// Generate an analytical report from the DuckDB graph.
// Prints to stdout and saves to docs/report.md for git history.

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DBPATH = path.join(ROOT, 'extract', 'graph.duckdb');
const OUT    = path.join(ROOT, 'docs', 'report.md');

const inst = await DuckDBInstance.create(DBPATH);
const conn = await inst.connect();

const rows = async (sql, params) => {
  const r = params ? await conn.run(sql, params) : await conn.run(sql);
  const o = await r.getRowObjects();
  return o.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
    return out;
  });
};

const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };

const now = new Date().toISOString();
log(`# UFO Archive — analytical report`);
log(``);
log(`Generated: ${now}`);
log(`Source: war.gov/UFO/ (PURSUE, 2026-05-08)`);
log(``);

// 1. Corpus headline
const counts = (await rows(`
  SELECT
    (SELECT COUNT(*) FROM documents)  AS docs,
    (SELECT COUNT(*) FROM captions)   AS caps,
    (SELECT COUNT(*) FROM entities)   AS ents,
    (SELECT COUNT(*) FROM doc_entity) AS links,
    (SELECT SUM(bytes) FROM documents) AS total_bytes
`))[0];
log(`## Corpus`);
log(``);
log(`- Documents: **${counts.docs}**`);
log(`- Captions:  ${counts.caps}`);
log(`- Entities:  ${counts.ents}`);
log(`- Links:     ${counts.links}`);
log(`- Bytes:     ${(counts.total_bytes / 1024 / 1024).toFixed(2)} MB`);
log(``);

// 2. By agency
const byAgency = await rows(`
  SELECT agency, COUNT(*) AS n, SUM(bytes) AS total_bytes
  FROM documents WHERE agency IS NOT NULL
  GROUP BY agency ORDER BY n DESC
`);
log(`## By agency`);
log(``);
log(`| Agency | Docs | Bytes |`);
log(`|--------|------|-------|`);
for (const r of byAgency) {
  log(`| ${r.agency} | ${r.n} | ${(r.total_bytes / 1024 / 1024).toFixed(2)} MB |`);
}
log(``);

// 3. By region
const byRegion = await rows(`
  SELECT region, COUNT(*) AS n
  FROM documents WHERE region IS NOT NULL
  GROUP BY region ORDER BY n DESC, region
`);
log(`## By region`);
log(``);
log(`| Region | Docs |`);
log(`|--------|------|`);
for (const r of byRegion) log(`| ${r.region} | ${r.n} |`);
log(``);

// 4. By kind / what_is_it from captions
const byWhat = await rows(`
  SELECT what_is_it, COUNT(*) AS n
  FROM captions GROUP BY what_is_it ORDER BY n DESC
`);
log(`## By visual type (vision-classified)`);
log(``);
log(`| Type | Docs |`);
log(`|------|------|`);
for (const r of byWhat) log(`| ${r.what_is_it || '(empty)'} | ${r.n} |`);
log(``);

// 5. Redaction density
const redaction = await rows(`
  SELECT
    COUNT(*) AS docs,
    AVG(redaction_blocks) AS avg_redactions,
    MIN(redaction_blocks) AS min_redactions,
    MAX(redaction_blocks) AS max_redactions,
    SUM(CASE WHEN redaction_blocks >= 8 THEN 1 ELSE 0 END) AS heavy_count,
    SUM(CASE WHEN redaction_blocks = 0 THEN 1 ELSE 0 END) AS no_redaction_count
  FROM captions
`);
const r = redaction[0];
log(`## Redaction density`);
log(``);
log(`- Docs analysed: ${r.docs}`);
log(`- Avg redaction blocks per frame: **${Number(r.avg_redactions).toFixed(2)}**`);
log(`- Range: ${r.min_redactions}–${r.max_redactions}`);
log(`- Heavy (≥8 blocks): ${r.heavy_count}`);
log(`- No redaction: ${r.no_redaction_count}`);
log(``);

// 6. Heaviest-redacted documents (top 5)
const heaviest = await rows(`
  SELECT d.name, d.region, d.date_str, c.redaction_blocks, c.headline
  FROM captions c JOIN documents d USING (sha256)
  ORDER BY c.redaction_blocks DESC LIMIT 5
`);
log(`### Heaviest-redacted (top 5)`);
log(``);
for (const r of heaviest) {
  log(`- **${r.redaction_blocks} blocks** · ${r.region || '—'} · ${r.date_str || '—'}`);
  log(`  *${r.headline}*`);
}
log(``);

