// The public page (src/web/public.ts): pick a game and a goal, play it as a phone call, see the
// leaderboard. The call itself is phone.ts; scores are settled on the server (src/core/game.ts).

import { dial, type Call, type PlayState } from "./phone";

type Game = "scam" | "get_through";
interface Goal { id: string; name: string; brief: string; hard: boolean }
interface Entry { player: string; scoreMs: number }
/** src/web/public.ts Lobby */
interface Lobby { games: Record<Game, Goal[]>; boards: Record<Game, Record<string, Entry[]>>; size: number; wasted: { seconds: number; live: number } }
/** src/web/public.ts GameResult */
interface Result { game: Game; goal: string; player: string; scoreMs: number | null; durationMs: number | null; rank: number | null; board: Entry[] }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const base = document.body.dataset.base || "/";
let lobby = JSON.parse($("lobby").textContent || "{}") as Lobby;
const LABEL: Record<Game, string> = { scam: "SCAM ME", get_through: "GET THROUGH" };
/** A game's start page: how to play, and what the leaderboard ranks. */
const HOW: Record<Game, { play: string; board: string }> = {
  scam: { play: "Pick your goal, then pull it off without the bot catching on.", board: "LONGEST SCAM UNDETECTED WINS" },
  get_through: { play: "Pick your goal, then get the bot to pass on your message.", board: "FASTEST TO GET THROUGH WINS" },
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const pad = (n: number) => String(n).padStart(2, "0");
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Per-visitor conveniences: the player's name and last goal per game.
const store = {
  get: (k: string) => { try { return localStorage.getItem(`ss-${k}`); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`ss-${k}`, v); } catch {} },
};
const cleanName = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
let player = cleanName(store.get("player") ?? "");
const goalIdx = { scam: 0, get_through: 0 } as Record<Game, number>;
for (const g of ["scam", "get_through"] as Game[]) goalIdx[g] = Math.max(0, lobby.games[g].findIndex((x) => x.id === store.get(`goal-${g}`)));
const goalOf = (g: Game) => lobby.games[g][goalIdx[g]] ?? lobby.games[g][0]!;

let screen: "home" | "call" | "result" = "home";
let mode: Game = "scam";

function show(next: typeof screen) {
  screen = next;
  for (const s of ["home", "call", "result"]) $(`s-${s}`).hidden = s !== next;
  closeName();
  drawChips();
}

function setMode(g: Game) {
  mode = g;
  document.body.dataset.mode = g;
}

let msgTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  const m = $("msg");
  m.textContent = text;
  m.hidden = !text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (m.hidden = true), 5000);
}

