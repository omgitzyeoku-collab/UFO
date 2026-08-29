// For each doc, generate a real static page at public/doc/<sha>.html.
//
// This is the archive's citation URL — it is what the Cite button emits, what
// every canonical and og:url points at, and what entity pages link to. It used
// to put its whole body inside <noscript> and then location.replace() to the
// SPA, which meant the cited URL rendered nothing, and search consolidated all
// 1,083 of them (77% of the sitemap) into "/". The body is now ordinary HTML;
// the interactive app is offered as a link rather than forced as a redirect.
//
// Also rebuilds public/sitemap.xml and public/robots.txt with the production
// domain, and prunes doc pages whose sha has left the manifest.

import fs from 'node:fs/promises';
import path from 'node:path';
import { QA_DIR, assertQaCoverage } from './qa-dir.mjs';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const OUTDIR = path.join(ROOT, 'public', 'doc');
const SITEMAP = path.join(ROOT, 'public', 'sitemap.xml');
const THUMBS = path.join(ROOT, 'extract', 'thumbs');

const BASE = process.env.UAP_BASE_URL || 'https://ufo-wheat.vercel.app';

await fs.mkdir(OUTDIR, { recursive: true });

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

async function loadQa(sha) {
  try {
    const j = await fs.readFile(path.join(QA_DIR, sha + '.json'), 'utf8');
    return JSON.parse(j);
  } catch { return null; }
}

// Resolve QA for every doc up front so coverage can be checked BEFORE anything
// is written. Loading it inside the write loop meant a run that resolved zero
// QA files still overwrote all 1,083 pages with raw-filename titles and no
// verification badge — which is what CI has been publishing.
const qaBySha = new Map();
await Promise.all(docs.map(async d => {
  const qa = await loadQa(d.sha256);
  if (qa) qaBySha.set(d.sha256, qa);
}));
console.log(`qa resolved: ${qaBySha.size}/${docs.length} (${QA_DIR})`);
assertQaCoverage(qaBySha.size, docs.length, 'build-doc-pages');

async function thumbExists(sha) {
  try { await fs.access(path.join(THUMBS, sha + '.jpg')); return true; } catch { return false; }
}

const today = new Date().toISOString().slice(0, 10);
const sitemapUrls = [
  { loc: `${BASE}/`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${BASE}/about.html`, priority: '0.9', changefreq: 'monthly' },
  { loc: `${BASE}/methodology.html`, priority: '0.9', changefreq: 'monthly' },
  { loc: `${BASE}/corrections.html`, priority: '0.7', changefreq: 'weekly' },
  { loc: `${BASE}/donate.html`, priority: '0.5', changefreq: 'monthly' },
  { loc: `${BASE}/privacy.html`, priority: '0.3', changefreq: 'yearly' },
  { loc: `${BASE}/terms.html`, priority: '0.3', changefreq: 'yearly' },
  { loc: `${BASE}/press.html`, priority: '0.7', changefreq: 'monthly' },
];

// Append entity-page URLs (generated separately by build-entity-pages.mjs)
try {
  const entityUrls = JSON.parse(await fs.readFile(path.join(ROOT, 'extract', 'entity-sitemap.json'), 'utf8'));
  for (const u of entityUrls) sitemapUrls.push(u);
} catch {}

let wrote = 0;
for (const d of docs) {
  const qa = qaBySha.get(d.sha256) || null;
  const headline = qa?.public_headline || d.title || d.name || `Document ${d.sha256.slice(0,12)}`;
  const tldr = qa?.public_tldr || d.description || `Declassified US government UAP document — ${d.agency || 'unknown agency'}.`;
  const hasThumb = await thumbExists(d.sha256);
  const ogImage = hasThumb ? `${BASE}/extract/thumbs/${d.sha256}.jpg` : `${BASE}/og-default.png`;
  const canonicalUrl = `${BASE}/doc/${d.sha256}.html`;
  const appUrl = `${BASE}/#doc/${d.sha256}`;

  const truncTldr = tldr.length > 200 ? tldr.slice(0, 197) + '…' : tldr;
  const truncHeadline = headline.length > 100 ? headline.slice(0, 97) + '…' : headline;

  // The qualifications must travel with the summary. The SPA renders these
  // directly beneath the same narrative (public/index.html:1878); omitting them
  // here published the AI narrative stripped of its own caveats on the page
  // that is now canonical and indexable.
  const caveats = Array.isArray(qa?.public_caveats) ? qa.public_caveats.filter(Boolean) : [];

  // Tier must be explicit. A badge-or-nothing signal makes amber (46 docs)
  // visually identical to an unreviewed record.
  const TIER_LABEL = {
    green: '✓ verified against source',
    amber: '± partially verified',
    red: '⚠ unverified — no summary published',
  };
  const tierBadge = qa?.tier && TIER_LABEL[qa.tier]
    ? `<span class="badge tier-${qa.tier}">${TIER_LABEL[qa.tier]}</span>`
    : '';

  // 612 records are National Archives catalogue entries, and 575 of them share
  // one URL covering a whole series. Labelling that "↓ Original document (49 KB)"
  // promises a per-document file that does not exist. The SPA already branches
  // on this (public/index.html:1893); the static page must match.
  const isNara = d.source === 'nara' || !/\.[a-z0-9]{2,5}(\?|$)/i.test(d.release_url || '');
  const assetNoun = d.type === 'VID' ? 'video' : d.type === 'AUD' ? 'audio' : d.type === 'IMG' ? 'image' : 'document';
  const sizeLabel = d.bytes >= 1048576 ? ` (${(d.bytes / 1048576).toFixed(1)} MB)`
    : d.bytes >= 1024 ? ` (${Math.round(d.bytes / 1024)} KB)` : '';

  // structured data: CreativeWork / Article-style
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: headline,
    description: tldr,
    url: canonicalUrl,
    image: ogImage,
    creator: { '@type': 'GovernmentOrganization', name: d.agency || 'US Government' },
    dateCreated: d.incident_date && d.incident_date !== 'N/A' ? d.incident_date : undefined,
    locationCreated: d.incident_location && d.incident_location !== 'N/A' ? { '@type': 'Place', name: d.incident_location } : undefined,
    isAccessibleForFree: true,
    license: 'https://www.usa.gov/government-works',
  };

  const html = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
<title>${escapeHtml(truncHeadline)} — UAP Files</title>
<meta name="description" content="${escapeAttr(truncTldr)}" />
<link rel="canonical" href="${escapeAttr(canonicalUrl)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${escapeAttr(canonicalUrl)}" />
<meta property="og:title" content="${escapeAttr(truncHeadline)} — UAP Files" />
<meta property="og:description" content="${escapeAttr(truncTldr)}" />
<meta property="og:image" content="${escapeAttr(ogImage)}" />
<meta property="og:site_name" content="UAP Files" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeAttr(truncHeadline)}" />
<meta name="twitter:description" content="${escapeAttr(truncTldr)}" />
<meta name="twitter:image" content="${escapeAttr(ogImage)}" />
<meta name="robots" content="index, follow" />
<!-- JSON.stringify does not escape "</script", so a document title containing
     it would close this block and inject markup. Escape < at the source. -->
