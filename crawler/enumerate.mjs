import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('docs');
await fs.mkdir(OUT, { recursive: true });

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

const page = await ctx.newPage();
const seen = new Set();
const network = [];
page.on('response', r => {
  const url = r.url();
  if (seen.has(url)) return;
  seen.add(url);
  network.push({ url, status: r.status(), ct: r.headers()['content-type'] || '' });
});

// 1. UFO front page
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });

// Scroll to bottom in steps to trigger lazy-load
for (let y = 0; y <= 8000; y += 800) {
  await page.evaluate(yy => window.scrollTo(0, yy), y);
  await page.waitForTimeout(700);
}

// Click each top-nav anchor in case sections render on activation
for (const sel of ['a[href="#intro"]', 'a[href="#directive"]', 'a[href="#release"]', 'a[href="#learn"]']) {
  try {
    const el = page.locator(sel).first();
    if (await el.count()) { await el.click({ trial: false, timeout: 3000 }); await page.waitForTimeout(800); }
  } catch {}
}

// Try clicking any "next"/"more" controls in the slideshow
const candidates = await page.locator('button, [role="button"], .slick-next, .carousel-control-next, [aria-label*="next" i], [aria-label*="more" i]').all();
for (let i = 0; i < Math.min(candidates.length, 80); i++) {
  try { await candidates[i].click({ timeout: 1500 }); await page.waitForTimeout(400); } catch {}
}

await page.waitForTimeout(2000);

const html = await page.content();
await fs.writeFile(path.join(OUT, 'war-gov-ufo-deep.html'), html);
await page.screenshot({ path: path.join(OUT, 'war-gov-ufo-deep.png'), fullPage: true });

// 2. Press release page
const pressUrl = 'https://www.war.gov/News/Releases/Release/Article/4480582/department-of-war-releases-unidentified-anomalous-phenomena-files-in-historic-t/';
try {
  await page.goto(pressUrl, { waitUntil: 'networkidle', timeout: 60000 });
  const press = await page.content();
  await fs.writeFile(path.join(OUT, 'press-release-4480582.html'), press);
  const text = await page.evaluate(() => document.body.innerText);
  await fs.writeFile(path.join(OUT, 'press-release-4480582.txt'), text);
} catch (e) {
  console.error('press-release fetch error:', e.message);
}

// 3. Output network log
const slideshowUrls = [...seen].filter(u => /Slideshow/i.test(u));
const inferred = {
  totalNetwork: network.length,
  slideshowAssetCount: slideshowUrls.length,
  slideshowAssets: slideshowUrls.sort(),
};
await fs.writeFile(path.join(OUT, 'enumerate-network.json'), JSON.stringify({ inferred, network }, null, 2));
console.log(JSON.stringify(inferred, null, 2));

await browser.close();
