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
  console.log('CSV unchanged. No new release. Exiting cleanly.');
  state.last_check = NOW;
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
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

// Spawn the existing differential crawler
console.log('\n=== running release-2-delta.mjs (handles any new release) ===');
const r1 = spawnSync('node', ['crawler/release-2-delta.mjs'], { stdio: 'inherit', cwd: ROOT });
if (r1.status !== 0) { console.error('release-2-delta failed'); process.exit(3); }

console.log('\n=== running release-2-dvids.mjs ===');
const r2 = spawnSync('node', ['crawler/release-2-dvids.mjs'], { stdio: 'inherit', cwd: ROOT });
if (r2.status !== 0) { console.error('release-2-dvids failed'); process.exit(3); }

console.log('\n=== running merge-release-2.mjs ===');
spawnSync('node', ['extract/merge-release-2.mjs'], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== running extract-pdf-text.mjs ===');
spawnSync('node', ['extract/extract-pdf-text.mjs'], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== running build-thumbnails.mjs ===');
spawnSync('node', ['extract/build-thumbnails.mjs'], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== running build-connections.mjs ===');
spawnSync('node', ['extract/build-connections.mjs'], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== running build-entity-pages.mjs ===');
spawnSync('node', ['extract/build-entity-pages.mjs'], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== running build-doc-pages.mjs ===');
spawnSync('node', ['extract/build-doc-pages.mjs'], { stdio: 'inherit', cwd: ROOT });

// Persist new state
state.csv_sha256 = csvSha;
state.csv_bytes = csvBytes;
state.last_check = NOW;
state.last_change = NOW;
state.date_counts = dateCounts;
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));

console.log('\n=== release-watch complete ===');
console.log('Run `git add -A && git commit && git push && vercel --prod` to publish.');
console.log('Or rely on the GitHub Actions workflow auto-deploy step.');
