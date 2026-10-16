// The real-call player at the top of the public page (src/web/listen.ts): a recording with its
// transcript, Jev's verdict and a 3D scene of the two sides (listen-scene.ts). The tiles under it
// switch calls in place. The audio's clock drives it; on the recorder's page (listen/render/<slug>)
// there's no audio, and demos/tools/record.ts steps the clock with window.demo.seek(t), one frame
// at a time. Everything drawn is a function of t.
import * as THREE from "three";
import { createScene, type BlunderKind, type CallScene, type Moment, type SceneKind, type SongMoment, type SongSection } from "./listen-scene";
import { mergeSpans, onHide, spanSeconds, spansOf, startTracking, track, type Span } from "./track";

type Speaker = "caller" | "agent";
interface Demo {
  slug: string;
  scene: SceneKind;
  title: string;
  length: string;
  caller: string;
  outcome: string;
}
interface Config {
  demos: Demo[];
  selected: string;
  autoplay: boolean;
  render: boolean;
  poster?: boolean;
  base: string;
  site?: string;
}
interface Line {
  speaker: Speaker;
  start: number;
  end: number;
  words: [number, string][];
}
/** a karaoke line: who sings it ("both": everyone) */
interface SongLine extends Omit<Line, "speaker"> {
  speaker: Speaker | "both";
}
interface Call {
  duration: number;
  /** the call's lines (with a song: the clip's) */
  lines: Line[];
  beeps: { speaker: Speaker; start: number; end: number }[];
  /** speech levels; with a song, over it too (gated by who sings) and the song's own loudness */
  levels: Record<Speaker, string> & { music?: string };
  levelFps: number;
  verdicts: [number, number, number, number][];
  /** a stage at t <= 0 began before the clip: its badge is on from the start, no banner */
  stages: [number, string][];
  /** a song after the call (areyouai): file times */
  song?: { start: number; end: number; bpm: number; beat: number; lines: SongLine[] };
}

