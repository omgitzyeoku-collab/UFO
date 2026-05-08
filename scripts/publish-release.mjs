// Publish war.gov/UFO/ Release 01 corpus as a GitHub Release.
// Each PDF goes up as its own browseable asset with its original filename.
// Thumbnails bundled as a single tar.gz.
// Outputs: extract/release-manifest.jsonl with sha256 + release URL + CSV metadata.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = path.resolve('.');
const REPO = 'omgitzyeoku-collab/UFO';
const TAG = 'v1.0-release-01-mirror';
const TITLE = 'war.gov/UFO/ Release 01 — full mirror';

// Get token from GCM (verified working earlier)
function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.*)$/m);
  if (!m) throw new Error('no GitHub token in credential helper');
  return m[1].trim();
}
const TOKEN = getToken();
console.log(`token type: ${TOKEN.slice(0, 4)}*** (${TOKEN.length} chars)`);

async function api(method, url, opts = {}) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  const r = await fetch(url, { method, headers, body: opts.body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// 1. Build the asset list from the medialink manifest
const manifestFiles = (await fs.readdir(path.join(ROOT, 'manifest')))
  .filter(f => /^manifest-medialink-/.test(f) && !/retry/.test(f))
  .sort();
const manifestPath = path.join(ROOT, 'manifest', manifestFiles[manifestFiles.length - 1]);
console.log(`reading: ${manifestFiles[manifestFiles.length - 1]}`);
const rows = (await fs.readFile(manifestPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
const csvRecords = JSON.parse(await fs.readFile(path.join(ROOT, 'docs', 'uap-csv-parsed.json'), 'utf8'));

// Match each ok PDF/thumb back to its CSV record + canonical filename
function filenameFromUrl(url) {
  return decodeURIComponent(url.split('/').pop().split('?')[0]);
}

const pdfsOk = rows.filter(r => r.kind === 'medialink-pdf' && r.status === 200);
const thumbsOk = rows.filter(r => r.kind === 'medialink-thumb' && r.status === 200);
console.log(`PDFs: ${pdfsOk.length}, thumbnails: ${thumbsOk.length}`);

// 2. Create the release (idempotent — if exists, get id)
console.log(`\n=== ensure release tag=${TAG} ===`);
let release;
{
  const r = await api('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
  if (r.status === 200) {
    release = r.json;
    console.log(`existing release id=${release.id}`);
  } else {
    const body = JSON.stringify({
      tag_name: TAG,
      target_commitish: 'master',
      name: TITLE,
      body: `Full mirror of the US Department of War PURSUE Release 01 (war.gov/UFO/), captured ${new Date().toISOString().slice(0,10)}. Each PDF is a separate downloadable asset. Source: https://www.war.gov/UFO/. The CSV index is preserved at docs/uap-csv.csv. Every artefact is content-addressed by SHA-256 in the manifest.`,
      draft: false, prerelease: false, generate_release_notes: false,
    });
    const c = await api('POST', `https://api.github.com/repos/${REPO}/releases`, {
      body, headers: { 'Content-Type': 'application/json' },
    });
    if (c.status >= 300) { console.error('release create failed:', c.status, c.text.slice(0, 300)); process.exit(1); }
    release = c.json;
    console.log(`created release id=${release.id}`);
  }
}

// Get existing assets
const existingByName = new Map();
{
  let url = `https://api.github.com/repos/${REPO}/releases/${release.id}/assets?per_page=100&page=1`;
  for (let page = 1; page <= 10; page++) {
    const r = await api('GET', url.replace(/page=\d+/, 'page=' + page));
    if (r.status !== 200 || !r.json?.length) break;
    for (const a of r.json) existingByName.set(a.name, a);
    if (r.json.length < 100) break;
  }
}
console.log(`existing assets: ${existingByName.size}`);

// 3. Stage each PDF with its original filename as a hard link (no copy, save disk)
const STAGE = path.join(os.tmpdir(), 'ufo-release-stage');
await fs.rm(STAGE, { recursive: true, force: true });
await fs.mkdir(STAGE, { recursive: true });

const releaseManifest = [];

for (const r of pdfsOk) {
  const name = filenameFromUrl(r.url);
  if (existingByName.has(name)) {
    const a = existingByName.get(name);
    releaseManifest.push({
      sha256: r.sha256, name, url: r.url, bytes: r.bytes,
      release_asset_id: a.id, release_url: a.browser_download_url,
      release_uploaded_at: a.created_at, status: 'already-uploaded',
    });
    continue;
  }
  const src = path.join(ROOT, r.blob_path);
  const dst = path.join(STAGE, name);
  await fs.rm(dst, { force: true });
  try { await fs.link(src, dst); } catch { await fs.copyFile(src, dst); }
  releaseManifest.push({
    sha256: r.sha256, name, url: r.url, bytes: r.bytes, staged: dst, status: 'pending-upload',
  });
}

console.log(`\nstaged ${releaseManifest.filter(r => r.status === 'pending-upload').length} PDFs for upload`);

// 4. Bundle thumbnails as tar.gz
const thumbStage = path.join(STAGE, '_thumbnails');
await fs.mkdir(thumbStage, { recursive: true });
for (const r of thumbsOk) {
  const name = filenameFromUrl(r.url);
  const src = path.join(ROOT, r.blob_path);
  const dst = path.join(thumbStage, name);
  try { await fs.link(src, dst); } catch { await fs.copyFile(src, dst); }
}
const thumbsTar = path.join(STAGE, 'thumbnails.tar.gz');
const tarRes = spawnSync('tar', ['--force-local', '-czf', thumbsTar, '-C', thumbStage, '.'], { encoding: 'utf8' });
if (tarRes.status !== 0) { console.error('tar failed:', tarRes.stderr); process.exit(2); }
const tarStat = await fs.stat(thumbsTar);
console.log(`thumbnails.tar.gz: ${(tarStat.size/1024/1024).toFixed(1)} MB`);

// 5. Upload assets via the release upload endpoint
async function uploadAsset(filePath, name, contentType) {
  const buf = await fs.readFile(filePath);
  const url = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
    },
    body: buf,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// Upload thumbnails tarball if not present
if (!existingByName.has('thumbnails.tar.gz')) {
  console.log(`\nuploading thumbnails.tar.gz...`);
  const r = await uploadAsset(thumbsTar, 'thumbnails.tar.gz', 'application/gzip');
  if (r.status >= 300) console.error(`  FAIL ${r.status} ${r.text.slice(0, 200)}`);
  else console.log(`  ok: ${r.json.browser_download_url}`);
}

// Upload PDFs sequentially with a small delay (avoid rate limits)
console.log(`\nuploading PDFs...`);
const pendingUploads = releaseManifest.filter(r => r.status === 'pending-upload');
let uploaded = 0, failed = 0;
for (let i = 0; i < pendingUploads.length; i++) {
  const r = pendingUploads[i];
  const t0 = Date.now();
  const up = await uploadAsset(r.staged, r.name, 'application/pdf');
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (up.status >= 300) {
    console.log(`  [${i+1}/${pendingUploads.length}] FAIL ${up.status} (${dt}s)  ${r.name}: ${up.text.slice(0,100)}`);
    r.status = 'upload-failed';
    r.upload_error = up.text.slice(0, 300);
    failed++;
  } else {
    r.status = 'uploaded';
    r.release_asset_id = up.json.id;
    r.release_url = up.json.browser_download_url;
    r.release_uploaded_at = up.json.created_at;
    console.log(`  [${i+1}/${pendingUploads.length}] ok ${(r.bytes/1024).toFixed(0).padStart(6)}KB (${dt}s)  ${r.name}`);
    uploaded++;
  }
}

// 6. Write the authoritative release manifest
// Enrich with CSV metadata
const csvByPdfUrl = new Map();
for (const rec of csvRecords) {
  const link = (rec['PDF | Image Link'] || '').toLowerCase();
  if (link) csvByPdfUrl.set(link, rec);
}

const enriched = releaseManifest.map(r => {
  const csv = csvByPdfUrl.get(r.url.toLowerCase()) || {};
  return {
    ...r,
    title: csv.Title?.trim(),
    type: csv.Type?.trim(),
    agency: csv.Agency?.trim(),
    incident_date: csv['Incident Date']?.trim(),
    incident_location: csv['Incident Location']?.trim(),
    description: csv['Description Blurb']?.trim(),
    release_date: csv['Release Date']?.trim(),
  };
});

const releaseManifestPath = path.join(ROOT, 'extract', 'release-manifest.jsonl');
await fs.writeFile(releaseManifestPath,
  enriched.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`\nwrote: ${releaseManifestPath}`);

console.log(`\n=== SUMMARY ===`);
console.log(`  release: https://github.com/${REPO}/releases/tag/${TAG}`);
console.log(`  PDFs uploaded:    ${uploaded}`);
console.log(`  PDFs already up:  ${releaseManifest.filter(r => r.status === 'already-uploaded').length}`);
console.log(`  PDFs failed:      ${failed}`);
console.log(`  total in manifest: ${enriched.length}`);
