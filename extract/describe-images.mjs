import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve('.');
const DERIVED = path.join(ROOT, 'extract', 'derived.jsonl');
const OUT = path.join(ROOT, 'extract', 'captions.jsonl');
const TMP = path.join(os.tmpdir(), 'ufo-vision');
await fs.mkdir(TMP, { recursive: true });

const records = (await fs.readFile(DERIVED, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

// Skip already-described records on resume (only if successfully parsed)
let existing = new Set();
try {
  const prev = (await fs.readFile(OUT, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const p of prev) if (p.parsed && p.sha256) existing.add(p.sha256);
  console.log(`resume: ${existing.size} already described successfully`);
} catch {}

const PROMPT_TEMPLATE = (filePath) => `You are analysing one image released by the US Department of War as part of the PURSUE (Presidential Unsealing and Reporting System for UAP Encounters) public release on 2026-05-08.

Use the Read tool to read this image file: ${filePath}

Then return STRICT JSON ONLY (no preamble, no code fences, no commentary). Schema:

{
  "what_is_it": "photo" | "infographic" | "diagram" | "sketch" | "document_scan" | "redacted_doc" | "other",
  "headline": "<one short sentence describing what is visually depicted>",
  "ocr_text": "<all text visible in the image, verbatim, preserving line breaks>",
  "people": ["<full names visible>"],
  "places": ["<places named or shown>"],
  "dates_seen": ["<any date strings present>"],
  "agency_markings": ["<DOW, FBI, NASA, AARO, classification markings, etc>"],
  "objects_described": ["<UFOs, aircraft, vehicles, lights, sensors, etc>"],
  "redaction_blocks": <integer count of black redaction rectangles visible, or 0>,
  "specificity_score": <0..10 integer; how many concrete names/dates/coords/measurements are present>,
  "novelty_signals": ["<any claim that seems unusual relative to typical UAP reporting>"],
  "notes": "<one sentence on anything else worth flagging>"
}

If a field doesn't apply, use [] for arrays, "" for strings, 0 for numbers.`;

function callClaude(prompt, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, ['-p', '--dangerously-skip-permissions', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    let stdout = '', stderr = '', spawnErr = null;
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('error', e => { spawnErr = e.message; });
    const t = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve({ exit: -1, stdout, stderr: stderr + '\n[TIMEOUT]', error: 'timeout' });
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(t);
      resolve({ exit: code, stdout, stderr, error: spawnErr });
    });
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
  const tmpFile = path.join(TMP, `${r.sha256.slice(0, 16)}.${r.ext || 'jpg'}`);
  await fs.copyFile(path.join(ROOT, r.blob_path), tmpFile);
  const prompt = PROMPT_TEMPLATE(tmpFile.replace(/\\/g, '/'));
  const startedAt = new Date().toISOString();
  console.log(`[${i + 1}/${target.length}] ${r.name}`);
  const { exit, stdout, stderr, error } = await callClaude(prompt);
  let parsed = null, parseErr = null;
  if (stdout) {
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); }
      catch (e) { parseErr = e.message; }
    } else {
      parseErr = 'no JSON object found in stdout';
    }
  } else if (error) {
    parseErr = `spawn: ${error}`;
  }
  await append({
    sha256: r.sha256,
    name: r.name,
    blob_path: r.blob_path,
    described_at: new Date().toISOString(),
    started_at: startedAt,
    exit_code: exit,
    parsed,
    parse_error: parseErr,
    raw_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-500),
  });
  console.log(`  exit=${exit} parsed=${!!parsed} ${parsed?.what_is_it || ''} | ${parsed?.headline?.slice(0, 80) || parseErr || ''}`);
}

console.log(`\nwrote ${target.length} captions to ${OUT}`);
