// Differential crawler for war.gov/UFO/ Release 2.
// 1. Pull the master uap-data.csv
// 2. Parse all rows (handling quoted multi-line fields)
// 3. Diff against existing release-manifest.jsonl
// 4. Download every new artefact via warmed Playwright + native browser download
// 5. Append new entries (with SHA-256, bytes, content type) to a fresh
//    manifest-release2-<crawlId>.jsonl

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS = path.join(ROOT, 'docs');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-release2-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

// === CSV PARSER ===
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// === LOAD EXISTING URLS (to skip) ===
const existingUrls = new Set();
const existingSha = new Set();
try {
  const lines = (await fs.readFile(path.join(ROOT, 'extract', 'release-manifest.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) {
    try { const r = JSON.parse(l); if (r.url) existingUrls.add(r.url); if (r.sha256) existingSha.add(r.sha256); } catch {}
  }
} catch {}
// Also load all manifest-*.jsonl URLs (to skip already-downloaded items even if not in release manifest)
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/\.jsonl$/.test(f)) continue;
  try {
    const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
    for (const l of lines) { try { const r = JSON.parse(l); if (r.url && r.status === 200) existingUrls.add(r.url); if (r.sha256) existingSha.add(r.sha256); } catch {} }
  } catch {}
}
console.log(`existing URLs (skip): ${existingUrls.size}`);
console.log(`existing SHA256s (dedup): ${existingSha.size}`);

// === BROWSER WARMUP ===
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true,
});
const page = await ctx.newPage();

console.log('=== warming up war.gov ===');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// === FETCH MASTER CSV ===
console.log('=== fetching uap-data.csv ===');
const csvRes = await page.evaluate(async () => {
  const r = await fetch('https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-data.csv', { credentials: 'include' });
  return { status: r.status, text: r.status === 200 ? await r.text() : '' };
});
if (csvRes.status !== 200) { console.error(`CSV fetch failed: ${csvRes.status}`); await browser.close(); process.exit(1); }
await fs.writeFile(path.join(DOCS, 'uap-data-r2.csv'), csvRes.text);
console.log(`csv: ${(csvRes.text.length/1024).toFixed(1)} KB`);

const rows = parseCsv(csvRes.text);
const header = rows[0];
console.log(`csv header (${header.length} cols): ${header.join(' | ').slice(0, 200)}…`);

const records = rows.slice(1).filter(r => r.some(c => (c||'').trim())).map(r => {
  const o = {}; header.forEach((h, i) => { o[h.trim()] = (r[i] || '').trim(); });
  return o;
});
console.log(`csv records: ${records.length}`);

// Bucket by release date
const byRelease = {};
for (const r of records) byRelease[r['Release Date'] || 'unknown'] = (byRelease[r['Release Date'] || 'unknown'] || 0) + 1;
console.log('records by release date:');
for (const [d, n] of Object.entries(byRelease).sort((a,b) => b[1]-a[1])) console.log(`  ${d.padEnd(10)} ${n}`);

// === EXTRACT URLS ===
// Each record may have a 'PDF | Image Link' or 'Modal Image' direct URL, or a DVIDS Video ID, or just a Title (PR050 → release_2/050uap?????.pdf — we need to discover the actual pattern).
const newAssetUrls = new Set();
const recordIndex = []; // for building enriched manifest entries later

for (const rec of records) {
  const direct1 = (rec['PDF | Image Link'] || '').trim();
  const direct2 = (rec['Modal Image'] || '').trim();
  const dvidsId = (rec['DVIDS Video ID'] || '').trim();
  const title = (rec['Title'] || '').trim();
  const type = (rec['Type'] || '').trim();

  // Direct URL patterns (war.gov / DVIDS / etc.)
  for (const cand of [direct1, direct2]) {
    if (!cand) continue;
    let u = cand.startsWith('http') ? cand : ('https://www.war.gov' + (cand.startsWith('/') ? cand : '/' + cand));
    // Add raw + try /release_2 variant if release date is 5/22/26
    newAssetUrls.add(u);
  }

  // Inferred URLs by PR ID (DOW-UAP-PR050 → 050uap?????.pdf in release_2)
  const prMatch = title.match(/DOW-UAP-PR(\d{2,3})/i) || (direct1 + ' ' + direct2).match(/PR(\d{2,3})/i);
  if (prMatch) {
    // Don't actually have a deterministic ID-to-filename map. Skip — direct URLs from CSV should cover.
  }

  recordIndex.push({ title, type, agency: rec['Agency'], release_date: rec['Release Date'],
                     incident_date: rec['Incident Date'], incident_location: rec['Incident Location'],
                     description: rec['Description Blurb'], dvids_id: dvidsId,
                     direct: direct1, modal: direct2 });
}