declare global {
  interface Window {
    demo?: { duration: number; seek(t: number): void };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const SPEAKERS: Speaker[] = ["caller", "agent"];
const phone = window.matchMedia("(max-width: 640px)");

/** emoji that pop over a speaker's head when a line says the word */
const POPS: Record<SceneKind, [RegExp, string, string?][]> = {
  police: [
    [/police/i, "👮", "“POLICE”"],
    [/heathrow/i, "✈️"],
    [/laptops/i, "💻"],
    [/reference/i, "📝"],
    [/pen and/i, "🖊️"],
    [/email/i, "📧"],
    [/badge/i, "🪪"],
    [/spam/i, "🗑️"],
    [/ebay|amazon/i, "🛒"],
    [/card/i, "💳"],
    [/bank/i, "🏦"],
    [/marmalade/i, "🍊", "MARMALADECOIN"],
    [/crypto/i, "🪙"],
    [/hardware wallet/i, "🔐"],
    [/robber|invasion/i, "🦹"],
    [/transcript/i, "📜"],
  ],
  cryptobot: [
    [/unauthori[sz]ed/i, "🚨"],
    [/password/i, "🔑"],
    [/balance/i, "💰"],
    [/revolut/i, "💳"],
    [/worrying/i, "😰"],
  ],
  areyouai: [
    [/real person/i, "🧑", "REAL PERSON"],
    [/what model/i, "🤖", "WHAT MODEL ARE YOU?"],
    [/openai/i, "🧠"],
    [/\bAI\b/, "🤖"],
    [/give us a call/i, "☎️"],
    [/take care/i, "👋"],
  ],
  electrician: [
    [/electrician/i, "⚡"],
    [/landlady/i, "🏠"],
    [/report/i, "📋"],
    [/hour/i, "⏰"],
    [/half eleven/i, "🕚"],
    [/thank you/i, "🙏"],
    [/messages/i, "📝"],
  ],
};

/** the song's emoji, for whoever sings the word (both heads on a line everyone sings) */
const SONG_POPS: [RegExp, string, string?][] = [
  [/real person/i, "🧑", "REAL PERSON"],
  [/human/i, "🧑"],
  [/machine|code|model/i, "🤖"],
  [/script/i, "📜"],
  [/brain/i, "🧠"],
  [/feelings/i, "💗"],
  [/\bram\b/i, "💾"],
  [/phone|call/i, "☎️"],
  [/screen/i, "🖥️"],
];

/**
 * The song's parts, seconds into it, and how wild the scene gets in each (about 0–1.3). Only one
 * song so far (areyouai's, 132 s): its structure, by ear. Choruses come in as a step (the drop at 22 s), the rest ease.
 */
const SONG_PARTS: [number, SongSection, number][] = [
  [0, "intro", 0.25],
  [6.1, "verse", 0.45],
  [20.2, "build", 0.6],
  [22, "chorus", 1],
  [37.4, "fill", 0.75],
  [39.9, "verse", 0.55],
  [56.8, "chorus", 1],
  [73.3, "fill", 0.7],
  [75, "bridge", 0.45],
  [80.7, "break", 0.25],
  [89.2, "fill", 0.6],
  [98, "outro", 0.9],
  [108, "finale", 1.3],
  [125.9, "last", 0.2],
  [130.3, "end", 0.1],
];

/** where the song is at t: its beat, part and loudness, or null outside it */
function songAt(song: NonNullable<Call["song"]>, t: number, music: number): SongMoment | null {
  if (t < song.start || t > song.end + 1) return null;
  const since = t - song.start;
  const beat = ((t - song.beat) * song.bpm) / 60;
  let i = 0;
  while (i + 1 < SONG_PARTS.length && SONG_PARTS[i + 1]![0] <= since) i++;
  const [from, section, e] = SONG_PARTS[i]!;
  const prev = SONG_PARTS[i - 1]?.[2] ?? 0;
  const sectionSince = since - from;
  // a chorus drops at once; into the song from the call's quiet, and the calm last line, take their time
  const ramp = section === "chorus" ? 0.05 : section === "last" || section === "intro" ? 1.5 : 0.4;
  const both = song.lines.find((l) => l.speaker === "both" && t >= l.start && t < l.end + 0.2);
  return {
    since,
    beat,
    phase: beat - Math.floor(beat),
    bar: Math.floor(beat / 4),
    section,
    sectionSince,
    energy: prev + (e - prev) * clamp01(sectionSince / ramp),
    music,
    swap: both ? t - both.start : null,
  };
}

/** the call-flow stages worth showing: the banner when it starts, then the badge that stays */
const STAGE_BANNER: Record<string, { banner: string; badge: string; ok: boolean }> = {
  waste_time: { banner: "SCAM SPOTTED · 🧌 TROLL MODE ON", badge: "🧌 TROLL MODE ON", ok: false },
  genuine: { banner: "GENUINE CALLER · TAKING A MESSAGE", badge: "📝 TAKING A MESSAGE", ok: true },
  decline_spam: { banner: "SALES CALL · SAYING NO THANKS", badge: "🙅 NO THANKS", ok: false },
};

/** A loaded call: its data, precomputed timelines and scene. */
interface Loaded {
  demo: Demo;
  call: Call;
  scene: CallScene;
  levels: Record<Speaker, Uint8Array>;
  active: Record<Speaker, Float32Array>;
  /** the song's loudness (empty without one) */
  music: Uint8Array;
  stage?: [number, string];
  loops: Loop[];
  blunders: Blunder[];
  pauses: [number, number][];
  pops: Pop[];
  /** the song's emoji */
  songPops: Pop[];
  lastWord: number;
  /** when the caller hung up in a huff (police), or undefined */
  hangup?: number;
  /** when the end card comes up */
  endAt: number;
}
interface Loop {
  start: number;
  end: number;
  n: number;
}
/** something dumb the scam bot did, shown over its head */
interface Blunder {
  t: number;
  kind: BlunderKind;
}
const BLUNDER: Record<BlunderKind, [string, string]> = {
  talkover: ["🙉", "NOT LISTENING"],
  cutoff: ["💨", "FORGOT THE REST"],
  ignored: ["🤷", "NOT IN THE SCRIPT"],
};
/** its nth time saying the same line */
const loopLabel = (n: number) => (n === 2 ? "DÉJÀ VU" : n === 3 ? "DÉJÀ DÉJÀ VU" : n === 4 ? "READING THE SCRIPT AGAIN" : `TAKE ${n}`);
interface Pop {
  speaker: Speaker;
  t: number;
  emoji: string;
  label?: string;
}

async function main() {
  const cfg = JSON.parse($("rc-config").textContent ?? "{}") as Config;
  const root = cfg.render ? document.body : $("rc");
  const stageEl = $("rc-stage");
  const canvas = $<HTMLCanvasElement>("rc-gl");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: cfg.render });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Drawn at the stage's real size (no upscaling, so no blur), up to 1080p.
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(1920, Math.round(stageEl.clientWidth * dpr));
    renderer.setPixelRatio(1);
    renderer.setSize(w, Math.round((w * 9) / 16), false);
  };
  resize();
  await Promise.all([document.fonts.load('20px "Jersey 10"').catch(() => {}), document.fonts.load('20px "Pixelify Sans"').catch(() => {})]);

  const cache = new Map<string, Promise<Call>>();
  const fetchCall = (slug: string) => {
    if (!cache.has(slug)) cache.set(slug, fetch(`${cfg.base}listen/media/${slug}.json`).then((r) => r.json() as Promise<Call>));
    return cache.get(slug)!;
  };
  const subs = new Subtitles();
  let cur: Loaded | null = null;

  async function load(slug: string): Promise<Loaded> {
    const demo = cfg.demos.find((d) => d.slug === slug) ?? cfg.demos[0]!;
    const call = await fetchCall(demo.slug);
    const levels = {} as Record<Speaker, Uint8Array>;
    const active = {} as Record<Speaker, Float32Array>;
    for (const s of SPEAKERS) {
      levels[s] = Uint8Array.from(atob(call.levels[s]), (ch) => ch.charCodeAt(0));
      active[s] = smooth(levels[s], call.levelFps);
    }
    const loops = loopsOf(call.lines);
    const l: Loaded = {
      demo,
      call,
      scene: createScene(renderer, demo.scene),
      levels,
      active,
      music: Uint8Array.from(atob(call.levels.music ?? ""), (ch) => ch.charCodeAt(0)),
      stage: call.stages.find(([, s]) => s in STAGE_BANNER),
      loops,
      blunders: demo.scene === "cryptobot" ? blundersOf(call.lines, loops) : [],
      pauses: demo.scene === "cryptobot" ? pausesOf(call.lines) : [],
      pops: popsOf(call.lines, POPS[demo.scene], 60),
      songPops: call.song ? popsOf(call.song.lines, SONG_POPS, 8) : [],
      lastWord: Math.max(...call.lines.map((x) => x.end)),
      endAt: 0,
    };
    // The police hung up on the bot: his last line, then the click.
    const lastCaller = call.lines.filter((x) => x.speaker === "caller").at(-1);
    if (demo.scene === "police" && lastCaller) l.hangup = lastCaller.end + 0.1;
    l.endAt = call.song ? call.song.end + 0.5 : l.hangup !== undefined ? l.hangup + 3.6 : l.lastWord + 0.5;
    root.dataset.scene = demo.scene;
    $("rc-outcome").replaceChildren(demo.outcome);
    const mark = $("rc-mark");
    // where it gets good: the song, or the stage starting (not one that began before the clip)
    const marked = call.song ? call.song.start : l.stage && l.stage[0] > 0 ? l.stage[0] : null;
    mark.style.display = marked !== null ? "block" : "none";
    if (marked !== null) mark.style.left = `${(marked / call.duration) * 100}%`;
    for (const t of document.querySelectorAll<HTMLElement>(".rc-tab")) {
      if (t.dataset.slug === demo.slug) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    }
    subs.reset();
    return l;
  }

  const draw = (t: number) => {
    if (!cur) return;
    const { call, scene, stage } = cur;
    const at = (arr: ArrayLike<number>, scale: number) => {
      const f = t * call.levelFps;
      const i = Math.floor(f);
      const a = arr[i] ?? 0;
      const b = arr[i + 1] ?? a;
      return (a + (b - a) * (f - i)) / scale;
    };
    // a stage on before the clip began counts as long since (the shades are already on)
    const sinceStage = stage && t >= stage[0] ? t - stage[0] + (stage[0] <= 0 ? 60 : 0) : null;
    const song = call.song ? songAt(call.song, t, at(cur.music, 255)) : null;
    const verdict = verdictAt(call.verdicts, t);
    const loop = cur.loops.find((l) => t >= l.start && t < l.end);
    const latest = [...cur.blunders].reverse().find((b) => t >= b.t);
    const blunder = latest && t < latest.t + 2 ? latest : undefined;
    const pause = cur.pauses.find(([a, b]) => t >= a && t < b);
    const buffering = !!pause;
    const talkedOver = [...cur.blunders].reverse().find((b) => b.kind === "talkover" && t >= b.t);
    const m: Moment = {
      t,
      level: { caller: at(cur.levels.caller, 255), agent: at(cur.levels.agent, 255) },
      active: { caller: at(cur.active.caller, 1), agent: at(cur.active.agent, 1) },
      sinceStage,
      genuine: verdict.genuine,
      looping: loop ? t - loop.start : null,
      blunder: latest && t < latest.t + 2.5 ? { kind: latest.kind, since: t - latest.t } : null,
      buffering,
      flinch: talkedOver ? t - talkedOver.t : null,
      hangup: cur.hangup !== undefined && t >= cur.hangup ? t - cur.hangup : null,
      song,
    };
    scene.render(m);
    const a = scene.anchors();

    // the stage's banner as it starts, then its badge in the corner
    const banner = $("rc-banner");
    const badge = $("rc-mode");
    if (song) {
      // the song: its banner, then karaoke mode in the corner
      banner.textContent = `🎵 ${cur.demo.title.toUpperCase()}`;
      badge.textContent = "🎤 KARAOKE MODE";
      banner.className = "rc-banner song";
      badge.className = "rc-mode song";
      const s = song.since;
      banner.style.setProperty("--s", String(s > 3.5 ? 0 : s > 3.1 ? (3.5 - s) / 0.4 : pop(s)));
      badge.style.setProperty("--s", String(s < 3.3 ? 0 : pop(s - 3.3)));
    } else if (stage) {
      const st = STAGE_BANNER[stage[1]]!;
      banner.classList.remove("song");
      badge.classList.remove("song");
      banner.textContent = st.banner;
      badge.textContent = st.badge;
      banner.classList.toggle("ok", st.ok);
      badge.classList.toggle("ok", st.ok);
      // already on when the clip starts: no banner
      const s = sinceStage ?? -1;
      banner.style.setProperty("--s", String(s < 0 || s > 3.5 ? 0 : s > 3.1 ? (3.5 - s) / 0.4 : pop(s)));
      badge.style.setProperty("--s", String(s < 3.3 ? 0 : pop(s - 3.3)));
    } else {
      banner.style.setProperty("--s", "0");
      badge.style.setProperty("--s", "0");
    }

    // beeps, blunders and emoji over the heads
    for (const s of SPEAKERS) {
      const head = s === "caller" ? a.callerHead : a.agentHead;
      const beep = call.beeps.find((b) => b.speaker === s && t >= b.start - 0.05 && t < b.end + 0.35);
      const el = $(`rc-beep-${s}`);
      place(el, [head[0] + (s === "caller" ? 0.04 : -0.04), head[1] + 0.06]);
      el.style.setProperty("--s", beep ? String(pop(t - beep.start + 0.05, 0.25)) : "0");
      const pe = $(`rc-pop-${s}`);
      place(pe, head);
      let html = "";
      let scale = 0;
      let dumb = false;
      const p = [...(song ? cur.songPops : cur.pops)].reverse().find((x) => x.speaker === s && t >= x.t && t < x.t + 2.6);
      if (s === "caller" && cur.hangup !== undefined && t >= cur.hangup + 0.3) {
        html = `📵<small>*CLICK*</small>`;
        scale = pop(t - cur.hangup - 0.3);
      } else if (s === "caller" && pause) {
        // never quite gets there
        const pct = Math.floor(99 * Math.pow(clamp01((t - pause[0]) / (pause[1] - pause[0])), 0.6));
        html = `⏳<small>LOADING SCAM… ${pct}%</small>`;
        scale = pop(t - pause[0]);
        dumb = true;
      } else if (s === "caller" && blunder) {
        const [emoji, label] = BLUNDER[blunder.kind];
        html = `${emoji}<small>${label}</small>`;
        scale = t > blunder.t + 1.7 ? (blunder.t + 2 - t) / 0.3 : pop(t - blunder.t);
        dumb = true;
      } else if (s === "caller" && loop) {
        html = `🔁<small>${loopLabel(loop.n)}</small>`;
        scale = pop(t - loop.start);
        dumb = true;
      } else if (p) {
        html = p.label ? `${p.emoji}<small>${p.label}</small>` : p.emoji;
        scale = t > p.t + 2.3 ? (p.t + 2.6 - t) / 0.3 : pop(t - p.t);
      }
      if (pe.innerHTML !== html) pe.innerHTML = html;
      pe.classList.toggle("dumb", dumb);
      pe.style.setProperty("--s", String(scale));
    }

    const below = phone.matches && !cfg.render;
    const names = { caller: cur.demo.caller, agent: "CALLSITTER BOT", both: "🎤 EVERYONE" };
    const lines = call.song && t >= call.song.start ? call.song.lines : call.lines;
    subs.show(lines, t, names, below ? $("rc-caption") : $("rc-subs"), below ? 1 : 2);
    const end = clamp01((t - cur.endAt) / 0.6);
    $("rc-end").style.setProperty("--o", String(end));
    // the end card has its own buttons
    root.classList.toggle("ended", end > 0);
    $("rc-progress").style.width = `${clamp01(t / call.duration) * 100}%`;
  };

  if (cfg.render) {
    cur = await load(cfg.selected);
    document.body.classList.toggle("poster", !!cfg.poster);
    if (cfg.site) {
      $("rc-site").hidden = false;
      $("rc-site").textContent = cfg.site.toUpperCase();
    }
    // a few seconds past the audio, so the end card gets screen time
    window.demo = { duration: Math.max(cur.call.duration, cur.endAt + 3), seek: draw };
    draw(0);
    document.body.dataset.ready = "1";
    return;
  }

  const audio = $<HTMLAudioElement>("rc-audio");
  const nextBtn = $<HTMLButtonElement>("rc-next");

  // Page analytics (track.ts): play, pause and ended with the position, and each recording's
  // listening totals for this page load (`watch`), sent as they grow: when switching away from it
  // and when the page is hidden. The server keeps the largest (src/core/analytics.ts).
  startTracking(cfg.base);
  /** the recording in the audio element */
  let audioSlug: string | null = null;
  /** what was heard of each recording before its audio was last loaded (that resets audio.played) */
  const heard = new Map<string, Span[]>();
  const lengths = new Map<string, number>();
  /** the last totals sent per recording */
  const reported = new Map<string, string>();
  const spansFor = (slug: string) => mergeSpans([...(heard.get(slug) ?? []), ...(slug === audioSlug ? spansOf(audio.played) : [])]);
  const reportWatch = (slug: string) => {
    const spans = spansFor(slug);
    if (!spans.length) return;
    const duration = lengths.get(slug) ?? 0;
    const played = spanSeconds(spans);
    const props = { playedSeconds: round1(played), maxPosition: round1(spans.at(-1)![1]), duration: round1(duration), completed: duration > 0 && played >= 0.9 * duration };
    const key = JSON.stringify(props);
    if (reported.get(slug) === key) return;
    reported.set(slug, key);
    track("watch", props, slug);
  };
  onHide(() => {
    for (const slug of new Set([...heard.keys(), ...(audioSlug ? [audioSlug] : [])])) reportWatch(slug);
  });
  const position = () => ({ position: round1(audio.currentTime) });
  /** the pause that switching calls causes: already reported */
  let switching = false;
  audio.addEventListener("play", () => audioSlug && track("play", position(), audioSlug));
  audio.addEventListener("pause", () => {
    if (switching) switching = false;
    else if (audioSlug && !audio.ended) track("pause", position(), audioSlug);
  });
  audio.addEventListener("ended", () => audioSlug && track("ended", position(), audioSlug));
  /** the picture runs on past the audio's end (a hang-up, the end card): performance.now() at t=0 */
  let tailFrom: number | null = null;
  const now = () => (tailFrom !== null ? (performance.now() - tailFrom) / 1000 : audio.currentTime);
  const playing = () => tailFrom !== null || !audio.paused;
  const setPlaying = () => root.classList.toggle("playing", playing());
  audio.onplay = audio.onpause = setPlaying;
  audio.onended = () => {
    if (!cur) return;
    tailFrom = performance.now() - audio.duration * 1000;
    setPlaying();
  };
  const tailEnd = () => (cur ? Math.max(cur.call.duration, cur.endAt + 0.8) : 0);
  const stopTail = () => {
    tailFrom = null;
    setPlaying();
  };

  /** Shows a call; with `play`, starts it. A call's link opened cold usually can't: browsers want a
   * tap before sound, so the ▶ waits for it. */
  async function select(slug: string, play: boolean) {
    if (audioSlug) {
      heard.set(audioSlug, spansFor(audioSlug));
      reportWatch(audioSlug);
      if (!audio.paused) {
        track("pause", { ...position(), switched: true }, audioSlug);
        switching = true;
      }
    }
    audio.pause();
    stopTail();
    cur = await load(slug);
    audio.src = `${cfg.base}listen/media/${cur.demo.slug}.mp3`;
    audioSlug = cur.demo.slug;
    lengths.set(audioSlug, cur.call.duration);
    const next = cfg.demos[(cfg.demos.indexOf(cur.demo) + 1) % cfg.demos.length]!;
    nextBtn.hidden = false;
    nextBtn.textContent = `NEXT ▶ ${next.title.toUpperCase()}`;
    nextBtn.onclick = (e) => {
      e.stopPropagation();
      track("click", { action: "next", target: next.slug }, audioSlug ?? undefined);
      void choose(next.slug);
    };
    draw(0);
    if (play) await audio.play().catch(() => {});
  }
  /** a tab or NEXT: switch in place and play (the click allows sound), and update the link */
  async function choose(slug: string) {
    history.replaceState(null, "", `${cfg.base}listen/${slug}`);
    await select(slug, true);
  }
  for (const tab of document.querySelectorAll<HTMLAnchorElement>(".rc-tab")) {
    tab.onclick = (e) => {
      e.preventDefault();
      track("click", { action: "tab", target: tab.dataset.slug! }, audioSlug ?? undefined);
      void choose(tab.dataset.slug!);
    };
  }

  // the stage is the control: tap to play/pause; after the end, from the start again
  stageEl.onclick = () => {
    const action = tailFrom !== null || audio.ended ? "replay" : audio.paused ? "play" : "pause";
    track("click", { action, target: "stage", ...position() }, audioSlug ?? undefined);
    if (tailFrom !== null || audio.ended) {
      stopTail();
      audio.currentTime = 0;
      void audio.play();
      return;
    }
    if (audio.paused) void audio.play();
    else audio.pause();
  };
  const seekBar = $("rc-seek");
  const seekTo = (e: PointerEvent) => {
    if (!cur) return;
    const r = seekBar.getBoundingClientRect();
    const t = clamp01((e.clientX - r.left) / r.width) * cur.call.duration;
    stopTail();
    audio.currentTime = t;
    draw(t);
  };
  seekBar.onclick = (e) => e.stopPropagation();
  seekBar.onpointerdown = (e) => {
    e.stopPropagation();
    seekBar.setPointerCapture(e.pointerId);
    seekTo(e);
    seekBar.onpointermove = seekTo;
  };
  seekBar.onpointerup = () => {
    seekBar.onpointermove = null;
    track("click", { action: "seek", target: null, ...position() }, audioSlug ?? undefined);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && (e.target === document.body || e.target === stageEl)) {
      e.preventDefault();
      stageEl.click();
    }
  });
  new ResizeObserver(() => {
    resize();
    draw(now());
  }).observe(stageEl);

  const frame = () => {
    // a game call took the screen: stop
    if (playing() && stageEl.offsetParent === null) {
      audio.pause();
      stopTail();
    }
    if (tailFrom !== null && cur && now() >= tailEnd()) {
      stopTail();
      draw(tailEnd());
    }
    if (playing()) draw(now());
    requestAnimationFrame(frame);
  };
  await select(cfg.selected, cfg.autoplay);
  requestAnimationFrame(frame);
}

