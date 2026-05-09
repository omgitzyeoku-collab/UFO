// Phase 1: search the corpus via DuckDB FTS.
// Usage:  node extract/query.mjs "search terms"
//         node extract/query.mjs --agency=NASA "anomaly"
//         node extract/query.mjs --rerank "soviet recon flight 1985"

import { DuckDBInstance } from '@duckdb/node-api';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve('.');
const DBPATH = path.join(ROOT, 'extract', 'graph.duckdb');

const args = process.argv.slice(2);
let rerank = false, agencyFilter = null;
const positional = [];
for (const a of args) {
  if (a === '--rerank') rerank = true;
  else if (a.startsWith('--agency=')) agencyFilter = a.slice(9);
  else positional.push(a);
}
const query = positional.join(' ').trim();
if (!query) {
  console.error('usage: node extract/query.mjs [--agency=NASA] [--rerank] "search terms"');
  process.exit(1);
}

const inst = await DuckDBInstance.create(DBPATH, { access_mode: 'READ_ONLY' });
const conn = await inst.connect();
await conn.run('LOAD fts;');

// FTS over pdf_text body
const where = agencyFilter ? `AND d.agency = '${agencyFilter.replace(/'/g, "''")}'` : '';
const sql = `
  WITH text_hits AS (
    SELECT sha256, fts_main_pdf_text.match_bm25(sha256, $1) AS score
    FROM pdf_text
    WHERE fts_main_pdf_text.match_bm25(sha256, $1) IS NOT NULL
  ),
  meta_hits AS (
    SELECT sha256, fts_main_documents.match_bm25(sha256, $1) AS score
    FROM documents
    WHERE fts_main_documents.match_bm25(sha256, $1) IS NOT NULL
  ),
  combined AS (
    SELECT sha256, MAX(score) AS score FROM (
      SELECT sha256, score FROM text_hits
      UNION ALL
      SELECT sha256, score * 1.2 FROM meta_hits   -- title/description matches weighted slightly higher
    ) GROUP BY sha256
  )
  SELECT d.sha256, d.title, d.agency, d.incident_date, d.incident_location,
         d.release_url, c.score, p.text_quality
  FROM combined c
  JOIN documents d ON c.sha256 = d.sha256
  JOIN pdf_text p ON c.sha256 = p.sha256
  WHERE 1=1 ${where}
  ORDER BY c.score DESC
  LIMIT 20
`;

const stmt = await conn.prepare(sql);
stmt.bindVarchar(1, query);
const r = await stmt.run();
const rows = (await r.getRowObjects()).map(o => Object.fromEntries(Object.entries(o).map(([k,v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
console.log(`=== ${rows.length} BM25 hits for "${query}" ${agencyFilter ? '(agency='+agencyFilter+')' : ''} ===\n`);

// Pull a snippet per hit
async function snippet(sha, terms) {
  const s = await conn.prepare(`SELECT body FROM pdf_text WHERE sha256 = $1`);
  s.bindVarchar(1, sha);
  const rr = await s.run();
  const body = (await rr.getRowObjects())[0]?.body || '';
  if (!body) return '(no body text)';
  // Find first occurrence of any query term, return ~200-char window around it
  const re = new RegExp('\\b(' + terms.split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
  const m = body.match(re);
  if (!m) return body.slice(0, 220).replace(/\s+/g, ' ').trim() + '...';
  const idx = m.index;
  const start = Math.max(0, idx - 90);
  const end = Math.min(body.length, idx + 200);
  let snip = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '...' : '') + snip + (end < body.length ? '...' : '');
}

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  console.log(`#${i+1} score=${r.score.toFixed(3)} [${r.text_quality}] ${r.agency || '?'}`);
  console.log(`     ${r.title || r.sha256.slice(0,16)}`);
  if (r.incident_date || r.incident_location) console.log(`     ${[r.incident_date, r.incident_location].filter(x=>x && x !== 'N/A').join(' · ')}`);
  const snip = await snippet(r.sha256, query);
  console.log(`     "${snip.slice(0, 280)}"`);
  console.log(`     ${r.release_url}`);
  console.log('');
}

if (rerank && rows.length > 0) {
  console.log('=== claude -p re-rank top 10 ===\n');
  const top = rows.slice(0, 10);
  const items = await Promise.all(top.map(async (r, i) => ({
    id: i+1,
    title: r.title,
    agency: r.agency,
    snippet: await snippet(r.sha256, query),
  })));
  const prompt = `Re-rank these UAP-related search results by their actual relevance to the query "${query}".
Return JSON array of integers (the IDs) in best-to-worst order, with one-line reasons. No preamble, no fences.

Results:
${items.map(i => `[${i.id}] ${i.agency} | ${i.title}\n     "${i.snippet.slice(0,200)}"`).join('\n\n')}`;
  await new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, ['-p', '--dangerously-skip-permissions', '--output-format', 'text'], { stdio: ['pipe','inherit','pipe'], shell: process.platform === 'win32' });
    proc.stdin.end(prompt);
    proc.on('close', resolve);
  });
}

await conn.disconnectSync();
