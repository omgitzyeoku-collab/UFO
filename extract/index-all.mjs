// Build a unified index across all manifests covering every captured artefact.
// Output: extract/derived-all.jsonl with one row per unique sha256.
//
// For each artefact: parse what we can from the URL/filename to populate
// agency/doc_type/region/date/kind. Also link to text/<sha>.txt if it exists.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const OUT = path.join(ROOT, 'extract', 'derived-all.jsonl');

const manifestFiles = (await fs.readdir(MANIFEST_DIR)).filter(f => f.endsWith('.jsonl') && f !== 'latest.jsonl');
const seenSha = new Set();
const rows = [];

function inferAgencyFromUrl(url) {
  const u = url.toLowerCase();
  if (u.includes('aaro.mil')) return 'AARO';
  if (u.includes('vault.fbi.gov')) return 'FBI';
  if (u.includes('cia.gov')) return 'CIA';
  if (u.includes('nasa.gov')) return 'NASA';
  if (u.includes('catalog.archives.gov')) return 'NARA';
  if (u.includes('media.defense.gov')) return 'DOD';
  if (u.includes('war.gov')) return 'DOW';
  return null;
}

function inferKind(url, ct = '') {
  if (/\.pdf(\?|$)|application\/pdf|at_download\/file/i.test(url + ' ' + ct)) return 'pdf';
  if (/^image\//i.test(ct) || /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(url)) return 'image';
  if (/^video\//i.test(ct) || /\.(mp4|mov|webm)(\?|$)/i.test(url)) return 'video';
  if (/text\/html/i.test(ct)) return 'html';
  return 'other';
}

function parseDowUfoFilename(url) {
  const name = (url.split('/').pop() || '').replace(/\?.*$/, '');
  // DOW-UAP-PR{N}-Unresolved-UAP-Report-{Region}-{Date}.jpg
  let m = name.match(/^DOW-UAP-(PR\d+)-Unresolved-UAP-Report-(.+?)-(\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)-\d{4})\.jpg$/);
  if (m) return { doc_id: m[1], doc_type: 'Unresolved UAP Report', region: m[2].replace(/-/g, ' '), date_str: m[3] };
  m = name.match(/^FBI-Photo-([A-Z]?\d+)-?\.jpg$/);
  if (m) return { doc_id: `FBI-${m[1]}`, doc_type: 'Photo' };
  m = name.match(/^NASA-UAP-(VM\d+)-Apollo-(\d+)-(\d{4})\.jpg$/);
  if (m) return { doc_id: `NASA-${m[1]}`, doc_type: 'Apollo Visual Material', region: `Apollo ${m[2]}`, date_str: m[3] };
  m = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.jpg$/);
  if (m) return { doc_id: name.replace('.jpg',''), doc_type: m[2].replace(/-/g, ' '), date_str: m[1] };
  return {};
}

function parseAaroFilename(url) {
  const name = decodeURIComponent(url.split('/').pop() || '').replace(/\?.*$/, '');
  return { doc_id: name.replace(/\.[a-z]+$/i, ''), doc_type: name.match(/case|report|paper|brief|memo|analysis/i)?.[0] || null };
}

function parseFbiVaultUrl(url) {
  const m = url.match(/\/UFO\/UFO%20Part%20(\d+)/i);
  if (m) return { doc_id: `FBI-UFO-Part-${parseInt(m[1])}`, doc_type: 'FOIA Release', region: 'FBI Vault' };
  return {};
}

function parseNasaUrl(url) {
  const name = (url.split('/').pop() || '').replace(/\?.*$/, '');
  return { doc_id: name.replace(/\.[a-z]+$/i, ''), doc_type: 'NASA UAP Material' };
}

for (const f of manifestFiles) {
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.status !== 200 || !r.sha256 || !r.blob_path) continue;
    if (seenSha.has(r.sha256)) continue;
    seenSha.add(r.sha256);
    const agency = inferAgencyFromUrl(r.url);
    const kind = inferKind(r.url, r.content_type);
    const filenameMeta = (() => {
      if (agency === 'DOW' && r.url.includes('/UFO/Slideshow/')) return parseDowUfoFilename(r.url);
      if (agency === 'AARO') return parseAaroFilename(r.url);
      if (agency === 'FBI') return parseFbiVaultUrl(r.url);
      if (agency === 'NASA') return parseNasaUrl(r.url);
      return {};
    })();
    const textExists = await fs.stat(path.join(TEXT_DIR, `${r.sha256}.txt`)).then(() => true).catch(() => false);
    rows.push({
      sha256: r.sha256,
      url: r.url,
      bytes: r.bytes,
      blob_path: r.blob_path,
      content_type: r.content_type,
      agency,
      kind,
      ...filenameMeta,
      has_text: textExists,
      first_seen_crawl: r.crawl_id,
    });
  }
}

await fs.writeFile(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const byAgencyKind = {};
for (const r of rows) {
  const k = `${r.agency || '?'} / ${r.kind}`;
  byAgencyKind[k] = (byAgencyKind[k] || 0) + 1;
}
console.log(`indexed ${rows.length} unique artefacts across all crawls\n`);
console.log('by agency / kind:');
for (const [k, n] of Object.entries(byAgencyKind).sort((a,b) => b[1]-a[1])) console.log(`  ${k.padEnd(26)} ${n}`);
const withText = rows.filter(r => r.has_text).length;
console.log(`\nwith extracted text: ${withText}`);
const totalBytes = rows.reduce((a, r) => a + (r.bytes || 0), 0);
console.log(`total bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