/** who's been talking lately, 0–1: speech frames smoothed over about a second, both ways */
function smooth(levels: Uint8Array, fps: number): Float32Array {
  const out = new Float32Array(levels.length);
  const k = 1 / (fps * 0.6);
  let v = 0;
  for (let i = 0; i < levels.length; i++) out[i] = v += ((levels[i]! > 90 ? 1 : 0) - v) * k;
  v = 0;
  for (let i = levels.length - 1; i >= 0; i--) {
    v += ((levels[i]! > 90 ? 1 : 0) - v) * k;
    out[i] = Math.min(1, Math.max(out[i]!, v) * 1.5);
  }
  return out;
}

/** Jev's latest verdict before t, eased over half a second from the one before */
function verdictAt(vs: Call["verdicts"], t: number): { junk: number; genuine: number } {
  let i = -1;
  while (i + 1 < vs.length && vs[i + 1]![0] <= t) i++;
  const get = (k: number) => (k < 0 ? { junk: 0, genuine: 0 } : { junk: vs[k]![1] + vs[k]![2], genuine: vs[k]![3] });
  const cur = get(i);
  const prev = get(i - 1);
  const x = i < 0 ? 1 : clamp01((t - vs[i]![0]) / 0.5);
  return { junk: prev.junk + (cur.junk - prev.junk) * x, genuine: prev.genuine + (cur.genuine - prev.genuine) * x };
}

