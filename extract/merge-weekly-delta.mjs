// Release-agnostic merge into extract/release-manifest.jsonl.
//
// The per-release merge scripts (merge-release-2/4) classify by the crawler's
// `kind` label. That label is unreliable: the generic medialink sweep tagged
// everything it found `medialink-thumb`, so 14 PRIMARY artefacts (fbi-photo-a*,
// nasa-uap-vm*) were stripped as thumbnails and never reached the corpus.
//
// This script uses the live CSV as the authority instead. For every CSV row,
// the "PDF | Image Link" column IS the primary artefact and the "Modal Image"
// column IS the thumbnail — the site tells us directly, so we don't guess. Any
// primary artefact whose bytes we hold but whose SHA is absent from the release
// manifest gets appended, with type taken from the CSV Type column and the
// release tag derived from the medialink URL.
//
// Idempotent: dedupes by sha256.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const CSV_JSON = path.join(ROOT, 'docs', 'uap-csv-parsed.json');

const norm = (u) => u.split('?')[0].toLowerCase();
function releaseFromUrl(u) {
  const m = u.match(/\/release_?0?(\d+)\//i);
  return m ? `release_${parseInt(m[1], 10)}` : null;
}

// DVIDS-hosted media has no medialink URL to derive a release from, so the CSV
// release date is the only signal.
const RELEASE_BY_DATE = {
  '5/8/26': 'release_1',
  '5/22/26': 'release_2',
  '6/12/26': 'release_3',
  '7/10/26': 'release_4',
};

// --- what the release manifest already holds
const existingSha = new Set();
const existingUrl = new Set();
try {
  for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.sha256) existingSha.add(r.sha256); if (r.url) existingUrl.add(norm(r.url)); } catch {}
  }
} catch {}
console.log(`release-manifest: ${existingSha.size} shas`);

// --- every downloaded blob we hold, indexed by URL and by DVIDS id
const byUrl = new Map();
const byDvids = new Map();
for (const f of await fs.readdir(MANIFEST_DIR)) {
  if (!/\.jsonl$/.test(f)) continue;
  for (const l of (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.status !== 200 || !r.sha256 || !r.blob_path) continue;
    if (!existsSync(path.resolve(ROOT, r.blob_path))) continue;
    if (r.url) byUrl.set(norm(r.url), r);        // later crawls win
    if (r.dvids_id) byDvids.set(String(r.dvids_id), r);
  }
}
console.log(`blobs on disk — by URL: ${byUrl.size}, by DVIDS id: ${byDvids.size}`);

// --- CSV is the authority on what is primary
const records = JSON.parse(await fs.readFile(CSV_JSON, 'utf8'));
const newEntries = [];
const counts = {};
let noBlob = 0, dup = 0;

for (const rec of records) {
  const link = (rec['PDF | Image Link'] || '').trim();
  const dvidsId = (rec['DVIDS Video ID'] || '').trim();
  const csvType = (rec['Type'] || '').trim().toUpperCase();

  // A row is either a war.gov medialink artefact or DVIDS-hosted media.
  let url = null, row = null, release = null;
  if (link) {
    url = link.startsWith('http') ? link : ('https://www.war.gov' + (link.startsWith('/') ? link : '/' + link));
    if (/\/thumbnail\//i.test(url)) continue;            // never a primary artefact
    row = byUrl.get(norm(url));
    release = releaseFromUrl(url);
  } else if (dvidsId && (csvType === 'VID' || csvType === 'AUD')) {
    row = byDvids.get(dvidsId);
    url = row?.video_url || row?.page_url || `https://www.dvidshub.net/video/${dvidsId}`;
    release = RELEASE_BY_DATE[(rec['Release Date'] || '').trim()] || null;
  } else {
    continue;
  }

  if (!row) { noBlob++; continue; }
  if (existingSha.has(row.sha256)) { dup++; continue; }

  const type = csvType || 'PDF';
  const entry = {
    sha256: row.sha256,
    bytes: row.bytes,
    name: row.suggested_filename || url.split('/').pop(),
    type,
    content_type: row.content_type || null,
    url,
    release_url: url,
    blob_path: row.blob_path,
    retrieved_at: row.retrieved_at,
    source: 'war.gov',
    release,
    title: rec['Title'] || null,
    agency: rec['Agency'] || null,
    incident_date: rec['Incident Date'] || null,
    incident_location: rec['Incident Location'] || null,
    description: rec['Description Blurb'] || null,
    dvids_id: rec['DVIDS Video ID'] || null,
  };
  for (const k of Object.keys(entry)) if (entry[k] == null) delete entry[k];

  newEntries.push(entry);
  existingSha.add(row.sha256);
  const key = `${release}/${type}`;
  counts[key] = (counts[key] || 0) + 1;
}

console.log(`\nnew entries: ${newEntries.length}`);
console.log(`  by release/type: ${JSON.stringify(counts)}`);
console.log(`  csv rows with no local blob: ${noBlob}, already-merged shas: ${dup}`);

if (newEntries.length) {
  await fs.appendFile(RELEASE, newEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`appended to ${path.relative(ROOT, RELEASE)}`);
  for (const e of newEntries) console.log(`  + ${e.release} ${e.type.padEnd(4)} ${(e.title || e.name).slice(0, 62)}`);
} else {
  console.log('nothing to append');
}
