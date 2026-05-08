import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const MANIFEST = path.join(ROOT, 'manifest', 'latest.jsonl');
const OUT = path.join(ROOT, 'extract', 'derived.jsonl');

const lines = (await fs.readFile(MANIFEST, 'utf8')).trim().split('\n').filter(Boolean);
const rows = lines.map(l => JSON.parse(l));

function parseFilename(url) {
  const name = url.split('/').pop().replace(/\?.*$/, '');
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || null;
  const out = { name, stem, ext, source_url: url, agency: null, doc_type: null, doc_id: null, region: null, date_str: null, date_iso: null, kind: null };

  const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
  const DATE_RE = `(\\d{4}|${MONTH}-\\d{4}|${MONTH} \\d{1,2}, \\d{4})`;

  // DOW-UAP-PR{N}-Unresolved-UAP-Report-{Region}-{Date}
  let m = stem.match(new RegExp(`^DOW-UAP-(PR\\d+)-(Unresolved-UAP-Report)-(.+?)-${DATE_RE}$`));
  if (m) {
    out.agency = 'DOW';
    out.doc_type = 'Unresolved UAP Report';
    out.doc_id = m[1];
    out.region = m[3].replace(/-/g, ' ');
    out.date_str = m[4];
    out.kind = 'pr';
    out.date_iso = normaliseDate(m[4]);
    return out;
  }
  // DOW-UAP-PR{N}-...-{Date} catch-all
  m = stem.match(new RegExp(`^DOW-UAP-(PR\\d+)-(.+?)-${DATE_RE}$`));
  if (m) {
    out.agency = 'DOW';
    out.doc_type = m[2].replace(/-/g, ' ');
    out.doc_id = m[1];
    out.date_str = m[3];
    out.date_iso = normaliseDate(m[3]);
    out.kind = 'pr';
    return out;
  }
  // FBI-Photo-{id}
  m = stem.match(/^FBI-Photo-([A-Z]?\d+|[A-Z]\d+)-?$/);
  if (m) {
    out.agency = 'FBI';
    out.doc_type = 'Photo';
    out.doc_id = `FBI-${m[1]}`;
    out.kind = 'fbi-photo';
    return out;
  }
  // NASA-UAP-VM{N}-Apollo-{N}-{Year}
  m = stem.match(/^NASA-UAP-(VM\d+)-Apollo-(\d+)-(\d{4})$/);
  if (m) {
    out.agency = 'NASA';
    out.doc_type = 'Apollo Visual Material';
    out.doc_id = `NASA-${m[1]}`;
    out.region = `Apollo ${m[2]}`;
    out.date_str = m[3];
    out.date_iso = `${m[3]}-01-01`;
    out.kind = 'nasa-apollo';
    return out;
  }
  // Date-prefixed sketches: 2024-04-30-Composite-Sketch
  m = stem.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
  if (m) {
    out.agency = 'DOW';
    out.doc_type = m[4].replace(/-/g, ' ');
    out.doc_id = stem;
    out.date_str = `${m[1]}-${m[2]}-${m[3]}`;
    out.date_iso = `${m[1]}-${m[2]}-${m[3]}`;
    out.kind = 'sketch';
    return out;
  }
  return null;
}

function normaliseDate(s) {
  if (!s) return null;
  const monthMap = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  let m = s.match(/^(\d{4})$/);
  if (m) return `${m[1]}-01-01`;
  m = s.match(/^([A-Za-z]+)[- ](\d{4})$/);
  if (m) {
    const k = m[1].slice(0, 3).toLowerCase();
    return monthMap[k] ? `${m[2]}-${monthMap[k]}-01` : null;
  }
  m = s.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (m) {
    const k = m[1].slice(0, 3).toLowerCase();
    return monthMap[k] ? `${m[3]}-${monthMap[k]}-${m[2].padStart(2, '0')}` : null;
  }
  return null;
}

const derived = [];
for (const r of rows) {
  if (!r.url) continue;
  if (!/Interactive\/2026\/UFO\/Slideshow\//i.test(r.url)) continue;
  if (r.status !== 200) continue;
  const meta = parseFilename(r.url);
  if (!meta) continue;
  derived.push({
    sha256: r.sha256,
    url: r.url,
    bytes: r.bytes,
    blob_path: r.blob_path,
    content_type: r.content_type,
    ...meta,
  });
}

await fs.writeFile(OUT, derived.map(r => JSON.stringify(r)).join('\n') + '\n');

console.log(`derived ${derived.length} structured records from ${rows.length} manifest rows\n`);
const byKind = {};
for (const d of derived) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
console.log('by kind:', byKind);
const byAgency = {};
for (const d of derived) byAgency[d.agency] = (byAgency[d.agency] || 0) + 1;
console.log('by agency:', byAgency);
const byRegion = {};
for (const d of derived) if (d.region) byRegion[d.region] = (byRegion[d.region] || 0) + 1;
console.log('by region:', byRegion);
console.log('\nfirst 5 records:');
for (const d of derived.slice(0, 5)) console.log(JSON.stringify(d, null, 2));
