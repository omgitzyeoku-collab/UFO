// Tranche detection: poll war.gov/UFO/ CSV index daily, detect new rows,
// download new assets, run QA pipeline, deploy. Existing scheduled task
// (UFO-Archive-Tick) calls this.
//
// Outputs a summary diff + triggers downstream rebuild + push.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const CSV_LOCAL = path.join(ROOT, 'docs', 'uap-csv.csv');
const CSV_PARSED = path.join(ROOT, 'docs', 'uap-csv-parsed.json');
const HISTORY = path.join(ROOT, 'docs', 'tranche-history.jsonl');

console.log('=== tranche watch run', new Date().toISOString(), '===');

// Snapshot the current CSV before updating
let prevCsv = null;
if (existsSync(CSV_LOCAL)) prevCsv = await fs.readFile(CSV_LOCAL, 'utf8');
let prevRecords = null;
if (existsSync(CSV_PARSED)) prevRecords = JSON.parse(await fs.readFile(CSV_PARSED, 'utf8'));

// Re-run the medialink corpus crawler (it pulls the latest CSV + downloads new items)
console.log('\n--- pulling latest CSV + new assets ---');
const r = spawnSync('node', ['crawler/war-gov-medialink-corpus.mjs'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error(`medialink crawler exited ${r.status} — abort`);
  process.exit(r.status || 1);
}

// Compare new CSV against snapshot
const newCsv = await fs.readFile(CSV_LOCAL, 'utf8');
const newRecords = JSON.parse(await fs.readFile(CSV_PARSED, 'utf8'));

let added = [], removed = [], modified = [];
if (prevRecords) {
  const prevByTitle = new Map(prevRecords.map(r => [r.Title, r]));
  const newByTitle = new Map(newRecords.map(r => [r.Title, r]));
  for (const [t, r] of newByTitle) {
    if (!prevByTitle.has(t)) added.push(r);
    else {
      const p = prevByTitle.get(t);
      const pdfChanged = (p['PDF | Image Link'] || '') !== (r['PDF | Image Link'] || '');
      if (pdfChanged) modified.push({ before: p, after: r });
    }
  }
  for (const [t, p] of prevByTitle) if (!newByTitle.has(t)) removed.push(p);
}

console.log(`\n--- diff vs previous tranche ---`);
console.log(`  added:    ${added.length}`);
console.log(`  removed:  ${removed.length}`);
console.log(`  modified: ${modified.length}`);

const tranche = {
  detected_at: new Date().toISOString(),
  prev_record_count: prevRecords?.length || 0,
  new_record_count: newRecords.length,
  added_titles: added.map(r => r.Title).slice(0, 20),
  removed_titles: removed.map(r => r.Title).slice(0, 20),
  modified_titles: modified.map(m => m.after.Title).slice(0, 20),
};
await fs.appendFile(HISTORY, JSON.stringify(tranche) + '\n');

// If any change, run downstream pipeline
if (added.length || removed.length || modified.length) {
  console.log('\n--- changes detected, running downstream pipeline ---');

  // Extract text from new PDFs
  spawnSync('node', ['extract/extract-pdf-text.mjs'], { stdio: 'inherit', shell: process.platform === 'win32' });

  // QA pipeline (idempotent — only processes new shas)
  spawnSync('node', ['extract/qa-pipeline.mjs'], { stdio: 'inherit', shell: process.platform === 'win32' });

  // Regenerate sitemap
  spawnSync('node', ['extract/generate-sitemap.mjs'], { stdio: 'inherit', shell: process.platform === 'win32' });

  // Append to public correction log isn't right here — corrections are
  // user-reported. But we do log the tranche event.

  // Commit + push
  spawnSync('git', ['add', '-A'], { stdio: 'inherit', shell: process.platform === 'win32' });
  const msg = `tranche: ${tranche.detected_at.slice(0,10)} (+${added.length} -${removed.length} ~${modified.length})`;
  spawnSync('git', ['commit', '-m', msg], { stdio: 'inherit', shell: process.platform === 'win32' });
  spawnSync('git', ['push'], { stdio: 'inherit', shell: process.platform === 'win32' });

  // Alert via Vega/Telegram
  const prompt = `A new UAP archive tranche dropped at war.gov/UFO/ on ${tranche.detected_at}.
Added: ${tranche.added_titles.slice(0, 5).join(', ')}${added.length > 5 ? ' and ' + (added.length-5) + ' more' : ''}
Removed: ${removed.length}
Modified: ${modified.length}
Send a single Telegram message via vega-push__push_to_user summarising in <= 3 lines.`;
  spawnSync('claude', ['-p', '--dangerously-skip-permissions', prompt], { stdio: 'inherit', shell: process.platform === 'win32' });
} else {
  console.log('\n--- no changes ---');
}

console.log(`\n=== tranche watch complete ${new Date().toISOString()} ===`);
