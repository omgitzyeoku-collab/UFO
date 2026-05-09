# Next-phase plan — analysis, publication, longitudinal

Three intertwined workstreams that take the archive from "queryable
mirror" to "useful piece of analytical infrastructure." All three are
designed to compose, not to be done in sequence.

---

## A. Hypothesis-driven analysis

Goal: produce defensible answers to the 10 hypotheses in
`docs/hypotheses.md`, with citations and a versioned decision log.

### A1. Deep-read pass (the missing half of Phase 5)

The current `extract/aggregate-evidence.mjs` picks candidate documents
from metadata only — title + agency + description. The actual
evidence lives in body text. Build:

- **`extract/aggregate-evidence-deep.mjs`** — for each candidate the
  metadata-pass picked, fetch the doc's full extracted text,
  pass to `claude -p` with the hypothesis statement, and ask for
  specific passages that support / contradict / contextualise the
  claim. Output: `extract/evidence-deep.jsonl` with `passage`,
  `quote_offset`, `weight`.
- **Per-hypothesis verdict**: aggregate evidence-deep passages,
  produce a 1-paragraph verdict + confidence score (low / medium /
  high) per hypothesis.
- **Decision log automation**: a CLI `extract/log-decision.mjs` that
  appends a versioned row to `docs/hypotheses.md`'s decision-log
  table whenever a verdict materially shifts.

### A2. Adversarial reading

Tag every doc on a "limited-hangout" axis. Not pejorative — a
legitimate analytical category. Per-doc `claude -p` returns:

- `tone`: "factual" / "sentiment-managing" / "vague" / "diplomatic"
- `specificity_density`: ratio of names/dates/coords to total words
- `confirms_public_narrative`: bool with rationale
- `contradicts_public_narrative`: bool with rationale
- `bureaucratic_distance`: how many steps removed from primary
  observation (0=witness statement, 1=summary by analyst, 2=brief
  citing the summary, etc.)

These weights re-feed the 6-axis fingerprint as a 7th axis.

### A3. Quantitative claim extraction

Real signal is in numbers, not narrative. Per-doc `claude -p`
extract:
- altitudes, speeds, headings (with units)
- sensor types + bearings + ranges
- duration of observation
- number of independent observers
- count of corroborating sensors

Stored as a `claims` table in DuckDB. Enables:
- "all incidents where reported speed > Mach 5"
- "all incidents with multi-sensor radar+IR+visual confirmation"
- distribution plots: kinematic signatures by region/year

### A4. Incident graph

Right now the graph is doc-to-entity. Add **incident as a first-class
node** between docs and entities. Two docs that describe the same
event get linked through an "incident" with: location, date,
observer cohort, sensor mix.

Run `claude -p` over each doc to extract one or more incident IDs
(creating new ones or linking to existing). Output: `incidents.jsonl`,
`doc_incident.jsonl`. Then "longest-spanning single incident" (H6)
becomes a single SQL query.

### A5. Hypothesis evidence dashboard view

Already wired in `dashboard/index.html` (hypotheses view shows
evidence cards). Extend:
- **Evidence weight visualisation**: stack supporting / contradicting
  weights horizontally per hypothesis.
- **Click an evidence card** → opens the doc in detail panel with the
  exact passage highlighted.
- **Export to citable Markdown** — per-hypothesis verdict + cited
  passages as a publishable analytical brief.

**Effort**: A1 = 1 day. A2 = 4 hours. A3 = 1 day. A4 = 1 day. A5 = 1 day.

---

## B. Public publication

Goal: turn the archive into something other people can find, cite,
and contribute to. Currently private repo + private dashboard.

### B1. Decide what's public-vs-private

Three layers, each can be made public independently:

| Layer | Content | Recommendation |
|---|---|---|
| Manifest + extracted text + analysis | release-manifest.jsonl, entity index, scores, evidence cards, hypothesis register, OCR'd text | **Make public.** This is the analytical artefact and has citation value. |
| Dashboard | Static site reading the public manifests | **Make public.** Becomes the discovery surface. |
| Code | Crawlers, analysers, dashboard source | **Make public** with appropriate licence (MIT or AGPL-3). Lets others reproduce + extend. |
| Binary corpus (PDFs/videos) | The 158 actual files | **Already public via GitHub Release.** Each asset has a stable browser_download_url. |