const normWords = (ws: Line["words"]) => ws.map((w) => w[1].toLowerCase().replace(/[^a-z0-9]/g, "")).join(" ");
const textOf = (l: Line) => l.words.map((w) => w[1]).join("").trim();

/** the caller saying something it already said (a scam bot's script running out): each repeat, numbered */
function loopsOf(lines: Line[]): Loop[] {
  let said = "";
  const out: Loop[] = [];
  for (const l of lines) {
    if (l.speaker !== "caller") continue;
    if (l.words.length >= 10) {
      const n = said.split(normWords(l.words.slice(0, 10))).length;
      if (n >= 2) out.push({ start: l.start, end: l.end, n });
    }
    said += ` ${normWords(l.words)}`;
  }
  return out;
}

/**
 * The scam bot's blunders: starting over the other side mid-sentence, giving up on its own
 * sentence, and answering a question with the same old line.
 */
function blundersOf(lines: Line[], loops: Loop[]): Blunder[] {
  const out: Blunder[] = [];
  const callers = lines.filter((l) => l.speaker === "caller");
  const agents = lines.filter((l) => l.speaker === "agent");
  for (const [i, c] of callers.entries()) {
    if (agents.some((a) => a.start + 0.3 < c.start && c.start < a.end - 0.4)) out.push({ t: c.start + 0.2, kind: "talkover" });
    const next = callers[i + 1];
    if (!/[.?!]$/.test(textOf(c).replace(/(\.\.\.|…)$/, "")) || /(\.\.\.|…)$/.test(textOf(c))) {
      if (next && next.start - c.end < 2.5) out.push({ t: c.end, kind: "cutoff" });
    }
    const asked = [...agents].reverse().find((a) => a.end <= c.start + 0.5);
    if (asked && /\?$/.test(textOf(asked)) && loops.some((l) => l.start === c.start)) out.push({ t: c.start + 0.1, kind: "ignored" });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** stretches where the bot had its turn and said nothing for over 3 s */
function pausesOf(lines: Line[]): [number, number][] {
  const out: [number, number][] = [];
  for (const l of lines) {
    if (l.speaker !== "agent") continue;
    const overlapping = lines.some((x) => x !== l && x.start < l.end && x.end > l.end);
    const next = lines.filter((x) => x.start > l.end - 0.1 && x !== l).sort((a, b) => a.start - b.start)[0];
    if (next && !overlapping && next.start - l.end > 3) out.push([l.end + 1, next.start]);
  }
  return out;
}

/** `rules`' emoji as the lines say them; a line everyone sings pops over both heads */
function popsOf(lines: SongLine[], rules: [RegExp, string, string?][], sameGap: number): Pop[] {
  const out: Pop[] = [];
  const lastOf = new Map<string, number>();
  for (const l of lines) {
    for (const [i, [t]] of l.words.entries()) {
      // the word and the next, so two-word cues ("half eleven") match on their first word
      const text = l.words[i]![1] + (l.words[i + 1]?.[1] ?? "");
      const hit = rules.find(([re]) => re.test(text) && re.test(text.slice(0, l.words[i]![1].length + 6)));
      if (!hit) continue;
      const key = `${hit[1]}${hit[2] ?? ""}`;
      const speakers = l.speaker === "both" ? SPEAKERS : [l.speaker];
      const mine = out.filter((p) => speakers.includes(p.speaker)).at(-1);
      // the same emoji at most once every `sameGap` s (a minute in a call), one per speaker every few seconds
      if ((mine && t - mine.t < 3) || t - (lastOf.get(key) ?? -Infinity) < sameGap) continue;
      lastOf.set(key, t);
      for (const speaker of speakers) out.push({ speaker, t, emoji: hit[1], label: hit[2] });
    }
  }
  return out;
}

/** the latest line or two as chat bubbles, each word lighting up as it's said */
class Subtitles {
  private shown = "";
  private spans: { el: HTMLElement; t: number }[] = [];

  reset() {
    this.shown = "";
  }

  show(lines: SongLine[], t: number, names: Record<SongLine["speaker"], string>, into: HTMLElement, max: number) {
    const pick = lines.filter((l) => l.start <= t && t < l.end + 1.5).slice(-max);
    const key = `${into.id}|${pick.map((l) => `${l.start}:${windowStart(l, t, max)}`).join("|")}`;
    if (key !== this.shown) {
      // moved between the stage and the caption box (phone): clear the other
      if (!this.shown.startsWith(`${into.id}|`)) for (const id of ["rc-subs", "rc-caption"]) document.getElementById(id)?.replaceChildren();
      this.shown = key;
      into.replaceChildren();
      this.spans = [];
      for (const [i, l] of pick.entries()) {
        const div = document.createElement("div");
        div.className = `rc-sub ${l.speaker}${i < pick.length - 1 ? " old" : ""}`;
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = names[l.speaker];
        div.append(who);
        const from = windowStart(l, t, max);
        if (from > 0) div.append("… ");
        for (const [wt, text] of l.words.slice(from)) {
          const span = document.createElement("i");
          span.textContent = text.trimEnd();
          // what was beeped or masked: "<my name>", "*********mi"
          if (/<[^>]+>|\*/.test(text)) span.classList.add("red");
          div.append(span, text.slice(text.trimEnd().length));
          this.spans.push({ el: span, t: wt });
        }
        into.append(div);
      }
    }
    for (const s of this.spans) s.el.classList.toggle("on", s.t <= t);
  }
}

/** long lines scroll: once past the first screenful, show from 8 words back, in steps */
function windowStart(l: SongLine, t: number, max: number): number {
  const keep = max === 1 ? 20 : 26;
  if (l.words.length <= keep) return 0;
  let i = 0;
  while (i + 1 < l.words.length && l.words[i + 1]![0] <= t) i++;
  const step = keep - 14;
  return i < keep - 4 ? 0 : Math.min(l.words.length - keep, Math.floor((i - 8) / step) * step);
}

function place(el: HTMLElement, [x, y]: [number, number]) {
  el.style.setProperty("--x", `${x * 100}%`);
  el.style.setProperty("--y", `${y * 100}%`);
}

/** a bounce in from 0 to 1 over `d` seconds */
function pop(s: number, d = 0.45): number {
  const x = clamp01(s / d);
  return x >= 1 ? 1 : 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
}

void main();
