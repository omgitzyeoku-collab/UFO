// Recursive multi-domain crawler. BFS within scope, captures every
// HTML/PDF/image, hashes content-addressably, appends to manifest.
//
// PDFs and direct asset URLs are fetched via APIRequestContext (page.goto
// chokes on PDFs because Chrome treats them as downloads).

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-recursive-${crawlId}.jsonl`);
const log = [];

const SCOPES = [
  {
    domain: 'www.war.gov',
    include: [/^https:\/\/www\.war\.gov\/UFO\/?/i, /^https:\/\/www\.war\.gov\/News\/Releases\/Release\/Article\/4480582/i],
    exclude: [/#/i, /\/Photos\//i, /\/Videos\//i, /\/Spotlights\/Drone/i],
    max_pages: 50,
    follow_links: true,
  },
  {
    domain: 'www.aaro.mil',
    include: [/^https:\/\/www\.aaro\.mil\/(UAP-|Resources|EFOIA|Submit-A-Report|About|Releases|News|Multimedia|Portals)/i, /^https:\/\/www\.aaro\.mil\/?$/],
    exclude: [/#/i, /\/login/i],
    max_pages: 800,
    follow_links: true,
  },
  {
    domain: 'media.defense.gov',
    include: [/^https:\/\/media\.defense\.gov\/[^?]*\.(pdf|jpg|jpeg|png|mp4|mov|webp)/i],
    exclude: [],
    max_pages: 500,
    follow_links: false,
  },
  {
    domain: 'vault.fbi.gov',
    include: [/^https:\/\/vault\.fbi\.gov\/UFO/i],
    exclude: [/#/i, /\/login_form/i, /sortFilter=/i],
    max_pages: 200,
    follow_links: true,
  },
  {
    domain: 'www.cia.gov',
    include: [/^https:\/\/www\.cia\.gov\/readingroom\/(historical-collections\/ufos|search\/site\/ufo|document\/.*ufo|collection\/ufo)/i],
    exclude: [/#/i],
    max_pages: 300,
    follow_links: true,
  },
];

const seeds = [
  'https://www.war.gov/UFO/',
  'https://www.war.gov/News/Releases/Release/Article/4480582/department-of-war-releases-unidentified-anomalous-phenomena-files-in-historic-t/',
  'https://www.aaro.mil/',
  'https://www.aaro.mil/UAP-Cases/Official-UAP-Imagery/',
  'https://www.aaro.mil/UAP-Cases/UAP-Case-Resolution-Reports/',
  'https://www.aaro.mil/UAP-Cases/UAP-Reporting-Trends/',
  'https://www.aaro.mil/UAP-Records/',
  'https://www.aaro.mil/Resources/',
  'https://www.aaro.mil/EFOIA-Reading-Room/',
  'https://www.aaro.mil/Releases/',
  'https://www.aaro.mil/News/',
  'https://vault.fbi.gov/UFO',
  'https://www.cia.gov/readingroom/historical-collections/ufos-fact-fiction-or-classified',
  'https://www.cia.gov/readingroom/collection/ufos-fact-fiction-or-classified',
];

function ruleFor(url) {
  let u;
  try { u = new URL(url); } catch { return { scope: null, eligible: false }; }
  for (const s of SCOPES) {
    if (s.domain === u.host) {
      const includeOk = s.include.some(re => re.test(url));
      const excludeBad = s.exclude.some(re => re.test(url));
      return { scope: s, eligible: includeOk && !excludeBad };
    }
  }
  return { scope: null, eligible: false };
}

function isPdf(url, ct = '') {
  if (/\.pdf(\?|$)/i.test(url)) return true;
  if (/at_download\/file/i.test(url)) return true;
  if (/pdf/i.test(ct)) return true;
  return false;
}
function isAsset(url, ct = '') {
  if (isPdf(url, ct)) return true;
  if (/\.(jpe?g|png|gif|webp|svg|mp4|mov|webm|tif{1,2})(\?|$)/i.test(url)) return true;
  if (/^image\//i.test(ct) || /^video\//i.test(ct)) return true;
  return false;
}

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
  acceptDownloads: false,
});
const page = await ctx.newPage();

const seenUrls = new Set();
const fetchedUrls = new Set();
const queue = [];
const perDomainCount = new Map();

// Listener: capture every in-page-rendered response (HTML, images, etc)
page.on('response', async (resp) => {
  try {
    const url = resp.url();
    if (fetchedUrls.has(url)) return;
    const headers = resp.headers();
    const ct = headers['content-type'] || '';
    const inScope = SCOPES.some(s => {
      try { return new URL(url).host === s.domain; } catch { return false; }
    });
    if (!inScope) return;
    // Skip downloads-only content here; we'll fetch PDFs via request.get explicitly
    if (isPdf(url, ct)) return;
    fetchedUrls.add(url);
    const status = resp.status();
    const body = await resp.body().catch(() => null);
    if (!body || body.length === 0) return;
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: 'render-capture',
      url, final_url: resp.url(), status,
      content_type: ct, content_length: headers['content-length'] || null,
      last_modified: headers['last-modified'] || null, etag: headers['etag'] || null,
      cache_control: headers['cache-control'] || null,
      bytes: body.length, sha256, blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
    });
  } catch {}
});

import { spawnSync } from 'node:child_process';
import os from 'node:os';

function fetchViaCurl(url, referer) {
  const args = [
    '-sS', '-L',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-H', 'Accept: */*',
    '-H', 'Accept-Language: en-US,en;q=0.9',
    '--max-time', '180',
    '-w', '\n__HTTP_STATUS__%{http_code}\n__CT__%{content_type}\n',
    '--output', '-',
    url,
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  const r = spawnSync('curl', args, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 200, windowsHide: true });
  if (r.status !== 0) return { status: -1, body: null, contentType: null, err: r.stderr?.toString().slice(0, 200) };
  const out = r.stdout;
  // Trailing footer: \n__HTTP_STATUS__NNN\n__CT__type\n
  const footerMatch = out.lastIndexOf(Buffer.from('__HTTP_STATUS__'));
  if (footerMatch < 0) return { status: -1, body: null, contentType: null };
  const body = out.subarray(0, footerMatch - 1);  // exclude the leading \n we added before __HTTP_STATUS__
  const tail = out.subarray(footerMatch).toString();
  const m = tail.match(/__HTTP_STATUS__(\d+)\n__CT__(.*)\n?/);
  return { status: m ? parseInt(m[1]) : -1, body, contentType: m ? m[2].trim() : null };
}

async function fetchAsset(url, kind = 'asset', referer = null) {
  if (fetchedUrls.has(url)) return;
  fetchedUrls.add(url);
  let host; try { host = new URL(url).host; } catch { host = ''; }
  // FBI Vault and other Plone/Akamai-like sources need real curl TLS fingerprint
  const useCurl = /vault\.fbi\.gov$/i.test(host) || /\.cia\.gov$/i.test(host);

  let status = -1, body = null, respHeaders = {}, finalUrl = url;
  try {
    if (useCurl) {
      const r = fetchViaCurl(url, referer);
      status = r.status;
      body = r.body;
      respHeaders = { 'content-type': r.contentType };
    } else {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      };
      if (referer) headers['Referer'] = referer;
      const resp = await fetch(url, { headers, redirect: 'follow' });
      status = resp.status;
      respHeaders = Object.fromEntries(resp.headers.entries());
      const ab = await resp.arrayBuffer();
      body = Buffer.from(ab);
      finalUrl = resp.url || url;
    }
  } catch (e) {
    console.error(`  [ERR] ${kind} ${url}: ${e.message.slice(0,80)}`);
    log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: e.message });
    return;
  }

  const bytes = body ? body.length : 0;
  let sha256 = null, blob = null;
  if (bytes > 0 && status === 200) {
    sha256 = crypto.createHash('sha256').update(body).digest('hex');
    blob = await blobPath(sha256);
    try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
  }
  log.push({
    crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind,
    url, final_url: finalUrl, status,
    content_type: respHeaders['content-type'] || null,
    content_length: respHeaders['content-length'] || null,
    last_modified: respHeaders['last-modified'] || null,
    etag: respHeaders['etag'] || null,
    cache_control: respHeaders['cache-control'] || null,
    referer,
    bytes, sha256, blob_path: blob ? path.relative(ROOT, blob).replace(/\\/g, '/') : null,
  });
  console.log(`  [${status}] ${kind} ${bytes ? (bytes/1024).toFixed(0) + 'KB' : '0B'}  ${url}`);
}

function enqueue(url, depth, referer = null) {
  if (seenUrls.has(url)) return;
  const { scope, eligible } = ruleFor(url);
  if (!scope || !eligible) return;
  const c = perDomainCount.get(scope.domain) || 0;
  if (c >= scope.max_pages) return;
  perDomainCount.set(scope.domain, c + 1);
  seenUrls.add(url);
  queue.push({ url, depth, referer });
}

for (const s of seeds) enqueue(s, 0);

let processed = 0;
const startedAt = Date.now();

while (queue.length) {
  const { url, depth, referer } = queue.shift();
  processed++;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${processed}/${queue.length + processed}] d=${depth} ${elapsed}s ${url}`);

  // Asset URLs: direct fetch, no navigation
  if (isAsset(url)) {
    await fetchAsset(url, isPdf(url) ? 'pdf' : 'asset', referer);
    await page.waitForTimeout(150);
    continue;
  }

  // HTML page navigation
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(700);
    const ct = resp?.headers()['content-type'] || '';
    if (/text\/html/i.test(ct) && depth < 6) {
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href));
      for (const l of links) {
        const { eligible } = ruleFor(l);
        if (eligible) enqueue(l, depth + 1, url);
      }
    }
  } catch (e) {
    if (/Download is starting/i.test(e.message) || /net::ERR_ABORTED/i.test(e.message)) {
      await fetchAsset(url, 'pdf', referer);
    } else {
      console.error(`  fail: ${e.message.slice(0, 100)}`);
      log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: 'nav-fail', url, status: -1, error: e.message.slice(0, 200) });
    }
  }
  await page.waitForTimeout(200);
}

