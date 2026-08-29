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
// Capture the URL alongside the message. Chromium's console text for any
// subresource failure is the same generic "Failed to load resource: the server
// responded with a status of 404 (Not Found)" — the URL lives only in
// msg.location(). Without it, no filter can tell an expected 404 from a broken
// asset, which is why the old filter had to swallow all of them.
page.on('console', msg => {
  if (msg.type() !== 'error') return;
  const url = msg.location()?.url || '';
  consoleErrors.push(url ? `${msg.text()} ${url}` : msg.text());
});
page.on('pageerror', e => consoleErrors.push(`PAGE ERROR: ${e.message}`));

console.log(`smoke-testing ${TARGET}`);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Wait for the app to populate at least one card before sampling
try { await page.waitForSelector('.card, .row', { timeout: 30000 }); } catch {}
await page.waitForTimeout(1500);

// 1. The #1 regression: <script> tag count
const scriptCount = await page.evaluate(() => document.querySelectorAll('script').length);
expect(`script count is ${EXPECTED_SCRIPTS}`, scriptCount === EXPECTED_SCRIPTS, `got ${scriptCount}`);

// 2. App actually rendered. The list has two densities — Rows (default, .row) and
// Gallery (.card) — so assert documents rendered, not one particular selector.
const docsRendered = await page.evaluate(() => document.querySelectorAll('.card, .row').length);
expect(`document list renders`, docsRendered >= 10, `got ${docsRendered}`);

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
// Two 404 classes are expected by design: the favicon, and the per-card
// thumbnail probe in index.html, which guesses every doc has a thumbnail and
// lets <img onerror> swap in a fallback. Every other 404 is a real broken
// asset and must fail the run.
const EXPECTED_404 = /favicon|\/extract\/thumbs\//i;
const realErrors = consoleErrors.filter(e => !EXPECTED_404.test(e));
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

// 9. Full-text (document body) search: focus loads the index (up to a few MB),
//    then "roswell" must surface docs that match only in the body (badge).
await page.focus('#q');
await page.fill('#q', 'roswell');
// Poll up to 15s for the lazy index fetch + re-render to produce a body badge.
let bodyHits = 0;
for (let t = 0; t < 30; t++) {
  bodyHits = await page.evaluate(() =>
    [...document.querySelectorAll('.card, .row')].filter(c => c.textContent.includes('in document text') || c.querySelector('.row-hit')).length);
  if (bodyHits >= 1) break;
  await page.waitForTimeout(500);
}
const roswellCards = await page.evaluate(() => document.querySelectorAll('.card, .row').length);
expect(`full-text "roswell" returns results`, roswellCards >= 1, `got ${roswellCards} cards`);
expect(`full-text body-match badge present`, bodyHits >= 1, `got ${bodyHits} body-badged cards (waited 15s)`);

// 10. The download links actually resolve. The page never fetches these — they
//     are <a href> targets — so no console error is ever produced for a dead
//     one. The whole GitHub mirror went 404 when the repo was flipped private
//     and nothing here noticed. Sample and probe them directly.
const sample = await page.evaluate(async () => {
  const r = await fetch('/extract/corpus.json');
  const docs = await r.json();
  const arr = Array.isArray(docs) ? docs : Object.values(docs).find(v => Array.isArray(v));
  const byHost = new Map();
  for (const d of arr) {
    const u = d.release_url;
    if (!u) continue;
    let h; try { h = new URL(u).hostname; } catch { continue; }
    if (!byHost.has(h)) byHost.set(h, []);
    if (byHost.get(h).length < 3) byHost.get(h).push(u);
  }
  return [...byHost.values()].flat();
});

// 404/410 means the document is gone — always a failure. 401/403/429 means the
// origin refused an automated client; several government hosts (aaro.mil,
// war.gov) sit behind bot protection and 403 every non-browser request while
// serving real visitors fine. That is their policy, not a broken archive, so it
// is reported but not failed. The mirror we control gets no such latitude.
const dead = [];
const blocked = [];
for (const u of sample) {
  const isOurMirror = /(^|\/\/)github\.com\//.test(u);
  try {
    const res = await page.request.get(u, { headers: { Range: 'bytes=0-511' }, timeout: 30000 });
    const s = res.status();
    if (s < 400) continue;
    if (!isOurMirror && [401, 403, 429].includes(s)) blocked.push(`${s} ${u}`);
    else dead.push(`${s} ${u}`);
  } catch (e) {
    dead.push(`ERR ${u} (${e.message.slice(0, 60)})`);
  }
}
if (blocked.length) {
  console.log(`  note: ${blocked.length}/${sample.length} origins refused an automated client (bot protection, not a dead link)`);
}
expect(`document download links resolve (${sample.length} sampled across hosts)`,
  dead.length === 0, dead.slice(0, 3).join(' | '));

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${11} checks passed`);
