// Harvest the entities the QA pipeline ALREADY extracted (named_people,
// named_places, agency, incident_location in each extract/public/<sha>.json)
// into extract/entities-normalised.jsonl — the format build-entity-pages.mjs
// consumes. This gives the entity pages coverage across every QA'd document
// (~970) instead of the stale 50-doc standalone extraction, WITHOUT re-running
// the LLM (deterministic, rate-limit-proof).

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const QA_DIR = path.join(ROOT, 'extract', 'public');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const OUT = path.join(ROOT, 'extract', 'entities-normalised.jsonl');

// title lookup from the manifest
const titleBySha = new Map();
const agencyBySha = new Map();
for (const l of (await fs.readFile(RELEASE, 'utf8')).trim().split('\n')) {
  try { const r = JSON.parse(l); if (r.sha256) { if (!titleBySha.has(r.sha256)) titleBySha.set(r.sha256, r.title || r.name || null); if (r.agency) agencyBySha.set(r.sha256, r.agency); } } catch {}
}

function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const s = (typeof x === 'string' ? x : (x?.name || x?.label || '')).trim();
    // Drop empties, pure codes shorter than 2, and obvious noise.
    if (!s || s.length < 2 || s.length > 80) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

const files = (await fs.readdir(QA_DIR)).filter(f => f.endsWith('.json'));
const rows = [];
let withPeople = 0, withPlaces = 0;
for (const f of files) {
  const sha = f.replace(/\.json$/, '');
  let j;
  try { j = JSON.parse(await fs.readFile(path.join(QA_DIR, f), 'utf8')); } catch { continue; }

  const people = clean(j.named_people);
  // places = named_places + the incident_location + the QA-declared location
  const places = clean([...(j.named_places || []), j.incident_location, j.location].filter(Boolean));
  // organisations = the agency (a real, useful facet)
  const orgs = clean([j.agency || agencyBySha.get(sha)].filter(Boolean));

  if (people.length) withPeople++;
  if (places.length) withPlaces++;
  if (!people.length && !places.length && !orgs.length) continue;

  rows.push({
    sha256: sha,
    title: titleBySha.get(sha) || j.title || null,
    agency: j.agency || agencyBySha.get(sha) || null,
    parsed: {
      people,
      places,
      organisations: orgs,
      projects: [],
      sensor_platforms: [],
      case_numbers: [],
      object_types: [],
    },
  });
}

await fs.writeFile(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`entities-normalised.jsonl: ${rows.length} docs (was ~50)`);
console.log(`  with people: ${withPeople} | with places: ${withPlaces}`);
