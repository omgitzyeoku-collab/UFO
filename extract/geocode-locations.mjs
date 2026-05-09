// Geocode the unique incident_location values from the corpus via Nominatim
// (free, no API key, polite rate-limit 1 req/sec). Output:
// extract/geocoded.jsonl. Idempotent — skips already-resolved locations.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const OUT = path.join(ROOT, 'extract', 'geocoded.jsonl');

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const locations = new Set();
for (const r of records) {
  const l = (r.incident_location || '').trim();
  if (l && l !== 'N/A') locations.add(l);
}
console.log(`unique locations: ${locations.size}`);

// Resume support
const cache = new Map();
try {
  const lines = (await fs.readFile(OUT, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); cache.set(r.location, r); }
} catch {}
console.log(`already cached: ${cache.size}`);

const todo = [...locations].filter(l => !cache.has(l));
console.log(`to geocode: ${todo.length}`);

for (const loc of todo) {
  // Strip noise from location strings — "Off the coast of X" → "X"
  const q = loc.replace(/^(off the coast of|near|south of|north of|east of|west of|over|in|at|outside)\s+/i, '').trim();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'ufo-archive/1.0 (omgitzyeoku@gmail.com)' } });
    const data = await r.json();
    const hit = data?.[0];
    const row = {
      location: loc,
      query: q,
      lat: hit ? parseFloat(hit.lat) : null,
      lon: hit ? parseFloat(hit.lon) : null,
      display_name: hit?.display_name || null,
      type: hit?.type || null,
      class: hit?.class || null,
      geocoded_at: new Date().toISOString(),
    };
    await fs.appendFile(OUT, JSON.stringify(row) + '\n');
    console.log(`  ${row.lat ? '✓' : '✗'} "${loc}" → ${row.display_name || '(not found)'}`);
  } catch (e) {
    console.error(`  ERR "${loc}": ${e.message}`);
    await fs.appendFile(OUT, JSON.stringify({ location: loc, query: q, error: e.message, geocoded_at: new Date().toISOString() }) + '\n');
  }
  // Polite: 1.1s between requests per Nominatim usage policy
  await new Promise(r => setTimeout(r, 1100));
}

console.log('\ngeocoding done');
