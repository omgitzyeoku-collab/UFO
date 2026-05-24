// Pull the two referenced CSVs (uap-release001.csv + uap-data.csv) and
// dump them. uap-data.csv looks like the combined Release 1+2 master.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs/promises';
import path from 'node:path';

chromium.use(StealthPlugin());
const ROOT = path.resolve('.');
const DOCS = path.join(ROOT, 'docs');

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage();

console.log('=== warmup ===');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

const urls = [
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-release001.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-data.csv',
  'https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-release002.csv',
];
for (const u of urls) {
  const res = await page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    const t = r.status === 200 ? await r.text() : '';
    return { status: r.status, ct: r.headers.get('content-type') || '', len: t.length, text: t };
  }, u);
  console.log(`[${res.status}] ${res.len}B  ${u}`);
  if (res.status === 200) {
    const name = u.split('/').pop();
    await fs.writeFile(path.join(DOCS, name), res.text);
    console.log(`  → saved docs/${name}`);
    // first 3 lines
    for (const line of res.text.split('\n').slice(0, 3)) console.log(`    ${line.slice(0,180)}`);
  }
}

// Look at the rendered SPA: extract every slideshow item / card
console.log('\n=== inspecting SPA DOM ===');
const slides = await page.evaluate(() => {
  const out = [];
  const items = document.querySelectorAll('[class*="slide" i], [class*="card" i], [class*="tile" i], [data-id], [data-index]');
  for (const el of items) {
    const id = el.getAttribute('data-id') || el.getAttribute('data-index') || el.id || '';
    const ttl = el.textContent?.trim().slice(0, 100) || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ttl || ariaLabel || id) out.push({ id, ttl, ariaLabel });
  }
  return out.slice(0, 100);
});
console.log(`slideshow items: ${slides.length}`);
for (const s of slides.slice(0, 20)) console.log(`  ${s.id?.padEnd(12)} ${s.ttl}`);

await browser.close();
