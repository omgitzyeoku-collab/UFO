// OCR scanned PDFs (those where pdftotext output was gibberish).
// Strategy: pdftoppm renders each PDF page to PNG, tesseract.js runs OCR
// per page, results concatenated to extract/text/<sha>.txt (overwriting
// the gibberish version). Idempotent: skip if already-OCR'd marker present.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorker } from 'tesseract.js';

const ROOT = path.resolve('.');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const OCR_LOG = path.join(ROOT, 'extract', 'ocr-status.jsonl');
const NEEDS_OCR = JSON.parse(await fs.readFile(path.join(ROOT, 'extract', 'needs-ocr.json'), 'utf8'));

console.log(`OCR queue: ${NEEDS_OCR.length} PDFs`);

// Resume support: skip shas where ocr-status row says ok
const done = new Set();
try {
  const lines = (await fs.readFile(OCR_LOG, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.status === 'ok') done.add(r.sha256); }
} catch {}
console.log(`already done: ${done.size}`);

const queue = NEEDS_OCR.filter(r => !done.has(r.sha256));
const limit = parseInt(process.env.LIMIT || '0', 10);
const target = limit ? queue.slice(0, limit) : queue;
console.log(`will OCR: ${target.length}`);

// Initialise tesseract worker once
console.log('initialising tesseract worker...');
const worker = await createWorker('eng');

async function appendLog(row) { await fs.appendFile(OCR_LOG, JSON.stringify(row) + '\n'); }

for (let i = 0; i < target.length; i++) {
  const rec = target[i];
  const startedAt = new Date().toISOString();
  console.log(`\n[${i+1}/${target.length}] ${rec.name}`);

  // Find blob path
  const blobPath = path.join(ROOT, 'blobs', rec.sha256.slice(0,2), rec.sha256.slice(2,4), rec.sha256);
  if (!existsSync(blobPath)) {
    console.error('  blob missing');
    await appendLog({ sha256: rec.sha256, name: rec.name, status: 'blob-missing', started_at: startedAt });
    continue;
  }

  // Render to per-page PNGs in temp dir
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ufo-ocr-'));
  try {
    // pdftoppm: -r 150 (DPI), -png, prefix → tmp/page-NNN.png
    const conv = spawnSync('pdftoppm', ['-r', '150', '-png', blobPath, path.join(tmp, 'page')], {
      encoding: 'utf8', timeout: 600_000,
    });
    if (conv.status !== 0) {
      console.error(`  pdftoppm failed: ${conv.stderr?.slice(0,200)}`);
      await appendLog({ sha256: rec.sha256, name: rec.name, status: 'render-fail', started_at: startedAt, err: conv.stderr?.slice(0,200) });
      await fs.rm(tmp, { recursive: true, force: true });
      continue;
    }
    const pngs = (await fs.readdir(tmp)).filter(f => f.endsWith('.png')).sort();
    console.log(`  rendered ${pngs.length} pages, OCR running...`);

    let combined = '';
    for (let p = 0; p < pngs.length; p++) {
      const pngPath = path.join(tmp, pngs[p]);
      try {
        const { data } = await worker.recognize(pngPath);
        combined += `\n=== Page ${p+1} ===\n${data.text}\n`;
      } catch (e) {
        combined += `\n=== Page ${p+1} (OCR failed: ${e.message.slice(0,100)}) ===\n`;
      }
      if ((p+1) % 5 === 0) process.stdout.write(`    page ${p+1}/${pngs.length}\r`);
    }
    process.stdout.write('\n');

    await fs.writeFile(path.join(TEXT_DIR, rec.sha256 + '.txt'), combined);
    const sample = combined.slice(0, 300).replace(/\s+/g,' ').trim();
    console.log(`  wrote ${combined.length} chars. sample: "${sample.slice(0,120)}..."`);
    await appendLog({ sha256: rec.sha256, name: rec.name, status: 'ok', started_at: startedAt, finished_at: new Date().toISOString(), pages: pngs.length, chars: combined.length });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

await worker.terminate();
console.log('\n=== OCR pass complete ===');
