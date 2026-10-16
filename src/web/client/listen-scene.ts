// The 3D half of the real-call player (listen.ts): two rooms joined by a phone cable, the caller
// on the left and the ScamSitter bot on the right, built from boxes (voxels, to match the arcade
// page). Every frame is a function of the call time alone (no state carried between frames), so
// the video recorder can render any frame in any order.
import * as THREE from "three";

export type SceneKind = "areyouai" | "police" | "cryptobot" | "electrician" | "coldcall";
/** the scam bot's mistakes: talking over, giving up mid-sentence, an off-script question */
export type BlunderKind = "talkover" | "cutoff" | "ignored";

/** a part of the song (listen.ts SONG_PARTS) */
export type SongSection = "intro" | "verse" | "build" | "chorus" | "fill" | "bridge" | "break" | "outro" | "finale" | "last" | "end";

/** Where the song after the call is (areyouai): the disco runs on its beat. */
export interface SongMoment {
  /** seconds into the song */
  since: number;
  /** beats since the first (fractional; negative before it) */
  beat: number;
  /** 0–1 through the current beat */
  phase: number;
  /** floor(beat / 4) */
  bar: number;
  section: SongSection;
  /** seconds into the section */
  sectionSince: number;
  /** how wild it gets, about 0–1.3, eased between sections */
  energy: number;
  /** the song's loudness now, 0–1 */
  music: number;
  /** seconds into a line everyone sings (the identity swap), or null */
  swap: number | null;
}

/** What a frame needs to know about the call at time t. */
export interface Moment {
  t: number;
  /** speech level now, 0–1 */
  level: { caller: number; agent: number };
  /** smoothed: who's been talking lately, 0–1 */
  active: { caller: number; agent: number };
  /** seconds since the scam/genuine stage began, or null before it */
  sinceStage: number | null;
  /** Jev's genuine probability (electrician) */
  genuine: number;
  /** caller is repeating itself (cryptobot): seconds into the current repeat, or null */
  looping: number | null;
  /** the caller's latest blunder (cryptobot) and seconds since, or null */
  blunder: { kind: BlunderKind; since: number } | null;
  /** the caller's gone quiet when it should answer (cryptobot) */
  buffering: boolean;
  /** seconds since the caller talked over the bot, or null */
  flinch: number | null;
  /** seconds since the call ended on a hang-up, or null: the caller's, in a huff (police), or the bot's (coldcall) */
  hangup: number | null;
  /** the song after the call (areyouai), or null outside it */
  song: SongMoment | null;
}

export interface CallScene {
  render(m: Moment): void;
  /** where the caller's and agent's heads and feet are on screen, 0–1 */
  anchors(): { callerHead: [number, number]; agentHead: [number, number]; callerFeet: [number, number]; agentFeet: [number, number] };
}

const lambert = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: string, emissive?: string): THREE.MeshLambertMaterial {
  const key = `${color}/${emissive ?? ""}`;
  let m = lambert.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive: emissive ?? "#000000", flatShading: true });
    lambert.set(key, m);
  }
  return m;
}
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

