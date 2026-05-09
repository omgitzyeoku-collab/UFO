// Phase 2b: entity normalisation. Read entities.jsonl, dedupe similar
// strings (Lt. Cmdr. Fravor / David Fravor / DAVID FRAVOR → one entity).
// Strategy: per-type bucketing then Levenshtein-distance clustering with
// a normalised-form canonical name. Output: extract/entities-normalised.jsonl.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const IN = path.join(ROOT, 'extract', 'entities.jsonl');
const OUT = path.join(ROOT, 'extract', 'entities-normalised.jsonl');
const ENT_INDEX = path.join(ROOT, 'extract', 'entity-index.jsonl');

const lines = (await fs.readFile(IN, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
console.log(`docs: ${lines.length}`);

// Levenshtein distance, capped at threshold for early-exit
function levDist(a, b, max = 5) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      curr[j] = Math.min(curr[j-1] + 1, prev[j] + 1, prev[j-1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

function norm(s) {
  return (s || '').toLowerCase().trim()
    .replace(/^(mr|ms|mrs|dr|lt|lt\.|cmdr|cmdr\.|sgt|maj|capt|cpl|col|gen|adm|adm\.|sec|secy|sec\.|pres|sen|rep)\b\.?\s+/i, '')
    .replace(/[.,'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stop list — tokens that aren't useful entities
const STOP = new Set(['unknown', 'unknown.', '?', 'n/a', 'na', 'none', 'redacted', '[redacted]', 'redacted_redacted', '']);

// Collect all (type, value) pairs across the corpus
const buckets = {};  // type -> [{ raw, norm, sha256 }]
for (const r of lines) {
  if (!r.parsed || !r.sha256) continue;
  for (const t of ['people','organisations','places','projects','case_numbers','sensor_platforms','object_types','classifications']) {
    for (const v of (r.parsed[t] || [])) {
      const n = norm(v);
      if (STOP.has(n) || n.length < 2) continue;
      if (!buckets[t]) buckets[t] = [];
      buckets[t].push({ raw: v, norm: n, sha256: r.sha256 });
    }
  }
}

console.log('raw entity counts by type:');
for (const [t, arr] of Object.entries(buckets)) console.log(`  ${t.padEnd(20)} ${arr.length}`);

// Per-type clustering. For each bucket: sort by frequency, then for each entry
// check if it's within Lev-distance threshold of any existing canonical entry.
// Canonical form = the most-frequent raw spelling within the cluster.
const clusters = {};  // type -> Map<canonicalNorm, { canonical, variants:Set<string>, docs:Set<string> }>

for (const [t, arr] of Object.entries(buckets)) {
  const freq = new Map();
  for (const e of arr) {
    if (!freq.has(e.norm)) freq.set(e.norm, { count: 0, raws: new Map(), docs: new Set() });
    const f = freq.get(e.norm);
    f.count++;
    f.raws.set(e.raw, (f.raws.get(e.raw) || 0) + 1);
    f.docs.add(e.sha256);
  }
  // Sort norms by frequency desc — most-frequent becomes seed for clustering
  const sortedNorms = [...freq.entries()].sort((a,b) => b[1].count - a[1].count);
  clusters[t] = new Map();
  for (const [n, info] of sortedNorms) {
    // Find existing cluster within Lev-distance 2 (or 3 for longer strings)
    let assigned = false;
    const threshold = n.length > 12 ? 3 : 2;
    for (const [canonNorm, cluster] of clusters[t]) {
      if (levDist(n, canonNorm, threshold) <= threshold) {
        // merge into existing cluster
        for (const [raw, c] of info.raws) cluster.variants.add(raw);
        for (const d of info.docs) cluster.docs.add(d);
        assigned = true; break;
      }
    }
    if (!assigned) {
      // canonical = most-common raw form in this cluster
      const canonical = [...info.raws.entries()].sort((a,b) => b[1] - a[1])[0][0];
      const variants = new Set([...info.raws.keys()]);
      clusters[t].set(n, { canonical, variants, docs: info.docs });
    }
  }
}

console.log('\nclusters by type:');
for (const [t, m] of Object.entries(clusters)) console.log(`  ${t.padEnd(20)} ${m.size} (was ${buckets[t].length} raw)`);

// Write entity index — per-type list of canonical entities + their variants + docs
const indexRows = [];
for (const [t, m] of Object.entries(clusters)) {
  for (const [norm, c] of m) {
    indexRows.push({
      type: t, canonical: c.canonical, norm,
      variants: [...c.variants], docs: [...c.docs],
      doc_count: c.docs.size,
    });
  }
}
indexRows.sort((a,b) => b.doc_count - a.doc_count);
await fs.writeFile(ENT_INDEX, indexRows.map(r => JSON.stringify(r)).join('\n') + '\n');

// Re-emit normalised per-doc records
const docToEntities = new Map();  // sha256 -> { type -> Set<canonical> }
for (const [t, m] of Object.entries(clusters)) {
  for (const c of m.values()) {
    for (const sha of c.docs) {
      if (!docToEntities.has(sha)) docToEntities.set(sha, {});
      if (!docToEntities.get(sha)[t]) docToEntities.get(sha)[t] = new Set();
      docToEntities.get(sha)[t].add(c.canonical);
    }
  }
}

const normalisedRows = [];
for (const r of lines) {
  if (!r.parsed || !r.sha256) continue;
  const ents = docToEntities.get(r.sha256) || {};
  const out = { sha256: r.sha256, title: r.title, agency: r.agency, parsed: { ...r.parsed } };
  for (const [t, set] of Object.entries(ents)) out.parsed[t] = [...set];
  normalisedRows.push(out);
}
await fs.writeFile(OUT, normalisedRows.map(r => JSON.stringify(r)).join('\n') + '\n');

console.log(`\ntop entities by doc count:`);
for (const r of indexRows.slice(0, 20)) {
  console.log(`  [${r.type.padEnd(18)}] ${r.canonical.padEnd(40)} (${r.doc_count} docs, ${r.variants.length} variants)`);
}
console.log(`\nwrote ${normalisedRows.length} normalised doc entities to ${path.relative(ROOT, OUT)}`);
console.log(`wrote ${indexRows.length} canonical entities to ${path.relative(ROOT, ENT_INDEX)}`);
