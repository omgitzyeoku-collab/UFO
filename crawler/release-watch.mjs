// Watcher: every run, fetch war.gov uap-data.csv, diff against the
// last-known SHA-256, and if there's anything new, spawn the differential
// crawler + downstream pipeline.
//
// Designed to be triggered by GitHub Actions on a schedule (every 4h) but
// runs fine locally too.
//
// State: docs/release-watch-state.json — { csv_sha256, csv_bytes, last_check }

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const DOCS = path.join(ROOT, 'docs');
const STATE_FILE = path.join(DOCS, 'release-watch-state.json');
const NOW = new Date().toISOString();

await fs.mkdir(DOCS, { recursive: true });

// Read state
let state = { csv_sha256: null, csv_bytes: 0, last_check: null, last_change: null };
try { state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch {}
const prevSha = state.csv_sha256;

console.log(`=== release-watch ===  (prev csv sha=${prevSha?.slice(0,12) || 'none'})`);

// Pull CSV
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const csvRes = await page.evaluate(async () => {
  const r = await fetch('https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-data.csv', { credentials: 'include' });
  return r.status === 200 ? { status: 200, text: await r.text() } : { status: r.status };
});
await browser.close();

if (csvRes.status !== 200 || !csvRes.text) {
  console.error(`CSV fetch failed: status=${csvRes.status}`);
  process.exit(2);
}

const csvSha = crypto.createHash('sha256').update(csvRes.text).digest('hex');
const csvBytes = csvRes.text.length;

console.log(`csv sha=${csvSha.slice(0,12)} bytes=${csvBytes}`);

if (csvSha === prevSha) {
  // Deliberately do NOT write the state file here. Writing last_check on every run
  // dirtied the working tree, so the workflow's `git status --porcelain` check saw a
  // change and committed "release-watch: new release detected" — 304 times, 6 a day,
  // every one of them false, each triggering a production deploy. A real release was
  // indistinguishable from the noise. The run log and the Actions history already
  // record when the watcher ran; the repo does not need a heartbeat commit.
  console.log('CSV unchanged. No new release. Exiting cleanly (state file untouched).');
  process.exit(0);
}

console.log('=== CSV CHANGED — new release likely ===');

// Save the new CSV
await fs.writeFile(path.join(DOCS, 'uap-data.csv'), csvRes.text);
await fs.writeFile(path.join(DOCS, `uap-data-${NOW.slice(0,10)}.csv`), csvRes.text);

// Count release dates so we can name what just dropped
function parseCsv(text) {
  const rows = []; let row=[], field='', inQ=false;
  for (let i=0;i<text.length;i++){const c=text[i];
    if(inQ){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')inQ=false;else field+=c;}
    else{if(c==='"')inQ=true;else if(c===','){row.push(field);field='';}
    else if(c==='\r'){}else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}else field+=c;}}
  if(field||row.length){row.push(field);rows.push(row);}
  return rows;
}
const rows = parseCsv(csvRes.text);
const h = rows[0];
const records = rows.slice(1).filter(r=>r.some(c=>(c||'').trim())).map(r=>{const o={};h.forEach((hh,i)=>{o[hh.trim()]=(r[i]||'').trim();});return o;});
const dateCounts = {};
for (const r of records) dateCounts[r['Release Date'] || 'unknown'] = (dateCounts[r['Release Date'] || 'unknown']||0)+1;
console.log('release date distribution:', JSON.stringify(dateCounts));

// Every stage below used to run with its exit status discarded, and the state
// file was written unconditionally afterwards. So a run where extraction or a
// generator failed still recorded the new CSV SHA — and the next 4-hourly run
// took the "CSV unchanged" early exit and never revisited the half-built
// release. That is how 22 Release 5 PDFs stayed live with no text for 22 days.
// Now: every stage is checked, and the state advances only if all of them pass.
// Two classes of stage, and they need different failure semantics.
//
// ACQUISITION stages pull bytes off war.gov and write them into the manifest.
// If one fails the release is genuinely not mirrored, so the state SHA must NOT
// advance — the next run has to retry. Nothing downstream is trustworthy
// either, so stop immediately.
//
// GENERATOR stages rebuild pages from data already committed. They are
// idempotent and re-runnable, and several now abort deliberately on bad input.
// Blocking the state SHA on those would re-download the entire release from
// war.gov every four hours, forever, over a fault that a rerun fixes for free.
// So they fail loudly and set a non-zero exit, but they do not hold the state.
const ACQUISITION = [
  ['release-2-delta',    'crawler/release-2-delta.mjs'],
  ['release-2-dvids',    'crawler/release-2-dvids.mjs'],
  ['merge-release-2',    'extract/merge-release-2.mjs'],
  ['extract-pdf-text',   'extract/extract-pdf-text.mjs'],
];
const GENERATORS = [
  ['build-thumbnails',   'extract/build-thumbnails.mjs'],
  ['build-connections',  'extract/build-connections.mjs'],
  ['build-entity-pages', 'extract/build-entity-pages.mjs'],
  ['build-doc-pages',    'extract/build-doc-pages.mjs'],
];

function runStage(name, script) {
  console.log(`\n=== running ${path.basename(script)} ===`);
  const res = spawnSync('node', [script], { stdio: 'inherit', cwd: ROOT });
  const status = res.status ?? -1;
  if (status !== 0) console.error(`STAGE FAILED: ${name} exited ${status}`);
  return status;
}

const acqFailures = [];
for (const [name, script] of ACQUISITION) {
  if (runStage(name, script) !== 0) { acqFailures.push(name); break; }
}

if (acqFailures.length) {
  console.error('\n=== release-watch INCOMPLETE (acquisition) ===');
  console.error(`  ✗ ${acqFailures.join(', ')}`);
  console.error('The release is not mirrored. Leaving docs/release-watch-state.json at');
  console.error('the previous CSV SHA so the next scheduled run retries it.');
  process.exit(3);
}

// Acquisition succeeded — the bytes are on disk and in the manifest. From here
// the state SHA advances regardless, because a rerun of a generator does not
// need war.gov.
state.csv_sha256 = csvSha;
state.csv_bytes = csvBytes;
state.last_check = NOW;
state.last_change = NOW;
state.date_counts = dateCounts;
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
console.log('\nacquisition complete — state advanced.');

const genFailures = [];
for (const [name, script] of GENERATORS) {
  if (runStage(name, script) !== 0) genFailures.push(name);
}

if (genFailures.length) {
  console.error('\n=== release-watch: acquisition OK, generators FAILED ===');
  console.error(`  ✗ ${genFailures.join(', ')}`);
  console.error('The mirror is complete and the state has advanced. Re-run the failed');
  console.error('generators locally — they do not need to touch war.gov again.');
  process.exit(4);
}

console.log('\n=== release-watch complete ===');
console.log('Run `git add -A && git commit && git push && vercel --prod` to publish.');
console.log('Or rely on the GitHub Actions workflow auto-deploy step.');