/** A box w×h×d whose bottom centre sits at (x, y, z) in `parent`. */
function box(parent: THREE.Object3D, w: number, h: number, d: number, color: string | THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo, typeof color === "string" ? mat(color) : color);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function group(parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/** A canvas texture with pixel-font text, for signs and screens. */
function textTexture(lines: string[], w: number, h: number, bg: string, fg: string, size: number, font = '"Jersey 10", monospace'): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  // "bold sans-serif" → "bold 34px sans-serif"
  const [weight, family] = font.startsWith("bold ") ? ["bold ", font.slice(5)] : ["", font];
  g.font = `${weight}${size}px ${family}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.05));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A whiteboard in marker: SCAM (with a grinning troll) and REAL, a pile of strikes under SCAM
 * and one under REAL. Drawn with a little wobble, so it looks hand-made.
 */
function whiteboard(): THREE.CanvasTexture {
  const W = 512;
  const H = 316;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6f6f1";
  g.fillRect(0, 0, W, H);
  g.lineCap = "round";
  g.lineJoin = "round";
  let seed = 1;
  const wob = (n: number) => (hash(seed++) - 0.5) * n;
  /** a marker line through the points, each a little off */
  const stroke = (pts: [number, number][], color: string, width = 5) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x + wob(3), y + wob(3)) : g.moveTo(x + wob(3), y + wob(3))));
    g.stroke();
  };
  const blue = "#1f3a8a";
  const red = "#c42b22";
  const hand = '"Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive';
  g.fillStyle = blue;
  g.font = `bold 46px ${hand}`;
  g.textAlign = "center";
  g.fillText("SCAM", 130, 58);
  g.fillText("REAL", 420, 58);
  stroke([[30, 74], [130, 76], [222, 72]], blue);
  stroke([[350, 74], [490, 73]], blue);
  stroke([[318, 22], [320, 160], [317, 296]], blue, 4);
  // the troll, sketched next to SCAM: wide head, pointy ears, squint, huge grin
  const tx = 262;
  const ty = 44;
  const k = 1.45;
  const at = (pts: [number, number][]) => pts.map(([x, y]) => [tx + x * k, ty + y * k] as [number, number]);
  const troll = red;
  stroke(at([[-26, -6], [-20, -24], [0, -30], [20, -24], [26, -6], [22, 18], [0, 30], [-22, 18], [-26, -6]]), troll, 4);
  stroke(at([[-26, -4], [-38, -14], [-28, 4]]), troll, 4);
  stroke(at([[26, -4], [38, -14], [28, 4]]), troll, 4);
  stroke(at([[-15, -12], [-6, -9]]), troll, 4);
  stroke(at([[6, -9], [15, -12]]), troll, 4);
  stroke(at([[-18, 4], [-8, 18], [8, 18], [18, 4], [-18, 4]]), troll, 4);
  for (const dx of [-9, 0, 9]) stroke(at([[dx, 6], [dx, 15]]), troll, 3);
  // tallies: gates of five under SCAM, a lonely one under REAL
  const gate = (x: number, y: number) => {
    for (let i = 0; i < 4; i++) stroke([[x + i * 11, y], [x + i * 11 + wob(4), y + 40]], blue, 4);
    stroke([[x - 6, y + 32], [x + 42, y + 6]], blue, 4);
  };
  for (let i = 0; i < 17; i++) gate(36 + (i % 5) * 54, 100 + Math.floor(i / 5) * 54);
  for (let i = 0; i < 3; i++) stroke([[36 + 2 * 54 + i * 11, 100 + 3 * 54], [36 + 2 * 54 + i * 11, 140 + 3 * 54]], blue, 4);
  stroke([[418, 100], [419, 140]], blue, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function sign(parent: THREE.Object3D, tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, emissive = false): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    emissive ? new THREE.MeshBasicMaterial({ map: tex }) : new THREE.MeshLambertMaterial({ map: tex }),
  );
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
/** a bounce in from 0 to 1 over `d` seconds */
const popIn = (s: number, d = 0.6) => {
  const x = clamp01(s / d);
  return x >= 1 ? 1 : 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
};
/** deterministic noise in [0, 1) */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ---------- the ScamSitter bot ----------

interface Bot {
  root: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Mesh[];
  mouth: THREE.Mesh;
  antennaTip: THREE.Mesh;
  arm: THREE.Group;
  /** the tea, in the right hand */
  cup: THREE.Group;
  armL: THREE.Group;
  belly: THREE.Mesh;
  extras: THREE.Group;
}

const SCREEN_ON = "#35d07a";

function buildBot(parent: THREE.Object3D, body: string, trim: string, screen = SCREEN_ON): Bot {
  const root = group(parent);
  // torso
  box(root, 1.15, 1.05, 0.85, body, 0, 0.95, 0);
  box(root, 1.2, 0.18, 0.9, trim, 0, 0.95, 0);
  const belly = box(root, 0.45, 0.32, 0.05, mat("#10161a", screen), 0, 1.35, 0.44);
  // legs, up on a footstool
  for (const x of [-0.3, 0.3]) {
    box(root, 0.36, 0.3, 1.2, trim, x, 0.8, 0.75);
    box(root, 0.42, 0.42, 0.3, "#3a3740", x, 0.72, 1.45);
  }
  // head
  const head = group(root, 0, 2.0, 0);
  box(head, 1.35, 1.0, 1.0, body, 0, 0, 0);
  box(head, 1.12, 0.74, 0.06, "#10161a", 0, 0.13, 0.5);
  const eyes = [-0.27, 0.27].map((x) => box(head, 0.17, 0.24, 0.04, mat(screen, screen), x, 0.5, 0.54));
  const mouth = box(head, 0.42, 0.07, 0.04, mat(screen, screen), 0, 0.27, 0.54);
  box(head, 0.06, 0.4, 0.06, "#8d8994", 0.35, 1.0, 0);
  const antennaTip = box(head, 0.16, 0.16, 0.16, mat("#d8281f", "#d8281f"), 0.35, 1.4, 0);
  // headset: band, ear cups, mic
  box(head, 1.5, 0.1, 0.16, "#2c2a33", 0, 1.03, 0);
  for (const x of [-0.72, 0.72]) {
    box(head, 0.1, 0.55, 0.16, "#2c2a33", x, 0.5, 0);
    box(head, 0.16, 0.4, 0.4, "#2c2a33", x * 1.03, 0.25, 0);
  }
  box(head, 0.06, 0.06, 0.5, "#2c2a33", -0.72, 0.22, 0.3);
  box(head, 0.12, 0.1, 0.1, "#d8281f", -0.62, 0.2, 0.55);
  // right arm (holds the tea)
  const arm = group(root, 0.68, 1.85, 0);
  box(arm, 0.26, 0.75, 0.26, body, 0, -0.75, 0);
  const cup = group(arm, 0, -0.85, 0.22);
  box(cup, 0.24, 0.24, 0.24, "#fff6ec", 0, 0, 0);
  box(cup, 0.2, 0.03, 0.2, "#7b4a2a", 0, 0.22, 0);
  box(cup, 0.06, 0.14, 0.12, "#fff6ec", 0.15, 0.05, 0);
  // left arm (notepad or rests)
  const armL = group(root, -0.68, 1.85, 0);
  box(armL, 0.26, 0.75, 0.26, body, 0, -0.75, 0);
  const extras = group(root);
  return { root, head, eyes, mouth, antennaTip, arm, cup, armL, belly, extras };
}

function animateBot(b: Bot, m: Moment, level: number, active: number, other: number, seed: number) {
  const t = m.t;
  // talking: mouth by level, head bobs; listening: slow nods
  b.mouth.scale.y = 0.07 + 0.32 * clamp01((level - 0.35) / 0.45);
  b.head.rotation.x = -0.05 + 0.07 * Math.sin(t * 7.3) * level + 0.06 * other * Math.max(0, Math.sin(t * 2.1 + seed));
  b.head.rotation.z = 0.05 * Math.sin(t * 0.9 + seed);
  b.head.position.y = 2.0 + 0.03 * Math.sin(t * 2.4 + seed);
  const blink = hash(Math.floor(t / 3.3 + seed)) < 0.8 && (t / 3.3 + seed) % 1 < 0.05;
  for (const e of b.eyes) {
    e.scale.y = blink ? 0.03 : 0.24;
    e.visible = true;
  }
  (b.antennaTip.material as THREE.MeshLambertMaterial).emissive.set(Math.floor(t * 1.5 + seed) % 2 ? "#d8281f" : "#3a0d0a");
  b.root.rotation.z = 0.015 * Math.sin(t * 1.3 + seed);
  return { idle: clamp01(1 - active * 1.6) };
}

// ---------- rooms ----------

function floorAndWall(parent: THREE.Object3D, x0: number, x1: number, floor: string, wall: string) {
  const w = x1 - x0;
  // deep enough to reach the bottom of the frame
  const f = box(parent, w, 0.2, 14, floor, (x0 + x1) / 2, -0.2, 4);
  f.castShadow = false;
  const back = box(parent, w, 7, 0.3, wall, (x0 + x1) / 2, -0.2, -3);
  back.castShadow = false;
  box(parent, w, 0.25, 0.32, "#1b1a20", (x0 + x1) / 2, 0, -2.84);
}

function agentRoom(scene: THREE.Scene) {
  floorAndWall(scene, 0, 9, "#5a3d2b", "#2f5a4a");
  // rug, armchair, side table with lamp, window, plant
  box(scene, 4.2, 0.03, 3.2, "#8a2c2a", 4.2, 0, 0.6).castShadow = false;
  const chair = group(scene, 4.4, 0, 0);
  box(chair, 2.3, 0.75, 1.7, "#24434f", 0, 0, 0);
  box(chair, 2.3, 1.9, 0.45, "#24434f", 0, 0, -0.85);
  for (const x of [-1.25, 1.25]) box(chair, 0.4, 1.2, 1.7, "#1d3640", x, 0, 0);
  const table = group(scene, 6.4, 0, 0.2);
  box(table, 0.8, 0.9, 0.8, "#6b4a33", 0, 0, 0);
  box(table, 0.12, 0.6, 0.12, "#2c2a33", 0, 0.9, 0);
  box(table, 0.6, 0.45, 0.6, mat("#ffd27a", "#b88a2a"), 0, 1.5, 0);
  const lamp = new THREE.PointLight("#ffcf80", 6, 7, 1.5);
  lamp.position.set(6.4, 1.9, 0.6);
  scene.add(lamp);
  // window with a night sky and a moon
  box(scene, 2.4, 1.7, 0.1, "#1b1a20", 2.4, 2.9, -2.82);
  box(scene, 2.1, 1.4, 0.1, mat("#16264a", "#0b1630"), 2.4, 3.05, -2.76);
  box(scene, 0.3, 0.3, 0.05, mat("#fff6ec", "#fff6ec"), 3.0, 3.85, -2.7);
  box(scene, 2.1, 0.08, 0.12, "#1b1a20", 2.4, 3.7, -2.7);
  // plant
  box(scene, 0.6, 0.6, 0.6, "#b0572e", 8.1, 0, -1.6);
  for (let i = 0; i < 5; i++) box(scene, 0.18, 0.9 + hash(i) * 0.7, 0.18, "#2f8a4f", 8.1 + (hash(i + 9) - 0.5) * 0.5, 0.6, -1.6 + (hash(i + 3) - 0.5) * 0.5);
  // the scoreboard over the armchair
  box(scene, 2.5, 1.6, 0.08, "#b9b0a3", 6.5, 2.55, -2.86);
  box(scene, 1.0, 0.06, 0.16, "#8d8994", 6.5, 2.55, -2.76);
  sign(scene, whiteboard(), 2.36, 1.46, 6.5, 3.35, -2.8);
}

// ---------- callers ----------

interface Caller {
  root: THREE.Group;
  head: THREE.Group;
  /** call time → pose */
  animate(m: Moment): void;
}

/** A person: torso, head, arms; the left hand holds a phone to the ear. */
function buildPerson(parent: THREE.Object3D, o: { top: string; legs: string; skin: string; hair: string }) {
  const root = group(parent);
  for (const x of [-0.25, 0.25]) {
    box(root, 0.36, 1.0, 0.4, o.legs, x, 0, 0);
    box(root, 0.4, 0.18, 0.55, "#1b1a20", x, 0, 0.08);
  }
  const torso = group(root, 0, 1.0, 0);
  box(torso, 1.05, 1.15, 0.6, o.top, 0, 0, 0);
  const head = group(torso, 0, 1.15, 0);
  const face = [box(head, 0.2, 0.15, 0.2, o.skin, 0, 0, 0), box(head, 0.82, 0.86, 0.78, o.skin, 0, 0.12, 0)];
  box(head, 0.86, 0.2, 0.82, o.hair, 0, 0.88, 0);
  box(head, 0.1, 0.1, 0.05, "#1b1a20", -0.18, 0.62, 0.4);
  box(head, 0.1, 0.1, 0.05, "#1b1a20", 0.18, 0.62, 0.4);
  const mouth = box(head, 0.3, 0.06, 0.05, "#5a1d1a", 0, 0.36, 0.4);
  // left arm: up to the ear, with the phone
  const phoneArm = group(torso, -0.62, 1.05, 0);
  box(phoneArm, 0.26, 0.7, 0.28, o.top, 0, -0.7, 0);
  phoneArm.rotation.z = -2.5;
  phoneArm.rotation.x = -0.3;
  const phone = group(head, -0.47, 0.42, 0.05);
  box(phone, 0.1, 0.42, 0.22, "#1b1a20", 0, -0.1, 0);
  face.push(box(phoneArm, 0.24, 0.2, 0.24, o.skin, 0, -0.85, 0));
  // right arm: gestures
  const arm = group(torso, 0.62, 1.05, 0);
  box(arm, 0.26, 0.85, 0.28, o.top, 0, -0.85, 0);
  box(arm, 0.24, 0.2, 0.24, o.skin, 0, -1.02, 0);
  return { root, torso, head, mouth, arm, phoneArm, phone, face };
}

/**
 * The police impersonator: "DCI Claude Taylor" (police), or with `essex` the "Essex Police" caller
 * of areyouai: the same desk and helmet, his own printout, a lanyard, a 100% HUMAN sticker, and
 * the moves for the song after the call.
 */
function police(scene: THREE.Scene, essex = false): Caller {
  floorAndWall(scene, -9, 0, "#2c2a33", "#3b3a44");
  // desk with a laptop and a pile of cash; a lamp; posters
  const desk = group(scene, -2.0, 0, 0.9);
  box(desk, 2.2, 1.0, 1.1, "#4a3b2c", 0, 0, 0);
  box(desk, 0.7, 0.05, 0.5, "#8d8994", -0.3, 1.0, 0);
  const screen = box(desk, 0.7, 0.48, 0.05, mat("#5ab4ff", "#2a6ab0"), -0.3, 1.05, -0.25);
  screen.rotation.x = -0.25;
  for (let i = 0; i < 3; i++) box(desk, 0.5, 0.14, 0.26, "#3f8f4a", 0.6, 1.0 + i * 0.14, 0.05 - (i % 2) * 0.05);
  const lampLight = new THREE.PointLight("#ffd27a", 5, 6, 1.5);
  lampLight.position.set(-2.8, 2.6, 1.2);
  scene.add(lampLight);
  // a printout, taped up a bit crooked, and today's tally
  sign(scene, textTexture(essex ? ["ESSEX", "POLICE"] : ["METROPOLITAN", "POLICE"], 160, 96, "#fff6ec", "#1f3a8a", 30), 2.3, 1.4, -6.9, 3.6, -2.82).rotation.z =
    essex ? -0.06 : 0.04;
  sign(scene, textTexture(["TODAY", "IIII IIII", "IIII II"], 120, 120, "#fff2a8", "#1b1a20", 26), 1.3, 1.3, -2.4, 3.3, -2.82);
  sign(scene, textTexture(["CYBER", "CRIME", "UNIT"], 96, 72, "#fff6ec", "#d8281f", 24), 1.1, 0.8, -6.9, 2.3, -2.82);

  // the scammer: hoodie, shades, a police helmet a size too big
  const chair = group(scene, -4.0, 0, -0.2);
  box(chair, 1.3, 0.7, 1.2, "#1b1a20", 0, 0, 0);
  box(chair, 1.3, 1.6, 0.25, "#1b1a20", 0, 0.7, -0.6);
  const p = buildPerson(scene, { top: "#2a2a30", legs: "#1d2a44", skin: "#c99a7a", hair: "#2a1a10" });
  p.root.position.set(-4.0, 0.1, 0.1);
  p.root.rotation.y = 0.45;
  box(p.head, 0.86, 0.16, 0.08, "#0e0d10", 0, 0.58, 0.41); // shades
  box(p.head, 0.82, 0.2, 0.06, "#6b4a33", 0, 0.12, 0.4); // stubble
  const helmet = group(p.head, 0, 0.95, 0);
  const navy = "#22409a";
  box(helmet, 1.0, 0.12, 1.0, navy, 0, 0, 0);
  box(helmet, 0.86, 0.5, 0.86, navy, 0, 0.1, 0);
  box(helmet, 0.72, 0.35, 0.72, navy, 0, 0.6, 0);
  box(helmet, 0.5, 0.2, 0.5, navy, 0, 0.95, 0);
  box(helmet, 0.16, 0.14, 0.16, "#c9c9d6", 0, 1.15, 0);
  box(helmet, 0.3, 0.34, 0.05, mat("#c9c9d6", "#4a4a5a"), 0, 0.3, 0.45);
  // hanging up: the phone on the desk, steam off the helmet
  const deskPhone = group(scene, -2.6, 1.0, 1.0);
  box(deskPhone, 0.42, 0.1, 0.22, "#1b1a20", 0, 0, 0);
  deskPhone.rotation.y = 0.6;
  const steam = Array.from({ length: 5 }, () => box(scene, 0.14, 0.14, 0.14, "#d9d2c8"));
  const angry = mat("#e0604f");
  const calm = p.face[0]!.material;
  const helmetPos = new THREE.Vector3();
  const party = essex ? essexExtras(p, helmet) : undefined;
  return {
    root: p.root,
    head: p.head,
    animate(m) {
      const lv = m.level.caller;
      const t = m.t;
      const h = m.hangup;
      p.mouth.scale.y = 0.06 + 0.22 * clamp01((lv - 0.35) / 0.45);
      p.torso.rotation.z = 0.04 * Math.sin(t * 1.7);
      p.head.rotation.x = 0.08 * Math.sin(t * 6.1) * lv - 0.04;
      p.head.rotation.y = 0.15 * Math.sin(t * 0.6);
      helmet.rotation.z = 0.14 * Math.sin(t * 8.3) * lv + 0.05 * Math.sin(t * 1.1);
      helmet.rotation.x = 0.06 * Math.sin(t * 5.2) * lv;
      helmet.position.y = 0.95;
      p.arm.rotation.x = -0.4 - 0.9 * m.active.caller * (0.5 + 0.5 * Math.sin(t * 3.1));
      p.arm.rotation.z = 0.2 + 0.3 * m.active.caller * Math.sin(t * 2.3);
      p.phoneArm.rotation.z = -2.5;
      p.phone.visible = true;
      deskPhone.visible = false;
      for (const f of p.face) f.material = calm;
      for (const s of steam) s.visible = false;
      party?.(m);
      if (h === null) return;
      // slams the phone down, goes red, shakes his head, steams; the helmet jumps
      const slam = ease(h / 0.35);
      p.phoneArm.rotation.z = -2.5 + 2.2 * slam;
      p.phone.visible = h < 0.3;
      deskPhone.visible = h >= 0.3;
      if (h > 0.4) for (const f of p.face) f.material = angry;
      p.head.rotation.y = h > 0.5 && h < 2 ? 0.35 * Math.sin((h - 0.5) * 18) : 0;
      p.mouth.scale.y = h > 0.4 ? 0.2 : 0.06;
      helmet.position.y = 0.95 + 0.6 * Math.max(0, Math.sin(Math.min(1, Math.max(0, (h - 0.4) / 0.5)) * Math.PI));
      p.arm.rotation.x = h < 0.6 ? -1.6 : -0.3;
      helmet.getWorldPosition(helmetPos);
      steam.forEach((s, i) => {
        const g = (h - 0.6 - i * 0.25) % 1.25;
        s.visible = h > 0.6 + i * 0.25 && g >= 0;
        if (!s.visible) return;
        s.position.set(helmetPos.x + 0.25 * Math.sin(i * 2 + g * 3), helmetPos.y + 0.9 + g * 1.1, helmetPos.z);
        s.scale.setScalar(0.6 + 0.8 * g);
      });
    },
  };
}

/** a hop on every beat: 0 landing on it, 1 between */
const hop = (s: SongMoment) => Math.sin(s.phase * Math.PI);
/** side to side, once every two beats: -1–1 */
const sway = (s: SongMoment) => Math.sin(s.beat * Math.PI);
/** the identity swap on lines everyone sings: on, every other beat (it flickers), or off */
const swapped = (s: SongMoment | null) => !!s && s.swap !== null && (s.swap < 0.6 || Math.floor(s.beat) % 2 === 0);
/** the disco's colours, a step on each beat */
const DISCO = ["#ff3bd4", "#35d0ff", "#ffe23b", "#35d07a", "#ff5a4e", "#9b5cff"];
const discoAt = (beat: number, k = 0) => DISCO[(((Math.floor(beat) + k) % DISCO.length) + DISCO.length) % DISCO.length]!;

/**
 * The Essex caller's lanyard and sticker, and his song: bouncing with the phone still at his
 * ear, the free arm waving, the helmet hopping a beat behind. On the lines everyone sings he
 * turns into a bot (antenna through the helmet, LED eyes on the shades, an LED mouth).
 */
function essexExtras(p: ReturnType<typeof buildPerson>, helmet: THREE.Group) {
  // the lanyard: a V of red strap to a card, and the sticker that settles it
  for (const [x, rz] of [[-0.21, 0.22], [0.05, -0.22]] as const) box(p.torso, 0.06, 0.62, 0.02, "#d8281f", x, 0.52, 0.31).rotation.z = rz;
  box(p.torso, 0.28, 0.34, 0.03, "#fff6ec", -0.08, 0.22, 0.32);
  box(p.torso, 0.29, 0.08, 0.035, "#1f3a8a", -0.08, 0.48, 0.32);
  sign(p.torso, textTexture(["100%", "HUMAN"], 96, 64, "#ffe23b", "#d8281f", 30), 0.44, 0.3, 0.27, 0.8, 0.31).rotation.z = -0.12;
  // the bot underneath
  const antenna = group(helmet, 0, 1.2, 0);
  box(antenna, 0.06, 0.55, 0.06, "#8d8994", 0, 0, 0);
  const tipMat = new THREE.MeshLambertMaterial({ color: "#d8281f", emissive: "#d8281f", flatShading: true });
  box(antenna, 0.18, 0.18, 0.18, tipMat, 0, 0.55, 0);
  const led = mat("#35d07a", "#35d07a");
  const eyes = [-0.18, 0.18].map((x) => box(p.head, 0.16, 0.09, 0.03, led, x, 0.56, 0.455));
  const ledMouth = box(p.head, 0.34, 0.07, 0.03, led, 0, 0.34, 0.44);
  return (m: Moment) => {
    const s = m.song;
    const bot = swapped(s);
    antenna.visible = bot;
    for (const e of eyes) e.visible = bot;
    ledMouth.visible = bot;
    p.mouth.visible = !bot;
    p.root.position.y = 0.1;
    p.torso.rotation.y = 0;
    if (!s) return;
    if (bot) {
      antenna.scale.setScalar(popIn(s.swap!, 0.3));
      tipMat.emissive.set(discoAt(s.beat * 2));
      ledMouth.scale.y = 0.07 + 0.25 * clamp01((m.level.caller - 0.35) / 0.45);
    }
    const e = Math.min(1.2, s.energy);
    const side = sway(s);
    p.root.position.y = 0.1 + 0.2 * e * hop(s);
    p.torso.rotation.z = 0.1 * e * side;
    p.torso.rotation.y = 0.18 * e * Math.sin((s.beat * Math.PI) / 2);
    p.head.rotation.x = -0.04 + 0.2 * e * Math.pow(1 - s.phase, 3);
    p.head.rotation.y = 0.15 * Math.sin((s.beat * Math.PI) / 4);
    // the helmet, a size too big, lands a moment after his head does
    helmet.position.y = 0.95 + 0.28 * e * Math.max(0, Math.sin((s.phase - 0.15) * Math.PI));
    helmet.rotation.z = 0.18 * e * side;
    helmet.rotation.x = 0;
    // the free arm: up and waving, higher the wilder it gets
    p.arm.rotation.x = -0.2;
    p.arm.rotation.z = 0.3 + 2.1 * clamp01(e) + 0.45 * side * e;
  };
}

/** A scam bot on a budget: a cardboard box with one LED, a coat-hanger antenna and tape. */
function cryptobot(scene: THREE.Scene): Caller {
  floorAndWall(scene, -9, 0, "#1d1630", "#2a2140");
  // a single rack, half its lights dead
  const rack = group(scene, -6.9, 0, -2.2);
  const leds: THREE.Mesh[] = [];
  box(rack, 1.1, 3.4, 0.9, "#0e0d10", 0, 0, 0);
  for (let i = 0; i < 9; i++) leds.push(box(rack, 0.12, 0.08, 0.05, mat("#35d07a", "#35d07a"), -0.3 + (i % 3) * 0.3, 0.5 + Math.floor(i / 3) * 0.9, 0.46));
  // marker on cardboard
  const sup = sign(scene, textTexture(["OFFICAL", "SUPPORT"], 140, 80, "#b98a55", "#1b1a20", 32, "bold sans-serif"), 2.0, 1.15, -6.6, 4.3, -2.82);
  sup.rotation.z = -0.14;
  // an upturned crate for a desk
  const crate = group(scene, -2.1, 0, 0.9);
  box(crate, 1.5, 0.9, 1.0, "#8a6a3a", 0, 0, 0);
  for (const y of [0.25, 0.6]) box(crate, 1.52, 0.08, 1.02, "#6b4f28", 0, y, 0);

  const card = "#b98a55";
  const tape = "#e6cf9a";
  const root = group(scene, -4.3, 0, 0.1);
  root.rotation.y = 0.45;
  for (const x of [-0.28, 0.28]) box(root, 0.3, 0.9, 0.3, card, x, 0, 0);
  const body = group(root, 0, 0.9, 0);
  box(body, 1.3, 1.2, 0.95, card, 0, 0, 0);
  box(body, 1.32, 0.14, 0.3, tape, 0, 1.06, 0);
  box(body, 0.3, 1.22, 0.97, tape, 0.35, 0, 0);
  sign(body, textTexture(["BOT ₿"], 96, 48, card, "#1b1a20", 34, "bold sans-serif"), 0.8, 0.4, -0.15, 0.62, 0.49);
  const arms = [-0.8, 0.8].map((x) => {
    const g = group(body, x, 1.0, 0);
    box(g, 0.22, 0.85, 0.22, "#d8c4a0", 0, -0.85, 0);
    return g;
  });
  const head = group(body, 0, 1.2, 0);
  box(head, 1.05, 0.85, 0.85, card, 0, 0, 0);
  box(head, 1.07, 0.12, 0.3, tape, 0, 0.6, 0.2);
  const ledOn = mat("#ff3b30", "#ff3b30");
  const ledOff = mat("#3a0d0a");
  const eye = box(head, 0.22, 0.22, 0.05, ledOn, 0.18, 0.45, 0.44);
  const mouth = box(head, 0.36, 0.1, 0.05, mat("#1b1a20"), -0.05, 0.18, 0.44);
  // coat-hanger antenna
  const hanger = group(head, 0, 0.85, 0);
  const wire = "#a7a7b3";
  box(hanger, 0.05, 0.35, 0.05, wire, 0, 0, 0);
  const tri = group(hanger, 0, 0.35, 0);
  for (const [x, rz] of [[-0.3, 0.55], [0.3, -0.55]] as const) box(tri, 0.05, 0.7, 0.05, wire, x, -0.05, 0).rotation.z = rz;
  box(tri, 1.2, 0.05, 0.05, wire, 0, -0.08, 0);
  // the script it reads from when it repeats itself
  const script = group(arms[0]!, 0, -0.95, 0.25);
  box(script, 0.55, 0.7, 0.03, "#fff6ec", 0, 0, 0);
  for (let i = 0; i < 4; i++) box(script, 0.4, 0.04, 0.035, "#1b1a20", 0, 0.5 - i * 0.12, 0);
  // a loading spinner over its head
  const spinner = group(head, 0, 1.5, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    box(spinner, 0.1, 0.1, 0.1, mat("#fff6ec", i < 3 ? "#fff6ec" : "#3a3740"), Math.cos(a) * 0.35, Math.sin(a) * 0.35, 0);
  }
  // sparks and smoke when it gives up mid-sentence
  const sparkMat = mat("#ffb000", "#ff7a1a");
  const sparks = Array.from({ length: 8 }, () => box(scene, 0.1, 0.1, 0.1, sparkMat));
  const smoke = Array.from({ length: 5 }, () => box(scene, 0.3, 0.3, 0.3, "#8d8994"));
  const headPos = new THREE.Vector3();
  return {
    root,
    head,
    animate(m) {
      const t = m.t;
      const lv = m.level.caller;
      const bl = m.blunder;
      const k = (kind: BlunderKind, d: number) => (bl && bl.kind === kind && bl.since < d ? Math.sin((bl.since / d) * Math.PI) : 0);
      // no lips: the mouth flicks on and off while it talks
      mouth.visible = lv > 0.4 && Math.floor(t * 9) % 2 === 0;
      for (let i = 0; i < leds.length; i++) leds[i]!.visible = i % 2 === 0 && hash(i * 7 + Math.floor(t * 4)) > 0.3;
      hanger.rotation.z = 0.3 * Math.sin(t * 6.5) * (0.4 + lv);

      // talking over: leans right in
      const lean = k("talkover", 1.6);
      body.rotation.z = 0.03 * Math.sin(t * 1.9) - 0.25 * lean;
      // off-script question: a shrug
      const shrug = k("ignored", 1.8);
      // repeating itself: reads the script, held up to its face
      const l = m.looping;
      const read = l === null ? 0 : Math.min(1, l / 0.6);
      script.visible = read > 0;
      arms[0]!.rotation.x = -0.2 - 0.5 * m.active.caller * Math.abs(Math.sin(t * 3)) * (1 - read) - 1.9 * read;
      arms[0]!.rotation.z = -0.9 * shrug;
      arms[1]!.rotation.x = -0.2;
      arms[1]!.rotation.z = 0.9 * shrug;
      head.rotation.z = 0.25 * shrug;

      // buffering: loading bar eye, droop, spinner
      spinner.visible = m.buffering;
      spinner.rotation.z = -Math.floor(t * 8) * (Math.PI / 4);
      eye.material = hash(Math.floor(t * 2.3)) < 0.15 ? ledOff : ledOn;
      eye.scale.x = m.buffering ? 0.05 + 0.4 * ((t * 1.2) % 1) : 0.22;
      head.rotation.x = m.buffering ? 0.3 : 0.25 * read + 0.06 * Math.sin(t * 7) * lv;
      head.rotation.y = l === null ? 0 : 2 * Math.PI * ease(l / 0.9);

      // giving up mid-sentence: sparks, smoke, eye out, head slumps
      const fizz = bl && bl.kind === "cutoff" ? bl.since : null;
      if (fizz !== null && fizz < 2) {
        eye.material = ledOff;
        head.rotation.x += 0.35 * Math.sin(Math.min(1, fizz / 0.4) * Math.PI * 0.5);
      }
      head.getWorldPosition(headPos);
      sparks.forEach((sp, i) => {
        sp.visible = fizz !== null && fizz < 0.8;
        if (!sp.visible) return;
        const g = fizz!;
        const ang = (i / sparks.length) * Math.PI * 2 + hash(i);
        sp.position.set(headPos.x + Math.cos(ang) * g * 2, headPos.y + 0.8 + g * 2.2 - 4 * g * g, headPos.z + Math.sin(ang) * g * 1.2);
      });
      smoke.forEach((sm, i) => {
        const g = fizz === null ? 9 : fizz - i * 0.15;
        sm.visible = g > 0 && g < 2;
        if (!sm.visible) return;
        sm.position.set(headPos.x + 0.3 * Math.sin(i * 2.1 + g * 2), headPos.y + 0.9 + g * 1.2, headPos.z);
        sm.scale.setScalar(0.3 + g * 0.35);
      });
    },
  };
}

/** The call list on the sales rep's wall: numbers from the drama range, three already crossed off. */
function callList(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 192;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff2a8";
  g.fillRect(0, 0, 192, 256);
  g.fillStyle = "#1b1a20";
  g.font = '34px "Jersey 10", monospace';
  g.textAlign = "center";
  g.fillText("CALL LIST", 96, 34);
  g.font = '26px "Jersey 10", monospace';
  g.textAlign = "left";
  for (let i = 0; i < 6; i++) {
    const y = 76 + i * 32;
    g.fillStyle = "#1b1a20";
    g.fillText(`07700 900${String(113 + i * 97).slice(-3)}`, 18, y);
    g.fillStyle = "#c42b22";
    if (i < 3) g.fillRect(12, y - 9, 168, 4);
  }
  // today's: the 4th, ringed
  g.strokeStyle = "#2a6ab0";
  g.lineWidth = 3;
  g.strokeRect(10, 76 + 3 * 32 - 24, 172, 32);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The cold caller: a startup sales rep at a standing desk, headset, vest and quiff, all grin and
 * gestures. The bot hangs up on him: he crosses the number off his list and deflates.
 */
function coldcall(scene: THREE.Scene): Caller {
  floorAndWall(scene, -9, 0, "#5b6170", "#d8d2c4");
  // the motivational poster, the call list, the gong that never rings
  sign(scene, textTexture(["ALWAYS", "BE", "CALLING"], 120, 150, "#1b1a20", "#ffcc00", 40), 1.5, 1.9, -6.0, 3.9, -2.82);
  const list = group(scene, -2.4, 3.4, -2.82);
  sign(list, callList(), 1.5, 2.0, 0, 0, 0);
  // the strike through today's number, drawn when the bot hangs up
  const strike = box(list, 1.32, 0.06, 0.02, "#c42b22", 0, -0.3, 0.02);
  strike.castShadow = false;
  const gong = group(scene, -7.6, 0, -1.6);
  for (const x of [-0.8, 0.8]) box(gong, 0.12, 2.6, 0.12, "#4a3b2c", x, 0, 0);
  box(gong, 1.8, 0.12, 0.14, "#4a3b2c", 0, 2.55, 0);
  const brass = mat("#d6a73a", "#3a2a08");
  box(gong, 1.1, 0.7, 0.06, brass, 0, 1.45, 0);
  box(gong, 0.7, 1.1, 0.06, brass, 0, 1.25, 0);
  box(gong, 0.3, 0.3, 0.08, "#b8892a", 0, 1.65, 0);
  sign(scene, textTexture(["MEETINGS", "BOOKED: 0"], 128, 64, "#fff6ec", "#1b1a20", 26), 1.1, 0.55, -7.6, 0.55, -1.5);
  // the standing desk: laptop, a mug
  const desk = group(scene, -2.0, 0, 0.9);
  box(desk, 0.1, 1.45, 0.1, "#2c2a33", -0.8, 0, 0);
  box(desk, 0.1, 1.45, 0.1, "#2c2a33", 0.8, 0, 0);
  box(desk, 2.0, 0.08, 1.0, "#e8e1d6", 0, 1.45, 0);
  box(desk, 0.7, 0.04, 0.5, "#8d8994", -0.3, 1.53, 0);
  const screen = box(desk, 0.7, 0.48, 0.04, mat("#9fe0c8", "#2a6a58"), -0.3, 1.55, -0.25);
  screen.rotation.x = -0.25;
  box(desk, 0.22, 0.26, 0.22, "#ff5a4e", 0.55, 1.53, 0.1);
  box(desk, 0.06, 0.14, 0.1, "#ff5a4e", 0.69, 1.58, 0.1);

  const p = buildPerson(scene, { top: "#9cc4f0", legs: "#c9b58a", skin: "#d9a47e", hair: "#3a2414" });
  p.root.position.set(-3.9, 0.1, 0.3);
  p.root.rotation.y = 0.45;
  // the vest, open over the shirt
  for (const x of [-0.33, 0.33]) box(p.torso, 0.42, 1.1, 0.66, "#1f2a44", x, 0.02, 0);
  // the quiff
  const quiff = group(p.head, 0, 0.98, 0.25);
  box(quiff, 0.7, 0.24, 0.32, "#3a2414", 0, 0, 0);
  box(quiff, 0.5, 0.14, 0.26, "#4a3020", 0, 0.2, 0.04);
  // a headset instead of a phone: band, the ear cup the cable runs to, the mic boom
  p.phone.visible = false;
  box(p.head, 0.9, 0.08, 0.14, "#2c2a33", 0, 0.94, -0.05);
  for (const x of [-0.45, 0.45]) box(p.head, 0.08, 0.5, 0.12, "#2c2a33", x, 0.45, -0.05);
  box(p.head, 0.14, 0.3, 0.3, "#2c2a33", -0.47, 0.35, 0);
  const boom = box(p.head, 0.05, 0.05, 0.42, "#2c2a33", -0.4, 0.3, 0.22);
  boom.rotation.y = 0.5;
  box(p.head, 0.1, 0.08, 0.08, "#d8281f", -0.24, 0.3, 0.42);
  // the grin: teeth over the mouth
  const grin = box(p.head, 0.4, 0.1, 0.055, "#fff6ec", 0, 0.36, 0.4);
  const pen = group(p.arm, 0, -1.1, 0.12);
  box(pen, 0.06, 0.06, 0.34, "#c42b22", 0, 0, 0);
  return {
    root: p.root,
    head: p.head,
    animate(m) {
      const t = m.t;
      const lv = m.level.caller;
      const h = m.hangup;
      const talk = clamp01((lv - 0.35) / 0.45);
      p.mouth.scale.y = 0.06 + 0.22 * talk;
      grin.visible = true;
      grin.scale.y = 0.1 - 0.05 * talk;
      // on his toes, nodding along, the free hand pitching
      p.root.position.y = 0.1 + 0.04 * Math.abs(Math.sin(t * 3.2)) * m.active.caller;
      p.torso.rotation.x = 0;
      p.torso.rotation.z = 0.04 * Math.sin(t * 1.8);
      p.head.rotation.x = 0.09 * Math.sin(t * 6.4) * lv - 0.03;
      p.head.rotation.y = 0.14 * Math.sin(t * 0.8);
      p.arm.rotation.x = -0.5 - 1.0 * m.active.caller * (0.5 + 0.5 * Math.sin(t * 3.4));
      p.arm.rotation.z = 0.15 + 0.35 * m.active.caller * Math.max(0, Math.sin(t * 2.1));
      // the other hand on the desk
      p.phoneArm.rotation.z = -0.25;
      p.phoneArm.rotation.x = -0.8;
      quiff.rotation.x = 0;
      strike.scale.x = 1e-3;
      strike.visible = false;
      pen.visible = false;
      if (h === null) return;
      // crosses the number off, then slumps: the grin gone, the quiff wilting
      const reach = h < 1.4 ? Math.sin(Math.min(1, h / 1.4) * Math.PI) : 0;
      pen.visible = h < 1.4;
      p.arm.rotation.x = -0.4 - 1.9 * reach;
      p.arm.rotation.z = 0.5 * reach;
      const draw = ease((h - 0.3) / 0.6);
      strike.visible = draw > 0;
      strike.scale.x = 1.32 * Math.max(1e-3, draw);
      strike.position.x = -0.66 + 0.66 * draw;
      const slump = ease((h - 1.2) / 0.8);
      p.torso.rotation.x = 0.22 * slump;
      p.head.rotation.x = 0.3 * slump;
      p.head.rotation.y = h > 1.2 ? 0 : 0.14 * Math.sin(t * 0.8);
      p.root.position.y = 0.1;
      quiff.rotation.x = 0.7 * slump;
      grin.visible = slump < 0.5;
      p.mouth.scale.y = 0.06;
    },
  };
}

function electrician(scene: THREE.Scene): Caller {
  floorAndWall(scene, -9, 0, "#3a3a3a", "#6b8fb0");
  // street: a van, a ladder, a giant light bulb
  const van = group(scene, -6.8, 0, -1.6);
  box(van, 3.2, 2.2, 1.9, "#f2efe8", 0, 0.35, 0);
  box(van, 1.1, 1.4, 1.9, "#f2efe8", 2.1, 0.35, 0);
  box(van, 0.9, 0.6, 0.05, mat("#9fd0ff", "#2a4a6a"), 2.15, 1.05, 0.96);
  for (const x of [-1, 1.9]) for (const z of [-0.95, 0.95]) box(van, 0.7, 0.7, 0.2, "#1b1a20", x, 0, z);
  sign(van, textTexture(["SPARKY", "ELECTRICS ⚡"], 160, 64, "#f2efe8", "#2a6ab0", 28), 2.6, 1.0, 0, 1.6, 0.97);
  box(scene, 0.12, 3.4, 0.12, "#c9c9d6", -2.4, 0, -2.5);
  box(scene, 0.12, 3.4, 0.12, "#c9c9d6", -1.8, 0, -2.5);
  for (let i = 0; i < 6; i++) box(scene, 0.6, 0.08, 0.1, "#c9c9d6", -2.1, 0.4 + i * 0.5, -2.5);
  const bulbGroup = group(scene, -3.6, 4.2, -0.6);
  const bulbOff = mat("#8d8994");
  const bulbOn = mat("#ffe27a", "#ffcc33");
  const glass = box(bulbGroup, 0.8, 0.8, 0.8, bulbOff, 0, 0, 0);
  box(bulbGroup, 0.4, 0.3, 0.4, "#c9c9d6", 0, -0.3, 0);
  const bulbLight = new THREE.PointLight("#ffd27a", 0, 8, 1.2);
  bulbLight.position.set(-3.6, 4.0, 0.4);
  scene.add(bulbLight);
  // toolbox
  box(scene, 0.9, 0.5, 0.5, "#d8281f", -1.6, 0, 1.0);
  box(scene, 0.5, 0.12, 0.08, "#1b1a20", -1.6, 0.5, 1.0);

  const p = buildPerson(scene, { top: "#ff7a1a", legs: "#2c3a5a", skin: "#e0b08a", hair: "#7a4a2a" });
  p.root.position.set(-3.9, 0.1, 0.3);
  p.root.rotation.y = 0.45;
  // hi-vis stripes and a hard hat
  box(p.torso, 1.07, 0.1, 0.62, "#e8e8f0", 0, 0.3, 0);
  box(p.torso, 1.07, 0.1, 0.62, "#e8e8f0", 0, 0.65, 0);
  const hat = group(p.head, 0, 0.9, 0);
  box(hat, 1.1, 0.1, 1.1, "#ffcc00", 0, 0, 0.05);
  box(hat, 0.9, 0.38, 0.88, "#ffcc00", 0, 0.05, 0);
  box(hat, 0.12, 0.1, 0.9, "#e0b000", 0, 0.42, 0);
  return {
    root: p.root,
    head: p.head,
    animate(m) {
      const t = m.t;
      const lv = m.level.caller;
      p.mouth.scale.y = 0.06 + 0.22 * clamp01((lv - 0.35) / 0.45);
      p.head.rotation.x = 0.06 * Math.sin(t * 5.7) * lv - 0.03;
      p.head.rotation.y = 0.12 * Math.sin(t * 0.7);
      p.torso.rotation.z = 0.03 * Math.sin(t * 1.4);
      p.arm.rotation.x = -0.3 - 0.7 * m.active.caller * (0.5 + 0.5 * Math.sin(t * 2.6));
      const on = clamp01((m.genuine - 0.4) / 0.2);
      glass.material = on > 0.5 ? bulbOn : bulbOff;
      bulbLight.intensity = 10 * on;
      bulbGroup.position.y = 4.2 + 0.08 * Math.sin(t * 2);
      bulbGroup.rotation.y = 0.3 * Math.sin(t * 0.8);
    },
  };
}

// ---------- the song's disco (areyouai) ----------

/**
 * A voxel mirror ball that drops in over the divider and spins, its specks of light sliding over
 * the back walls, coloured lights stepping on the beat, and confetti in the finale. Instanced
 * meshes and four unshadowed lights, so a phone keeps up.
 */
function disco(scene: THREE.Scene) {
  const o = new THREE.Object3D();
  const instanced = (n: number, w: number, h: number, d: number) => {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial(), n);
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  // the ball: a shell of mirror tiles on a rod
  const ball = group(scene);
  const cells: THREE.Vector3[] = [];
  for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) for (let z = -3; z <= 3; z++) {
    const r = Math.hypot(x, y, z);
    if (r > 2.2 && r < 3.3) cells.push(new THREE.Vector3(x, y, z).multiplyScalar(0.2));
  }
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.185, 0.185, 0.185), new THREE.MeshBasicMaterial(), cells.length);
  ball.add(tiles);
  cells.forEach((c, i) => {
    o.position.copy(c);
    o.updateMatrix();
    tiles.setMatrixAt(i, o.matrix);
  });
  box(ball, 0.06, 5, 0.06, "#8d8994", 0, 0.55, 0).castShadow = false;
  const specks = instanced(44, 0.16, 0.16, 0.02);
  const confetti = instanced(90, 0.2, 0.12, 0.02);
  // colours set now, so the materials are built with them
  const c = new THREE.Color();
  for (let i = 0; i < confetti.count; i++) confetti.setColorAt(i, c.set(DISCO[i % DISCO.length]!));
  for (const im of [tiles, specks]) for (let i = 0; i < im.count; i++) im.setColorAt(i, c.set("#ffffff"));
  const lights = [-6, -2.4, 2.4, 6].map((x, i) => {
    const l = new THREE.PointLight("#ffffff", 0, 14, 1);
    l.position.set(x, i === 0 || i === 3 ? 4.6 : 5.2, 2.8);
    scene.add(l);
    return l;
  });
  const hide = (im: THREE.InstancedMesh) => {
    o.scale.setScalar(0);
    o.updateMatrix();
    for (let i = 0; i < im.count; i++) im.setMatrixAt(i, o.matrix);
    im.instanceMatrix.needsUpdate = true;
  };

  return (m: Moment) => {
    const s = m.song;
    ball.visible = specks.visible = confetti.visible = !!s;
    for (const l of lights) l.intensity = 0;
    if (!s) return;
    const e = Math.min(1.3, s.energy);
    const fast = s.section === "finale" ? 2 : 1;
    // drops in while the song's first line plays, then spins
    ball.position.set(0, 5.55 + 4.5 * (1 - ease(s.since / 2.4)), 1.4);
    ball.rotation.y = s.since * 0.9;
    ball.rotation.z = 0.15;
    for (let i = 0; i < cells.length; i++) {
      const glint = hash(i * 7.3 + Math.floor(s.since * 10)) > 0.86;
      const tint = hash(i * 3.1 + Math.floor(s.beat)) > 0.72;
      if (glint) c.set("#ffffff");
      else if (tint) c.set(discoAt(s.beat, i));
      else c.setScalar(0.35 + 0.4 * hash(i));
      tiles.setColorAt(i, c);
    }
    tiles.instanceColor!.needsUpdate = true;
    // the specks it throws: sliding along the back walls as it turns
    for (let i = 0; i < specks.count; i++) {
      const x = (((hash(i) * 18 + s.since * 0.9 * (i % 2 ? 1 : 0.8)) % 18) + 18) % 18 - 9;
      o.position.set(x, 0.4 + hash(i + 50) * 6, -2.62);
      o.rotation.set(0, 0, 0);
      // more of them the wilder it gets
      o.scale.setScalar(Math.abs(x) < 0.3 || i / specks.count > 0.25 + 0.6 * e ? 0 : 0.7 + 0.6 * e);
      o.updateMatrix();
      specks.setMatrixAt(i, o.matrix);
      specks.setColorAt(i, i % 3 ? c.set("#ffffff") : c.set(discoAt(s.beat * fast, i)));
    }
    specks.instanceMatrix.needsUpdate = true;
    specks.instanceColor!.needsUpdate = true;
    // coloured lights, a step round the palette on every beat (two in the finale), punched on it, up with the loudness
    lights.forEach((l, i) => {
      l.color.set(discoAt(s.beat * fast, i * 2));
      l.intensity = 30 * e * (0.45 + 0.55 * Math.pow(1 - s.phase, 2)) * (0.7 + 0.5 * s.music);
    });
    // confetti in the finale: each piece falls on its own loop and stops at the last line
    if (s.since < 108 || s.since > 131) hide(confetti);
    else {
      for (let i = 0; i < confetti.count; i++) {
        const speed = 0.28 + 0.2 * hash(i + 3);
        const u = (s.since - 108) * speed - hash(i + 7);
        const cycle = Math.floor(u);
        const off = u < 0 || 108 + (cycle + hash(i + 7)) / speed > 125.9;
        const f = u - cycle;
        o.position.set(-8.5 + 17 * hash(i + 13) + 0.3 * Math.sin(u * 6 + i), 7.4 - 8.2 * f, -2 + 7 * hash(i + 21));
        o.rotation.set(u * 7 + i, u * 5, u * 3);
        o.scale.setScalar(off ? 0 : 1);
        o.updateMatrix();
        confetti.setMatrixAt(i, o.matrix);
      }
      confetti.instanceMatrix.needsUpdate = true;
    }
  };
}

/** The bot's song kit: a microphone for the tea, and hair and a human mouth for the swap. */
function botSongKit(bot: Bot) {
  const mic = group(bot.arm, 0, -0.85, 0.22);
  mic.rotation.x = 2.1;
  box(mic, 0.1, 0.36, 0.1, "#1b1a20", 0, -0.1, 0);
  box(mic, 0.22, 0.22, 0.22, "#8d8994", 0, 0.24, 0);
  box(mic, 0.24, 0.05, 0.24, "#2c2a33", 0, 0.33, 0);
  const hair = group(bot.head, 0, 0.95, 0);
  // blond, like the 🧑 that pops up
  const blond = "#d9a441";
  box(hair, 1.45, 0.3, 1.1, blond, 0, 0, 0);
  box(hair, 0.7, 0.28, 0.6, blond, -0.15, 0.25, 0.2).rotation.z = 0.2;
  box(hair, 1.25, 0.16, 0.12, blond, 0, -0.06, 0.52);
  // under the shades, which cover the LED mouth's place
  const lips = group(bot.head, 0, 0.12, 0.56);
  const lip = box(lips, 0.46, 0.06, 0.04, "#c84a55", 0, 0.08, 0);
  const lowerLip = box(lips, 0.46, 0.06, 0.04, "#c84a55", 0, -0.06, 0);
  const inside = box(lips, 0.4, 0.1, 0.03, "#3a0d10", 0, -0.02, -0.01);
  const teeth = box(lips, 0.34, 0.04, 0.035, "#fff6ec", 0, 0.04, 0);
  return (m: Moment) => {
    const s = m.song;
    mic.visible = !!s;
    bot.cup.visible = !s;
    const human = swapped(s);
    hair.visible = lips.visible = human;
    if (!s) return;
    bot.mouth.visible = !human;
    if (human) {
      hair.scale.setScalar(popIn(s.swap!, 0.3));
      const open = clamp01((m.level.agent - 0.35) / 0.45);
      lip.position.y = 0.08 + 0.06 * open;
      lowerLip.position.y = -0.03 - 0.06 * open;
      inside.scale.y = 0.04 + 0.14 * open;
      inside.position.y = 0.02 - 0.03 * open;
      teeth.position.y = 0.06 + 0.06 * open;
    }
  };
}

// ---------- the scene ----------

/** One call's scene, drawn with `renderer` (shared by every call on the page). */
export function createScene(renderer: THREE.WebGLRenderer, kind: SceneKind): CallScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0e0d10");
  const sky = new THREE.HemisphereLight("#fff3e0", "#2a2333", 1.6);
  scene.add(sky);
  const sun = new THREE.DirectionalLight("#ffffff", 1.8);
  sun.position.set(-3, 9, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 8, bottom: -3 });
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);

  agentRoom(scene);
  // the divider between the two ends of the call
  const divider = box(scene, 0.25, 7.2, 14.4, "#0e0d10", 0, -0.2, 3.8);
  divider.castShadow = false;
  const caller =
    kind === "police" || kind === "areyouai" ? police(scene, kind === "areyouai") : kind === "cryptobot"
        ? cryptobot(scene)
        : kind === "coldcall"
          ? coldcall(scene)
          : electrician(scene);

  const bot = buildBot(scene, "#e8e1d6", "#b9b0a3");
  bot.root.position.set(4.4, 0.05, 0.25);
  bot.root.rotation.y = -0.4;
  // scam: deal-with-it shades drop in; genuine: a notepad
  // wider than the face, so they show against the head as well as the dark screen
  const shades = group(bot.head, 0, 0.5, 0.6);
  box(shades, 1.62, 0.1, 0.08, "#0e0d10", 0, 0.06, 0);
  for (const x of [-0.36, 0.36]) {
    box(shades, 0.56, 0.3, 0.08, "#0e0d10", x, -0.2, 0);
    box(shades, 0.14, 0.07, 0.09, "#fff6ec", x - 0.12, -0.02, 0);
    box(shades, 0.07, 0.07, 0.09, "#fff6ec", x - 0.02, -0.09, 0);
  }
  const pad = group(bot.armL, 0, -0.85, 0.3);
  box(pad, 0.5, 0.06, 0.62, "#fff2a8", 0, 0, 0);
  for (let i = 0; i < 4; i++) box(pad, 0.36, 0.065, 0.03, "#2a6ab0", 0, 0.001, -0.2 + i * 0.13);
  pad.visible = false;
  const party = kind === "areyouai" ? disco(scene) : undefined;
  const songKit = kind === "areyouai" ? botSongKit(bot) : undefined;

  // the phone cable: from the caller's ear over the divider to the bot's headset, with pulses
  const cable = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-4.4, 2.9, 0.4),
    new THREE.Vector3(-2.5, 4.6, 0.2),
    new THREE.Vector3(0, 5.6, 0.3),
    new THREE.Vector3(2.5, 4.6, 0.2),
    new THREE.Vector3(3.9, 2.9, 0.4),
  ]);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(cable, 40, 0.05, 4), mat("#1b1a20"));
  scene.add(tube);
  const PULSES = 7;
  const pulseGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  const callerPulse = new THREE.MeshBasicMaterial({
    color: kind === "electrician" ? "#ffb000" : kind === "cryptobot" ? "#c58bff" : kind === "areyouai" ? "#6ea8ff" : kind === "coldcall" ? "#4fd1c5" : "#ff5a4e",
  });
  const agentPulse = new THREE.MeshBasicMaterial({ color: "#35d07a" });
  // the song's: every pulse its own colour
  const rainbow = kind === "areyouai" ? Array.from({ length: PULSES * 2 }, () => new THREE.MeshBasicMaterial()) : [];
  const pulses = Array.from({ length: PULSES * 2 }, (_, i) => {
    const m = new THREE.Mesh(pulseGeo, i < PULSES ? callerPulse : agentPulse);
    scene.add(m);
    return m;
  });

  const v = new THREE.Vector3();
  const project = (o: THREE.Object3D, dy: number): [number, number] => {
    o.getWorldPosition(v);
    v.y += dy;
    v.project(camera);
    return [(v.x + 1) / 2, (1 - v.y) / 2];
  };

  return {
    render(m) {
      const t = m.t;
      const song = m.song;
      // camera leans toward whoever is talking
      const lean = 0.9 * (m.active.agent - m.active.caller) * (song ? 0.3 : 1);
      camera.position.set(lean + 0.3 * Math.sin(t * 0.13), 4.3 + 0.15 * Math.sin(t * 0.21), 17.5);
      camera.lookAt(lean * 0.6, 2.25, 0);
      sky.intensity = 1.6;
      sun.intensity = 1.8;
      divider.scale.set(0.25, 7.2, 14.4);
      divider.position.set(0, -0.2 + 3.6, 3.8);
      if (song) {
        // the disco: lights down, the divider sinks for the ball, and the camera dances too: a slow
        // orbit, a sway every two beats, a pump on each, a punch in when a chorus drops
        const e = Math.min(1.3, song.energy);
        const k = ease(song.since / 2);
        const pump = Math.pow(1 - song.phase, 4);
        const punch = song.section === "chorus" && song.sectionSince < 1.4 ? 1 - ease(song.sectionSince / 1.4) : 0;
        const dist = 17.5 - k * (0.6 * e * pump + 3.2 * punch + (song.section === "finale" ? 1.6 : 0));
        const orbit = k * 0.12 * Math.sin(song.since * 0.1);
        const x = lean * 0.6 + 0.35 * e * sway(song);
        camera.position.set(x + Math.sin(orbit) * dist, 4.3 + 0.25 * e * hop(song) - 0.6 * punch, Math.cos(orbit) * dist);
        camera.lookAt(x, 2.25, 0);
        camera.rotateZ(0.03 * e * sway(song));
        // a white flash as a chorus drops, a flicker on the beat in the finale
        const flash = 3 * punch * punch + (song.section === "finale" ? 1.2 * Math.pow(1 - song.phase, 8) : 0.3 * e * Math.pow(1 - song.phase, 6));
        sky.intensity = 1.6 * (1 - 0.75 * k) + flash;
        sun.intensity = 1.8 * (1 - 0.8 * k);
        // the divider pulls back and down, out of the moving camera's way, and the ball comes in over it
        const h = 7.2 - 2.8 * ease(song.since / 1.5);
        const d = 14.4 - 10 * ease(song.since / 1.5);
        divider.scale.set(0.25, h, d);
        divider.position.set(0, -0.2 + h / 2, -3.4 + d / 2);
      }
      party?.(m);

      caller.animate(m);
      const { idle } = animateBot(bot, m, m.level.agent, m.active.agent, m.active.caller, 0);
      // talked over: a startled jolt
      if (m.flinch !== null && m.flinch < 0.5) {
        const k = Math.sin((m.flinch / 0.5) * Math.PI);
        bot.head.position.y += 0.18 * k;
        bot.head.rotation.z += 0.15 * k;
      }
      // a sip of tea every so often while the caller talks
      const sipPhase = (t % 11) / 11;
      let sip = kind === "electrician" ? 0 : idle * (sipPhase < 0.2 ? Math.sin((sipPhase / 0.2) * Math.PI) : 0);
      // they hung up: a long, satisfied sip
      if (m.hangup !== null) sip = m.hangup < 1 ? 0 : Math.sin(Math.min(1, (m.hangup - 1) / 2.2) * Math.PI);
      if (song) sip = 0;
      bot.arm.rotation.x = -0.35 - 1.7 * sip;
      bot.arm.rotation.z = 0.35 * sip;
      if (sip > 0.6) bot.mouth.scale.y = 0.02;
      const since = m.sinceStage;
      if (kind === "electrician") {
        pad.visible = since !== null;
        bot.armL.rotation.x = since !== null ? -0.9 : -0.2;
        bot.arm.rotation.x = since !== null ? -0.6 - 0.25 * m.active.caller * Math.max(0, Math.sin(t * 9)) : -0.35;
        shades.visible = false;
      } else {
        shades.visible = since !== null;
        if (since !== null) shades.position.y = 0.5 + 2.2 * (1 - ease(since / 0.9));
        if (since !== null && since > 0.8) for (const e of bot.eyes) e.visible = false;
        bot.armL.rotation.x = -0.15;
      }
      (bot.belly.material as THREE.MeshLambertMaterial).emissive.set(since === null ? "#35d07a" : kind === "electrician" ? "#35d07a" : "#d8281f");
      bot.root.position.y = 0.05;
      bot.armL.rotation.z = 0;
      bot.mouth.visible = true;
      songKit?.(m);
      if (song) {
        // bouncing in the armchair, mic up while it sings, the other arm waving, antenna strobing
        const e = Math.min(1.2, song.energy);
        const side = sway(song);
        const sing = clamp01(m.active.agent * 1.5);
        bot.root.position.y = 0.05 + 0.18 * e * hop(song);
        bot.root.rotation.z = 0.06 * e * side;
        bot.head.rotation.x = -0.05 + 0.2 * e * Math.pow(1 - song.phase, 3);
        bot.head.rotation.z = 0.12 * e * side;
        bot.arm.rotation.x = -0.35 - 1.7 * sing - (1 - sing) * 1.4 * clamp01(e) * (0.6 + 0.4 * side);
        bot.arm.rotation.z = 0.35 * sing;
        bot.armL.rotation.x = -0.2;
        bot.armL.rotation.z = -(0.3 + 2.1 * clamp01(e) - 0.45 * side * e);
        (bot.antennaTip.material as THREE.MeshLambertMaterial).emissive.set(discoAt(song.beat * 2, 3));
        (bot.belly.material as THREE.MeshLambertMaterial).emissive.set(discoAt(song.beat, 1));
      }

      // pulses travel away from whoever is speaking
      for (let i = 0; i < pulses.length; i++) {
        const fromCaller = i < PULSES;
        const level = fromCaller ? m.level.caller : m.level.agent;
        const p = pulses[i]!;
        if (song) {
          // the song: always on, rainbow, stepping along with the beat
          // the beat count is negative before the first beat: keep u in [0, 1)
          const u = (((song.beat * 0.125 + (i % PULSES) / PULSES) % 1) + 1) % 1;
          const mat = rainbow[i]!;
          mat.color.setHSL((i / PULSES + song.beat * 0.0625) % 1, 1, 0.55);
          p.material = mat;
          p.visible = true;
          cable.getPointAt(fromCaller ? u : 1 - u, p.position);
          p.scale.setScalar(0.5 + 0.8 * Math.min(1.2, song.energy) * Math.pow(1 - song.phase, 2));
          continue;
        }
        p.material = fromCaller ? callerPulse : agentPulse;
        const u = (t * 0.45 + (i % PULSES) / PULSES) % 1;
        p.visible = level > 0.3;
        cable.getPointAt(fromCaller ? u : 1 - u, p.position);
        p.scale.setScalar(0.6 + level);
      }
      renderer.render(scene, camera);
    },
    anchors() {
      return {
        callerHead: project(caller.head, 2.1),
        agentHead: project(bot.head, 1.9),
        callerFeet: project(caller.root, -0.3),
        agentFeet: project(bot.root, -0.3),
      };
    },
  };
}
