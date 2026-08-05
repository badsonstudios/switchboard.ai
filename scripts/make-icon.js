// PLACEHOLDER app icon generator (P2-E19-01).
//
// `build/icon.ico` is committed, not generated at build time — electron-builder
// wants the file to exist before it starts, and a build step that draws an icon
// is a build step that can fail. This script exists so the committed bytes have
// a PROVENANCE: nobody downloaded them, and anyone can reproduce or tweak them
// with `node scripts/make-icon.js`.
//
// It is deliberately a placeholder: three pairs of jacks with one patch cable
// across them, in the nordic palette the app already ships. Real artwork
// replaces `build/icon.ico` and this script goes away with it.
//
// Format notes: an .ico is a 6-byte header, one 16-byte directory entry per
// size, then the images. Each image here is a whole PNG (the Vista-era
// "PNG-compressed entry" the 256px size effectively requires) rather than a
// BMP, which keeps the file small and the encoder to one function. A width or
// height byte of 0 in a directory entry means 256 — the field is one byte, so
// there is no other way to say it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** the sizes Windows actually asks for (taskbar, alt-tab, explorer, installer) */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// nordic palette, same values as the renderer's tokens.css --bg / frost accents
const BG = [0x24, 0x29, 0x33, 0xff];
const JACK = [0x88, 0xc0, 0xd0, 0xff];
const CABLE = [0xa3, 0xbe, 0x8c, 0xff];

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Buffer} rgba raw width*height*4 pixels @returns {Buffer} a PNG file */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12: compression / filter / interlace, all 0

  // one filter byte (0 = None) in front of every scanline
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ the glyph

/**
 * Draw the mark at `size`, antialiased by supersampling 4x and averaging — at
 * 16px a hard-edged circle is a blob, and 16 samples per pixel is cheap for
 * seven images drawn once.
 */
function drawIcon(size) {
  const S = 4; // supersample factor
  const n = size * S;
  const px = Buffer.alloc(size * size * 4);

  // geometry in 0..1 units so every size draws the same picture
  const jacks = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      jacks.push({ x: 0.3 + col * 0.4, y: 0.24 + row * 0.26 });
    }
  }
  const R = 0.075; // jack radius
  const CABLE_HALF = 0.028; // half-thickness of the patch cable

  // the cable runs from the top-left jack to the bottom-right one
  const a = jacks[0];
  const b = jacks[5];

  const distToSegment = (x, y) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
  };

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (pxi * S + sx + 0.5) / n;
          const v = (py * S + sy + 0.5) / n;
          let c = BG;
          if (distToSegment(u, v) < CABLE_HALF) c = CABLE;
          if (jacks.some((j) => Math.hypot(u - j.x, v - j.y) < R)) c = JACK;
          r += c[0];
          g += c[1];
          bl += c[2];
        }
      }
      const i = (py * size + pxi) * 4;
      const samples = S * S;
      px[i] = Math.round(r / samples);
      px[i + 1] = Math.round(g / samples);
      px[i + 2] = Math.round(bl / samples);
      px[i + 3] = 0xff; // fully opaque: Windows draws installer icons on light and dark alike
    }
  }
  return px;
}

// ------------------------------------------------------------------- assembly

function buildIco(sizes) {
  const images = sizes.map((s) => encodePng(drawIcon(s), s, s));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(sizes.length, 4);

  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir[e] = s === 256 ? 0 : s; // 0 means 256 — the field is one byte
    dir[e + 1] = s === 256 ? 0 : s;
    dir[e + 2] = 0; // palette colours (0 = not paletted)
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });

  return Buffer.concat([header, dir, ...images]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
const ico = buildIco(SIZES);
fs.writeFileSync(out, ico);
console.log(`[make-icon] wrote ${out} — ${SIZES.join('/')}px, ${ico.length} bytes`);
