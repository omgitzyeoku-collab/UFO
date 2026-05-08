// Describe every image-kind artefact across the corpus via claude -p vision.
// Reads derived-all.jsonl, skips already-described shas (resumable).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve('.');
const DERIVED_ALL = path.join(ROOT, 'extract', 'derived-all.jsonl');
const OUT = path.join(ROOT, 'extract', 'captions.jsonl');
const TMP = path.join(os.tmpdir(), 'ufo-vision');
await fs.mkdir(TMP, { recursive: true });

const records = (await fs.readFile(DERIVED_ALL, 'utf8'))
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(r => r.kind === 'image' && r.bytes > 5000);  // skip favicons / tiny chrome

let existing = new Set();
try {
  const prev = (await fs.readFile(OUT, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const p of prev) if (p.parsed && p.sha256) existing.add(p.sha256);
} catch {}
console.log(`already described: ${existing.size}`);

const PROMPT = (filePath, agency, url) => `You are analysing one image from a US government UAP-related archive.

Source: ${agency || 'unknown agency'}
URL: ${url}
File: ${filePath}

Use the Read tool to load this image file, then return STRICT JSON ONLY (no preamble, no code fences). Schema:

{
  "what_is_it": "photo" | "infographic" | "diagram" | "sketch" | "document_scan" | "chart" | "logo" | "screenshot" | "other",
  "headline": "<one short sentence describing what is visually depicted>",
  "ocr_text": "<all visible text verbatim with line breaks>",
  "people": ["<full names visible>"],
  "places": ["<places named or shown>"],
  "dates_seen": ["<any date strings present>"],
  "agency_markings": ["<DOW, FBI, NASA, AARO, classification markings, etc>"],
  "objects_described": ["<UFOs, aircraft, vehicles, lights, sensors, etc>"],
  "redaction_blocks": <integer count of black redaction rectangles visible, or 0>,
  "specificity_score": <0..10 integer; how many concrete names/dates/coords/measurements are present>,
  "novelty_signals": ["<any unusual claim or visual feature relative to typical UAP material>"],
  "notes": "<one sentence on anything else worth flagging, or empty string if image is just navigation chrome / banner / non-substantive>"
}

If the image is generic site chrome (banner, logo, decorative, navigation), set "what_is_it":"other", "notes":"chrome", and minimal everything else.`;

function callClaude(prompt, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, ['-p', '--dangerously-skip-permissions', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {}
      resolve({ exit: -1, stdout, stderr: stderr + '\n[TIMEOUT]' }); }, timeoutMs);
    proc.on('close', code => { clearTimeout(t); resolve({ exit: code, stdout, stderr }); });
    proc.stdin.end(prompt);
  });
}

const limit = parseInt(process.env.LIMIT || '0', 10);
const queue = records.filter(r => !existing.has(r.sha256));
const target = limit ? queue.slice(0, limit) : queue;
console.log(`describing ${target.length} of ${records.length} images`);

const append = async (row) => fs.appendFile(OUT, JSON.stringify(row) + '\n');

for (let i = 0; i < target.length; i++) {
  const r = target[i];
  const ext = (r.url.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tmpFile = path.join(TMP, `${r.sha256.slice(0, 16)}.${ext}`);
  try { await fs.copyFile(path.join(ROOT, r.blob_path), tmpFile); } catch (e) { console.error(`  copy fail: ${e.message}`); continue; }
  const prompt = PROMPT(tmpFile.replace(/\\/g, '/'), r.agency, r.url);
  console.log(`[${i + 1}/${target.length}] ${r.agency || '?'} ${r.url.slice(0, 80)}`);
  const startedAt = new Date().toISOString();
  const { exit, stdout, stderr } = await callClaude(prompt);
  let parsed = null, parseErr = null;
  if (stdout) {
    const m = stdout.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e) { parseErr = e.message; } }
    else parseErr = 'no JSON object';
  } else if (stderr) parseErr = stderr.slice(0, 200);
  await append({
    sha256: r.sha256, name: r.url.split('/').pop(), blob_path: r.blob_path,
    agency: r.agency, url: r.url,
    described_at: new Date().toISOString(), started_at: startedAt,
    exit_code: exit, parsed, parse_error: parseErr,
    raw_tail: stdout.slice(-1500), stderr_tail: stderr.slice(-300),
  });
  console.log(`  exit=${exit} parsed=${!!parsed} ${parsed?.what_is_it || ''} | ${parsed?.headline?.slice(0, 80) || parseErr || ''}`);
}
console.log(`\nwrote ${target.length} captions to ${OUT}`);
