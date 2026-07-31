// A dependency-free PNG reader, for assertions about what is actually PAINTED.
//
// Why this exists: the session-group frame bug (Dan 2026-07-31) survived three
// different proxies. `getComputedStyle` said the border was there — it was.
// Geometry said it had room — it did. `elementFromPoint` returns the sash even
// when the sash is transparent, because hit-testing is not painting. The only
// statement that matched what Dan could see was "this column of pixels is
// bright", so a test that means it has to read pixels.
//
// Playwright screenshots are 8-bit non-interlaced RGBA, which is the only shape
// handled here — anything else throws rather than guessing.
import fs from 'fs';
import zlib from 'zlib';

export interface Decoded {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

export function decodePng(file: string): Decoded {
  const buf = fs.readFileSync(file);
  let pos = 8; // signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`png: bit depth ${bitDepth} unsupported`);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`png: color type ${colorType} unsupported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? out[(y - 1) * stride + i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Perceived luminance (0–255) of every pixel in one row, left to right. */
export function rowLuminance(png: Decoded, row: number): number[] {
  const stride = png.width * png.channels;
  const out: number[] = [];
  for (let x = 0; x < png.width; x++) {
    const i = row * stride + x * png.channels;
    out.push(0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]);
  }
  return out;
}
