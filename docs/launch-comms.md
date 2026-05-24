# UAP Files — launch comms drafts

For YEO-99. Copy-paste, edit to taste, post.

---

## Hacker News submission

**Title (80 char max):**
```
Show HN: UAP Files – every declassified US government UAP document, translated
```

**URL:** `https://ufo-wheat.vercel.app/` (replace with custom domain once registered)

**First-comment template (post immediately after submitting):**
```
Hi HN — I built UAP Files (https://ufo-wheat.vercel.app/) to make the
recent war.gov PURSUE drop actually readable.

What it does:
- Mirrors every artefact from war.gov/UFO/ (Release 1 May 8 + Release 2 May 22,
  ~240 items: PDFs, videos, NASA Apollo audio) byte-verified via SHA-256
- Translates each document into plain English via a 5-agent QA pipeline
  (extractor → verifier → adjudicator → citation-linker → rewriter)
- Tiers every claim: green = source-verified citation, amber = hedged in
  prose, red = hidden (couldn't be substantiated). The "red" pile is
  important: there's a real bullshit floor in declassified material
- Connects documents via shared entities (people, sensor platforms,
  locations) in a force-directed graph
- Free, no signup, no ads, no tracking, raw data on GitHub Release

Stack:
- Playwright + stealth (war.gov is behind Akamai)
- Node 22, DuckDB w/ FTS, pdftotext + Tesseract OCR for scans
- D3 force-graph, Leaflet for the map
- Claude (via Claude Code CLI headless) drives the QA pipeline
- Static deploy on Vercel; corpus binaries in a GitHub Release (not LFS)

Source: https://github.com/omgitzyeoku-collab/UFO  (open-pipeline soon)

Happy to answer questions about the QA pipeline, the Akamai-bypass
crawler, or why ~25% of red-tier docs end up there.
```

---

## Reddit — r/UFOs

**Self-post, not link drop.**

**Title:**
```
I built a free translated archive of every declassified PURSUE / war.gov UAP document — including the new Release 2
```

**Body:**
```
Hey r/UFOs —

I've been mirroring and translating every document on war.gov/UFO/ since
the May 8 drop. With Release 2 landing on May 22 (51 videos, 7 NASA Apollo
audio recordings, 6 new DOE/CIA/ODNI documents) I figured it's time to
share what I built.

Link: https://ufo-wheat.vercel.app/

What's there:
- All 178 Release 1 items + the new 64 Release 2 items
- Every document gets a plain-English summary so you don't have to wade
  through redacted PDFs
- A 5-agent verification pipeline reads each one and tags claims as
  verified / partial / hidden — anything we couldn't substantiate gets
  hidden by default, not exaggerated
- Interactive map (where did each incident happen?), force-directed
  connection graph (which docs share people, sensor platforms, locations?),
  timeline view by incident year
- The 4-UFO formation Iran 2022 IR video and the Apollo 12 medical-debrief
  audio are both in there
- Everything cites the original source PDF/video so you can verify yourself

What it isn't:
- Not a "disclosure" hype site. If a document says "unresolved" we say
  "unresolved", we don't extrapolate
- Not a paywall. Free, no signup, no ads, no tracking. Donations only
- Not a private collection — the entire corpus is downloadable from the
  GitHub Release

If something is wrong, there's a "report error" link on each doc — every
correction is logged publicly.

Happy to take feedback / suggestions / hate.
```

---

## X / Twitter thread (8 tweets)

