# UFO Archive — Hypothesis Register

Written before extensive corpus reading, on 2026-05-08, immediately after
acquisition of war.gov/UFO/ Release 01. The point is to commit specific
questions in advance so the analysis is hypothesis-driven rather than
fishing-expedition. Each hypothesis below gets evidence cards generated
from the corpus by `extract/aggregate-evidence.mjs`.

The register is **versioned in git**. Edits get history; nothing is
silently rewritten.

---

## H1: Geographic clustering of unresolved cases

Of the unresolved cases in this release, how many cluster geographically
or temporally enough to suggest a sustained programme of incursion (vs.
random one-offs)?

**Why it matters:** A diffuse global pattern looks like noise. Repeated
incursion at the same theatre — Strait of Hormuz, Persian Gulf —
implies either deliberate adversary activity, persistent natural
phenomenon, or repeated sensor artefact at one platform.

**Test:** group every UAP mission report by `incident_location` +
`incident_date`. Surface clusters with N≥3 in any region or N≥3 in any
12-month window.

---

## H2: 62-HQ-83894 newly-declassified material

Does the FBI 62-HQ-83894 case file (released here in 10+ sections, with
"newly declassified pages and only minor redactions") materially
change the public picture of any specific 1947–1968 case, or is it
mostly procedural correspondence?

**Why it matters:** vault.fbi.gov already hosts a partial copy. The
delta between the FBI Vault version and this version is the actual
news, regardless of headline framing.

**Test:** OCR the new sections, diff against vault.fbi.gov contents
(already mirrored locally). Surface specific factual statements that
appear in only the new version.

---

## H3: NASA Apollo crew debriefings

Do the NASA Apollo 11/12/17 + Skylab crew debriefings contain
first-person UAP claims, or is the inclusion ceremonial /
context-setting?

**Why it matters:** if Aldrin / Bean / Cernan / Schmitt / etc. made
contemporaneous statements about anomalous observations, that's a
qualitatively different evidence class than declassified analysis
documents.

**Test:** scan the transcripts for utterances by individual astronauts
that describe non-prosaic visual/radar/IR observations, separated
from procedural mission audio.

---

## H4: AARO resolved-case distribution

Where do AARO's "resolved" cases land on the prosaic ↔ non-prosaic
spectrum, and does that distribution differ by region?

**Why it matters:** if the resolved-prosaic ratio in the Middle East
differs significantly from INDOPACOM, that's a structural signal
(sensor platforms, reporting culture, adversary activity) rather
than the universal "always satellites/balloons" framing.

**Test:** for each AARO Case Resolution doc, classify the verdict.
Aggregate by region. Statistical significance via simple chi-squared.

---

## H5: Contemporaneous vs retrospective DoS characterisation

Which State Department cables show evidence of contemporaneous (vs.
retrospective) UAP characterisation by US officials?

**Why it matters:** a cable written days after an event by the embassy
that observed it carries different evidentiary weight than a cable
written years later as analysis.

**Test:** for each DoS UAP cable, compare cable date vs. event date.
Look at language: present-tense reporting vs. past-tense summary;
named witness vs. unnamed; specific times+coords vs. general framing.

---

## H6: Longest-spanning single incident

What's the longest-spanning single incident in the corpus, measured
from the earliest-dated document referencing it to the latest?

**Why it matters:** an incident that generates documents over a decade
indicates sustained institutional interest. Maps to which incidents
the US gov treated as analytically significant rather than dismissive.

**Test:** entity-extract incident references across all docs.
Cross-reference. Output: incidents ranked by document time-span.

---

## H7: Quietly-recurring entities

Are there entities (people, projects, sensor platforms, locations)
that appear unusually often without being explicitly "the subject" of
any document — i.e. quietly recurring in the background?

**Why it matters:** this is how an analyst surfaces structural actors
or systems that the released set isn't explicitly drawing attention
to. Often more revealing than the named programmes.

**Test:** entity frequency vs. entity-as-subject frequency. Surface
entities with high mention-count but low subject-count.

---

## H8: Cross-agency redaction pattern

Does the redaction pattern (which fields get blacked out) reveal a
consistent classification schema across agencies, or is each agency
idiosyncratic?

**Why it matters:** if all agencies redact the same metadata fields
(coords, sensor-platform IDs, callsigns), there's a unified
classification rubric. If they diverge, it's agency-specific
discretion.

**Test:** vision-count redaction blocks per doc. Categorise WHAT was
redacted (HUD overlay, specific paragraph, witness name, etc.)
where text-context allows. Cross-tab by agency.

---

## H9: Recurring kinematic signatures

Of the documents that claim "object behaviour inconsistent with known
aircraft", what specific kinematic / IR / radar signatures recur?

**Why it matters:** if 80% of unresolved cases share two or three
specific signatures (e.g. "no IR plume" + "instantaneous velocity
change"), that's a converging description of a coherent phenomenon
(or a coherent sensor failure mode).

**Test:** extract phenomenology phrases from all unresolved-case
descriptions. Cluster by signature. Surface most-common.

---

## H10: Gaps vs. existing public corpus

What's the gap between this release and what was already public on
AARO.mil / vault.fbi.gov / FOIA reading rooms — and is anything
*missing* from the war.gov set that should be there?

**Why it matters:** the release framing is "transparency". The
honest test is: are there famous unresolved cases (Phoenix Lights,
Stephenville, Aguadilla, Nimitz/Tic-Tac) that are conspicuously
absent? Or cases that were public before and have been withdrawn?

**Test:** compare the war.gov/UFO/ inventory against AARO.mil's
existing case-resolution list and the existing FBI/CIA UAP
records. List omissions and additions.

---

## Decision log

| Date (UTC) | Hypothesis | Doc | Update |
|---|---|---|---|
| 2026-05-08 | (pre-read) | — | Register committed before substantive corpus reading. |

Append-only. Each meaningful update to a view should land here as a
single line with timestamp + hypothesis + driving doc.
