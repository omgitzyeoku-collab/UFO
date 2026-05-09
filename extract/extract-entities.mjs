// Phase 2: extract structured entities from each doc with usable text.
// Per CLAUDE.md: claude -p is the runtime LLM. Idempotent + resumable.

import { spawn } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DBPATH = path.join(ROOT, 'extract', 'graph.duckdb');
const OUT = path.join(ROOT, 'extract', 'entities.jsonl');

// Read good-text + caption-having docs
const inst = await DuckDBInstance.create(DBPATH, { access_mode: 'READ_ONLY' });
const conn = await inst.connect();
const r = await conn.run(`
  SELECT d.sha256, d.title, d.agency, d.incident_date, d.incident_location, d.description,
         p.body, p.text_quality, c.headline, c.ocr_text
  FROM documents d
  LEFT JOIN pdf_text p ON d.sha256 = p.sha256
  LEFT JOIN captions c ON d.sha256 = c.sha256
  WHERE p.text_quality = 'good' OR c.headline IS NOT NULL
  ORDER BY d.agency, d.title
`);
const rows = (await r.getRowObjects()).map(o => Object.fromEntries(Object.entries(o).map(([k,v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
console.log(`extractable docs: ${rows.length}`);
await conn.disconnectSync();

// Resume support
const done = new Set();
try {
  const lines = (await fs.readFile(OUT, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.sha256 && r.parsed) done.add(r.sha256); }
} catch {}
console.log(`already extracted: ${done.size}`);

const queue = rows.filter(r => !done.has(r.sha256));
const limit = parseInt(process.env.LIMIT || '0', 10);
const target = limit ? queue.slice(0, limit) : queue;

const PROMPT = (r) => {
  let inputText = '';
  if (r.body && r.body.length > 100) {
    // Cap at 60K chars to keep context bounded
    inputText = `BODY TEXT (extracted from PDF):\n${r.body.slice(0, 60000)}`;
  } else if (r.headline) {
    inputText = `IMAGE CAPTION: ${r.headline}\nIMAGE OCR: ${r.ocr_text || ''}`;
  }
  return `You are extracting structured entities from a UAP-related document released by the US government on 2026-05-08 as part of the war.gov/UFO/ PURSUE collection.

DOCUMENT METADATA:
  Title: ${r.title || ''}
  Agency: ${r.agency || ''}
  Incident date: ${r.incident_date || ''}
  Incident location: ${r.incident_location || ''}
  CSV description: ${(r.description || '').slice(0, 800)}

${inputText}

Return STRICT JSON ONLY (no preamble, no fences, no commentary):

{
  "people":           ["<full names of individuals mentioned>"],
  "organisations":    ["<orgs/agencies/units beyond the obvious top-level agency>"],
  "places":           ["<countries, cities, regions, military installations, geographic features>"],
  "coordinates":      ["<lat/long pairs or GEO refs visible>"],
  "dates":            ["<ISO-format dates of named events: YYYY-MM-DD or YYYY-MM>"],
  "projects":         ["<project codenames, programmes, e.g. AAWSAP, AATIP, KONA BLUE, BLUE BOOK, etc>"],
  "case_numbers":     ["<FOIA case numbers, file numbers, e.g. 62-HQ-83894, 24-F-0250>"],
  "sensor_platforms": ["<aircraft, radar systems, satellite, FLIR, infrared, etc>"],
  "object_types":     ["<UAP morphologies described: tic-tac, cigar, sphere, disc, triangle, light, etc>"],
  "classifications":  ["<classification markings observed: CONFIDENTIAL, SECRET, TS, NOFORN, etc>"],
  "redaction_count":  <integer count of [REDACTED] markers or visible black-block redactions, or 0>,
  "key_claims":       ["<3-5 distinct factual or analytical claims this document makes, one per array item>"],
  "novelty_signals":  ["<anything unusual relative to typical UAP documentation: anomalous physics, unique witness type, multi-sensor corroboration, etc>"],
  "summary":          "<2 sentence summary of what this document says>"
}

Use empty arrays for fields with no content. Do not invent. Use exactly the names that appear in the source.`;
};

function callClaude(prompt, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, ['-p', '--dangerously-skip-permissions', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve({ exit: -1, stdout, stderr: stderr+'\n[TIMEOUT]' }); }, timeoutMs);
    proc.on('close', code => { clearTimeout(t); resolve({ exit: code, stdout, stderr }); });
    proc.stdin.end(prompt);
  });
}

console.log(`will extract: ${target.length}`);
for (let i = 0; i < target.length; i++) {
  const r = target[i];
  console.log(`[${i+1}/${target.length}] ${r.agency} | ${r.title?.slice(0,80)}`);
  const t0 = Date.now();
  const { exit, stdout, stderr } = await callClaude(PROMPT(r));
  const dt = ((Date.now()-t0)/1000).toFixed(1);
  let parsed = null, err = null;
  if (stdout) {
    const m = stdout.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e) { err = e.message.slice(0,200); } }
    else err = 'no JSON';
  } else err = stderr.slice(0, 200);
  await fs.appendFile(OUT, JSON.stringify({
    sha256: r.sha256, title: r.title, agency: r.agency,
    extracted_at: new Date().toISOString(), exit_code: exit, parsed, err,
  }) + '\n');
  const hits = parsed ? Object.entries(parsed).filter(([k,v]) => Array.isArray(v) && v.length).map(([k,v]) => `${k}=${v.length}`).join(' ') : err;
  console.log(`  ${dt}s exit=${exit} | ${hits}`);
}

console.log('\n=== entity extraction pass done ===');
