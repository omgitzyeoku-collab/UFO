import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
  return r.status ?? -1;
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

// 4. Diff
const diffExit = run('node', ['manifest/diff.mjs']);

// 5. Alert if changes (diff exit code 2 = changes detected)
if (diffExit === 2) {
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
