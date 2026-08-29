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
import { openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { QA_DIR, assertQaCoverage } from './qa-dir.mjs';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
// QA path resolution + the coverage guard live in extract/qa-dir.mjs so that
// every consumer shares one implementation. See that file for why.
const THUMBS_DIR = path.join(ROOT, 'extract', 'thumbs');
const TRANSCRIPTS_DIR = path.join(ROOT, 'extract', 'transcripts');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
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

/**
 * The year the incident happened — which is NOT what `incident_date` holds for
 * every NARA record.
 *
 * All 612 NARA records carry the single value "2023": that is the year the
 * series was accessioned into the National Archives, not the year of the event.
 * Their own source-verified headlines say otherwise — "Twelve Aircraft Reported
 * Unidentified Object Over Colorado in 2007" against incident_date "2023". Left
 * alone, the timeline stacks 2007 sightings on 2023.
 *
 * A green-tier headline has been checked against a quote in the source, so a
 * year stated there is the most trustworthy signal available. Prefer it, and
 * only for green — amber is hedged and red is unverified.
 *
 * war.gov / FBI / CIA / NASA records carry genuine dates ("12/30/47"), so their
 * incident_date is trusted as the fallback.
 */
const YEAR_RE = /\b(19[4-9]\d|20[0-2]\d)\b/;
function deriveIncidentYear(d, qa) {
  if (qa?.tier === 'green') {
    const m = `${qa.public_headline || ''} ${qa.public_tldr || ''}`.match(YEAR_RE);
    if (m) return parseInt(m[1]);
  }
  // NARA's blanket accession year is not an incident date — never fall back to it.
  if (d.source === 'nara') return null;
  const v = String(d.incident_date || '');
  const m = v.match(YEAR_RE);
  if (m) return parseInt(m[1]);
  const short = v.match(/\/(\d{2})$/); // "12/30/47" -> 1947
  if (short) { const y = parseInt(short[1]); return y > 30 ? 1900 + y : 2000 + y; }
  return null;
}


/** True only if a transcript contains real speech, not Whisper filler on silence. */
function hasRealSpeech(p) {
  if (!existsSync(p)) return false;
  try {
    const t = (JSON.parse(readFileSync(p, 'utf8')).text || '').trim();
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 12) return false;
    const uniq = new Set(words.map(w => w.toLowerCase().replace(/[^a-z]/g, ''))).size;
    return uniq >= 8;
  } catch { return false; }
}

/**
 * Flag cards whose body text is boilerplate we would be repeating verbatim.
 *
 * When we have no verified summary the card falls back to the source's own
 * description — and the government writes those from a template. The default
 * "newest first" sort puts the AARO mission reports first, so the landing grid
 * opened with a dozen cards all reading "The United States X Command submitted a
 * report of an unidentified anomalous phenomenon to the All-domain Anomaly
 * Resolution Office...". Identical text, four lines each, zero information.
 *
 * Nothing is hidden: the description still shows in full on the document page.
 * The card just stops repeating the same sentence down the page.
 */
function openingPhrase(s) {
  return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ')
    .trim().split(' ').slice(0, 14).join(' ');
}
const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];

/**
 * war.gov serves a thumbnail image next to many of its documents. We mirror it
 * faithfully — it has its own SHA and it is a real artefact — but it is NOT a
 * separate document. It is a picture of one we already count.
 *
 * Counted as documents they: inflate the corpus by ~7% (1,033 vs 966 distinct
 * records); render duplicate cards whose "Document text" panel 404s, because a
 * thumbnail has no text; make "72 images" mean "3 photographs and 69 pages of
 * paperwork rendered as a picture"; and land in the unverified pile (28 of them)
 * for the trivial reason that an image cannot be checked against a source quote.
 *
 * So: flag them, attach them to the parent they depict, and let the site leave
 * them out of the document count. Every affected parent already carries its own
 * thumbnail, so nothing loses its visual.
 */
const titleIndex = new Map();
for (const d of docs) {
  const t = (d.title || '').trim();
  if (!t) continue;
  if (!titleIndex.has(t)) titleIndex.set(t, []);
  titleIndex.get(t).push(d);
}

// The manifest spells some agencies two ways, which split one bucket into two:
// clicking "CIA" silently missed the docs filed as "Central Intelligence Agency".
const AGENCY_CANON = {
  'Central Intelligence Agency': 'CIA',
  'Office of the Director of National Intelligence': 'ODNI',
  'Department of Defense': 'Department of War',
};
const canonAgency = a => (a ? (AGENCY_CANON[a.trim()] || a.trim()) : null);
const DERIVATIVE_PATH = /\/(thumbnails?|Rotator)\//i;
function derivativeParent(d) {
  if ((d.type || '') !== 'IMG') return null;
  if (!DERIVATIVE_PATH.test(d.url || '')) return null;
  const siblings = titleIndex.get((d.title || '').trim()) || [];
  const parent = siblings.find(x => x.sha256 !== d.sha256 && (x.type || 'PDF') !== 'IMG');
  return parent ? parent.sha256 : null;
}

// Committed, environment-independent type corrections (blob-sniffed offline).
let typeOverrides = {};
try { typeOverrides = JSON.parse(await fs.readFile(path.join(ROOT, 'extract', 'type-overrides.json'), 'utf8')); } catch {}

