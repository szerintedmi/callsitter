// Renders the site icon (src/web/favicon.ts) to PNGs and a favicon.ico in assets/: the YouTube profile
// picture and app icons. `bun run brand-icons`. Cells scale by whole pixels with no smoothing, so the
// pixel art stays hard-edged.
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { COLORS, GRID } from "../src/web/favicon";

const INK = COLORS.K!;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The grid at `cell` px per pixel, centred on a `size` square over `bg` (undefined: transparent). */
function render(grid: string[], cell: number, size: number, bg?: string): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const back = bg ? [...rgb(bg), 255] : [0, 0, 0, 0];
  for (let i = 0; i < size * size; i++) px.set(back, i * 4);
  const off = Math.floor((size - grid.length * cell) / 2);
  grid.forEach((row, gy) =>
    [...row].forEach((c, gx) => {
      const color = COLORS[c];
      if (!color) return;
      const v = [...rgb(color), 255];
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) px.set(v, ((off + gy * cell + y) * size + off + gx * cell + x) * 4);
    }),
  );
  return png(size, px);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
/** An RGBA PNG. */
function png(size: number, rgba: Buffer) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** An .ico holding PNG images (every current browser reads PNG entries). */
function ico(images: { size: number; data: Buffer }[]) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size % 256, e);
    head.writeUInt8(size % 256, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.data)]);
}

// YouTube crops the 800×800 upload to a circle, so the octagon keeps a margin and an opaque ink back.
const OUT = {
  "callsitter-youtube.png": render(GRID, 28, 800, INK),
  "callsitter-512.png": render(GRID, 21, 512),
  "apple-touch-icon.png": render(GRID, 7, 180, INK),
  "favicon.ico": ico([1, 2].map((k) => ({ size: 24 * k, data: render(GRID, k, 24 * k) }))),
};
mkdirSync("assets", { recursive: true });
for (const [name, data] of Object.entries(OUT)) {
  await Bun.write(`assets/${name}`, data);
  console.log(`assets/${name}`);
}
