// Pull war.gov/UFO/ uap-csv.csv index, then download every referenced PDF + thumbnail
// + asset metadata via warmed Playwright context.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS_DIR = path.join(ROOT, 'docs');
await fs.mkdir(BLOBS, { recursive: true });
await fs.mkdir(MANIFEST_DIR, { recursive: true });
await fs.mkdir(DOCS_DIR, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-medialink-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = await ctx.newPage();

console.log('=== warming up Akamai with war.gov/UFO/ ===');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

console.log('=== fetching uap-csv.csv via in-page fetch ===');
const csvRes = await page.evaluate(async () => {
  const r = await fetch('https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv', { credentials: 'include' });
  if (r.status !== 200) return { status: r.status, text: '' };
  return { status: 200, text: await r.text() };
});
console.log(`csv status=${csvRes.status} chars=${csvRes.text.length}`);
await fs.writeFile(path.join(DOCS_DIR, 'uap-csv.csv'), csvRes.text);

if (csvRes.status !== 200 || !csvRes.text) {
  console.error('CSV fetch failed — abort');
  await browser.close();
  process.exit(1);
}

// Parse CSV. Naive parser handles double-quoted commas.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
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

const rows = parseCsv(csvRes.text);
console.log(`csv rows: ${rows.length}`);
const header = rows[0] || [];
console.log(`header (${header.length} cols): ${header.join(' | ')}`);
console.log(`sample row 1: ${(rows[1]||[]).slice(0,10).join(' | ')}`);
console.log(`sample row 2: ${(rows[2]||[]).slice(0,10).join(' | ')}`);

// Save the parsed structure for inspection
const records = rows.slice(1).filter(r => r.some(c => c)).map(r => {
  const obj = {};
  header.forEach((h, i) => { obj[h.trim()] = (r[i] || '').trim(); });
  return obj;
});
await fs.writeFile(path.join(DOCS_DIR, 'uap-csv-parsed.json'), JSON.stringify(records, null, 2));
console.log(`parsed records: ${records.length}`);

// Build the URL set: PDF + thumbnail per record. CSV columns probably include
// asset filename or ID. We'll look at every column for *.pdf / *.jpg / pattern matches.
const pdfUrls = new Set();
const thumbUrls = new Set();
const otherDocUrls = new Set();

for (const rec of records) {
  for (const v of Object.values(rec)) {
    if (typeof v !== 'string') continue;
    // Direct URL?
    if (/^https?:\/\//.test(v)) {
      if (/\.pdf/i.test(v)) pdfUrls.add(v);
      else if (/\/thumbnail\//i.test(v) || /\.(jpg|jpeg|png)/i.test(v)) thumbUrls.add(v);
      else otherDocUrls.add(v);
      continue;
    }
    // Pattern: NNNuapNNNNN
    const m = v.match(/(\d{3}uap\d{5})/i);
    if (m) {
      const id = m[1].toLowerCase();
      pdfUrls.add(`https://www.war.gov/medialink/ufo/release_1/${id}.pdf`);
      thumbUrls.add(`https://www.war.gov/medialink/ufo/release_1/thumbnail/${id}.jpg`);
    }
    // Pattern: filename ends with .pdf
    if (/[a-z0-9_-]+\.pdf$/i.test(v) && !v.includes('/')) {
      pdfUrls.add(`https://www.war.gov/medialink/ufo/release_1/${v}`);
    }
  }
}

console.log(`\n=== discovered ===`);
console.log(`  PDFs:       ${pdfUrls.size}`);
console.log(`  thumbnails: ${thumbUrls.size}`);
console.log(`  other:      ${otherDocUrls.size}`);

async function downloadAndStore(url, kind) {
  // Trigger native Chrome download via injected <a download> click.
  // The browser uses its full TLS fingerprint + warmed Akamai cookies.
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate((u) => {
      const a = document.createElement('a');
      a.href = u;
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, url);
    const download = await downloadPromise;
    const tmpPath = await download.path();
    if (!tmpPath) {
      log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: 'no download path' });
      return { ok: false, status: -1 };
    }
    const body = await fs.readFile(tmpPath);
    if (!body.length) {
      log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: 'empty body' });
      return { ok: false, status: -1 };
    }
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
    // Determine content type from suggested filename
    const suggested = download.suggestedFilename();
    const ct = /\.pdf$/i.test(suggested) ? 'application/pdf'
            : /\.(jpe?g)$/i.test(suggested) ? 'image/jpeg'
            : /\.png$/i.test(suggested) ? 'image/png'
            : 'application/octet-stream';
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: 200,
      content_type: ct, suggested_filename: suggested,
      bytes: body.length, sha256,
      blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
    });
    // Clean up Playwright's temp file
    try { await fs.unlink(tmpPath); } catch {}
    return { ok: true, bytes: body.length, sha256 };
  } catch (e) {
    log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: -1, error: e.message });
    return { ok: false, status: -1, err: e.message };
  }
}

console.log('\n=== downloading PDFs ===');
let pdfsOk = 0, pdfsFail = 0;
for (const u of pdfUrls) {
  const r = await downloadAndStore(u, 'medialink-pdf');
  if (r.ok) { pdfsOk++; console.log(`  [200] ${(r.bytes/1024).toFixed(0).padStart(6)}KB ${u.split('/').pop()}`); }
  else { pdfsFail++; console.log(`  [${r.status}] ${u.split('/').pop()}`); }
  await page.waitForTimeout(50);
}

console.log('\n=== downloading thumbnails ===');
let thumbOk = 0;
for (const u of thumbUrls) {
  const r = await downloadAndStore(u, 'medialink-thumb');
  if (r.ok) thumbOk++;
}
console.log(`  ${thumbOk}/${thumbUrls.size} thumbs ok`);

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');
await browser.close();

console.log(`\n=== SUMMARY ===`);
console.log(`  CSV rows parsed: ${records.length}`);
console.log(`  PDFs:  ${pdfsOk}/${pdfUrls.size} ok (${pdfsFail} failed)`);
console.log(`  Thumbs: ${thumbOk}/${thumbUrls.size}`);
console.log(`  manifest: ${manifestPath}`);
