// Ingest NARA UAP electronic-records ZIPs (NRC / ODNI / FAA / DoD) into the
// corpus. These are born-digital, public-domain PDFs from the National
// Archives UAP bulk-download endpoint.
//
//   - Extract each ZIP, SHA-256 every PDF, store as content-addressed blob
//   - Dedup against the existing corpus (don't re-add war.gov/FBI/AARO dupes)
//   - Append manifest entries with source='nara', release='nara-electronic'
//   - Series-level metadata (title, date range, scope note) enriches each doc;
//     the real per-doc headline/date/summary comes later from the QA pipeline
//     reading the PDF body.
//
// The heavy Blue Book photo/case-PDF sets (~700 GB) are deliberately NOT
// mirrored — those get deep-linked to NARA's S3 in a later phase.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve('.');
const ZIPS = path.join(ROOT, 'nara', 'zips');
const JSON_DIR = path.join(ROOT, 'nara', 'json');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
await fs.mkdir(MANIFEST_DIR, { recursive: true });

const UNZIP = process.env.UNZIP_BIN || 'unzip';

// ZIP id → agency mapping
const AGENCY = {
  '488808322': 'NRC',  // Nuclear Regulatory Commission
  '493468579': 'ODNI', // Office of the Director of National Intelligence
  '493468575': 'FAA',  // Federal Aviation Administration
  '493468580': 'OSD',  // Office of the Secretary of Defense
};

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}
function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    createReadStream(p).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

// Load series-level metadata per ZIP (title, dates, scope note)
async function seriesMeta(id) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(JSON_DIR, id + '.json'), 'utf8'));
    const r = Array.isArray(j) ? j[0] : j;
    return {
      title: r.title || null,
      scope: (r.scopeAndContentNote || '').slice(0, 800) || null,
      start: r.inclusiveStartDate?.logicalDate || r.coverageStartDate?.logicalDate || null,
      end: r.inclusiveEndDate?.logicalDate || r.coverageEndDate?.logicalDate || null,
      naId: r.naId || null,
    };
  } catch { return {}; }
}

// Existing corpus SHAs (dedup)
const existing = new Set();
try {
  for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n')) {
    try { const r = JSON.parse(l); if (r.sha256) existing.add(r.sha256); } catch {}
  }
} catch {}
console.log(`existing corpus SHAs: ${existing.size}`);

const crawlId = '2026-06-01-nara';
const manifestPath = path.join(MANIFEST_DIR, `manifest-nara-${crawlId}.jsonl`);
const newEntries = [];
let added = 0, dup = 0;

for (const id of Object.keys(AGENCY)) {
  const zip = path.join(ZIPS, id + '.zip');
  if (!existsSync(zip)) { console.log(`SKIP ${id} (no zip)`); continue; }
  const meta = await seriesMeta(id);
  const agency = AGENCY[id];
  console.log(`\n=== ${agency} (${id}) — ${meta.title || ''} ===`);

  // Extract to a temp dir
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `nara-${id}-`));
  const ex = spawnSync(UNZIP, ['-o', '-q', zip, '-d', tmp], { encoding: 'utf8', timeout: 300000, windowsHide: true });
  if (ex.status !== 0) { console.log(`  unzip failed: ${ex.stderr?.slice(0,120)}`); await fs.rm(tmp, { recursive: true, force: true }); continue; }

  // Walk extracted PDFs
  async function walk(dir) {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await walk(fp));
      else if (/\.pdf$/i.test(e.name)) out.push(fp);
    }
    return out;
  }
  const pdfs = await walk(tmp);
  console.log(`  ${pdfs.length} PDFs`);

  for (const pdf of pdfs) {
    const sha = await sha256File(pdf);
    const stat = await fs.stat(pdf);
    if (existing.has(sha)) { dup++; continue; }
    existing.add(sha);
    const blob = await blobPath(sha);
    if (!existsSync(blob)) await fs.copyFile(pdf, blob);
    const fname = path.basename(pdf);
    newEntries.push({
      sha256: sha,
      bytes: stat.size,
      name: fname,
      type: 'PDF',
      content_type: 'application/pdf',
      // NARA hosts the canonical copy; deep-link to the bulk-download S3 object's parent catalog
      url: meta.naId ? `https://catalog.archives.gov/id/${meta.naId}` : null,
      release_url: meta.naId ? `https://catalog.archives.gov/id/${meta.naId}` : null,
      blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      retrieved_at: new Date(`2026-06-01T12:00:00Z`).toISOString(),
      source: 'nara',
      release: 'nara-electronic',
      agency,
      title: `${agency} UAP record ${fname.replace(/\.pdf$/i, '')}`,
      incident_date: meta.start ? meta.start.slice(0, 4) : null,
      incident_location: null,
      description: meta.scope || meta.title || `${agency} record relating to Unidentified Anomalous Phenomena (NARA bulk release).`,
      nara_series: meta.title || null,
    });
    added++;
  }
  await fs.rm(tmp, { recursive: true, force: true });
}

await fs.writeFile(manifestPath, newEntries.map(e => JSON.stringify(e)).join('\n') + (newEntries.length ? '\n' : ''));
if (newEntries.length) await fs.appendFile(RELEASE, newEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

console.log(`\n=== SUMMARY ===`);
console.log(`  NARA PDFs added: ${added} (dedup skipped: ${dup})`);
const byAgency = {};
for (const e of newEntries) byAgency[e.agency] = (byAgency[e.agency] || 0) + 1;
console.log(`  by agency: ${JSON.stringify(byAgency)}`);
console.log(`  manifest: ${manifestPath}`);
console.log(`  appended to release-manifest.jsonl`);
