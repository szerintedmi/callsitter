// The player's fullscreen on the live page (listen.ts): its button, and on a phone turned to
// landscape while it plays, the player (stage and captions) fills the screen; back to portrait, the
// ✕, Escape or the Back gesture leave it. The Fullscreen API where it works (prefixed in older
// WebKit), else (iPhone Safari: no element fullscreen) a pseudo-fullscreen in CSS (.fs, listen.ts
// realCallsCss) that behaves the same. Entering pushes a history entry, so Back leaves fullscreen
// rather than the page. What each event does is listen-story.ts fsStep (pure, tested).

import { FS_OFF, fsStep, type FsEffect, type FsEvent } from "./listen-story";

/** how long the ✕ stays up without a touch */
const IDLE_MS = 2000;

type Fs = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

/**
 * Wires fullscreen to the player: `root` (stage and captions) goes fullscreen; `button` toggles it,
 * `close` (the ✕) leaves; `playing()` tells whether it plays (for rotating in); `changed` reports
 * each change (analytics) and lets the page redraw.
 */
export function fullscreen(o: { root: HTMLElement; button: HTMLElement; close: HTMLElement; playing: () => boolean; changed: (on: boolean, how: string) => void }) {
  const doc = document as FsDoc;
  const root = o.root as Fs;
  let state = FS_OFF;
  /** our own history.back(): its popstate isn't the user's Back */
  let popping = false;
  let native = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = window.matchMedia("(pointer: coarse)");
  const landscape = window.matchMedia("(orientation: landscape)");

  const wake = () => {
    root.classList.remove("idle");
    clearTimeout(idle);
    if (state.on) idle = setTimeout(() => root.classList.add("idle"), IDLE_MS);
  };
  const apply = (effects: FsEffect[], how: string) => {
    for (const fx of effects) {
      if (fx === "enter") {
        root.classList.add("fs");
        document.documentElement.classList.add("rc-fs-on");
        // the real thing if the browser allows it here (it wants a tap); else the CSS one stays
        const req = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
        native = false;
        if (req) {
          Promise.resolve()
            .then(() => req())
            .then(() => (native = true))
            .catch(() => {});
        }
        wake();
      } else if (fx === "exit") {
        root.classList.remove("fs", "idle");
        document.documentElement.classList.remove("rc-fs-on");
        clearTimeout(idle);
        if (doc.fullscreenElement ?? doc.webkitFullscreenElement) void Promise.resolve((doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)).catch(() => {});
        native = false;
      } else if (fx === "push") history.pushState({ rcFullscreen: true }, "");
      else if (fx === "pop") {
        popping = true;
        history.back();
      } else if (fx === "lock") {
        const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        // after the fullscreen's granted: phones only lock in fullscreen
        setTimeout(() => void o?.lock?.("landscape").catch(() => {}), 150);
      }
    }
    if (effects.includes("enter") || effects.includes("exit")) o.changed(state.on, how);
  };
  const send = (e: FsEvent, how: string) => {
    const r = fsStep(state, e);
    state = r.state;
    apply(r.effects, how);
  };

  o.button.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "button" }, "button");
  });
  o.close.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.on) send({ type: "button" }, "close");
  });
  landscape.addEventListener("change", () => send({ type: "rotate", landscape: landscape.matches, playing: o.playing(), touch: touch.matches }, "rotate"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.on) send({ type: "escape" }, "escape");
  });
  window.addEventListener("popstate", () => {
    if (popping) popping = false;
    else if (state.on) send({ type: "back" }, "back");
  });
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => {
      if (native && !(doc.fullscreenElement ?? doc.webkitFullscreenElement) && state.on) send({ type: "native-exit" }, "escape");
    });
  }
  // the ✕ comes back on a touch, and fades again
  for (const ev of ["pointerdown", "pointermove", "touchstart"]) root.addEventListener(ev, wake, { passive: true });
  return { isOn: () => state.on };
}
