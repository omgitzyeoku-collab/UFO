# UFO Archive

Archival mirror, manifest, and analysis layer for the US Department of War's
[PURSUE](https://www.war.gov/UFO/) public release (war.gov/UFO/).

## Stack

- **Crawlers** (`crawler/`): Playwright + stealth plugin to bypass Akamai Bot Manager
- **Manifest** (`manifest/`, `extract/`): JSONL manifests with SHA-256 verification, DuckDB for analysis
- **Text extraction** (`extract/`): pdftotext + Tesseract.js OCR
- **Dashboard** (`docs/`, `public/`): Static site deployed to Vercel
- **Storage**: GitHub Releases for binary corpus (PDFs, videos, thumbnails)

Node 22+, ESM (`"type": "module"`).

## Key dependencies

DuckDB (`@duckdb/node-api`), Playwright, Sharp, Tesseract.js, robots-parser.

## Conventions

- Manifests are append-only JSONL. Every artefact has a SHA-256.
- Binary corpus lives in GitHub Releases, never in git (gitignored under `blobs/`).
- Crawlers must respect robots.txt and use stealth to avoid Akamai blocks.
- Deploy target: Vercel (static export from `docs/`).

## Runtime LLM

`claude -p` only. No Anthropic SDK, no Ollama.

## Tone rules — non-negotiable

Three banned phrase classes. Violations cost trust directly.

1. **No theatre implying prior failure.** Never: "for real this time", "actually now", "really this time", "properly this time", "genuinely", "finally", "truly this time".
2. **No narrator voice.** Never: "Let me check X", "Let me look at Y", "I'll now run Z", "First, let me".
3. **No hedging.** Never: "should work", "hopefully", "fingers crossed", "let me know if it still breaks", "I think it's fixed", "try that now".

Replacement patterns:
- Verified: "Done. X is live."
- Correcting: "Fixed. <root cause, one sentence>."
- Partial: "Shipped, one thing untested: <specific>. Want me to verify?"

British / European register. No "happy to", no "looking forward to", no emojis. Short, factual, no narration.

## Linear

Use the `linear` MCP for all tasks generated in this project.
- Team: `Yeoku`
- Default project: `UFO`
- Mirror every new TaskCreate into a Linear issue immediately (title + description + priority + labels).
- Default labels: `auto` (Claude ships without input) or `ops` (operator action), plus one of `P0`/`P1`/`P2`. Add `revenue` if applicable, `blocked` if waiting on external.
- Run `/sync-to-linear` to bulk-mirror local TODO/BACKLOG/CLAUDE.md tasks to Linear.
