#!/usr/bin/env bash
set -e
mkdir -p public/extract/text public/extract/public public/docs

for f in release-manifest captions entities entities-normalised entity-index scores evidence geocoded connections; do
  if [ -f "extract/${f}.jsonl" ]; then
    cp "extract/${f}.jsonl" "public/extract/${f}.jsonl"
  fi
done

if [ -d "extract/public" ]; then cp -r extract/public/. public/extract/public/ 2>/dev/null || true; fi
if [ -d "extract/text" ];   then cp -r extract/text/.   public/extract/text/   2>/dev/null || true; fi

for f in hypotheses cross-corpus-diff improvement-plan deployment next-phase-plan sprint-1-status; do
  if [ -f "docs/${f}.md" ]; then cp "docs/${f}.md" "public/docs/${f}.md"; fi
done

echo "vercel-build: staged $(find public/extract -type f | wc -l) extract files + $(ls public/docs 2>/dev/null | wc -l) docs"