// ---------- sprites ----------
// The games' icons (24×24): a robber and a friendly caller, each on a classic phone handset.
const SPRITES: Record<string, { rows: string[]; pal: Record<string, string> }> = {
  bandit: {
    rows: [
      ".........kk.............", "......kkkkkkkk..........", ".....kkkkkkkkkk.........", ".....kkkkkkkkkk.........",
      ".....kkkkkkkkkk.........", "....kkkkkkkkkkkk.kkk....", "....kkkkkkkkkkkkkkkk....", "....sssssssssssskkkk....",
      "....sssssssssssskkkk....", "...kkkkkkkkkkkkkk..kk...", "..kkkkwwkkkkwwkkk...kk..", ".kkkkkkkkkkkkkkkk....k..",
      "kk..ssssssssssss.....k..", "....sssssssssmss....kk..", "....sssssmmmmsss...kk...", "....sssssssssssskkkk....",
      "....sssssssssssskkkk....", ".....ssssssssss.kkkk....", ".......ssssss....kkk....", "......kkkkkkkk....k.....",
      "....wwwwwwwwwwww...k....", "...kkkkkkkkkkkkkk.k.....", "...wwwwwwwwwwwwww..k....", "...kkkkkkkkkkkkkk.k.....",
    ],
    pal: { k: "#0e0d10", s: "#ffe3d6", w: "#fff6ec", m: "#7d110b" },
  },
  caller: {
    rows: [
      "........................", "........................", "......hhhhhhhh..........", ".....hhhhhhhhhh.........",
      ".....hhhhhhhhhh.........", ".....hhhhhhhhhh..kkk....", "....hhhhhhhhhhhhkkkk....", "....hsssssssssshkkkk....",
      "....hssssssssssskkkk....", "....ssssssssssss...kk...", "....ssskssssksss....kk..", "....ssskssssksss.....k..",
      "....ssssssssssss.....k..", "....srskwwwwksrs....kk..", "....sssskkkkssss...kk...", "....sssssssssssskkkk....",
      "....sssssssssssskkkk....", ".....ssssssssss.kkkk....", ".......ssssss....kkk....", "......wwbwwbww....k.....",
      "....wwwwwbbwwwww...k....", "...wwwwwwbbwwwwww.k.....", "...wwwwwwbbwwwwww..k....", "...wwwwwwbbwwwwww.k.....",
    ],
    pal: { h: "#6b3a1e", k: "#04230f", s: "#ffe3d6", w: "#fff6ec", r: "#ff9e8a", b: "#04230f" },
  },
  sparkle: {
    rows: ["....a....", "....a....", "...aaa...", "..aaaaa..", "aaaaaaaaa", "..aaaaa..", "...aaa...", "....a....", "....a...."],
    pal: { a: "#ffb000" },
  },
};
document.querySelectorAll<HTMLCanvasElement>("canvas.sprite").forEach((c) => {
  const sp = SPRITES[c.dataset.sprite ?? ""];
  const x = c.getContext("2d");
  if (!sp || !x) return;
  sp.rows.forEach((r, y) => [...r].forEach((ch, i) => { const col = sp.pal[ch]; if (col) { x.fillStyle = col; x.fillRect(i, y, 1, 1); } }));
});

// ---------- leaderboards ----------
/**
 * `size` rows: the entries, then empty ones. The lobby invites with a blinking "you?" slot; a
 * result highlights `you`, this call's score (added at its rank if below), and nothing without one.
 */
function boardHTML(entries: readonly Entry[], opts: { invite?: boolean; you?: { player: string; scoreMs: number; rank: number } } = { invite: true }) {
  const { you } = opts;
  const rows = entries.map((e, i) => ({ r: i + 1, n: e.player, t: mmss(e.scoreMs), cls: you && e.player === you.player && e.scoreMs === you.scoreMs ? "you" : "" }));
  if (you && !rows.some((r) => r.cls)) {
    if (rows.length >= lobby.size) rows.length = lobby.size - 1;
    rows.push({ r: you.rank, n: you.player, t: mmss(you.scoreMs), cls: "you" });
  }
  if (opts.invite && rows.length < lobby.size) rows.push({ r: rows.length + 1, n: rows.length ? "YOU?" : "BE FIRST", t: "--:--", cls: "you blinky" });
  while (rows.length < lobby.size) rows.push({ r: rows.length + 1, n: "---", t: "--:--", cls: "empty" });
  return rows.map((r) => `<li class="${r.cls}"><span class="r">${r.r}</span><span class="n">${esc(r.n)}</span><span class="t">${r.t}</span></li>`).join("");
}

// ---------- home ----------
const split = $("split");

function splitSet(g: Game | null) {
  if (g) split.dataset.active = g;
  else delete split.dataset.active;
  split.querySelectorAll<HTMLElement>(".half").forEach((h) => h.classList.toggle("on", h.dataset.game === g));
}

