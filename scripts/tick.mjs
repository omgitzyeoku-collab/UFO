import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const SKIP_DESCRIBE = process.env.SKIP_DESCRIBE === '1';
const SKIP_PUSH     = process.env.SKIP_PUSH === '1';
const SKIP_ALERT    = process.env.SKIP_ALERT === '1';

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
  return r.status ?? -1;
}

function runCapture(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, shell: process.platform === 'win32', ...opts });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { exit: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const startedAt = new Date().toISOString();

// 1. Crawl
const crawlExit = run('node', ['crawler/crawl.mjs']);
if (crawlExit !== 0) {
  console.error(`crawler exited ${crawlExit}`);
  process.exit(crawlExit);
}

// 2. Parse filenames
run('node', ['extract/parse-filenames.mjs']);

// 3. Sign manifest
run('node', ['manifest/sign.mjs']);

// 4. Diff. Three-state contract:
//      0 = no corpus change
//      2 = corpus change detected
//      anything else = the diff could not be trusted (incomparable pair, crash)
// Anything outside {0, 2} must NOT fall through to the no-change branch — that
// would commit and push a "routine snapshot" off a comparison the differ itself
// rejected.
const diffExit = run('node', ['manifest/diff.mjs']);
if (diffExit !== 0 && diffExit !== 2) {
  console.error(`manifest/diff.mjs exited ${diffExit} — the comparison is not trustworthy.`);
  console.error('Refusing to commit a snapshot off a rejected diff.');
  process.exit(diffExit);
}
const changesDetected = diffExit === 2;

// 5. If new assets appeared, describe them too (idempotent — describe-images skips already-captioned sha256s)
if (changesDetected && !SKIP_DESCRIBE) {
  console.log('\n=== DESCRIBING NEW ASSETS ===');
  run('node', ['extract/describe-images.mjs']);
}

// 5b. Rebuild entity graph + report (cheap, idempotent — run every tick to stay current)
console.log('\n=== REBUILDING ENTITY GRAPH + REPORT ===');
run('node', ['extract/build-graph.mjs']);
run('node', ['extract/report.mjs']);

// 6. Commit + push every tick (NOT just on change). Reasons:
//    - Per-crawl manifest snapshots are written every run and worth committing for audit trail
//    - Signed sidecar updates every run too
//    - last-diff.json captures even no-op runs
//    - Push lag costs nothing; push staleness costs everything
if (!SKIP_PUSH) {
  console.log('\n=== COMMIT + PUSH ===');
  // Stage everything tracked-or-new under manifest/, extract/, docs/
  run('git', ['add', '-A', 'manifest/', 'extract/', 'docs/']);
  const status = runCapture('git', ['status', '--porcelain']);
  const hasChanges = status.stdout.trim().length > 0;
  if (!hasChanges) {
    console.log('  (working tree clean — nothing to commit)');
  } else {
    let title;
    if (changesDetected) {
      const diff = JSON.parse(await fs.readFile(path.join(ROOT, 'manifest', 'last-diff.json'), 'utf8'));
      title = `tick: war.gov/UFO/ change detected (+${diff.summary.added} -${diff.summary.removed} ~${diff.summary.changed})`;
    } else {
      title = `tick: routine snapshot ${startedAt.slice(0, 16)}`;
    }
    const body = `Automated daily snapshot. Crawl started ${startedAt}.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`;
    const msg = `${title}\n\n${body}\n`;
    // Write message to a temp file (multiline -m args break under shell: true on Windows)
    const msgFile = path.join(ROOT, '.git', 'TICK_COMMIT_MSG');
    await fs.writeFile(msgFile, msg);
    const commit = run('git', ['commit', '-F', msgFile]);
    await fs.unlink(msgFile).catch(() => {});
    if (commit !== 0) {
      console.error(`git commit exited ${commit}`);
    } else {
      const push = run('git', ['push', 'origin', 'HEAD']);
      if (push !== 0) {
        console.error(`git push exited ${push} — left committed locally; will retry next tick`);
      } else {
        console.log('  pushed to origin');
      }
    }
  }
}

// 7. Alert if changes (diff exit code 2 = changes detected)
if (changesDetected && !SKIP_ALERT) {
  console.log('\n=== CHANGES DETECTED — ALERTING ===');
  const diffPath = path.join(ROOT, 'manifest', 'last-diff.json');
  const diff = JSON.parse(await fs.readFile(diffPath, 'utf8'));
  const summary = `UFO archive change at ${startedAt}: +${diff.summary.added} added, -${diff.summary.removed} removed, ~${diff.summary.changed} hash-changed.`;
  console.log(summary);
  // Route to Vega via claude -p (per CLAUDE.md, claude -p is the sanctioned runtime LLM path)
  // Vega's Telegram push tool will handle delivery
  const prompt = `An automated UFO archive monitor at C:/Users/Yeoku/UFO detected changes on war.gov/UFO/.

Diff summary: ${JSON.stringify(diff.summary)}

Added URLs: ${diff.added.map(a => a.url).slice(0, 20).join(', ') || '(none)'}
Removed URLs: ${diff.removed.map(a => a.url).slice(0, 20).join(', ') || '(none)'}
Hash-changed URLs: ${diff.changed.map(c => c.url).slice(0, 20).join(', ') || '(none)'}

Push a single Telegram message via vega-push__push_to_user that summarises this in <= 3 lines, including the count of changes by category and the first 3 affected URLs. Do not run additional crawling. Reply with the push outcome.`;

  run('claude', ['-p', '--dangerously-skip-permissions', prompt]);
}

console.log(`\n=== TICK COMPLETE @ ${new Date().toISOString()} ===`);
