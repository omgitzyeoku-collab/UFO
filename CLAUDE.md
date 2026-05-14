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