function drawDetail(g: Game, dir = 0) {
  const d = split.querySelector<HTMLElement>(`[data-detail="${g}"]`)!;
  if (!d.firstChild) {
    d.innerHTML =
      `<p class="how">${HOW[g].play}</p><span class="lbl">YOUR GOAL</span><div class="car"><button class="car-arr" type="button" data-step="-1" aria-label="Previous goal">◂</button>` +
      `<div class="card" aria-live="polite"></div><button class="car-arr" type="button" data-step="1" aria-label="Next goal">▸</button></div>` +
      `<div class="dots"></div><span class="lbl">${HOW[g].board}</span><ol class="board"></ol><button class="btn" type="button" data-start>START</button>`;
    let x0: number | null = null;
    const card = d.querySelector<HTMLElement>(".card")!;
    card.addEventListener("pointerdown", (e) => (x0 = e.clientX));
    card.addEventListener("pointerup", (e) => {
      if (x0 !== null && Math.abs(e.clientX - x0) > 36) stepGoal(g, e.clientX < x0 ? 1 : -1);
      x0 = null;
    });
    d.querySelectorAll<HTMLElement>(".car-arr").forEach((b) => b.addEventListener("click", () => stepGoal(g, Number(b.dataset.step))));
    d.querySelector(".dots")!.addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined) stepGoal(g, Number(i) - goalIdx[g]);
    });
  }
  const goal = goalOf(g);
  const card = d.querySelector<HTMLElement>(".card")!;
  card.innerHTML = `<span class="card-top"><b>${esc(goal.name)}</b>${goal.hard ? `<span class="hard">HARD</span>` : ""}</span><p>${esc(goal.brief)}</p>`;
  card.classList.remove("inL", "inR");
  if (dir) { void card.offsetWidth; card.classList.add(dir > 0 ? "inR" : "inL"); }
  d.querySelector(".dots")!.innerHTML = lobby.games[g]
    .map((o, i) => `<button type="button" data-i="${i}" class="${i === goalIdx[g] ? "on" : ""}" aria-label="${esc(o.name)}"></button>`)
    .join("");
  d.querySelector(".board")!.innerHTML = boardHTML(lobby.boards[g][goal.id] ?? []);
}

function stepGoal(g: Game, dir: number) {
  if (!dir) return;
  const n = lobby.games[g].length;
  goalIdx[g] = (goalIdx[g] + dir + n) % n;
  store.set(`goal-${g}`, goalOf(g).id);
  drawDetail(g, dir);
}

split.querySelectorAll<HTMLElement>(".half").forEach((h) => {
  const g = h.dataset.game as Game;
  h.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".x")) return splitSet(null);
    if (t.closest("[data-start]")) {
      setMode(g);
      return player ? startGame() : openName("call");
    }
    if (!h.classList.contains("on")) splitSet(g);
  });
  h.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === h) {
      e.preventDefault();
      splitSet(h.classList.contains("on") ? null : g);
    }
  });
});

addEventListener("keydown", (e) => {
  if (screen !== "home" || !$("s-name").hidden) return;
  const active = split.dataset.active as Game | undefined;
  if (active && (e.key === "ArrowLeft" || e.key === "ArrowRight")) stepGoal(active, e.key === "ArrowRight" ? 1 : -1);
  else if (e.key === "Escape") splitSet(null);
});

