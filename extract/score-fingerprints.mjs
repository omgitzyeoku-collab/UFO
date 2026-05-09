// Phase 3: 6-axis scoring fingerprint per document.
// Reads documents + pdf_text + captions + entities (if present).
// Writes extract/scores.jsonl: one row per doc with the 6 axes + composite.

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const DBPATH = path.join(ROOT, 'extract', 'graph.duckdb');
const ENT_NORM = path.join(ROOT, 'extract', 'entities-normalised.jsonl');
const ENTITIES = existsSync(ENT_NORM) ? ENT_NORM : path.join(ROOT, 'extract', 'entities.jsonl');
const OUT = path.join(ROOT, 'extract', 'scores.jsonl');

const inst = await DuckDBInstance.create(DBPATH, { access_mode: 'READ_ONLY' });
const conn = await inst.connect();

// Load entities
const ents = new Map();
try {
  const lines = (await fs.readFile(ENTITIES, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.sha256 && r.parsed) ents.set(r.sha256, r.parsed); }
} catch {}
console.log(`entities for ${ents.size} docs`);

// Load doc + text + caption metadata in one query
const r = await conn.run(`
  SELECT d.sha256, d.title, d.agency, d.bytes, d.incident_date, d.incident_location,
         p.text_quality, p.chars,
         c.redaction_blocks AS img_redactions, c.specificity_score AS img_spec
  FROM documents d
  LEFT JOIN pdf_text p ON d.sha256 = p.sha256
  LEFT JOIN captions c ON d.sha256 = c.sha256
`);
const docs = (await r.getRowObjects()).map(o => Object.fromEntries(Object.entries(o).map(([k,v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
console.log(`scoring ${docs.length} docs`);

// Build entity-cooccurrence index for novelty + corroboration
const docToEntities = new Map();
const entityToDocs = new Map();
for (const [sha, e] of ents) {
  const all = new Set();
  for (const t of ['people','places','organisations','projects','case_numbers','sensor_platforms','object_types']) {
    for (const v of (e[t] || [])) {
      const key = `${t}:${(v||'').toLowerCase().trim()}`;
      if (key.length < 5) continue;
      all.add(key);
      if (!entityToDocs.has(key)) entityToDocs.set(key, new Set());
      entityToDocs.get(key).add(sha);
    }
  }
  docToEntities.set(sha, all);
}

// Agency weight
const agencyWeight = { 'Department of War': 1.0, 'NASA': 0.9, 'Department of State': 0.85, 'FBI': 0.8 };

const scores = [];
for (const d of docs) {
  const e = ents.get(d.sha256);
  const docEnts = docToEntities.get(d.sha256) || new Set();

  // 1. SIGNIFICANCE: how many other docs share entities with this one
  let coDocs = new Set();
  for (const k of docEnts) {
    const others = entityToDocs.get(k) || new Set();
    for (const o of others) if (o !== d.sha256) coDocs.add(o);
  }
  const significance = Math.min(10, Math.round((coDocs.size / 5) * 10) / 10);

  // 2. NOVELTY: ratio of entities unique to this doc vs total entities
  let unique = 0, total = 0;
  for (const k of docEnts) {
    const sharedWith = (entityToDocs.get(k) || new Set()).size;
    total++;
    if (sharedWith === 1) unique++;
  }
  const novelty = total > 0 ? Math.round((unique / total) * 100) / 10 : 0;

  // 3. SPECIFICITY: count of concrete entities (people, dates, coords, case numbers)
  let specCount = 0;
  if (e) {
    specCount += (e.people || []).length;
    specCount += (e.dates || []).length;
    specCount += (e.coordinates || []).length * 2;
    specCount += (e.case_numbers || []).length * 1.5;
  }
  const specificity = Math.min(10, Math.round(specCount * 0.7 * 10) / 10);

  // 4. PROVENANCE: agency × text quality × has structured metadata
  const aw = agencyWeight[d.agency] || 0.7;
  const tw = d.text_quality === 'good' ? 1.0 : (d.text_quality === 'gibberish' ? 0.5 : 0.3);
  const mw = (d.incident_date && d.incident_date !== 'N/A') ? 1.0 : 0.7;
  const provenance = Math.round(aw * tw * mw * 100) / 10;

  // 5. REDACTION DENSITY: from entities (LLM-counted) or vision caption
  let redactions = 0;
  if (e?.redaction_count != null) redactions = e.redaction_count;
  else if (d.img_redactions != null) redactions = d.img_redactions;
  // Normalise per-doc — log scale
  const redaction_density = Math.min(10, Math.round(Math.log2(redactions + 1) * 2 * 10) / 10);

  // 6. CORROBORATION: number of OTHER docs sharing rare entities (rare = appearing in <5 docs)
  let corrob = 0;
  for (const k of docEnts) {
    const sharing = entityToDocs.get(k) || new Set();
    if (sharing.size > 1 && sharing.size <= 5) corrob++;
  }
  const corroboration = Math.min(10, Math.round(corrob * 0.5 * 10) / 10);

  scores.push({
    sha256: d.sha256,
    title: d.title,
    agency: d.agency,
    significance, novelty, specificity, provenance, redaction_density, corroboration,
    composite: Math.round((significance + novelty + specificity + provenance + redaction_density + corroboration) / 6 * 10) / 10,
    has_entities: !!e,
    entities_total: total,
    entities_unique: unique,
    co_docs: coDocs.size,
  });
}

await fs.writeFile(OUT, scores.map(s => JSON.stringify(s)).join('\n') + '\n');

// Print top 10 by composite
scores.sort((a,b) => b.composite - a.composite);
console.log('\n=== top 10 by composite score ===');
console.log('comp  sig nov spc prv red cor  agency           title');
for (const s of scores.slice(0, 10)) {
  const f = (n) => n.toFixed(1).padStart(4);
  console.log(`${f(s.composite)} ${f(s.significance)} ${f(s.novelty)} ${f(s.specificity)} ${f(s.provenance)} ${f(s.redaction_density)} ${f(s.corroboration)}  ${(s.agency||'?').padEnd(16)} ${(s.title||'').slice(0,60)}`);
}

await conn.disconnectSync();
console.log(`\nwrote ${scores.length} score records to ${OUT}`);
