#!/bin/bash
# Idempotent finalize pipeline. Safe to re-run if interrupted.
#   1. Wait for phase 2 crawler to finish (manifest written)
#   2. Index all artefacts (derived-all.jsonl)
#   3. Run pdftotext on every PDF (skips already-extracted)
#   4. Build DuckDB graph + analytical report
#   5. git commit + push everything
set -e
cd "$(dirname "$0")/.."

echo "=== finalize start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. Wait for phase 2 to write a new recursive manifest
NEW_MANIFEST=$(ls -t manifest/manifest-recursive-*.jsonl 2>/dev/null | head -1)
LAST_LINE_COUNT=$(wc -l < "$NEW_MANIFEST" 2>/dev/null || echo 0)
echo "newest manifest: $NEW_MANIFEST ($LAST_LINE_COUNT lines)"

# Check phase2 log for "RECURSIVE CRAWL ... done" line
if grep -q '=== RECURSIVE CRAWL' /tmp/phase2.log 2>/dev/null; then
  echo "phase 2 already finished per log"
else
  echo "phase 2 still running per log; finalizing with current data"
fi

# 2. Index every artefact
echo ""
echo "=== index-all ==="
node extract/index-all.mjs

# 3. pdftotext over every PDF
echo ""
echo "=== pdftotext ==="
node extract/extract-pdf-text.mjs

# 4. Re-index with new text-extracted flags
echo ""
echo "=== index-all (refresh has_text) ==="
node extract/index-all.mjs

# 5. Graph + report
echo ""
echo "=== build-graph ==="
node extract/build-graph.mjs
echo ""
echo "=== report ==="
node extract/report.mjs

# 6. Stage everything new
echo ""
echo "=== git stage ==="
git add manifest/ extract/derived-all.jsonl extract/derived.jsonl extract/text-index.jsonl extract/captions.jsonl extract/text/ docs/report.md docs/screenshot-*.png blobs/ extract/build-graph.mjs extract/report.mjs extract/index-all.mjs extract/extract-pdf-text.mjs extract/describe-all-images.mjs crawler/crawl-recursive.mjs crawler/scout-source.mjs dashboard/index.html scripts/finalize.sh 2>&1 | tail -3

# 7. Commit + push
HASH_TOTAL=$(find blobs -type f | wc -l)
TEXT_TOTAL=$(ls extract/text/ 2>/dev/null | wc -l)
DERIVED_COUNT=$(wc -l < extract/derived-all.jsonl 2>/dev/null || echo 0)
CAPS_OK=$(grep -c '"parsed":{' extract/captions.jsonl 2>/dev/null || echo 0)

cat > /tmp/finalize_msg <<EOF
finalize: full multi-source UAP corpus + extraction pipeline

Multi-domain crawl phases 1+2 + extraction pipeline.

Sources crawled:
  www.war.gov         DOW PURSUE Release 01 (war.gov/UFO/)
  www.aaro.mil        Pentagon UAP office: case resolutions, PIA, ORNL,
                      Kona Blue, mission briefs, FOIA series 23-F/24-F/25-F
  vault.fbi.gov       FBI UFO file (16 PDF parts)
  media.defense.gov   DoD CDN UAP releases
  www.cia.gov         CIA reading room UFO collection (paginated)
  science.nasa.gov    NASA UAP independent study report + supporting docs
  catalog.archives.gov  NARA UAP record IDs

Corpus stats this commit:
  Unique blobs:    $HASH_TOTAL
  Derived rows:    $DERIVED_COUNT
  PDF text files:  $TEXT_TOTAL
  Captioned:       $CAPS_OK

Extraction pipeline:
  - extract/extract-pdf-text.mjs   pdftotext over every PDF blob
  - extract/describe-all-images.mjs  claude vision over every image
  - extract/index-all.mjs          unifies all manifests into derived-all
  - extract/build-graph.mjs        DuckDB entity graph + pdf_text table
  - extract/report.mjs             analytical report → docs/report.md
  - scripts/finalize.sh            idempotent end-to-end pipeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF

git commit -F /tmp/finalize_msg 2>&1 | tail -5
git push 2>&1 | tail -5

echo ""
echo "=== finalize done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