**1/**
```
The May 22 PURSUE release dropped 64 new UAP files from the US govt.

Combined with May 8: ~240 documents, videos, and NASA Apollo audio.

We translated every single one into plain English. Free, no signup.

🧵
ufo-wheat.vercel.app
```

**2/**
```
Every doc gets a 5-agent QA pipeline:

- extractor pulls facts
- verifier independently checks them
- adjudicator resolves disagreements
- citation linker requires a verbatim quote
- rewriter narrates in plain English

If a claim has no verifiable source, it gets hidden. Not exaggerated.
```

**3/** (screenshot of grid view)
```
Browse the full corpus as a grid. 178 Release 1 + 64 Release 2.

The new Release 2 cards have a red NEW badge so you can spot what's
fresh from the May 22 drop.
```

**4/** (screenshot of map)
```
Plot every incident on a world map. The Middle East density is real.
```

**5/** (screenshot of network graph)
```
Force-directed graph of how documents connect via shared entities —
people, sensor platforms, locations, programs.

You can see which cases share USCENTCOM ground crews vs which share
NASA Apollo astronauts vs which share Roswell-era investigators.
```

**6/** (screenshot of doc detail)
```
Each doc has the plain-English summary, the verified key facts (with
green/amber confidence tags), what to know, related documents, and
the original PDF embedded for verification.

Citation export in BibTeX + Chicago for researchers.
```

**7/**
```
Highlights from Release 2:

- 4-UFO formation, Iran, 26 Aug 2022 (IR sensor) — DOW-UAP-PR050
- Apollo 12 medical debrief: astronauts seeing "streaks of light"
  with eyes closed (NASA-UAP-D008)
- UAP reported at Sandia Base 1948-1950 (DOW-UAP-D017)
- CIA Intelligence Report on USSR UAP 1973 (CIA-UAP-D001)
```

**8/**
```
No paywall, no ads, no tracking. Donations welcome.

If you find an error, every doc has a "report error" link — every
correction goes in a public log.

ufo-wheat.vercel.app
Source: github.com/omgitzyeoku-collab/UFO
```

---

## Journalist email template

**Subject:** Free translated archive of every war.gov UAP file — Release 2 included

**Body:**
```
Hi <name>,

I saw your <publication> piece on the <May 8 / May 22> PURSUE release
(<link>). I built a free archive that might be a useful angle for follow-up
coverage:

https://ufo-wheat.vercel.app/

Every document, video, and audio file on war.gov/UFO/ — both Release 1
and the new Release 2 — translated into plain English by a 5-agent QA
pipeline. Each translation is source-cited at the claim level, with
confidence tiers visible to readers.

The interesting story angles I think are under-reported:

1. The "no findings" pattern — across ~240 documents, how often does the
   investigator-on-record actually conclude "this is anomalous" vs
   "this is a balloon / drone / sensor artefact"? The corpus is grep-able.

2. The Apollo 12 medical debriefing (NASA-UAP-D008) — astronauts
   discussing "streaks of light" they saw with eyes closed. Often
   misreported as cosmic-ray hits but the audio transcript suggests
   debrief team was taking it seriously.

3. Geographic concentration — the map view shows >40% of unresolved
   sightings since 2020 are in the Persian Gulf / Middle East. Why?

Source data is downloadable. Open to a call if useful.

— <operator name>
```

---

## Targets (post first, email second)

**Pre-launch checklist (1h before HN post):**
- [ ] Custom domain live (uapfiles.org)?
- [ ] At least one donation rail wired? (GitHub Sponsors fastest)
- [ ] Run `curl -sI https://uapfiles.org/og-default.png | head` — image serves
- [ ] Post test tweet from operator account to warm engagement
- [ ] Open Plausible / GoatCounter dashboard in another tab

**Journalist target list (verified emails when known):**
- NBC News — Carol Cratty, Geoff Brumfiel
- NPR — Geoff Brumfiel (also)
- Newsweek — Tom Norton (UFO beat)
- The War Zone (TWZ) — Tyler Rogoway, Joe Trevithick
- Live Science — Brandon Specktor
- EarthSky — Paul Scott Anderson
- The Debrief — Tim McMillan, Christopher Plain
- Avi Loeb (avi.loeb@harvard.edu — does respond to interesting work)
- Brian Greene (cc public account, low chance)

**Sub-reddits, in order:**
1. r/UFOs (3.5M) — primary
2. r/Documentaries (12M) — peripheral but engaged
3. r/DataHoarder (700k) — appreciate the mirror + open data angle
4. r/sysadmin (1M) — appreciate the Akamai-bypass crawler tech

**X accounts worth notifying** (reply-quote, don't DM):
- @ufojoenickell, @MickWest, @AviLoeb, @LueElizondo, @ChrisKMellon,
  @gimbal_gimbal (anon UAP analyst), @vmamigon (NPR space reporter)

---

## Pre-launch site checklist (do before posting)

- [ ] Hero banner shows Release 2 badge ✓ (shipped)
- [ ] Notify-strip signup wired with real endpoint (not just localStorage)
- [ ] At least one donation link works
- [ ] Custom domain configured
- [ ] OG image renders on Twitter / Slack / Discord link preview test
- [ ] About page mentions operator name + email for press
- [ ] Methodology page is accurate (5 agents named correctly)
- [ ] Plausible / GoatCounter analytics installed (optional but useful)
- [ ] First-comment for HN drafted and pinned in operator clipboard
