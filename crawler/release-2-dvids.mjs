// DVIDS crawler for Release 2 (2026-05-22): 51 videos + 7 audio.
// DVIDS pages embed CloudFront/Amazon S3 URLs for the actual media.
// We use Playwright (warmed) rather than curl so we get a real browser
// fetch and respect DVIDS's headers.

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
const manifestPath = path.join(MANIFEST_DIR, `manifest-dvids-r2-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0,2), hash.slice(2,4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

// === parse master csv ===
function parseCsv(text) {
  const rows = [];
  let row=[], field='', inQ=false;
  for (let i=0;i<text.length;i++){
    const c=text[i];
    if(inQ){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')inQ=false;else field+=c;}
    else{if(c==='"')inQ=true;else if(c===','){row.push(field);field='';}
    else if(c==='\r'){}else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}else field+=c;}
  }
  if(field||row.length){row.push(field);rows.push(row);}
  return rows;
}

const text = await fs.readFile(path.join(DOCS, 'uap-data-r2.csv'), 'utf8');
const rows = parseCsv(text);
const h = rows[0];
const records = rows.slice(1).filter(r=>r.some(c=>(c||'').trim())).map(r=>{const o={};h.forEach((hh,i)=>{o[hh.trim()]=(r[i]||'').trim();});return o;});
const r2 = records.filter(r => r['Release Date'] === '5/22/26');
console.log(`Release 2 records: ${r2.length}`);

const queue = [];
const seen = new Set();
for (const r of r2) {
  const id = r['DVIDS Video ID'];
  if (!id || seen.has(id)) continue;
  seen.add(id);
  queue.push({
    id, title: r['Title'], type: r['Type'], agency: r['Agency'],
    video_title: r['Video Title'], description: r['Description Blurb'],
    incident_date: r['Incident Date'], incident_location: r['Incident Location'],
    release_date: r['Release Date'],
  });
}
console.log(`DVIDS IDs to fetch: ${queue.length}`);

// === dedup against any prior dvids manifest ===
const alreadyHaveId = new Set();
for (const f of (await fs.readdir(MANIFEST_DIR))) {
  if (!/manifest-dvids/.test(f)) continue;
  try {
    const ls = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
    for (const l of ls) { try { const r = JSON.parse(l); if (r.status === 200 && r.dvids_id) alreadyHaveId.add(r.dvids_id); } catch {} }
  } catch {}
}
const toFetch = queue.filter(q => !alreadyHaveId.has(q.id));
console.log(`already have: ${queue.length - toFetch.length}; new to fetch: ${toFetch.length}`);

// === browser ===
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();

let ok = 0, fail = 0;
for (let i = 0; i < toFetch.length; i++) {
  const v = toFetch[i];
  const pageUrl = `https://www.dvidshub.net/${v.type === 'AUD' ? 'audio' : 'video'}/${v.id}`;
  console.log(`\n[${(i+1).toString().padStart(2)}/${toFetch.length}] ${v.type} ${v.id} | ${(v.title||'').slice(0,80)}`);
  let mediaUrl = null;
  try {
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (resp && resp.status() >= 400) {
      // Try the alternative URL for audio (some are at /audio/, some at /video/)
      const alt = `https://www.dvidshub.net/${v.type === 'AUD' ? 'video' : 'audio'}/${v.id}`;
      await page.goto(alt, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForTimeout(1200);
    // Look for media URLs in HTML / data attributes / inline scripts
    mediaUrl = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      // common patterns
      const reList = [
        /(https?:\/\/[^"'\s<>]+\.mp4)/i,
        /(https?:\/\/[^"'\s<>]+\.mp3)/i,
        /(https?:\/\/[^"'\s<>]+\.m4a)/i,
        /(https?:\/\/[^"'\s<>]+\.wav)/i,
      ];
      for (const re of reList) { const m = html.match(re); if (m) return m[1]; }
      // also: <video src=...> <audio src=...>
      const v = document.querySelector('video[src], video source[src]');
      if (v) return v.src || v.getAttribute('src');
      const a = document.querySelector('audio[src], audio source[src]');
      if (a) return a.src || a.getAttribute('src');
      return null;
    });
  } catch (e) {
    console.log(`  page error: ${e.message.slice(0,80)}`);
    fail++; log.push({ crawl_id: crawlId, dvids_id: v.id, page_url: pageUrl, status: -1, error: e.message.slice(0,200) });
    continue;
  }
  if (!mediaUrl) {
    console.log('  no media URL found');
    fail++; log.push({ crawl_id: crawlId, dvids_id: v.id, page_url: pageUrl, status: -1, error: 'no media URL' });
    continue;
  }
  console.log(`  → ${mediaUrl.slice(0, 100)}`);

  // Download via Node-side fetch (CloudFront has no CORS; Node ignores CORS).
  let body;
  try {
    const r = await fetch(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': pageUrl,
      },
    });
    if (r.status !== 200) {
      console.log(`  node-fetch ${r.status}`);
      fail++; log.push({ crawl_id: crawlId, dvids_id: v.id, page_url: pageUrl, video_url: mediaUrl, status: r.status, error: `fetch ${r.status}` });
      continue;
    }
    body = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.log(`  node-fetch err: ${e.message.slice(0,80)}`);
    fail++; log.push({ crawl_id: crawlId, dvids_id: v.id, page_url: pageUrl, video_url: mediaUrl, status: -1, error: e.message.slice(0,200) });
    continue;
  }

  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const blob = await blobPath(sha256);
  if (!existsSync(blob)) await fs.writeFile(blob, body);

  log.push({
    crawl_id: crawlId, retrieved_at: new Date().toISOString(),
    kind: v.type === 'AUD' ? 'dvids-audio' : 'dvids-video',
    dvids_id: v.id,
    title: v.title, type: v.type, agency: v.agency,
    video_title: v.video_title, description: v.description,
    incident_date: v.incident_date, incident_location: v.incident_location,
    release_date: v.release_date,
    page_url: pageUrl, video_url: mediaUrl,
    status: 200, bytes: body.length, sha256,
    blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
  });
  ok++;
  console.log(`  [200] ${(body.length/1048576).toFixed(1)} MB  sha=${sha256.slice(0,12)}`);
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');
await browser.close();

console.log(`\n=== SUMMARY ===`);
console.log(`  ok: ${ok}/${toFetch.length} (fail: ${fail})`);
console.log(`  manifest: ${manifestPath}`);
