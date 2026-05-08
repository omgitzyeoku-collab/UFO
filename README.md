# UFO Archive — war.gov/UFO/ mirror

An archival mirror, manifest, and analysis layer for the US Department of War's
[PURSUE](https://www.war.gov/UFO/) (Presidential Unsealing and Reporting System
for UAP Encounters) public release, launched 2026-05-08. Files are released on
a rolling basis; this project detects each tranche and preserves a signed,
hash-anchored snapshot.

Repo: <https://github.com/omgitzyeoku-collab/UFO> (private)
Daily tick: Windows scheduled task `UFO-Archive-Tick`, 09:00 local
Telegram alerts via Vega when changes are detected

## Why this exists

The Department of War can edit, redact further, or quietly remove what's
posted. Every artefact captured here is content-addressed by SHA-256 and
recorded in a per-crawl manifest, so changes are detectable rather than silent.
Provenance is the product.

## Layout

```
crawler/
  scout.mjs           # one-shot site recon
  enumerate.mjs       # deep render + lazy-load triggers
  crawl.mjs           # production crawler, response-listener auto-capture
manifest/
  manifest-<crawl_id>.jsonl   # per-crawl snapshot (never overwritten)
  latest.jsonl                # convenience copy of most recent crawl
  latest.jsonl.asc            # GPG detached signature (if key configured)
  latest.jsonl.sha256.json    # SHA-256 sidecar (fallback when no GPG key)
  diff.mjs                    # compare two manifests
  sign.mjs                    # GPG-sign or sha256-attest the latest manifest
  last-diff.json              # most recent diff result (consumed by alerts)
blobs/
  <ab>/<cd>/<sha256>          # content-addressable blob store
extract/
  parse-filenames.mjs # structured fields from DOW/FBI/NASA filenames
  derived.jsonl       # parsed metadata per asset
dashboard/
  index.html          # vanilla JS dashboard
  serve.mjs           # tiny static server (no Next.js required)
scripts/
  tick.mjs            # crawl + parse + sign + diff + alert
docs/                 # screenshots, raw HTML, scout output
```

## Running

```bash
npm install
npx playwright install chrome      # one-time

# manual
node crawler/crawl.mjs              # capture current state
node extract/parse-filenames.mjs    # derive structured records
node manifest/sign.mjs              # sign or attest manifest
node manifest/diff.mjs              # diff vs previous crawl

# dashboard
cd dashboard && node serve.mjs      # http://localhost:4173/

# scheduled tick (crawl → parse → sign → diff → alert if changed)
node scripts/tick.mjs
```

## Bot manager note

`www.war.gov` sits behind Akamai Bot Manager. Headless-shell is blocked.
The crawler runs system Chrome via Playwright's `channel: 'chrome'` with
the `webdriver` flag suppressed. For unattended scheduled runs, see
[crawler/STEALTH.md](crawler/STEALTH.md) for the playwright-extra-stealth
fallback (planned).

## Verification

Each crawl writes a manifest row per artefact with `sha256`, `retrieved_at`,
HTTP status, and response headers (Last-Modified, ETag, Cache-Control,
Server). Anyone with the manifest and the blob store can independently
verify what was on war.gov/UFO/ at the time of the crawl by recomputing
the hash.

## Filename convention (parsed automatically)

```
DOW-UAP-PR{N}-Unresolved-UAP-Report-{Region}-{Date}.jpg
FBI-Photo-{Series}{N}.jpg
NASA-UAP-{Mission ID}-Apollo-{N}-{Year}.jpg
{YYYY-MM-DD}-{Description}.jpg
```

The Pentagon's filename convention encodes agency, document ID, region, and
date — the parser extracts these into queryable fields without OCR.

## Release 01 inventory (2026-05-08)

Captured 17 unique image artefacts from the initial public release:

- 9 × `DOW-UAP-PR*` Unresolved UAP Reports — sparse PR numbering (PR19, 26,
  34, 35, 38, 43, 45, 46, 49) implies an internal series of ≥49 records of
  which only unresolved entries are public. Regions cover Middle East (×3),
  Greece (×2), UAE, Africa, INDOPACOM, Department of the Army.
- 6 × FBI archival photos (FBI-Photo-1, A5, B2, B7, B18, B20).
- 1 × NASA Apollo 17 visual material (1972).
- 1 × composite sketch dated 2024-04-30.

The press release confirms further tranches will include "videos, photos,
and original source documents" — the diff loop catches each new tranche
without manual re-checking.
