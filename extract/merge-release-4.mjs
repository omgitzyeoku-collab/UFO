// Merge Release 4 (2026-07-10) manifest entries into release-manifest.jsonl.
// The release-4 crawler already embeds CSV metadata into each manifest row,
// so this just classifies type + emits release-manifest entries. Idempotent:
// dedupes by sha256. Modal thumbnails (kind=release4-thumb) are kept in the
// raw crawl manifest but excluded from the corpus (they back the PDFs).

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');

const existing = new Set();
try {
  for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean)) {
    try { existing.add(JSON.parse(l).sha256); } catch {}
  }
} catch {}
console.log(`existing release-manifest shas: ${existing.size}`);

const r4Manifests = (await fs.readdir(MANIFEST_DIR)).filter(f => /^manifest-release4-/.test(f));
console.log(`R4 manifests to merge: ${r4Manifests.join(', ') || '(none)'}`);

const newEntries = [];
let pdf = 0, vid = 0, aud = 0, img = 0, skipThumb = 0, skipDup = 0;

for (const f of r4Manifests) {
  for (const l of (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.status !== 200 || !r.sha256) continue;
    if (r.kind === 'release4-thumb') { skipThumb++; continue; }
    if (existing.has(r.sha256)) { skipDup++; continue; }

    let type = 'PDF';
    if (r.kind === 'dvids-video') { type = 'VID'; vid++; }
    else if (r.kind === 'dvids-audio') { type = 'AUD'; aud++; }
    else if (r.kind === 'release4-image') { type = 'IMG'; img++; }
    else { type = 'PDF'; pdf++; }

    const url = r.url || r.video_url;
    const entry = {
      sha256: r.sha256,
      bytes: r.bytes,
      name: r.suggested_filename || (url ? url.split('/').pop() : null),
      type,
      content_type: r.content_type || (type === 'VID' ? 'video/mp4' : type === 'AUD' ? 'audio/mpeg' : null),
      url,
      release_url: url,
      blob_path: r.blob_path,
      retrieved_at: r.retrieved_at,
      source: 'war.gov',
      release: 'release_4',
      title: r.title || null,
      agency: r.agency || null,
      incident_date: r.incident_date || null,
      incident_location: r.incident_location || null,
      description: r.description || null,
      dvids_id: r.dvids_id || null,
    };
    for (const k of Object.keys(entry)) if (entry[k] == null) delete entry[k];
    newEntries.push(entry);
    existing.add(r.sha256);
  }
}

console.log(`\nNew entries to append: ${newEntries.length}`);
console.log(`  PDFs: ${pdf}, VIDs: ${vid}, AUDs: ${aud}, IMGs: ${img}`);
console.log(`  thumbnails skipped: ${skipThumb}, dup shas skipped: ${skipDup}`);

if (newEntries.length) {
  await fs.appendFile(RELEASE, newEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`appended to ${path.relative(ROOT, RELEASE)}`);
} else {
  console.log('nothing to append');
}
