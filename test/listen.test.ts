import { describe, expect, test } from "bun:test";
import { demoMedia } from "../src/runtime/demo-media";
import { callTimeAt, resolveCut } from "../src/web/client/listen-cut";
import { logo } from "../src/web/favicon";
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
  test("the home page: the pitch with the bot page and the game, a tab per recording, the player, GitHub in the footer", () => {
    const html = realCallsPage("/", { selected: "electrician", autoplay: true, wastedSeconds: 3725 });
    for (const d of DEMOS) expect(html).toContain(`href="/listen/${d.slug}"`);
    expect(html).toContain('"selected":"electrician"');
    expect(html).toContain('"autoplay":true');
    expect(html).toContain(">1:02:05</b>");
    expect(html).toContain("REAL CALLS.");
    expect(html).toContain("LET THE BOT TAKE IT.");
    expect(html).toContain('<a class="hero-own" href="/bot">GET YOUR OWN BOT</a>');
    expect(html).toContain('<a class="hero-play" href="/play"><b>PLAY THE BOT</b><span>Can you fool it?</span></a>');
    expect(html).not.toContain('class="rc-own"');
    expect(html).toContain('<header class="rc-top solo">');
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("4620 6827");
    expect(html).toMatch(/<footer class="rc-legal rc-foot"><a class="rc-gh" href="https:\/\/github.com\/szerintedmi\/callsitter">.*GitHub<\/a>/);
  });

  test("the song demo comes first, of five tabs", () => {
    expect(DEMOS.map((d) => d.slug)).toEqual(["areyouai", "cold-call", "police-scam", "crypto-bot", "electrician"]);
    expect(DEMOS[0]!.scene).toBe("areyouai");
    const html = realCallsPage("/", { selected: "areyouai", autoplay: false, wastedSeconds: 0 });
    expect(html.match(/class="rc-tab /g)).toHaveLength(5);
    expect(html).toContain('data-slug="electrician" data-notrack><i>05</i>The electrician</a>');
  });

  test("the recorder's page has the stage only", async () => {
    const res = await get("/listen/render/electrician");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"render":true');
    expect(html).not.toContain("<audio");
    expect(html).not.toContain('class="rc-tiles"');
    expect(await (await get("/listen/render/electrician?poster=1")).text()).toContain('"poster":true');
    const song = await get("/listen/render/areyouai");
    expect(song.status).toBe(200);
    expect(await song.text()).toContain('"selected":"areyouai"');
  });

  test("the recorder's page takes a layout and the safe area off", async () => {
    const config = async (q: string) => JSON.parse((await (await get(`/listen/render/areyouai${q}`)).text()).match(/id="rc-config">(.*?)<\/script>/s)![1]!);
    expect(await config("")).toMatchObject({ safe: true });
    expect((await config("")).layout).toBeUndefined();
    expect(await config("?layout=stack&safe=0")).toMatchObject({ layout: "stack", safe: false });
    expect((await get("/listen/render/areyouai?layout=diagonal")).status).toBe(400);
  });

  test("unknown demos and files are not found", async () => {
    expect((await get("/listen/render/nope")).status).toBe(404);
    expect((await get("/listen/media/nope.mp3")).status).toBe(404);
    expect((await get("/listen/media/electrician.wav")).status).toBe(404);
    expect((await get("/listen/media/..%2Fpackage.json")).status).toBe(404);
    expect(asked).toEqual([]);
    expect(await (await get("/listen/media/electrician.json")).text()).toBe("electrician.json");
    expect(await (await get("/listen/media/areyouai.mp3")).text()).toBe("areyouai.mp3");
    expect((await get("/listen/media/electrician.jpg")).status).toBe(404);
  });

  test("the page script is served", async () => {
    expect(await (await get("/assets/listen.js")).text()).toBe("// page");
  });
});

