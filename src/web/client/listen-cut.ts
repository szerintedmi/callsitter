// An edit of a demo call for a video (demos/tools/record.ts --edit, which documents the file): the
// stretches of the call to show, in order, and what goes over them, timed on the video's clock.
// Pure (no DOM, no Bun): the recorder builds the audio from it and the render page (listen.ts,
// listen-edit.ts) the picture, so both cut in the same places.

/** a stretch of the call; or a still of one moment of it, `for` seconds */
export type CutSegment =
  | {
      from: number;
      to: number;
      /** round both ends to the song's beat grid (bpm and first beat from the call's song) */
      snap?: "bar" | "beat";
      /** faster than real time (a "time passing" montage) */
      speed?: number;
      /** its sound: as it is (the default at speed 1), silence (the default faster), or sped up, its pitch kept */
      audio?: "on" | "mute" | "fast";
      /** the audio's crossfade into it, s */
      fade?: number;
    }
  | { hold: number; for: number; fade?: number };

export type OverlayIn = "pop" | "fade" | "none";
export interface OverlayTiming {
  /** on the video's clock, s */
  start: number;
  /** until the end if left out */
  end?: number;
  in?: OverlayIn;
  out?: "fade" | "none";
}
/** where on the frame: a preset or the middle's height, 0–1 */
export type OverlayPos = "top" | "center" | "bottom" | number;
export type Overlay = OverlayTiming &
  (
    | { type: "card"; text: string; pos?: OverlayPos; size?: number; dim?: boolean }
    | { type: "message"; text: string | string[]; chat?: string; sender?: string; pos?: OverlayPos; side?: "left" | "right" | "center"; every?: number }
    | { type: "clock"; label?: string; offset?: number; pos?: "top-left" | "top" | "top-right" }
    | { type: "endcard"; title: string; subtitle?: string; url?: string }
  );

export interface Cut {
  segments: CutSegment[];
  overlays?: Overlay[];
  /** the default crossfade at every cut, s */
  fade?: number;
  /** the prologue's cards to leave out, by their text (an edit that shows its own instead) */
  hide?: string[];
}

/** A segment placed on the video's clock: `len` s from `out`, showing the call from `from` to `to`. */
export interface Piece {
  out: number;
  len: number;
  from: number;
  to: number;
  /** call seconds per video second (0 for a hold) */
  speed: number;
  audio: "on" | "mute" | "fast";
  /** the crossfade into it */
  fade: number;
}

export interface ResolvedCut {
  pieces: Piece[];
  duration: number;
}

export const CUT_FADE = 0.04;

/**
 * Places the segments end to end. Each lasts a whole number of frames (its end moves by under a
 * frame to fit), so the cuts land on frames and the audio, placed by the same pieces, stays in step.
 */
export function resolveCut(cut: Cut, song: { bpm: number; beat: number } | undefined, fps: number): ResolvedCut {
  const pieces: Piece[] = [];
  let out = 0;
  for (const [i, s] of cut.segments.entries()) {
    const fade = s.fade ?? cut.fade ?? CUT_FADE;
    if ("hold" in s) {
      if (!(s.for > 0)) throw new Error(`segment ${i}: a hold needs "for" > 0`);
      const len = Math.round(s.for * fps) / fps;
      pieces.push({ out, len, from: s.hold, to: s.hold, speed: 0, audio: "mute", fade });
      out += len;
      continue;
    }
    let { from, to } = s;
    if (s.snap) {
      if (!song) throw new Error(`segment ${i}: snap needs the call's song`);
      const step = ((s.snap === "bar" ? 4 : 1) * 60) / song.bpm;
      const snap = (x: number) => song.beat + Math.round((x - song.beat) / step) * step;
      from = snap(from);
      to = snap(to);
    }
    const speed = s.speed ?? 1;
    if (!(speed > 0)) throw new Error(`segment ${i}: speed must be > 0`);
    if (!(to > from)) throw new Error(`segment ${i}: "to" must be after "from"`);
    const frames = Math.max(1, Math.round(((to - from) / speed) * fps));
    const len = frames / fps;
    pieces.push({ out, len, from, to: from + len * speed, speed, audio: s.audio ?? (speed === 1 ? "on" : "mute"), fade });
    out += len;
  }
  return { pieces, duration: out };
}

/** the piece showing at video time `t` (the last one past the end) */
export function pieceAt(pieces: Piece[], t: number): Piece | undefined {
  let i = 0;
  // a frame's time can land a hair before a cut that's on it
  while (i + 1 < pieces.length && pieces[i + 1]!.out <= t + 1e-6) i++;
  return pieces[i];
}

/** the call's time at video time `t` */
export function callTimeAt(pieces: Piece[], t: number): number {
  const p = pieceAt(pieces, t);
  return p ? p.from + Math.max(0, t - p.out) * p.speed : t;
}
