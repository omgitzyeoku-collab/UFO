import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs/promises';
import path from 'node:path';
chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const network = [];
page.on('response', async r => {
  const url = r.url();
  network.push({ url, status: r.status(), ct: r.headers()['content-type'] || '', method: r.request().method() });
});

console.log('=== test 1: direct anchor URL from video ===');
const ANCHOR = 'https://www.war.gov/UFO/#State-Department-UAP-Cable-3-Tbilisi-Georgia-October-30-2001';
await page.goto(ANCHOR, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: path.join(ROOT, 'docs', 'war-gov-anchor-test.png'), fullPage: true });
const html = await page.content();
await fs.writeFile(path.join(ROOT, 'docs', 'war-gov-anchor-test.html'), html);

console.log('\n=== JS-rendered: count of medialink/uap/release_1 references in DOM ===');
const counts = await page.evaluate(() => {
  const html = document.documentElement.outerHTML;
  return {
    medialink: (html.match(/medialink/gi) || []).length,
    uap_release: (html.match(/release_\d+/gi) || []).length,
    uap_pattern: (html.match(/\d{3}uap\d{5}/gi) || []).length,
    download_btns: document.querySelectorAll('a[download], button:not([aria-hidden="true"]), [class*="download" i]').length,
    dgov_slideshow_imgs: document.querySelectorAll('.dgov2slideshow img').length,
    every_link_with_pdf: Array.from(document.querySelectorAll('a[href]')).filter(a => /\.pdf|medialink/i.test(a.href)).map(a => a.href),
  };
});
console.log(JSON.stringify(counts, null, 2));

console.log('\n=== test 2: query for State Department UAP via search ===');
// Maybe the docs are accessed via search or a separate listing page
for (const url of [
  'https://www.war.gov/UFO/Documents/',
  'https://www.war.gov/UFO/Cables/',
  'https://www.war.gov/UFO/Release/',
  'https://www.war.gov/medialink/ufo/release_1/059uap00011.pdf',
  'https://search.defense.gov/search/?affiliate=dod_search&query=059uap00011',
]) {
  const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  console.log(`  [${r?.status() || 'err'}] ${url}`);
}

console.log('\n=== test 3: look at network log for non-asset XHR/fetch ===');
const xhrs = network.filter(n => /^(xhr|fetch|other|script)$/i.test(n.method) || /json|api|search|cable|cables|uap/i.test(n.url));
console.log(`xhr-ish/json-ish entries: ${xhrs.length}`);
for (const x of xhrs.slice(0, 30)) console.log(`  [${x.status}] ${x.method} ${(x.ct||'').slice(0,40).padEnd(42)} ${x.url}`);

console.log('\n=== test 4: dump ALL JSON-content-type responses ===');
const jsons = network.filter(n => /json/i.test(n.ct));
for (const j of jsons.slice(0, 20)) console.log(`  [${j.status}] ${j.url}`);

await browser.close();