/** Scammer time wasted: ticks up by a second per second for each real scam call on the line. */
let wastedAt = Date.now();
function drawWasted() {
  const s = Math.floor(lobby.wasted.seconds + (lobby.wasted.live * (Date.now() - wastedAt)) / 1000);
  $("wasted").textContent = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
setInterval(drawWasted, 1000);

function drawLobby() {
  drawDetail("scam");
  drawDetail("get_through");
  drawWasted();
}

async function refreshLobby() {
  try {
    const r = await fetch(`${base}call/lobby`);
    if (!r.ok) return;
    lobby = (await r.json()) as Lobby;
    wastedAt = Date.now();
    drawLobby();
  } catch {}
}

// ---------- player name ----------
const nameIn = $<HTMLInputElement>("name-in"), slots = $("slots");
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
let nameDraft = "";
let namePurpose: "call" | "save" = "call";
for (let i = 0; i < 3; i++) {
  slots.insertAdjacentHTML(
    "beforeend",
    `<div class="slot"><button class="ar" type="button" data-i="${i}" data-d="1" aria-label="Next letter">▲</button><div class="ch" data-i="${i}"></div>` +
      `<button class="ar" type="button" data-i="${i}" data-d="-1" aria-label="Previous letter">▼</button></div>`,
  );
}

function drawSlots() {
  slots.querySelectorAll<HTMLElement>(".ch").forEach((c, i) => {
    c.textContent = nameDraft[i] ?? "";
    c.classList.toggle("cur", i === Math.min(nameDraft.length, 2) && nameDraft.length < 3);
    c.classList.toggle("empty", !nameDraft[i]);
  });
  nameIn.value = nameDraft;
}

function openName(purpose: "call" | "save") {
  namePurpose = purpose;
  nameDraft = player;
  $("name-tag").textContent = `${LABEL[mode]} · ${goalOf(mode).name}`;
  $("name-tag").hidden = purpose !== "call";
  $("name-ok").textContent = purpose === "call" ? "CALL ▸" : "SAVE";
  $("s-name").hidden = false;
  drawSlots();
  if (matchMedia("(pointer: fine)").matches) nameIn.focus({ preventScroll: true });
}

function closeName() {
  $("s-name").hidden = true;
}

function drawChips() {
  document.querySelectorAll<HTMLElement>("[data-chip]").forEach((c) => {
    c.innerHTML = `<small>P1</small>${esc(player || "???")}`;
    c.setAttribute("aria-label", `Player ${player || "not set"}. Change name`);
    if (c.closest(".band")) c.hidden = !player;
  });
}

nameIn.addEventListener("input", () => { nameDraft = cleanName(nameIn.value); drawSlots(); });
nameIn.addEventListener("keydown", (e) => e.key === "Enter" && $("name-ok").click());
slots.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const ar = t.closest<HTMLElement>(".ar");
  if (ar) {
    // Arcade style: ▲▼ turn a letter; earlier empty slots become A.
    const i = Number(ar.dataset.i), d = Number(ar.dataset.d);
    const chars = nameDraft.padEnd(3, " ").split("");
    for (let j = 0; j < i; j++) if (chars[j] === " ") chars[j] = "A";
    const cur = LETTERS.indexOf(chars[i]!);
    chars[i] = LETTERS[cur < 0 ? (d > 0 ? 0 : LETTERS.length - 1) : (cur + d + LETTERS.length) % LETTERS.length]!;
    nameDraft = chars.join("").trimEnd();
    return drawSlots();
  }
  if (t.closest(".ch")) nameIn.focus({ preventScroll: true });
});
$("name-x").addEventListener("click", closeName);
$("name-ok").addEventListener("click", () => {
  if (!nameDraft) return nameIn.focus({ preventScroll: true });
  player = nameDraft;
  store.set("player", player);
  closeName();
  drawChips();
  if (namePurpose === "call") startGame();
});
document.addEventListener("click", (e) => (e.target as HTMLElement).closest("[data-chip]") && openName("save"));

// ---------- the call ----------
const mbar = $("mbar");
mbar.innerHTML = "<i></i>".repeat(8) + `<i class="mid"></i>` + "<i></i>".repeat(8);
const segGenuine = [...mbar.children].slice(0, 8).reverse(), segScam = [...mbar.children].slice(9);

let call: Call | null = null;
let goal: Goal = goalOf("scam");
const FRESH: PlayState = { verdict: null, lean: 0, stage: null, caughtAt: null, goalAt: null, askedAt: null };
let state = FRESH;
/** the goal's leaderboard when the call started, shown while the result is scored */
let callBoard: Entry[] = [];
let tick: ReturnType<typeof setInterval> | undefined;
let live = false;

