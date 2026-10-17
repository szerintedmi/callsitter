// A demo's prologue over the player's stage (listen.ts; the data: listen-story.ts): the owner's
// phone ringing with the caller ID, title cards, a "real call" tag, the time-lapse's clock, the
// scene dimmed while the owner texts the bot, and the antenna lighting up as it gets the message.
// Every frame is drawn from t alone, like the rest of the page, on the live page and the recorder's.
// The look is the edit overlays' (src/web/listen.ts editCss) plus its own (prologueCss).
import type { CallScene } from "./listen-scene";
import { beatsOf, blinkAt, clamp01, clockTime, easeInOut, keyTimes, pop, type BeatOf, type Prologue } from "./listen-story";

type Anchors = ReturnType<CallScene["anchors"]>;
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
/** past 1 and back: an entrance with a little overshoot */
const easeBack = (x: number) => {
  const u = clamp01(x) - 1;
  return 1 + 2.4 * u * u * u + 1.4 * u * u;
};
const FADE = 0.3;
/** the siren's blue/red, a second for both */
const SIREN_HZ = 1;
/** the phone: ringing, held up for the chat (about 70% of a 16:9 frame's height), and in the call (the edit's message overlay's size) */
const RINGING = { pz: 1.2, w: 20, h: 36, y: 0.43 };
const UP = { pz: 1.5, w: 18.5, h: 26.3, y: 0.565 };
const CALL = { pz: 1, w: 25, h: 15 };
/** a tall frame's (the recorder's Shorts): a card that follows an eye line sits this far above it (of the frame's
 * height), over the head; a card while the phone's up sits just above the phone, at least this big */
const TALL_ABOVE_EYES = 0.12;
const TALL_OVER_PHONE = { y: 0.235, size: 1.1 };
/** …and the ringing phone sits lower, under its caption */
const TALL_RINGING_Y = 0.46;

/** pixel art, one rect per run: a police light, a handset, a send arrow, a tick */
const px = (w: number, h: number, rects: [number, number, number, number, string][], cls = "") =>
  `<svg class="${cls}" viewBox="0 0 ${w} ${h}">${rects.map(([x, y, rw, rh, c]) => `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${c}"/>`).join("")}</svg>`;
const LIGHT = px(14, 12, [
  [4, 1, 6, 1, "var(--lb,#3d6bff)"], [3, 2, 8, 1, "var(--lb,#3d6bff)"], [2, 3, 10, 5, "var(--lb,#3d6bff)"], [4, 2, 2, 3, "#cfe0ff"],
  [1, 8, 12, 2, "#2c2a33"], [0, 10, 14, 2, "#1b1a20"],
], "pl-light");
const HANDSET = (c: string) => px(9, 9, [[0, 0, 3, 3, c], [1, 3, 2, 1, c], [2, 4, 2, 1, c], [3, 5, 2, 1, c], [4, 6, 2, 1, c], [5, 6, 1, 2, c], [6, 6, 3, 3, c]]);
/** hung up: the handset lying flat */
const HUNG_UP = (c: string) => px(9, 9, [[1, 2, 7, 2, c], [0, 4, 3, 2, c], [6, 4, 3, 2, c]]);
const ARROW = px(8, 8, [[0, 0, 2, 8, "#0e0d10"], [2, 1, 2, 6, "#0e0d10"], [4, 2, 2, 4, "#0e0d10"], [6, 3, 2, 2, "#0e0d10"]]);
const TICK = px(8, 6, [[0, 3, 2, 2, "#35d07a"], [2, 4, 2, 2, "#35d07a"], [4, 2, 2, 2, "#35d07a"], [6, 0, 2, 2, "#35d07a"]], "pl-tick");

