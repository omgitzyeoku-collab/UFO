// Generate /public/entity/<slug>.html static pages for every entity that
// appears in 3+ documents. Drives long-tail SEO ("Roswell government docs",
// "USCENTCOM UAP", "Apollo 12 anomalous", etc.).
//
// Input:
//   extract/release-manifest.jsonl   — docs
//   extract/public/<sha>.json        — QA pipeline output (has entities)
//   extract/connections.jsonl        — also has entity nodes
// Output:
//   public/entity/<slug>.html        — static page per entity
//   sitemap.xml                      — extended with entity URLs (done by build-doc-pages later)

import fs from 'node:fs/promises';
import path from 'node:path';
import { QA_DIR, assertQaCoverage } from './qa-dir.mjs';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const OUT = path.join(ROOT, 'public', 'entity');
const BASE = process.env.UAP_BASE_URL || 'https://ufo-wheat.vercel.app';
await fs.mkdir(OUT, { recursive: true });

function esc(s) { return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function slugify(s) {
  return (s||'').toString().toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, '')
    .trim().replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Load docs (deduped by sha)
const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const docs = new Map();
for (const r of records) if (r.sha256 && !docs.has(r.sha256)) docs.set(r.sha256, r);

// Build entity → docs map from entities-normalised.jsonl
const entityToDocs = new Map();  // 'people:Richard A. Harrison' → Set<sha>
const entityLabels = new Map();  // key → display label

const TRACKED_FIELDS = ['people', 'organisations', 'places', 'projects', 'sensor_platforms', 'case_numbers', 'object_types'];
const FIELD_TO_TYPE = {
  people: 'people', organisations: 'organisations', places: 'locations',
  projects: 'programs', sensor_platforms: 'sensor_platforms',
  case_numbers: 'case_numbers', object_types: 'object_types',
};

const entLines = (await fs.readFile(path.join(ROOT, 'extract', 'entities-normalised.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
for (const line of entLines) {
  let row; try { row = JSON.parse(line); } catch { continue; }
  if (!row.sha256 || !row.parsed) continue;
  if (!docs.has(row.sha256)) continue;
  for (const field of TRACKED_FIELDS) {
    const list = row.parsed[field];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const label = (typeof e === 'string' ? e : (e?.label || e?.name || '')).trim();
      if (!label || label.length < 2 || label.length > 80) continue;
      const type = FIELD_TO_TYPE[field];
      const key = `${type}:${label.toLowerCase()}`;
      if (!entityToDocs.has(key)) { entityToDocs.set(key, new Set()); entityLabels.set(key, { type, label }); }
      entityToDocs.get(key).add(row.sha256);
    }
  }
}

// Pick entities with >= 3 docs (drop noise / hapaxes)
const qualifying = [...entityToDocs.entries()].filter(([k, shas]) => shas.size >= 3);
console.log(`entities with >=3 docs: ${qualifying.length}`);

// Sort by doc count desc
qualifying.sort((a, b) => b[1].size - a[1].size);

const typeLabel = {
  people: 'Person', locations: 'Location', organisations: 'Organisation',
  programs: 'Program', sensor_platforms: 'Sensor / platform',
  case_numbers: 'Case', years: 'Year', vehicles: 'Vehicle',
};
const typeSchema = {
  people: 'Person', locations: 'Place', organisations: 'Organization',
  programs: 'Thing', sensor_platforms: 'Thing', case_numbers: 'Thing',
};

// Load the QA headline for every document we are about to link to. Before this,
// QADIR was declared and never read: entity cards rendered d.title, which for
// several hundred records is the raw filename (65_HS1-834228961_62-HQ-83894…).
// The human headline already existed in the QA output; it just was not wired up.
const qaHeadline = new Map();
{
  const shas = [...new Set(qualifying.flatMap(([, shaSet]) => [...shaSet]))].filter(sha => docs.has(sha));
  await Promise.all(shas.map(async sha => {
    try {
      const j = JSON.parse(await fs.readFile(path.join(QA_DIR, sha + '.json'), 'utf8'));
      if (j?.public_headline) qaHeadline.set(sha, j.public_headline);
    } catch {}
  }));
  console.log(`qa headlines resolved: ${qaHeadline.size}/${shas.length} (${QA_DIR})`);
  // Abort before the write loop, not after — a QA-less run would overwrite every
  // entity page with raw-filename titles, which is what CI has been publishing.
  assertQaCoverage(qaHeadline.size, shas.length, 'build-entity-pages');
}

function cardTitle(d) {
  return (qaHeadline.get(d.sha256) || d.title || d.name || '').slice(0, 90);
}

const today = new Date().toISOString().slice(0, 10);
const allEntitySlugs = new Set();

let written = 0;
for (const [key, shaSet] of qualifying) {
  const meta = entityLabels.get(key);
  if (!meta) continue;
  const slug = slugify(`${meta.type}-${meta.label}`);
  if (allEntitySlugs.has(slug)) continue;
  allEntitySlugs.add(slug);

  const relatedDocs = [...shaSet].map(sha => docs.get(sha)).filter(Boolean);
  // Sort by release_date desc then incident year
  relatedDocs.sort((a, b) => {
    const r = (b.release === 'release_2' ? 1 : 0) - (a.release === 'release_2' ? 1 : 0);
    if (r) return r;
    const ya = parseInt((a.incident_date||'').match(/(\d{4})/)?.[1] || '0');
    const yb = parseInt((b.incident_date||'').match(/(\d{4})/)?.[1] || '0');
    return yb - ya;
  });

  const headline = `${meta.label} — ${shaSet.size} declassified US government documents mention this ${typeLabel[meta.type]?.toLowerCase() || 'entity'}`;
  const desc = `Plain-English summaries of every declassified US government UAP/UFO document that references ${meta.label}. From the war.gov PURSUE release and AARO records, source-cited and verified.`;
  const canonicalUrl = `${BASE}/entity/${slug}.html`;
  const ogImage = `${BASE}/og-default.png`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': typeSchema[meta.type] || 'Thing',
    name: meta.label,
    description: desc,
    url: canonicalUrl,
    subjectOf: {
      '@type': 'Dataset',
      name: `UAP Files — documents referencing ${meta.label}`,
      url: canonicalUrl,
    },
  };

  const html = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
<title>${esc(meta.label)} — declassified UAP documents | UAP Files</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(canonicalUrl)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${esc(canonicalUrl)}" />
<meta property="og:title" content="${esc(headline)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:image" content="${esc(ogImage)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(headline)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(ogImage)}" />
<meta name="robots" content="index, follow" />
<script type="application/ld+json">${JSON.stringify(jsonLd, null, 0)}</script>
<link rel="stylesheet" href="../page.css" />
<style>
  body { background: var(--bg, #0b0c0f); color: var(--text, #e6e7ea); font-family: ui-sans-serif, system-ui, sans-serif; max-width: 980px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; line-height: 1.6; }
  a { color: var(--accent, #d97757); }
  .topnav { display: flex; gap: 1rem; padding: 0.5rem 0 1.5rem; font-size: 0.88rem; }
  .topnav a { color: var(--text-dim, #8a8f99); text-decoration: none; }
  .topnav a:hover { color: var(--accent, #d97757); }
  .ent-type { color: var(--text-dim, #8a8f99); font-family: ui-monospace, 'JetBrains Mono', monospace; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
  h1 { font-size: 1.8rem; line-height: 1.25; letter-spacing: -0.01em; margin: 0.4rem 0 1rem; }
  .summary { color: var(--text-soft, #b3b6bd); font-size: 0.95rem; max-width: 70ch; margin-bottom: 1.8rem; }
  .stat-row { display: flex; gap: 1.5rem; padding: 1rem 0; border-top: 1px solid var(--line, #1f232b); border-bottom: 1px solid var(--line, #1f232b); margin-bottom: 1.6rem; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; gap: 0.2rem; }
  .stat .num { font-size: 1.4rem; font-weight: 700; color: var(--accent, #d97757); }
  .stat .lbl { font-size: 0.72rem; color: var(--text-dim, #8a8f99); text-transform: uppercase; letter-spacing: 0.05em; }
  .docs { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .doc-card { background: var(--bg-elev, #15171c); border: 1px solid var(--line, #1f232b); border-radius: 6px; padding: 0.85rem 1.05rem; text-decoration: none; color: inherit; display: flex; flex-direction: column; gap: 0.45rem; transition: border-color 0.15s; }
  .doc-card:hover { border-color: var(--accent, #d97757); }
  .doc-card.r2 { border-left: 3px solid #e74c3c; }
  .doc-card .meta { font-family: ui-monospace, 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--text-dim, #8a8f99); }
  .doc-card h3 { font-size: 0.95rem; font-weight: 600; margin: 0; line-height: 1.35; }
  .doc-card .badges { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .badge { background: var(--bg-elev-2, #1b1e23); padding: 0.1rem 0.45rem; border-radius: 3px; font-size: 0.7rem; color: var(--text-soft, #b3b6bd); }
  .badge.r2 { background: #e74c3c; color: #fff; font-weight: 700; }
  .related-section { margin-top: 2.4rem; padding-top: 1.5rem; border-top: 1px solid var(--line, #1f232b); }
  .related-section h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.6rem; }
</style>
</head>
<body>
<div class="topnav">
  <a href="../index.html">← All UAP Files</a>
  <a href="../about.html">About</a>
  <a href="../methodology.html">Methodology</a>
  <a href="../donate.html">Support</a>
</div>

<div class="ent-type">${esc(typeLabel[meta.type] || meta.type)}</div>
<h1>${esc(meta.label)}</h1>
<p class="summary">${shaSet.size} declassified US government UAP/UFO documents reference this ${typeLabel[meta.type]?.toLowerCase() || 'entity'}. Each summary below was generated by a 5-agent QA pipeline against the original document text and is source-cited.</p>

<div class="stat-row">
  <div class="stat"><div class="num">${shaSet.size}</div><div class="lbl">documents</div></div>
  <div class="stat"><div class="num">${relatedDocs.filter(d => d.release === 'release_2').length}</div><div class="lbl">in Release 2</div></div>
  <div class="stat"><div class="num">${new Set(relatedDocs.map(d => d.agency).filter(Boolean)).size}</div><div class="lbl">agencies</div></div>
  <div class="stat"><div class="num">${new Set(relatedDocs.map(d => (d.incident_date||'').match(/(\d{4})/)?.[1]).filter(Boolean)).size}</div><div class="lbl">distinct years</div></div>
</div>

<h2 style="font-size:1.05rem; font-weight:600; margin:0 0 0.85rem;">Documents that reference ${esc(meta.label)}</h2>
<div class="docs">
${relatedDocs.map(d => `  <a class="doc-card${d.release === 'release_2' ? ' r2' : ''}" href="../doc/${d.sha256}.html">
    <div class="badges">
      ${d.agency ? `<span class="badge">${esc(d.agency)}</span>` : ''}
      ${d.release === 'release_2' ? '<span class="badge r2">R2</span>' : ''}
      ${d.type === 'VID' ? '<span class="badge">video</span>' : ''}
      ${d.type === 'AUD' ? '<span class="badge">audio</span>' : ''}
    </div>
    <h3>${esc(cardTitle(d))}</h3>
    <div class="meta">${esc(d.incident_date || '')}${d.incident_location && d.incident_location !== 'N/A' ? ' · ' + esc(d.incident_location) : ''}</div>
  </a>`).join('\n')}
</div>

<div class="related-section">
  <h2>About this archive</h2>
  <p>UAP Files mirrors every declassified UAP/UFO document released by the US government — currently <a href="https://www.war.gov/UFO/" target="_blank" rel="noopener">war.gov/UFO/</a> (PURSUE program, Releases 1 + 2). Each document is summarised by an independent 5-agent pipeline and tagged with a confidence tier. Free, no paywalls, no ads, no tracking.</p>
  <p><a href="../index.html">← Browse the full corpus</a></p>
</div>
</body>
</html>
`;

  await fs.writeFile(path.join(OUT, slug + '.html'), html);
  written++;
}

// Write an index page for /entity/
const indexEntries = [...allEntitySlugs].map(slug => {
  // re-derive label from one of the qualifying entries
  const match = qualifying.find(([k]) => slugify(`${entityLabels.get(k).type}-${entityLabels.get(k).label}`) === slug);
  if (!match) return null;
  const [k, shaSet] = match;
  const meta = entityLabels.get(k);
  return { slug, label: meta.label, type: meta.type, count: shaSet.size };
}).filter(Boolean).sort((a, b) => b.count - a.count);

const indexHtml = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>People, places, programs — UAP Files entity index</title>
<meta name="description" content="Index of every person, location, organisation, program, and sensor platform mentioned 3+ times across the declassified US government UAP corpus." />
<link rel="canonical" href="${BASE}/entity/" />
<link rel="stylesheet" href="../page.css" />
<style>
  body { background: var(--bg, #0b0c0f); color: var(--text, #e6e7ea); font-family: ui-sans-serif, system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  a { color: var(--accent, #d97757); }
  .topnav { display: flex; gap: 1rem; padding: 0.5rem 0 1.5rem; font-size: 0.88rem; }
  .topnav a { color: var(--text-dim, #8a8f99); text-decoration: none; }
  h1 { font-size: 1.6rem; margin: 0 0 1rem; }
  .group { margin: 1.5rem 0; }
  .group h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim, #8a8f99); margin: 0 0 0.7rem; }
  .ents { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .ent { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.35rem 0.7rem; background: var(--bg-elev, #15171c); border: 1px solid var(--line, #1f232b); border-radius: 4px; text-decoration: none; color: inherit; font-size: 0.85rem; }
  .ent:hover { border-color: var(--accent, #d97757); }
  .ent .count { font-family: ui-monospace, monospace; color: var(--text-dim, #8a8f99); font-size: 0.72rem; }
</style>
</head>
<body>
<div class="topnav">
  <a href="../index.html">← All UAP Files</a>
  <a href="../about.html">About</a>
  <a href="../methodology.html">Methodology</a>
</div>
<h1>Entity index <span style="color:var(--text-dim);font-size:0.9rem;font-weight:400;">${indexEntries.length} entities, 3+ document mentions</span></h1>
${Object.entries(indexEntries.reduce((acc, e) => { (acc[e.type] = acc[e.type] || []).push(e); return acc; }, {})).map(([type, list]) => `
<div class="group">
  <h2>${esc(typeLabel[type] || type)} (${list.length})</h2>
  <div class="ents">
    ${list.slice(0, 200).map(e => `<a class="ent" href="${esc(e.slug)}.html">${esc(e.label)} <span class="count">${e.count}</span></a>`).join('')}
  </div>
</div>`).join('')}
</body>
</html>
`;
await fs.writeFile(path.join(OUT, 'index.html'), indexHtml);

// Emit a small JSON manifest so build-doc-pages can extend sitemap with entity URLs
const sitemapAddendum = indexEntries.map(e => ({
  loc: `${BASE}/entity/${e.slug}.html`,
  lastmod: today, changefreq: 'monthly', priority: '0.6',
}));
sitemapAddendum.unshift({ loc: `${BASE}/entity/`, lastmod: today, changefreq: 'weekly', priority: '0.7' });
await fs.writeFile(path.join(ROOT, 'extract', 'entity-sitemap.json'), JSON.stringify(sitemapAddendum, null, 2));

console.log(`built ${written} entity pages + 1 index → public/entity/`);
console.log(`sitemap addendum (${sitemapAddendum.length} URLs) → extract/entity-sitemap.json`);
