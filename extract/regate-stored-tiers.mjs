#!/usr/bin/env node
/**
 * Re-gate the stored per-document QA files to the corrected rule: green requires
 * at least one key_fact with an exact source-quote citation.
 *
 * The old pipeline awarded green when only amber claims existed, so ~33 stored
 * files carry tier "green" with no exact citation. build-corpus already re-gates
 * this for the live corpus, and hydrateQa now keeps the corpus tier — but the
 * stored files are the canonical QA output and are referenced in the funding
 * application, so a file claiming "green" with no exact quote is exactly the
 * inconsistency this project exists to eliminate. This corrects them in place.
 *
 * Purely deterministic — no model calls, no re-QA. Same demotion build-corpus
 * applies at build time; the fixed pipeline (qa-pipeline.mjs) prevents new ones.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = [
  path.join(ROOT, 'extract', 'public'),           // local (gitignored)
  path.join(ROOT, 'public', 'extract', 'public'), // committed / deployed mirror
].filter(existsSync);

function hasExactQuote(qa) {
  return (qa.key_facts || []).some(f => f.citation_offset && f.citation_offset.exact === true);
}

// The corrected tier, from data already in the file. Mirrors qa-pipeline.mjs.
function correctTier(qa) {
  if (qa.fabrication_score != null && qa.fabrication_score >= 5) return 'red';
  if (hasExactQuote(qa)) return 'green';
  const hasSummary = qa.core_summary || qa.public_tldr;
  return hasSummary ? 'amber' : 'red';
}

let scanned = 0, changed = 0;
const moves = {};

for (const dir of DIRS) {
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(dir, f);
    let qa;
    try { qa = JSON.parse(await fs.readFile(fp, 'utf8')); } catch { continue; }
    if (!qa.tier) continue;
    scanned++;
    const want = correctTier(qa);
    if (want === qa.tier) continue;

    // Only ever tighten: green->amber, green->red, amber->red. Never loosen a tier
    // upward from stored data — that would be the failure mode in reverse.
    const rank = { green: 3, amber: 2, red: 1 };
    if (rank[want] >= rank[qa.tier]) continue;

    const key = `${qa.tier}->${want}`;
    moves[key] = (moves[key] || 0) + 1;
    qa.tier = want;
    // If it fell out of green/amber, its published summary must not survive.
    if (want === 'red') {
      qa.public_headline = null; qa.public_tldr = null;
      qa.public_narrative = null; qa.public_caveats = [];
    }
    await fs.writeFile(fp, JSON.stringify(qa, null, 2));
    changed++;
  }
}

console.log(`scanned ${scanned} stored QA files across ${DIRS.length} dir(s)`);
console.log(`re-gated ${changed}: ${JSON.stringify(moves)}`);
