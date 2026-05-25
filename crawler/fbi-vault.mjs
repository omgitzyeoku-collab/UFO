// FBI Vault UFO mirror — vault.fbi.gov/UFO.
//
// FBI Vault is behind a basic anti-bot layer (curl gets 403). Real Chrome
// + stealth + slow request cadence works.
//
// Strategy:
//   1. GET vault.fbi.gov/UFO — extract every case-file link (e.g.
//      /UFO/roswell-incident, /UFO/hottel-memo, etc.)
//   2. For each case page, extract every PDF link
//   3. Download every PDF, dedupe by SHA-256
//
// Output: manifest/manifest-fbi-vault-<crawlId>.jsonl

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
await fs.mkdir(DOCS, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-fbi-vault-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0,2), hash.slice(2,4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

// Dedupe set
const existingSha = new Set();
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/\.jsonl$/.test(f)) continue;
  try {
    const ls = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
    for (const l of ls) { try { const r = JSON.parse(l); if (r.sha256) existingSha.add(r.sha256); } catch {} }
  } catch {}
}
console.log(`existing SHAs (dedup): ${existingSha.size}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true,
});
const page = await ctx.newPage();

console.log('=== loading vault.fbi.gov/UFO ===');
const resp = await page.goto('https://vault.fbi.gov/UFO', { waitUntil: 'domcontentloaded', timeout: 120000 });
if (!resp || resp.status() >= 400) { console.error(`index returned ${resp?.status()}`); await browser.close(); process.exit(1); }
await page.waitForTimeout(4000);
// Wait for at least some links to appear (the FBI Vault index renders progressively)
try { await page.waitForSelector('a[href*="/UFO/"]', { timeout: 30000 }); } catch {}

// Extract every case-page link
const caseLinks = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const u = new URL(a.href, location.href).href;
    if (/vault\.fbi\.gov\/(UFO|Unexplained%20Phenomenon)\//i.test(u)) {
      // exclude the index itself
      if (!/\/UFO\/?$/.test(u)) out.add(u);
    }
  }
  return [...out];
});
console.log(`case-page links found: ${caseLinks.length}`);
await fs.writeFile(path.join(DOCS, `fbi-vault-cases-${crawlId}.json`), JSON.stringify(caseLinks, null, 2));

// Visit each case page and harvest PDF URLs
const pdfUrls = new Set();
let caseIdx = 0;
for (const cu of caseLinks) {
  caseIdx++;
  console.log(`[case ${caseIdx}/${caseLinks.length}] ${cu}`);
  try {
    await page.goto(cu, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(1200);
    const found = await page.evaluate(() => {
      const out = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const u = new URL(a.href, location.href).href;
        if (/\.pdf(\?|$)/i.test(u) && /vault\.fbi\.gov/i.test(u)) out.add(u);
      }
      return [...out];
    });
    for (const u of found) pdfUrls.add(u);
    console.log(`  +${found.length} pdfs`);
  } catch (e) {
    console.log(`  err: ${e.message.slice(0,60)}`);
  }
}
console.log(`\n=== PDFs to fetch: ${pdfUrls.size} ===`);

// Download each PDF
async function downloadPdf(url) {
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate((u) => {
      const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    }, url);
    const dl = await downloadPromise;
    const tmp = await dl.path();
    if (!tmp) return { ok: false };
    const body = await fs.readFile(tmp);
    if (!body.length) return { ok: false };
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (existingSha.has(sha256)) { try { await fs.unlink(tmp); } catch {} return { ok: true, dedup: true, sha256 }; }
    const blob = await blobPath(sha256);
    if (!existsSync(blob)) await fs.writeFile(blob, body);
    const suggested = dl.suggestedFilename();
    log.push({
      crawl_id: crawlId, retrieved_at: new Date().toISOString(),
      kind: 'fbi-vault-pdf', url, status: 200,
      content_type: 'application/pdf', suggested_filename: suggested,
      bytes: body.length, sha256, blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      source: 'fbi.gov',
    });
    existingSha.add(sha256);
    try { await fs.unlink(tmp); } catch {}
    return { ok: true, bytes: body.length, sha256 };
  } catch (e) {
    log.push({ crawl_id: crawlId, kind: 'fbi-vault-pdf', url, status: -1, error: e.message.slice(0,200), source: 'fbi.gov' });
    return { ok: false, err: e.message.slice(0,80) };
  }
}

const pdfArr = [...pdfUrls];
let ok = 0, dedup = 0, fail = 0;
for (let i = 0; i < pdfArr.length; i++) {
  const u = pdfArr[i];
  const r = await downloadPdf(u);
  if (r.ok && r.dedup) { dedup++; console.log(`  [${i+1}/${pdfArr.length}] DEDUP ${u.split('/').pop()}`); }
  else if (r.ok) { ok++; console.log(`  [${i+1}/${pdfArr.length}] ${(r.bytes/1024).toFixed(0).padStart(6)}KB ${u.split('/').pop()}`); }
  else { fail++; console.log(`  [${i+1}/${pdfArr.length}] FAIL ${r.err || '?'}`); }
  // Polite cadence — FBI Vault may rate-limit
  if (i % 10 === 9) await page.waitForTimeout(500);
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');
await browser.close();

console.log(`\n=== SUMMARY ===`);
console.log(`  Cases: ${caseLinks.length}`);
console.log(`  PDFs:  ${pdfUrls.size} discovered → ${ok} new, ${dedup} dedup, ${fail} failed`);
console.log(`  Manifest: ${manifestPath}`);
console.log(`Next: run OCR via tesseract/ocr-pipeline.mjs against the new blobs.`);
