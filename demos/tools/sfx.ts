// Synthesized sound effects for a demo's prologue (prologue.ts): ffmpeg lavfi sources, 48 kHz mono,
// chiptune-ish, nothing sampled. Each is a name (what a storyboard asks for) and its parameters.

const SR = "s=48000";

/** each sound's source, by name; `d` its length where it has one, `duck` stretches (s into it) to soften */
export const SOUNDS = {
  /** the phone's motor: a low hum with a rattle */
  buzz: () => `aevalsrc='(0.55*sin(2*PI*82*t)+0.22*sgn(sin(2*PI*164*t)))*(0.75+0.25*sin(2*PI*31*t))':${SR}:d=0.3,lowpass=f=700,afade=t=in:d=0.02,afade=t=out:st=0.22:d=0.08`,
  /** picking up */
  click: () => `aevalsrc='(2*random(0)-1)*exp(-260*t)+0.4*sin(2*PI*1400*t)*exp(-90*t)':${SR}:d=0.08,highpass=f=300`,
  /** a card popping in */
  pop: () => `aevalsrc='0.5*sin(2*PI*(380*t+220*t*t))*exp(-26*t)':${SR}:d=0.18`,
  /** the time-lapse's tick, a square blip at `hz` */
  tick: (o: { hz: number }) => `aevalsrc='0.5*sgn(sin(2*PI*${o.hz}*t))*exp(-70*t)':${SR}:d=0.04`,
  /**
   * the time-lapse's bed, `d` s: a 12-a-second blip running a four-note pattern over a buzzing low
   * hum, softer through `duck`, cut dead at its end
   */
  bed: (o: { d: number; duck: [number, number][] }) =>
    `aevalsrc='0.35*sgn(sin(2*PI*if(eq(mod(floor(t*12),4),0),1047,if(eq(mod(floor(t*12),4),2),880,784))*t))*exp(-55*mod(t,1/12))+0.14*sgn(sin(2*PI*65*t))*(0.6+0.4*sin(2*PI*24*t))':${SR}:d=${o.d.toFixed(3)},` +
    `lowpass=f=5000,afade=t=in:d=0.3,afade=t=out:st=${(o.d - 0.02).toFixed(3)}:d=0.02` +
    (o.duck.length ? `,volume=volume='1-0.6*min(1,${o.duck.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join("+")})':eval=frame` : ""),
  /** the clock landing */
  thump: () => `aevalsrc='0.8*sin(2*PI*(48*t+5*(1-exp(-18*t))))*exp(-7*t)':${SR}:d=0.6`,
  /** a key on the phone */
  key: () => `aevalsrc='(2*random(0)-1)*exp(-420*t)+0.25*sgn(sin(2*PI*2200*t))*exp(-160*t)':${SR}:d=0.04,highpass=f=900`,
  /** sent: a rising blip (two of them, at 1319 and 1760 Hz) */
  sent: (o: { hz: number }) => `aevalsrc='0.45*sgn(sin(2*PI*${o.hz}*t))*exp(-35*t)':${SR}:d=0.09`,
  /** and a soft whoosh */
  whoosh: () => `anoisesrc=d=0.5:c=pink:r=48000:a=0.6,highpass=f=500,lowpass=f=6000,afade=t=in:d=0.28:curve=qsin,afade=t=out:st=0.28:d=0.22:curve=qsin`,
  /** a quiet room, `d` s, so a held beat isn't a dropout */
  hum: (o: { d: number }) => `anoisesrc=d=${o.d.toFixed(2)}:c=brown:r=48000:a=0.5,lowpass=f=220,afade=t=in:d=0.6,afade=t=out:st=${(o.d - 0.5).toFixed(2)}:d=0.5`,
  /** the antenna: message received */
  blip: () => `aevalsrc='0.5*sin(2*PI*880*t)*exp(-14*t)+0.2*sin(2*PI*1760*t)*exp(-20*t)':${SR}:d=0.35`,
} as const;

export type SoundName = keyof typeof SOUNDS;
export const isSound = (name: string): name is SoundName => name in SOUNDS;

/** a sound placed: at `at` s, `gain` dB, with its parameters */
export interface Sfx {
  at: number;
  sound: SoundName;
  gain: number;
  params?: Record<string, unknown>;
}

/** the ffmpeg source for a placed sound */
export const sourceOf = (s: Sfx): string => (SOUNDS[s.sound] as (o: never) => string)((s.params ?? {}) as never);
