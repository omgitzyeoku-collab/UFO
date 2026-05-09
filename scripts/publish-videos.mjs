// Upload the 28 DVIDS videos to the existing GitHub Release
// v1.0-release-01-mirror as named assets. Update extract/release-manifest.jsonl
// with the video records (sha256 + release URL + DVIDS metadata).
//
// Idempotent — skips already-uploaded.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const REPO = 'omgitzyeoku-collab/UFO';
const TAG = 'v1.0-release-01-mirror';

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.*)$/m);
  if (!m) throw new Error('no GitHub token');
  return m[1].trim();
}
const TOKEN = getToken();

async function api(method, url, body, contentType) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (body && Buffer.isBuffer(body)) headers['Content-Length'] = String(body.length);
  const r = await fetch(url, { method, headers, body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// Get release id + existing asset names
const rel = await api('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
if (rel.status !== 200) { console.error('release fetch failed:', rel.status, rel.text.slice(0,200)); process.exit(1); }
const releaseId = rel.json.id;
console.log(`release id=${releaseId}`);
const existing = new Map();
for (const a of (rel.json.assets || [])) existing.set(a.name, a);
console.log(`existing assets: ${existing.size}`);

// Page through additional assets if >100
if (rel.json.assets.length === 100) {
  for (let page = 2; page <= 5; page++) {
    const more = await api('GET', `https://api.github.com/repos/${REPO}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    if (more.status !== 200 || !more.json?.length) break;
    for (const a of more.json) existing.set(a.name, a);
    if (more.json.length < 100) break;
  }
}

// Read DVIDS manifest
const dvidsManifestFiles = (await fs.readdir(path.join(ROOT, 'manifest')))
  .filter(f => /^manifest-dvids-/.test(f)).sort();
const dvidsPath = path.join(ROOT, 'manifest', dvidsManifestFiles[dvidsManifestFiles.length - 1]);
const dvidsRows = (await fs.readFile(dvidsPath, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.status === 200);
console.log(`videos to upload: ${dvidsRows.length}`);

// Asset name = sanitised dvids id + title slug + .mp4
function assetName(r) {
  const slug = (r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `dvids-${r.dvids_id}-${slug}.mp4`;
}

const uploaded = [];
for (let i = 0; i < dvidsRows.length; i++) {
  const r = dvidsRows[i];
  const name = assetName(r);
  if (existing.has(name)) {
    const a = existing.get(name);
    console.log(`  [${i+1}/${dvidsRows.length}] EXISTS ${name}`);
    uploaded.push({ ...r, name, release_asset_id: a.id, release_url: a.browser_download_url });
    continue;
  }
  const blobPath = path.join(ROOT, r.blob_path);
  const body = await fs.readFile(blobPath);
  const t0 = Date.now();
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const u = await api('POST', url, body, 'video/mp4');
  const dt = ((Date.now()-t0)/1000).toFixed(1);
  if (u.status >= 300) {
    console.log(`  [${i+1}/${dvidsRows.length}] FAIL ${u.status} (${dt}s) ${name}: ${u.text.slice(0,200)}`);
  } else {
    console.log(`  [${i+1}/${dvidsRows.length}] ok ${(body.length/1024/1024).toFixed(1).padStart(6)}MB (${dt}s) ${name}`);
    uploaded.push({ ...r, name, release_asset_id: u.json.id, release_url: u.json.browser_download_url, release_uploaded_at: u.json.created_at });
  }
}

// Append to release-manifest.jsonl
const releaseManifestPath = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const existingManifest = (await fs.readFile(releaseManifestPath, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const existingShas = new Set(existingManifest.map(r => r.sha256));
const newRows = [];
for (const u of uploaded) {
  if (existingShas.has(u.sha256)) continue;  // already in manifest
  newRows.push({
    sha256: u.sha256, name: u.name, url: u.video_url, bytes: u.bytes,
    release_asset_id: u.release_asset_id, release_url: u.release_url, release_uploaded_at: u.release_uploaded_at,
    title: u.title, type: 'VID', agency: u.agency,
    dvids_id: u.dvids_id, dvids_page_url: u.page_url, video_title: u.video_title,
    status: 'uploaded',
  });
}
if (newRows.length) {
  const append = newRows.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(releaseManifestPath, append);
  console.log(`\nappended ${newRows.length} video records to extract/release-manifest.jsonl`);
} else {
  console.log('\nno new manifest rows');
}

console.log(`\n=== SUMMARY ===`);
console.log(`  uploaded: ${uploaded.filter(u => u.release_url).length}`);
console.log(`  release: https://github.com/${REPO}/releases/tag/${TAG}`);
