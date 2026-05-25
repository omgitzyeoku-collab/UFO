// Build extract/qa-index.json — list of sha256s that have a QA output
// in extract/public/<sha>.json. Loaded once at site startup so we only
// fetch the JSONs that actually exist (currently 159 of the 266 docs
// have no QA output yet — fetching them all yields 404 spam).

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const PUBLIC = path.join(ROOT, 'extract', 'public');
const OUT = path.join(ROOT, 'extract', 'qa-index.json');

const files = await fs.readdir(PUBLIC);
const shas = files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
shas.sort();

await fs.writeFile(OUT, JSON.stringify({ shas, count: shas.length, generated_at: new Date().toISOString() }, null, 0));
console.log(`qa-index: ${shas.length} docs have QA output`);
