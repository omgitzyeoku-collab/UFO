// Build extract/transcripts-search.json — a compact { sha: lowercased-text }
// map so the main search box can match against audio/video transcript content.
// This is what makes the Apollo 12 "streaks of light" line findable.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DIR = path.join(ROOT, 'extract', 'transcripts');
const OUT = path.join(ROOT, 'extract', 'transcripts-search.json');

const map = {};
let count = 0, totalChars = 0;
try {
  for (const f of await fs.readdir(DIR)) {
    if (!f.endsWith('.json')) continue;
    const sha = f.replace(/\.json$/, '');
    try {
      const tr = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8'));
      const text = (tr.text || (tr.segments || []).map(s => s.text).join(' ') || '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      if (text.length > 20) { map[sha] = text; count++; totalChars += text.length; }
    } catch {}
  }
} catch {}

await fs.writeFile(OUT, JSON.stringify(map));
console.log(`transcripts-search.json: ${count} transcripts, ${(totalChars/1024).toFixed(0)} KB of text`);
