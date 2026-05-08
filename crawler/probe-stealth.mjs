// Probe whether Akamai Bot Manager lets us through in headless mode with stealth.
// If status === 200 and links > 50, we're good. If 403, fall back to system Chrome.
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function probe(opts) {
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: opts.channel,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  let status = -1, links = 0, err = null;
  try {
    const resp = await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
    status = resp?.status() ?? -1;
    if (status === 200) {
      links = await page.evaluate(() => document.querySelectorAll('a[href]').length);
    }
  } catch (e) {
    err = e.message;
  }
  await browser.close();
  return { ...opts, status, links, err };
}

const matrix = [
  { label: 'headless-shell + stealth (preferred for scheduled task)', headless: true,  channel: undefined },
  { label: 'system Chrome headless + stealth',                         headless: true,  channel: 'chrome'  },
  { label: 'system Chrome headed + stealth (current crawler default)', headless: false, channel: 'chrome'  },
];

console.log('probing Akamai under stealth...\n');
for (const opts of matrix) {
  console.log(`-- ${opts.label}`);
  const r = await probe(opts);
  console.log(`   status=${r.status} links=${r.links}${r.err ? ' err=' + r.err : ''}`);
  console.log('');
}
