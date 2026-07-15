#!/usr/bin/env node
/**
 * Ranks entities for the "start here" directory.
 *
 * The rank decides ORDER ONLY and is never shown. What the reader sees is a
 * sentence assembled from countable fields (documents, agencies, years, media).
 * If that sentence can't be built from the data, the entity doesn't rank —
 * that constraint is what keeps the directory honest. No score, no badge:
 * a number invites the reader to supply their own meaning, and on this subject
 * they'll supply "cover-up".
 *
 * Only green-tier (source-verified) documents count toward a rank.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'extract/corpus.json'), 'utf8'));
const DOCS = Array.isArray(corpus) ? corpus : Object.values(corpus)[0];

const bySha = new Map(DOCS.map(d => [d.sha256, d]));

// --- entity mentions -------------------------------------------------------
const lines = fs.readFileSync(path.join(ROOT, 'extract/entities-normalised.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const SOURCE_LABEL = {
  'war.gov': 'the Pentagon', 'nara': 'the National Archives',
  'aaro.mil': 'AARO', 'fbi.gov': 'the FBI',
};

// Bare IATA/ICAO airport and facility codes dominate the FAA records and carry
// no meaning for a reader. Drop 3-4 char all-caps tokens with no vowel-word shape.
const isCode = s => /^[A-Z0-9]{2,4}$/.test(s);
const STOP = new Set(['UNKNOWN', 'N/A', 'NONE', 'UNSPECIFIED', 'REDACTED', 'CLASSIFIED',
  'US', 'USA', 'U.S.', 'UNITED STATES', 'FAA', 'DOD', 'DOW', 'UAP', 'UFO', 'AIR FORCE',
  // Too generic to tell a reader anything — these are the setting, not the subject.
  'EARTH', 'THE EARTH', 'WORLD', 'SPACE', 'SKY', 'AMERICA', 'NORTH AMERICA', 'ATLANTIC',
  'PACIFIC', 'WASHINGTON']);

const norm = s => String(s || '').trim().replace(/\s+/g, ' ');

/**
 * Collapse "Washington, D.C." / "Washington DC" / "Washington, DC" onto one key.
 * Punctuation and case carry no meaning in these extractions, so strip them for
 * identity while keeping the best-formed variant for display.
 */
const identity = s => s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/** kind => weight of how identifying this class of entity is */
const KINDS = ['people', 'places', 'projects', 'sensor_platforms', 'object_types'];

const ent = new Map(); // key -> {name, kind, shas:Set}
for (const rec of lines) {
  const p = rec.parsed || {};
  for (const kind of KINDS) {
    for (const rawName of (p[kind] || [])) {
      const name = norm(rawName);
      if (!name || name.length < 3) continue;
      if (STOP.has(name.toUpperCase())) continue;
      if (isCode(name)) continue;                       // airport codes: noise
      if (!/[a-z]/.test(name) && name.length < 6) continue;
      const key = `${kind}:${identity(name)}`;
      if (!ent.has(key)) ent.set(key, { name, kind, shas: new Set() });
      const e = ent.get(key);
      // Keep the most complete-looking surface form for display.
      if (name.length > e.name.length) e.name = name;
      e.shas.add(rec.sha256);
    }
  }
}

const N = DOCS.length;
const out = [];

for (const [key, e] of ent) {
  // green-tier documents only — red never ranks
  const docs = [...e.shas].map(s => bySha.get(s)).filter(d => d && d._qa?.tier === 'green');
  if (docs.length < 2) continue;

  const sources = new Set(docs.map(d => d.source).filter(Boolean));
  const agencies = new Set(docs.map(d => d.agency).filter(a => a && a !== 'Unknown'));

  // NO year claims. incident_date cannot support them: all 575 FAA records carry
  // the single blanket value "2023", and the historical files are null/N/A. The
  // only dated document mentioning a 1947 figure is often a modern retrospective,
  // so a year derived here would report when someone WROTE about the subject and
  // read as when it HAPPENED. That inference is exactly what this project must
  // not make, so the directory says nothing about dates at all.

  const media = docs.filter(d => d.type && d.type !== 'PDF');
  const idf = Math.log(N / e.shas.size);

  // People, projects and named platforms identify a subject; a bare country name
  // is usually just the setting. Rank the identifying kinds first.
  const kindBonus = { people: 3, projects: 3, sensor_platforms: 2, object_types: 1, places: 0 }[e.kind] ?? 0;

  // Ordering only. Never rendered — a visible score invites the reader to supply
  // their own meaning, and on this subject they will supply "cover-up".
  const score =
    kindBonus * 30 +
    Math.log(docs.length + 1) * idf * 6 +
    sources.size * 6 +
    media.length * 4;

  // The sentence — countable facts only, no adjectives, no dates.
  const bits = [`Appears in ${docs.length} document${docs.length === 1 ? '' : 's'}`];
  if (agencies.size > 1) bits.push(`from ${agencies.size} agencies`);
  else if (agencies.size === 1) bits.push(`from ${[...agencies][0]}`);
  let sentence = bits.join(' ') + '.';
  if (media.length) {
    const v = media.filter(m => m.type === 'VID').length;
    const i = media.filter(m => m.type === 'IMG').length;
    const a = media.filter(m => m.type === 'AUD').length;
    const parts = [v && `${v} video${v === 1 ? '' : 's'}`, i && `${i} image${i === 1 ? '' : 's'}`, a && `${a} audio recording${a === 1 ? '' : 's'}`].filter(Boolean);
    if (parts.length) sentence += ` Includes ${parts.join(', ')}.`;
  }

  out.push({
    name: e.name, kind: e.kind, slug: identity(e.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    docs: docs.length, sources: [...sources].map(s => SOURCE_LABEL[s] || s), agencies: [...agencies],
    media: media.length, sentence, score,
    shas: docs.slice(0, 60).map(d => d.sha256),
  });
}

out.sort((a, b) => b.score - a.score);
out.forEach(e => delete e.score); // never ship the score

const dest = path.join(ROOT, 'public/significance.json');
fs.writeFileSync(dest, JSON.stringify({ built: new Date().toISOString(), entities: out.slice(0, 240) }));
console.log(`ranked ${out.length} entities -> ${path.relative(ROOT, dest)} (top 240 shipped)`);
console.log('\nTop 25:');
for (const e of out.slice(0, 30)) {
  console.log(`  ${e.kind.padEnd(17)} ${e.name.slice(0, 34).padEnd(35)} ${e.sentence}`);
}