// An edit for a video (record.ts --edit): segments end to end, each a whole number of frames, song
// cuts on the beat grid, stills, sped-up stretches.
describe("cuts", () => {
  const song = { bpm: 120, beat: 10 };

  test("segments play end to end on the video's clock", () => {
    const { pieces, duration } = resolveCut({ segments: [{ from: 5, to: 7 }, { hold: 20, for: 1 }, { from: 30, to: 42, speed: 4 }] }, undefined, 30);
    expect(duration).toBeCloseTo(6);
    expect(pieces.map((p) => [p.out, p.len, p.audio])).toEqual([[0, 2, "on"], [2, 1, "mute"], [3, 3, "mute"]]);
    expect(callTimeAt(pieces, 0)).toBe(5);
    expect(callTimeAt(pieces, 1.5)).toBe(6.5);
    expect(callTimeAt(pieces, 2)).toBe(20);
    expect(callTimeAt(pieces, 2.9)).toBe(20);
    expect(callTimeAt(pieces, 4)).toBeCloseTo(34);
    // a frame's time a hair short of a cut is still after it
    expect(callTimeAt(pieces, 3 - 1e-9)).toBeCloseTo(30);
  });

  test("a segment lasts whole frames, its end moved to fit", () => {
    const { pieces } = resolveCut({ segments: [{ from: 0, to: 1.01 }, { from: 3, to: 4 }] }, undefined, 30);
    expect(pieces[0]!.len).toBe(1);
    expect(pieces[0]!.to).toBe(1);
    expect(pieces[1]!.out).toBe(1);
  });

  test("snapping to the song's bars and beats", () => {
    // a beat is 0.5 s from 10 s, a bar 2 s
    const { pieces } = resolveCut({ segments: [{ from: 13.2, to: 18.6, snap: "bar" }, { from: 13.2, to: 18.6, snap: "beat" }] }, song, 30);
    expect([pieces[0]!.from, pieces[0]!.to]).toEqual([14, 18]);
    expect([pieces[1]!.from, pieces[1]!.to]).toEqual([13, 18.5]);
    expect(() => resolveCut({ segments: [{ from: 1, to: 2, snap: "bar" }] }, undefined, 30)).toThrow(/song/);
  });

  test("crossfades and audio choices", () => {
    const { pieces } = resolveCut({ fade: 0.1, segments: [{ from: 1, to: 2 }, { from: 3, to: 9, speed: 3, audio: "fast" }, { from: 9, to: 10, fade: 0.5 }] }, undefined, 30);
    expect(pieces.map((p) => [p.fade, p.audio])).toEqual([[0.1, "on"], [0.1, "fast"], [0.5, "on"]]);
    expect(() => resolveCut({ segments: [{ from: 2, to: 1 }] }, undefined, 30)).toThrow();
    expect(() => resolveCut({ segments: [{ hold: 1, for: 0 }] }, undefined, 30)).toThrow();
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
    manager: { bus: { subscribe: () => () => {} }, gate: { exhausted: async () => null } } as unknown as PublicDeps["manager"],
    repo: { scores: async () => [], junkCallSeconds: async () => 0 } as unknown as PublicDeps["repo"],
    referee: {} as PublicDeps["referee"],
    config: () => config,
    webrtc: {} as PublicDeps["webrtc"],
    clientAssets: async () => undefined,
    realCalls: true,
  });
  const config_ = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="rc-config">(.*?)<\/script>/s)![1]!);

  test("the home page is the recordings, on the first, waiting for a tap; the games are at /play", async () => {
    const html = await (await page.request("http://x/")).text();
    expect(html).toContain("REAL CALLS.");
    expect(config_(html)).toMatchObject({ selected: DEMOS[0]!.slug, autoplay: false, base: "/" });
    const games = await (await page.request("http://x/play")).text();
    expect(games).toContain(">SCAM ME<");
  });

  test("/play has the home page's top bar, with the player's chip, and no phone number", async () => {
    const games = await (await page.request("http://x/play")).text();
    expect(games).toContain(`<header class="rc-top"><a class="rc-brand" href="/">${logo}CALLSITTER</a>`);
    expect(games).toContain('<b id="wasted">0:00:00</b>');
    expect(games).toContain('<a class="rc-own" href="/bot">GET YOUR OWN BOT</a>');
    expect(games).toMatch(/<div class="rc-right"><button class="chip" type="button" data-chip data-track="change_name" hidden><\/button><a class="rc-own"/);
    expect(games).toContain(".rc-top{");
    expect(games).not.toContain("tel:");
    expect(games).not.toContain("4620 6827");
    expect(games).not.toContain('id="dial"');
  });

  test("the bot page: the headline and the form, the game top right, the home page's footer, no phone number", async () => {
    const html = await (await page.request("http://x/bot")).text();
    expect(html).toContain("GET YOUR OWN BOT.");
    expect(html).toContain('<div class="rc-right"><a class="rc-game" href="/play">PLAY THE BOT</a>');
    expect(html).toContain('<footer class="rc-legal rc-foot">');
    expect(html).not.toContain("CallSitter answers your phone");
    expect(html).not.toContain('class="rc-own"');
    expect(html).not.toContain("tel:");
  });

  test("the terms and the privacy notice, linked from every public page", async () => {
    for (const path of ["/", "/bot", "/play"]) {
      const html = await (await page.request(`http://x${path}`)).text();
      expect(html).toContain('<a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>');
    }
    const terms = await (await page.request("http://x/terms")).text();
    expect(terms).toContain("<h1>TERMS</h1>");
    expect(terms).toContain('href="/privacy"');
    const privacy = await (await page.request("http://x/privacy")).text();
    expect(privacy).toContain("<h1>PRIVACY</h1>");
    expect(privacy).toContain("180 days");
    for (const html of [terms, privacy]) {
      expect(html).toContain(`<header class="rc-top"><a class="rc-brand" href="/">${logo}CALLSITTER</a>`);
      expect(html).not.toContain('class="rc-own"');
      expect(html).not.toContain("tel:");
    }
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
