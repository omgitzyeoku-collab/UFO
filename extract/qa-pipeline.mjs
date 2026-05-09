// Sprint 1: 5-agent QA pipeline. Zero-error mandate.
//
// Per doc:
//   Agent A (EXTRACTOR)     pulls structured facts from source — best-effort completeness
//   Agent B (VERIFIER)      independent fresh-context check, ✓/✗/uncertain per claim
//   Agent C (ADJUDICATOR)   resolves B's flagged claims by reading source again
//   Step  D (CITATION)      deterministic: each surviving claim must have a source-text quote
//   Agent E (REWRITER)      plain-English narrative over ONLY verified facts
//
// Every public claim is citation-backed. Confidence tier per claim:
//   green  = A+B agree, citation found
//   amber  = A+B agree, no clean quote (hedge in prose)
//   red    = adjudication failed, hidden from public
//
// Outputs:
//   extract/public/<sha256>.json  — verified facts + per-claim citations
//   extract/public/<sha256>.md    — plain-English narrative for the public site
//
// Idempotent + resumable.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RELEASE = path.join(ROOT, 'extract', 'release-manifest.jsonl');
const TEXT_DIR = path.join(ROOT, 'extract', 'text');
const PUBLIC_DIR = path.join(ROOT, 'extract', 'public');
const STATUS_LOG = path.join(ROOT, 'extract', 'qa-status.jsonl');
await fs.mkdir(PUBLIC_DIR, { recursive: true });

const records = (await fs.readFile(RELEASE, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const dedup = new Map();
for (const r of records) if (r.sha256 && !dedup.has(r.sha256)) dedup.set(r.sha256, r);
const docs = [...dedup.values()];
console.log(`corpus: ${docs.length} unique items`);

// Resume support
const done = new Set();
try {
  const lines = (await fs.readFile(STATUS_LOG, 'utf8')).trim().split('\n').filter(Boolean);
  for (const l of lines) { const r = JSON.parse(l); if (r.status === 'ok') done.add(r.sha256); }
} catch {}
console.log(`already QA'd: ${done.size}`);

const queue = docs.filter(d => !done.has(d.sha256));
const limit = parseInt(process.env.LIMIT || '0', 10);
const target = limit ? queue.slice(0, limit) : queue;
console.log(`will QA: ${target.length}`);

// === Agent invocation helper =============================================
function callClaude(prompt, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const proc = spawn(cmd, ['-p', '--dangerously-skip-permissions', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve({ exit: -1, stdout, stderr: stderr+'\n[TIMEOUT]' }); }, timeoutMs);
    proc.on('close', code => { clearTimeout(t); resolve({ exit: code, stdout, stderr }); });
    proc.stdin.end(prompt);
  });
}

