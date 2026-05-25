#!/usr/bin/env bash
set -e
mkdir -p public/extract/text public/extract/public public/extract/thumbs public/extract/transcripts public/docs public/doc public/entity

for f in release-manifest captions entities entities-normalised entity-index scores evidence geocoded connections; do
  if [ -f "extract/${f}.jsonl" ]; then
    cp "extract/${f}.jsonl" "public/extract/${f}.jsonl"
  fi
done

# qa-index.json (list of shas that have QA output — avoids 404 spam on load)
if [ -f "extract/build-qa-index.mjs" ]; then
  node extract/build-qa-index.mjs || true
fi
if [ -f "extract/qa-index.json" ]; then cp extract/qa-index.json public/extract/qa-index.json; fi

if [ -d "extract/public" ]; then cp -r extract/public/. public/extract/public/ 2>/dev/null || true; fi
if [ -d "extract/text" ];   then cp -r extract/text/.   public/extract/text/   2>/dev/null || true; fi
if [ -d "extract/thumbs" ]; then cp -r extract/thumbs/. public/extract/thumbs/ 2>/dev/null || true; fi
if [ -d "extract/transcripts" ]; then cp -r extract/transcripts/. public/extract/transcripts/ 2>/dev/null || true; fi

for f in hypotheses cross-corpus-diff improvement-plan deployment next-phase-plan sprint-1-status; do
  if [ -f "docs/${f}.md" ]; then cp "docs/${f}.md" "public/docs/${f}.md"; fi
done

# Regenerate per-doc static stubs + sitemap with current extract data.
# Stubs are also pre-built and committed; rerunning here keeps them in sync.
if [ -f "extract/build-doc-pages.mjs" ]; then
  node extract/build-doc-pages.mjs || echo "doc-pages rebuild failed (non-fatal; pre-built copies survive)"
fi

echo "vercel-build: $(find public/extract -type f | wc -l) extract files + $(ls public/extract/thumbs 2>/dev/null | wc -l) thumbs + $(ls public/doc 2>/dev/null | wc -l) doc-pages + $(ls public/docs 2>/dev/null | wc -l) markdown-docs"
