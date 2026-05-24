// For each doc with a thumbnail, copy the thumbnail blob to extract/thumbs/<sha>.jpg
// so the public site can reference them at /extract/thumbs/<sha>.jpg.
//
// Sources:
//   - medialink manifest 'medialink-thumb' rows (war.gov UFO thumbnails)
//   - dvids manifest video poster frames (best-effort, optional)
// Match strategy: by URL pattern. A war.gov PDF/IMG record's source URL is
// like .../release_1/<slug>.<ext>; the thumbnail at .../thumbnail/<slug>.jpg
// shares the same slug. Look up by slug match.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const THUMBS = path.join(ROOT, 'extract', 'thumbs');
await fs.mkdir(THUMBS, { recursive: true });

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];

// Find all thumbnail blobs from the manifest dir
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const thumbBlobBySlug = new Map();  // slug → { sha256, blob_path }
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/^manifest-(medialink|release2)/.test(f)) continue;
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.status !== 200 || !r.sha256 || !r.url) continue;
    // Release 1: .../thumbnail/<slug>.jpg
    if (r.kind === 'medialink-thumb') {
      const m = r.url.match(/thumbnail\/([^/?]+)\.(jpg|jpeg|png)/i);
      if (!m) continue;
      const slug = m[1].toLowerCase();
      if (!thumbBlobBySlug.has(slug)) thumbBlobBySlug.set(slug, { sha256: r.sha256, blob_path: r.blob_path });
    }
    // Release 2: .../release_02/documents/<stem>.jpg pairs with .pdf of same stem
    else if (r.kind === 'release2-image' && /\.jpe?g$/i.test(r.url)) {
      const stem = r.url.split('/').pop().replace(/\.jpe?g$/i, '').toLowerCase();
      if (!thumbBlobBySlug.has(stem)) thumbBlobBySlug.set(stem, { sha256: r.sha256, blob_path: r.blob_path });
    }
  }
}
console.log(`thumbnail blobs found by slug: ${thumbBlobBySlug.size}`);

let copied = 0, missing = 0, alreadyImg = 0;
for (const d of docs) {
  // If the doc itself is an image, use it as its own thumbnail
  if (d.type === 'IMG' || /\.(jpe?g|png)$/i.test(d.name || '')) {
    const blobPath = path.join(ROOT, d.blob_path || `blobs/${d.sha256.slice(0,2)}/${d.sha256.slice(2,4)}/${d.sha256}`);
    if (existsSync(blobPath)) {
      const dst = path.join(THUMBS, d.sha256 + '.jpg');
      try { await fs.copyFile(blobPath, dst); alreadyImg++; copied++; } catch {}
      continue;
    }
  }

  // Otherwise: derive slug from URL and look up thumbnail blob.
  // Try Release 1 pattern first, then Release 2 pattern.
  const url = d.url || d.release_url || '';
  let slug = null;
  const m1 = url.match(/\/release_1\/([^/?]+)\.(pdf|jpg|jpeg|png|mp4)/i);
  if (m1) slug = m1[1].toLowerCase();
  else {
    const m2 = url.match(/\/release_02\/documents\/([^/?]+)\.(pdf|jpg|jpeg|png|mp4)/i);
    if (m2) slug = m2[1].toLowerCase();
  }
  if (!slug) { missing++; continue; }
  const tb = thumbBlobBySlug.get(slug);
  if (!tb) { missing++; continue; }

  const blobPath = path.join(ROOT, tb.blob_path);
  if (!existsSync(blobPath)) { missing++; continue; }

  const dst = path.join(THUMBS, d.sha256 + '.jpg');
  try {
    await fs.copyFile(blobPath, dst);
    copied++;
  } catch {
    missing++;
  }
}

console.log(`copied: ${copied} (${alreadyImg} self-image), missing: ${missing}, total docs: ${docs.length}`);
console.log(`output: extract/thumbs/`);
