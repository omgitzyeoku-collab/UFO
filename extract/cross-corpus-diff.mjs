// H10: cross-corpus diff. War.gov/UFO/ corpus vs the on-disk noise crawl
// (AARO/FBI Vault/CIA/NASA/NARA from earlier multi-domain crawl).
// Output: extract/cross-corpus.jsonl + a markdown summary at
// docs/cross-corpus-diff.md.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const OUT_JSONL = path.join(ROOT, 'extract', 'cross-corpus.jsonl');
const OUT_MD = path.join(ROOT, 'docs', 'cross-corpus-diff.md');

// Load war.gov/UFO/ canonical
const warRecords = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const warShas = new Set(warRecords.map(r => r.sha256));
const warTitles = new Map();
for (const r of warRecords) warTitles.set(r.sha256, r.title || r.name);
console.log(`war.gov/UFO/ canonical: ${warShas.size} sha256s, ${warTitles.size} titled`);

// Load all manifest-recursive-* (the noise crawl) + manifest-medialink-*
const manifestFiles = (await fs.readdir(MANIFEST_DIR)).filter(f => /^manifest-(recursive|spa-wargov)/.test(f));
console.log(`noise manifests: ${manifestFiles.length}`);

const noise = new Map();  // sha256 -> { url, status, content_type, source_domain, manifest_file }
for (const f of manifestFiles) {
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.status !== 200 || !r.sha256) continue;
    if (!noise.has(r.sha256)) {
      let domain = ''; try { domain = new URL(r.url).host; } catch {}
      noise.set(r.sha256, { url: r.url, content_type: r.content_type, domain, file: f });
    }
  }
}
console.log(`noise corpus: ${noise.size} unique sha256s`);

// Compare
const inBoth = [];
const onlyInWar = [];
const onlyInNoise = [];
for (const sha of warShas) {
  if (noise.has(sha)) inBoth.push({ sha256: sha, title: warTitles.get(sha), noise_url: noise.get(sha).url, noise_domain: noise.get(sha).domain });
  else onlyInWar.push({ sha256: sha, title: warTitles.get(sha) });
}
for (const [sha, data] of noise) {
  if (!warShas.has(sha)) onlyInNoise.push({ sha256: sha, url: data.url, domain: data.domain, content_type: data.content_type });
}

console.log(`in both: ${inBoth.length}`);
console.log(`only in war.gov/UFO/: ${onlyInWar.length}`);
console.log(`only in noise (external corpus): ${onlyInNoise.length}`);

// Group noise-only by domain
const byDomain = {};
for (const r of onlyInNoise) byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;

// Look for war.gov/UFO/ titles that have a public-corpus equivalent.
// Match by similarity in title strings.
function tokenSet(s) {
  return new Set((s||'').toLowerCase().split(/\s+/).filter(t => t.length > 3));
}
function jaccard(a, b) {
  const inter = [...a].filter(x => b.has(x));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : inter.length / union.size;
}

// Build noise-corpus title bank from filenames
const noiseTitles = [];
for (const [sha, d] of noise) {
  const fname = decodeURIComponent((d.url || '').split('/').pop().replace(/\.[a-z0-9]+$/i, ''));
  if (fname && fname.length > 5) noiseTitles.push({ sha, fname, domain: d.domain, url: d.url });
}

const titleMatches = [];
for (const w of warRecords) {
  if (!w.title) continue;
  const wTok = tokenSet(w.title);
  if (wTok.size < 2) continue;
  const candidates = [];
  for (const n of noiseTitles) {
    if (n.sha === w.sha256) continue;  // skip identical-content matches (covered by inBoth)
    const sim = jaccard(wTok, tokenSet(n.fname));
    if (sim >= 0.4) candidates.push({ ...n, sim: Math.round(sim * 100) / 100 });
  }
  if (candidates.length) {
    candidates.sort((a,b) => b.sim - a.sim);
    titleMatches.push({ war_title: w.title, war_sha: w.sha256, candidates: candidates.slice(0, 3) });
  }
}

// Detect AARO Case-Resolution gaps: AARO already publishes case-resolution PDFs;
// see if any aren't in war.gov/UFO/
const aaroOnlyCases = onlyInNoise.filter(r =>
  /aaro\.mil/.test(r.domain) &&
  /case_resolution/i.test(r.url) &&
  /\.pdf/i.test(r.url));

console.log(`AARO case-resolution PDFs not in war.gov/UFO/: ${aaroOnlyCases.length}`);

// Detect FBI vault parts not in war.gov/UFO/
const fbiOnlyParts = onlyInNoise.filter(r =>
  /vault\.fbi\.gov/.test(r.domain) && /UFO%20Part/i.test(r.url));

console.log(`FBI Vault UFO parts not in war.gov/UFO/: ${fbiOnlyParts.length}`);

