// Build extract/corpus.json — ONE file the site fetches on load instead of
// 165+ individual QA-JSON requests.
//
// Each record = manifest fields + flags (_thumb, _transcript) + an inline
// QA summary (_qa: {tier, public_headline, public_tldr}) or null. The heavy
// QA detail (narrative, key_facts, caveats) stays in extract/public/<sha>.json
// and is lazy-loaded on detail-open.
//
// Also corrects a data-quality bug: 9 Release-1 "Unresolved UAP Report" docs
// are tagged type=VID but their blobs are actually PDFs. We verify magic
// bytes and correct the type so they render as documents, not broken players.

import fs from 'node:fs/promises';
import { openSync, readSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const QA_DIR = path.join(ROOT, 'extract', 'public');
const THUMBS_DIR = path.join(ROOT, 'extract', 'thumbs');
const TRANSCRIPTS_DIR = path.join(ROOT, 'extract', 'transcripts');
const OUT = path.join(ROOT, 'extract', 'corpus.json');

// Detect real file type from the blob's first bytes.
function sniffType(blobPath) {
  if (!existsSync(blobPath)) return null;
  try {
    const fd = openSync(blobPath, 'r');
    const buf = Buffer.alloc(12);
    readSync(fd, buf, 0, 12, 0);
    closeSync(fd);
    const hex = buf.toString('hex');
    if (buf.slice(4, 8).toString() === 'ftyp') return 'VID';
    if (hex.startsWith('25504446')) return 'PDF';      // %PDF
    if (hex.startsWith('ffd8ff')) return 'IMG';         // JPEG
    if (hex.startsWith('89504e47')) return 'IMG';       // PNG
    if (hex.startsWith('494433') || hex.startsWith('fff')) return 'AUD'; // ID3 / MPEG
    if (buf.slice(0, 4).toString() === 'RIFF') return 'AUD'; // WAV
    return null;
  } catch { return null; }
}

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];

// Committed, environment-independent type corrections (blob-sniffed offline).
let typeOverrides = {};
try { typeOverrides = JSON.parse(await fs.readFile(path.join(ROOT, 'extract', 'type-overrides.json'), 'utf8')); } catch {}

let qaCount = 0, thumbCount = 0, transcriptCount = 0, typeCorrected = 0;
const out = [];

for (const d of docs) {
  const blobPath = path.join(ROOT, d.blob_path || `blobs/${d.sha256.slice(0,2)}/${d.sha256.slice(2,4)}/${d.sha256}`);

  // Correct mislabeled type. PRIMARY signal is the filename extension —
  // it's in the manifest, authoritative, and (unlike magic-byte sniffing)
  // survives the Vercel build where the blobs are absent (gitignored).
  // Magic bytes are a fallback only when the name has no useful extension.
  let type = d.type || 'PDF';
  const name = (d.name || d.url || '').toLowerCase();
  const extType =
    /\.pdf$/.test(name) ? 'PDF' :
    /\.(mp4|mov|webm|mkv)$/.test(name) ? 'VID' :
    /\.(mp3|wav|m4a|ogg|flac)$/.test(name) ? 'AUD' :
    /\.(jpe?g|png|gif|webp|tiff?)$/.test(name) ? 'IMG' : null;
  if (extType && extType !== type) {
    // Only correct media→document/image (the observed bug direction); never
    // downgrade a real video to PDF on a stray name.
    if ((type === 'VID' || type === 'AUD') && (extType === 'PDF' || extType === 'IMG')) {
      type = extType; typeCorrected++;
    } else if (type === 'PDF' && extType === 'VID' && d.dvids_id) {
      // A PDF-typed record that's really a DVIDS video.
      type = extType; typeCorrected++;
    }
  } else if (!extType) {
    // No extension to go on — fall back to magic bytes if the blob is local.
    const sniffed = sniffType(blobPath);
    if (sniffed && (type === 'VID' || type === 'AUD') && (sniffed === 'PDF' || sniffed === 'IMG')) {
      type = sniffed; typeCorrected++;
    }
  }
  // Committed override wins over everything (handles e.g. JPEG served at a
  // .pdf URL, where the extension lies and the blob isn't on the build host).
  if (typeOverrides[d.sha256] && typeOverrides[d.sha256] !== type) {
    type = typeOverrides[d.sha256]; typeCorrected++;
  }

  // Inline QA summary
  let qa = null;
  const qaPath = path.join(QA_DIR, d.sha256 + '.json');
  if (existsSync(qaPath)) {
    try {
      const full = JSON.parse(await fs.readFile(qaPath, 'utf8'));
      qa = {
        tier: full.tier || null,
        public_headline: full.public_headline || null,
        public_tldr: full.public_tldr || null,
      };
      qaCount++;
    } catch {}
  }

  const thumb = existsSync(path.join(THUMBS_DIR, d.sha256 + '.jpg'));
  if (thumb) thumbCount++;
  const transcript = existsSync(path.join(TRANSCRIPTS_DIR, d.sha256 + '.json'));
  if (transcript) transcriptCount++;

  // Derive the release tag from the medialink URL (release_0N → release_N).
  // war.gov's release-watch delta crawler hardcodes 'release_2', so a doc
  // whose URL says release_03 must be re-tagged. The URL is authoritative.
  let release = d.release || 'release_1';
  const relMatch = (d.url || d.release_url || '').match(/release_0?(\d+)/i);
  if (relMatch) release = `release_${parseInt(relMatch[1])}`;

  out.push({
    sha256: d.sha256,
    type,
    agency: d.agency || null,
    incident_date: d.incident_date || null,
    incident_location: d.incident_location || null,
    release,
    source: d.source || 'war.gov',
    bytes: d.bytes || 0,
    name: d.name || null,
    title: d.title || null,
    url: d.url || null,
    release_url: d.release_url || d.url || null,
    dvids_id: d.dvids_id || null,
    description: d.description || null,
    _qa: qa,
    _thumb: thumb,
    _transcript: transcript,
  });
}

await fs.writeFile(OUT, JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);

console.log(`corpus.json: ${out.length} docs, ${kb} KB`);
console.log(`  with QA summary: ${qaCount}`);
console.log(`  with thumbnail:  ${thumbCount}`);
console.log(`  with transcript: ${transcriptCount}`);
console.log(`  type-corrected (VID/AUD→PDF/IMG): ${typeCorrected}`);
