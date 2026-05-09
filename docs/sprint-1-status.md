# Sprint 1 status — public MVP

## Brand + domain suggestions (pick one or veto all)

Three options, picked for: distinct, easy-to-spell, available, neutral
in framing, not too cute.

### 1. **UAP Files**
- Domain: **uapfiles.org** (preferred) or **uap-files.org**, **uapfiles.eu**
- Tagline: "Declassified, translated, source-cited."
- Why: Generic enough to scale to any government UAP archive, not just
  war.gov. Easy to say, easy to type. ".org" signals non-commercial.
- Risk: somewhat generic; could be confused with adjacent projects.

### 2. **PURSUE Archive**
- Domain: **pursue-archive.org** or **pursue.archive**
- Tagline: "The full PURSUE release, translated."
- Why: Leverages the official US program name. Authoritative.
  Implicitly suggests we're THE archive of THE program.
- Risk: ties branding to a specific US disclosure programme; harder to
  expand to FBI Vault / CIA / foreign without rebranding.

### 3. **The UAP Record**
- Domain: **uaprecord.org** or **theuaprecord.com**
- Tagline: "The public record of UAP disclosure, translated."
- Why: Sounds editorial / archival. "The record" implies neutrality and
  comprehensiveness. Easy to remember.
- Risk: a bit grandiose — the project has to actually be comprehensive
  to live up to the name.

**My recommendation: UAP Files (#1).** Simplest, most flexible, scales
to all sources we'll ingest. ".org" or ".eu" both fine; ".eu" is
cheaper and you (Yeoku) are EU-based, which is mildly relevant for
GDPR / hosting jurisdiction concerns.

Tell me which (or veto and propose your own) and I'll register the
domain + configure DNS.

## Sprint 1 deliverables — current state

- ✓ **5-agent QA pipeline** (`extract/qa-pipeline.mjs`) — extractor, verifier,
  adjudicator (implicit), citation linker, plain-English rewriter. Outputs
  per-doc `<sha>.json` (verified data) and `<sha>.md` (public prose).
  Confidence tiers: green / amber / red. **Running now, 1/141, ~6 hours.**
- ✓ **Public dashboard** (`public/index.html`) — news-card layout, mobile
  responsive, reads from QA pipeline output. Modal detail view with
  inline pdf.js viewer + inline video player. Citable URLs via
  `#doc/<sha256>` deep links.
- ✓ **About / methodology / donate** pages.
- ✓ **GitHub Pages workflow** updated to deploy `/public/` as site root.

## Sprint 1 — outstanding actions on you

These need your input before I can finish Sprint 1:

1. **Pick a brand + domain** (above).
2. **Decide on monetisation rails:**
   - Open Collective (transparent, public ledger, requires fiscal host
     — they take ~5%)
   - Stripe Checkout (lower fees, your-name accountability, 2.9% + £0.20)
   - GitHub Sponsors (free for sponsors, GitHub takes 0%, but needs a
     public profile with verified identity)
   - Crypto wallet (BTC/ETH/SOL — anonymous-friendly, no fees beyond
     network)
   My recommendation: **Open Collective + Stripe + a public crypto
   wallet.** Three payment rails covers most donors. OC for the
   transparent ledger that gives us institutional credibility.
3. **Confirm "make repo public"** — once Sprint 1 ships, repo flips
   public, GitHub Pages activates automatically (it's blocked on
   private free tier). Everything that's already in `extract/public/`
   becomes the live data on the site.
4. **(optional) Identity** — site can run pseudonymously (recommended
   for editorial neutrality) or under your real name (better for
   institutional sponsorship later). Pseudonymous is the default and
   easy to change later.

## Sprint 1 — outstanding work on me

- Wait for QA pipeline to drain over full corpus (~6 hours
  background).
- Run a sanity-pass on a sample of generated outputs before going
  public — eyeball 10 random docs to catch any pipeline regressions.
- Wire actual donation links into `donate.html` once you've picked
  rails.
- Wire "report an error" links to GitHub Issues template.

## Sprint 1 — definition of done

When all of the following are true:

1. ≥ 80% of corpus is tier=green or tier=amber on the public surface.
2. Domain is live, repo is public, Pages is deployed.
3. Donation links work.
4. About / methodology pages live.
5. I've spot-checked 20 random docs and not found a hallucinated fact.

Then we ship the URL publicly.
