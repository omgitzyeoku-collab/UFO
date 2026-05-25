// Whisper transcription for audio (.mp3/.wav/.m4a/.ogg) + video (.mp4/.mov)
// items in the corpus. Output: extract/transcripts/<sha>.json with timed
// segments + extract/transcripts/<sha>.vtt for HTML5 <track> captions.
//
// Requires whisper.cpp OR `whisper` CLI on PATH. Tries both.
// Defaults to model `small.en` for speed; override with WHISPER_MODEL env.
// ffmpeg is required to demux video → wav.
//
// Usage:
//   node extract/transcribe-media.mjs               # all AUD + VID docs
//   node extract/transcribe-media.mjs --aud         # audio only
//   node extract/transcribe-media.mjs --vid         # video only
//   WHISPER_MODEL=medium.en node extract/transcribe-media.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const OUT = path.join(ROOT, 'extract', 'transcripts');
await fs.mkdir(OUT, { recursive: true });

const flags = process.argv.slice(2);
const audOnly = flags.includes('--aud');
const vidOnly = flags.includes('--vid');
const MODEL = process.env.WHISPER_MODEL || 'small.en';

// Detect whisper binary
function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim().split('\n')[0].trim() : null;
}
const WHISPER = which('whisper') || which('whisper.exe') || which('whisper-cpp') || which('main') || null;
const FFMPEG = which('ffmpeg');
if (!WHISPER) {
  console.error(`whisper binary not found on PATH.

Install one of:
  pip install -U openai-whisper          # Python, GPU-friendly
  brew install whisper-cpp               # macOS
  winget install ggerganov.whisper.cpp   # Windows (community)
  npm i -g whisper-node                  # JS wrapper

Then re-run.`);
  process.exit(2);
}
if (!FFMPEG) { console.error('ffmpeg not found on PATH'); process.exit(2); }
console.log(`whisper: ${WHISPER}`);
console.log(`ffmpeg:  ${FFMPEG}`);
console.log(`model:   ${MODEL}`);

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const docs = new Map();
for (const r of records) if (r.sha256 && !docs.has(r.sha256)) docs.set(r.sha256, r);

const queue = [...docs.values()].filter(d => {
  if (audOnly && d.type !== 'AUD') return false;
  if (vidOnly && d.type !== 'VID') return false;
  if (!audOnly && !vidOnly && !['AUD', 'VID'].includes(d.type)) return false;
  return true;
}).filter(d => {
  const outPath = path.join(OUT, d.sha256 + '.json');
  return !existsSync(outPath);  // idempotent: skip if transcribed
});
console.log(`\nqueue: ${queue.length} docs to transcribe`);

let ok = 0, fail = 0;
for (let i = 0; i < queue.length; i++) {
  const d = queue[i];
  const blob = path.join(ROOT, d.blob_path || `blobs/${d.sha256.slice(0,2)}/${d.sha256.slice(2,4)}/${d.sha256}`);
  if (!existsSync(blob)) { console.log(`[${i+1}/${queue.length}] MISSING blob: ${d.sha256.slice(0,12)}`); fail++; continue; }

  const headline = (d.title || d.name || d.sha256.slice(0,12)).slice(0, 60);
  console.log(`\n[${i+1}/${queue.length}] ${d.type} ${d.sha256.slice(0,12)} | ${headline}`);

  // Demux to wav (16kHz mono PCM — what whisper wants)
  const tmpWav = path.join(os.tmpdir(), `${d.sha256.slice(0,12)}.wav`);
  const r1 = spawnSync(FFMPEG, ['-y', '-i', blob, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav],
    { encoding: 'utf8', windowsHide: true });
  if (r1.status !== 0) {
    console.log(`  ffmpeg failed: ${r1.stderr?.slice(-200) || '?'}`);
    fail++; continue;
  }

  // Run whisper. Output JSON to OUT dir.
  const tmpOut = path.join(OUT, '_tmp_' + d.sha256.slice(0,12));
  await fs.mkdir(tmpOut, { recursive: true });
  const r2 = spawnSync(WHISPER, [
    tmpWav, '--model', MODEL, '--output_dir', tmpOut, '--output_format', 'all', '--language', 'en'
  ], { encoding: 'utf8', windowsHide: true });
  if (r2.status !== 0) {
    console.log(`  whisper failed: ${r2.stderr?.slice(-200) || '?'}`);
    try { await fs.unlink(tmpWav); } catch {}
    fail++; continue;
  }

  // whisper writes <basename>.json/.vtt/.srt/.tsv/.txt — find them
  const baseName = path.basename(tmpWav, '.wav');
  const jsonSrc = path.join(tmpOut, baseName + '.json');
  const vttSrc = path.join(tmpOut, baseName + '.vtt');
  if (existsSync(jsonSrc)) {
    const j = JSON.parse(await fs.readFile(jsonSrc, 'utf8'));
    const segments = (j.segments || []).map(s => ({ start: s.start, end: s.end, text: (s.text || '').trim() }));
    await fs.writeFile(path.join(OUT, d.sha256 + '.json'), JSON.stringify({
      sha256: d.sha256, type: d.type, model: MODEL,
      duration: j.duration || null, language: j.language || 'en',
      text: j.text || segments.map(s => s.text).join(' '),
      segments,
      generated_at: new Date().toISOString(),
    }, null, 2));
  }
  if (existsSync(vttSrc)) {
    await fs.copyFile(vttSrc, path.join(OUT, d.sha256 + '.vtt'));
  }
  // Cleanup
  try { await fs.rm(tmpOut, { recursive: true, force: true }); } catch {}
  try { await fs.unlink(tmpWav); } catch {}

  ok++;
  console.log(`  → ${d.sha256.slice(0,12)}.{json,vtt} written`);
}

console.log(`\n=== SUMMARY ===`);
console.log(`  Transcribed: ${ok}, failed: ${fail}, total: ${queue.length}`);
console.log(`  Output dir: extract/transcripts/`);
