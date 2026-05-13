// Generate public/og-default.png (1200x630) — branded social-share card.
// Used as og:image for the homepage + as fallback for doc pages without a thumbnail.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const OUT = path.join(ROOT, 'public', 'og-default.png');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0c0f"/>
      <stop offset="100%" stop-color="#15171c"/>
    </linearGradient>
    <radialGradient id="glow" cx="80%" cy="20%" r="50%">
      <stop offset="0%" stop-color="#d97757" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#d97757" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- Grid pattern -->
  <g stroke="#1c1f25" stroke-width="1" opacity="0.6">
    ${Array.from({length: 13}, (_, i) => `<line x1="${i*100}" y1="0" x2="${i*100}" y2="630"/>`).join('')}
    ${Array.from({length: 7}, (_, i) => `<line x1="0" y1="${i*100}" x2="1200" y2="${i*100}"/>`).join('')}
  </g>

  <!-- Brand dot -->
  <circle cx="80" cy="100" r="11" fill="#d97757"/>
  <text x="105" y="108" font-family="ui-sans-serif, system-ui, -apple-system, Inter, sans-serif" font-size="32" font-weight="700" fill="#faf9f5">UAP Files</text>
  <text x="105" y="138" font-family="ui-monospace, 'JetBrains Mono', monospace" font-size="13" fill="#8a8f99" letter-spacing="2">DECLASSIFIED · TRANSLATED · CONNECTED</text>

  <!-- Headline -->
  <text x="80" y="280" font-family="ui-sans-serif, system-ui, -apple-system, Inter, sans-serif" font-size="64" font-weight="700" fill="#faf9f5" letter-spacing="-1">178 declassified</text>
  <text x="80" y="358" font-family="ui-sans-serif, system-ui, -apple-system, Inter, sans-serif" font-size="64" font-weight="700" fill="#faf9f5" letter-spacing="-1">US government UAP</text>
  <text x="80" y="436" font-family="ui-sans-serif, system-ui, -apple-system, Inter, sans-serif" font-size="64" font-weight="700" fill="#d97757" letter-spacing="-1">documents.</text>

  <!-- Sub-line -->
  <text x="80" y="510" font-family="ui-sans-serif, system-ui, -apple-system, Inter, sans-serif" font-size="22" fill="#b3b6bd">Plain-English summaries · source-cited · map · connection graph</text>

  <!-- URL -->
  <text x="80" y="575" font-family="ui-monospace, 'JetBrains Mono', monospace" font-size="16" fill="#8a8f99">ufo-wheat.vercel.app</text>

  <!-- Decorative scan-lines -->
  <g opacity="0.18">
    <line x1="900" y1="120" x2="1170" y2="120" stroke="#d97757" stroke-width="2"/>
    <line x1="940" y1="155" x2="1130" y2="155" stroke="#d97757" stroke-width="1"/>
    <line x1="970" y1="180" x2="1100" y2="180" stroke="#d97757" stroke-width="1"/>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9, quality: 92 }).toFile(OUT);
const stat = await fs.stat(OUT);
console.log(`og-default.png → ${(stat.size/1024).toFixed(1)} KB`);
