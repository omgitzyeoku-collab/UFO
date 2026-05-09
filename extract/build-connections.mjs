// Build pairwise document similarity for the network visualisation.
// Two docs are connected if they share high-signal entities. Edge weight
// = sum of (1 / global frequency of each shared entity). This naturally
// down-weights noisy entities (AARO, USCENTCOM) and up-weights rare ones
// (specific person names, project codenames, case numbers).
//
// Output: extract/connections.jsonl with rows:
//   { kind:'node', sha256, agency, label, x?, y?, year, region, entity_count }
//   { kind:'edge', a, b, weight, shared:[<entity strings>] }

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const ENT = path.join(ROOT, 'extract', 'entities-normalised.jsonl');
const ENT_FALLBACK = path.join(ROOT, 'extract', 'entities.jsonl');
const QA = path.join(ROOT, 'extract', 'public');
const OUT = path.join(ROOT, 'extract', 'connections.jsonl');

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];

let entLines = [];
try { entLines = (await fs.readFile(ENT, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
catch { try { entLines = (await fs.readFile(ENT_FALLBACK, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {} }
const entsBySha = new Map();
for (const e of entLines) if (e.parsed && e.sha256) entsBySha.set(e.sha256, e.parsed);

console.log(`docs: ${docs.length}, with entities: ${entsBySha.size}`);

// Helper: a doc's high-signal entity tokens
const TYPES = ['places','projects','case_numbers','sensor_platforms','object_types','people','organisations'];
const STOP = new Set([
  'aaro','dow','fbi','nasa','dos','dod','department of war','department of state',
  'all-domain anomaly resolution office','federal bureau of investigation',
  'national aeronautics and space administration', 'unidentified', 'unidentified anomalous phenomena',
  'unknown', 'n/a', 'na', 'redacted', '?', '', 'us', 'united states',
]);
function entityTokens(sha256, agency, doc) {
  const tokens = new Set();
  // From extracted entities
  const e = entsBySha.get(sha256);
  if (e) {
    for (const t of TYPES) for (const v of (e[t] || [])) {
      const tok = (v || '').toLowerCase().trim();
      if (tok && tok.length > 2 && !STOP.has(tok)) tokens.add(`${t}:${tok}`);
    }
  }
  // From metadata too (always available)
  if (doc.incident_location && doc.incident_location !== 'N/A') {
    tokens.add(`location:${doc.incident_location.toLowerCase().trim()}`);
  }
  // Year bucket from incident_date
  if (doc.incident_date && doc.incident_date !== 'N/A') {
    const y = (doc.incident_date.match(/(\d{4})/) || doc.incident_date.match(/\/(\d{2})$/));
    if (y) {
      const year = y[0].length === 4 ? y[0] : ('20' + y[1]);
      tokens.add(`year:${year}`);
    }
  }
  return tokens;
}

const docTokens = new Map();
for (const d of docs) docTokens.set(d.sha256, entityTokens(d.sha256, d.agency, d));

// Global frequency per token (for IDF-like weighting)
const tokenFreq = new Map();
for (const tokens of docTokens.values()) for (const t of tokens) tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);

const N = docs.length;
function tokenWeight(tok) {
  const f = tokenFreq.get(tok) || 1;
  // IDF: log(N/f). Cap at 0 if extremely common.
  return Math.max(0, Math.log(N / f));
}

// Build node rows + edge rows
const rows = [];

// QA tier per doc (read public json files if present; cheap because there are <200)
const qaTier = new Map();
for (const d of docs) {
  const p = path.join(QA, d.sha256 + '.json');
  if (existsSync(p)) {
    try { const j = JSON.parse(await fs.readFile(p, 'utf8')); qaTier.set(d.sha256, j.tier); } catch {}
  }
}

for (const d of docs) {
  const yr = (d.incident_date || '').match(/(\d{4})/);
  rows.push({
    kind: 'node',
    id: d.sha256,
    sha256: d.sha256,
    label: d.title || d.name,
    agency: d.agency,
    type: d.type,
    year: yr ? parseInt(yr[1]) : null,
    region: d.incident_location && d.incident_location !== 'N/A' ? d.incident_location : null,
    entity_count: docTokens.get(d.sha256).size,
    tier: qaTier.get(d.sha256) || null,
  });
}

const edges = [];
const docIds = [...docTokens.keys()];
for (let i = 0; i < docIds.length; i++) {
  const a = docIds[i], aTokens = docTokens.get(a);
  for (let j = i + 1; j < docIds.length; j++) {
    const b = docIds[j], bTokens = docTokens.get(b);
    let weight = 0;
    const shared = [];
    for (const t of aTokens) {
      if (bTokens.has(t)) {
        const w = tokenWeight(t);
        if (w > 0) { weight += w; shared.push(t); }
      }
    }
    // Only keep edges with meaningful overlap
    if (weight >= 1.5 && shared.length >= 2) {
      edges.push({ kind: 'edge', a, b, weight: Math.round(weight * 100) / 100, shared });
    }
  }
}

console.log(`nodes: ${rows.length}, edges: ${edges.length}`);

// Distribution of edge weights for sanity
const weights = edges.map(e => e.weight).sort((a,b) => b - a);
console.log(`top 5 edge weights: ${weights.slice(0,5).map(w => w.toFixed(2)).join(', ')}`);
console.log(`median edge weight: ${weights[Math.floor(weights.length/2)]?.toFixed(2)}`);

// Top entities by frequency (for entity index)
const topEnts = [...tokenFreq.entries()].sort((a,b) => b[1] - a[1]).slice(0, 50);
console.log(`top 5 entities: ${topEnts.slice(0,5).map(([t,n]) => `${t}=${n}`).join(', ')}`);

await fs.writeFile(OUT, [...rows, ...edges].map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length + edges.length} rows to ${path.relative(ROOT, OUT)}`);
