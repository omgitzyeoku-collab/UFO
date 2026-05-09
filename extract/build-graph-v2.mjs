// Phase 1: DuckDB graph build, war.gov/UFO/ corpus only.
// Reads release-manifest.jsonl (116 records, sha256 + release URL + CSV
// metadata) plus pdf_text from extract/text/, plus captions from
// extract/captions.jsonl. Builds an FTS-indexed pdf_text table.

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const CAPS = path.join(ROOT, 'extract', 'captions.jsonl');
const DBPATH = path.join(ROOT, 'extract', 'graph.duckdb');

const allRecords = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
// Dedupe by sha256 — multiple CSV records can point to the same PDF blob.
// Keep the first occurrence and join titles into a comma-separated alias list.
const recordsMap = new Map();
for (const r of allRecords) {
  if (recordsMap.has(r.sha256)) {
    const existing = recordsMap.get(r.sha256);
    if (r.title && !existing.title?.includes(r.title)) {
      existing.aliases = (existing.aliases || []).concat(r.title);
    }
  } else {
    recordsMap.set(r.sha256, { ...r, aliases: [] });
  }
}
const records = [...recordsMap.values()];
console.log(`raw records: ${allRecords.length}, deduped by sha256: ${records.length}`);
let captionsBySha = new Map();
try {
  const lines = (await fs.readFile(CAPS, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const c of lines) if (c.parsed && c.sha256) captionsBySha.set(c.sha256, c.parsed);
} catch {}
console.log(`records: ${records.length} | captions: ${captionsBySha.size}`);

try { await fs.unlink(DBPATH); } catch {}
const inst = await DuckDBInstance.create(DBPATH);
const conn = await inst.connect();
await conn.run('INSTALL fts; LOAD fts;');

await conn.run(`
  CREATE TABLE documents (
    sha256              VARCHAR PRIMARY KEY,
    name                VARCHAR,
    title               VARCHAR,
    agency              VARCHAR,
    type                VARCHAR,
    incident_date       VARCHAR,
    incident_location   VARCHAR,
    description         VARCHAR,
    release_date        VARCHAR,
    bytes               INTEGER,
    source_url          VARCHAR,
    release_url         VARCHAR,
    blob_path           VARCHAR,
    has_text            BOOLEAN
  );
`);

await conn.run(`
  CREATE TABLE pdf_text (
    sha256       VARCHAR PRIMARY KEY,
    chars        INTEGER,
    text_quality VARCHAR,    -- 'good' | 'gibberish' | 'missing'
    body         VARCHAR
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
    confidence  DOUBLE,
    PRIMARY KEY (sha256, entity_id)
  );
`);

const bindStr = (s, i, v) => v == null ? s.bindNull(i) : s.bindVarchar(i, String(v));
const bindInt = (s, i, v) => v == null ? s.bindNull(i) : s.bindInteger(i, Number(v));
const bindBool = (s, i, v) => s.bindBoolean(i, !!v);
const bindDbl = (s, i, v) => v == null ? s.bindNull(i) : s.bindDouble(i, Number(v));

const insertDoc = await conn.prepare(`
  INSERT INTO documents
  (sha256, name, title, agency, type, incident_date, incident_location, description, release_date, bytes, source_url, release_url, blob_path, has_text)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
`);

const insertText = await conn.prepare(`
  INSERT INTO pdf_text (sha256, chars, text_quality, body) VALUES ($1, $2, $3, $4)
`);

let goodText = 0, gibberish = 0, noText = 0;
for (const r of records) {
  // text quality assessment
  const txtPath = path.join(TEXT_DIR, r.sha256 + '.txt');
  let body = null, quality = 'missing', chars = 0;
  if (existsSync(txtPath)) {
    body = await fs.readFile(txtPath, 'utf8');
    chars = body.length;
    const sample = body.slice(0, 5000);
    const printable = (sample.match(/[a-zA-Z0-9 .,;:!?'"()\-\n]/g) || []).length;
    const ratio = sample.length > 0 ? printable / sample.length : 0;
    quality = (chars < 300 || ratio < 0.4) ? 'gibberish' : 'good';
  }
  if (quality === 'good') goodText++;
  else if (quality === 'gibberish') gibberish++;
  else noText++;

  bindStr(insertDoc, 1, r.sha256);
  bindStr(insertDoc, 2, r.name);
  bindStr(insertDoc, 3, r.title);
  bindStr(insertDoc, 4, r.agency);
  bindStr(insertDoc, 5, r.type);
  bindStr(insertDoc, 6, r.incident_date);
  bindStr(insertDoc, 7, r.incident_location);
  bindStr(insertDoc, 8, r.description);
  bindStr(insertDoc, 9, r.release_date);
  bindInt(insertDoc, 10, r.bytes);
  bindStr(insertDoc, 11, r.url);
  bindStr(insertDoc, 12, r.release_url);
  bindStr(insertDoc, 13, r.blob_path);
  bindBool(insertDoc, 14, quality === 'good');
  await insertDoc.run();

  bindStr(insertText, 1, r.sha256);
  bindInt(insertText, 2, chars);
  bindStr(insertText, 3, quality);
  bindStr(insertText, 4, body ? body.slice(0, 1_000_000) : '');
  await insertText.run();
}

// Captions for image-having records — we have captions for the war.gov/UFO/ thumbnails
const insertCap = await conn.prepare(`
  INSERT OR REPLACE INTO captions (sha256, what_is_it, headline, ocr_text, redaction_blocks, specificity_score, notes)
  VALUES ($1,$2,$3,$4,$5,$6,$7)
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

// Build FTS index on pdf_text.body + on documents.title+description
console.log('building FTS index...');
await conn.run(`PRAGMA create_fts_index('pdf_text', 'sha256', 'body', stemmer='english', stopwords='english', overwrite=1);`);
await conn.run(`PRAGMA create_fts_index('documents', 'sha256', 'title', 'description', 'incident_location', stemmer='english', stopwords='english', overwrite=1);`);

const fix = (o) => Object.fromEntries(Object.entries(o).map(([k,v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
const counts = (await (await conn.run(`
  SELECT
    (SELECT COUNT(*) FROM documents) AS docs,
    (SELECT COUNT(*) FROM pdf_text WHERE text_quality='good') AS good_text,
    (SELECT COUNT(*) FROM pdf_text WHERE text_quality='gibberish') AS gibberish,
    (SELECT COUNT(*) FROM pdf_text WHERE text_quality='missing') AS no_text,
    (SELECT COUNT(*) FROM captions) AS captions
`)).getRowObjects())[0];
console.log(JSON.stringify(fix(counts), null, 2));

const byAgency = (await (await conn.run(`SELECT agency, COUNT(*) AS n FROM documents GROUP BY agency ORDER BY n DESC`)).getRowObjects()).map(fix);
console.log('\nby agency:');
for (const r of byAgency) console.log(`  ${(r.agency||'?').padEnd(25)} ${r.n}`);

await conn.disconnectSync();
console.log(`\nwrote: ${path.relative(ROOT, DBPATH)}`);
console.log('FTS indexes built. Use query.mjs to search.');
