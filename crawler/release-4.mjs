// Consolidated crawler for war.gov/UFO/ Release 4 (2026-07-10).
// Combines the release-2-delta (direct war.gov assets) and release-2-dvids
// (DVIDS video/audio) patterns into one pass over the 7/10/26 CSV rows.
//
//   - PDF / IMG rows  → direct war.gov medialink URLs, downloaded via warmed
//                        stealth Chromium native download (+ modal thumbnails)
//   - VID / AUD rows  → DVIDS page scrape → CloudFront media URL → node fetch
//
// Writes manifest/manifest-release4-<crawlId>.jsonl with sha256, bytes,
// content_type, and the CSV metadata. Idempotent: skips URLs/DVIDS ids already
// present in any manifest. Merge into release-manifest.jsonl is a separate step.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const RELEASE_DATE = '7/10/26';
const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS = path.join(ROOT, 'docs');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-release4-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"' && text[i+1] === '"') { field += '"'; i++; } else if (c === '"') inQ = false; else field += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += c; }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// === CSV ===
const csvText = await fs.readFile(path.join(DOCS, 'uap-data.csv'), 'utf8');
const rows = parseCsv(csvText);
const header = rows[0].map(h => h.trim());
const records = rows.slice(1).filter(r => r.some(c => (c||'').trim())).map(r => {
  const o = {}; header.forEach((h, i) => { o[h] = (r[i] || '').trim(); }); return o;
});
const r4 = records.filter(r => r['Release Date'] === RELEASE_DATE);
console.log(`Release 4 (${RELEASE_DATE}) records: ${r4.length}`);

// === dedup sets from existing manifests ===
const haveUrl = new Set();
const haveDvids = new Set();
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/\.jsonl$/.test(f)) continue;
  try {
    for (const l of (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); if (r.status === 200 && r.url) haveUrl.add(r.url); if (r.status === 200 && r.video_url) haveUrl.add(r.video_url); if (r.status === 200 && r.dvids_id) haveDvids.add(r.dvids_id); } catch {}
    }
  } catch {}
}
// Also dedup against docs already in release-manifest.jsonl
try {
  for (const l of (await fs.readFile(path.join(ROOT, 'extract', 'release-manifest.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.url) haveUrl.add(r.url); if (r.dvids_id) haveDvids.add(r.dvids_id); } catch {}
  }
} catch {}
console.log(`already-have URLs: ${haveUrl.size}, DVIDS ids: ${haveDvids.size}`);

// === browser ===
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
console.log('warming up war.gov…');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// === direct war.gov asset download (native browser download) ===
async function downloadDirect(url, kind, rec) {
  try {
    const dlP = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); }, url);
    const dl = await dlP;
    const tmp = await dl.path();
    if (!tmp) return { ok: false, err: 'no path' };
    const body = await fs.readFile(tmp);
    if (!body.length) return { ok: false, err: 'empty' };
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    if (!existsSync(blob)) await fs.writeFile(blob, body);
    try { await fs.unlink(tmp); } catch {}
    const suggested = dl.suggestedFilename();
    const ct = /\.pdf$/i.test(suggested) ? 'application/pdf'
      : /\.(jpe?g)$/i.test(suggested) ? 'image/jpeg'
      : /\.png$/i.test(suggested) ? 'image/png'
      : /\.(mp3|wav|m4a|ogg)$/i.test(suggested) ? 'audio/' + suggested.split('.').pop().toLowerCase()
      : 'application/octet-stream';
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: 200,
      content_type: ct, suggested_filename: suggested, bytes: body.length, sha256,
      blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      title: rec['Title'], asset_type: rec['Type'], agency: rec['Agency'],
      incident_date: rec['Incident Date'], incident_location: rec['Incident Location'],
      description: rec['Description Blurb'], release_date: rec['Release Date'],
    });
    return { ok: true, bytes: body.length };
  } catch (e) {
    log.push({ crawl_id: crawlId, kind, url, status: -1, error: e.message.slice(0, 160) });
    return { ok: false, err: e.message.slice(0, 100) };
  }
}

