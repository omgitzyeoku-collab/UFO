// Retry only failed URLs from the latest medialink manifest.
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
chromium.use(StealthPlugin());

const ROOT = path.resolve('.');
const MANIFEST_DIR = path.join(ROOT, 'manifest');

// Find latest medialink manifest
const files = (await fs.readdir(MANIFEST_DIR)).filter(f => /^manifest-medialink-/.test(f)).sort();
const latest = files[files.length - 1];
console.log(`reading: ${latest}`);
const lines = (await fs.readFile(path.join(MANIFEST_DIR, latest), 'utf8')).trim().split('\n').map(l => JSON.parse(l));

const failed = lines.filter(r => r.status !== 200);
console.log(`failed entries: ${failed.length}`);
for (const f of failed) console.log(`  ${f.url} (${f.status})`);
if (!failed.length) { console.log('nothing to retry'); process.exit(0); }

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const outManifest = path.join(MANIFEST_DIR, `manifest-medialink-retry-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(ROOT, 'blobs', hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();

console.log('=== warming up ===');
await page.goto('https://www.war.gov/UFO/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

for (const f of failed) {
  const url = f.url;
  console.log(`\nretrying: ${url}`);
  // Try multiple times with longer waits
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
      await page.evaluate((u) => {
        const a = document.createElement('a');
        a.href = u; a.download = ''; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
      }, url);
      const download = await downloadPromise;
      const tmpPath = await download.path();
      if (!tmpPath) throw new Error('no download path');
      const body = await fs.readFile(tmpPath);
      if (!body.length) throw new Error('empty body');
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const blob = await blobPath(sha256);
      try { await fs.access(blob); } catch { await fs.writeFile(blob, body); }
      log.push({
        crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: f.kind || 'medialink-pdf',
        url, status: 200,
        content_type: /\.pdf$/i.test(url) ? 'application/pdf' : 'image/jpeg',
        bytes: body.length, sha256,
        blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
        attempt,
      });
      try { await fs.unlink(tmpPath); } catch {}
      console.log(`  [200] attempt=${attempt}  ${(body.length/1024).toFixed(0)}KB  sha=${sha256.slice(0,12)}`);
      break;
    } catch (e) {
      console.log(`  attempt ${attempt} fail: ${e.message.slice(0,100)}`);
      if (attempt === 3) {
        log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: f.kind, url, status: -1, error: e.message });
      }
      await page.waitForTimeout(2000);
    }
  }
}

await browser.close();
await fs.writeFile(outManifest, log.map(r => JSON.stringify(r)).join('\n') + '\n');

const ok = log.filter(r => r.status === 200).length;
const stillFailed = log.filter(r => r.status !== 200).length;
console.log(`\n=== retry done: ${ok} ok, ${stillFailed} still failed ===`);
console.log(`manifest: ${outManifest}`);
