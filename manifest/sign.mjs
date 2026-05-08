import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MANIFEST_DIR = path.resolve('manifest');
const latest = path.join(MANIFEST_DIR, 'latest.jsonl');

const stat = await fs.stat(latest).catch(() => null);
if (!stat) {
  console.error('no manifest/latest.jsonl to sign — run a crawl first');
  process.exit(1);
}

const buf = await fs.readFile(latest);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log(`manifest sha256: ${sha}`);
console.log(`manifest bytes:  ${buf.length}`);

// Try to detect a signing key. If none, write a sha256 sidecar (still verifiable, just not GPG-signed).
const keys = spawnSync('gpg', ['--list-secret-keys', '--with-colons'], { encoding: 'utf8' });
const hasKey = keys.status === 0 && /^sec:/m.test(keys.stdout);

if (hasKey) {
  console.log('GPG secret key found, signing...');
  const out = path.join(MANIFEST_DIR, 'latest.jsonl.asc');
  const sig = spawnSync('gpg', ['--batch', '--yes', '--armor', '--detach-sign', '--output', out, latest], { stdio: 'inherit' });
  if (sig.status !== 0) {
    console.error('gpg sign failed');
    process.exit(2);
  }
  console.log(`signature: ${out}`);
} else {
  console.log('no GPG secret key configured — writing sha256 sidecar instead');
  const sidecar = {
    manifest_file: 'latest.jsonl',
    sha256: sha,
    bytes: buf.length,
    generated_at: new Date().toISOString(),
    note: 'unsigned content hash. set up gpg --gen-key to enable detached signing.',
  };
  await fs.writeFile(path.join(MANIFEST_DIR, 'latest.jsonl.sha256.json'), JSON.stringify(sidecar, null, 2));
  console.log(`sidecar: manifest/latest.jsonl.sha256.json`);
}