let qaCount = 0, thumbCount = 0, transcriptCount = 0, typeCorrected = 0, derivativeCount = 0, tierDemoted = 0, transcriptNoise = 0;
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
      // "No quote, no green label" is the promise the whole site rests on, but
      // the pipeline was awarding green to documents where no fact ever matched
      // an exact quote — 33 of them, 21 with no extractable source text at all.
      // Those were verified against the government's CSV blurb, not the document.
      // (DOW-UAP-PR050 says so in its own warnings, and was the homepage hero.)
      // Enforce the promise here: green must be earned by an exact citation.
      let tier = full.tier || null;
      const facts = full.key_facts || [];
      const hasExactQuote = facts.some(f => f.citation_offset && f.citation_offset.exact === true);
      if (tier === 'green' && !hasExactQuote) { tier = 'amber'; tierDemoted++; }
      qa = {
        tier,
        public_headline: full.public_headline || null,
        public_tldr: full.public_tldr || null,
      };
      qaCount++;
    } catch {}
  }

  // Does this record have ANY readable text — an extracted text layer, or a
  // transcript with real speech? 97 records have neither: silent infrared sensor
  // video, and images. They are not "queued" (which promises we will get to them);
  // there is nothing to get to. A summary cannot be verified against a source that
  // has no words, and no amount of reprocessing changes that. Flag it so the site
  // can say so plainly instead of implying a backlog it will never clear.
  const hasText = existsSync(path.join(TEXT_DIR, d.sha256 + '.txt'));

  const thumb = existsSync(path.join(THUMBS_DIR, d.sha256 + '.jpg'));
  if (thumb) thumbCount++;
  // A transcript only counts if there is actually speech in it. Most of the
  // Pentagon mission videos are silent infrared sensor footage, and Whisper
  // hallucinates filler on silence — 95 of 105 video "transcripts" were the
  // single word "You". Publishing that as a transcript is worse than none.
  const transcript = hasRealSpeech(path.join(TRANSCRIPTS_DIR, d.sha256 + '.json'));
  if (transcript) transcriptCount++; else if (existsSync(path.join(TRANSCRIPTS_DIR, d.sha256 + '.json'))) transcriptNoise++;

  // Derive the release tag from the medialink URL (release_0N → release_N).
  // war.gov's release-watch delta crawler hardcodes 'release_2', so a doc
  // whose URL says release_03 must be re-tagged. The URL is authoritative.
  let release = d.release || 'release_1';
  const relMatch = (d.url || d.release_url || '').match(/release_0?(\d+)/i);
  if (relMatch) release = `release_${parseInt(relMatch[1])}`;

  const parentSha = derivativeParent(d);
  if (parentSha) derivativeCount++;

  out.push({
    sha256: d.sha256,
    type,
    // A thumbnail of _parent, not a document in its own right. The site excludes
    // these from the corpus so they are neither counted nor rendered as cards.
    ...(parentSha ? { _derivative: true, _parent: parentSha } : {}),
    // No extracted text and no real-speech transcript: nothing exists to verify a
    // summary against. Drives the "media only" label instead of "queued".
    ...((!hasText && !transcript) ? { _notext: true } : {}),
    agency: canonAgency(d.agency),
    incident_date: d.incident_date || null,
    incident_year: deriveIncidentYear(d, qa),
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

// Refuse to write a corpus stripped of its verification data. When the QA
// directory is missing, every doc silently builds with _qa:null — which erases
// all 881 badges and republishes the 117 summaries that failed review as if they
// were ordinary entries. That shipped to production once, undetected, because
// this step failed quietly. It must be loud.
assertQaCoverage(qaCount, out.length, 'build-corpus');

// Second pass: a card body is boilerplate only if the same opening phrase appears
// on more than two other records AND it is the source's text, not a summary of ours.
const phraseCount = {};
for (const r of out) {
  const body = r._qa?.public_tldr || r.description || '';
  const k = openingPhrase(body);
  if (k) phraseCount[k] = (phraseCount[k] || 0) + 1;
}
let boilerplateFlagged = 0;
for (const r of out) {
  if (r._qa?.public_tldr) continue;            // our own summary is never boilerplate
  const k = openingPhrase(r.description || '');
  if (k && phraseCount[k] > 2) { r._boilerplate = true; boilerplateFlagged++; }
}
console.log(`  boilerplate card bodies flagged: ${boilerplateFlagged}`);

await fs.writeFile(OUT, JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);

console.log(`corpus.json: ${out.length} docs, ${kb} KB`);
console.log(`  with QA summary: ${qaCount}`);
console.log(`  with thumbnail:  ${thumbCount}`);
console.log(`  with transcript: ${transcriptCount}`);
console.log(`  type-corrected (VID/AUD→PDF/IMG): ${typeCorrected}`);
console.log(`  derivative thumbnails flagged: ${derivativeCount} (distinct documents: ${out.length - derivativeCount})`);
console.log(`  green→amber demoted (no exact source quote): ${tierDemoted}`);
console.log(`  transcripts rejected as silence/filler: ${transcriptNoise}`);
