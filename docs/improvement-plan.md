# Improvement plan — what's weak and what to do next

Written 2026-05-09 immediately after the first end-to-end build of Phase 0–5.
Honest retrospective. Items ranked by a rough effort × value heuristic, not
order they came to mind.

---

## The headline problem: 65 of 115 docs have no usable text

The single biggest hole. The release contains **57% of its corpus as
scanned typewriter PDFs with no text layer** — almost the entire FBI
62-HQ-83894 case file (the "newly declassified" material that's the
release's marquee item), the NARA box-186 1949 flying-discs file (120
MB), the box-7 incident-summaries series, several historical typewritten
reports. `pdftotext` returns gibberish. Until OCR runs, search,
entity extraction, scoring, and hypothesis evidence all see only the
50 modern, born-digital PDFs.

The Tesseract install blocked on a UAC prompt; `pdf-img-convert` failed
silently in npm install. Three viable fixes, ranked:

1. **Use Claude vision for OCR.** `extract/ocr-via-claude.mjs` is
   already written. It needs a working PDF→PNG renderer. Two paths:
   - **(a)** install `pdf-img-convert` properly (it failed silently;
     re-run npm install with `--verbose` to see why)
   - **(b)** install `poppler-utils` for Windows manually — gives us
     `pdftoppm` and `pdfinfo`. Either via Scoop (no admin needed:
     `scoop install poppler`) or direct binary download
   Then run `node extract/ocr-via-claude.mjs` and let it grind through
   all 65 docs. Estimated 6–10 hours of compute (page-by-page through
   `claude -p`), parallelisable.

2. **Local Tesseract.** Same UAC issue but if the user clicks Allow,
   `winget install UB-Mannheim.TesseractOCR` lands. Then
   `extract/ocr-scanned.mjs` (already written) runs without LLM cost.
   Faster but lower accuracy on degraded scans.

3. **Skip and accept the gap.** Document scoring becomes biased toward
   modern docs that happen to have good text. Whole categories of
   historical claims become invisible. Not recommended.

**Pick:** path 1, with poppler-utils via scoop as the renderer. After
this lands, every other phase improves automatically.

---

## Phase 1 (search) — what's working, what's missing

**Working**: BM25 over body + metadata, agency filter, snippet preview,
sub-second response.

**Gaps:**
- No semantic search. "Tic-tac shaped object" doesn't return docs that
  describe "elongated cigar-like form" without the literal string.
  Fix: install `sentence-transformers` Python (one-time, ~500 MB
  model), generate 384-dim embeddings per doc, store in a separate
  parquet. Simple Python script ~20 min to write.
- `--rerank` flag wired but only partially useful. The re-rank prompt
  asks for IDs in best-to-worst order; should also pull the top
  passage per doc for the prompt context, not just the title+snippet.
- No time/agency facets in the dashboard search bar.

---

## Phase 2 (entity extraction) — what's working, what's missing

**Working**: structured JSON per doc, populating people / organisations /
places / projects / case_numbers / sensor_platforms / object_types /
classifications / key_claims / novelty_signals / summary. The first 10
results show real names (Richard A. Harrison), real units (USCENTCOM,
196 ATKS, 12 AF PAROC), real coordinates, real project codenames
(INHERENT RESOLVE, PHANTOM FLEX), real case numbers (MDR 25-0094).

**Gaps:**
- **Entity normalisation is naive.** "Lt. Cmdr. Fravor" / "David
  Fravor" / "DAVID FRAVOR" are three different entities right now.
  Need a Levenshtein/embedding-based dedup pass after extraction
  completes.
- **No incident linkage.** When two docs describe the same event,
  there's no doc-to-incident table. Need an incident-extraction pass
  that creates incident IDs and links docs to them.
- Doesn't handle scanned-PDF docs (because they have no text). Fixed
  automatically once OCR lands.
- Coordinates returned as raw strings (`38SMC851.4a771.4a`) — partly
  redacted. Need a coord-parsing step that handles MGRS + lat/long
  with redaction tokens, surfaces partial geo where possible.

---

## Phase 3 (6-axis scoring) — what's weak

The fingerprint runs but several axes are too crude.

- **Significance** uses raw shared-entity count. Should be weighted by
  entity type (a shared person matters more than a shared sensor).
- **Novelty** treats unique-to-this-doc entities equally. A
  unique-to-this-doc entity that's a unique surname is much more
  meaningful than a unique-to-this-doc entity that's an obvious
  numerical artefact. Need entity-type weighting + frequency cutoffs.
- **Specificity** uses fixed counts. Should normalise by doc length —
  a 50-page brief that mentions 20 dates isn't more specific per
  unit-of-content than a 2-page brief that mentions 5.
- **Provenance** has hand-coded agency weights I picked off the top
  of my head. Need a real provenance taxonomy (e.g. signed-by-named-
  official vs. anonymous; classification level; document type).
