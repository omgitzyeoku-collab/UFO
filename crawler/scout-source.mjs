import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());

const targetUrl = process.argv[2];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let status = -1, links = [], err = null;
try {
  const r = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  status = r?.status() ?? -1;
  if (status === 200) {
    links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => ({
      href: a.href, text: (a.textContent||'').trim().slice(0,80)
    })));
  }
} catch (e) { err = e.message; }
await browser.close();
const origin = new URL(targetUrl).origin;
const internal = links.filter(l => l.href.startsWith(origin));
const pdfs = links.filter(l => /\.pdf(\?|$)/i.test(l.href));
const reportPaths = internal.filter(l => /resourc|report|uap|case|file|document|release|archive|library|vault|read|histor|incident|sight/i.test(l.href));
console.log(JSON.stringify({
  url: targetUrl, status, err,
  total_links: links.length,
  internal_count: internal.length,
  pdfs_count: pdfs.length,
  report_path_links: reportPaths.length,
  sample_pdfs: pdfs.slice(0,20).map(l => l.href),
  sample_report_paths: reportPaths.slice(0,40).map(l => ({ text: l.text, href: l.href })),
}, null, 2));
