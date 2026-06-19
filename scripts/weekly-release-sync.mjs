// Weekly release sync — the "detect AND process" routine.
//
// release-watch (GitHub Action, every 4h) already DETECTS new war.gov
// content and mirrors its metadata. But it runs on an ephemeral runner, so
// the actual binaries never persist and never get processed. This script,
// run LOCALLY (where blobs persist and `claude -p` is Max-authed), closes
// that gap end-to-end:
//
//   1. Pull the latest manifest from origin (release-watch's detections)
//   2. Backfill any war.gov blob that's referenced but not on disk
//   3. Extract text from new PDFs
//   4. Run the 5-agent QA pipeline over anything new with a text source
//   5. Render page-1 thumbnails for new PDFs
//   6. Rebuild corpus.json (release tags derived from URLs) + indexes
//   7. Report what changed (counts by release) for a Linear note
//
// After this completes, commit + deploy (a thin wrapper or the operator does
// the push; this script does not push, by design — it's the heavy lifting).
//
// Intended cadence: weekly (Sunday). Safe to run any time — every stage is
// idempotent and resumable.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const POPPLER = process.env.POPPLER_BIN ||
  'C:/Users/Yeoku/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftoppm.exe';

function run(label, cmd, args, env = {}) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, windowsHide: true, env: { ...process.env, ...env } });
  if (r.status !== 0) console.log(`  (${label} exited ${r.status} — continuing)`);
  return r.status;
}

async function corpusSnapshot() {
  try {
    const c = JSON.parse(await fs.readFile(path.join(ROOT, 'extract', 'corpus.json'), 'utf8'));
    const rel = {}; for (const d of c) rel[d.release || '?'] = (rel[d.release || '?'] || 0) + 1;
    return { total: c.length, qa: c.filter(d => d._qa).length, green: c.filter(d => d._qa?.tier === 'green').length, rel };
  } catch { return null; }
}

console.log(`weekly-release-sync @ ${new Date().toISOString()}`);
const before = await corpusSnapshot();

// 1. Pull origin (release-watch detections). Non-fatal if it conflicts.
run('pull origin (release-watch detections)', 'git', ['pull', '--no-edit', '--no-rebase', 'origin', 'master']);

// 2. Backfill missing war.gov blobs (Release N binaries the runner didn't persist)
run('backfill missing blobs', 'node', ['crawler/backfill-blobs.mjs']);

// 3. Extract text from any PDF blob lacking a .txt (targeted, source-agnostic)
run('extract pdf text', 'node', ['-e', `
const {spawnSync}=require('child_process');const fs=require('fs');
const docs=new Map();
for(const l of fs.readFileSync('extract/release-manifest.jsonl','utf8').trim().split('\\n')){try{const r=JSON.parse(l);if(r.sha256&&!docs.has(r.sha256))docs.set(r.sha256,r);}catch{}}
let n=0;for(const d of docs.values()){const out='extract/text/'+d.sha256+'.txt';if(fs.existsSync(out))continue;const blob=d.blob_path;if(!blob||!fs.existsSync(blob))continue;
const fd=fs.openSync(blob,'r');const b=Buffer.alloc(5);fs.readSync(fd,b,0,5,0);fs.closeSync(fd);if(b.toString('hex').slice(0,8)!=='25504446')continue;
const r=spawnSync('pdftotext',['-q','-enc','UTF-8',blob,out],{timeout:60000,windowsHide:true});if(r.status===0&&fs.existsSync(out))n++;}
console.log('text extracted for',n,'new PDFs');
`], { PATH: `${process.env.PATH};${path.dirname(POPPLER)}` });

// 4. QA pipeline (resumable; processes everything new with a text source)
run('qa pipeline', 'node', ['extract/qa-pipeline.mjs']);

// 5. Thumbnails for new PDFs
run('pdf thumbnails', 'node', ['extract/build-fbi-thumbs.mjs'], { POPPLER_BIN: POPPLER });

// 6. Rebuild corpus + indexes
run('build corpus', 'node', ['extract/build-corpus.mjs']);
run('build qa-index', 'node', ['extract/build-qa-index.mjs']);
run('build transcript-search', 'node', ['extract/build-transcript-search.mjs']);
run('build entity pages', 'node', ['extract/build-entity-pages.mjs']);
run('build doc pages + sitemap', 'node', ['extract/build-doc-pages.mjs']);

// Mirror artefacts into public/
run('mirror artefacts to public', 'node', ['-e', `
const fs=require('fs');const cp=require('child_process');
for(const f of ['corpus.json','qa-index.json','thumbs-index.json','transcripts-index.json','transcripts-search.json']){try{fs.copyFileSync('extract/'+f,'public/extract/'+f);}catch{}}
for(const dir of ['public','thumbs','transcripts']){try{cp.execSync('cp -r extract/'+dir+'/. public/extract/'+dir+'/',{stdio:'ignore'});}catch{}}
console.log('mirrored');
`]);

// 7. Report delta
const after = await corpusSnapshot();
console.log(`\n=== WEEKLY SYNC COMPLETE ===`);
if (before && after) {
  console.log(`  docs:  ${before.total} → ${after.total}  (+${after.total - before.total})`);
  console.log(`  QA:    ${before.qa} → ${after.qa}  (+${after.qa - before.qa})`);
  console.log(`  green: ${before.green} → ${after.green}  (+${after.green - before.green})`);
  console.log(`  by release (now): ${JSON.stringify(after.rel)}`);
}
console.log(`\nNext: review, then  git add -A && git commit && git push  +  vercel --prod`);
console.log(`(deploy is intentionally manual — this script does the heavy lifting, not the irreversible push)`);