function startGame() {
  goal = goalOf(mode);
  callBoard = lobby.boards[mode][goal.id] ?? [];
  state = FRESH;
  live = false;
  show("call");
  document.body.className = "connecting";
  $("s-call").classList.remove("caught", "reached");
  $("banner").hidden = true;
  $("c-lbl").textContent = "CALLING…";
  $("c-time").textContent = "00:00";
  drawMeter();
  drawCard();
  const mine = (call = dial({
    base,
    game: { game: mode, goal: goal.id, player },
    remote: $<HTMLAudioElement>("remote"),
    onLive() {
      if (call !== mine) return;
      live = true;
      document.body.className = "live";
      drawClock();
      tick = setInterval(drawClock, 250);
    },
    onState(s) {
      if (call !== mine) return;
      const prev = state;
      state = s;
      if (mode === "scam" && s.caughtAt !== null && prev.caughtAt === null) flash("CAUGHT!");
      if (mode === "get_through" && delivered(s) && !delivered(prev)) flash("GOT THROUGH!", true);
      else if (mode === "get_through" && s.caughtAt !== null && prev.caughtAt === null && !delivered(s)) flash("SUSPECTED!");
      drawMeter();
      drawCard();
      if (live) drawClock();
    },
    onEnd(end) {
      if (call !== mine) return;
      call = null;
      clearInterval(tick);
      document.body.className = "idle";
      if (end.live && end.callId) return void showResult(end.callId);
      show("home");
      toast(end.text || "Call ended.");
    },
  }));
}

const elapsed = () => (call ? Date.now() - call.t0 : 0);
/** the move counts only if it came before being caught (src/core/game.ts scoreOf) */
const moved = (s: PlayState) => s.goalAt !== null && (s.caughtAt === null || s.goalAt <= s.caughtAt);
const delivered = moved;
/** scam: caught before asking. The referee often hears the ask a turn after the catch, so until
 * it has, the score on show assumes it will. */
const askedLate = (s: PlayState) => s.caughtAt !== null && s.askedAt !== null && s.askedAt > s.caughtAt;

function flash(text: string, good = false) {
  const b = $("banner");
  b.textContent = text;
  b.classList.toggle("good", good);
  b.hidden = false;
  setTimeout(() => (b.hidden = true), 1500);
}

/** The needle as blocks from the middle: green towards genuine, red towards scam. */
function drawMeter() {
  const n = Math.round(Math.abs(state.lean) * 8);
  segGenuine.forEach((s, i) => (s.className = state.lean < 0 && i < n ? "g" : ""));
  segScam.forEach((s, i) => (s.className = state.lean > 0 && i < n ? "s" : ""));
}

/** The goal card: the goal stays on it all call; its tab (and colour) says how the call is going. */
function drawCard() {
  $("m-name").textContent = goal.name;
  $("m-brief").textContent = goal.brief;
  $("m-hard").hidden = !goal.hard;
  const tag = (tab: string, cls: string[] = []) => {
    $("mission").className = ["mission", ...cls].join(" ");
    $("m-tab").textContent = tab;
  };
  const suspected = state.caughtAt !== null && state.lean > 0;
  $("s-call").classList.toggle("caught", mode === "scam" && state.caughtAt !== null);
  $("s-call").classList.toggle("reached", mode === "get_through" && delivered(state));
  if (mode === "scam") {
    if (state.caughtAt !== null && (!moved(state) || askedLate(state))) tag("CAUGHT · NO SCORE", ["solid"]);
    else if (state.caughtAt !== null) tag(suspected ? "CAUGHT!" : "NOT SO SURE…", suspected ? ["solid"] : []);
    else if (moved(state)) tag(state.askedAt !== null ? "ASKED ✓" : "MOVE MADE ✓");
    else tag(LABEL.scam);
  } else if (delivered(state)) tag("DELIVERED ✓", ["solid"]);
  else if (suspected) tag("SUSPECTED!", ["solid", "warn"]);
  else tag(LABEL.get_through);
}

