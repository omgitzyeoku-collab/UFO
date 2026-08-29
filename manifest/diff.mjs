import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_DIR = path.resolve('manifest');

async function loadJsonl(p) {
  const txt = await fs.readFile(p, 'utf8');
  return txt.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Only the daily crawl series is comparable run-to-run. manifest/ also holds
// ~45 one-off snapshots from twelve other families (manifest-dvids-r2-*,
// manifest-release2-*, manifest-weekly-*, manifest-spa-wargov-*, …), and a
// blanket `manifest-*` glob sorted lexicographically puts digits before
// letters — so the last two entries were permanently the frozen May
// manifest-spa-wargov and the frozen July manifest-weekly, two crawls with
// zero URLs in common. That pair diffs to +10 -62 ~0 forever, which is the
// false "change detected" this repo committed 18 times in a row.
const DAILY_RE = /^manifest-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/;

function dailyTimestamp(filename) {
  const m = DAILY_RE.exec(filename);
  if (!m) return null;
  const [, date, hh, mm, ss, ms] = m;
  const t = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(t) ? null : t;
}

async function listManifests() {
  const files = (await fs.readdir(MANIFEST_DIR))
    .map(f => ({ f, t: dailyTimestamp(f) }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t)      // chronological, not lexicographic
    .map(x => x.f);
  return files.map(f => path.join(MANIFEST_DIR, f));
}

// The daily crawl walks war.gov/UFO/ and records every subresource the page
// pulls — roughly 117 rows, of which ~72 are site chrome (DNN skin CSS/JS,
// ScriptResource.axd, font-awesome, analytics) and 2 are the SPA shell itself.
// None of that is the archive. Worse, the CMS appends a ?cdv=NNNN cache-buster
// that changes on every content deploy, so a chrome asset reappears under a new
// URL and reads as one removal plus one addition.
//
// Measured over all 61 consecutive daily pairs: diffing everything fires on 44
// of them, 801 of the 902 events being pure ?cdv= churn. Restricting the signal
// to corpus assets fires on 11 — and all 11 are real (three CSV renames, and new
// slideshow thumbnails on exactly the four release dates).
//
// Everything is still diffed and printed. Only the exit code is gated.
const CORPUS_PATH = /\/(medialink\/ufo|Interactive\/2026\/UFO)\//i;
const ASSET_EXT = /\.(pdf|jpe?g|png|gif|webp|mp4|mov|m4v|mp3|wav|csv|json|txt|docx?|xlsx?)(\?|$)/i;

/** Is this URL part of the archive, as opposed to war.gov page furniture? */
function isCorpusAsset(url) {
  return CORPUS_PATH.test(url) && ASSET_EXT.test(url);
}

/** Compare on the URL without its cache-busting query string. */
function urlKey(url) {
  try {
    const u = new URL(url);
    u.search = '';
    return u.origin.toLowerCase() + u.pathname;
  } catch { return url; }
}

const list = await listManifests();

const explicitPair = process.argv[2] && process.argv[3];
if (!explicitPair && list.length < 2) {
  console.log(`only ${list.length} daily manifest(s) on disk — nothing to diff yet`);
  process.exit(0);
}

const [prevPath, currPath] = explicitPair
  ? [process.argv[2], process.argv[3]]
  : [list[list.length - 2], list[list.length - 1]];

console.log(`comparing:\n  prev: ${path.basename(prevPath)}\n  curr: ${path.basename(currPath)}\n`);

const prev = await loadJsonl(prevPath);
const curr = await loadJsonl(currPath);

const prevByUrl = new Map(prev.filter(r => r.url).map(r => [urlKey(r.url), r]));
const currByUrl = new Map(curr.filter(r => r.url).map(r => [urlKey(r.url), r]));

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

// Corpus-only view — this is what decides the exit code.
const sigAdded   = added.filter(r => isCorpusAsset(r.url));
const sigRemoved = removed.filter(r => isCorpusAsset(r.url));
const sigChanged = changed.filter(c => isCorpusAsset(c.curr?.url || c.url || ''));

const summary = {
  prev: path.basename(prevPath),
  curr: path.basename(currPath),
  added: added.length,
  removed: removed.length,
  changed: changed.length,
  same: same.length,
  // Only these drive the alert. The rest is war.gov chrome.
  corpus_added: sigAdded.length,
  corpus_removed: sigRemoved.length,
  corpus_changed: sigChanged.length,
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

// Two manifests that share no URLs at all are not a before/after pair — they
// are an incomparable comparison, and every row reads as added or removed.
// Never report that as a release; exit 1 so callers treat it as an error
// rather than as the exit-2 "changes detected" signal.
//
// This runs BEFORE last-diff.json is written: a summary we have just rejected
// must not become the committed record of the last comparison.
//
// A crawl that returned almost nothing is a crawl failure, not an incomparable
// pair, so it is exempted here and alerts through the normal path instead.
const totalLoss = prevByUrl.size > 0 && currByUrl.size < prevByUrl.size * 0.1;
if (same.length === 0 && (added.length || removed.length) && !totalLoss) {
  console.error('\nFATAL: the two manifests share no URLs in common (same=0).');
  console.error(`  ${summary.prev}`);
  console.error(`  ${summary.curr}`);
  console.error('This is an incomparable pair, not a change. Refusing to signal a release.');
  console.error('Leaving manifest/last-diff.json at the previous comparison.');
  process.exit(1);
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

// Exit 2 only for corpus changes. Site-chrome churn is reported above but is
// not a release, and treating it as one is what trained the alert into noise.
if (sigAdded.length || sigRemoved.length || sigChanged.length) {
  console.log(`\ncorpus change: +${sigAdded.length} -${sigRemoved.length} ~${sigChanged.length}`);
  for (const r of sigAdded)   console.log(`  + ${r.url}`);
  for (const r of sigRemoved) console.log(`  - ${r.url}`);
  for (const c of sigChanged) console.log(`  * ${c.url}`);
  process.exitCode = 2;
} else if (added.length || removed.length || changed.length) {
  console.log(`\nonly war.gov chrome changed (+${added.length} -${removed.length} ~${changed.length}) — not a release.`);
}
