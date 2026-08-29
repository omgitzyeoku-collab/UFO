// Single source of truth for where the QA pipeline's per-document output lives.
//
// The QA outputs are written to extract/public/ locally, but that path is
// gitignored (.gitignore:44). What is committed to the repo is the deployed
// mirror, public/extract/public/. A build environment that only has the git
// checkout — a GitHub Actions runner, a Vercel build — therefore finds nothing
// at the primary path.
//
// Every consumer that resolved this path on its own got it wrong at least
// once. build-corpus.mjs was fixed after it silently shipped a corpus with
// every verification badge erased; build-doc-pages.mjs, build-entity-pages.mjs
// and build-qa-index.mjs kept the single-path version and went on writing
// QA-less output from CI — 851 verified badges and 422 human headlines missing
// from the crawler-visible pages while the app itself still looked correct.
//
// Import from here. Do not re-derive the path.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');

export const QA_DIR_CANDIDATES = [
  path.join(ROOT, 'extract', 'public'),
  path.join(ROOT, 'public', 'extract', 'public'),
];

/** First candidate that exists and actually holds QA JSON; else the primary. */
export function resolveQaDir(candidates = QA_DIR_CANDIDATES) {
  const found = candidates.find(d => {
    try { return existsSync(d) && readdirSync(d).some(f => f.endsWith('.json')); }
    catch { return false; }
  });
  return found || candidates[0];
}

export const QA_DIR = resolveQaDir();

/**
 * Refuse to write output that has silently lost its verification data.
 *
 * Building with QA_DIR unresolved does not throw — it just yields _qa:null for
 * every document, which erases the badges AND republishes the summaries the
 * site promises to withhold. That has shipped to production twice. It has to
 * be loud, and it has to abort *before* the write loop, not after.
 *
 * @param {number} resolved  docs that found a QA file
 * @param {number} total     docs considered
 * @param {string} label     script name, for the error message
 * @param {number} minRatio  floor below which we abort
 */
export function assertQaCoverage(resolved, total, label, minRatio = 0.5) {
  // total === 0 is never a legitimate build. Passing it silently is how a
  // truncated or unreadable manifest gets treated as success by every caller.
  if (total === 0) {
    console.error(`FATAL (${label}): zero documents to build.`);
    console.error('An empty manifest is never valid — refusing to continue.');
    process.exit(1);
  }
  if (resolved < total * minRatio) {
    console.error(`FATAL (${label}): only ${resolved}/${total} docs resolved a QA summary.`);
    console.error(`  looked in:  ${QA_DIR}`);
    console.error(`  candidates: ${QA_DIR_CANDIDATES.join(', ')}`);
    console.error('Refusing to write — the output would drop every verification tier');
    console.error('and publish unverified summaries. Fix the QA path, then rebuild.');
    process.exit(1);
  }
}
