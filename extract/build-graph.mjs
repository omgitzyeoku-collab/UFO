// Build a DuckDB entity graph from derived.jsonl + captions.jsonl.
// Tables:
//   documents      one row per blob — agency, region, date, etc.
//   captions       vision-extracted summary per doc
//   entities       deduped (type, value) across the corpus
//   doc_entity     many-to-many between documents and entities
//
// Output: extract/graph.duckdb

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DERIVED  = path.join(ROOT, 'extract', 'derived.jsonl');
const CAPTIONS = path.join(ROOT, 'extract', 'captions.jsonl');
const DBPATH   = path.join(ROOT, 'extract', 'graph.duckdb');

async function loadJsonl(p) {
  return (await fs.readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const [derived, captionsRaw] = await Promise.all([loadJsonl(DERIVED), loadJsonl(CAPTIONS)]);
const captionsBySha = new Map();
for (const c of captionsRaw) if (c.parsed && c.sha256) captionsBySha.set(c.sha256, c.parsed);

console.log(`derived: ${derived.length} | captions parsed: ${captionsBySha.size}`);

// Fresh DB each build — graph is derivable, not authoritative
try { await fs.unlink(DBPATH); } catch {}
const inst = await DuckDBInstance.create(DBPATH);
const conn = await inst.connect();

await conn.run(`
  CREATE TABLE documents (
    sha256        VARCHAR PRIMARY KEY,
    name          VARCHAR,
    agency        VARCHAR,
    doc_id        VARCHAR,
    doc_type      VARCHAR,
    region        VARCHAR,
    date_str      VARCHAR,
    date_iso      DATE,
    kind          VARCHAR,
    bytes         INTEGER,
    blob_path     VARCHAR,
    source_url    VARCHAR
  );
`);

await conn.run(`
  CREATE TABLE captions (
    sha256              VARCHAR PRIMARY KEY,
    what_is_it          VARCHAR,
    headline            VARCHAR,
    ocr_text            VARCHAR,
    redaction_blocks    INTEGER,
    specificity_score   INTEGER,
    notes               VARCHAR
  );
`);

await conn.run(`
  CREATE TABLE entities (
    entity_id     INTEGER PRIMARY KEY,
    type          VARCHAR,        -- person|place|date|agency|object|novelty
    value         VARCHAR,
    norm          VARCHAR,        -- lowercased trimmed canonical form
    UNIQUE(type, norm)
  );
`);

await conn.run(`
  CREATE TABLE doc_entity (
    sha256       VARCHAR,
    entity_id    INTEGER,
    PRIMARY KEY (sha256, entity_id)
  );
`);

// Insert documents
const bindStr = (stmt, i, v) => v == null ? stmt.bindNull(i) : stmt.bindVarchar(i, String(v));
const bindInt = (stmt, i, v) => v == null ? stmt.bindNull(i) : stmt.bindInteger(i, Number(v));

const insertDoc = await conn.prepare(`
  INSERT INTO documents (sha256, name, agency, doc_id, doc_type, region, date_str, date_iso, kind, bytes, blob_path, source_url)
  VALUES ($1, $2, $3, $4, $5, $6, $7, CAST($8 AS DATE), $9, $10, $11, $12)
`);
for (const d of derived) {
  bindStr(insertDoc, 1, d.sha256);
  bindStr(insertDoc, 2, d.name);
  bindStr(insertDoc, 3, d.agency);
  bindStr(insertDoc, 4, d.doc_id);
  bindStr(insertDoc, 5, d.doc_type);
  bindStr(insertDoc, 6, d.region);
  bindStr(insertDoc, 7, d.date_str);
  bindStr(insertDoc, 8, d.date_iso);
  bindStr(insertDoc, 9, d.kind);
  bindInt(insertDoc, 10, d.bytes ?? 0);
  bindStr(insertDoc, 11, d.blob_path);
  bindStr(insertDoc, 12, d.source_url);
  await insertDoc.run();
}

// Insert captions
const insertCap = await conn.prepare(`
  INSERT INTO captions (sha256, what_is_it, headline, ocr_text, redaction_blocks, specificity_score, notes)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`);
for (const [sha, c] of captionsBySha) {
  bindStr(insertCap, 1, sha);
  bindStr(insertCap, 2, c.what_is_it || '');
  bindStr(insertCap, 3, c.headline || '');
  bindStr(insertCap, 4, c.ocr_text || '');
  bindInt(insertCap, 5, c.redaction_blocks ?? 0);
  bindInt(insertCap, 6, c.specificity_score ?? 0);
  bindStr(insertCap, 7, c.notes || '');
  await insertCap.run();
}

// Insert entities + doc_entity
const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const entityIdByKey = new Map();
let nextId = 1;

const insertEntity = await conn.prepare(`INSERT INTO entities VALUES ($1, $2, $3, $4)`);
const insertLink   = await conn.prepare(`INSERT OR IGNORE INTO doc_entity VALUES ($1, $2)`);

async function upsertEntity(type, value) {
  const n = norm(value);
  if (!n) return null;
  const k = `${type}::${n}`;
  if (entityIdByKey.has(k)) return entityIdByKey.get(k);
  const id = nextId++;
  insertEntity.bindInteger(1, id);
  insertEntity.bindVarchar(2, type);
  insertEntity.bindVarchar(3, String(value));
  insertEntity.bindVarchar(4, n);
  await insertEntity.run();
  entityIdByKey.set(k, id);
  return id;
}

async function linkDocEntity(sha, type, value) {
  const id = await upsertEntity(type, value);
  if (id == null) return;
  insertLink.bindVarchar(1, sha);
  insertLink.bindInteger(2, id);
  await insertLink.run();
}

for (const d of derived) {
  // From derived: agency, region, doc_id are entities too
  if (d.agency) await linkDocEntity(d.sha256, 'agency', d.agency);
  if (d.region) await linkDocEntity(d.sha256, 'place',  d.region);
  if (d.date_iso) await linkDocEntity(d.sha256, 'date',  d.date_iso);
  // Vision-extracted entities
  const c = captionsBySha.get(d.sha256);
  if (!c) continue;
  for (const p of (c.people || []))             await linkDocEntity(d.sha256, 'person',   p);
  for (const p of (c.places || []))             await linkDocEntity(d.sha256, 'place',    p);
  for (const p of (c.dates_seen || []))         await linkDocEntity(d.sha256, 'date',     p);
  for (const p of (c.agency_markings || []))    await linkDocEntity(d.sha256, 'agency',   p);
  for (const p of (c.objects_described || []))  await linkDocEntity(d.sha256, 'object',   p);
  for (const p of (c.novelty_signals || []))    await linkDocEntity(d.sha256, 'novelty',  p);
}

// Summary
const row = async (q) => {
  const r = await conn.run(q);
  const rows = await r.getRowObjects();
  return rows;
};
const counts = await row(`
  SELECT
    (SELECT COUNT(*) FROM documents)   AS docs,
    (SELECT COUNT(*) FROM captions)    AS caps,
    (SELECT COUNT(*) FROM entities)    AS ents,
    (SELECT COUNT(*) FROM doc_entity)  AS links
`);
console.log('\nbuilt graph:');
console.log(JSON.stringify(counts[0], (k, v) => typeof v === 'bigint' ? Number(v) : v, 2));

const byType = await row(`SELECT type, COUNT(*) AS n FROM entities GROUP BY type ORDER BY n DESC`);
console.log('\nentity types:');
for (const r of byType) console.log(`  ${r.type.padEnd(10)} ${r.n}`);

await conn.disconnectSync();
console.log(`\nwrote: ${path.relative(ROOT, DBPATH)}`);
