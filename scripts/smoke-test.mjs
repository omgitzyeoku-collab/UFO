// Smoke-test the live site (or a local file:// URL) against regressions
// that have actually bitten us. Run as a pre-deploy / post-deploy check.
//
//   node scripts/smoke-test.mjs                       # tests live prod
//   node scripts/smoke-test.mjs https://staging.url   # alternate target
//   node scripts/smoke-test.mjs file:///abs/path/index.html  # local
//
// The most important assertion: the number of <script> elements on the
// page matches the expected count. Anything else means the HTML parser
// got confused by a literal </script> inside a JS template literal,
// which is exactly how we broke prod once.

import { chromium } from 'playwright';

const TARGET = process.argv[2] || 'https://ufo-wheat.vercel.app/';
// 1 application/ld+json + 3 CDN <script src> (leaflet, leaflet.markercluster, d3) + 1 inline app = 5
const EXPECTED_SCRIPTS = 5;

const failures = [];
function expect(label, cond, detail) {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ' — ' + detail : ''}`); failures.push(label); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', e => consoleErrors.push(`PAGE ERROR: ${e.message}`));

console.log(`smoke-testing ${TARGET}`);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Wait for the app to populate at least one card before sampling
try { await page.waitForSelector('.card', { timeout: 30000 }); } catch {}
await page.waitForTimeout(1500);

// 1. The #1 regression: <script> tag count
const scriptCount = await page.evaluate(() => document.querySelectorAll('script').length);
expect(`script count is ${EXPECTED_SCRIPTS}`, scriptCount === EXPECTED_SCRIPTS, `got ${scriptCount}`);

// 2. App actually rendered (cards visible)
const cards = await page.evaluate(() => document.querySelectorAll('.card').length);
expect(`grid has cards`, cards >= 10, `got ${cards}`);

// 3. Hero stat populated (was stuck on "—" when JS broke)
const heroStat = await page.evaluate(() => document.getElementById('hero-stat-total')?.textContent || '');
expect(`hero stat shows a number`, /\d/.test(heroStat), `got "${heroStat}"`);

// 4. Filter pill present
const pillVisible = await page.evaluate(() => !!document.getElementById('filter-pill'));
expect(`filter pill present`, pillVisible);

// 5. Featured tiles rendered
const featured = await page.evaluate(() => document.querySelectorAll('#hero-featured .hero-feat-card').length);
expect(`featured tiles >= 3`, featured >= 3, `got ${featured}`);

// 6. No JS execution errors (pageerror)
const realErrors = consoleErrors.filter(e => !/(404|favicon)/i.test(e));
expect(`no JS execution errors`, realErrors.length === 0, `${realErrors.length}: ${realErrors.slice(0,2).join(' | ')}`);

// 7. View switching works (network view should render an SVG with nodes)
await page.click('button[data-view="network"]');
await page.waitForTimeout(1500);
const netNodes = await page.evaluate(() => document.querySelectorAll('#netsvg circle').length);
expect(`network view renders >= 50 nodes`, netNodes >= 50, `got ${netNodes}`);

// 8. Switch back to grid (default state)
await page.click('button[data-view="grid"]');
await page.waitForTimeout(500);
const gridVisible = await page.evaluate(() => document.getElementById('vb-grid').style.display !== 'none');
expect(`grid view restores`, gridVisible);

// 9. Full-text (document body) search: focus loads the index, "roswell" must
//    surface docs that match only in the body (with an "in document text" badge).
await page.focus('#q');
await page.fill('#q', 'roswell');
await page.waitForTimeout(2500);  // debounce + lazy index fetch + re-render
const bodyHits = await page.evaluate(() =>
  [...document.querySelectorAll('.card')].filter(c => c.textContent.includes('in document text')).length);
const roswellCards = await page.evaluate(() => document.querySelectorAll('.card').length);
expect(`full-text "roswell" returns results`, roswellCards >= 1, `got ${roswellCards} cards`);
expect(`full-text body-match badge present`, bodyHits >= 1, `got ${bodyHits} body-badged cards`);

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${10} checks passed`);
