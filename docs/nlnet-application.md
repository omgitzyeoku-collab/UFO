# NLnet / NGI Zero — application draft

**Status:** draft, ready for operator review. Not submitted.
**Programme:** NGI Zero Commons Fund (rolling; deadlines 1 Feb / 1 Jun / 1 Oct).
**Apply at:** https://nlnet.nl/propose/
**Ask:** €35,000
**Eligibility:** NLnet funds individuals. No legal entity or institution required.
Payment is milestone-based against agreed deliverables, so a fiscal host
(Open Collective Europe) is useful but not a precondition.

---

## Framing — read this first

NLnet funds **open internet infrastructure**, not subject-matter projects. They do
not fund "a UFO archive" and pitching one would fail on relevance, not merit.

What this project actually is, stripped of its subject: **a pipeline that mirrors
primary-source government records with cryptographic provenance and attaches
machine-generated summaries that are refused unless they can be matched to an exact
quote in the source.** The UAP corpus is the proving ground — a real, adversarial,
continuously-updating dataset — not the product.

Every number below is measured against the live corpus. Do not round them up.

---

## 1. Project name

**Verifiable Provenance Archive — citation-gated summarisation for primary-source
public records**

## 2. Website / repository

- Live instance: https://ufo-wheat.vercel.app/
- Source: https://github.com/omgitzyeoku-collab/UFO

## 3. Abstract (NLnet asks for ~1200 characters)

> Public bodies increasingly release primary-source records as bulk dumps: thousands
> of PDFs, videos and scans, with no index and no plain-language entry point.
> Machine summarisation is the obvious answer and the dangerous one — a fluent
> summary of a government record that nobody checked is a fabrication with a
> citation-shaped hole in it.
>
> This project is a pipeline that refuses to publish what it cannot substantiate.
> Each record is mirrored byte-for-byte and content-addressed by SHA-256, then read
> by an extraction pass, re-read by an independent verification pass in a fresh
> context, adjudicated where the two disagree, and finally gated by a deterministic
> citation-linker that string-matches every surviving claim against the source text.
> No exact quote, no publication — the summary is withheld and the original file is
> served alone.
>
> It runs today over 965 US government records (15.3 GB) from four sources. 814 are
> published as verified, 40 as partial, and 88 are deliberately withheld because the
> claims could not be matched. That 88 is the point: it is the number most systems
> would quietly publish anyway.
>
> The work funded here generalises the pipeline away from its first corpus, adds
> reproducible provenance attestation, and packages it so any archive, newsroom or
> civic group can point it at their own document dump.

## 4. Requested amount

**€35,000**

## 5. Have you been involved with projects or organisations relevant to this project before? And how?

> I built and operate the current system single-handedly: crawlers, the verification
> pipeline, the extraction and OCR stack, the static front-end, and the automated
> release-watching that keeps it current without human involvement. It is live,
> open-source, and has been running unattended — the most recent government release
> was detected, mirrored, transcribed, verified and published with no manual step.
>
> The project has no institutional backing and no funding. That is precisely why the
> verification layer exists: with no editorial staff, correctness has to be
> structural rather than supervisory.

## 6. Explain what the project is going to achieve

### The problem

Bulk record releases are technically public and practically unreadable. The gap
between "released" and "readable" is where LLM summarisation is now being applied
at scale — and it is being applied without a substantiation gate. The failure is
not that models hallucinate; it is that a fluent, confident, wrong summary of a
government document is *indistinguishable from a correct one* to the reader it is
meant to serve. Trust is transferred from the record to the summariser, silently.

The existing answers are inadequate in opposite directions. Raw mirrors (FOIA
dumps, agency reading rooms) are honest and unusable. AI-summarised archives are
usable and unaccountable — they publish everything, because a pipeline with no
refusal path has no way to express doubt.

### What exists today (measured, live)

| | |
|---|---|
| Records mirrored | **965** across four sources — Pentagon PURSUE releases (302), US National Archives (612), AARO (35), FBI Vault (16) |
| Bytes, content-addressed | **15.3 GB**, every artefact SHA-256 fingerprinted, never altered |
| Types | 852 PDFs, 105 video, 4 audio, 4 images |
| Published as verified | **814** — every claim matched to an exact quote in the source |
| Published as partial | **40** — agreed but not quote-pinned; hedged in prose |
| **Withheld** | **88** — could not be substantiated, so no summary is published at all |
| Full-text index | **158,003** distinct terms |
| Entity graph | **50,113** weighted edges over 939 records |
| Automation | release detection every 4h; weekly transcribe → verify → publish, unattended |

### The gate, concretely

The pipeline's distinguishing property is that it has a **refusal path**, and that
the refusal is enforced by code rather than by prompt:

1. **Acquire** — mirror, content-address by SHA-256, never modify the original.
2. **Extract** — text layer for born-digital PDFs, OCR for scans, speech-to-text for
   media (with a silence gate: 95 of 105 videos in the current corpus are silent
   sensor footage, and a transcript of silence is worse than none).
3. **Summarise** — an extraction pass produces candidate claims.
4. **Disprove** — an independent pass re-reads the source in a fresh context with a
   different prompt and marks each claim supported / contradicted / absent.
5. **Adjudicate** — disagreements are re-read and settled, usually by deletion.
6. **Gate (deterministic)** — a citation-linker string-matches every surviving claim
   against the extracted source text. This step contains no model. **No exact match,
   no green label.**