The PDFs are already public-domain US gov works, so there's no IP
concern. The risk is **attribution** (it should be obvious you're a
mirror, not the originator) and **provenance** (you must not be
suspected of altering the files).

### B2. Publication mechanics

- **Repository**: `gh repo edit omgitzyeoku-collab/UFO --visibility public`
  once you decide to flip.
- **GitHub Pages activates immediately** for public repos on free tier
  — the workflow at `.github/workflows/pages.yml` deploys
  automatically on first push after.
- **Custom domain**: e.g. `ufoarchive.eu` (or any TLD you own). Set
  `CNAME` in Pages settings. Adds gravitas, signals durability.
- **Citable URL pattern**: `<domain>/dashboard/#doc/<sha256>` for
  per-doc deep links. Wire via URL hash → render correct doc panel.
  Already half-implemented.
- **Persistent identifier**: register the corpus on Zenodo to mint a
  DOI per release. `https://zenodo.org/account/settings/github/`,
  enable webhook for the repo, tag a release → DOI.
- **Internet Archive mirror** (durability hedge): use `internetarchive`
  CLI to upload the entire Release as a single IA item. Survives
  GitHub disappearing. Mention in README so cite-ers can choose
  which URL is more durable.

### B3. Discovery + accessibility

- **README.md** → polished "what this is, why, how to use it".
- **`/about`** page on the dashboard with provenance, licence,
  contact, cite-as bibtex.
- **Sitemap + Open Graph metadata** on the dashboard for indexing.
- **OAI-PMH endpoint** (later, if academic uptake matters) — exposes
  manifest as a harvestable archive metadata feed.
- **Twitter / Bluesky / Mastodon** of significant changes via the
  Vega tick (already wired) → public broadcast hook.

### B4. Contributor surface

Once public, others may want to add. Provide:
- `CONTRIBUTING.md` — how to run the pipeline, what kinds of
  contribution are useful (better OCR on a specific doc, additional
  hypothesis, better entity normalisation, alternative scoring).
- `LICENSE` — MIT or AGPL-3. AGPL-3 forces derivative works to also
  be open; MIT permits closed forks. Pick based on whether you want
  to encourage open ecosystem or maximise reach.
- Issue templates for "incorrect transcription", "missing document",
  "alternative interpretation".

### B5. Adversarial-press posture

Publishing a UAP-archive at this scale will attract two adversarial
cohorts:
1. **Conspiracy-minded over-readers** who project meaning beyond
   what the docs support. Mitigation: hypothesis register published
   with explicit confidence levels; each evidence card shows
   stance + rationale; verdict paragraph names what's NOT supported.
2. **Debunking dismissers** who insist nothing here is novel.
   Mitigation: cross-corpus diff (already done) shows what's actually
   new in war.gov vs existing public corpora; specificity scoring
   shows which docs have hard evidence vs vague narrative.

Both groups will read selectively. The right response is to make
the analysis rigorous enough that intellectually-honest people on
both sides find it useful.

**Effort**: B1 = 1 hour decision. B2 = 2 hours setup. B3 = 4 hours.
B4 = 2 hours. B5 = ongoing posture, not a task.

---

## C. Longitudinal: cross-comparison with newer tranches

The official press release said tranches will be released "every
few weeks." Diff-on-change is the project's most enduring value.

### C1. Tranche detection

The crawler already works — it pulls the canonical CSV at
`war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv`. New tranches
will appear as new rows + new asset URLs. Daily scheduled task
(`UFO-Archive-Tick`) is already installed and runs at 09:00.

What's missing for true tranche-handling:

- **Tranche identity**: each row in CSV doesn't carry a tranche ID.
  Need to infer from `Release Date` field (currently all `5/8/26`).
  When new dates appear, those = new tranche.
- **Tranche-aware diff**: when the CSV grows, compute the delta:
  added rows, removed rows, modified rows. Modifications matter — a
  re-released document with a different sha256 means re-redaction.
- **Tranche-tagged manifest**: extend `release-manifest.jsonl` with
  a `tranche_id` field so historical analysis can cohort by
  tranche.

### C2. Per-tranche analytical artefact

For each new tranche, auto-generate:
1. **Diff report** (`docs/tranche-N-diff.md`): added / removed /
   modified docs + sha256 chains.
