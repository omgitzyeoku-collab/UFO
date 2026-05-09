// Sprint 2: extract aaro.mil PDF records from existing crawl manifests and
// append them to extract/release-manifest.jsonl with source: "aaro.mil".
// The running QA pipeline picks them up next iteration.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');

// Find all crawl manifests that include aaro.mil records
const allFiles = (await fs.readdir(MANIFEST_DIR)).filter(f =>
  /^manifest-(recursive|spa-wargov|medialink)/.test(f) && f.endsWith('.jsonl'));

const aaroBySha = new Map();
for (const f of allFiles) {
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.status !== 200 || !r.sha256 || !r.url) continue;
    if (!/aaro\.mil/.test(r.url)) continue;
    if (!/\.pdf$/i.test(r.url)) continue;  // PDFs only for now; thumbnails too noisy
    if (aaroBySha.has(r.sha256)) continue;
    aaroBySha.set(r.sha256, r);
  }
}
console.log(`found ${aaroBySha.size} unique aaro.mil PDFs in existing crawls`);

// Read existing release-manifest to dedup
const existing = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const existingShas = new Set(existing.map(r => r.sha256));

// Build aaro records in release-manifest format
const newRecords = [];
for (const [sha, r] of aaroBySha) {
  if (existingShas.has(sha)) continue;
  // Filename → title heuristic (aaro filenames are descriptive)
  const fname = decodeURIComponent((r.url || '').split('/').pop().replace(/\.pdf$/i, ''));
  const title = fname
    .replace(/[_-]+/g, ' ')
    .replace(/\b(\w)/g, (m, c) => c.toUpperCase())
    .trim();
  // Infer agency
  let agency = 'AARO';  // most are direct AARO; some are DOW papers via AARO portal
  if (/AAROs?_/i.test(fname)) agency = 'AARO';
  // Infer document type
  let type = 'PDF';
  // Has text already? (from extract-pdf-text run earlier)
  const textPath = path.join(TEXT_DIR, sha + '.txt');
  const hasText = existsSync(textPath);

  newRecords.push({
    sha256: sha,
    name: r.url.split('/').pop(),
    url: r.url,
    bytes: r.bytes,
    blob_path: r.blob_path,
    title: title.slice(0, 200),
    type,
    agency,
    incident_date: '',
    incident_location: '',
    description: `AARO document mirrored from aaro.mil. Original URL: ${r.url}`,
    release_date: '',
    source: 'aaro.mil',
    has_text: hasText,
    release_url: r.url,  // for now; we may re-upload to GitHub Release later
  });
}

console.log(`appending ${newRecords.length} new AARO records to release-manifest.jsonl`);
if (newRecords.length) {
  await fs.appendFile(RELEASE, newRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('done');
}

// Print sample
console.log('\nsample records:');
for (const r of newRecords.slice(0, 8)) {
  console.log(`  [${r.has_text ? '✓' : '?'}] ${r.title.slice(0, 70)}`);
}