await browser.close();

const lines = log.map(r => JSON.stringify(r)).join('\n') + '\n';
await fs.writeFile(manifestPath, lines);

const ok = log.filter(r => r.status === 200).length;
const totalBytes = log.reduce((a, r) => a + (r.bytes || 0), 0);
const byDomain = new Map();
for (const r of log) {
  if (!r.url) continue;
  let h; try { h = new URL(r.url).host; } catch { continue; }
  const e = byDomain.get(h) || { docs: 0, bytes: 0, pdfs: 0, images: 0, html: 0, fails: 0 };
  e.docs++;
  e.bytes += r.bytes || 0;
  if (r.status !== 200) { e.fails++; continue; }
  if (/pdf/i.test(r.content_type || '') || isPdf(r.url, r.content_type || '')) e.pdfs++;
  else if (/^image\//i.test(r.content_type || '')) e.images++;
  else if (/html/i.test(r.content_type || '')) e.html++;
  byDomain.set(h, e);
}

console.log(`\n=== RECURSIVE CRAWL ${crawlId} ===`);
console.log(`  ${log.length} rows, ${ok} ok, ${(totalBytes / 1024 / 1024).toFixed(2)} MB total`);
console.log(`  pages processed: ${processed}`);
console.log(`  manifest: ${manifestPath}`);
console.log('\n=== BY DOMAIN ===');
for (const [host, e] of byDomain) {
  console.log(`  ${host.padEnd(28)} docs=${e.docs.toString().padStart(4)} html=${e.html.toString().padStart(3)} pdfs=${e.pdfs.toString().padStart(3)} imgs=${e.images.toString().padStart(3)} fails=${e.fails.toString().padStart(2)} ${(e.bytes/1024/1024).toFixed(1).padStart(6)}MB`);
}
