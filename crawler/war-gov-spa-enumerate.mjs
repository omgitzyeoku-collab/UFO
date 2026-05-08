// Drive the war.gov/UFO/ SPA: open page, capture every XHR/fetch + every link
// the JS reveals, click each slideshow item to trigger document detail loads,
// then download every medialink PDF.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS_DIR = path.join(ROOT, 'docs');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });
await fs.mkdir(DOCS_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-spa-wargov-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

const networkLog = [];
const seenUrls = new Set();

page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    const ct = resp.headers()['content-type'] || '';
    const status = resp.status();
    networkLog.push({ url, status, ct, type: resp.request().resourceType() });
    // Capture every war.gov resource we haven't already
    if (!/^https?:\/\/(www\.)?war\.gov\//.test(url)) return;
    const body = await resp.body().catch(() => null);
    if (!body || body.length === 0) return;
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(),
      kind: 'spa-render', url, status, content_type: ct,
      bytes: body.length, sha256,
      blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
    });
  } catch {}
});

console.log('=== loading war.gov/UFO/ ===');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// Scroll to bottom to trigger any lazy load
for (let y = 0; y <= 12000; y += 1000) {
  await page.evaluate(yy => window.scrollTo(0, yy), y);
  await page.waitForTimeout(400);
}

// Look for clickable cards/slides in the slideshow
const cardSelectors = [
  '[class*="slide" i] a, [class*="card" i] a, [class*="tile" i] a',
  '.dgov2slideshow a, .dgov2slideshow [data-target], .dgov2slideshow [tabindex]',
  '[role="button"], a[href*="UFO/#"]',
];

const candidateUrls = await page.evaluate(() => {
  // Find every element with an href containing #UFO or that looks like a doc-detail anchor
  const all = Array.from(document.querySelectorAll('a, [data-href], [data-anchor], [data-id]'));
  const set = new Set();
  for (const el of all) {
    const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
    if (/^#[A-Z]/.test(href) || /\/UFO\/?#/.test(href)) {
      const abs = new URL(href, location.href).href;
      set.add(abs);
    }
  }
  return [...set];
});
console.log(`anchor candidates: ${candidateUrls.length}`);
for (const u of candidateUrls.slice(0, 30)) console.log(`  ${u}`);

// Try to click each slideshow card to trigger detail-panel load
const slideshowItems = await page.locator('.dgov2slideshow [class*="slide" i], [class*="slide" i] a, [class*="card" i], button[aria-label*="document" i]').all();
console.log(`slideshow items found: ${slideshowItems.length}`);

const detailPanels = [];
for (let i = 0; i < Math.min(slideshowItems.length, 100); i++) {
  try {
    await slideshowItems[i].scrollIntoViewIfNeeded({ timeout: 3000 });
    await slideshowItems[i].click({ timeout: 3000 });
    await page.waitForTimeout(1200);
    const url = page.url();
    const html = await page.content();
    const downloadLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href;
        if (/medialink|\.pdf|\.PDF/.test(h)) links.push({ href: h, text: (a.textContent||'').trim().slice(0,80) });
      });
      return links;
    });
    if (downloadLinks.length) {
      console.log(`[${i+1}/${slideshowItems.length}] ${url}`);
      for (const l of downloadLinks.slice(0, 5)) console.log(`    ${l.text} → ${l.href}`);
      detailPanels.push({ url, downloadLinks });
    }
    // Try to close any modal so next click works
    const closes = await page.locator('button[aria-label*="close" i], .close, [data-dismiss]').all();
    for (const c of closes.slice(0,2)) { try { await c.click({ timeout: 1000 }); await page.waitForTimeout(300); } catch {} }
  } catch (e) {
    // continue
  }
}

// Save the rendered DOM (post-interaction) so we can grep for full doc index later
const finalHtml = await page.content();
await fs.writeFile(path.join(DOCS_DIR, `war-gov-ufo-spa-driven-${crawlId}.html`), finalHtml);

// Save network log
await fs.writeFile(path.join(DOCS_DIR, `network-log-${crawlId}.json`), JSON.stringify(networkLog, null, 2));

// Collect every medialink URL discovered anywhere
const medialinkUrls = new Set();
for (const r of networkLog) if (/medialink/i.test(r.url)) medialinkUrls.add(r.url);
const finalDom = finalHtml;
for (const m of finalDom.matchAll(/https?:\/\/[^"'\s)]+medialink[^"'\s)]+/gi)) medialinkUrls.add(m[0]);
for (const m of finalDom.matchAll(/\/medialink\/ufo\/[^"'\s)]+/gi)) medialinkUrls.add('https://www.war.gov' + m[0]);
for (const p of detailPanels) for (const dl of p.downloadLinks) if (/medialink|\.pdf/i.test(dl.href)) medialinkUrls.add(dl.href);

console.log(`\n=== medialink URLs discovered: ${medialinkUrls.size} ===`);
for (const u of [...medialinkUrls].slice(0, 30)) console.log(`  ${u}`);

// Fetch every medialink URL via in-page fetch (inherits Akamai cookies)
console.log('\n=== fetching medialink PDFs via in-page fetch ===');
let fetched = 0, failed = 0;
for (const u of medialinkUrls) {
  if (seenUrls.has(u)) continue;
  try {
    const res = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' });
      const ab = await r.arrayBuffer();
      return { status: r.status, ct: r.headers.get('content-type') || '', bytes: Array.from(new Uint8Array(ab)) };
    }, u);
    if (res.status === 200 && res.bytes.length) {
      const body = Buffer.from(res.bytes);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const blob = await blobPath(sha256);
      try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
      log.push({
        crawl_id: crawlId, retrieved_at: new Date().toISOString(),
        kind: 'medialink-pdf', url: u, status: 200,
        content_type: res.ct, bytes: body.length, sha256,
        blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      });
      console.log(`  [200] ${(body.length/1024).toFixed(0)}KB  ${u}`);
      fetched++;
    } else {
      console.log(`  [${res.status}] FAIL  ${u}`);
      failed++;
    }
  } catch (e) {
    console.error(`  ERR ${u}: ${e.message.slice(0,80)}`);
    failed++;
  }
}

await browser.close();

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');

console.log(`\n=== SUMMARY ===`);
console.log(`  network responses: ${networkLog.length}`);
console.log(`  medialink discovered: ${medialinkUrls.size}`);
console.log(`  PDFs fetched: ${fetched}`);
console.log(`  failures: ${failed}`);
console.log(`  total log rows: ${log.length}`);
console.log(`  manifest: ${manifestPath}`);