// 7. Top recurring objects across the corpus (mentioned in ≥2 docs)
const recurring = await rows(`
  SELECT e.value, COUNT(DISTINCT de.sha256) AS doc_count
  FROM entities e JOIN doc_entity de ON e.entity_id = de.entity_id
  WHERE e.type = 'object'
  GROUP BY e.value
  HAVING COUNT(DISTINCT de.sha256) >= 2
  ORDER BY doc_count DESC, e.value
  LIMIT 20
`);
log(`## Recurring objects (in ≥2 docs)`);
log(``);
if (!recurring.length) log(`(no exact-string matches across docs — entity normalisation is naive; semantic clustering would catch more)`);
else {
  log(`| Object | Docs |`);
  log(`|--------|------|`);
  for (const r of recurring) log(`| ${r.value} | ${r.doc_count} |`);
}
log(``);

// 8. Recurring object STEMS using LIKE patterns (catches "FLIR/infrared..." vs "infrared/FLIR...")
const flirCount = (await rows(`
  SELECT COUNT(DISTINCT de.sha256) AS n
  FROM entities e JOIN doc_entity de ON e.entity_id = de.entity_id
  WHERE e.type = 'object' AND (LOWER(e.value) LIKE '%flir%' OR LOWER(e.value) LIKE '%infrared%')
`))[0].n;
const reticleCount = (await rows(`
  SELECT COUNT(DISTINCT de.sha256) AS n
  FROM entities e JOIN doc_entity de ON e.entity_id = de.entity_id
  WHERE e.type = 'object' AND (LOWER(e.value) LIKE '%reticle%' OR LOWER(e.value) LIKE '%crosshair%')
`))[0].n;
const cigarCount = (await rows(`
  SELECT COUNT(DISTINCT de.sha256) AS n
  FROM entities e JOIN doc_entity de ON e.entity_id = de.entity_id
  WHERE e.type = 'object' AND (LOWER(e.value) LIKE '%cigar%' OR LOWER(e.value) LIKE '%tic-tac%' OR LOWER(e.value) LIKE '%tic tac%' OR LOWER(e.value) LIKE '%elongated%')
`))[0].n;
log(`### Pattern matches (substring)`);
log(``);
log(`- FLIR/infrared sensor present: **${flirCount}** of ${counts.docs} docs`);
log(`- Targeting reticle/crosshair:  **${reticleCount}**`);
log(`- Cigar/tic-tac/elongated obj:  **${cigarCount}**`);
log(``);

// 9. Specificity score distribution
const spec = await rows(`
  SELECT specificity_score, COUNT(*) AS n
  FROM captions GROUP BY specificity_score ORDER BY specificity_score
`);
log(`## Specificity score distribution`);
log(``);
log(`(0–10; how many concrete names/dates/coords are visible)`);
log(``);
log(`| Score | Docs |`);
log(`|-------|------|`);
for (const r of spec) log(`| ${r.specificity_score} | ${r.n} |`);
log(``);

// 10. Distinctive novelty signals (each unique to one doc)
const novelty = await rows(`
  SELECT e.value, d.name, d.region, d.date_str
  FROM entities e
  JOIN doc_entity de ON e.entity_id = de.entity_id
  JOIN documents d ON de.sha256 = d.sha256
  WHERE e.type = 'novelty'
  ORDER BY d.region NULLS LAST, d.date_str
  LIMIT 20
`);
log(`## Notable novelty signals (sample)`);
log(``);
for (const r of novelty) {
  log(`- **${r.region || r.name}** (${r.date_str || '—'}): ${r.value.slice(0, 200)}`);
}
log(``);

// 11. Cross-region: any region with multiple distinct dates
const multiDate = await rows(`
  SELECT region, COUNT(DISTINCT date_iso) AS distinct_dates,
         STRING_AGG(DISTINCT date_iso, ', ') AS dates
  FROM documents
  WHERE region IS NOT NULL AND date_iso IS NOT NULL
  GROUP BY region
  HAVING COUNT(DISTINCT date_iso) >= 2
  ORDER BY distinct_dates DESC
`);
log(`## Regions with multiple distinct incident dates`);
log(``);
if (!multiDate.length) log(`(none — each region only has one canonical date so far)`);
else {
  log(`| Region | Distinct dates | Dates |`);
  log(`|--------|---------------:|-------|`);
  for (const r of multiDate) log(`| ${r.region} | ${r.distinct_dates} | ${r.dates} |`);
}
log(``);

// 12. Time span
const span = (await rows(`
  SELECT MIN(date_iso) AS earliest, MAX(date_iso) AS latest, COUNT(DISTINCT date_iso) AS distinct_dates
  FROM documents WHERE date_iso IS NOT NULL
`))[0];
log(`## Temporal span`);
log(``);
log(`- Earliest: ${span.earliest}`);
log(`- Latest:   ${span.latest}`);
log(`- Distinct dates: ${span.distinct_dates}`);
log(``);

await conn.disconnectSync();

await fs.writeFile(OUT, lines.join('\n') + '\n');
console.log(`\nwrote: ${path.relative(ROOT, OUT)}`);
