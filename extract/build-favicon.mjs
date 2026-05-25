// Generate a tiny 32x32 brand-dot favicon (PNG) using sharp's SVG-to-PNG.
// Plus a 192x192 + 512x512 for proper PWA / mobile homescreen support.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const PUB = path.join(ROOT, 'public');

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0b0c0f"/>
  <circle cx="50" cy="50" r="22" fill="#d97757"/>
  <circle cx="50" cy="50" r="6" fill="#0b0c0f"/>
</svg>`;

await sharp(Buffer.from(svg(32))).png({ compressionLevel: 9 }).resize(32, 32).toFile(path.join(PUB, 'favicon.png'));
await sharp(Buffer.from(svg(192))).png({ compressionLevel: 9 }).resize(192, 192).toFile(path.join(PUB, 'icon-192.png'));
await sharp(Buffer.from(svg(512))).png({ compressionLevel: 9 }).resize(512, 512).toFile(path.join(PUB, 'icon-512.png'));
// ICO: just rename favicon.png to .ico (browsers accept PNG-as-ICO from modern hosts)
await fs.copyFile(path.join(PUB, 'favicon.png'), path.join(PUB, 'favicon.ico'));

console.log('favicons written: favicon.{png,ico}, icon-192.png, icon-512.png');
