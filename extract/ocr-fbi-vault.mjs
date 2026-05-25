// OCR the 16 FBI Vault UFO PDFs. They're scanned typewriter-era documents
// (1947-1977) with PDF embedded gibberish text that pdftotext can't decode.
// Pipeline: pdftoppm (render PNG per page) → tesseract.js (OCR per page) →
// concat to extract/text/<sha>.txt.
//
// Resumable via extract/ocr-status.jsonl.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorker } from 'tesseract.js';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const OCR_LOG = path.join(ROOT, 'extract', 'ocr-status.jsonl');
const POPPLER_BIN = process.env.POPPLER_BIN || 'pdftoppm';

await fs.mkdir(TEXT_DIR, { recursive: true });

// Pick FBI Vault docs from release-manifest
const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const fbi = [];
const seen = new Set();
for (const r of records) {
  if (r.release !== 'fbi-vault' || !r.sha256 || seen.has(r.sha256)) continue;
  seen.add(r.sha256);
  fbi.push(r);
}
console.log(`FBI Vault docs in release manifest: ${fbi.length}`);

// Skip docs already marked ok in ocr-status
const ocrOk = new Set();
try {
  const lines = (await fs.readFile(OCR_LOG, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.status === 'ok' && r.source === 'fbi-vault-ocr') ocrOk.add(r.sha256); }
} catch {}

const queue = fbi.filter(r => !ocrOk.has(r.sha256));
console.log(`to OCR: ${queue.length} (skipping ${fbi.length - queue.length} already done)`);

if (!queue.length) { console.log('nothing to do'); process.exit(0); }

console.log('initialising tesseract worker (eng)...');
const worker = await createWorker('eng');
const appendLog = async (r) => fs.appendFile(OCR_LOG, JSON.stringify(r) + '\n');

let ok = 0, fail = 0;
for (let i = 0; i < queue.length; i++) {
  const rec = queue[i];
  const startedAt = new Date().toISOString();
  console.log(`\n[${i+1}/${queue.length}] ${rec.title || rec.name} (${(rec.bytes/1048576).toFixed(1)} MB)`);
  const blob = path.join(ROOT, rec.blob_path || `blobs/${rec.sha256.slice(0,2)}/${rec.sha256.slice(2,4)}/${rec.sha256}`);
  if (!existsSync(blob)) {
    console.error('  blob missing'); fail++;
    await appendLog({ sha256: rec.sha256, name: rec.name, source: 'fbi-vault-ocr', status: 'blob-missing', started_at: startedAt });
    continue;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ufo-fbi-ocr-'));
  try {
    const conv = spawnSync(POPPLER_BIN, ['-r', '150', '-png', blob, path.join(tmp, 'page')], {
      encoding: 'utf8', timeout: 1_200_000, windowsHide: true,
    });
    if (conv.status !== 0) {
      console.error(`  pdftoppm failed: ${conv.stderr?.slice(0,200) || '?'}`);
      fail++;
      await appendLog({ sha256: rec.sha256, name: rec.name, source: 'fbi-vault-ocr', status: 'render-fail', started_at: startedAt, err: conv.stderr?.slice(0,200) });
      continue;
    }
    const pngs = (await fs.readdir(tmp)).filter(f => f.endsWith('.png')).sort();
    console.log(`  rendered ${pngs.length} pages, OCR running...`);

    let combined = '';
    for (let p = 0; p < pngs.length; p++) {
      try {
        const { data } = await worker.recognize(path.join(tmp, pngs[p]));
        combined += `\n=== Page ${p+1} ===\n${data.text}\n`;
      } catch (e) {
        combined += `\n=== Page ${p+1} (OCR failed: ${e.message.slice(0,80)}) ===\n`;
      }
      if ((p+1) % 5 === 0) process.stdout.write(`    page ${p+1}/${pngs.length}\r`);
    }
    process.stdout.write('\n');

    await fs.writeFile(path.join(TEXT_DIR, rec.sha256 + '.txt'), combined);
    const sample = combined.slice(0, 280).replace(/\s+/g,' ').trim();
    console.log(`  wrote ${combined.length} chars`);
    console.log(`  sample: "${sample.slice(0,120)}..."`);
    await appendLog({ sha256: rec.sha256, name: rec.name, source: 'fbi-vault-ocr', status: 'ok', started_at: startedAt, finished_at: new Date().toISOString(), pages: pngs.length, chars: combined.length });
    ok++;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

await worker.terminate();
console.log(`\n=== SUMMARY ===\n  OCR'd: ${ok}, failed: ${fail}`);
