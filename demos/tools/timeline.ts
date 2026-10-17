// Moving a demo's times around (build.ts): stretches cut out of the call (its goodbye's pauses), and
// everything after a prologue moved later by its length. Pure, so it's tested on its own.
import type { DemoCall } from "./build";

/**
 * Stretches cut out of a clip ([from, to] on its clock) as a map from its times to the shortened
 * clock: a time after a stretch moves back by its length, one inside it goes to where it was cut.
 */
export function trimmer(trims: [number, number][]): (t: number) => number {
  const ts = [...trims].sort((a, b) => a[0] - b[0]);
  for (const [i, [a, b]] of ts.entries()) if (!(b > a) || (i > 0 && a < ts[i - 1]![1])) throw new Error(`trim ${a}–${b}: empty, or overlapping the one before`);
  return (t) => {
    let out = t;
    for (const [a, b] of ts) out -= Math.max(0, Math.min(t, b) - a);
    return out;
  };
}

/**
 * Mono samples with the stretches cut out, each cut crossfaded over `fade` s (equal power, centred
 * on the cut), so the result is exactly the stretches' length shorter.
 */
export function trimSamples(x: Float32Array, rate: number, trims: [number, number][], fade: number): Float32Array {
  const ts = [...trims].sort((a, b) => a[0] - b[0]).map(([a, b]) => [Math.round(a * rate), Math.round(b * rate)] as const);
  const half = Math.round((fade * rate) / 2);
  const cut = ts.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Float32Array(x.length - cut);
  // the kept stretches, end to end; at each join the one before fades out as the next fades in
  let from = 0;
  let o = 0;
  for (const [a, b] of [...ts, [x.length, x.length] as const]) {
    for (let i = from; i < a; i++) out[o++] = x[i]!;
    if (a >= x.length) break;
    const w = Math.min(half, a - from, x.length - b);
    o -= w;
    for (let k = -w; k < w; k++) {
      const u = (k + w) / (2 * w);
      out[o++] = (x[a + k] ?? 0) * Math.cos((u * Math.PI) / 2) + (x[b + k] ?? 0) * Math.sin((u * Math.PI) / 2);
    }
    from = b + w;
  }
  return out;
}

/** a demo's times mapped by `f` (trims, or moving it later): lines and words, beeps, verdicts, stages, the song */
export function retime(call: Pick<DemoCall, "lines" | "beeps" | "verdicts" | "stages" | "song">, f: (t: number) => number): Pick<DemoCall, "lines" | "beeps" | "verdicts" | "stages" | "song"> {
  const r = (t: number) => Math.round(f(t) * 100) / 100;
  return {
    lines: call.lines.map((l) => ({ ...l, start: r(l.start), end: r(l.end), words: l.words.map(([t, w]): [number, string] => [r(t), w]) })),
    beeps: call.beeps.map((b) => ({ ...b, start: r(b.start), end: r(b.end) })),
    verdicts: call.verdicts.map(([t, ...p]) => [r(t), ...p]),
    stages: call.stages.map(([t, s]) => [r(t), s]),
    ...(call.song && {
      song: { ...call.song, start: r(call.song.start), end: r(call.song.end), beat: r(call.song.beat), lines: call.song.lines.map((l) => ({ ...l, start: r(l.start), end: r(l.end), words: l.words.map(([t, w]): [number, string] => [r(t), w]) })) },
    }),
  };
}
