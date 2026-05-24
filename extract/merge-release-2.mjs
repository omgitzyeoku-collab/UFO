// Merge Release 2 manifest entries into extract/release-manifest.jsonl,
// enriched with metadata from docs/uap-data-r2.csv.
// Idempotent: dedupes by sha256.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const MANIFEST_DIR = path.join(ROOT, 'manifest');
const DOCS = path.join(ROOT, 'docs');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');

function parseCsv(text) {
  const rows = []; let row=[], field='', inQ=false;
  for (let i=0;i<text.length;i++){const c=text[i];
    if(inQ){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')inQ=false;else field+=c;}
    else{if(c==='"')inQ=true;else if(c===','){row.push(field);field='';}
    else if(c==='\r'){}else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}else field+=c;}
  }
  if(field||row.length){row.push(field);rows.push(row);}
  return rows;
}

// 1. Load CSV → records (keyed by direct asset URL filename + DVIDS id)
const csvText = await fs.readFile(path.join(DOCS, 'uap-data-r2.csv'), 'utf8');
const rows = parseCsv(csvText);
const h = rows[0];
const records = rows.slice(1).filter(r=>r.some(c=>(c||'').trim())).map(r=>{const o={};h.forEach((hh,i)=>{o[hh.trim()]=(r[i]||'').trim();});return o;});

// Index by URL filename slug
const byFilename = new Map();    // 'DOW-UAP-D017_General_Correspondence_Of_Sandia.pdf' → record
const byDvidsId = new Map();
for (const rec of records) {
  const url = (rec['PDF | Image Link'] || '').trim();
  if (url.startsWith('http')) byFilename.set(url.split('/').pop().toLowerCase(), rec);
  const dv = (rec['DVIDS Video ID'] || '').trim();
  if (dv) byDvidsId.set(dv, rec);
}
console.log(`CSV records indexed: by URL filename ${byFilename.size}, by DVIDS ${byDvidsId.size}`);

// 2. Load existing release manifest sha-set
const existing = new Set();
try {
  const lines = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { try { existing.add(JSON.parse(l).sha256); } catch {} }
} catch {}
console.log(`existing release-manifest shas: ${existing.size}`);

// 3. Iterate over Release 2 manifest files + DVIDS R2 manifests
const r2Manifests = (await fs.readdir(MANIFEST_DIR))
  .filter(f => /^manifest-(release2|dvids-r2)/.test(f));
console.log(`R2 manifests to merge: ${r2Manifests.join(', ')}`);

const newEntries = [];
let pdfCount = 0, vidCount = 0, audCount = 0, imgCount = 0, skipped = 0;

for (const f of r2Manifests) {
  const lines = (await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.status !== 200 || !r.sha256) continue;
    if (existing.has(r.sha256)) { skipped++; continue; }

    // Skip thumbnails (kind=release2-image when the PDF version exists)
    // We treat the .pdf as the primary asset; the .jpg is the thumbnail.
    const filename = (r.suggested_filename || r.url?.split('/').pop() || '').toLowerCase();
    if (/\.jpe?g$/.test(filename) && !r.kind?.includes('image')) {
      // these are thumbnails — keep as thumbnail records (the build-thumbnails script will pick them up)
    }

    // Look up CSV record by filename or DVIDS id
    const csvRec = r.dvids_id ? byDvidsId.get(r.dvids_id) : byFilename.get(filename.replace(/\.jpe?g$/, '.pdf'));
    if (!csvRec && r.kind === 'release2-image') {
      // For thumbnails without direct PDF match — skip from release manifest (still in raw)
      continue;
    }

    // Type classification
    let type = 'PDF';
    if (r.kind === 'dvids-video' || /\.mp4$/.test(filename)) { type = 'VID'; vidCount++; }
    else if (r.kind === 'dvids-audio' || /\.(mp3|wav|m4a|ogg)$/.test(filename)) { type = 'AUD'; audCount++; }
    else if (/\.(jpe?g|png)$/.test(filename)) { type = 'IMG'; imgCount++; }
    else if (/\.pdf$/.test(filename)) { type = 'PDF'; pdfCount++; }

    const entry = {
      sha256: r.sha256,
      bytes: r.bytes,
      name: r.suggested_filename || filename,
      type,
      content_type: r.content_type,
      url: r.url || r.video_url,
      release_url: r.url || r.video_url,
      blob_path: r.blob_path,
      retrieved_at: r.retrieved_at,
      source: csvRec ? 'war.gov' : 'war.gov',
      release: 'release_2',
      title: csvRec?.['Title'] || r.title || null,
      agency: csvRec?.['Agency'] || r.agency || null,
      incident_date: csvRec?.['Incident Date'] || r.incident_date || null,
      incident_location: csvRec?.['Incident Location'] || r.incident_location || null,
      description: csvRec?.['Description Blurb'] || r.description || null,
      dvids_id: r.dvids_id || csvRec?.['DVIDS Video ID'] || null,
    };
    // Strip falsy nulls
    for (const k of Object.keys(entry)) if (entry[k] == null) delete entry[k];

    newEntries.push(entry);
    existing.add(r.sha256);
  }
}

console.log(`\nNew entries to append: ${newEntries.length}`);
console.log(`  PDFs: ${pdfCount}, VIDs: ${vidCount}, AUDs: ${audCount}, IMGs: ${imgCount}`);
console.log(`  Already in release manifest (skipped): ${skipped}`);

if (newEntries.length) {
  await fs.appendFile(RELEASE, newEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`appended to ${RELEASE}`);
}
