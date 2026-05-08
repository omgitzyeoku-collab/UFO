import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_DIR = path.resolve('manifest');

async function loadJsonl(p) {
  const txt = await fs.readFile(p, 'utf8');
  return txt.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function listManifests() {
  const files = (await fs.readdir(MANIFEST_DIR))
    .filter(f => /^manifest-.*\.jsonl$/.test(f))
    .sort();
  return files.map(f => path.join(MANIFEST_DIR, f));
}

const list = await listManifests();
if (list.length < 2) {
  console.log(`only ${list.length} manifest(s) on disk — nothing to diff yet`);
  process.exit(0);
}

const [prevPath, currPath] = process.argv[2] && process.argv[3]
  ? [process.argv[2], process.argv[3]]
  : [list[list.length - 2], list[list.length - 1]];

console.log(`comparing:\n  prev: ${path.basename(prevPath)}\n  curr: ${path.basename(currPath)}\n`);

const prev = await loadJsonl(prevPath);
const curr = await loadJsonl(currPath);

const prevByUrl = new Map(prev.filter(r => r.url).map(r => [r.url, r]));
const currByUrl = new Map(curr.filter(r => r.url).map(r => [r.url, r]));

const added = [];
const removed = [];
const changed = [];
const same = [];

for (const [url, c] of currByUrl) {
  const p = prevByUrl.get(url);
  if (!p) added.push(c);
  else if (c.sha256 && p.sha256 && c.sha256 !== p.sha256) changed.push({ url, prev: p, curr: c });
  else same.push(c);
}
for (const [url, p] of prevByUrl) {
  if (!currByUrl.has(url)) removed.push(p);
}

const summary = {
  prev: path.basename(prevPath),
  curr: path.basename(currPath),
  added: added.length,
  removed: removed.length,
  changed: changed.length,
  same: same.length,
};

console.log(JSON.stringify(summary, null, 2));

if (added.length) {
  console.log('\n=== ADDED ===');
  for (const r of added) console.log(`  + [${r.status}] ${r.bytes || '?'}B ${r.url}`);
}
if (removed.length) {
  console.log('\n=== REMOVED ===');
  for (const r of removed) console.log(`  - ${r.url}`);
}
if (changed.length) {
  console.log('\n=== CHANGED (content hash differs) ===');
  for (const c of changed) {
    console.log(`  * ${c.url}`);
    console.log(`      prev sha256: ${c.prev.sha256}`);
    console.log(`      curr sha256: ${c.curr.sha256}`);
    console.log(`      prev bytes : ${c.prev.bytes}`);
    console.log(`      curr bytes : ${c.curr.bytes}`);
  }
}

const out = {
  generated_at: new Date().toISOString(),
  prev: path.basename(prevPath),
  curr: path.basename(currPath),
  summary,
  added,
  removed,
  changed,
};
await fs.writeFile(path.join(MANIFEST_DIR, 'last-diff.json'), JSON.stringify(out, null, 2));
console.log(`\nwrote: manifest/last-diff.json`);

// Exit non-zero if there are changes worth alerting on
if (added.length || removed.length || changed.length) {
  process.exitCode = 2;
}
