// Weekly delta crawler for war.gov/UFO/.
//
// The release-N crawlers each targeted one release. This one is release-agnostic:
// it pulls the live uap-data.csv, takes every primary artefact URL (the
// "PDF | Image Link" column only — NOT "Modal Image", which is a thumbnail and
// pollutes the corpus), diffs against everything already known, and downloads
// whatever is genuinely absent.
//
// Writes manifest/manifest-weekly-<crawlId>.jsonl with CSV metadata embedded
// and a release tag derived from the medialink URL. Idempotent + resumable.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS = path.join(ROOT, 'docs');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-weekly-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// release_1 → release_1 ; 061226/release_03 → release_3
function releaseFromUrl(u) {
  const m = u.match(/\/release_?0?(\d+)\//i);
  return m ? `release_${parseInt(m[1], 10)}` : null;
}

const norm = (u) => u.split('?')[0].toLowerCase();

// === WHAT DO WE ALREADY HAVE ===
// A URL only counts as "held" if we have the BYTES on disk. A manifest row
// alone is not enough: release-watch runs on an ephemeral GitHub runner, so it
// records URL+SHA for blobs that never reached this machine. Gating on the row
// rather than the blob is what let 10 release_3 images sit unfetched for weeks.
const heldUrls = new Set();   // url → blob confirmed on disk
const knownUrls = new Set();  // url → seen in some manifest (blob may be absent)
const existingSha = new Set();

function ingest(r) {
  if (!r || !r.url) return;
  const u = norm(r.url);
  if (r.status && r.status !== 200) return;
  knownUrls.add(u);
  if (r.sha256) existingSha.add(r.sha256);
  if (r.blob_path && existsSync(path.resolve(ROOT, r.blob_path))) heldUrls.add(u);
}

try {
  for (const l of (await fs.readFile(path.join(ROOT, 'extract', 'release-manifest.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)) {
    try { ingest(JSON.parse(l)); } catch {}
  }
} catch {}
for (const f of await fs.readdir(MANIFEST_DIR)) {
  if (!/\.jsonl$/.test(f)) continue;
  try {
    for (const l of (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean)) {
      try { ingest(JSON.parse(l)); } catch {}
    }
  } catch {}
}
console.log(`URLs with blob on disk: ${heldUrls.size}  seen-but-no-blob: ${knownUrls.size - heldUrls.size}  known SHAs: ${existingSha.size}`);

// === WARM + FETCH CSV ===
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
console.log('warming war.gov…');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3500);

const csvRes = await page.evaluate(async () => {
  const r = await fetch('https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-data.csv', { credentials: 'include' });
  return { status: r.status, text: r.status === 200 ? await r.text() : '' };
});
if (csvRes.status !== 200) {
  console.error(`CSV fetch failed: ${csvRes.status} — war.gov structure may have changed. Aborting.`);
  await browser.close();
  process.exit(1);
}
await fs.writeFile(path.join(DOCS, 'uap-data.csv'), csvRes.text);
console.log(`csv: ${(csvRes.text.length / 1024).toFixed(1)} KB`);

const rows = parseCsv(csvRes.text);
const header = rows[0].map(h => h.trim());
const records = rows.slice(1).filter(r => r.some(c => (c || '').trim())).map(r => {
  const o = {}; header.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
  return o;
});
console.log(`csv records: ${records.length}`);

// Keep the parsed CSV fresh for downstream consumers (dvids-videos.mjs reads it)
await fs.writeFile(path.join(DOCS, 'uap-csv-parsed.json'), JSON.stringify(records, null, 2));

const byRelease = {};
for (const r of records) byRelease[r['Release Date'] || 'unknown'] = (byRelease[r['Release Date'] || 'unknown'] || 0) + 1;
console.log('records by release date:', JSON.stringify(byRelease));

// === DIFF: primary artefact links only ===
const targets = [];
const seen = new Set();
for (const rec of records) {
  const link = (rec['PDF | Image Link'] || '').trim();
  if (!link) continue;
  const u = link.startsWith('http') ? link : ('https://www.war.gov' + (link.startsWith('/') ? link : '/' + link));
  if (seen.has(norm(u))) continue;
  seen.add(norm(u));
  if (heldUrls.has(norm(u))) continue;
  targets.push({ url: u, rec, refetch: knownUrls.has(norm(u)) });
}
console.log(`\nprimary artefacts without local bytes: ${targets.length}`);
for (const t of targets) {
  console.log(`  ${t.rec['Release Date'].padEnd(9)} ${t.rec['Type'].padEnd(4)} ${t.refetch ? 're-fetch' : 'new     '} ${t.url.slice(-64)}`);
}

if (!targets.length) {
  console.log('\nnothing to download.');
  await browser.close();
  process.exit(0);
}

// === DOWNLOAD ===
async function downloadOne(url) {
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.evaluate((u) => {
    const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
  }, url);
  const dl = await downloadPromise;
  const tmp = await dl.path();
  if (!tmp) return { ok: false, err: 'no path' };
  const body = await fs.readFile(tmp);
  if (!body.length) return { ok: false, err: 'empty' };
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const blob = await blobPath(sha256);
  if (!existsSync(blob)) await fs.writeFile(blob, body);
  return { ok: true, body, sha256, blob, suggested: dl.suggestedFilename() };
}

let ok = 0, fail = 0, dup = 0;
for (const [i, t] of targets.entries()) {
  const label = `[${i + 1}/${targets.length}] ${t.url.split('/').pop().slice(0, 58)}`;
  try {
    const r = await downloadOne(t.url);
    if (!r.ok) { console.log(`  FAIL ${label} — ${r.err}`); fail++; log.push({ crawl_id: crawlId, url: t.url, status: -1, error: r.err }); continue; }
    if (existingSha.has(r.sha256)) { dup++; console.log(`  dup  ${label} (sha already held)`); }
    existingSha.add(r.sha256);

    const name = r.suggested || t.url.split('/').pop();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const ct = ext === 'pdf' ? 'application/pdf'
      : ext === 'png' ? 'image/png'
      : /^jpe?g$/.test(ext) ? 'image/jpeg'
      : ext === 'mp4' ? 'video/mp4'
      : /^(mp3|wav|m4a|ogg)$/.test(ext) ? `audio/${ext}`
      : 'application/octet-stream';

    log.push({
      crawl_id: crawlId,
      retrieved_at: new Date().toISOString(),
      kind: 'weekly-delta',
      url: t.url,
      status: 200,
      content_type: ct,
      suggested_filename: name,
      bytes: r.body.length,
      sha256: r.sha256,
      blob_path: path.relative(ROOT, r.blob).replace(/\\/g, '/'),
      release: releaseFromUrl(t.url),
      csv_type: t.rec['Type'] || null,
      title: t.rec['Title'] || null,
      agency: t.rec['Agency'] || null,
      incident_date: t.rec['Incident Date'] || null,
      incident_location: t.rec['Incident Location'] || null,
      description: t.rec['Description Blurb'] || null,
      dvids_id: t.rec['DVIDS Video ID'] || null,
      release_date: t.rec['Release Date'] || null,
    });
    ok++;
    console.log(`  ok   ${label} ${(r.body.length / 1024).toFixed(0)} KB ${r.sha256.slice(0, 12)}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${label} — ${e.message.slice(0, 70)}`);
    log.push({ crawl_id: crawlId, url: t.url, status: -1, error: e.message.slice(0, 200) });
  }
  await page.waitForTimeout(400);
}

await fs.writeFile(manifestPath, log.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`\ndownloaded ${ok}, failed ${fail}, dup-sha ${dup}`);
console.log(`manifest: ${path.relative(ROOT, manifestPath)}`);
await browser.close();
