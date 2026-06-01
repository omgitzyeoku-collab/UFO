// Notify IndexNow (Bing, Yandex, Seznam, etc.) of every URL in the sitemap.
// IndexNow is a free, no-account protocol: host <key>.txt at the site root,
// then POST the URL list. Search engines fetch the key file to verify
// ownership, then crawl the submitted URLs.
//
// The content is already public; this just tells search engines it exists.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const HOST = process.env.UAP_HOST || 'ufo-wheat.vercel.app';
const BASE = `https://${HOST}`;
const key = (await fs.readFile(path.join(ROOT, 'extract', 'indexnow-key.txt'), 'utf8')).trim();

// Parse URLs out of the generated sitemap.
const sitemap = await fs.readFile(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => u.startsWith(BASE));
console.log(`sitemap URLs to submit: ${urls.length}`);

if (!urls.length) { console.error('no URLs found'); process.exit(1); }

// IndexNow accepts up to 10,000 URLs per POST.
const body = {
  host: HOST,
  key,
  keyLocation: `${BASE}/${key}.txt`,
  urlList: urls,
};

const endpoints = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow',
  'https://yandex.com/indexnow',
];

for (const ep of endpoints) {
  try {
    const r = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    console.log(`  ${ep} → ${r.status} ${r.statusText}`);
  } catch (e) {
    console.log(`  ${ep} → ERROR ${e.message.slice(0,80)}`);
  }
}

console.log(`\nSubmitted ${urls.length} URLs to IndexNow. Bing/Yandex will crawl over the next days.`);
console.log(`Key file must be live at ${BASE}/${key}.txt — verify after deploy.`);