- **Redaction density** depends on entity-extraction's
  `redaction_count` which it can only see in text. For scanned docs,
  vision-counted redactions only — biased low. Fix automatically with OCR.
- **Corroboration** — currently shared-entity-with-rare-entity-count.
  Better metric: independent-witness-statement count. Hard to
  automate; needs a proper "claim extraction" pass first.

These are all tunable. Worth running once after OCR completes, then
hand-tuning weights against a sample of docs the user judges by hand.

---

## Phase 4 (dashboard) — gaps

**Working**: corpus list with agency colour-coding, filter by
agency, search box (client-side substring match, fast), detail
panel with metadata + caption + entities + extracted text +
download-PDF button, timeline view (year buckets), entity aggregate
view, hypothesis register view with evidence cards.

**Gaps:**
- **No PDF inline viewer.** Currently you click "download PDF" and
  the browser opens it. Better UX: pdf.js inline so you stay in the
  dashboard. ~30 min to integrate.
- **No map.** `incident_location` strings need geocoding (one-time:
  Nominatim / OpenCage / or a manual lookup table for the ~15
  unique locations). Then Leaflet renders points.
- **Entity drilldown is read-only.** Click an entity → see all docs
  that mention it. Currently the entity list shows aggregates but
  doesn't link back. ~20 min to add.
- **Search is client-side substring**, not BM25. The DuckDB FTS
  index only works server-side. Either expose a tiny query API
  (Node) or use DuckDB-WASM in the browser (more elegant but more
  setup).
- **No diff view** for future tranches. When Release 02 drops,
  what's added/removed/changed should be a first-class view, not
  just a `last-diff.json` file.
- **Not deployed**: dashboard runs locally only. GitHub Pages
  deployment from the same repo is one workflow file away.

---

## Phase 5 (investigator) — gaps

**Working**: 10 hypotheses written before reading the corpus,
versioned in git, evidence aggregator running in background to
pick relevant docs per hypothesis.

**Gaps:**
- **Aggregator is metadata-only.** It picks candidate docs from
  title + description, doesn't read body text. A second-pass
  "deep-read" script should take the top candidates per hypothesis
  and `claude -p` over their full text to extract specific
  passages. That's where actual evidence lives.
- **No decision log automation.** The MD table is append-only by
  hand. Needs a CLI: `node extract/log-decision.mjs --hyp=H3
  --doc=<sha> --update="now think H3 is weakly supported because…"`
- **Adversarial reading** axis (limited-hangout flagging) — written
  in the plan but not implemented. Needs a per-doc tag from
  `claude -p`: "vague vs specific", "sentiment-managing vs
  factual", "confirms-narrative vs contradicts-narrative".
- **Cross-corpus comparison (H10) is impossible** without crawling
  AARO.mil case-resolutions and FBI Vault separately. Earlier
  noise crawl is already on disk — use it as the comparison set.
  Build `extract/cross-corpus-diff.mjs` that diffs entities/cases
  between war.gov/UFO/ and existing public.

---

## Cross-cutting issues

1. **DuckDB write lock contention.** Right now extract-entities,
   evidence aggregator, and scoring all want to read the DB but the
   first one that opens it write-mode locks out the others. Fix:
   build-graph writes once, everyone else opens read-only (just
   landed). But for repeated rebuilds, need a clean
   "rebuild-from-scratch" workflow.

2. **No incremental rebuild.** Every script reads the whole corpus
   each time. Fine for 115 docs. Not fine for 1000 docs after a
   few more tranches. Need an "incremental update" path that only
   processes new shas.

3. **No quality gates.** Entity extraction can return malformed
   JSON; the aggregator silently logs `parsed: null`. Should also
   compute schema validity per record + flag docs that need re-extraction.

4. **Output gets stale.** scores.jsonl, evidence.jsonl, entities.jsonl
   are produced once. After a new entity-extraction run, scores
   should auto-rebuild. Need a `Makefile` or `npm run` orchestration
   that runs the whole DAG when inputs change.

5. **No write protection on graph.duckdb.** Anyone running
   `extract-entities.mjs` could accidentally lock out the dashboard.
   Fix: pre-built read-only DuckDB-WASM bundle in `dashboard/`,
   shipped as part of the repo, regenerated by a single
   `extract/rebuild-all.mjs`.

---

## Recommended next-pass execution order

1. Install poppler-utils (manual, no admin: scoop install poppler)
2. Run `extract/ocr-via-claude.mjs` over the 65 scanned PDFs
   (background, hours of compute)
3. While OCR runs: install Python sentence-transformers, generate
   embeddings, add to graph
4. Once OCR completes: rebuild graph + re-run entity extraction over
   the new text + re-run scoring
5. Run the deep-read evidence pass on the top 3 candidates per
   hypothesis
6. Add map view (geocode 15 locations, Leaflet)
7. Add inline PDF viewer (pdf.js)
8. Cross-corpus diff (H10 evidence) using on-disk noise crawl data
9. Deploy dashboard to GitHub Pages
10. Iterate on scoring weights with hand-judged sample