// Write JSONL
const rows = [
  { kind: 'summary', war_count: warShas.size, noise_count: noise.size, in_both: inBoth.length, only_war: onlyInWar.length, only_noise: onlyInNoise.length, by_noise_domain: byDomain },
  ...inBoth.map(r => ({ kind: 'in-both', ...r })),
  ...onlyInWar.map(r => ({ kind: 'only-war', ...r })),
  ...titleMatches.map(r => ({ kind: 'title-match', ...r })),
  ...aaroOnlyCases.map(r => ({ kind: 'aaro-only-case', ...r })),
  ...fbiOnlyParts.map(r => ({ kind: 'fbi-only-part', ...r })),
];
await fs.writeFile(OUT_JSONL, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

// Write markdown summary
const md = `# Cross-corpus diff — war.gov/UFO/ vs. existing public corpora

Generated: ${new Date().toISOString()}

## Summary

| Set | Count |
|---|---|
| war.gov/UFO/ Release 01 (canonical) | ${warShas.size} unique blobs |
| Noise crawl (AARO + FBI Vault + CIA + NASA + NARA + media.defense.gov) | ${noise.size} unique blobs |
| Identical content (same sha256 in both) | ${inBoth.length} |
| In war.gov/UFO/ only | ${onlyInWar.length} |
| In noise only (i.e. exists publicly elsewhere, not republished by war.gov) | ${onlyInNoise.length} |

By external domain (noise-only, i.e. material NOT in war.gov/UFO/):
${Object.entries(byDomain).sort((a,b) => b[1]-a[1]).map(([d,n]) => `- **${d}**: ${n} unique blobs`).join('\n')}

## Identical content matches (${inBoth.length})

These items in war.gov/UFO/ Release 01 are byte-identical to material that
already exists at one of: ${[...new Set([...noise.values()].map(d=>d.domain))].join(', ')}.

${inBoth.slice(0, 30).map(r => `- \`${r.sha256.slice(0,12)}\` ${r.noise_domain} — ${r.title || ''}`).join('\n')}
${inBoth.length > 30 ? `\n_(+${inBoth.length-30} more)_` : ''}

## Title-similarity matches (${titleMatches.length})

These war.gov titles match (Jaccard ≥ 0.4 over title tokens) the filename of a
noise-corpus item but are different sha256s — likely the same document with
different redactions / metadata / scan quality.

${titleMatches.slice(0, 20).map(r => `- **${r.war_title}**\n  candidates:\n${r.candidates.map(c => `    - ${c.domain} | ${c.fname.slice(0,80)} (sim=${c.sim})`).join('\n')}`).join('\n\n')}
${titleMatches.length > 20 ? `\n_(+${titleMatches.length-20} more)_` : ''}

## AARO case-resolution PDFs NOT in war.gov/UFO/ (${aaroOnlyCases.length})

If war.gov/UFO/ is the canonical disclosure mirror, these AARO case
resolutions absent from it are notable.

${aaroOnlyCases.slice(0, 30).map(r => `- ${r.url}`).join('\n')}
${aaroOnlyCases.length > 30 ? `\n_(+${aaroOnlyCases.length-30} more)_` : ''}

## FBI Vault UFO parts NOT in war.gov/UFO/ (${fbiOnlyParts.length})

The CSV description claims the war.gov set is a "complete case file with
several newly declassified pages" of FBI 62-HQ-83894. The Vault has 16 parts
total. Anything missing here is what war.gov chose not to mirror.

${fbiOnlyParts.slice(0, 30).map(r => `- ${r.url}`).join('\n')}
${fbiOnlyParts.length > 30 ? `\n_(+${fbiOnlyParts.length-30} more)_` : ''}

## H10 verdict (preliminary)

Based on automatic byte + title matching:
${inBoth.length > 5 ? '- Significant overlap with public material: same blobs are recycled from existing public sources.' : ''}
${titleMatches.length > 5 ? '- Many war.gov items have public near-equivalents (different redactions): worth checking which version is more or less redacted.' : ''}
${aaroOnlyCases.length > 0 ? `- ${aaroOnlyCases.length} AARO case resolutions exist publicly but are NOT in war.gov/UFO/. Possible deliberate omission.` : ''}
${fbiOnlyParts.length > 0 ? `- ${fbiOnlyParts.length} FBI Vault UFO parts not mirrored. Either intentionally excluded or simply not yet released.` : ''}

This is automated metadata diff. A meaningful H10 verdict requires
text-level comparison (diff the OCR'd content of the same case across
versions) which needs OCR coverage on both sides.
`;
await fs.writeFile(OUT_MD, md);
console.log(`\nwrote ${rows.length} rows to ${path.relative(ROOT, OUT_JSONL)}`);
console.log(`wrote markdown to ${path.relative(ROOT, OUT_MD)}`);