7. **Publish or withhold** — unsubstantiated records are served as the original file
   plus the issuing body's own description, explicitly labelled as not ours.

The gate is not advisory. When it was tightened during development, 33 records that
the model tier had marked "verified" were demoted because no claim resolved to an
exact quote — 21 of them had no extractable source text at all and had been
"verified" against a catalogue blurb rather than the document. That is the failure
mode this project exists to make structurally impossible, and it is invisible
without a deterministic gate.

### What the grant funds

**M1 — Extract the pipeline from its corpus (€9k).**
Today the acquisition layer is coupled to specific government sites. Deliverable: a
declarative source adapter (fetch strategy, manifest mapping, licence, robots
posture) so a new corpus is a config file, not a fork. Reference adapters for a
generic FOIA reading room and an OAI-PMH endpoint.

**M2 — Provenance attestation (€8k).**
Today integrity is a SHA-256 manifest. Deliverable: a signed, append-only
attestation log binding {source URL, retrieval time, bytes, digest, extraction tool
version, verification verdict} per artefact, verifiable offline by a third party
with no trust in the operator. This is what makes "we didn't alter it" checkable
rather than promised.

**M3 — Model-independent verification (€8k).**
Today the extraction and verification passes run through one vendor's CLI.
Deliverable: an adapter interface so extraction and verification can run on
different backends — including local open-weight models — with a published
comparison of gate outcomes across backends. A verification layer that depends on a
single proprietary model is not infrastructure.

**M4 — Publish the gate as a reusable component (€6k).**
Deliverable: the citation-linker and tier logic as a standalone, documented library
with a conformance test suite, decoupled from this project's storage and front-end.
This is the transferable artefact — the part other people should be able to take.

**M5 — Documentation and a second live corpus (€4k).**
Deliverable: an operator guide, and the pipeline run end-to-end against a
non-UAP public dataset to demonstrate the abstraction holds.

### Why this is infrastructure, not an application

The subject is incidental and I want to be blunt about that. The reusable claims
are: *primary sources should be mirrored with checkable provenance; machine
summaries of primary sources should be refused unless they resolve to an exact
quote; and the refusal rate should be published rather than hidden.* Those apply to
court records, planning applications, procurement disclosures, inquiry evidence, and
any other bulk release. The current corpus is a good proving ground precisely
because it is adversarial: heavily redacted, badly scanned, and surrounded by an
audience that would very much like the summaries to say more than the documents do.

## 7. Compare your own project with existing or historical efforts

- **Internet Archive / DocumentCloud** — mirror and OCR at scale, and do it well.
  Neither attempts substantiated summarisation; the gap between "released" and
  "readable" is left to the reader. Complementary, not competing: this pipeline
  could publish into DocumentCloud.
- **The Black Vault, agency FOIA reading rooms** — raw honesty, no index, no entry
  point. This is the "usable" half they lack.
- **AI-summarised archives and news-summarisation products** — usable, but publish
  every summary they generate. No refusal path, no published refusal rate, and
  therefore no way for a reader to distinguish a checked claim from a fluent guess.
- **RAG / citation-attribution research** — attribution is typically scored
  (a similarity number) rather than gated (publish / do not publish). Scoring lets
  a weak citation through wearing a confidence badge. This project's contribution is
  the deterministic gate and the willingness to withhold: 88 of 965, published as a
  number on the site.

## 8. What are significant technical challenges you expect to solve?

1. **Making the gate corpus-independent.** Exact-quote matching is easy on clean
   born-digital text and hard on OCR of 1940s typescript, where the "source text" is
   itself lossy. The interesting work is a matching tolerance that survives OCR noise
   without silently loosening into paraphrase-matching.
2. **Offline-verifiable attestation without an operator you must trust.** The log has
   to be checkable by someone who assumes I am hostile.
3. **Backend-independent verification.** Demonstrating the gate's outcomes are a
   property of the pipeline rather than of one vendor's model — including where
   open-weight models degrade the refusal rate, published honestly.
4. **Redaction-aware extraction.** Blacked-out regions must be represented as
   *known-absent* rather than silently dropped, or a summary can assert completeness
   over a hole.

## 9. Licence

- Code: MIT (existing repository).
- Generated summaries: CC-BY 4.0.
- Mirrored records: US government works, public domain (17 U.S.C. § 105).
- All grant deliverables released under the same terms.

---

## Operator notes — not part of the submission

- **Do not lead with UFOs anywhere in the form.** Relevance to NGI is provenance,
  verifiability, and open infrastructure. The corpus is evidence the thing works on
  hard real data.
- **The 88 withheld records are the strongest asset in this application.** They are
  proof of a working refusal path. Lead with that number in conversation.
- Rolling deadlines: 1 Feb / 1 Jun / 1 Oct. Decisions run ~3–4 months.
- Honest expectation: ~10–15% hit rate. This draft is ~8 hours of work for an
  expected value of roughly £2–4k. It is still the best return per hour available to
  this project by a wide margin.
- **Before submitting:** re-run the figures. `node extract/build-corpus.mjs` prints
  the tier counts; the graph and index numbers come from `connections.jsonl` and
  `fulltext-index.json`. Every number here was measured on 2026-07-17 and will drift
  with the next release.
- Adjacent, much cheaper: **Awesome Foundation** (£1k, monthly, individuals
  eligible, ~30-minute application). Worth doing while this is pending.