<script type="application/ld+json">${JSON.stringify(jsonLd, null, 0).replace(/</g, '\\u003c')}</script>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0c0f; color: #e6e7ea; max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem; line-height: 1.6; }
  a { color: #d97757; }
  .badge { display: inline-block; background: #1a1d22; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; color: #b3b6bd; margin-right: 0.4rem; }
  .thumb { max-width: 100%; border: 1px solid #232830; border-radius: 6px; margin: 1rem 0; }
  h1 { font-size: 1.5rem; line-height: 1.3; letter-spacing: -0.01em; }
  .meta { color: #8a8f99; font-size: 0.88rem; margin: 0.6rem 0 1.2rem; }
  .narr { white-space: pre-wrap; }
  .cta { display: inline-block; background: #d97757; color: #141413; padding: 0.65rem 1.1rem; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 1rem; }
  .badge.tier-green { background: #1d2a1f; color: #7fbf8f; }
  .badge.tier-amber { background: #2b2617; color: #d9b265; }
  .badge.tier-red   { background: #2b1d1c; color: #df8c84; }
  .caveats { background: #15171c; border: 1px solid #232830; border-radius: 6px; padding: 0.9rem 1.1rem; margin-top: 1.2rem; }
  .caveats h2 { font-size: 0.9rem; margin: 0 0 0.5rem; color: #b3b6bd; }
  .caveats ul { margin: 0; padding-left: 1.1rem; font-size: 0.9rem; color: #b3b6bd; }
  .nosum { background: #15171c; border: 1px solid #232830; border-radius: 6px; padding: 0.9rem 1.1rem; margin-top: 1.2rem; font-size: 0.9rem; color: #b3b6bd; }
  .nosum h2 { font-size: 0.9rem; margin: 0 0 0.4rem; color: #e6e7ea; }
  .nav { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .actions { display: flex; gap: 0.9rem; flex-wrap: wrap; align-items: center; margin-top: 1.4rem; }
  .prov { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #232830; font-size: 0.8rem; color: #8a8f99; }
  .prov code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; color: #b3b6bd; }
</style>
</head>
<body>
<nav class="nav">
  <a href="/">← UAP Files</a>
  <a href="/about.html">About</a>
  <a href="/methodology.html">How it works</a>
</nav>

<main>
  <h1>${escapeHtml(headline)}</h1>
  <div class="meta">
    ${d.agency ? `<span class="badge">${escapeHtml(d.agency)}</span>` : ''}
    ${d.incident_date && d.incident_date !== 'N/A' ? `<span class="badge">${escapeHtml(d.incident_date)}</span>` : ''}
    ${d.incident_location && d.incident_location !== 'N/A' ? `<span class="badge">${escapeHtml(d.incident_location)}</span>` : ''}
    ${tierBadge}
  </div>
  ${hasThumb ? `<img class="thumb" src="/extract/thumbs/${d.sha256}.jpg" alt="${escapeAttr(headline)} thumbnail" loading="lazy" width="760" />` : ''}
  <p>${escapeHtml(tldr)}</p>
  ${qa?.public_narrative ? `<div class="narr">${escapeHtml(qa.public_narrative)}</div>` : ''}
  ${caveats.length ? `<div class="caveats">
    <h2>What to know</h2>
    <ul>${caveats.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
  </div>` : ''}
  ${qa?.tier === 'red' ? `<div class="nosum">
    <h2>Why there is no summary here</h2>
    <p>We extracted claims from this document but could not match them to an exact quote in the source, so we do not publish them. Read the original — it is linked below — and judge it yourself.</p>
  </div>` : ''}

  <div class="actions">
    <a class="cta" href="${escapeAttr(d.release_url)}" rel="noopener">${isNara
      ? '↗ View at the National Archives'
      : `↓ Original ${assetNoun}${sizeLabel}`}</a>
    <a href="/#doc/${d.sha256}">Open in the interactive archive →</a>
  </div>
  ${isNara ? `<div class="nosum">
    <h2>This is a National Archives record</h2>
    <p>The full original is hosted at <a href="${escapeAttr(d.release_url)}" rel="noopener">catalog.archives.gov</a>, which serves a catalogue page covering a series rather than a single file.${d.nara_series ? ` Series: ${escapeHtml(d.nara_series)}.` : ''}</p>
  </div>` : ''}

  <div class="prov">
    <p>Source of record:
      ${d.url ? `<a href="${escapeAttr(d.url)}" rel="noopener">${escapeHtml(d.url)}</a>` : 'US government release'}
    </p>
    <p>SHA-256: <code>${escapeHtml(d.sha256)}</code></p>
    <p><a href="/">Browse the full archive</a> · <a href="/corrections.html">Report an error in this summary</a></p>
  </div>
</main>
</body>
</html>
`;

  await fs.writeFile(path.join(OUTDIR, d.sha256 + '.html'), html);
  sitemapUrls.push({ loc: canonicalUrl, priority: '0.8', changefreq: 'monthly', image: hasThumb ? ogImage : undefined });
  wrote++;
}

// Prune doc pages whose sha is no longer in the manifest. Without this they
// stay on disk, stay in the deploy, and stay indexable — pages for documents
// the archive no longer claims to hold.
//
// These are the archive's citation URLs, so the prune is floored. A truncated
// or partially-merged manifest must never be able to mass-delete them: the QA
// coverage guard above cannot catch that case, because it measures a RATIO —
// shrink the manifest and numerator and denominator shrink together.
const liveShas = new Set(docs.map(d => d.sha256));
const onDisk = (await fs.readdir(OUTDIR)).filter(f => /^[0-9a-f]{64}\.html$/.test(f));
const orphans = onDisk.filter(f => !liveShas.has(f.slice(0, 64)));
const PRUNE_CEILING = Math.max(25, Math.floor(onDisk.length * 0.05));
if (orphans.length > PRUNE_CEILING) {
  console.error(`FATAL (build-doc-pages): ${orphans.length} of ${onDisk.length} doc pages`);
  console.error(`look orphaned, over the ceiling of ${PRUNE_CEILING}. The manifest has`);
  console.error(`${docs.length} documents. This is what a truncated or partially-merged`);
  console.error('manifest looks like, not a real removal. Refusing to prune citation URLs.');
  console.error('If the removal is genuine, delete the stale files by hand and re-run.');
  process.exit(1);
}
let pruned = 0;
for (const f of orphans) {
  console.log(`  prune orphan: ${f}`);
  await fs.unlink(path.join(OUTDIR, f));
  pruned++;
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${sitemapUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>${u.image ? `
    <image:image><image:loc>${u.image}</image:loc></image:image>` : ''}
  </url>`).join('\n')}
</urlset>
`;
await fs.writeFile(SITEMAP, sitemap);

// robots.txt with prod domain
const robots = `User-agent: *
Allow: /
Disallow: /extract/manifest/
Disallow: /extract/release-manifest.jsonl

Sitemap: ${BASE}/sitemap.xml

# UAP Files — a public archive of US government UAP/UFO disclosure files.
# Crawl politely.
Crawl-delay: 1
`;
await fs.writeFile(path.join(ROOT, 'public', 'robots.txt'), robots);

console.log(`built ${wrote} doc pages → public/doc/  (pruned ${pruned} orphans)`);
console.log(`sitemap → ${sitemapUrls.length} urls`);
console.log(`robots.txt + sitemap.xml regenerated with base: ${BASE}`);
