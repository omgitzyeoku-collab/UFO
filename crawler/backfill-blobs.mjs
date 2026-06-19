// Backfill war.gov blobs for manifest entries that have a URL but no local
// blob — i.e. docs that release-watch detected + recorded on the ephemeral
// GitHub runner but whose binaries never reached this machine.
//
// Downloads each via warmed stealth Chromium (native browser download),
// verifies it stores under the SHA the manifest expects (or records the new
// SHA if war.gov re-rendered the file), and writes text + a release tag
// derived from the medialink URL (release_0N → release_N).

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const crawlId = new Date(`2026-06-14T00:00:00Z`).toISOString().replace(/[:.]/g, '-');
const outManifest = path.join(MANIFEST_DIR, `manifest-backfill-${crawlId}.jsonl`);

async function blobPath(hash) {
  const dir = path.join(ROOT, 'blobs', hash.slice(0,2), hash.slice(2,4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

// Find war.gov docs with a URL but no local blob.
const docs = new Map();
for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n')) {
  try { const r = JSON.parse(l); if (r.sha256 && !docs.has(r.sha256)) docs.set(r.sha256, r); } catch {}
}
const targets = [...docs.values()].filter(d =>
  d.source === 'war.gov' && (d.url || d.release_url) && !existsSync(d.blob_path || '') && !d.dvids_id);
console.log(`backfill targets: ${targets.length}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
console.log('warming up war.gov…');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

function releaseFromUrl(u) {
  const m = (u || '').match(/release_0?(\d+)/i);
  return m ? `release_${parseInt(m[1])}` : null;
}

const log = [];
let ok = 0, fail = 0, shaChanged = 0;
for (let i = 0; i < targets.length; i++) {
  const d = targets[i];
  const url = d.url || d.release_url;
  try {
    const dlP = page.waitForEvent('download', { timeout: 90000 });
    await page.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.download = ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); }, url);
    const dl = await dlP;
    const tmp = await dl.path();
    if (!tmp) { fail++; continue; }
    const body = await fs.readFile(tmp);
    if (!body.length) { fail++; continue; }
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const blob = await blobPath(sha);
    if (!existsSync(blob)) await fs.writeFile(blob, body);
    try { await fs.unlink(tmp); } catch {}
    if (sha !== d.sha256) shaChanged++;
    log.push({
      crawl_id: crawlId, retrieved_at: new Date(`2026-06-14T00:00:00Z`).toISOString(),
      kind: 'backfill-pdf', url, status: 200, content_type: 'application/pdf',
      bytes: body.length, sha256: sha, blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
      orig_sha: d.sha256, release_tag: releaseFromUrl(url), source: 'war.gov',
    });
    ok++;
    if ((i+1) % 10 === 0 || i === targets.length-1) console.log(`  [${i+1}/${targets.length}] ${(body.length/1024).toFixed(0)}KB ${(d.title||d.name||'').slice(0,45)}`);
  } catch (e) {
    fail++;
    log.push({ crawl_id: crawlId, kind: 'backfill-pdf', url, status: -1, error: e.message.slice(0,120), orig_sha: d.sha256 });
  }
  if (i % 8 === 7) await page.waitForTimeout(150);
}

await fs.writeFile(outManifest, log.map(r => JSON.stringify(r)).join('\n') + (log.length ? '\n' : ''));
await browser.close();
console.log(`\n=== SUMMARY ===`);
console.log(`  downloaded: ${ok} | failed: ${fail} | sha changed since detection: ${shaChanged}`);
console.log(`  manifest: ${outManifest}`);
