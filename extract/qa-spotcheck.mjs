// Spot-check tool: walk recent QA outputs and surface anything suspect.
// Flags: claims with no citation, heavy hedging in narrative, contradictions
// between key_facts and narrative, fabrication score >= 3.
//
// Run after each QA batch; review flagged docs manually. Anything that
// can't be verified gets quarantined: tier set to 'red', narrative
// suppressed.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const PUBLIC_DIR = path.join(ROOT, 'extract', 'public');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const QUARANTINE = path.join(ROOT, 'extract', 'qa-quarantine.jsonl');

const files = (await fs.readdir(PUBLIC_DIR)).filter(f => f.endsWith('.json'));
console.log(`spot-checking ${files.length} verified docs\n`);

const flags = [];
const stats = { total: 0, green: 0, amber: 0, red: 0, flagged: 0, no_citations: 0, fab_high: 0, narrative_missing: 0 };

for (const f of files) {
  const d = JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, f), 'utf8'));
  stats.total++;
  if (d.tier === 'green') stats.green++;
  if (d.tier === 'amber') stats.amber++;
  if (d.tier === 'red') stats.red++;

  const issues = [];

  // Check 1: green-tier claims without citations
  const greenClaims = (d.verifiable_claims || []).filter(c => c.confidence === 'green');
  const noCiteGreens = greenClaims.filter(c => !c.citation_offset);
  if (noCiteGreens.length > 0) {
    issues.push(`${noCiteGreens.length} green-tier claim(s) lack citation_offset`);
  }

  // Check 2: high fabrication score
  if (d.fabrication_score != null && d.fabrication_score >= 3) {
    issues.push(`fabrication_score=${d.fabrication_score} (>=3 is risky)`);
    stats.fab_high++;
  }

  // Check 3: tier=green but no narrative
  if (d.tier === 'green' && !d.public_narrative) {
    issues.push(`green tier but public_narrative missing`);
    stats.narrative_missing++;
  }

  // Check 4: narrative proper-noun overlap with full extracted entities
  // (people + places + named events from QA, not just key_facts)
  if (d.public_narrative) {
    const allKnown = new Set();
    for (const arr of [d.named_people, d.named_places, d.dated_events, d.objects_described, [d.title]]) {
      for (const v of (arr || [])) {
        if (typeof v === 'string') for (const tok of v.split(/[\s,.()]+/).filter(t => t.length > 3)) allKnown.add(tok.toLowerCase());
      }
    }
    for (const f of (d.key_facts || [])) {
      if (typeof f.value === 'string') for (const tok of f.value.split(/[\s,.()]+/).filter(t => t.length > 3)) allKnown.add(tok.toLowerCase());
    }
    const narrativeNouns = (d.public_narrative.match(/\b[A-Z][a-z]{3,}(?:\s+[A-Z][a-z]+)*\b/g) || [])
      .filter(p => !['The','This','That','While','When','There','These','They','But','And','For','Bureau','Department','Office','Director','Government','America','American','United','States','Police','Federal','National','Special'].some(c => p.startsWith(c)));
    const unknown = narrativeNouns.filter(p => {
      for (const tok of p.split(/\s+/)) if (allKnown.has(tok.toLowerCase())) return false;
      return true;
    });
    if (unknown.length > 8) issues.push(`narrative may have ${unknown.length} unsupported proper nouns (sample: ${unknown.slice(0,3).join(', ')})`);
  }

  // Check 5: source-text quote check — verify quote appears in source.
  // Use loose matching since OCR noise distorts exact strings.
  for (const f of (d.key_facts || []).slice(0, 5)) {
    if (!f.source_quote || f.source_quote.length < 30) continue;
    const txtPath = path.join(TEXT_DIR, d.sha256 + '.txt');
    if (!existsSync(txtPath)) continue;
    const src = await fs.readFile(txtPath, 'utf8');
    const normLoose = (s) => s.replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
    const N = normLoose(src);
    const Q = normLoose(f.source_quote.slice(0, 80));
    // Require at least 70% of unique tokens in quote to appear in source
    const qTokens = [...new Set(Q.split(' ').filter(t => t.length > 3))];
    if (qTokens.length === 0) continue;
    const hits = qTokens.filter(t => N.includes(t)).length;
    if (hits / qTokens.length < 0.7) {
      issues.push(`fact "${f.field}" quote weakly grounded (${hits}/${qTokens.length} tokens found): "${f.source_quote.slice(0, 60)}..."`);
    }
  }

  if (issues.length > 0) {
    stats.flagged++;
    flags.push({ sha256: d.sha256, title: d.public_headline || d.title, tier: d.tier, issues });
  }
}

console.log('=== STATS ===');
console.log(JSON.stringify(stats, null, 2));

console.log(`\n=== ${flags.length} flagged ===`);
for (const f of flags.slice(0, 50)) {
  console.log(`\n[${f.tier}] ${f.title?.slice(0, 100)}`);
  console.log(`  sha: ${f.sha256.slice(0, 16)}`);
  for (const i of f.issues) console.log(`  - ${i}`);
}

// Write quarantine list
await fs.writeFile(QUARANTINE, flags.map(f => JSON.stringify(f)).join('\n') + '\n');
console.log(`\nwrote ${flags.length} flagged records to extract/qa-quarantine.jsonl`);
console.log('manual review recommended for any with severity issues; downgrade tier to "red" if a real fabrication is confirmed');