2. **Per-doc analysis** (`extract/text/<sha>.txt`, `extract/entities.jsonl`,
   `extract/scores.jsonl`) — fully populated by the existing
   pipeline.
3. **Hypothesis-verdict update**: re-run evidence aggregator over the
   new tranche; surface any verdicts that materially shifted.
4. **Cross-comparison delta**: re-run cross-corpus-diff. Any new
   AARO case-resolutions / FBI Vault items that this tranche now
   includes (or pointedly doesn't).
5. **Public broadcast**: tweet thread / Mastodon post / Bluesky
   thread summarising the tranche, generated by `claude -p` from
   the diff report. Manual review before posting.

### C3. Re-redaction detection

This is the highest-value longitudinal signal, full stop. If a
document released today gets re-released next month with different
redactions, the change is the actual news. Implementation:

- **Same-doc detection**: when a new tranche arrives, for each new
  PDF, hash + filename-match against historical inventory. Filename
  match + sha256 mismatch = "same doc, different redaction".
- **Visual diff**: render both versions to PNG per page, perceptual-
  hash each page, surface pages whose hash differs. Then claude
  vision over the differing pages: "what changed".
- **Text diff**: if both versions OCR-decode, run actual diff
  on extracted text. Surface added/removed paragraphs.
- **Output**: `docs/redaction-changes.md` — append-only log of every
  observed re-redaction event with timestamp + which fields/paragraphs
  changed.

This is the audit trail nobody else will have. Worth building right.

### C4. Multi-tranche scoring stability

The 6-axis fingerprint is deterministic per snapshot but will shift
across tranches as the corpus grows. Track:

- **Score deltas** per doc across tranches (a doc whose
  `corroboration` axis grows when later tranches arrive that
  reference the same incident is genuinely more corroborated).
- **Rank stability**: which docs consistently top the composite over
  multiple tranches vs. which spike then fade?
- **Hypothesis stability**: do verdicts stay the same as more data
  arrives, or does the picture flip with each tranche?

### C5. Other government UAP releases

The same pipeline can ingest:
- AARO.mil case-resolution drops (semi-regular)
- FBI Vault new releases (irregular)
- CIA reading-room periodic uploads
- NARA digitisation initiatives
- Foreign government parallels: France GEPAN/COMETA, UK MoD UFO Desk,
  Russia (when accessible), Brazil Operação Prato, Japan GAS, Chile
  CEFAA — all have published UAP material at various times.

Each gets its own crawler + manifest, all feeding the same DuckDB
graph. Cross-corpus comparison becomes "which agencies reference the
same incident" rather than just "war.gov vs everyone else".

**Effort**: C1 = 4 hours. C2 = 1 day. C3 = 2 days (visual diff is
genuinely complex). C4 = 4 hours. C5 = open-ended; per-source 1–3
days.

---

## Recommended execution order

If treating this as a project plan with limited time, work in this
order — each step pays compound interest into later ones.

1. **Finish OCR** (background, blocks A1 / A2 / A3 / A4 for the
   currently-text-blind 65 docs).
2. **A1 deep-read** (1 day) — produces actual hypothesis verdicts,
   the analytical artefact people will read.
3. **A4 incident graph** (1 day) — turns "115 docs" into "N
   incidents" which is what humans actually care about.
4. **B2 publication mechanics** (2 hours) — flip repo public, mint
   DOI, mirror to IA. Now there's a citable artefact.
5. **A3 quantitative claim extraction** (1 day) — kinematics
   distribution analysis. Dramatically improves the analytical
   depth.
6. **C1 tranche-aware diff** (4 hours) — preps the daily tick to
   handle Release 02 properly when it lands.
7. **C3 re-redaction detector** (2 days) — the unique-to-this-
   project audit trail.
8. **Iterate scoring weights** (ongoing) — once you've hand-judged
   30–50 docs, adjust weights against your judgement and watch
   scoring rank-correlation improve.

Total: about 10–12 working days for everything in this plan, OR
spread it over weeks depending on signal value vs. effort.

---

## What I'd flag as the single most-valuable next move

**A1 deep-read pass.** Right now the hypothesis register has
candidates but no real verdicts. A 1-day investment turns
"this archive contains documents that bear on hypothesis X" into
"hypothesis X is supported by these specific passages with these
specific weights." That's the difference between an archive and an
analysis.

After OCR finishes, run A1 in one sweep. Everything else is upside.
