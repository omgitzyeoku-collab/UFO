// OCR scanned PDFs via claude -p vision (faster + cleaner than tesseract.js
// on typewriter scans). pdf-img-convert renders pages to PNG, claude
// transcribes each. Idempotent + resumable per page.
//
// Per CLAUDE.md: claude -p is the sanctioned LLM path. Max plan covers usage.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pdf2img from 'pdf-img-convert';

const ROOT = path.resolve('.');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const PAGES_DIR = path.join(ROOT, 'extract', 'pages');  // cached page PNGs (gitignored)
const OCR_LOG = path.join(ROOT, 'extract', 'ocr-status.jsonl');
const NEEDS_OCR = JSON.parse(await fs.readFile(path.join(ROOT, 'extract', 'needs-ocr.json'), 'utf8'));
await fs.mkdir(PAGES_DIR, { recursive: true });

const done = new Set();
try {
  const lines = (await fs.readFile(OCR_LOG, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.status === 'ok') done.add(r.sha256); }
} catch {}
console.log(`OCR queue: ${NEEDS_OCR.length} PDFs (${done.size} already done)`);

const queue = NEEDS_OCR.filter(r => !done.has(r.sha256));
const limit = parseInt(process.env.LIMIT || '0', 10);
const target = limit ? queue.slice(0, limit) : queue;
console.log(`will OCR: ${target.length}`);

function callClaudeVision(pngPath, timeoutMs = 180_000) {
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
    proc.stdin.end(`Use the Read tool to load this image: ${pngPath.replace(/\\/g,'/')}\n\nThe image is one page of a scanned UAP-related historical document (often typewriter-era, often heavily redacted). Transcribe ALL visible text verbatim, preserving line breaks and structure. Include any classification markings, stamps, handwritten annotations. For redacted black rectangles use [REDACTED]. For illegible characters use [?]. Output ONLY the transcription, no commentary, no preamble, no markdown formatting, no fences.`);
  });
}

async function appendLog(row) { await fs.appendFile(OCR_LOG, JSON.stringify(row) + '\n'); }

for (let i = 0; i < target.length; i++) {
  const rec = target[i];
  const startedAt = new Date().toISOString();
  console.log(`\n[${i+1}/${target.length}] ${rec.name}`);

  const blobPath = path.join(ROOT, 'blobs', rec.sha256.slice(0,2), rec.sha256.slice(2,4), rec.sha256);
  if (!existsSync(blobPath)) {
    console.error('  blob missing'); await appendLog({ sha256: rec.sha256, name: rec.name, status: 'blob-missing' }); continue;
  }

  // Render pages to PNG
  let pages;
  try {
    pages = await pdf2img.convert(blobPath, { width: 1600, base64: false });
    console.log(`  rendered ${pages.length} pages`);
  } catch (e) {
    console.error(`  pdf-img-convert failed: ${e.message.slice(0,200)}`);
    await appendLog({ sha256: rec.sha256, name: rec.name, status: 'render-fail', err: e.message.slice(0,300), started_at: startedAt });
    continue;
  }

  let combined = '';
  let pagesOk = 0, pagesFail = 0;
  for (let p = 0; p < pages.length; p++) {
    const pngPath = path.join(PAGES_DIR, `${rec.sha256.slice(0,12)}-p${String(p+1).padStart(4,'0')}.png`);
    await fs.writeFile(pngPath, pages[p]);
    const t0 = Date.now();
    const { exit, stdout, stderr } = await callClaudeVision(pngPath);
    const dt = ((Date.now()-t0)/1000).toFixed(1);
    if (exit === 0 && stdout.trim()) {
      combined += `\n=== Page ${p+1} ===\n${stdout.trim()}\n`;
      pagesOk++;
    } else {
      combined += `\n=== Page ${p+1} (OCR failed exit=${exit}) ===\n`;
      pagesFail++;
    }
    process.stdout.write(`    page ${p+1}/${pages.length} (${dt}s)\r`);
    // Clean up the page PNG to save disk; cached only briefly
    try { await fs.unlink(pngPath); } catch {}
  }
  process.stdout.write('\n');

  await fs.writeFile(path.join(TEXT_DIR, rec.sha256 + '.txt'), combined);
  console.log(`  wrote ${combined.length} chars (${pagesOk} ok / ${pagesFail} fail)`);
  await appendLog({ sha256: rec.sha256, name: rec.name, status: 'ok', started_at: startedAt, finished_at: new Date().toISOString(), pages: pages.length, pages_ok: pagesOk, pages_fail: pagesFail, chars: combined.length });
}

console.log('\n=== OCR pass done ===');
