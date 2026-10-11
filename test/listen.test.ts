import { describe, expect, test } from "bun:test";
import { demoMedia } from "../src/runtime/demo-media";
import { DEMOS, listenRoutes, realCallsPage } from "../src/web/listen";
import { publicRoutes, type PublicDeps } from "../src/web/public";
import { loadRepoConfig } from "./helpers";

// The real-call player (/listen): the recorder's page for the listed demos only, media files by
// name only, and Range requests answered, since browsers seek audio with them. The public page
// with the player on top and /listen/<slug>: public.test.ts.

const asked: string[] = [];
const app = listenRoutes({
  clientAssets: async (name) => (name === "listen.js" ? "// page" : undefined),
  media: async (name) => {
    asked.push(name);
    return new Response(name);
  },
});
const get = (path: string, init?: RequestInit) => app.request(`http://x${path}`, init);

describe("listen routes", () => {
  test("the home page: a tab per recording, the player, the game's link", () => {
    const html = realCallsPage("/", { selected: "electrician", autoplay: true, wastedSeconds: 3725, phone: "+44 20 4620 6827" });
    for (const d of DEMOS) expect(html).toContain(`href="/listen/${d.slug}"`);
    expect(html).toContain('"selected":"electrician"');
    expect(html).toContain('"autoplay":true');
    expect(html).toContain(">1:02:05</b>");
    expect(html).toContain('href="/play"');
    expect(html).toContain('href="tel:+442046206827"');
    expect(html).toContain('href="https://github.com/szerintedmi/scamsitter"');
  });

  test("the recorder's page has the stage only", async () => {
    const res = await get("/listen/render/electrician");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"render":true');
    expect(html).not.toContain("<audio");
    expect(html).not.toContain('class="rc-tiles"');
    expect(await (await get("/listen/render/electrician?poster=1")).text()).toContain('"poster":true');
  });

  test("unknown demos and files are not found", async () => {
    expect((await get("/listen/render/nope")).status).toBe(404);
    expect((await get("/listen/media/nope.mp3")).status).toBe(404);
    expect((await get("/listen/media/electrician.wav")).status).toBe(404);
    expect((await get("/listen/media/..%2Fpackage.json")).status).toBe(404);
    expect(asked).toEqual([]);
    expect(await (await get("/listen/media/electrician.json")).text()).toBe("electrician.json");
    expect((await get("/listen/media/electrician.jpg")).status).toBe(404);
  });

  test("the page script is served", async () => {
    expect(await (await get("/assets/listen.js")).text()).toBe("// page");
  });
});

describe("demo media", () => {
  const file = `${DEMOS[0]!.slug}.json`;
  const size = Bun.file(`demos/calls/${file}`).size;
  const req = (range?: string) => new Request("http://x/", { headers: range ? { range } : {} });

  test("whole file without a Range", async () => {
    const res = (await demoMedia(file, req()))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(size);
  });

  test("byte ranges", async () => {
    const mid = (await demoMedia(file, req("bytes=10-19")))!;
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes 10-19/${size}`);
    expect((await mid.arrayBuffer()).byteLength).toBe(10);
    const tail = (await demoMedia(file, req("bytes=-5")))!;
    expect(tail.headers.get("content-range")).toBe(`bytes ${size - 5}-${size - 1}/${size}`);
    const open = (await demoMedia(file, req(`bytes=${size - 3}-`)))!;
    expect((await open.arrayBuffer()).byteLength).toBe(3);
    expect((await demoMedia(file, req(`bytes=${size}-`)))!.status).toBe(416);
  });

  test("missing files", async () => {
    expect(await demoMedia("nope.mp3", req())).toBeUndefined();
  });
});

describe("public page with the real calls", async () => {
  const config = await loadRepoConfig();
  const page = publicRoutes({
    manager: { bus: { subscribe: () => () => {} } } as unknown as PublicDeps["manager"],
    repo: { scores: async () => [], junkCallSeconds: async () => 0 } as unknown as PublicDeps["repo"],
    referee: {} as PublicDeps["referee"],
    config: () => config,
    gate: {} as PublicDeps["gate"],
    webrtc: {} as PublicDeps["webrtc"],
    clientAssets: async () => undefined,
    realCalls: true,
  });
  const config_ = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="rc-config">(.*?)<\/script>/s)![1]!);

  test("the home page is the recordings, on the first, waiting for a tap; the games are at /play", async () => {
    const html = await (await page.request("http://x/")).text();
    expect(html).toContain("REAL CALL RECORDINGS");
    expect(config_(html)).toMatchObject({ selected: DEMOS[0]!.slug, autoplay: false, base: "/" });
    const games = await (await page.request("http://x/play")).text();
    expect(games).toContain(">SCAM ME<");
    expect(games).toContain('<a class="pbrand" href="/"');
  });

  test("a recording's link opens the page on that call, playing", async () => {
    const html = await (await page.request("http://x/listen/crypto-bot")).text();
    expect(config_(html)).toMatchObject({ selected: "crypto-bot", autoplay: true, base: "/" });
    expect((await page.request("http://x/listen/nope")).status).toBe(404);
    const index = await page.request("http://x/listen");
    expect(index.status).toBe(302);
    expect(index.headers.get("location")).toBe("/");
  });
});
