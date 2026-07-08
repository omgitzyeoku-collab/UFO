// Build a compact inverted index over every document's body text
// (OCR + extracted PDF text + transcripts) so the site can search the actual
// contents of the ~900 historical documents — not just the QA summaries.
//
// Output: extract/fulltext-index.json  { v, docs:[sha...], idx:{word:[docIdx...]} }
// ~3.4 MB raw (~490 KB brotli). The client LAZY-loads it on first search so
// the initial page load stays lean (corpus.json is only ~100 KB compressed).
//
// Words: 3-20 lowercase letters, common stopwords dropped, postings capped at
// 250 per word (a word in >250 docs is too common to be a useful filter).
// Single-doc words are KEPT — rare terms (a witness surname, a town) are
// exactly what a researcher searches for.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const OUT = path.join(ROOT, 'extract', 'fulltext-index.json');

const STOP = new Set(('the of to and a in is it for on as at by an be or are was were this that with from has have '
  + 'not which but their they them then than there here when what who whom will would could should been being over '
  + 'more most such only also into out any all can may his her its had did does not you your our we us if no so up '
  + 'about after again against because before between during through under while these those some other each').split(/\s+/));

const docsM = new Map();
for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n')) {
  try { const r = JSON.parse(l); if (r.sha256 && !docsM.has(r.sha256)) docsM.set(r.sha256, r); } catch {}
}
const shas = [...docsM.keys()];

const idx = new Map();  // word -> array of doc indices
let indexed = 0, totalChars = 0;
for (let i = 0; i < shas.length; i++) {
  const p = path.join(TEXT_DIR, shas[i] + '.txt');
  if (!existsSync(p)) continue;
  const txt = (await fs.readFile(p, 'utf8')).toLowerCase();
  indexed++; totalChars += txt.length;
  const seen = new Set();
  const m = txt.match(/[a-z]{3,20}/g);
  if (!m) continue;
  for (const w of m) {
    if (STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    let a = idx.get(w);
    if (!a) { a = []; idx.set(w, a); }
    a.push(i);
  }
}

let capped = 0;
for (const [w, a] of idx) if (a.length > 250) { idx.set(w, a.slice(0, 250)); capped++; }

const obj = {};
for (const [w, a] of idx) obj[w] = a;
const out = JSON.stringify({ v: 1, docs: shas, idx: obj });
await fs.writeFile(OUT, out);

console.log(`fulltext-index.json: ${indexed} docs indexed (${(totalChars/1048576).toFixed(1)} MB text)`);
console.log(`  vocabulary: ${idx.size} words | capped(>250): ${capped}`);
console.log(`  size: ${(out.length/1024).toFixed(0)} KB raw`);
