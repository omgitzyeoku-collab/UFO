// Acquire the 28 DVIDS-hosted videos referenced in the war.gov/UFO/ CSV.
// Strategy: GET dvidshub.net/video/{id}, parse out the CloudFront MP4 URL,
// download with curl. Idempotent + resumable.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
await fs.mkdir(BLOBS, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-dvids-${crawlId}.jsonl`);
const log = [];

const records = JSON.parse(await fs.readFile(path.join(ROOT, 'docs', 'uap-csv-parsed.json'), 'utf8'));
const seen = new Set();
const queue = [];
for (const r of records) {
  const id = r['DVIDS Video ID'];
  if (!id || seen.has(id)) continue;
  seen.add(id);
  queue.push({ id, title: r.Title, agency: r.Agency, video_title: r['Video Title'], description: r['Description Blurb'] });
}
console.log(`DVIDS videos to acquire: ${queue.length}`);

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0,2), hash.slice(2,4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

function curlGet(url, outFile = null) {
  const args = [
    '-sS', '-L',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
    '-H', 'Accept: */*',
    '--max-time', '600',
  ];
  if (outFile) args.push('-o', outFile);
  args.push(url);
  return spawnSync('curl', args, { encoding: outFile ? undefined : 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
}

let ok = 0, failed = 0;
for (let i = 0; i < queue.length; i++) {
  const v = queue[i];
  const pageUrl = `https://www.dvidshub.net/video/${v.id}`;
  console.log(`\n[${i+1}/${queue.length}] DVIDS ${v.id} | ${v.title?.slice(0,80)}`);
  // Fetch HTML
  const r = curlGet(pageUrl);
  if (r.status !== 0) {
    console.log(`  page fetch failed: status=${r.status}`); failed++; continue;
  }
  // Extract MP4 URL
  const m = r.stdout.match(/(https?:\/\/[^"\s]+\.mp4)/);
  if (!m) {
    console.log('  no MP4 URL in page'); failed++;
    log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: 'dvids-video', dvids_id: v.id, page_url: pageUrl, status: -1, error: 'no MP4 URL' });
    continue;
  }
  const videoUrl = m[1];
  console.log(`  → ${videoUrl}`);

  // Download to a temp file, hash, move to blob
  const tmp = path.join(ROOT, `_tmp_${v.id}.mp4`);
  const dl = curlGet(videoUrl, tmp);
  if (dl.status !== 0) {
    console.log(`  download failed: status=${dl.status}`); failed++;
    log.push({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: 'dvids-video', dvids_id: v.id, page_url: pageUrl, video_url: videoUrl, status: dl.status, error: 'download failed' });
    try { await fs.unlink(tmp); } catch {}
    continue;
  }
  const body = await fs.readFile(tmp);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const blob = await blobPath(sha256);
  if (!existsSync(blob)) await fs.rename(tmp, blob);
  else { await fs.unlink(tmp); }
  log.push({
    crawl_id: crawlId, retrieved_at: new Date().toISOString(),
    kind: 'dvids-video',
    dvids_id: v.id,
    title: v.title,
    agency: v.agency,
    video_title: v.video_title,
    page_url: pageUrl,
    video_url: videoUrl,
    status: 200,
    bytes: body.length,
    sha256,
    blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
  });
  console.log(`  [200] ${(body.length/1024/1024).toFixed(1)} MB | sha256=${sha256.slice(0,12)}`);
  ok++;
}

await fs.writeFile(manifestPath, log.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`\n=== SUMMARY ===`);
console.log(`  ok: ${ok}/${queue.length}, failed: ${failed}`);
console.log(`  manifest: ${manifestPath}`);
