import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET = process.env.TARGET || 'https://www.war.gov/UFO/';
const OUT_DIR = path.resolve('docs');
await fs.mkdir(OUT_DIR, { recursive: true });

const HEADLESS = process.env.HEADLESS === '1';
const CHANNEL = process.env.CHANNEL || 'chrome';
const browser = await chromium.launch({
  headless: HEADLESS,
  channel: CHANNEL,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
const ctx = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: {
    'Accept-Language': 'en-US,en;q=0.9',
  },
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
});
const page = await ctx.newPage();

const network = [];
page.on('response', async r => {
  try {
    const url = r.url();
    const status = r.status();
    const headers = r.headers();
    network.push({ url, status, ct: headers['content-type'] || '', cl: headers['content-length'] || '' });
  } catch {}
});

let resp;
try {
  resp = await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 45000 });
} catch (e) {
  console.error('navigate error:', e.message);
}
const status = resp?.status();
console.log(`primary status: ${status}`);
const finalUrl = page.url();
console.log(`final url: ${finalUrl}`);

const html = await page.content();
await fs.writeFile(path.join(OUT_DIR, 'war-gov-ufo-index.html'), html);
await page.screenshot({ path: path.join(OUT_DIR, 'war-gov-ufo-index.png'), fullPage: true });

const links = await page.evaluate(() => {
  const a = Array.from(document.querySelectorAll('a[href]'));
  return a.map(x => ({
    href: x.href,
    text: (x.textContent || '').trim().slice(0, 200),
  }));
});

const origin = new URL(TARGET).origin;
const summary = {
  target: TARGET,
  finalUrl,
  status,
  totalLinks: links.length,
  pdfLinks: links.filter(l => /\.pdf(\?|$)/i.test(l.href)).length,
  imageLinks: links.filter(l => /\.(png|jpe?g|gif|webp|tiff?)(\?|$)/i.test(l.href)).length,
  internalLinks: links.filter(l => l.href.startsWith(origin)).length,
  externalLinks: links.filter(l => !l.href.startsWith(origin) && /^https?:/.test(l.href)).length,
  uniqueHosts: [...new Set(links.map(l => { try { return new URL(l.href).host; } catch { return null; } }).filter(Boolean))],
  networkResponseCount: network.length,
  networkPdfs: network.filter(n => /pdf/i.test(n.ct) || /\.pdf(\?|$)/i.test(n.url)).length,
  networkImages: network.filter(n => /^image\//.test(n.ct)).length,
};

await fs.writeFile(path.join(OUT_DIR, 'scout-summary.json'), JSON.stringify({ summary, links, network }, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();
