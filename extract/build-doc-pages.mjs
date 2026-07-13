// For each doc, generate a static HTML stub at public/doc/<sha>.html.
// Why: social shares (Twitter/LinkedIn/Discord), Google crawlers, and link
// previews all read server-rendered <meta> tags. Hash fragments in a SPA
// don't surface there. These static stubs carry the meta tags + a fallback
// noscript body, then JS redirects to the main app with #doc/<sha>.
//
// Also rebuilds public/sitemap.xml with the production domain.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const QADIR = path.join(ROOT, 'extract', 'public');
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
    const j = await fs.readFile(path.join(QADIR, sha + '.json'), 'utf8');
    return JSON.parse(j);
  } catch { return null; }
}

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
  const qa = await loadQa(d.sha256);
  const headline = qa?.public_headline || d.title || d.name || `Document ${d.sha256.slice(0,12)}`;
  const tldr = qa?.public_tldr || d.description || `Declassified US government UAP document — ${d.agency || 'unknown agency'}.`;
  const hasThumb = await thumbExists(d.sha256);
  const ogImage = hasThumb ? `${BASE}/extract/thumbs/${d.sha256}.jpg` : `${BASE}/og-default.png`;
  const canonicalUrl = `${BASE}/doc/${d.sha256}.html`;
  const appUrl = `${BASE}/#doc/${d.sha256}`;

  const truncTldr = tldr.length > 200 ? tldr.slice(0, 197) + '…' : tldr;
  const truncHeadline = headline.length > 100 ? headline.slice(0, 97) + '…' : headline;

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
<script type="application/ld+json">${JSON.stringify(jsonLd, null, 0)}</script>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0c0f; color: #e6e7ea; max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem; line-height: 1.6; }
  a { color: #d97757; }
  .badge { display: inline-block; background: #1a1d22; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; color: #b3b6bd; margin-right: 0.4rem; }
  .thumb { max-width: 100%; border: 1px solid #232830; border-radius: 6px; margin: 1rem 0; }
  h1 { font-size: 1.5rem; line-height: 1.3; letter-spacing: -0.01em; }
  .meta { color: #8a8f99; font-size: 0.88rem; margin: 0.6rem 0 1.2rem; }
  .narr { white-space: pre-wrap; }
  .cta { display: inline-block; background: #d97757; color: #141413; padding: 0.65rem 1.1rem; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 1rem; }
</style>
</head>
<body>
<noscript>
  <p><a href="/">← UAP Files corpus</a></p>
  <h1>${escapeHtml(headline)}</h1>
  <div class="meta">
    ${d.agency ? `<span class="badge">${escapeHtml(d.agency)}</span>` : ''}
    ${d.incident_date && d.incident_date !== 'N/A' ? `<span class="badge">${escapeHtml(d.incident_date)}</span>` : ''}
    ${d.incident_location && d.incident_location !== 'N/A' ? `<span class="badge">${escapeHtml(d.incident_location)}</span>` : ''}
    ${qa?.tier === 'green' ? '<span class="badge">verified</span>' : ''}
  </div>
  ${hasThumb ? `<img class="thumb" src="/extract/thumbs/${d.sha256}.jpg" alt="${escapeAttr(headline)} thumbnail" loading="lazy" />` : ''}
  <p>${escapeHtml(tldr)}</p>
  ${qa?.public_narrative ? `<div class="narr">${escapeHtml(qa.public_narrative)}</div>` : ''}
  <p><a class="cta" href="${escapeAttr(d.release_url)}" rel="noopener">↓ Original document (${d.bytes ? (d.bytes/1048576).toFixed(1) + ' MB' : ''})</a></p>
  <p><a href="/">← Browse all 178 declassified UAP documents on UAP Files</a></p>
</noscript>
<script>
  // For JS clients, redirect to the SPA with deep-link fragment so the
  // full interactive experience loads.
  location.replace('/#doc/${d.sha256}');
</script>
</body>
</html>
`;

  await fs.writeFile(path.join(OUTDIR, d.sha256 + '.html'), html);
  sitemapUrls.push({ loc: canonicalUrl, priority: '0.8', changefreq: 'monthly', image: hasThumb ? ogImage : undefined });
  wrote++;
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

console.log(`built ${wrote} doc pages → public/doc/`);
console.log(`sitemap → ${sitemapUrls.length} urls`);
console.log(`robots.txt + sitemap.xml regenerated with base: ${BASE}`);
