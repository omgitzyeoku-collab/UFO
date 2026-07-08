#!/usr/bin/env bash
set -e
mkdir -p public/extract/text public/extract/public public/extract/thumbs public/extract/transcripts public/docs public/doc public/entity

for f in release-manifest captions entities entities-normalised entity-index scores evidence geocoded connections; do
  if [ -f "extract/${f}.jsonl" ]; then
    cp "extract/${f}.jsonl" "public/extract/${f}.jsonl"
  fi
done

# corpus.json — single bundled fetch (manifest + QA summary + artefact flags).
# Primary load path; the qa-index/thumbs-index below remain as fallback.
if [ -f "extract/build-corpus.mjs" ]; then
  node extract/build-corpus.mjs || echo "build-corpus failed (non-fatal)"
fi
if [ -f "extract/corpus.json" ]; then cp extract/corpus.json public/extract/corpus.json; fi

# fulltext-index.json — inverted index over document bodies (lazy-loaded on search)
if [ -f "extract/build-fulltext-index.mjs" ]; then
  node extract/build-fulltext-index.mjs || echo "build-fulltext failed (non-fatal)"
fi
if [ -f "extract/fulltext-index.json" ]; then cp extract/fulltext-index.json public/extract/fulltext-index.json; fi

# qa-index.json + thumbs-index.json (legacy fallback path)
if [ -f "extract/build-qa-index.mjs" ]; then
  node extract/build-qa-index.mjs || true
fi
for idx in qa-index thumbs-index transcripts-index; do
  if [ -f "extract/${idx}.json" ]; then cp "extract/${idx}.json" "public/extract/${idx}.json"; fi
done

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
