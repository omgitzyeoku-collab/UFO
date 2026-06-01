// Render page 1 of each FBI Vault PDF (and any PDF lacking a thumbnail) to a
// cover-image thumbnail at extract/thumbs/<sha>.jpg, so they stop showing as
// blank no-thumbnail cards.
//
// pdftoppm renders the first page to PNG; sharp resizes + JPEG-encodes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const THUMBS = path.join(ROOT, 'extract', 'thumbs');
const POPPLER = process.env.POPPLER_BIN || 'pdftoppm';
await fs.mkdir(THUMBS, { recursive: true });

// Target: FBI Vault docs + any PDF without a thumbnail already.
const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const seen = new Set();
const queue = [];
for (const d of records) {
  if (!d.sha256 || seen.has(d.sha256)) continue;
  seen.add(d.sha256);
  const isPdf = d.release === 'fbi-vault' || d.type === 'PDF' || /\.pdf$/i.test(d.name || '');
  if (!isPdf) continue;
  if (existsSync(path.join(THUMBS, d.sha256 + '.jpg'))) continue;  // already has thumb
  queue.push(d);
}
console.log(`PDFs needing a thumbnail: ${queue.length}`);

let ok = 0, fail = 0;
for (let i = 0; i < queue.length; i++) {
  const d = queue[i];
  const blob = path.join(ROOT, d.blob_path || `blobs/${d.sha256.slice(0,2)}/${d.sha256.slice(2,4)}/${d.sha256}`);
  if (!existsSync(blob)) { fail++; continue; }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fbi-thumb-'));
  try {
    // Render only page 1 at 100 DPI → tmp/pg-1.png
    const conv = spawnSync(POPPLER, ['-f', '1', '-l', '1', '-r', '100', '-png', blob, path.join(tmp, 'pg')],
      { encoding: 'utf8', timeout: 120000, windowsHide: true });
    if (conv.status !== 0) { fail++; await fs.rm(tmp, { recursive: true, force: true }); continue; }
    const pngs = (await fs.readdir(tmp)).filter(f => f.endsWith('.png'));
    if (!pngs.length) { fail++; await fs.rm(tmp, { recursive: true, force: true }); continue; }
    // Resize to 480px wide cover JPEG (16:9-ish crop from the top of the page)
    await sharp(path.join(tmp, pngs[0]))
      .resize({ width: 480, height: 270, fit: 'cover', position: 'top' })
      .jpeg({ quality: 80 })
      .toFile(path.join(THUMBS, d.sha256 + '.jpg'));
    ok++;
    console.log(`  [${i+1}/${queue.length}] ${(d.title || d.name || '').slice(0,50)}`);
  } catch (e) {
    fail++;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

console.log(`\nFBI/PDF thumbnails: ${ok} created, ${fail} failed`);