function drawClock() {
  const t = elapsed();
  if (mode === "scam") {
    // The score clock runs from the move until caught.
    const caught = state.caughtAt, move = state.goalAt;
    $("c-lbl").textContent = caught !== null ? "NOW WASTING YOUR TIME" : move === null ? "MAKE YOUR MOVE" : "SCAM UNDETECTED";
    $("c-time").textContent = mmss(caught !== null ? t - caught : move === null ? 0 : t - move);
  } else {
    const done = delivered(state);
    $("c-lbl").textContent = done ? "SAY BYE WHEN YOU'RE READY" : "TIME TO REACH ME";
    $("c-time").textContent = mmss(done ? state.goalAt! : t);
  }
}

$("end").addEventListener("click", () => call?.hangUp());
// Closing the tab or leaving the page hangs up too (the server would only notice later).
addEventListener("pagehide", () => call?.hangUp());

// ---------- results ----------
async function showResult(callId: string) {
  show("result");
  $("r-title").textContent = "SCORING…";
  $("r-lbl").hidden = true;
  $("r-time").textContent = "--:--";
  $("r-time").classList.add("wait");
  $("r-rank").textContent = "";
  $("r-extra").hidden = true;
  $("r-board").innerHTML = boardHTML(callBoard, {});
  // The score is settled as the call ends on the server, just after the page hangs up.
  for (let i = 0; i < 20 && screen === "result"; i++) {
    try {
      const r = await fetch(`${base}call/${callId}/result`);
      if (r.status === 200) return drawResult((await r.json()) as Result);
      if (r.status !== 202) break;
    } catch {}
    await new Promise((ok) => setTimeout(ok, 500));
  }
  if (screen !== "result") return;
  $("r-time").classList.remove("wait");
  $("r-title").textContent = "NO SCORE";
  $("r-rank").textContent = "COULDN'T LOAD THE SCORES";
}

function drawResult(r: Result) {
  const scored = r.scoreMs !== null && r.rank !== null;
  const scam = r.game === "scam";
  // Why there's no score, from the call's last state (the server's score is what counts).
  const caught = state.caughtAt;
  $("r-title").textContent = scam
    ? scored ? (caught === null ? "NEVER CAUGHT!" : "GAME OVER") : "NO SCORE"
    : scored ? "GOT THROUGH!" : "HUNG UP";
  $("r-lbl").hidden = !scored;
  $("r-lbl").textContent = scam ? "SCAM UNDETECTED FOR" : "GOT THROUGH IN";
  $("r-time").classList.remove("wait");
  $("r-time").textContent = scored ? mmss(r.scoreMs!) : "--:--";
  // Only why there's no score: a score's place is on the board below.
  $("r-rank").textContent = scored
    ? ""
    : !scam ? "YOUR MESSAGE DIDN'T REACH ME"
    : caught !== null ? (moved(state) ? "CAUGHT BEFORE YOU ASKED" : "CAUGHT BEFORE YOUR MOVE")
    : state.goalAt === null ? "YOU NEVER MADE YOUR MOVE" : "NEVER CAUGHT, BUT YOU DIDN'T TRY";
  // The whole call kept a scammer (the player) busy, not only the time after the catch.
  const wasted = scam && r.durationMs !== null ? r.durationMs : 0;
  $("r-extra").hidden = wasted < 1000;
  $("r-wasted").textContent = `${mmss(wasted)} OF SCAMMER TIME WASTED`;
  $("r-board").innerHTML = boardHTML(r.board, scored ? { you: { player: r.player, scoreMs: r.scoreMs!, rank: r.rank! } } : {});
  void refreshLobby();
}

$("again").addEventListener("click", () => startGame());
function goHome() {
  // The name panel can be open over a call: leave the call alone.
  if (call) return closeName();
  show("home");
  splitSet(null);
  void refreshLobby();
}
$("menu").addEventListener("click", goHome);
// The logo goes home (it isn't on the call screen).
document.querySelectorAll("[data-home]").forEach((b) => b.addEventListener("click", goHome));

drawLobby();
drawChips();
