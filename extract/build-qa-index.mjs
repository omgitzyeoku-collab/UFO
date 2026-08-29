// Build extract/qa-index.json + thumbs-index.json + transcripts-index.json
// — flat lists of which docs have QA / thumbnail / transcript artefacts.
// Loaded at site startup so the client only fetches files that exist
// (otherwise we get 150+ console 404s on initial page load).

import fs from 'node:fs/promises';
import path from 'node:path';
import { QA_DIR, QA_DIR_CANDIDATES } from './qa-dir.mjs';

const ROOT = path.resolve('.');
const THUMBS_DIR = path.join(ROOT, 'extract', 'thumbs');
const TRANSCRIPTS_DIR = path.join(ROOT, 'extract', 'transcripts');

async function indexDir(dir, suffix) {
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith(suffix)).map(f => f.replace(new RegExp(suffix + '$'), '')).sort();
  } catch { return []; }
}

const qaShas = await indexDir(QA_DIR, '.json');
const thumbShas = await indexDir(THUMBS_DIR, '.jpg');
const transcriptShas = await indexDir(TRANSCRIPTS_DIR, '.json');

// An empty qa-index is not a valid state — the client reads it to decide which
// per-document QA files are worth fetching, so {"shas":[],"count":0} silently
// turns off the entire verification layer on the site. That is exactly what
// shipped when this script resolved a gitignored path in CI. Fail instead.
if (qaShas.length === 0) {
  console.error('FATAL (build-qa-index): resolved 0 QA files.');
  console.error(`  looked in:  ${QA_DIR}`);
  console.error(`  candidates: ${QA_DIR_CANDIDATES.join(', ')}`);
  console.error('Refusing to write an empty qa-index.json — it would disable every');
  console.error('verification badge on the site. Fix the QA path, then rebuild.');
  process.exit(1);
}

const ts = new Date().toISOString();
await fs.writeFile(path.join(ROOT, 'extract', 'qa-index.json'),
  JSON.stringify({ shas: qaShas, count: qaShas.length, generated_at: ts }, null, 0));
await fs.writeFile(path.join(ROOT, 'extract', 'thumbs-index.json'),
  JSON.stringify({ shas: thumbShas, count: thumbShas.length, generated_at: ts }, null, 0));
await fs.writeFile(path.join(ROOT, 'extract', 'transcripts-index.json'),
  JSON.stringify({ shas: transcriptShas, count: transcriptShas.length, generated_at: ts }, null, 0));

console.log(`qa-index:         ${qaShas.length}`);
console.log(`thumbs-index:     ${thumbShas.length}`);
console.log(`transcripts-idx:  ${transcriptShas.length}`);
