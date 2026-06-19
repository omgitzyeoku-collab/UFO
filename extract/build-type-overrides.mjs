// Sniff every LOCAL blob's magic bytes and record a type override wherever
// the real content disagrees with the manifest's declared type (e.g. war.gov
// served a JPEG at a .pdf URL). Output extract/type-overrides.json {sha:type}
// is committed and read by build-corpus.mjs, so the correction is
// deterministic across environments — including the Vercel build, which has
// no blobs and so can't sniff for itself.

import fs from 'node:fs/promises';
import { openSync, readSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const OUT = path.join(ROOT, 'extract', 'type-overrides.json');

function sniff(p) {
  try {
    const fd = openSync(p, 'r'); const b = Buffer.alloc(12); readSync(fd, b, 0, 12, 0); closeSync(fd);
    const hex = b.toString('hex');
    if (b.slice(4, 8).toString() === 'ftyp') return 'VID';
    if (hex.startsWith('25504446')) return 'PDF';
    if (hex.startsWith('ffd8ff') || hex.startsWith('89504e47') || hex.startsWith('47494638')) return 'IMG';
    if (hex.startsWith('494433') || b.slice(0,4).toString() === 'RIFF') return 'AUD';
    return null;
  } catch { return null; }
}

const docs = new Map();
for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n')) {
  try { const r = JSON.parse(l); if (r.sha256 && !docs.has(r.sha256)) docs.set(r.sha256, r); } catch {}
}

// Start from any existing overrides so we never lose a correction once a blob
// is gone (e.g. cleaned up later).
let overrides = {};
try { overrides = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}

let added = 0;
for (const d of docs.values()) {
  if (!existsSync(d.blob_path || '')) continue;
  const real = sniff(d.blob_path);
  if (!real) continue;
  const declared = (d.type || 'PDF').toUpperCase();
  if (real !== declared && overrides[d.sha256] !== real) {
    overrides[d.sha256] = real;
    added++;
  }
}

await fs.writeFile(OUT, JSON.stringify(overrides));
const byType = {};
for (const t of Object.values(overrides)) byType[t] = (byType[t] || 0) + 1;
console.log(`type-overrides.json: ${Object.keys(overrides).length} entries (+${added} new)`);
console.log(`  corrected to: ${JSON.stringify(byType)}`);
