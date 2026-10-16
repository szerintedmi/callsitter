import { Hono } from "hono";

// The site icon: a ringing phone handset on an amber octagon (a stop sign for calls), 24×24.
// A = amber, K = ink (the site palette); "." is transparent. The handset and its waves are the white
// shapes of the "Software_Telephone_Call_Handset_Signal_Ringing" sprite from the 1-bit Pixel Icons
// pack, unscaled: show the icon only at whole multiples of 24 px, or the pixels smear.
export const GRID = [
  ".......AAAAAAAAAA.......",
  "......AAAAAAAAAAAA......",
  ".....AAAAAAAAAAAAAA.....",
  "....AAAAAAAAAAAAAAAA....",
  "...AAAAAAAAAAAAAAAAAA...",
  "..AAAAAAAAAAAAAAAAAAAA..",
  ".AAAAAAAAKKKAAAKAAAAAAA.",
  "AAAAAAAAKAAAAAKKKAAAAAAA",
  "AAAAAAAKAAKKAKKKKAAAAAAA",
  "AAAAAAKAAKAAAKKKKAAAAAAA",
  "AAAAAAKAKAAAAAKKKAAAAAAA",
  "AAAAAAKAKAAAAAKKKAAAAAAA",
  "AAAAAAAAAAAAAKKKAAAAAAAA",
  "AAAAAAAAKKAAKKKKAAAAAAAA",
  "AAAAAAAKKKKKKKKAAAAAAAAA",
  "AAAAAAKKKKKKKKAAAAAAAAAA",
  "AAAAAAAKKKKKAAAAAAAAAAAA",
  ".AAAAAAAAAAAAAAAAAAAAAA.",
  "..AAAAAAAAAAAAAAAAAAAA..",
  "...AAAAAAAAAAAAAAAAAA...",
  "....AAAAAAAAAAAAAAAA....",
  ".....AAAAAAAAAAAAAA.....",
  "......AAAAAAAAAAAA......",
  ".......AAAAAAAAAA.......",
];
export const COLORS: Record<string, string> = { A: "#ffb000", K: "#0e0d10" };

/** One path per color, each row's runs as rectangles. */
function svg() {
  const paths = Object.entries(COLORS).map(([key, fill]) => {
    let d = "";
    GRID.forEach((row, y) => {
      for (const m of row.matchAll(new RegExp(`${key}+`, "g"))) d += `M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`;
    });
    return `<path fill="${fill}" d="${d}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.length} ${GRID.length}" shape-rendering="crispEdges">${paths.join("")}</svg>`;
}

/** A data URI for `<link rel="icon">`: the pages' icon needs no request. */
export const favicon = `data:image/svg+xml,${encodeURIComponent(svg())}`;

/** The same icon beside the CALLSITTER wordmark; `.logo` sets its size (keep it a multiple of 24 px). */
export const logo = `<img class="logo" src="${favicon}" alt="">`;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The icon as a PNG: `cell` px per grid pixel, centred on a `size` square over `bg` (default
 * transparent). Whole-pixel cells with no smoothing, so the pixel art stays hard-edged. */
export async function iconPng(cell: number, size: number, bg?: string): Promise<Uint8Array> {
  const px = new Uint8Array(size * size * 4);
  const back = bg ? [...rgb(bg), 255] : [0, 0, 0, 0];
  for (let i = 0; i < size * size; i++) px.set(back, i * 4);
  const off = Math.floor((size - GRID.length * cell) / 2);
  GRID.forEach((row, gy) =>
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

/** favicon.ico: the icon at 24 and 48 px, as PNG entries (every current browser reads them). */
export async function iconIco(): Promise<Uint8Array> {
  const images = await Promise.all([1, 2].map(async (k) => ({ size: 24 * k, data: await iconPng(k, 24 * k) })));
  const head = new Uint8Array(6 + 16 * images.length);
  const v = new DataView(head.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, images.length, true);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    v.setUint8(e, size % 256);
    v.setUint8(e + 1, size % 256);
    v.setUint16(e + 4, 1, true);
    v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, data.length, true);
    v.setUint32(e + 12, offset, true);
    offset += data.length;
  });
  return concat([head, ...images.map((im) => im.data)]);
}

/** `/favicon.ico` (crawlers and older browsers ask for it) and `/apple-touch-icon.png` (iOS home
 * screens: opaque, on ink), built from the grid on first request. */
export function iconRoutes() {
  const app = new Hono();
  const cached = (make: () => Promise<Uint8Array>) => {
    let p: Promise<Uint8Array> | undefined;
    return () => (p ??= make());
  };
  const ico = cached(iconIco);
  const touch = cached(() => iconPng(7, 180, COLORS.K));
  const headers = (type: string) => ({ "Content-Type": type, "Cache-Control": "public, max-age=86400" });
  app.get("/favicon.ico", async (c) => c.body((await ico()) as Uint8Array<ArrayBuffer>, 200, headers("image/x-icon")));
  app.get("/apple-touch-icon.png", async (c) => c.body((await touch()) as Uint8Array<ArrayBuffer>, 200, headers("image/png")));
  return app;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array) {
  const body = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(body.length + 8);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(body, 4);
  v.setUint32(body.length + 4, crc32(body));
  return out;
}
/** An RGBA PNG; zlib-compressed with the web's CompressionStream, which Workers have too. */
async function png(size: number, rgba: Uint8Array) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zipped), chunk("IEND", new Uint8Array(0))]);
}
