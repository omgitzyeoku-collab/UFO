# UFO Archive — war.gov/UFO/ Release 01 mirror

Full mirror of the US Department of War's [PURSUE](https://www.war.gov/UFO/)
(Presidential Unsealing and Reporting System for UAP Encounters) public
release, captured 2026-05-08.

## Where the data lives

**Canonical: GitHub Release →**
<https://github.com/omgitzyeoku-collab/UFO/releases/tag/v1.0-release-01-mirror>

- **116 PDFs** — each individually downloadable with its original filename
- **28 MP4 videos** from DVIDS — DoW UAP mission reports, range-fouler debriefs, unresolved UAP video, NASA-UAP-D3A Gemini 7 1965 audio
- **`thumbnails.tar.gz`** — 130 thumbnail images
- **145 assets total, 3.57 GB**

**Authoritative manifest:** [`extract/release-manifest.jsonl`](extract/release-manifest.jsonl)
— one row per artefact with sha256, release URL, original URL, CSV-derived metadata
(title, agency, incident date, location, description). Anyone with the manifest can
independently verify any asset by SHA-256 against the Release download.

**CSV index from war.gov/UFO/:** [`docs/uap-csv.csv`](docs/uap-csv.csv) (raw),
[`docs/uap-csv-parsed.json`](docs/uap-csv-parsed.json) (parsed) — the document
index that lives at `war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv` and
drives the SPA.

## Inventory

161 records in the CSV map to **158 unique items**: 116 PDFs + 28 videos +
14 image-only items. By Type column: 119 PDF records, 28 VID records, 14 IMG
records (some records share underlying assets, hence 158 unique not 161).

By agency:

- **Department of War** — UAP mission reports by location (Strait of Hormuz,
  Iran, Persian Gulf, Syria, Gulf of Aden, Djibouti, Arabian Gulf), Unresolved
  UAP Report series (PR-19, 26, 34, 35, 38, 43, 45, 46, 49), composite sketch
- **NASA** — Apollo 11 / 12 / 17 transcripts and crew debriefings, Skylab
  technical crew debriefing (1969–1973)
- **Department of State** — UAP cables (Papua New Guinea 1985, Kazakhstan 1994,
  Georgia 2001, etc.) — `dos-uap-d*` and `059uap*` series
- **FBI** — `62-HQ-83894` case file in 10+ sections (full case file with newly
  declassified pages vs. the partial copy on vault.fbi.gov), `FBI-Photo-B1` to
  `B24` series, redacted serials 3/4/5, US person statement
- **NARA-style historical** — flying-discs records 1949 (box 186), German
  armament documents 1944–45, intel collection records 1948–55 (Top Secret
  controlled), various numerical files

## Pipeline

```
crawler/
  scout-source.mjs              # one-shot recon of any URL
  probe-stealth.mjs             # validate Akamai bypass before a real crawl
  war-gov-spa-enumerate.mjs     # discover the SPA's hidden CSV index
  war-gov-medialink-corpus.mjs  # download every PDF + thumbnail in CSV
  retry-failed.mjs              # retry any failed URL idempotently
manifest/
  manifest-medialink-*.jsonl    # per-crawl snapshot of medialink fetches
  manifest-medialink-retry-*.jsonl  # retry results
extract/
  release-manifest.jsonl        # AUTHORITATIVE manifest (sha256 + release URL + CSV metadata)
  text/<sha256>.txt             # pdftotext extraction per PDF
  extract-pdf-text.mjs          # runs pdftotext over every PDF
  text-index.jsonl              # index of extracted text snippets
docs/
  uap-csv.csv                   # the war.gov document index
  uap-csv-parsed.json           # same, parsed to JSON
scripts/
  publish-release.mjs           # uploads PDFs to GitHub Release as named assets
blobs/                          # local content-addressable cache (gitignored)
  <ab>/<cd>/<sha256>            # canonical artefacts also live in the Release
```

## Running from scratch

```bash
npm install
npx playwright install chromium

# 1. Acquire (downloads everything from war.gov/UFO/ via the CSV index)
node crawler/war-gov-medialink-corpus.mjs

# 2. (optional) Retry any failures
node crawler/retry-failed.mjs

# 3. Extract PDF text
node extract/extract-pdf-text.mjs

# 4. Publish to GitHub Release (idempotent — skips already-uploaded assets)
node scripts/publish-release.mjs
```

## Bot manager / acquisition notes

`www.war.gov` sits behind Akamai Bot Manager. Three things had to be true for
the corpus to be acquirable end-to-end:

1. **Headless-shell + playwright-extra-stealth** for the page renders. Plain
   headless Chromium is blocked at TLS-fingerprint level.
2. **In-page warmup** — visit `war.gov/UFO/` first so Akamai cookies land in
   the browser context. The CSV fetch and subsequent downloads then inherit
   that context.
3. **Native browser download** for the PDFs — using `<a download>` injection
   plus `page.waitForEvent('download')`. Direct `context.request.get` returns
   403 (different TLS fingerprint than the rendered page); in-page `fetch` +
   `arrayBuffer` blew Node's heap on the larger PDFs (Apollo crew debriefing
   is 28 MB, NARA box-186 flying-discs is 120 MB). Native download streams
   straight to disk.

## Verification

Every PDF was verified byte-complete via `%%EOF` end-marker check after
download (116 / 116 ✓). To verify against the Release:

```bash
# pick any record from extract/release-manifest.jsonl
curl -sSL <release_url> | sha256sum
# compare to .sha256 field in the manifest
```

## Storage rationale

GitHub Releases was chosen over LFS / R2 / Internet Archive because:
- 2 GB / asset is plenty for the largest PDFs in this release
- No aggregate cap on free-tier Releases
- Each asset has a stable `browser_download_url` that's directly citable
- Native browseable UI in the GitHub release page
- Zero new accounts / credentials beyond the existing repo

If/when the corpus grows past Release-friendly size, manifest still works —
add R2 or Internet Archive URLs as additional fields per record.