// === DVIDS media resolve + download ===
async function downloadDvids(rec) {
  const id = rec['DVIDS Video ID'];
  const type = rec['Type'];
  const pageUrl = `https://www.dvidshub.net/${type === 'AUD' ? 'audio' : 'video'}/${id}`;
  let mediaUrl = null;
  try {
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (resp && resp.status() >= 400) {
      const alt = `https://www.dvidshub.net/${type === 'AUD' ? 'video' : 'audio'}/${id}`;
      await page.goto(alt, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForTimeout(1200);
    mediaUrl = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const reList = [/(https?:\/\/[^"'\s<>]+\.mp4)/i, /(https?:\/\/[^"'\s<>]+\.mp3)/i, /(https?:\/\/[^"'\s<>]+\.m4a)/i, /(https?:\/\/[^"'\s<>]+\.wav)/i];
      for (const re of reList) { const m = html.match(re); if (m) return m[1]; }
      const v = document.querySelector('video[src], video source[src]'); if (v) return v.src || v.getAttribute('src');
      const a = document.querySelector('audio[src], audio source[src]'); if (a) return a.src || a.getAttribute('src');
      return null;
    });
  } catch (e) {
    log.push({ crawl_id: crawlId, dvids_id: id, page_url: pageUrl, status: -1, error: e.message.slice(0, 160) });
    return { ok: false, err: e.message.slice(0, 100) };
  }
  if (!mediaUrl) { log.push({ crawl_id: crawlId, dvids_id: id, page_url: pageUrl, status: -1, error: 'no media URL' }); return { ok: false, err: 'no media URL' }; }
  let body;
  try {
    const r = await fetch(mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': '*/*', 'Referer': pageUrl } });
    if (r.status !== 200) { log.push({ crawl_id: crawlId, dvids_id: id, page_url: pageUrl, video_url: mediaUrl, status: r.status, error: `fetch ${r.status}` }); return { ok: false, err: `fetch ${r.status}` }; }
    body = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    log.push({ crawl_id: crawlId, dvids_id: id, page_url: pageUrl, video_url: mediaUrl, status: -1, error: e.message.slice(0, 160) }); return { ok: false, err: e.message.slice(0, 100) };
  }
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const blob = await blobPath(sha256);
  if (!existsSync(blob)) await fs.writeFile(blob, body);
  log.push({
    crawl_id: crawlId, retrieved_at: new Date().toISOString(),
    kind: type === 'AUD' ? 'dvids-audio' : 'dvids-video', dvids_id: id,
    title: rec['Title'], asset_type: type, agency: rec['Agency'],
    video_title: rec['Video Title'], description: rec['Description Blurb'],
    incident_date: rec['Incident Date'], incident_location: rec['Incident Location'],
    release_date: rec['Release Date'], page_url: pageUrl, video_url: mediaUrl,
    status: 200, bytes: body.length, sha256, blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
  });
  return { ok: true, bytes: body.length };
}

// === run ===
let ok = 0, fail = 0, skip = 0;
for (let i = 0; i < r4.length; i++) {
  const rec = r4[i];
  const type = rec['Type'];
  const dvidsId = (rec['DVIDS Video ID'] || '').trim();
  const pdfLink = (rec['PDF | Image Link'] || '').trim();
  const modal = (rec['Modal Image'] || '').trim();
  const tag = `[${(i+1).toString().padStart(2)}/${r4.length}] ${type} ${(rec['Title']||'').slice(0,50)}`;

  if (dvidsId) {
    if (haveDvids.has(dvidsId)) { skip++; console.log(`${tag}  SKIP (have dvids ${dvidsId})`); continue; }
    const r = await downloadDvids(rec);
    if (r.ok) { ok++; console.log(`${tag}  → ${(r.bytes/1048576).toFixed(1)}MB`); } else { fail++; console.log(`${tag}  FAIL ${r.err}`); }
  } else if (pdfLink) {
    if (haveUrl.has(pdfLink)) { skip++; console.log(`${tag}  SKIP (have ${pdfLink.split('/').pop()})`); continue; }
    const kind = /\.pdf$/i.test(pdfLink) ? 'release4-pdf' : /\.(jpe?g|png)$/i.test(pdfLink) ? 'release4-image' : 'release4-other';
    const r = await downloadDirect(pdfLink, kind, rec);
    if (r.ok) { ok++; console.log(`${tag}  → ${(r.bytes/1024).toFixed(0)}KB`); } else { fail++; console.log(`${tag}  FAIL ${r.err}`); }
    // modal thumbnail (kept as a raw image record for build-thumbnails)
    if (modal && modal.startsWith('http') && !haveUrl.has(modal)) {
      await downloadDirect(modal, 'release4-thumb', rec);
    }
  } else {
    skip++; console.log(`${tag}  SKIP (no direct URL / dvids id)`);
  }
  if (i % 6 === 5) await page.waitForTimeout(250);
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + (log.length ? '\n' : ''));
await browser.close();

console.log(`\n=== RELEASE 4 CRAWL SUMMARY ===`);
console.log(`  records: ${r4.length} | ok: ${ok} | fail: ${fail} | skipped: ${skip}`);
console.log(`  manifest: ${path.relative(ROOT, manifestPath)}`);
