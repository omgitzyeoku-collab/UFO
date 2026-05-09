// Generate sitemap.xml from the release manifest. Run after every QA batch.
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const SITE = process.env.SITE_URL || 'https://omgitzyeoku-collab.github.io/UFO';

const records = (await fs.readFile(path.join(ROOT, 'extract', 'release-manifest.jsonl'), 'utf8'))
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];

const today = new Date().toISOString().slice(0, 10);
const urls = [
  `${SITE}/`,
  `${SITE}/about.html`,
  `${SITE}/methodology.html`,
  `${SITE}/donate.html`,
  `${SITE}/corrections.html`,
  ...docs.map(d => `${SITE}/#doc/${d.sha256}`),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.includes('#doc/') ? '0.8' : '1.0'}</priority>
  </url>`).join('\n')}
</urlset>
`;
await fs.writeFile(path.join(ROOT, 'public', 'sitemap.xml'), xml);
console.log(`wrote sitemap.xml: ${urls.length} URLs`);
