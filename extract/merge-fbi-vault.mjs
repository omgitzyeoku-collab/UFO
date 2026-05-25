// Merge already-mirrored FBI Vault PDFs into extract/release-manifest.jsonl.
// These 16 "UFO Part NN" files were captured by an earlier crawl but never
// appended to the release manifest, so they don't appear on the public site.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const MANIFEST_DIR = path.join(ROOT, 'manifest');

// Existing release SHAs (skip)
const existing = new Set();
try {
  const ls = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of ls) { try { existing.add(JSON.parse(l).sha256); } catch {} }
} catch {}
console.log(`existing release-manifest SHAs: ${existing.size}`);

// Scan every manifest for vault.fbi.gov PDFs, keep first occurrence per SHA
const fbiPdfs = new Map();
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/\.jsonl$/.test(f)) continue;
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) {
    try { const r = JSON.parse(l);
      if (!/vault\.fbi\.gov/i.test(r.url||'')) continue;
      if (r.status !== 200 || !r.sha256) continue;
      if (r.content_type !== 'application/pdf') continue;
      if (existing.has(r.sha256)) continue;
      if (fbiPdfs.has(r.sha256)) continue;
      // Prefer URLs without /at_download/file (cleaner canonical)
      fbiPdfs.set(r.sha256, r);
    } catch {}
  }
}
console.log(`FBI Vault PDFs to merge: ${fbiPdfs.size}`);

const newEntries = [];
for (const r of fbiPdfs.values()) {
  // Derive title from URL: "/UFO/UFO%20Part%2001/..." → "UFO Part 01"
  const m = r.url.match(/\/UFO\/([^/]+)/i);
  const titleRaw = m ? decodeURIComponent(m[1]) : 'FBI Vault UFO file';
  const title = titleRaw.replace(/\s+/g, ' ').trim();
  // Year: FBI Vault UFO files cover ~1947-1977 (Project Blue Book era, post-Roswell)
  const partNum = parseInt((title.match(/Part\s*(\d+)/i)||[])[1] || '0');

  const entry = {
    sha256: r.sha256,
    bytes: r.bytes,
    name: title + '.pdf',
    type: 'PDF',
    content_type: 'application/pdf',
    url: r.url.replace(/\/at_download\/file$/, ''),
    release_url: r.url.replace(/\/at_download\/file$/, ''),
    blob_path: r.blob_path,
    retrieved_at: r.retrieved_at,
    source: 'fbi.gov',
    release: 'fbi-vault',
    title,
    agency: 'FBI',
    description: 'Declassified UFO/UAP-related case files from the FBI Vault. Originals cover roughly 1947–1977, including Project Blue Book era reports, Roswell-related material, and historical sighting investigations. Scanned PDFs from the FBI public reading room.',
  };
  newEntries.push(entry);
}

if (newEntries.length) {
  await fs.appendFile(RELEASE, newEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`appended ${newEntries.length} FBI Vault entries to ${RELEASE}`);
} else {
  console.log('nothing to append');
}
