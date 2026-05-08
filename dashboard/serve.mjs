import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = process.env.PORT || 4173;
const ROOT = path.resolve('..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

async function detectImageType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/dashboard/index.html';
    const fp = path.normalize(path.join(ROOT, urlPath));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const stat = await fs.stat(fp).catch(() => null);
    if (!stat || !stat.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(fp).toLowerCase();
    let type = TYPES[ext];
    const buf = await fs.readFile(fp);
    if (!type) type = (await detectImageType(buf)) || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch (e) {
    res.writeHead(500); res.end(`error: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`UFO archive dashboard: http://localhost:${PORT}/`);
});
