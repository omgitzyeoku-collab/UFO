// AARO (aaro.mil) mirror: pulls the All-domain Anomaly Resolution Office
// public records — Historical Record Report Vol I, annual reports, case
// summaries, videos.
//
// AARO sits behind AkamaiGHost (same as war.gov) — stealth Chromium required.

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
const manifestPath = path.join(MANIFEST_DIR, `manifest-aaro-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0,2), hash.slice(2,4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

// Existing SHAs to dedup against
const existingSha = new Set();
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/\.jsonl$/.test(f)) continue;
  try {
    const ls = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
    for (const l of ls) { try { const r = JSON.parse(l); if (r.sha256) existingSha.add(r.sha256); } catch {} }
  } catch {}
}
console.log(`existing SHAs (dedup): ${existingSha.size}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true,
});
const page = await ctx.newPage();

const seedPages = [
  'https://www.aaro.mil/',
  'https://www.aaro.mil/Cases/',
  'https://www.aaro.mil/Cases/Aerial-Cases/',
  'https://www.aaro.mil/Cases/Maritime-Cases/',
  'https://www.aaro.mil/Cases/Space-Cases/',
  'https://www.aaro.mil/Library/',
  'https://www.aaro.mil/News/',
];

const discoveredUrls = new Set();
const visitedPages = new Set();

// Capture every download-worthy URL we encounter while loading seed pages
page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (!/^https?:\/\/(www\.)?aaro\.mil\//i.test(url)) return;
    if (visitedPages.has(url) || discoveredUrls.has(url)) return;
    const ct = resp.headers()['content-type'] || '';
    // Track downloadable artefacts
    if (/(\.pdf|\.mp4|\.jpe?g|\.png|\.docx?|\.xlsx?)(\?|$)/i.test(url)
        || /(pdf|image\/|video\/|audio\/)/i.test(ct)) {
      discoveredUrls.add(url);
    }
  } catch {}
});

for (const seedUrl of seedPages) {
  if (visitedPages.has(seedUrl)) continue;
  visitedPages.add(seedUrl);
  console.log(`[seed] ${seedUrl}`);
  try {
    const resp = await page.goto(seedUrl, { waitUntil: 'networkidle', timeout: 60000 });
    if (!resp || resp.status() >= 400) { console.log(`  ${resp?.status()}`); continue; }
    await page.waitForTimeout(2000);

    // Discover internal links + downloadable assets in DOM
    const found = await page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('a[href], iframe[src], video[src], source[src], img[src]')) {
        const u = el.getAttribute('href') || el.getAttribute('src');
        if (!u) continue;
        try { out.add(new URL(u, location.href).href); } catch {}
      }
      // Scrape inline scripts for asset URLs
      const html = document.documentElement.outerHTML;
      for (const m of html.matchAll(/https?:\/\/(?:www\.)?aaro\.mil\/[^"'\s)<>]+/gi)) out.add(m[0]);
      return [...out];
    });

    for (const u of found) {
      if (!/^https?:\/\/(www\.)?aaro\.mil\//i.test(u)) continue;
      // Document-like asset?
      if (/(\.pdf|\.mp4|\.jpe?g|\.png|\.docx?|\.xlsx?|\.zip|\.csv)(\?|$)/i.test(u)) discoveredUrls.add(u);
      // Listing / sub-page? Queue for second-pass crawl
      else if (/\/(Cases|Library|News|Documents?|Reports?|Publications?)/i.test(u) && !visitedPages.has(u) && seedPages.length + visitedPages.size < 80) {
        seedPages.push(u);
      }
    }
  } catch (e) {
    console.log(`  err: ${e.message.slice(0,80)}`);
  }
}

console.log(`\n=== discovered ${discoveredUrls.size} downloadable URLs ===`);

// Download via native browser download
async function downloadOne(url, kind) {
  if (existingSha.size > 0) {
    // Quick HEAD check via in-page fetch to skip massive duplicates
  }
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
    await page.evaluate((u) => {
      const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    }, url);
    const dl = await downloadPromise;
    const tmp = await dl.path();
    if (!tmp) return { ok: false };
    const body = await fs.readFile(tmp);
    if (!body.length) return { ok: false };
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (existingSha.has(sha256)) { try { await fs.unlink(tmp); } catch {} return { ok: true, dedup: true, sha256 }; }
    const blob = await blobPath(sha256);
    if (!existsSync(blob)) await fs.writeFile(blob, body);
    const suggested = dl.suggestedFilename();
    const ct = /\.pdf$/i.test(suggested) ? 'application/pdf'
            : /\.mp4$/i.test(suggested) ? 'video/mp4'
            : /\.(jpe?g)$/i.test(suggested) ? 'image/jpeg'
            : 'application/octet-stream';
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(),
      kind, url, status: 200, content_type: ct, suggested_filename: suggested,
      bytes: body.length, sha256, blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      source: 'aaro.mil',
    });
    existingSha.add(sha256);
    try { await fs.unlink(tmp); } catch {}
    return { ok: true, bytes: body.length, sha256 };
  } catch (e) {
    log.push({ crawl_id: crawlId, kind, url, status: -1, error: e.message.slice(0,200), source: 'aaro.mil' });
    return { ok: false, err: e.message.slice(0,80) };
  }
}

const urlsArr = [...discoveredUrls];
let ok = 0, fail = 0, dedup = 0;
for (let i = 0; i < urlsArr.length; i++) {
  const u = urlsArr[i];
  const kind = /\.pdf/i.test(u) ? 'aaro-pdf'
             : /\.(mp4|mov|webm)/i.test(u) ? 'aaro-video'
             : /\.(jpe?g|png)/i.test(u) ? 'aaro-image'
             : 'aaro-other';
  const r = await downloadOne(u, kind);
  if (r.ok && r.dedup) { dedup++; console.log(`  [${i+1}/${urlsArr.length}] DEDUP ${u.split('/').pop().slice(0,60)}`); }
  else if (r.ok) { ok++; console.log(`  [${i+1}/${urlsArr.length}] ${(r.bytes/1024).toFixed(0).padStart(6)}KB ${u.split('/').pop().slice(0,60)}`); }
  else { fail++; console.log(`  [${i+1}/${urlsArr.length}] FAIL ${u.split('/').pop().slice(0,60)} (${r.err || '?'})`); }
  if (i % 5 === 4) await page.waitForTimeout(200);
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');
await browser.close();

console.log(`\n=== SUMMARY ===`);
console.log(`  Discovered URLs: ${discoveredUrls.size}`);
console.log(`  Downloads: ${ok} ok, ${dedup} dedup, ${fail} failed`);
console.log(`  Manifest: ${manifestPath}`);