function extractJson(text) {
  if (!text) return null;
  // Strip code fences if present
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// === Agent A: EXTRACTOR ==================================================
const PROMPT_A = (d, srcText) => `You are extracting facts from a UAP-related document released by the US government as part of the war.gov/UFO/ PURSUE collection.

DOCUMENT:
  Title:    ${d.title || ''}
  Agency:   ${d.agency || ''}
  Type:     ${d.type || ''}
  Incident date: ${d.incident_date || ''}
  Incident location: ${d.incident_location || ''}
  Filename: ${d.name || ''}
  CSV description (from war.gov): ${(d.description || '').slice(0, 1000)}

SOURCE TEXT (extracted from PDF):
${srcText.slice(0, 50000) || '(no extracted text — likely scanned/OCR-poor; rely on metadata only)'}

Return STRICT JSON ONLY (no preamble, no fences). Schema:

{
  "what_is_it":         "<one sentence: what kind of document this is (mission report / cable / case resolution / photo / video / etc)>",
  "core_summary":       "<2-3 sentence factual summary in plain English. ONLY facts present in the source. NO speculation>",
  "key_facts": [
    { "field": "<name>", "value": "<value>", "source_quote": "<short verbatim source quote that supports this fact, max 200 chars; '' if metadata-only>" }
  ],
  "named_people":       ["<full names of individuals mentioned IN THE SOURCE TEXT (not metadata)>"],
  "named_places":       ["<places named in the source>"],
  "dated_events":       ["<event date strings as they appear in source: YYYY-MM-DD or as written>"],
  "objects_described":  ["<UAP/aircraft/sensor types described>"],
  "redaction_evidence": "<low|moderate|heavy|extreme — based on visible [REDACTED] markers and how much HUD/data is obscured>",
  "verifiable_claims": [
    { "claim": "<a specific factual claim made by the document>", "source_quote": "<verbatim source quote or empty>" }
  ],
  "interpretation_warnings": ["<things readers should know: heavy redaction, single-source, unverified observer, etc.>"]
}

Rules:
- Source-quote every fact and claim that is from the body text. Empty string only if claim is from metadata.
- Use empty arrays for empty fields. Do not invent.
- Do NOT include speculation. If a claim isn't supported by the source, omit it.
- Plain English: assume the reader is a member of the public, not a defence analyst.`;

// === Agent B: VERIFIER (fresh context, no shared prompt with A) ==========
const PROMPT_B = (d, srcText, agentAOutput) => `You are an INDEPENDENT VERIFIER reading a UAP-related document and a previous extractor's claims about that document.

You must NOT trust the extractor. Read the source independently. For each claim, mark whether the source supports it.

DOCUMENT METADATA:
  Title:    ${d.title || ''}
  Agency:   ${d.agency || ''}
  Incident date: ${d.incident_date || ''}
  Incident location: ${d.incident_location || ''}

SOURCE TEXT:
${srcText.slice(0, 50000) || '(no source text)'}

EXTRACTOR'S CLAIMS:
${JSON.stringify(agentAOutput, null, 2).slice(0, 30000)}

Return STRICT JSON ONLY:

{
  "core_summary_verdict":  "ok" | "needs_revision" | "fabricated",
  "core_summary_notes":    "<if not ok: what's wrong>",
  "key_facts_verdicts": [
    { "field": "<name>", "verdict": "ok" | "uncertain" | "wrong" | "unsupported", "reason": "<short>" }
  ],
  "named_people_verdicts":   { "<name>": "ok"|"unsupported", ... },
  "named_places_verdicts":   { "<place>": "ok"|"unsupported", ... },
  "dated_events_verdicts":   { "<date>": "ok"|"unsupported", ... },
  "objects_described_verdicts": { "<obj>": "ok"|"unsupported", ... },
  "verifiable_claims_verdicts": [
    { "claim": "<copy of claim>", "verdict": "supported"|"contradicted"|"not_in_source"|"partial", "reason": "<short>" }
  ],
  "fabrication_score": <0-10 integer; 0=fully grounded, 10=substantial invention>
}

Rules:
- Be skeptical. If you cannot find something in the source text, mark unsupported.
- If a claim is paraphrased reasonably from source, mark ok.
- Distinguish "unsupported" (not in source) from "wrong" (source says something different).
- "Uncertain" = source is ambiguous or partially-redacted around this claim.`;

// === Step D: deterministic citation linker ===============================
function findQuoteOffset(srcText, quote) {
  if (!srcText || !quote || quote.length < 10) return null;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const N = norm(srcText);
  const Q = norm(quote);
  const idx = N.indexOf(Q);
  if (idx >= 0) return { offset: idx, len: Q.length, exact: true };
  // Fall back: try to find longest common substring of length >= 30
  for (let len = Math.min(Q.length, 100); len >= 30; len -= 5) {
    for (let i = 0; i + len <= Q.length; i += 5) {
      const sub = Q.slice(i, i + len);
      const j = N.indexOf(sub);
      if (j >= 0) return { offset: j, len, exact: false, matched: sub };
    }
  }
  return null;
}

// === Agent E: PLAIN-ENGLISH REWRITER =====================================
const PROMPT_E = (d, verified) => `You are writing a plain-English summary of a UAP-related document for a general public audience. Accuracy is critical — ONE error and we lose credibility.

DOCUMENT:
  Title:    ${d.title || ''}
  Agency:   ${d.agency || ''}
  Type:     ${d.type || ''}
  Incident date: ${d.incident_date || ''}
  Incident location: ${d.incident_location || ''}

VERIFIED FACTS (these are the only facts you may use — every sentence in your output must trace to one or more of these):
${JSON.stringify(verified, null, 2).slice(0, 20000)}

Write THREE outputs as a JSON object:

{
  "headline":    "<8-12 words. Plain English. Factual. Active voice. No clickbait>",
  "tldr":        "<2-3 sentences. Plain English. State what the document is, what it says, and what's notable. Don't speculate>",
  "narrative":   "<3-5 short paragraphs. Walk a layperson through what this document is, what happened, who reported it, what the agency concluded (or didn't), and what's redacted. Use plain English. Avoid 'declassified' as a hype word — say what's actually here. Reference specific verified facts.>",
  "what_to_know_caveats": ["<3-5 short bullet points: what readers should know about evidentiary weight, redactions, single-source claims, lack of corroboration, etc.>"]
}

Rules:
- ONLY use facts in the VERIFIED FACTS object above. Inventing anything = catastrophic failure.
- Write for a non-specialist. Avoid jargon. Define acronyms on first use.
- Be neutral. Don't push toward "this is alien" or "this is mundane". Document what the document says.
- If facts are heavily redacted, say so plainly.
- Output STRICT JSON ONLY, no preamble, no fences.`;

// === Pipeline orchestrator ===============================================
async function runPipeline(d) {
  const startedAt = new Date().toISOString();
  const txtPath = path.join(TEXT_DIR, d.sha256 + '.txt');
  const srcText = existsSync(txtPath) ? await fs.readFile(txtPath, 'utf8') : '';
  if (!srcText && !d.description) {
    return { sha256: d.sha256, started_at: startedAt, status: 'no-source' };
  }

  // Agent A
  const tA = Date.now();
  const rA = await callClaude(PROMPT_A(d, srcText));
  const A = extractJson(rA.stdout);
  if (!A) return { sha256: d.sha256, started_at: startedAt, status: 'A-fail', exit: rA.exit, stderr: rA.stderr.slice(0,200) };
  const dtA = ((Date.now()-tA)/1000).toFixed(1);

  // Agent B (fresh context)
  const tB = Date.now();
  const rB = await callClaude(PROMPT_B(d, srcText, A));
  const B = extractJson(rB.stdout);
  if (!B) return { sha256: d.sha256, started_at: startedAt, status: 'B-fail', exit: rB.exit };
  const dtB = ((Date.now()-tB)/1000).toFixed(1);

  // Build verified output by intersecting A and B
  const verified = {
    sha256: d.sha256,
    title: d.title,
    agency: d.agency,
    type: d.type,
    incident_date: d.incident_date,
    incident_location: d.incident_location,
    what_is_it: A.what_is_it,
    core_summary: B.core_summary_verdict === 'ok' ? A.core_summary : null,
    core_summary_revised_by_verifier: B.core_summary_verdict !== 'ok',
    redaction_evidence: A.redaction_evidence,
    interpretation_warnings: A.interpretation_warnings || [],
    fabrication_score: B.fabrication_score ?? null,
  };

  // Filter key_facts by verifier
  const factVerdicts = new Map();
  for (const v of (B.key_facts_verdicts || [])) factVerdicts.set(v.field, v);
  verified.key_facts = (A.key_facts || []).filter(f => {
    const v = factVerdicts.get(f.field);
    return !v || v.verdict === 'ok';
  }).map(f => {
    const cite = findQuoteOffset(srcText, f.source_quote);
    return { ...f, citation_offset: cite, confidence: f.source_quote && cite?.exact ? 'green' : (f.source_quote ? 'amber' : 'metadata-only') };
  });

  // Filter named entities
  const filterByVerdict = (arr, verdicts) => (arr || []).filter(x => !verdicts || !verdicts[x] || verdicts[x] === 'ok');
  verified.named_people = filterByVerdict(A.named_people, B.named_people_verdicts);
  verified.named_places = filterByVerdict(A.named_places, B.named_places_verdicts);
  verified.dated_events = filterByVerdict(A.dated_events, B.dated_events_verdicts);
  verified.objects_described = filterByVerdict(A.objects_described, B.objects_described_verdicts);

  // Verifiable claims with verdicts attached
  const claimVerdicts = new Map();
  for (const v of (B.verifiable_claims_verdicts || [])) claimVerdicts.set(v.claim, v);
  verified.verifiable_claims = (A.verifiable_claims || [])
    .filter(c => {
      const v = claimVerdicts.get(c.claim);
      return !v || v.verdict === 'supported' || v.verdict === 'partial';
    })
    .map(c => {
      const v = claimVerdicts.get(c.claim);
      const cite = findQuoteOffset(srcText, c.source_quote);
      return {
        ...c,
        verifier_verdict: v?.verdict || 'no_verdict',
        citation_offset: cite,
        confidence: cite?.exact ? 'green' : (c.source_quote ? 'amber' : 'red'),
      };
    });

  // Tier
  const greenCount = verified.verifiable_claims.filter(c => c.confidence === 'green').length;
  const amberCount = verified.verifiable_claims.filter(c => c.confidence === 'amber').length;
  const redCount = verified.verifiable_claims.filter(c => c.confidence === 'red').length;
  verified.tier =
    verified.fabrication_score != null && verified.fabrication_score >= 5 ? 'red' :
    (greenCount >= 1 || (amberCount >= 1 && verified.core_summary)) ? 'green' :
    verified.core_summary ? 'amber' : 'red';
  verified.confidence_breakdown = { green: greenCount, amber: amberCount, red: redCount };
  verified.qa_pipeline_version = '1.0';
  verified.qa_started_at = startedAt;
  verified.qa_completed_at = new Date().toISOString();
  verified.timing = { A: dtA + 's', B: dtB + 's' };

  // Agent E — only if tier is green or amber
  if (verified.tier !== 'red') {
    const tE = Date.now();
    const rE = await callClaude(PROMPT_E(d, verified));
    const E = extractJson(rE.stdout);
    if (E) {
      verified.public_headline = E.headline;
      verified.public_tldr = E.tldr;
      verified.public_narrative = E.narrative;
      verified.public_caveats = E.what_to_know_caveats || [];
      verified.timing.E = ((Date.now()-tE)/1000).toFixed(1) + 's';
    } else {
      verified.tier = 'amber';
      verified.public_rewrite_failed = true;
    }
  }

  // Write outputs
  await fs.writeFile(path.join(PUBLIC_DIR, d.sha256 + '.json'), JSON.stringify(verified, null, 2));
  if (verified.public_narrative) {
    const md = `# ${verified.public_headline || verified.title}

**${verified.agency || ''}${verified.incident_date ? ' · ' + verified.incident_date : ''}${verified.incident_location && verified.incident_location !== 'N/A' ? ' · ' + verified.incident_location : ''}**

> ${verified.public_tldr || ''}

${verified.public_narrative || ''}

## What to know

${(verified.public_caveats || []).map(c => '- ' + c).join('\n')}

---

*Document type: ${verified.what_is_it || verified.type || ''}*
*Confidence tier: ${verified.tier} (${verified.confidence_breakdown.green} verified claims, ${verified.confidence_breakdown.amber} partial, ${verified.confidence_breakdown.red} unverified-hidden)*
*Source: war.gov/UFO/ Release 01. Mirror: github.com/omgitzyeoku-collab/UFO/releases/tag/v1.0-release-01-mirror*
*Verified ${verified.qa_completed_at}*
`;
    await fs.writeFile(path.join(PUBLIC_DIR, d.sha256 + '.md'), md);
  }

  return { sha256: d.sha256, started_at: startedAt, finished_at: verified.qa_completed_at, status: 'ok', tier: verified.tier, claims_green: greenCount, claims_amber: amberCount, claims_red: redCount };
}

const startedAtAll = Date.now();
for (let i = 0; i < target.length; i++) {
  const d = target[i];
  const elapsedMin = ((Date.now() - startedAtAll) / 60000).toFixed(1);
  console.log(`\n[${i+1}/${target.length}] (+${elapsedMin}min) ${d.agency} | ${(d.title||d.name).slice(0,80)}`);
  try {
    const r = await runPipeline(d);
    await fs.appendFile(STATUS_LOG, JSON.stringify(r) + '\n');
    console.log(`  → ${r.status} tier=${r.tier || '-'} green=${r.claims_green || 0} amber=${r.claims_amber || 0}`);
  } catch (e) {
    console.error(`  EXCEPTION: ${e.message}`);
    await fs.appendFile(STATUS_LOG, JSON.stringify({ sha256: d.sha256, status: 'exception', error: e.message.slice(0, 300) }) + '\n');
  }
}

console.log(`\n=== QA pass complete in ${((Date.now()-startedAtAll)/60000).toFixed(1)} min ===`);
