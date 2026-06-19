// OCR Release-3 scanned PDFs (1940s-70s FBI/CIA historical scans whose
// pdftotext output was empty/gibberish). pdftoppm renders each page → PNG,
// tesseract.js OCRs, concatenated to extract/text/<sha>.txt.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorker } from 'tesseract.js';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const POPPLER = process.env.POPPLER_BIN || 'pdftoppm';

const docs = new Map();
for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n')) {
  try { const r = JSON.parse(l); if (r.sha256 && !docs.has(r.sha256)) docs.set(r.sha256, r); } catch {}
}

// Target: release_03 docs whose text file is missing or tiny (scanned).
const queue = [];
for (const d of docs.values()) {
  if (!/release_03/i.test(d.url || d.release_url || '')) continue;
  const txt = path.join(TEXT_DIR, d.sha256 + '.txt');
  const tiny = !existsSync(txt) || (await fs.stat(txt).then(s => s.size < 100).catch(() => true));
  if (tiny && existsSync(d.blob_path || '')) queue.push(d);
}
console.log(`R3 scanned PDFs to OCR: ${queue.length}`);
if (!queue.length) process.exit(0);

// Sniff blob type: PDF → render pages then OCR; JPEG/PNG → OCR directly.
import { openSync, readSync, closeSync } from 'node:fs';
function sniff(p) {
  try { const fd = openSync(p, 'r'); const b = Buffer.alloc(8); readSync(fd, b, 0, 8, 0); closeSync(fd);
    const hex = b.toString('hex');
    if (hex.startsWith('25504446')) return 'pdf';
    if (hex.startsWith('ffd8ff')) return 'jpg';
    if (hex.startsWith('89504e47')) return 'png';
    return 'other';
  } catch { return 'other'; }
}

const worker = await createWorker('eng');
let ok = 0, fail = 0, imgCount = 0;
for (let i = 0; i < queue.length; i++) {
  const d = queue[i];
  const kind = sniff(d.blob_path);
  try {
    if (kind === 'jpg' || kind === 'png') {
      // OCR the image blob directly (tesseract reads jpg/png natively).
      const { data } = await worker.recognize(d.blob_path);
      await fs.writeFile(path.join(TEXT_DIR, d.sha256 + '.txt'), data.text || '');
      ok++; imgCount++;
      console.log(`  [${i+1}/${queue.length}] img ${(d.title||d.name||'').slice(0,45)}`);
      continue;
    }
    // PDF path: render pages → OCR each.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'r3-ocr-'));
    try {
      const conv = spawnSync(POPPLER, ['-r', '150', '-png', d.blob_path, path.join(tmp, 'pg')], { encoding: 'utf8', timeout: 600000, windowsHide: true });
      if (conv.status !== 0) { fail++; continue; }
      const pngs = (await fs.readdir(tmp)).filter(f => f.endsWith('.png')).sort();
      let combined = '';
      for (let p = 0; p < pngs.length; p++) {
        try { const { data } = await worker.recognize(path.join(tmp, pngs[p])); combined += `\n=== Page ${p+1} ===\n${data.text}\n`; } catch {}
      }
      await fs.writeFile(path.join(TEXT_DIR, d.sha256 + '.txt'), combined);
      ok++;
      console.log(`  [${i+1}/${queue.length}] ${pngs.length}pg ${(d.title||d.name||'').slice(0,45)}`);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  } catch { fail++; }
}
await worker.terminate();
console.log(`\nR3 OCR: ${ok} done (${imgCount} images), ${fail} failed`);