console.log(`\ncandidate URLs from CSV: ${newAssetUrls.size}`);
const toFetch = [...newAssetUrls].filter(u => !existingUrls.has(u));
console.log(`new (not in any existing manifest): ${toFetch.length}`);

// === SCRAPE SPA FOR ADDITIONAL ASSET URLS (Slideshow-2 etc.) ===
console.log('\n=== mining SPA DOM for additional asset URLs ===');
const spaUrls = await page.evaluate(() => {
  const urls = new Set();
  // every <a href>, <img src>, <source src>, <video src>, etc.
  for (const el of document.querySelectorAll('a[href], img[src], source[src], video[src], iframe[src]')) {
    const href = el.getAttribute('href') || el.getAttribute('src');
    if (!href) continue;
    if (/^javascript:/i.test(href)) continue;
    if (/\.(pdf|jpg|jpeg|png|mp4|mov|webm|mp3|wav|m4a|ogg)(\?|$)/i.test(href)) {
      try { urls.add(new URL(href, location.href).href); } catch {}
    }
  }
  // also scrape inline scripts / data attributes for URL-looking strings
  const html = document.documentElement.outerHTML;
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?war\.gov\/[^"'\s)<>]+\.(?:pdf|jpe?g|png|mp4|mov|webm|mp3|wav|m4a|ogg)/gi)) urls.add(m[0]);
  for (const m of html.matchAll(/\/(?:Portals|medialink|portals|media)\/[^"'\s)<>]+\.(?:pdf|jpe?g|png|mp4|mov|webm|mp3|wav|m4a|ogg)/gi)) urls.add('https://www.war.gov' + m[0]);
  return [...urls];
});
console.log(`SPA scraped URLs: ${spaUrls.length}`);
for (const u of spaUrls) if (!existingUrls.has(u)) newAssetUrls.add(u);

const allToFetch = [...newAssetUrls].filter(u => !existingUrls.has(u));
console.log(`TOTAL new to fetch: ${allToFetch.length}`);

// === DOWNLOAD VIA NATIVE BROWSER DOWNLOAD ===
async function downloadOne(url, kind) {
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
    await page.evaluate((u) => {
      const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    }, url);
    const dl = await downloadPromise;
    const tmp = await dl.path();
    if (!tmp) return { ok: false, status: -1, err: 'no path' };
    const body = await fs.readFile(tmp);
    if (!body.length) return { ok: false, status: -1, err: 'empty' };
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    if (!existsSync(blob)) await fs.writeFile(blob, body);
    const suggested = dl.suggestedFilename();
    const ct = /\.pdf$/i.test(suggested) ? 'application/pdf'
            : /\.mp4$/i.test(suggested) ? 'video/mp4'
            : /\.(jpe?g)$/i.test(suggested) ? 'image/jpeg'
            : /\.(mp3|wav|m4a|ogg)$/i.test(suggested) ? 'audio/' + suggested.split('.').pop().toLowerCase()
            : 'application/octet-stream';
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(),
      kind, url, status: 200, content_type: ct, suggested_filename: suggested,
      bytes: body.length, sha256, blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
    });
    try { await fs.unlink(tmp); } catch {}
    return { ok: true, bytes: body.length, sha256 };
  } catch (e) {
    log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: e.message });
    return { ok: false, status: -1, err: e.message.slice(0, 100) };
  }
}

console.log(`\n=== downloading ${allToFetch.length} new assets ===`);
let ok = 0, fail = 0;
for (let i = 0; i < allToFetch.length; i++) {
  const u = allToFetch[i];
  const kind = /\.pdf/i.test(u) ? 'release2-pdf'
             : /\.(mp4|mov|webm)/i.test(u) ? 'release2-video'
             : /\.(mp3|wav|m4a|ogg)/i.test(u) ? 'release2-audio'
             : /\.(jpe?g|png)/i.test(u) ? 'release2-image'
             : 'release2-other';
  const r = await downloadOne(u, kind);
  if (r.ok) { ok++; console.log(`  [${(i+1).toString().padStart(3)}/${allToFetch.length}] ${(r.bytes/1024).toFixed(0).padStart(6)}KB ${u.split('/').pop().slice(0, 80)}`); }
  else { fail++; console.log(`  [${(i+1).toString().padStart(3)}/${allToFetch.length}] FAIL ${r.err || r.status} ${u.split('/').pop().slice(0,80)}`); }
  if (i % 10 === 9) await page.waitForTimeout(200);
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');
await fs.writeFile(path.join(DOCS, `csv-records-r2-${crawlId}.json`), JSON.stringify(recordIndex, null, 2));
await browser.close();

console.log(`\n=== SUMMARY ===`);
console.log(`  CSV rows: ${records.length}`);
console.log(`  Existing URLs skipped: ${existingUrls.size}`);
console.log(`  New downloads: ${ok} ok, ${fail} failed`);
console.log(`  Manifest: ${manifestPath}`);
