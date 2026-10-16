import { describe, expect, test } from "bun:test";
import { iconRoutes } from "../src/web/favicon";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
};

describe("icon routes", () => {
  const app = iconRoutes();

  test("/favicon.ico holds the icon at 24 and 48 px as PNG entries", async () => {
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    const b = new Uint8Array(await res.arrayBuffer());
    const v = new DataView(b.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 2]);
    const entries = [0, 1].map((i) => ({ size: b[6 + 16 * i]!, length: v.getUint32(14 + 16 * i, true), offset: v.getUint32(18 + 16 * i, true) }));
    expect(entries.map((e) => e.size)).toEqual([24, 48]);
    for (const e of entries) {
      const image = b.subarray(e.offset, e.offset + e.length);
      expect([...image.subarray(0, 8)]).toEqual(PNG);
      expect(pngSize(image)).toEqual([e.size, e.size]);
    }
  });

  test("/apple-touch-icon.png is a 180 px PNG", async () => {
    const res = await app.request("/apple-touch-icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const b = new Uint8Array(await res.arrayBuffer());
    expect([...b.subarray(0, 8)]).toEqual(PNG);
    expect(pngSize(b)).toEqual([180, 180]);
  });
});