const el = (tag: string, cls: string, parent?: HTMLElement) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.append(e);
  return e;
};
const set = (e: Element, vars: Record<string, string | number>) => {
  for (const [k, v] of Object.entries(vars)) (e as HTMLElement).style.setProperty(`--${k}`, String(v));
};
const show = (e: HTMLElement, on: boolean) => {
  e.style.display = on ? "" : "none";
};
/** text with *emphasis* in amber */
function rich(into: HTMLElement, text: string) {
  for (const [i, part] of text.split(/\*([^*]+)\*/).entries()) {
    if (i % 2) el("em", "", into).textContent = part;
    else into.append(part);
  }
}
/** "A · B" as two spans and the dot between them, so a tall frame can show two lines (listen.ts: .sep) */
export function splitLine(into: HTMLElement, text: string) {
  if (into.dataset.text === text) return;
  into.dataset.text = text;
  into.textContent = "";
  for (const [i, part] of text.split(" · ").entries()) {
    if (i) el("i", "sep", into).textContent = " · ";
    el("span", "", into).textContent = part;
  }
}
/** "7:30" */
const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export class PrologueLayer {
  private root: HTMLElement;
  private draws: ((t: number) => void)[] = [];
  private glow: HTMLElement;
  private anchors?: Anchors;
  private ping: HTMLElement;

  constructor(stage: HTMLElement, private p: Prologue, before: Element | null) {
    this.root = el("div", "rc-pro");
    stage.insertBefore(this.root, before);
    this.glow = el("div", "pl-glow", this.root);
    this.ping = el("div", "pl-ping", this.root);
    for (const d of beatsOf(p, "dim")) this.dim(d);
    for (const c of beatsOf(p, "card")) this.card(c);
    for (const c of beatsOf(p, "clock")) this.clock(c);
    for (const g of beatsOf(p, "tag")) this.tag(g);
    this.phone(beatsOf(p, "ring")[0], beatsOf(p, "phone")[0]);
  }

  /** the stage is a tall frame's */
  private tall() {
    return this.root.parentElement?.dataset.shape === "tall";
  }

  remove() {
    this.root.remove();
  }

  /** time t; `at`: where things are in the scene, 0–1 on the stage (the antenna's tip for its blinks, the eye lines for a card that follows one) */
  draw(t: number, at: Anchors) {
    this.anchors = at;
    const antenna = at.antenna;
    for (const d of this.draws) d(t);
    const blink = blinkAt(this.p, t);
    const tip = { x: `${antenna[0] * 100}%`, y: `${antenna[1] * 100}%` };
    set(this.glow, { ...tip, o: Math.max(0, blink ?? 0) });
    const since = beatsOf(this.p, "blink").flatMap((b) => b.at).map((b) => t - b).find((s) => s >= 0 && s < 0.5);
    set(this.ping, { ...tip, o: since === undefined ? 0 : 1 - since / 0.5, d: 2 + (since ?? 0) * 12 });
  }

  private dim(d: BeatOf<"dim">) {
    const e = el("div", "pl-dim", this.root);
    this.draws.push((t) => {
      const o = (d.amount ?? 0.85) * easeOut((t - d.start) / 0.45) * (1 - easeOut((t - d.end) / 0.4));
      show(e, o > 0.001 && t >= d.start);
      set(e, { o });
    });
  }

  /** a title card, built like an edit's (listen-edit.ts): a pop in, a fade over its last 0.3 s */
  private card(c: BeatOf<"card">) {
    const e = el("div", `rc-card${c.align === "left" ? " pl-left" : ""}`, this.root);
    const b = el("b", "", e);
    rich(b, c.text);
    if (c.sub) el("small", "", b).textContent = c.sub;
    const chat = beatsOf(this.p, "phone")[0];
    const overPhone = !!chat && c.start < chat.handoff && c.end > chat.start;
    // a tall frame's: over the dimmed phone, as amber text (listen.ts: .pl-over)
    e.classList.toggle("pl-over", overPhone);
    this.draws.push((t) => {
      const on = t >= c.start && t < c.end;
      show(e, on);
      if (!on) return;
      set(e, { s: c.in === "none" ? 1 : pop(t - c.start), o: clamp01((c.end - t) / FADE) });
      const tall = this.tall();
      const eyes = c.follow && this.anchors?.[c.follow === "agent" ? "agentEyes" : "callerEyes"];
      const y = eyes ? eyes[1] - (tall ? TALL_ABOVE_EYES : 0) : tall && overPhone ? TALL_OVER_PHONE.y : (c.pos ?? 0.5);
      set(e, { y: `${(y * 100).toFixed(2)}%`, k: tall && overPhone ? Math.max(c.size ?? 1, TALL_OVER_PHONE.size) : (c.size ?? 1) });
    });
  }

  /** the call's time: racing through the time-lapse, landing, then the call's own as it plays */
  private clock(c: BeatOf<"clock">) {
    const e = el("div", "rc-clock top-left", this.root);
    const b = el("b", "", e);
    if (c.label) el("small", "", e).textContent = c.label.toUpperCase();
    this.draws.push((t) => {
      const on = t >= c.start && t < (c.end ?? Infinity);
      show(e, on);
      if (!on) return;
      set(e, { s: pop(t - c.start), o: c.end === undefined ? 1 : clamp01((c.end - t) / FADE) });
      const text = mmss(clockTime(c, this.p.duration, t));
      if (b.textContent !== text) b.textContent = text;
    });
  }

  /** a small label, its red dot pulsing like a TV's LIVE light (about once a second) */
  private tag(g: BeatOf<"tag">) {
    const e = el("div", "pl-tag", this.root);
    const dot = el("i", "", e);
    e.append(g.text);
    this.draws.push((t) => {
      const on = t >= g.start && t < g.end;
      show(e, on);
      if (!on) return;
      set(e, { o: Math.min(clamp01((t - g.start) / FADE), clamp01((g.end - t) / FADE)) });
      set(dot, { o: (0.35 + 0.65 * easeInOut(0.5 + 0.5 * Math.cos(2 * Math.PI * (t - g.start)))).toFixed(3) });
    });
  }

  /** The owner's phone: ringing (black around it, a siren wash) until it's answered; then later the chat with the bot, the message typed and sent, shrinking to its place for the call. */
  private phone(ring: BeatOf<"ring"> | undefined, chat: BeatOf<"phone"> | undefined) {
    if (!ring && !chat) return;
    const black = el("div", "pl-black", this.root);
    const siren = el("div", "pl-siren", this.root);
    const cap = el("div", "pl-cap", this.root);
    splitLine(cap, ring?.caption?.text ?? "");
    const msg = el("div", "pl-msg", this.root);
    msg.innerHTML = `<div class="rc-phone">
    <i class="rc-phone-cam"></i>
    <div class="pl-ring"><div class="pl-inc"></div>${LIGHT}<div class="pl-id"></div>
      <div class="pl-btns"><i class="pl-no">${HUNG_UP("#fff6ec")}</i><i class="pl-yes">${HANDSET("#04230f")}</i></div></div>
    <div class="rc-phone-top"><i></i><span></span></div>
    <div class="pl-space"></div>
    <div class="rc-phone-chat"><div class="rc-bub"><small></small><span></span>${TICK}</div></div>
    <div class="pl-input"><div class="pl-field"><span></span><i class="pl-caret"></i></div><i class="pl-send">${ARROW}</i></div>
  </div>`;
    const flash = el("div", "pl-flash", this.root);
    const q = <T extends Element = HTMLElement>(s: string) => msg.querySelector(s) as unknown as T;
    const ph = q(".rc-phone");
    const [ringEl, top, space, chatEl, input, bub, typed, caret, send, yes, light, tick] = (
      [".pl-ring", ".rc-phone-top", ".pl-space", ".rc-phone-chat", ".pl-input", ".rc-bub", ".pl-field span", ".pl-caret", ".pl-send", ".pl-yes", ".pl-light", ".pl-tick"] as const
    ).map((s) => q(s)) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    if (ring) {
      q(".pl-inc").innerHTML = `${ring.label ?? "INCOMING CALL"}<i>…</i>`;
      q(".pl-id").textContent = ring.id;
    }
    if (chat) {
      q(".rc-phone-top span").textContent = (chat.chat ?? "MY BOT").toUpperCase();
      q(".rc-bub small").textContent = (chat.sender ?? "ME").toUpperCase();
      q(".rc-bub span").textContent = chat.text;
    }
    const keys = chat ? keyTimes(chat.text, chat.typing) : { chars: [], times: [] };

    this.draws.push((t) => {
      const ringing = !!ring && t >= ring.start && t < ring.end;
      show(black, ringing);
      show(siren, ringing);
      show(cap, ringing);
      show(flash, ringing);
      const chatting = !!chat && t >= chat.start && t < chat.end;
      show(msg, ringing || chatting);
      if (ringing) {
        // the siren, soft: about once a second, blue on the left then red on the right
        const side = 0.5 + 0.5 * Math.tanh(3 * Math.sin(2 * Math.PI * SIREN_HZ * t));
        set(siren, { b: (0.45 * side).toFixed(3), r: (0.4 * (1 - side)).toFixed(3) });
        set(cap, { o: ring.caption ? easeOut((t - ring.caption.at) / 0.4) : 0 });
        set(flash, { o: t >= ring.answer ? 0.2 * Math.exp(-(t - ring.answer) * 24) : 0 });
        show(ringEl, true);
        for (const e of [top, chatEl, space, input]) show(e, false);
        // a buzz: a quick shake, side to side and a little turn
        let dx = 0;
        let r = 0;
        for (const b of ring.buzz) {
          const u = (t - b) / 0.3;
          if (u < 0 || u >= 1) continue;
          const env = Math.sin(Math.PI * u);
          dx += env * 0.5 * Math.sin(2 * Math.PI * 26 * (t - b));
          r += env * 1.4 * Math.sin(2 * Math.PI * 19 * (t - b) + 1);
        }
        set(msg, { y: `${(this.tall() ? TALL_RINGING_Y : RINGING.y) * 100}%`, dx: `${dx}cqw`, r: `${r}deg`, o: 1 });
        set(ph, RINGING);
        set(light, { lb: Math.sin(2 * Math.PI * SIREN_HZ * t) < 0 ? "#d8281f" : "#3d6bff" });
        const press = t >= ring.answer;
        set(yes, { s: press ? 1 : 1 + 0.08 * Math.max(0, Math.sin(t * 7)), p: press ? "0.3cqw" : 0 });
        return;
      }
      if (!chatting) return;
      // up from below, then held; at the handoff, into its place and size for the call
      const up = easeBack((t - chat.start) / 0.6);
      const u = easeInOut((t - chat.handoff) / 0.4);
      const handed = t >= chat.handoff + 0.4;
      show(ringEl, false);
      show(top, true);
      show(chatEl, true);
      show(space, !handed);
      show(input, !handed);
      const y = 130 - (130 - UP.y * 100) * up + ((chat.pos ?? 0.42) - UP.y) * 100 * u;
      // a tall frame has no room for it in the call (it'd sit on the subtitles): it fades as it hands off
      set(msg, { y: `${y.toFixed(2)}%`, dx: "0cqw", r: "0deg", o: clamp01((chat.end - t) / FADE) * (this.tall() ? 1 - u : 1) });
      set(ph, { pz: UP.pz + (CALL.pz - UP.pz) * u, w: UP.w + (CALL.w - UP.w) * u, h: UP.h + (CALL.h - UP.h) * u });
      set(space, { g: 1 - u });
      set(input, { ih: 1 - u });
      const n = keys.times.filter((k) => k <= t).length;
      const sent = t >= chat.sent;
      const text = sent ? "" : keys.chars.slice(0, n).join("");
      if (typed.textContent !== text) typed.textContent = text;
      const typing = t >= chat.typing[0] && t < chat.typing[1] + 0.1;
      set(caret, { o: typing || Math.floor(t * 2.4) % 2 ? 1 : 0 });
      set(send, { s: sent ? 1 + 0.25 * Math.exp(-(t - chat.sent) * 12) : n === keys.chars.length ? 1 + 0.06 * Math.sin(t * 8) : 1 });
      show(bub, sent);
      set(bub, { s: pop(t - chat.sent, 0.3) });
      set(tick, { o: easeOut((t - chat.sent - 0.25) / 0.2) * (1 - u) });
    });
  }
}
