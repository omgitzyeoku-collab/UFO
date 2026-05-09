// Build a DuckDB entity graph from derived-all.jsonl + captions.jsonl + extract/text/.
// Tables:
//   documents     one row per artefact (any source)
//   captions      vision-extracted summary per image doc (where available)
//   pdf_text      text extracted from PDFs (FTS-indexed)
//   entities      deduped (type, value)
//   doc_entity    many-to-many

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DERIVED_ALL = path.join(ROOT, 'extract', 'derived-all.jsonl');
const DERIVED     = path.join(ROOT, 'extract', 'derived.jsonl');
const CAPTIONS    = path.join(ROOT, 'extract', 'captions.jsonl');
const TEXT_DIR    = path.join(ROOT, 'extract', 'text');
const DBPATH      = path.join(ROOT, 'extract', 'graph.duckdb');

async function loadJsonl(p) {
  return (await fs.readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const derivedSrc = await fs.stat(DERIVED_ALL).then(() => DERIVED_ALL).catch(() => DERIVED);
console.log(`derived source: ${path.relative(ROOT, derivedSrc)}`);
const derived = await loadJsonl(derivedSrc);
let captionsRaw = [];
try { captionsRaw = await loadJsonl(CAPTIONS); } catch {}
const captionsBySha = new Map();
for (const c of captionsRaw) if (c.parsed && c.sha256) captionsBySha.set(c.sha256, c.parsed);
console.log(`derived: ${derived.length} | captions: ${captionsBySha.size}`);

try { await fs.unlink(DBPATH); } catch {}
const inst = await DuckDBInstance.create(DBPATH);
const conn = await inst.connect();

await conn.run(`
  CREATE TABLE documents (
    sha256        VARCHAR PRIMARY KEY,
    url           VARCHAR,
    agency        VARCHAR,
    kind          VARCHAR,
    doc_id        VARCHAR,
    doc_type      VARCHAR,
    region        VARCHAR,
    date_str      VARCHAR,
    bytes         INTEGER,
    blob_path     VARCHAR,
    content_type  VARCHAR,
    has_text      BOOLEAN,
    crawl_id      VARCHAR
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
  CREATE TABLE pdf_text (
    sha256       VARCHAR PRIMARY KEY,
    bytes        INTEGER,
    text         VARCHAR
  );
`);

await conn.run(`
  CREATE TABLE entities (
    entity_id   INTEGER PRIMARY KEY,
    type        VARCHAR,
    value       VARCHAR,
    norm        VARCHAR,
    UNIQUE(type, norm)
  );
`);

await conn.run(`
  CREATE TABLE doc_entity (
    sha256      VARCHAR,
    entity_id   INTEGER,
    PRIMARY KEY (sha256, entity_id)
  );
`);

const bindStr = (stmt, i, v) => v == null ? stmt.bindNull(i) : stmt.bindVarchar(i, String(v));
const bindInt = (stmt, i, v) => v == null ? stmt.bindNull(i) : stmt.bindInteger(i, Number(v));
const bindBool = (stmt, i, v) => stmt.bindBoolean(i, !!v);

// Insert documents
const insertDoc = await conn.prepare(`
  INSERT INTO documents (sha256, url, agency, kind, doc_id, doc_type, region, date_str, bytes, blob_path, content_type, has_text, crawl_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`);
for (const d of derived) {
  bindStr(insertDoc, 1, d.sha256);
  bindStr(insertDoc, 2, d.url);
  bindStr(insertDoc, 3, d.agency);
  bindStr(insertDoc, 4, d.kind);
  bindStr(insertDoc, 5, d.doc_id);
  bindStr(insertDoc, 6, d.doc_type);
  bindStr(insertDoc, 7, d.region);
  bindStr(insertDoc, 8, d.date_str);
  bindInt(insertDoc, 9, d.bytes ?? 0);
  bindStr(insertDoc, 10, d.blob_path);
  bindStr(insertDoc, 11, d.content_type);
  bindBool(insertDoc, 12, d.has_text);
  bindStr(insertDoc, 13, d.first_seen_crawl);
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

// Insert PDF text bodies
const insertText = await conn.prepare(`INSERT INTO pdf_text VALUES ($1, $2, $3)`);
let textCount = 0;
for (const d of derived) {
  if (!d.has_text) continue;
  try {
    const body = await fs.readFile(path.join(TEXT_DIR, `${d.sha256}.txt`), 'utf8');
    bindStr(insertText, 1, d.sha256);
    bindInt(insertText, 2, body.length);
    bindStr(insertText, 3, body.slice(0, 500_000));  // cap at 500KB per row to keep DB lean
    await insertText.run();
    textCount++;
  } catch {}
}

// Entities
const insertEntity = await conn.prepare(`INSERT INTO entities VALUES ($1, $2, $3, $4)`);
const insertLink   = await conn.prepare(`INSERT OR IGNORE INTO doc_entity VALUES ($1, $2)`);

const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const entityIdByKey = new Map();
let nextId = 1;

async function upsertEntity(type, value) {
  const n = norm(value);
  if (!n) return null;
  const k = `${type}::${n}`;
  if (entityIdByKey.has(k)) return entityIdByKey.get(k);
  const id = nextId++;
  insertEntity.bindInteger(1, id);
  insertEntity.bindVarchar(2, type);
  insertEntity.bindVarchar(3, String(value).slice(0, 1000));
  insertEntity.bindVarchar(4, n.slice(0, 1000));
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
  if (d.agency)  await linkDocEntity(d.sha256, 'agency', d.agency);
  if (d.region)  await linkDocEntity(d.sha256, 'place', d.region);
  if (d.date_str) await linkDocEntity(d.sha256, 'date', d.date_str);
  const c = captionsBySha.get(d.sha256);
  if (!c) continue;
  for (const p of (c.people || []))             await linkDocEntity(d.sha256, 'person',   p);
  for (const p of (c.places || []))             await linkDocEntity(d.sha256, 'place',    p);
  for (const p of (c.dates_seen || []))         await linkDocEntity(d.sha256, 'date',     p);
  for (const p of (c.agency_markings || []))    await linkDocEntity(d.sha256, 'agency',   p);
  for (const p of (c.objects_described || []))  await linkDocEntity(d.sha256, 'object',   p);
  for (const p of (c.novelty_signals || []))    await linkDocEntity(d.sha256, 'novelty',  p);
}

const counts = (await (await conn.run(`
  SELECT
    (SELECT COUNT(*) FROM documents)  AS docs,
    (SELECT COUNT(*) FROM captions)   AS caps,
    (SELECT COUNT(*) FROM pdf_text)   AS texts,
    (SELECT COUNT(*) FROM entities)   AS ents,
    (SELECT COUNT(*) FROM doc_entity) AS links
`)).getRowObjects())[0];
const fix = (o) => Object.fromEntries(Object.entries(o).map(([k,v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
console.log('\nbuilt graph:');
console.log(JSON.stringify(fix(counts), null, 2));

await conn.disconnectSync();
console.log(`\nwrote: ${path.relative(ROOT, DBPATH)}`);
