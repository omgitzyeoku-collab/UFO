// Run pdftotext over every PDF blob, save to extract/text/<sha>.txt.
// Idempotent: skip already-extracted shas.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
await fs.mkdir(TEXT_DIR, { recursive: true });

// Collect every manifest row with a PDF content type
const manifestFiles = (await fs.readdir(MANIFEST_DIR)).filter(f => f.endsWith('.jsonl') && f !== 'latest.jsonl');
const seenSha = new Set();
const pdfs = [];

for (const f of manifestFiles) {
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.status !== 200 || !r.sha256 || !r.blob_path) continue;
    if (seenSha.has(r.sha256)) continue;
    const ct = (r.content_type || '').toLowerCase();
    const isPdf = ct.includes('pdf') || /\.pdf(\?|$)/i.test(r.url || '') || /at_download\/file/i.test(r.url || '');
    if (!isPdf) continue;
    seenSha.add(r.sha256);
    pdfs.push(r);
  }
}

console.log(`unique PDF blobs to extract: ${pdfs.length}`);

const summary = [];
let extracted = 0, skipped = 0, failed = 0;

for (let i = 0; i < pdfs.length; i++) {
  const r = pdfs[i];
  const txtPath = path.join(TEXT_DIR, `${r.sha256}.txt`);
  const exists = await fs.stat(txtPath).then(() => true).catch(() => false);
  if (exists) { skipped++; continue; }
  const blobPath = path.join(ROOT, r.blob_path);
  const proc = spawnSync('pdftotext', ['-q', '-layout', blobPath, txtPath], { encoding: 'utf8', timeout: 120_000 });
  // pdftotext missing entirely is an environment fault, not a bad PDF. Logging
  // it once per file and exiting 0 is how a CI run published a whole release
  // with no document text at all. Abort on the first ENOENT.
  if (proc.error?.code === 'ENOENT') {
    console.error('FATAL: pdftotext not found on PATH.');
    console.error('  Install poppler-utils (Debian/Ubuntu: apt-get install -y poppler-utils).');
    console.error('  Refusing to continue — every document would be published without text.');
    process.exit(127);
  }
  if (proc.status !== 0) {
    failed++;
    console.log(`  [${i+1}/${pdfs.length}] FAIL ${r.sha256.slice(0,12)} ${(r.url || '').slice(0, 80)}`);
    continue;
  }
  const stat = await fs.stat(txtPath);
  extracted++;
  const sample = (await fs.readFile(txtPath, 'utf8')).slice(0, 200).replace(/\s+/g, ' ').trim();
  console.log(`  [${i+1}/${pdfs.length}] ${(stat.size/1024).toFixed(0).padStart(6)}KB  ${r.sha256.slice(0,12)} ${(r.url || '').split('/').pop().slice(0, 60)}`);
  summary.push({ sha256: r.sha256, url: r.url, bytes: stat.size, sample });
}

await fs.writeFile(path.join(ROOT, 'extract', 'text-index.jsonl'),
  summary.map(s => JSON.stringify(s)).join('\n') + '\n');

console.log(`\nextracted=${extracted} skipped=${skipped} failed=${failed} total=${pdfs.length}`);
console.log(`text/ size:`);
const sz = spawnSync('du', ['-sh', TEXT_DIR], { encoding: 'utf8' });
console.log(sz.stdout || '');
