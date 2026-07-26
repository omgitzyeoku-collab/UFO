// Targeted DVIDS acquisition — fetch only the media we don't already hold.
//
// dvids-videos.mjs has no skip logic: it re-downloads every ID in the CSV
// (~300 files, many GB) on each run. For a weekly job that's untenable, so
// this variant diffs against the manifests first and fetches only the gap.
//
// Also handles audio. The original matches /\.mp4/ only, which is why the
// three NASA AUD items in Release 3 could never have been acquired by it.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';

// Hash by streaming. These files run to several GB (one Release 3 item is
// 3.2 GB), and fs.readFile throws ERR_FS_FILE_TOO_LARGE past 2 GiB.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

const ROOT = path.resolve('.');
const BLOBS = path.join(ROOT, 'blobs');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
await fs.mkdir(BLOBS, { recursive: true });

const crawlId = new Date().toISOString().replace(/[:.]/g, '-');
const manifestPath = path.join(MANIFEST_DIR, `manifest-dvids-delta-${crawlId}.jsonl`);
const log = [];

async function blobPath(hash) {
  const dir = path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, hash);
}

// --- what we already hold (blob confirmed on disk)
const held = new Set();
for (const f of await fs.readdir(MANIFEST_DIR)) {
  if (!/\.jsonl$/.test(f)) continue;
  for (const l of (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.dvids_id && r.status === 200 && r.blob_path && existsSync(path.resolve(ROOT, r.blob_path))) held.add(String(r.dvids_id));
  }
}
try {
  for (const l of (await fs.readFile(path.join(ROOT, 'extract', 'release-manifest.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.dvids_id && r.blob_path && existsSync(path.resolve(ROOT, r.blob_path))) held.add(String(r.dvids_id)); } catch {}
  }
} catch {}
console.log(`DVIDS ids already held: ${held.size}`);

const records = JSON.parse(await fs.readFile(path.join(ROOT, 'docs', 'uap-csv-parsed.json'), 'utf8'));
const seen = new Set();
const queue = [];
for (const r of records) {
  const id = (r['DVIDS Video ID'] || '').trim();
  if (!id || seen.has(id)) continue;
  seen.add(id);
  if (held.has(id)) continue;
  queue.push({
    id, title: r.Title, agency: r.Agency, video_title: r['Video Title'],
    description: r['Description Blurb'], type: (r.Type || '').toUpperCase(),
    incident_date: r['Incident Date'], incident_location: r['Incident Location'],
    release_date: r['Release Date'],
  });
}
console.log(`DVIDS ids in CSV: ${seen.size}  to acquire: ${queue.length}`);
for (const q of queue) console.log(`  ${q.type.padEnd(4)} ${q.id}  ${(q.title || '').slice(0, 62)}`);

if (!queue.length) { console.log('\nnothing to acquire.'); process.exit(0); }

// Append-as-we-go. A multi-GB download that dies on item N must not discard
// items 1..N-1 and force a re-fetch of everything.
async function rec(o) {
  log.push(o);
  await fs.appendFile(manifestPath, JSON.stringify(o) + '\n');
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
for (const [i, v] of queue.entries()) {
  const pageUrl = `https://www.dvidshub.net/video/${v.id}`;
  console.log(`\n[${i + 1}/${queue.length}] ${v.type} ${v.id} | ${(v.title || '').slice(0, 70)}`);
  const r = curlGet(pageUrl);
  if (r.status !== 0) {
    console.log(`  page fetch failed: status=${r.status}`); failed++;
    await rec({ crawl_id: crawlId, kind: 'dvids-delta', dvids_id: v.id, page_url: pageUrl, status: -1, error: 'page fetch failed' });
    continue;
  }
  // Video first, then audio containers.
  const m = r.stdout.match(/(https?:\/\/[^"\s]+\.mp4)/)
    || r.stdout.match(/(https?:\/\/[^"\s]+\.(?:mp3|m4a|wav|ogg))/);
  if (!m) {
    console.log('  no media URL in page'); failed++;
    await rec({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: 'dvids-delta', dvids_id: v.id, page_url: pageUrl, status: -1, error: 'no media URL' });
    continue;
  }
  const mediaUrl = m[1];
  const ext = (mediaUrl.split('.').pop() || 'mp4').toLowerCase();
  console.log(`  → ${mediaUrl.slice(0, 100)}`);

  const tmp = path.join(ROOT, `_tmp_${v.id}.${ext}`);
  const dl = curlGet(mediaUrl, tmp);
  if (dl.status !== 0) {
    console.log(`  download failed: status=${dl.status}`); failed++;
    await rec({ crawl_id: crawlId, retrieved_at: new Date().toISOString(), kind: 'dvids-delta', dvids_id: v.id, page_url: pageUrl, video_url: mediaUrl, status: dl.status, error: 'download failed' });
    try { await fs.unlink(tmp); } catch {}
    continue;
  }
  const size = statSync(tmp).size;
  if (!size) {
    console.log('  empty download'); failed++;
    try { await fs.unlink(tmp); } catch {}
    continue;
  }
  const sha256 = await sha256File(tmp);
  const blob = await blobPath(sha256);
  if (!existsSync(blob)) await fs.rename(tmp, blob); else await fs.unlink(tmp);
  const body = { length: size };

  const isAud = v.type === 'AUD' || /^(mp3|m4a|wav|ogg)$/.test(ext);
  await rec({
    crawl_id: crawlId, retrieved_at: new Date().toISOString(),
    kind: isAud ? 'dvids-audio' : 'dvids-video',
    dvids_id: v.id,
    title: v.title, agency: v.agency, video_title: v.video_title,
    description: v.description,
    incident_date: v.incident_date, incident_location: v.incident_location,
    release_date: v.release_date,
    csv_type: v.type,
    page_url: pageUrl, video_url: mediaUrl,
    status: 200,
    content_type: isAud ? `audio/${ext === 'm4a' ? 'mp4' : ext}` : 'video/mp4',
    bytes: body.length, sha256,
    blob_path: path.relative(ROOT, blob).replace(/\\/g, '/'),
  });
  console.log(`  [200] ${(body.length / 1024 / 1024).toFixed(1)} MB | sha256=${sha256.slice(0, 12)}`);
  ok++;
}

console.log(`\n=== SUMMARY ===  ok: ${ok}/${queue.length}, failed: ${failed}`);
console.log(`  manifest: ${path.relative(ROOT, manifestPath)}`);
