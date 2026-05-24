// Quick recon: pull war.gov/UFO/uap-csv.csv via warmed Akamai context,
// dump it, and report row counts + asset-URL patterns so we know whether
// Release 2 uses /release_2/ paths, new ID patterns, new content types.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs/promises';
import path from 'node:path';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const DOCS = path.join(ROOT, 'docs');
await fs.mkdir(DOCS, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

console.log('=== warming up war.gov ===');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// Try several known CSV paths (the team may have moved to release_2 csv)
const candidates = [
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv-release-2.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv-r2.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/release_2/uap-csv.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/data.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/data.json',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/index.json',
];

for (const url of candidates) {
  const res = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, ct: r.headers.get('content-type') || '', len: (await r.text()).length };
    } catch (e) { return { status: -1, error: e.message }; }
  }, url);
  console.log(`[${String(res.status).padStart(3)}] ${res.len ?? '-'}B  ${url}`);
}

console.log('\n=== inspecting page source for asset-URL patterns ===');
const html = await page.content();
const urlMatches = new Set();
for (const m of html.matchAll(/https?:\/\/(?:www\.)?war\.gov\/[^"'\s)]+/gi)) urlMatches.add(m[0]);
for (const m of html.matchAll(/\/medialink\/[^"'\s)]+/gi)) urlMatches.add('https://www.war.gov' + m[0]);
for (const m of html.matchAll(/\/Portals\/1\/[^"'\s)]+/gi)) urlMatches.add('https://www.war.gov' + m[0]);

const byBucket = {};
for (const u of urlMatches) {
  const key = (u.match(/(release_\d+|uap-csv|UFO\/[^/]+)/) || [])[1] || 'other';
  byBucket[key] = (byBucket[key] || 0) + 1;
}
console.log('URL bucket counts:');
for (const [k, n] of Object.entries(byBucket).sort((a,b) => b[1]-a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);
console.log(`\ntotal unique war.gov URLs: ${urlMatches.size}`);

const release2 = [...urlMatches].filter(u => /release_2/i.test(u));
console.log(`\nrelease_2 URLs (${release2.length}):`);
for (const u of release2.slice(0, 30)) console.log(`  ${u}`);

// Also: any data/manifest files?
const dataFiles = [...urlMatches].filter(u => /\.(csv|json|xml)(\?|$)/i.test(u));
console.log(`\ndata files referenced (${dataFiles.length}):`);
for (const u of dataFiles.slice(0, 30)) console.log(`  ${u}`);

await fs.writeFile(path.join(DOCS, 'recon-release-2.html'), html);
console.log(`\nfull DOM → docs/recon-release-2.html (${(html.length/1024).toFixed(1)} KB)`);

await browser.close();
