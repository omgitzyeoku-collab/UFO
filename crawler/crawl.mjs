import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-${crawlId}.jsonl`);
const latestPath = path.join(MANIFEST_DIR, 'latest.jsonl');
const log = [];

const KNOWN_PRS = new Set(['PR19', 'PR26', 'PR34', 'PR35', 'PR38', 'PR43', 'PR45', 'PR46', 'PR49']);

const CONFIRMED_ASSETS = [
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/2024-04-30-Composite-Sketch.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR19-Unresolved-UAP-Report-Middle-East-May-2022.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR26-Unresolved-UAP-Report-United-Arab-Emirates-October-2023.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR34-Unresolved-UAP-Report-Greece-October-2023.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR35-Unresolved-UAP-Report-Greece-October-2023.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR38-Unresolved-UAP-Report-Middle-East-2013.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR43-Unresolved-UAP-Report-Africa-2025.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR45-Unresolved-UAP-Report-Middle-East-2020.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR46-Unresolved-UAP-Report-INDOPACOM-2024.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/DOW-UAP-PR49-Unresolved-UAP-Report-Department-of-the-Army-2026.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/FBI-Photo-1.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/FBI-Photo-A5.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/FBI-Photo-B2.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/FBI-Photo-B7-.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/FBI-Photo-B18.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/FBI-Photo-B20.jpg',
  'https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow/NASA-UAP-VM6-Apollo-17-1972.jpg',
];

const SEEDS = [
  ['page', 'https://www.war.gov/UFO/'],
  ['page', 'https://www.war.gov/News/Releases/Release/Article/4480582/department-of-war-releases-unidentified-anomalous-phenomena-files-in-historic-t/'],
];

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 900 },
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

async function captureViaResponseListener(page, url, kind) {
  // Wait for the response that matches the URL we navigated to
  return new Promise(async (resolve) => {
    let resolved = false;
    const handler = async (resp) => {
      if (resolved) return;
      if (resp.url() !== url) return;
      resolved = true;
      page.off('response', handler);
      try {
        const status = resp.status();
        const headers = resp.headers();
        const body = await resp.body().catch(() => null);
        const bytes = body?.length || 0;
        let sha256 = null, blob = null;
        if (body && bytes > 0) {
          sha256 = crypto.createHash('sha256').update(body).digest('hex');
          blob = await blobPath(sha256);
          try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
        }
        const row = {
          crawl_id: crawlId,
          retrieved_at: new Date().toISOString(),
          kind,
          url,
          final_url: resp.url(),
          status,
          content_type: headers['content-type'] || null,
          content_length: headers['content-length'] || null,
          last_modified: headers['last-modified'] || null,
          etag: headers['etag'] || null,
          cache_control: headers['cache-control'] || null,
          server: headers['server'] || null,
          bytes,
          sha256,
          blob_path: blob ? path.relative(ROOT, blob).replace(/\\/g, '/') : null,
        };
        log.push(row);
        console.log(`  [${status}] ${kind.padEnd(8)} ${bytes.toString().padStart(8)}B  ${url}`);
        resolve(row);
      } catch (e) {
        console.error(`  [ERR] ${url}: ${e.message}`);
        log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: e.message });
        resolve(null);
      }
    };
    page.on('response', handler);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        page.off('response', handler);
        log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: 'timeout' });
        console.error(`  [TIMEOUT] ${url}`);
        resolve(null);
      }
    }, 30000);
  });
}

async function fetchInPage(page, url, kind) {
  const cap = captureViaResponseListener(page, url, kind);
  page.evaluate(u => fetch(u, { credentials: 'include', mode: 'no-cors' }).catch(() => {}), url).catch(() => {});
  return cap;
}

const page = await ctx.newPage();
const seenAssetUrls = new Set();

// Hook ALL responses from the index render so we capture every asset including hidden/lazy ones
page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (seenAssetUrls.has(url)) return;
    if (!/^https?:\/\/(www\.)?war\.gov\//.test(url)) return;  // limit to war.gov for now
    seenAssetUrls.add(url);
    const status = resp.status();
    const headers = resp.headers();
    const body = await resp.body().catch(() => null);
    if (!body) return;
    const bytes = body.length;
    if (bytes === 0) return;
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
    log.push({
      crawl_id: crawlId,
      retrieved_at: new Date().toISOString(),
      kind: 'render-capture',
      url,
      final_url: resp.url(),
      status,
      content_type: headers['content-type'] || null,
      content_length: headers['content-length'] || null,
      last_modified: headers['last-modified'] || null,
      etag: headers['etag'] || null,
      cache_control: headers['cache-control'] || null,
      server: headers['server'] || null,
      bytes,
      sha256,
      blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
    });
  } catch {}
});

console.log('=== RENDERING SEED PAGES (auto-capture all war.gov resources) ===');
for (const [kind, url] of SEEDS) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    for (let y = 0; y <= 8000; y += 800) {
      await page.evaluate(yy => window.scrollTo(0, yy), y);
      await page.waitForTimeout(400);
    }
    console.log(`  rendered: ${url}`);
  } catch (e) {
    console.error(`  navigate fail: ${url} ${e.message}`);
  }
}

// At this point page.on('response') has already captured every linked asset.
// Now make sure ALL CONFIRMED_ASSETS are present — fall back to in-page fetch for any missing.
console.log('\n=== ENSURING ALL CONFIRMED RELEASE 01 ASSETS ARE CAPTURED ===');
// Re-navigate to UFO/ so subsequent in-page fetches share its origin
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
for (const asset of CONFIRMED_ASSETS) {
  if (seenAssetUrls.has(asset)) continue;
  await fetchInPage(page, asset, 'asset');
  await page.waitForTimeout(200);
}

// Visual provenance — full page screenshot
console.log('\n=== VISUAL PROVENANCE ===');
for (let y = 0; y <= 8000; y += 800) {
  await page.evaluate(yy => window.scrollTo(0, yy), y);
  await page.waitForTimeout(300);
}
const docsDir = path.join(ROOT, 'docs');
await fs.mkdir(docsDir, { recursive: true });
const shotPath = path.join(docsDir, `screenshot-${crawlId}.png`);
await page.screenshot({ path: shotPath, fullPage: true });
const shotBuf = await fs.readFile(shotPath);
const shotHash = crypto.createHash('sha256').update(shotBuf).digest('hex');
const shotBlob = await blobPath(shotHash);
try { await fs.access(shotBlob); } catch { await fs.writeFile(shotBlob, shotBuf); }
log.push({
  crawl_id: crawlId,
  retrieved_at: new Date().toISOString(),
  kind: 'screenshot',
  url: 'https://www.war.gov/UFO/',
  status: 200,
  content_type: 'image/png',
  bytes: shotBuf.length,
  sha256: shotHash,
  blob_path: path.relative(ROOT, shotBlob).replace(/\\/g, '/'),
  note: 'full-page screenshot of UFO/ index at crawl time',
});
console.log(`  screenshot: ${shotBuf.length}B sha256=${shotHash.slice(0,12)}`);

await browser.close();

// De-dupe log on (kind,url): keep the one with sha256
const byKey = new Map();
for (const r of log) {
  const key = `${r.kind}::${r.url}`;
  const existing = byKey.get(key);
  if (!existing || (!existing.sha256 && r.sha256)) byKey.set(key, r);
}
const final = [...byKey.values()];

const lines = final.map(r => JSON.stringify(r)).join('\n') + '\n';
await fs.writeFile(manifestPath, lines);
await fs.writeFile(latestPath, lines);

const ok = final.filter(r => r.status === 200).length;
const fail = final.filter(r => r.status && r.status !== 200).length;
const totalBytes = final.reduce((a, r) => a + (r.bytes || 0), 0);
console.log(`\n=== CRAWL ${crawlId} ===`);
console.log(`  ${ok} ok, ${fail} non-200, ${final.length} rows`);
console.log(`  ${(totalBytes / 1024 / 1024).toFixed(2)} MB total`);
console.log(`  manifest: ${manifestPath}`);

// Quick inventory of UFO assets specifically
const ufoAssets = final.filter(r => r.url && /Interactive\/2026\/UFO\/Slideshow/i.test(r.url) && r.status === 200);
console.log(`\n=== UFO RELEASE 01 ASSETS CAPTURED: ${ufoAssets.length} ===`);
for (const a of ufoAssets) {
  const name = a.url.split('/').pop();
  console.log(`  ${a.bytes.toString().padStart(8)}B  ${a.sha256?.slice(0,12)}  ${name}`);
}
