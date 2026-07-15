// Generates placeholder icon/splash PNGs with zero dependencies (node zlib).
// Design: dark navy field, stylised ring + bar (roundel-ish, deliberately not
// the trademarked TfL roundel). Rerun: node gen-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, w, h, pixelFn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const o = rowStart + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(DIR, file), png);
  console.log(`${file}: ${w}x${h}, ${png.length} bytes`);
}

const BG = [10, 14, 26];       // #0A0E1A
const RING = [77, 107, 255];   // #4D6BFF accentBright
const BAR = [0, 25, 168];      // #0019A8 accent
const HAND = [255, 255, 255];  // clock hands + centre dot

function segDist(dx, dy, hx, hy) {
  const len2 = hx * hx + hy * hy;
  let t = (dx * hx + dy * hy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = dx - t * hx, ey = dy - t * hy;
  return Math.sqrt(ex * ex + ey * ey);
}

// P1 roundel-clock (chosen 15-Jul-2026): purple ring, deep-blue bar,
// white hour hand to 12 + minute hand to ~4, white centre dot.
function mark(x, y, cx, cy, s) {
  const dx = x - cx, dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < s * 0.0375) return HAND; // centre dot
  if (segDist(dx, dy, 0, -s * 0.242) < s * 0.027) return HAND;        // hour hand -> 12
  if (segDist(dx, dy, s * 0.179, s * 0.104) < s * 0.021) return HAND; // minute hand -> ~4
  const barHalfH = s * 0.0875, barHalfW = s * 0.467;
  if (Math.abs(dy) < barHalfH && Math.abs(dx) < barHalfW) return BAR;
  if (d > s * 0.28 && d < s * 0.42) return RING;
  return BG;
}

writePng('icon.png', 1024, 1024, (x, y) => mark(x, y, 512, 512, 1024 * 0.78));
writePng('adaptive-icon.png', 1024, 1024, (x, y) => mark(x, y, 512, 512, 1024 * 0.6));
writePng('splash.png', 1284, 2778, (x, y) => mark(x, y, 642, 1389, 700));
