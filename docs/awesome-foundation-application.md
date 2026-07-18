# Awesome Foundation — application draft

**Status:** draft, ready for operator review. Not submitted.
**Grant:** US$1,000, no strings, monthly.
**Apply at:** https://www.awesomefoundation.org/en/submissions/new
(pick the nearest active chapter — e.g. London, or any "any location" / digital chapter).
**Eligibility:** individuals welcome. No legal entity, no fiscal host needed.
The application is one short form; most of the boxes below are 1–3 sentences.

Awesome grants reward a concrete, finishable thing, not a mission statement. So
this asks for a *specific* deliverable the $1,000 completes, not general support.

---

## Project name

UAP Files — make the government's own UFO releases readable, and prove every word

## The one-paragraph pitch (their main box)

> When the US government dumps thousands of declassified UFO records online, they're
> technically public and practically unreadable — no index, no plain-English entry
> point, just a wall of PDFs and sensor videos. UAP Files mirrors all of them
> (965 documents so far, 15.3 GB, byte-for-byte verifiable) and writes a plain
> summary of each — but only publishes the summary when it can be matched to an
> exact quote in the original. 88 documents are deliberately shown with no summary
> at all, because we couldn't substantiate one. It's free, open source, has no ads
> and no tracking, and it's run by one person. This grant pays the compute to clear
> the backlog of un-processed records and OCR the oldest scans that no machine reads
> cleanly.

## What exactly will $1,000 do?

> It buys the processing for a specific, finishable batch: the ~23 records still
> queued, plus OCR passes on the 1940s–50s FBI typescript that current extraction
> mangles. Concretely: transcription + summarisation + the two-pass verification
> for the queue, and a second OCR engine tuned for degraded typewriter scans so
> those records become searchable rather than sitting as un-indexed images. The
> money runs out exactly when that batch is done — which is what makes it a good fit
> for a one-off grant rather than a subscription.

## Why is it awesome?

> It refuses to do the tempting thing. Every other "AI reads the documents for you"
> project publishes whatever the model produces. This one publishes a number —
> 88 of 965 — for the records it *couldn't* stand behind, and shows the original
> instead. In a subject drowning in confident nonsense, a tool whose headline
> feature is "here's what we could NOT verify" is a small act of public sanity. And
> it's genuinely free: public-domain records, open code, CC-BY summaries, no login.

## Who are you?

> A solo developer (UK/Europe). I built the whole thing — crawlers, the verification
> pipeline, OCR/transcription, the site, and the automation that keeps it current
> without me. The most recent government release was detected, processed and
> published with no manual step. No institution, no funding — which is exactly why
> the verification layer had to be built into the code rather than left to an editor.

## Link

- https://ufo-wheat.vercel.app/
- https://github.com/omgitzyeoku-collab/UFO

---

## Operator notes — not part of the submission

- Awesome grants are decided by local chapters that meet monthly; tone is informal
  and they like *specific finishable things*. The "$1,000 does exactly X and then
  runs out" framing is deliberate — do not turn it into "supports ongoing costs".
- Unlike NLnet, leading with UFOs is fine here — it's a hook, not a liability. The
  awesome factor is the honesty (the 88), so lead with that in conversation.
- ~30 minutes to submit. Re-verify the numbers first: `node extract/build-corpus.mjs`
  prints the tier counts. All figures here measured 2026-07-17.
- Apply to a chapter that accepts remote/any-location projects if the nearest
  geographic one requires local presence.
- This and NLnet are not mutually exclusive — different scale, different framing,
  submit both.
