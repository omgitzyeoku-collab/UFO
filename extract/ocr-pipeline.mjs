// OCR pipeline: pymupdf renders each scanned PDF page to PNG via Python
// shellout, then tesseract.js does the OCR. Idempotent + resumable.
// Per-PDF status logged to extract/ocr-status.jsonl.

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

const RENDER_PY = `
import fitz, sys, os
pdf_path = sys.argv[1]
out_dir = sys.argv[2]
dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 200
doc = fitz.open(pdf_path)
mat = fitz.Matrix(dpi/72, dpi/72)
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=mat, alpha=False)
    pix.save(os.path.join(out_dir, f'p{i+1:04d}.png'))
print(len(doc))
`;

console.log('initialising tesseract worker...');
const worker = await createWorker('eng');

async function appendLog(row) { await fs.appendFile(OCR_LOG, JSON.stringify(row) + '\n'); }

const startedAtAll = Date.now();
for (let i = 0; i < target.length; i++) {
  const rec = target[i];
  const startedAt = new Date().toISOString();
  const totalElapsed = ((Date.now() - startedAtAll) / 60000).toFixed(1);
  console.log(`\n[${i+1}/${target.length}] (+${totalElapsed}min) ${rec.name}`);

  const blobPath = path.join(ROOT, 'blobs', rec.sha256.slice(0,2), rec.sha256.slice(2,4), rec.sha256);
  if (!existsSync(blobPath)) {
    console.error('  blob missing'); await appendLog({ sha256: rec.sha256, name: rec.name, status: 'blob-missing' }); continue;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ufo-ocr-'));
  try {
    const conv = spawnSync('python', ['-c', RENDER_PY, blobPath, tmp, '180'], {
      encoding: 'utf8', timeout: 600_000, windowsHide: true,
    });
    if (conv.status !== 0) {
      console.error(`  pymupdf failed: ${conv.stderr?.slice(0,200)}`);
      await appendLog({ sha256: rec.sha256, name: rec.name, status: 'render-fail', err: conv.stderr?.slice(0,300), started_at: startedAt });
      await fs.rm(tmp, { recursive: true, force: true });
      continue;
    }
    const pageCount = parseInt(conv.stdout.trim()) || 0;
    const pngs = (await fs.readdir(tmp)).filter(f => f.endsWith('.png')).sort();
    console.log(`  rendered ${pngs.length} pages, OCR running...`);

    let combined = '';
    const pageStart = Date.now();
    for (let p = 0; p < pngs.length; p++) {
      const pngPath = path.join(tmp, pngs[p]);
      try {
        const { data } = await worker.recognize(pngPath);
        combined += `\n=== Page ${p+1} ===\n${data.text.trim()}\n`;
      } catch (e) {
        combined += `\n=== Page ${p+1} (OCR failed: ${e.message.slice(0,80)}) ===\n`;
      }
      if ((p+1) % 5 === 0 || p === pngs.length-1) {
        const elapsed = ((Date.now() - pageStart)/1000).toFixed(0);
        process.stdout.write(`    page ${p+1}/${pngs.length} (${elapsed}s elapsed)\r`);
      }
    }
    process.stdout.write('\n');

    await fs.writeFile(path.join(TEXT_DIR, rec.sha256 + '.txt'), combined);
    const sample = combined.slice(0, 200).replace(/\s+/g,' ').trim();
    console.log(`  wrote ${combined.length} chars. sample: "${sample.slice(0,120)}..."`);
    await appendLog({ sha256: rec.sha256, name: rec.name, status: 'ok', started_at: startedAt, finished_at: new Date().toISOString(), pages: pngs.length, chars: combined.length });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

await worker.terminate();
const totalMin = ((Date.now() - startedAtAll) / 60000).toFixed(1);
console.log(`\n=== OCR pass complete in ${totalMin}min ===`);
