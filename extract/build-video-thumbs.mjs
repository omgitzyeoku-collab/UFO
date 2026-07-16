#!/usr/bin/env node
/**
 * Extract a poster frame from every video blob.
 *
 * All 852 PDFs carry a thumbnail; none of the 105 videos did, so the grid
 * rendered 105 identical orange play-button placeholders — the single largest
 * visual failure on the site. The footage is the most compelling material in the
 * archive and it was showing as nothing.
 *
 * Seeks ~12% into the runtime rather than frame 0: these are sensor recordings
 * that often open on a black frame or a title card.
 *
 * Idempotent — skips any thumbnail already built. Run after a new release lands.
 */
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'extract', 'thumbs');
const corpus = JSON.parse(await fs.readFile(path.join(ROOT, 'extract/corpus.json'), 'utf8'));
const DOCS = (Array.isArray(corpus) ? corpus : Object.values(corpus)[0]).filter(d => !d._derivative);

const blobPath = sha => path.join(ROOT, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha);

function run(cmd, cmdArgs, timeoutMs = 60_000) {
  return new Promise(resolve => {
    const p = spawn(cmd, cmdArgs, { windowsHide: true });
    let err = '';
    p.stderr.on('data', c => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', e => { clearTimeout(t); resolve({ ok: false, err: e.message }); });
    p.on('close', code => { clearTimeout(t); resolve({ ok: code === 0, err }); });
  });
}

/** Runtime in seconds, or null if ffprobe can't read it. */
async function duration(file) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { windowsHide: true });
    let out = '';
    p.stdout.on('data', c => (out += c));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const d = parseFloat(out.trim());
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    });
  });
}

await fs.mkdir(OUT_DIR, { recursive: true });

const vids = DOCS.filter(d => d.type === 'VID');
let built = 0, skipped = 0, failed = 0;
const failures = [];

for (const d of vids) {
  const dest = path.join(OUT_DIR, d.sha256 + '.jpg');
  if (existsSync(dest) && statSync(dest).size > 1024) { skipped++; continue; }

  const src = blobPath(d.sha256);
  if (!existsSync(src)) { failed++; failures.push(`${d.sha256.slice(0, 10)} no blob`); continue; }

  const dur = await duration(src);
  // 12% in — past the black frames and title cards these recordings open on.
  const seek = dur ? Math.max(0.5, Math.min(dur * 0.12, dur - 0.5)) : 1;

  const r = await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', seek.toFixed(2), '-i', src,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '4',
    dest,
  ]);

  if (r.ok && existsSync(dest) && statSync(dest).size > 1024) {
    built++;
    process.stdout.write(`\r  built ${built}  skipped ${skipped}  failed ${failed}   `);
  } else {
    failed++;
    failures.push(`${d.sha256.slice(0, 10)} ${(r.err || '').split('\n')[0].slice(0, 60)}`);
  }
}

process.stdout.write('\n');
console.log(`video thumbs: ${built} built, ${skipped} already present, ${failed} failed (of ${vids.length} videos)`);
if (failures.length) {
  console.log('failures:');
  for (const f of failures.slice(0, 8)) console.log('  ' + f);
}
