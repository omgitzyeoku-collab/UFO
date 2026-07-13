// Download the Release 4 direct war.gov assets (PDF documents + standalone
// images) that the buggy 2026-07-10 crawl merged into release-manifest.jsonl
// without ever persisting the blobs. Deduped on blob-on-disk (not manifest
// URL), so it actually re-fetches the missing binaries. Modal thumbnails are
// intentionally NOT fetched — PDF page-1 thumbnails are rendered from the PDF.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const RELEASE_DATE = '7/10/26';
const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS = path.join(ROOT, 'docs');

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-release4-direct-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (inQ) { if (c === '"' && text[i+1] === '"') { field += '"'; i++; } else if (c === '"') inQ = false; else field += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { row.push(field); field = ''; } else if (c === '\r') {} else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += c; }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvText = await fs.readFile(path.join(DOCS, 'uap-data.csv'), 'utf8');
const rows = parseCsv(csvText);
const header = rows[0].map(h => h.trim());
const records = rows.slice(1).filter(r => r.some(c => (c||'').trim())).map(r => { const o = {}; header.forEach((h, i) => { o[h] = (r[i] || '').trim(); }); return o; });
const r4direct = records.filter(r => r['Release Date'] === RELEASE_DATE && !(r['DVIDS Video ID'] || '').trim() && /^https?:\/\//.test((r['PDF | Image Link'] || '').trim()));
console.log(`R4 direct-asset records: ${r4direct.length}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
console.log('warming up war.gov…');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

let ok = 0, fail = 0;
for (let i = 0; i < r4direct.length; i++) {
  const rec = r4direct[i];
  const url = rec['PDF | Image Link'].trim();
  const kind = /\.pdf$/i.test(url) ? 'release4-pdf' : /\.(jpe?g|png)$/i.test(url) ? 'release4-image' : 'release4-other';
  const tag = `[${(i+1).toString().padStart(2)}/${r4direct.length}] ${rec['Type']} ${url.split('/').pop().slice(0, 55)}`;
  try {
    const dlP = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); }, url);
    const dl = await dlP;
    const tmp = await dl.path();
    if (!tmp) { fail++; console.log(`${tag}  FAIL no-path`); continue; }
    const body = await fs.readFile(tmp);
    if (!body.length) { fail++; console.log(`${tag}  FAIL empty`); continue; }
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha256);
    if (!existsSync(blob)) await fs.writeFile(blob, body);
    try { await fs.unlink(tmp); } catch {}
    const suggested = dl.suggestedFilename();
    const ct = /\.pdf$/i.test(suggested) ? 'application/pdf' : /\.(jpe?g)$/i.test(suggested) ? 'image/jpeg' : /\.png$/i.test(suggested) ? 'image/png' : 'application/octet-stream';
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind, url, status: 200,
      content_type: ct, suggested_filename: suggested, bytes: body.length, sha256,
      blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      title: rec['Title'], asset_type: rec['Type'], agency: rec['Agency'],
      incident_date: rec['Incident Date'], incident_location: rec['Incident Location'],
      description: rec['Description Blurb'], release_date: rec['Release Date'],
    });
    ok++; console.log(`${tag}  → ${(body.length/1024).toFixed(0)}KB`);
  } catch (e) {
    fail++; log.push({ crawl_id: crawlId, kind, url, status: -1, error: e.message.slice(0, 160) });
    console.log(`${tag}  FAIL ${e.message.slice(0, 60)}`);
  }
  if (i % 6 === 5) await page.waitForTimeout(250);
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + (log.length ? '\n' : ''));
await browser.close();
console.log(`\n=== R4 DIRECT SUMMARY ===\n  ok: ${ok} | fail: ${fail}\n  manifest: ${path.relative(ROOT, manifestPath)}`);
