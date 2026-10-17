// What an edit (listen-cut.ts) puts over the player on the recorder's page: title cards, the owner's
// messages to the bot on a phone, a call timer and an end card. Every frame is drawn from the
// video's time alone, like the rest of the page, so the recorder's workers can render in parallel.
// The look is the page's: pixel fonts, near-black, amber and ivory, hard shadows (the CSS:
// src/web/listen.ts editCss).
import type { Overlay, OverlayPos } from "./listen-cut";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** a bounce in from 0 to 1 over `d` seconds (listen.ts's) */
function pop(s: number, d = 0.45): number {
  const x = clamp01(s / d);
  return x >= 1 ? 1 : 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
}
const FADE = 0.3;
/** when a message's bubbles come, s after it starts (and its typing dots before each) */
const FIRST_BUBBLE = 0.9;
const TYPING = 0.7;

const el = (tag: string, cls: string, parent?: HTMLElement) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.append(e);
  return e;
};
/** text with *emphasis* in amber; \n breaks the line (CSS pre-line) */
function rich(into: HTMLElement, text: string) {
  for (const [i, part] of text.split(/\*([^*]+)\*/).entries()) {
    if (i % 2) el("em", "", into).textContent = part;
    else into.append(part);
  }
}
const posY = (p: OverlayPos | undefined, fallback: number) => (typeof p === "number" ? p : p === "top" ? 0.16 : p === "bottom" ? 0.68 : p === "center" ? 0.5 : fallback);
/** "4:07", "1:02:05" */
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const mm = `${Math.floor(t / 60) % 60}`;
  return t >= 3600 ? `${Math.floor(t / 3600)}:${mm.padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${mm}:${String(t % 60).padStart(2, "0")}`;
};

interface Drawn {
  o: Overlay;
  root: HTMLElement;
  /** per frame, after the envelope: what moves inside */
  update?(t: number, callT: number): void;
}

export class EditOverlays {
  private drawn: Drawn[] = [];

  constructor(stage: HTMLElement, overlays: Overlay[], private duration: number) {
    const layer = el("div", "rc-edit", stage);
    for (const o of overlays) this.drawn.push(build(o, layer));
  }

  /** the overlays at video time `t`, over the call at `callT` */
  draw(t: number, callT: number) {
    for (const d of this.drawn) {
      const { o, root } = d;
      const end = o.end ?? this.duration + 1;
      const on = t >= o.start && t < end;
      root.style.display = on ? "" : "none";
      if (!on) continue;
      const since = t - o.start;
      const how = o.in ?? (o.type === "endcard" ? "fade" : "pop");
      let opacity = how === "fade" ? clamp01(since / FADE) : 1;
      if ((o.out ?? "fade") === "fade" && o.end !== undefined) opacity *= clamp01((end - t) / FADE);
      root.style.setProperty("--s", String(how === "pop" ? pop(since) : 1));
      root.style.setProperty("--o", String(opacity));
      d.update?.(t, callT);
    }
  }
}

function build(o: Overlay, layer: HTMLElement): Drawn {
  switch (o.type) {
    case "card": {
      const root = el("div", `rc-card${o.dim ? " dim" : ""}`, layer);
      root.style.setProperty("--y", `${posY(o.pos, 0.5) * 100}%`);
      if (o.size) root.style.setProperty("--k", String(o.size));
      rich(el("b", "", root), o.text);
      return { o, root };
    }
    case "message": {
      const root = el("div", `rc-msg ${o.side ?? "center"}`, layer);
      root.style.setProperty("--y", `${posY(o.pos, 0.42) * 100}%`);
      const phone = el("div", "rc-phone", root);
      el("i", "rc-phone-cam", phone);
      const top = el("div", "rc-phone-top", phone);
      el("i", "", top);
      el("span", "", top).textContent = (o.chat ?? "MY BOT").toUpperCase();
      const chat = el("div", "rc-phone-chat", phone);
      const texts = typeof o.text === "string" ? [o.text] : o.text;
      const every = o.every ?? 1.6;
      const bubbles = texts.map((text) => {
        const b = el("div", "rc-bub", chat);
        el("small", "", b).textContent = (o.sender ?? "YOU").toUpperCase();
        rich(el("span", "", b), text);
        return b;
      });
      const typing = el("div", "rc-typing", chat);
      const dots = [0, 1, 2].map(() => el("i", "", typing));
      return {
        o,
        root,
        update(t) {
          const since = t - o.start;
          let next = -1;
          bubbles.forEach((b, i) => {
            const at = FIRST_BUBBLE + i * every;
            b.style.display = since >= at ? "" : "none";
            b.style.setProperty("--s", String(pop(since - at, 0.3)));
            if (next < 0 && since < at) next = i;
          });
          // typing just before the next bubble
          const at = FIRST_BUBBLE + next * every;
          const typingNow = next >= 0 && since >= at - TYPING;
          typing.style.display = typingNow ? "" : "none";
          dots.forEach((d, i) => d.style.setProperty("--h", String(Math.max(0, Math.sin((since * 7 - i * 0.9) % (Math.PI * 2))))));
        },
      };
    }
    case "clock": {
      const root = el("div", `rc-clock ${o.pos ?? "top-left"}`, layer);
      const b = el("b", "", root);
      if (o.label) el("small", "", root).textContent = o.label.toUpperCase();
      return {
        o,
        root,
        update(_t, callT) {
          const text = clock(callT + (o.offset ?? 0));
          if (b.textContent !== text) b.textContent = text;
        },
      };
    }
    case "endcard": {
      const root = el("div", "rc-endcard", layer);
      rich(el("b", "", root), o.title);
      if (o.subtitle) rich(el("span", "", root), o.subtitle);
      if (o.url) el("u", "", root).textContent = o.url;
      return { o, root };
    }
  }
}
