// Phase 5: per-hypothesis evidence aggregator.
// For each hypothesis in docs/hypotheses.md, ask claude -p to identify the
// top supporting/contradicting documents from the corpus. Writes evidence
// cards to extract/evidence.jsonl.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const HYP_PATH = path.join(ROOT, 'docs', 'hypotheses.md');
const OUT = path.join(ROOT, 'extract', 'evidence.jsonl');

const md = await fs.readFile(HYP_PATH, 'utf8');
const sections = md.split(/\n(?=## H\d)/).filter(s => /^##\s*H\d/.test(s));
const hypotheses = sections.map(s => {
  const m = s.match(/^##\s*(H\d+):?\s*(.+?)\n([\s\S]*?)(?=\n## |\n---|$)/);
  if (!m) return null;
  return { id: m[1], title: m[2].trim(), body: m[3].trim() };
}).filter(Boolean);
console.log(`hypotheses: ${hypotheses.length}`);

// Load doc corpus inventory (titles + agencies + descriptions only — full
// text is too much for the prompt; we ask claude to identify candidates by
// metadata first, then we can deep-read on a follow-up pass).
// Read from release-manifest.jsonl directly to avoid DuckDB lock contention.
const allRecords = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of allRecords) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()].map(r => ({
  sha256: r.sha256, title: r.title, agency: r.agency,
  incident_date: r.incident_date, incident_location: r.incident_location,
  description: r.description,
}));
docs.sort((a,b) => (a.agency||'').localeCompare(b.agency||'') || (a.title||'').localeCompare(b.title||''));
console.log(`corpus: ${docs.length} docs`);

// Build a compact corpus listing (id + agency + title + 1-line description)
const corpusListing = docs.map((d, i) => `[${i+1}] ${d.agency || '?'} | ${(d.title||'').slice(0,90)} | ${(d.description||'').slice(0,120)}`).join('\n');

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

// Resume support
const done = new Set();
try {
  const lines = (await fs.readFile(OUT, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.hypothesis_id) done.add(r.hypothesis_id); }
} catch {}
console.log(`already aggregated: ${done.size}`);

for (const h of hypotheses) {
  if (done.has(h.id)) { console.log(`skip ${h.id}`); continue; }
  console.log(`\n=== ${h.id}: ${h.title} ===`);

  const prompt = `You are an analyst working through the war.gov/UFO/ Release 01 corpus (PURSUE, 2026-05-08). The corpus inventory is below.

HYPOTHESIS ${h.id}: ${h.title}

${h.body}

CORPUS INVENTORY (numbered):
${corpusListing}

Identify which documents from the inventory are most relevant to ${h.id} — supporting evidence, contradicting evidence, or important context.

Return STRICT JSON ONLY (no preamble, no fences):
{
  "hypothesis_id": "${h.id}",
  "stance_summary": "<1-2 sentences: where the corpus seems to land on this hypothesis based on titles+descriptions alone>",
  "candidates": [
    {
      "doc_id": <integer from inventory>,
      "stance": "supporting" | "contradicting" | "context" | "ambiguous",
      "rationale": "<why this doc is relevant, 1 sentence>",
      "deep_read_priority": "high" | "medium" | "low"
    }
  ],
  "open_questions": ["<questions the metadata alone can't answer; these would need full-text reads>"]
}

Pick at most 12 candidates. Be specific about why each is relevant. Be honest if the corpus titles+descriptions don't strongly bear on the hypothesis (return few candidates rather than padding).`;

  const t0 = Date.now();
  const { exit, stdout, stderr } = await callClaude(prompt);
  const dt = ((Date.now()-t0)/1000).toFixed(1);
  let parsed = null, err = null;
  if (stdout) {
    const m = stdout.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e) { err = e.message.slice(0,200); } }
    else err = 'no JSON';
  } else err = stderr.slice(0, 200);

  if (parsed?.candidates) {
    // Resolve doc_id → sha256 + title and emit one row per candidate
    for (const c of parsed.candidates) {
      const d = docs[(c.doc_id || 1) - 1];
      if (!d) continue;
      await fs.appendFile(OUT, JSON.stringify({
        hypothesis_id: h.id,
        hypothesis_title: h.title,
        sha256: d.sha256,
        doc_title: d.title,
        agency: d.agency,
        stance: c.stance,
        rationale: c.rationale,
        deep_read_priority: c.deep_read_priority,
        passage: '',  // placeholder — populated by phase-5b deep-read pass
        aggregated_at: new Date().toISOString(),
      }) + '\n');
    }
  }
  // Also emit a hypothesis-level summary row
  await fs.appendFile(OUT, JSON.stringify({
    hypothesis_id: h.id,
    hypothesis_title: h.title,
    stance_summary: parsed?.stance_summary,
    open_questions: parsed?.open_questions,
    aggregated_at: new Date().toISOString(),
    candidate_count: parsed?.candidates?.length || 0,
    err,
  }) + '\n');

  console.log(`  ${dt}s exit=${exit} candidates=${parsed?.candidates?.length || 0} | ${parsed?.stance_summary?.slice(0,150) || err}`);
}

console.log('\n=== evidence aggregation done ===');
