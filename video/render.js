"use strict";
/* global Mp4Muxer */
/*
 * The bot film: both bots' real records played back as one story, frame by frame,
 * from /data.json. In record mode it encodes an MP4 in the browser and posts it to
 * make.cjs.
 *
 *   /?record=1   render every frame, encode, upload   (what make.cjs opens)
 *   /?t=12.5     draw one frame at 12.5 s             (stills / checks)
 *   /?play=1     play it live in the page
 *
 * Acts: cold open -> title -> the replay (one big scene: a ring per bot, linked;
 * the clock runs from the first trade to today, slowing down on real highlights) ->
 * the record (final scorecard).
 */

const W = 1080;
const H = 1920;
const FPS = 30;
const N = 64; // points per ring line
const SANS = "'Space Grotesk', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono', Menlo, 'DejaVu Sans Mono', monospace";
const COL = {
  bg: "#02040a",
  text: "#e9f1fb",
  mid: "#9fb3c8",
  dim: "#5d7189",
  edge: "rgba(120, 180, 240, 0.22)",
  green: "#3dff9a",
  red: "#ff4d6d",
  gold: "#ffd36a",
};
const LOOK = {
  bybit: { name: "BYBIT FUTURES", short: "BYBIT", color: "#ffad42", win: "#ffd76e", loss: "#ff4f4f", base: [255, 196, 120] },
  pump: { name: "PUMP.FUN", short: "PUMP", color: "#47e1ff", win: "#52ffc6", loss: "#ff4d8d", base: [150, 214, 255] },
};

let DUR = 30;
const T_COLD = 2.2; // cold open ends
const T0 = 5.0; // replay starts
let T1 = 24.5; // replay ends, the record begins
let R = T1 - T0;

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d", { alpha: false });
const statusEl = document.getElementById("status");
const barEl = document.querySelector("#bar i");
const mk = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const sceneCv = mk(W, H);
const sctx = sceneCv.getContext("2d");
const bloomA = mk(W / 4, H / 4);
const bctxA = bloomA.getContext("2d");
const bloomB = mk(W / 12, H / 12);
const bctxB = bloomB.getContext("2d");

// ------------------------------------------------------------------ helpers

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const hash = (seed, k) => {
  const x = Math.sin(seed * 9301.17 * (k + 1) + k * 49.297) * 43758.5453;
  return x - Math.floor(x);
};
function upperBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function num(v, dec = 0) {
  const [i, d] = Math.abs(v).toFixed(dec).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
}
const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
const signed = (v, dec) => sign(v) + num(v, dec);
const usd = (v, dec = 2) => `${sign(v)}$${num(v, dec)}`;
const pad2 = (n) => String(n).padStart(2, "0");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const dateText = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const timeText = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const shortStamp = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${timeText(ms)}`;
};
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function txt(c, s, x, y, o = {}) {
  const { size = 16, weight = 500, font = MONO, color = COL.text, align = "left", alpha = 1, spacing = 0, glow = 0 } = o;
  if (alpha <= 0.002 || !s) return 0;
  c.save();
  c.globalAlpha *= clamp(alpha, 0, 1);
  c.font = `${weight} ${size}px ${font}`;
  c.fillStyle = color;
  c.textBaseline = "alphabetic";
  if (glow) {
    c.shadowColor = color;
    c.shadowBlur = glow;
  }
  let width;
  if (!spacing) {
    c.textAlign = align;
    c.fillText(s, x, y);
    width = c.measureText(s).width;
  } else {
    const chars = [...s];
    const ws = chars.map((ch) => c.measureText(ch).width);
    width = ws.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    let cx = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
    c.textAlign = "left";
    chars.forEach((ch, i) => {
      c.fillText(ch, cx, y);
      cx += ws[i] + spacing;
    });
  }
  c.restore();
  return width;
}

function glass(c, x, y, w, h, alpha = 1, accent = null, fill = 0.72) {
  if (alpha <= 0.002) return;
  c.save();
  c.globalAlpha *= alpha;
  c.fillStyle = `rgba(5, 10, 21, ${fill})`;
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, 14);
  else c.rect(x, y, w, h);
  c.fill();
  c.strokeStyle = accent ? rgba(accent, 0.55) : COL.edge;
  c.lineWidth = 1.2;
  c.stroke();
  c.restore();
}

// ------------------------------------------------------------------ data prep

let D;
let BOTS;
let CLOCK;
let ALL;
let PLAN;
let EVENTS;

function buildClock() {
  // Replay position p (0..1) for a moment in time. Mostly "how much has happened by
  // then" (each bot gets an equal share, trades count most, watched coins a little),
  // plus a little real time so long pauses still take a moment.
  const ev = [];
  for (const b of D.bots) {
    const items = [];
    for (const l of b.lines) items.push([l.t, 0.05]);
    for (const t of b.trades) {
      if (t.open) items.push([t.open, 0.5]);
      items.push([t.close, 1]);
    }
    for (const f of b.fails) items.push([f.t, 0.3]);
    const total = items.reduce((s2, x) => s2 + x[1], 0) || 1;
    for (const [t, w] of items) ev.push([t, w / total]);
  }
  ev.sort((a, b) => a[0] - b[0]);
  const times = Float64Array.from(ev.map((e) => e[0]));
  const cumW = new Float64Array(ev.length);
  let run = 0;
  ev.forEach((e, i) => (cumW[i] = run += e[1]));
  const totalW = run || 1;
  const start = ev.length ? times[0] : D.story.start;
  const end = ev.length ? times[times.length - 1] : D.story.end;
  const span = Math.max(1, end - start);
  const LIN = 0.04;
  const pOf = (ms) => {
    if (ms <= start) return 0;
    if (ms >= end) return 1;
    const i = upperBound(times, ms); // times[i-1] <= ms < times[i]
    const before = i > 0 ? cumW[i - 1] : 0;
    const t0 = i > 0 ? times[i - 1] : start;
    const frac = (ms - t0) / Math.max(1, times[i] - t0);
    const q = (before + (cumW[i] - before) * frac) / totalW;
    return LIN * ((ms - start) / span) + (1 - LIN) * q;
  };
  // inverse, tabulated once
  const K = 4000;
  const tab = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) {
    let lo = start;
    let hi = end;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (pOf(mid) < k / K) lo = mid;
      else hi = mid;
    }
    tab[k] = (lo + hi) / 2;
  }
  const msOf = (p) => {
    const f = clamp(p, 0, 1) * K;
    const j = Math.min(K - 1, Math.floor(f));
    return tab[j] + (tab[j + 1] - tab[j]) * (f - j);
  };
  return { start, end, span, pOf, msOf };
}

function prepBot(bot, index, count) {
  const B = { ...bot, look: LOOK[bot.key] || LOOK.pump, index };
  const L = B.lines;
  B.pAppear = Float64Array.from(L.map((l) => CLOCK.pOf(l.t)));
  B.pClose = Float64Array.from(B.trades.map((t) => CLOCK.pOf(t.close)));
  B.pOpen = Float64Array.from(B.trades.map((t, i) => (t.open ? Math.min(CLOCK.pOf(t.open), B.pClose[i]) : B.pClose[i])));
  B.geom = new Float32Array(L.length * N * 3);
  B.group = new Uint8Array(L.length);
  L.forEach((l, i) => {
    const s = l.seed;
    const u0 = hash(s, 1) * Math.PI * 2;
    const spanU = Math.PI * (0.55 + 1.15 * hash(s, 2));
    const wind = (hash(s, 3) < 0.5 ? -1 : 1) * (1.6 + 5.5 * hash(s, 6));
    const v0 = hash(s, 4) * Math.PI * 2;
    const rr = 0.42 * (0.5 + 0.55 * hash(s, 5)) + 0.06 * (l.w || 0);
    for (let j = 0; j < N; j++) {
      const u = u0 + (spanU * j) / (N - 1);
      const v = v0 + wind * (u - u0);
      const o = (i * N + j) * 3;
      B.geom[o] = (1 + rr * Math.cos(v)) * Math.cos(u);
      B.geom[o + 1] = (1 + rr * Math.cos(v)) * Math.sin(u);
      B.geom[o + 2] = rr * Math.sin(v);
    }
    const hue = hash(s, 7);
    const w = l.w || 0;
    B.group[i] = (hue < 0.8 ? 0 : hue < 0.92 ? 1 : 2) * 3 + (w < 0.15 ? 0 : w < 0.5 ? 1 : 2);
  });
  B.scr = new Float32Array(L.length * N * 2);
  B.depth = new Uint8Array(L.length);
  B.tradeOfLine = new Int32Array(L.length).fill(-1);
  B.trades.forEach((t, i) => {
    if (t.line >= 0 && t.line < L.length) B.tradeOfLine[t.line] = i;
  });
  // where the ring sits: two rings link through each other, one ring sits alone
  B.mode = count === 1 ? "solo" : bot.key === "bybit" ? "top" : "bottom";
  B.spin = bot.key === "bybit" ? 0.2 : -0.17;
  // particles on the ring surface
  B.dust = [];
  for (let k = 0; k < 80; k++) {
    const s = index * 1000 + k;
    B.dust.push([hash(s, 11) * Math.PI * 2, hash(s, 12) * Math.PI * 2, 0.3 + 0.75 * hash(s, 13), hash(s, 14)]);
  }
  return B;
}

function prep() {
  DUR = D.seconds || 30;
  T1 = DUR - 5.5;
  R = T1 - T0;
  CLOCK = buildClock();
  BOTS = D.bots.map((b, i) => prepBot(b, i, D.bots.length));
  // every closed trade of both bots in one line, for the totals and the chart
  ALL = [];
  BOTS.forEach((B) => B.trades.forEach((t, i) => ALL.push({ B, i, p: B.pClose[i], t })));
  ALL.sort((a, b) => a.p - b.p);
  ALL.p = Float64Array.from(ALL.map((x) => x.p));
  let run = 0;
  ALL.cum = Float64Array.from(ALL.map((x) => (run += x.t.usd || 0)));
  ALL.min = Math.min(0, ...ALL.cum);
  ALL.max = Math.max(0, ...ALL.cum);
  // per bot running sums (for the unpriced chart) and activity over real time (scrubber)
  for (const B of BOTS) {
    let r = 0;
    B.cum = Float64Array.from(B.trades.map((t) => (r += t.pnl)));
    B.cumMin = Math.min(0, ...B.cum);
    B.cumMax = Math.max(0, ...B.cum);
    B.hist = new Float32Array(240);
    for (const t of B.trades) B.hist[Math.min(239, Math.floor(((t.close - CLOCK.start) / CLOCK.span) * 240))]++;
    for (const l of B.lines) B.hist[Math.min(239, Math.floor(((l.t - CLOCK.start) / CLOCK.span) * 240))] += 0.02;
    B.histMax = Math.max(1e-9, ...B.hist);
  }
  // ticker events: closed trades and failed buys
  EVENTS = [];
  BOTS.forEach((B) => {
    B.trades.forEach((t, i) => EVENTS.push({ p: B.pClose[i], B, kind: "close", t }));
    B.fails.forEach((f) => EVENTS.push({ p: CLOCK.pOf(f.t), B, kind: "fail", f }));
  });
  EVENTS.sort((a, b) => a.p - b.p);
  EVENTS.p = Float64Array.from(EVENTS.map((e) => e.p));
  PLAN = planStory();
}

// ------------------------------------------------------------------ story plan: highlights + slow motion

const E_HL = 1.15; // extra seconds of slow motion per highlight
const E_GAP = 2.9; // seconds an intermission takes (end of a chapter -> pause -> next chapter)
function buildMap(sel) {
  const K = 4000;
  const extra = sel.reduce((s, h) => s + (h.kind === "gap" ? E_GAP : E_HL), 0);
  const base = R - extra;
  if (base < 0.4 * R) return null;
  const m = new Float64Array(K).fill(base / K);
  for (const h of sel) {
    if (h.kind === "gap") {
      const a = Math.floor(h.p0 * K);
      const b = Math.max(a + 1, Math.ceil(h.p1 * K));
      for (let i = a; i < b && i < K; i++) m[i] += E_GAP / (b - a);
    } else {
      const c = h.p * K;
      const wb = 12;
      const ws = [];
      let sum = 0;
      for (let i = Math.floor(c - wb); i <= Math.ceil(c + wb); i++) {
        const w = 0.5 + 0.5 * Math.cos((Math.PI * (i - c)) / (wb + 1));
        ws.push([i, w]);
        sum += w;
      }
      for (const [i, w] of ws) m[clamp(i, 0, K - 1)] += (E_HL * w) / sum;
    }
  }
  const S = new Float64Array(K + 1);
  for (let i = 0; i < K; i++) S[i + 1] = S[i] + m[i];
  const secOf = (p) => {
    const f = clamp(p, 0, 1) * K;
    const j = Math.min(K - 1, Math.floor(f));
    return T0 + S[j] + (S[j + 1] - S[j]) * (f - j);
  };
  const pAt = (sec) => {
    const s = clamp(sec - T0, 0, S[K]);
    const j = Math.max(0, upperBound(S, s) - 1);
    if (j >= K) return 1;
    return (j + (s - S[j]) / Math.max(1e-12, S[j + 1] - S[j])) / K;
  };
  return { secOf, pAt };
}

function windowOf(h, map) {
  if (h.kind === "gap") return [map.secOf(h.p0) - 0.25, map.secOf(h.p1) + 0.45];
  const s = map.secOf(h.p);
  return [s - 0.15, s + 1.95];
}

function planStory() {
  const bots = Object.fromEntries(BOTS.map((B) => [B.key, B]));
  const cands = [];
  for (const h of D.story.highlights) {
    const c = { ...h };
    if (h.kind === "gap") {
      const g = D.story.gaps.find((x) => Math.abs(x.from + 1 - h.t) < 2);
      if (!g) continue;
      c.p0 = CLOCK.pOf(g.from);
      c.p1 = CLOCK.pOf(g.to);
      c.p = c.p0;
      c.gap = g;
    } else {
      const B = bots[h.bot];
      if (!B) continue;
      c.B = B;
      c.p = CLOCK.pOf(h.t);
      c.line = h.trade !== undefined ? B.trades[h.trade].line : h.line;
      if (c.line === undefined || c.line < 0) continue;
      c.chapter = D.story.chapters.findIndex((ch) => h.t >= ch.from - 1 && h.t <= ch.to + 1) + 1;
    }
    cands.push(c);
  }
  // intermissions first: they are the turning points of the story
  const rank = (h) => (h.kind === "gap" ? 100 : h.priority);
  cands.sort((a, b) => rank(b) - rank(a) || a.t - b.t);
  let sel = [];
  for (const c of cands) {
    const trial = [...sel, c];
    const map = buildMap(trial);
    if (!map) continue;
    const ws = trial.map((h) => windowOf(h, map)).sort((a, b) => a[0] - b[0]);
    let ok = ws[0][0] >= T0 - 0.25 && ws[ws.length - 1][1] <= T1 + 0.3;
    for (let i = 1; i < ws.length && ok; i++) if (ws[i][0] < ws[i - 1][1] + 0.12) ok = false;
    if (ok) sel = trial;
  }
  const map = buildMap(sel) || buildMap([]);
  sel.sort((a, b) => a.p - b.p);
  for (const h of sel) {
    h.win = windowOf(h, map);
    h.s = h.kind === "gap" ? map.secOf(h.p0) : map.secOf(h.p);
  }
  return { sel, map };
}

const progressAt = (sec) => (sec < T0 ? -1 : sec >= T1 ? 1 : PLAN.map.pAt(sec));

// ------------------------------------------------------------------ state at a point of the replay

function stateAt(p) {
  const bots = BOTS.map((B) => {
    const n = upperBound(B.pClose, p);
    let wins = 0;
    for (let i = 0; i < n; i++) if (B.trades[i].pnl > 0) wins++;
    let open = 0;
    for (let i = 0; i < B.trades.length; i++) if (B.pOpen[i] <= p && B.pClose[i] > p) open++;
    const lines = upperBound(B.pAppear, p);
    return { n, wins, open, lines, pnl: n ? B.cum[n - 1] : 0, watched: B.watched === null ? null : Math.min(B.watched, lines * B.perLine) };
  });
  const m = upperBound(ALL.p, p);
  return { bots, total: m ? ALL.cum[m - 1] : 0, trades: m, wins: bots.reduce((s, b) => s + b.wins, 0) };
}

// ------------------------------------------------------------------ the scene: rings in 3D

function envelope(h, sec) {
  if (h.kind === "gap") return 0;
  return smooth((sec - (h.s - 0.3)) / 0.45) * (1 - smooth((sec - (h.s + 1.35)) / 0.55));
}

function baseCamera(sec) {
  return {
    theta: 0.82 + 0.3 * Math.sin(sec * 0.21),
    pitch: 0.2 + 0.06 * Math.sin(sec * 0.15 + 1),
    scale: BOTS.length === 1 ? 255 : 202,
    cx: W / 2,
    cy: 800,
    sec,
  };
}

function camera(sec) {
  const cam = baseCamera(sec);
  let zoom = 1;
  if (sec < T0) zoom = 0.7 + 0.3 * easeOut((sec - T_COLD) / (T0 - T_COLD));
  let sx = 0;
  let sy = 0;
  for (const h of PLAN.sel) {
    const e = envelope(h, sec);
    if (e <= 0) continue;
    const a = projectPoint(h.B, h.line, N >> 1, cam);
    zoom += 0.15 * e;
    sx += (a.x - cam.cx) * 0.28 * e;
    sy += (a.y - cam.cy) * 0.28 * e;
  }
  if (sec > T1) zoom *= 1 - 0.2 * smooth((sec - T1) / 1.2);
  cam.scale *= zoom;
  cam.cx -= sx;
  cam.cy -= sy;
  return cam;
}

// local torus point (axis z) -> screen, for ring B under camera cam
function makeProjector(B, cam) {
  const phi = cam.sec * B.spin;
  const cf = Math.cos(phi);
  const sf = Math.sin(phi);
  const ct = Math.cos(cam.theta);
  const st = Math.sin(cam.theta);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const Dz = 7;
  const mode = B.mode;
  return (x, y, z, out) => {
    const x1 = x * cf - y * sf;
    const y1 = x * sf + y * cf;
    let wx;
    let wy;
    let wz;
    if (mode === "top") {
      wx = x1;
      wy = y1 + 0.5;
      wz = z;
    } else if (mode === "bottom") {
      wx = z;
      wy = y1 - 0.5;
      wz = x1;
    } else {
      wx = x1;
      wy = y1;
      wz = z;
    }
    const X = wx * ct + wz * st;
    const Z = -wx * st + wz * ct;
    const Y2 = wy * cp - Z * sp;
    const Z2 = wy * sp + Z * cp;
    const k = (cam.scale * Dz) / (Dz - Z2);
    out[0] = cam.cx + X * k;
    out[1] = cam.cy - Y2 * k;
    out[2] = Z2;
    return out;
  };
}

const tmp = [0, 0, 0];
function projectPoint(B, line, j, cam) {
  const proj = makeProjector(B, cam);
  const o = (line * N + j) * 3;
  proj(B.geom[o], B.geom[o + 1], B.geom[o + 2], tmp);
  return { x: tmp[0], y: tmp[1] };
}

function strokeLine(c, s, i, from = 0, to = N) {
  const o = i * N * 2;
  c.moveTo(s[o + from * 2], s[o + from * 2 + 1]);
  for (let j = from + 1; j < to; j++) c.lineTo(s[o + j * 2], s[o + j * 2 + 1]);
}

const LINE_TINTS = [null, [90, 255, 215], [200, 160, 255]];

function drawRing(c, B, cam, sec, p, ignite) {
  const proj = makeProjector(B, cam);
  const look = B.look;
  c.save();
  c.globalCompositeOperation = "lighter";

  // scaffold: faint wireframe so the ring is there before its first line
  c.strokeStyle = rgba(look.color, 0.05 + 0.1 * ignite);
  c.lineWidth = 1;
  c.beginPath();
  for (let k = 0; k < 9; k++) {
    const v = (k / 9) * Math.PI * 2;
    for (let j = 0; j <= 96; j++) {
      const u = (j / 96) * Math.PI * 2;
      proj((1 + 0.42 * Math.cos(v)) * Math.cos(u), (1 + 0.42 * Math.cos(v)) * Math.sin(u), 0.42 * Math.sin(v), tmp);
      if (j === 0) c.moveTo(tmp[0], tmp[1]);
      else c.lineTo(tmp[0], tmp[1]);
    }
  }
  c.stroke();

  // dust
  for (const [u, v, r, ph] of B.dust) {
    const rr = 0.42 * r;
    proj((1 + rr * Math.cos(v)) * Math.cos(u), (1 + rr * Math.cos(v)) * Math.sin(u), rr * Math.sin(v), tmp);
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(sec * (1.3 + ph * 2) + ph * 10));
    c.fillStyle = rgba(look.color, (0.25 + 0.5 * ignite) * tw);
    c.fillRect(tmp[0] - 1.2, tmp[1] - 1.2, 2.4, 2.4);
  }

  const vis = upperBound(B.pAppear, p);
  const s = B.scr;
  const g = B.geom;
  for (let i = 0; i < vis; i++) {
    for (let j = 0; j < N; j++) {
      const o = (i * N + j) * 3;
      proj(g[o], g[o + 1], g[o + 2], tmp);
      s[(i * N + j) * 2] = tmp[0];
      s[(i * N + j) * 2 + 1] = tmp[1];
      if (j === N >> 1) B.depth[i] = tmp[2] < -0.45 ? 0 : tmp[2] < 0.45 ? 1 : 2;
    }
  }

  // Brightness follows how many lines show, so the ring stays see-through.
  const baseAlpha = clamp(0.95 / Math.sqrt(Math.max(1, vis)), 0.009, 0.24);
  const GROW = 0.5;
  const newFrom = upperBound(B.pAppear, p - GROW / R);
  const DEPTH = [0.5, 0.85, 1.25];
  c.lineWidth = 0.9;
  for (let gid = 0; gid < 9; gid++) {
    const tint = LINE_TINTS[Math.floor(gid / 3)] || look.base;
    for (let d = 0; d < 3; d++) {
      const a = baseAlpha * [0.7, 1.1, 1.6][gid % 3] * DEPTH[d];
      c.strokeStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`;
      c.beginPath();
      let n = 0;
      for (let i = 0; i < newFrom; i++) {
        if (B.group[i] !== gid || B.depth[i] !== d || B.tradeOfLine[i] >= 0) continue;
        strokeLine(c, s, i);
        if (++n % 70 === 0) {
          c.stroke();
          c.beginPath();
        }
      }
      if (n) c.stroke();
    }
  }
  for (let i = newFrom; i < vis; i++) {
    if (B.tradeOfLine[i] >= 0) continue;
    const age = (p - B.pAppear[i]) * R;
    c.strokeStyle = `rgba(225, 242, 255, ${0.35 * (1 - age / GROW) + baseAlpha})`;
    c.lineWidth = 1.1;
    c.beginPath();
    strokeLine(c, s, i, 0, Math.max(2, Math.floor(N * clamp(age / GROW, 0, 1))));
    c.stroke();
  }

  // trades: gold while held, then a flash and the win / loss colour
  const settled = { win: [], loss: [] };
  const fresh = [];
  for (let t = 0; t < B.trades.length; t++) {
    const line = B.trades[t].line;
    if (B.pOpen[t] > p || line >= vis) continue;
    if (B.pClose[t] > p) {
      fresh.push({ line, kind: "open" });
      continue;
    }
    const age = (p - B.pClose[t]) * R;
    const win = B.trades[t].pnl > 0;
    if (age < 0.9) fresh.push({ line, kind: win ? "win" : "loss", age });
    else settled[win ? "win" : "loss"].push(line);
  }
  // In a busy stretch dozens of trades close each second: only the newest few flash,
  // the rest settle straight away (otherwise the ring turns into a white blob).
  const opens = fresh.filter((f) => f.kind === "open");
  const closes = fresh.filter((f) => f.kind !== "open").sort((a, b) => a.age - b.age);
  for (const f of closes.slice(6)) settled[f.kind].push(f.line);
  fresh.length = 0;
  fresh.push(...opens.slice(0, 6), ...closes.slice(0, 6));
  const nSettled = settled.win.length + settled.loss.length;
  const tradeAlpha = clamp(2.6 / Math.sqrt(Math.max(1, nSettled)), 0.07, 0.5);
  for (const kind of ["win", "loss"]) {
    c.strokeStyle = rgba(look[kind], tradeAlpha * (kind === "loss" ? 0.9 : 1));
    c.lineWidth = 1.05;
    c.beginPath();
    settled[kind].forEach((line, k) => {
      strokeLine(c, s, line);
      if ((k + 1) % 60 === 0) {
        c.stroke();
        c.beginPath();
      }
    });
    c.stroke();
  }
  for (const f of fresh) {
    const color = f.kind === "open" ? COL.gold : look[f.kind];
    const flash = f.kind === "open" ? 0.55 + 0.35 * Math.sin(sec * 9) : Math.exp(-f.age / 0.35);
    c.strokeStyle = rgba(color, 0.1 + 0.2 * flash);
    c.lineWidth = 5;
    c.beginPath();
    strokeLine(c, s, f.line);
    c.stroke();
    c.strokeStyle = f.kind === "open" ? rgba(color, 0.9) : `rgba(255,255,255,${clamp(0.3 + 0.7 * flash, 0, 1)})`;
    c.lineWidth = 1.2 + 1.2 * flash;
    c.beginPath();
    strokeLine(c, s, f.line);
    c.stroke();
    if (f.kind !== "open") {
      const j = Math.min(N - 1, Math.floor((f.age / 0.9) * N));
      const o = f.line * N * 2 + j * 2;
      const rg = c.createRadialGradient(s[o], s[o + 1], 0, s[o], s[o + 1], 20);
      rg.addColorStop(0, "rgba(255,255,255,0.95)");
      rg.addColorStop(0.3, rgba(color, 0.7));
      rg.addColorStop(1, rgba(color, 0));
      c.fillStyle = rg;
      c.fillRect(s[o] - 20, s[o + 1] - 20, 40, 40);
    }
  }
  c.restore();
}

function ringEdge(B, cam, side, nearY) {
  // the ring's outer edge towards one side of the screen, close to a given height
  const proj = makeProjector(B, cam);
  let best = null;
  for (let k = 0; k < 48; k++) {
    const u = (k / 48) * Math.PI * 2;
    proj(1.42 * Math.cos(u), 1.42 * Math.sin(u), 0, tmp);
    const score = (side === "right" ? tmp[0] : -tmp[0]) - Math.abs(tmp[1] - nearY) * 0.6;
    if (!best || score > best.score) best = { x: tmp[0], y: tmp[1], score };
  }
  return best;
}

function drawScene(sec, p, alpha) {
  const cam = camera(sec);
  if (alpha <= 0.002) return cam;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, W, H);
  const g = sctx.createRadialGradient(cam.cx, cam.cy, 20, cam.cx, cam.cy, 620);
  g.addColorStop(0, "rgba(60, 120, 220, 0.10)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, W, H);
  const ignite = sec < T0 ? smooth((sec - T_COLD) / 1.4) : 1;
  for (const B of BOTS) drawRing(sctx, B, cam, sec, p, ignite);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(sceneCv, 0, 0);
  // bloom: blurred copies added on top
  bctxA.clearRect(0, 0, bloomA.width, bloomA.height);
  bctxA.drawImage(sceneCv, 0, 0, bloomA.width, bloomA.height);
  bctxB.clearRect(0, 0, bloomB.width, bloomB.height);
  bctxB.drawImage(bloomA, 0, 0, bloomB.width, bloomB.height);
  ctx.globalCompositeOperation = "lighter";
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = 0.3 * alpha;
  ctx.drawImage(bloomA, 0, 0, W, H);
  ctx.globalAlpha = 0.22 * alpha;
  ctx.drawImage(bloomB, 0, 0, W, H);
  ctx.restore();
  return cam;
}

// ------------------------------------------------------------------ HUD

function emblem(c, x, y, r, alpha) {
  if (alpha <= 0.002) return;
  c.save();
  c.globalAlpha *= alpha;
  c.lineWidth = 3;
  c.strokeStyle = LOOK.bybit.color;
  c.beginPath();
  c.arc(x - r * 0.45, y, r, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = LOOK.pump.color;
  c.beginPath();
  c.arc(x + r * 0.45, y, r, 0, Math.PI * 2);
  c.stroke();
  c.restore();
}

function topBar(a, sec) {
  emblem(ctx, 62, 66, 17, a);
  txt(ctx, D.brand || "BUBAVERSE", 100, 75, { font: SANS, size: 30, weight: 700, spacing: 5, alpha: a });
  txt(ctx, "TRADE ENGINE // REAL RECORD", 102, 100, { size: 13, weight: 700, color: COL.dim, spacing: 2, alpha: a });
  if (Math.floor(sec * 2) % 2 === 0) {
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = COL.red;
    ctx.beginPath();
    ctx.arc(W - 252, 68, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  txt(ctx, "REC", W - 238, 75, { size: 18, weight: 700, color: COL.text, alpha: a });
  txt(ctx, "REAL MONEY", W - 40, 75, { size: 18, weight: 700, color: COL.gold, align: "right", alpha: a });
}

function chapterAt(ms) {
  const chs = D.story.chapters;
  for (let i = 0; i < chs.length; i++) if (ms >= chs[i].from - 1 && ms <= chs[i].to + 1) return { n: i + 1, ch: chs[i] };
  return null;
}

function dateBlock(a, p) {
  const ms = CLOCK.msOf(Math.max(0, p));
  txt(ctx, dateText(ms), 40, 196, { font: SANS, size: 74, weight: 700, alpha: a });
  const chap = chapterAt(ms);
  const color = chap && chap.ch.bots.length === 1 ? (LOOK[chap.ch.bots[0]] || LOOK.pump).color : COL.gold;
  txt(ctx, timeText(ms), W - 40, 196, { font: MONO, size: 44, weight: 700, color, align: "right", alpha: a });
  const label = chap ? `CHAPTER ${chap.n} · ${chap.ch.bots.map((k) => (LOOK[k] || LOOK.pump).name).join(" + ")}` : "INTERMISSION";
  txt(ctx, label, 42, 238, { font: SANS, size: 22, weight: 700, color: chap ? color : COL.mid, spacing: 3, alpha: a });
  const day = Math.floor((ms - CLOCK.start) / 86400000) + 1;
  const days = Math.max(1, Math.ceil(CLOCK.span / 86400000));
  txt(ctx, `DAY ${day} OF ${days}`, W - 40, 238, { size: 16, weight: 700, color: COL.mid, align: "right", alpha: a });
  scrubber(a, ms);
}

function scrubber(a, ms) {
  const x0 = 40;
  const w = W - 80;
  const y = 270;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(120,170,230,0.14)";
  ctx.fillRect(x0, y, w, 2);
  // where each bot was busy (real time)
  for (const B of BOTS) {
    const bw = w / B.hist.length;
    for (let i = 0; i < B.hist.length; i++) {
      if (!B.hist[i]) continue;
      const v = Math.sqrt(B.hist[i] / B.histMax);
      ctx.fillStyle = rgba(B.look.color, 0.3 + 0.6 * v);
      ctx.fillRect(x0 + i * bw, y - 2 - v * 12, Math.max(2, bw), 2 + v * 12);
    }
  }
  // month ticks
  const d0 = new Date(CLOCK.start);
  let m = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
  while (m.getTime() < CLOCK.end) {
    const mx = x0 + ((m.getTime() - CLOCK.start) / CLOCK.span) * w;
    ctx.fillStyle = "rgba(160,190,230,0.35)";
    ctx.fillRect(mx, y + 4, 1, 7);
    txt(ctx, MONTHS[m.getMonth()], mx + 4, y + 22, { size: 12, weight: 700, color: COL.dim });
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  const px = x0 + clamp((ms - CLOCK.start) / CLOCK.span, 0, 1) * w;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = 12;
  ctx.fillRect(px - 1.5, y - 18, 3, 28);
  ctx.restore();
}

function ringTags(a, st, cam) {
  BOTS.forEach((B, k) => {
    const s = st.bots[k];
    const right = B.mode !== "bottom";
    const tw = 330;
    const th = 108;
    const tx = right ? W - 40 - tw : 40;
    const ty = B.mode === "bottom" ? 1150 : 312;
    const edge = ringEdge(B, cam, right ? "right" : "left", B.mode === "bottom" ? 1100 : 480);
    ctx.save();
    ctx.globalAlpha = a * 0.8;
    ctx.strokeStyle = rgba(B.look.color, 0.6);
    ctx.lineWidth = 1.2;
    const lx = right ? tx + tw - 40 : tx + 40;
    const ly = B.mode === "bottom" ? ty : ty + th;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(lx, ly + (B.mode === "bottom" ? -18 : 18));
    ctx.lineTo(edge.x, edge.y);
    ctx.stroke();
    ctx.fillStyle = B.look.color;
    ctx.beginPath();
    ctx.arc(edge.x, edge.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    glass(ctx, tx, ty, tw, th, a, B.look.color, 0.82);
    txt(ctx, B.look.name, tx + 16, ty + 30, { font: SANS, size: 21, weight: 700, color: B.look.color, spacing: 2, alpha: a });
    const live = B.status === "LIVE";
    txt(ctx, live ? "● LIVE" : "■ STOPPED", tx + tw - 14, ty + 30, { size: 13, weight: 700, color: live ? COL.green : COL.mid, align: "right", alpha: a });
    const pnlText = B.unit === "SOL" ? `${signed(s.pnl, 4)} SOL` : usd(s.pnl);
    txt(ctx, pnlText, tx + 16, ty + 68, { font: SANS, size: 30, weight: 700, color: s.pnl > 0 ? COL.green : s.pnl < 0 ? COL.red : COL.text, alpha: a });
    const parts = [`${num(s.n)} trades`];
    if (s.n) parts.push(`${Math.round((s.wins / s.n) * 100)}% win`);
    if (B.key === "pump" && s.watched !== null) parts.push(`${num(s.watched)} coins seen`);
    txt(ctx, parts.join(" · "), tx + 16, ty + 94, { size: 13, weight: 700, color: COL.mid, alpha: a });
  });
}

function totalBlock(a, st) {
  const y = 1276;
  const priced = D.story.priced;
  txt(ctx, priced ? "TOTAL P&L · BOTH BOTS · USD" : "P&L", 40, y + 20, { size: 15, weight: 700, color: COL.dim, spacing: 2, alpha: a });
  if (priced) {
    const v = st.total;
    txt(ctx, usd(v), 36, y + 112, { font: SANS, size: 92, weight: 700, color: v > 0 ? COL.green : v < 0 ? COL.red : COL.text, alpha: a, glow: 18 });
  } else {
    const parts = BOTS.map((B, k) => (B.unit === "SOL" ? `${signed(st.bots[k].pnl, 4)} SOL` : usd(st.bots[k].pnl)));
    txt(ctx, parts.join("  "), 40, y + 100, { font: SANS, size: 52, weight: 700, alpha: a });
  }
  txt(ctx, "TRADES", W - 40, y + 20, { size: 15, weight: 700, color: COL.dim, align: "right", spacing: 2, alpha: a });
  txt(ctx, num(st.trades), W - 40, y + 66, { font: SANS, size: 44, weight: 700, align: "right", alpha: a });
  txt(ctx, "WIN RATE", W - 40, y + 94, { size: 15, weight: 700, color: COL.dim, align: "right", spacing: 2, alpha: a });
  txt(ctx, st.trades ? `${((st.wins / st.trades) * 100).toFixed(1)}%` : "—", W - 40, y + 136, { font: SANS, size: 40, weight: 700, align: "right", alpha: a });
}

function chart(a, p) {
  const x = 40;
  const y = 1436;
  const w = W - 80;
  const h = 196;
  glass(ctx, x - 8, y - 8, w + 16, h + 34, a);
  ctx.save();
  ctx.globalAlpha = a;
  for (const g of D.story.gaps) {
    const a0 = CLOCK.pOf(g.from);
    const a1 = CLOCK.pOf(g.to);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(x + a0 * w, y, Math.max(2, (a1 - a0) * w), h);
    txt(ctx, `${g.days} DAYS OFF`, x + ((a0 + a1) / 2) * w, y + h - 8, { size: 11, weight: 700, color: COL.dim, align: "center" });
  }
  const priced = D.story.priced;
  const series = priced
    ? [{ p: ALL.p, v: ALL.cum, min: ALL.min, max: ALL.max, color: "#ffffff", who: ALL.map((x2) => x2.B) }]
    : BOTS.map((B) => ({ p: B.pClose, v: B.cum, min: B.cumMin, max: B.cumMax, color: B.look.color, who: null }));
  for (const sr of series) {
    const span = Math.max(1e-12, sr.max - sr.min);
    const yOf = (v) => y + 26 + (h - 44) * (1 - (v - sr.min) / span);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(160,190,230,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(0));
    ctx.lineTo(x + w, yOf(0));
    ctx.stroke();
    ctx.setLineDash([]);
    const n = upperBound(sr.p, p);
    if (!n) continue;
    ctx.beginPath();
    ctx.moveTo(x, yOf(0));
    for (let i = 0; i < n; i++) ctx.lineTo(x + sr.p[i] * w, yOf(sr.v[i]));
    ctx.lineTo(x + p * w, yOf(sr.v[n - 1]));
    ctx.lineTo(x + p * w, yOf(0));
    ctx.closePath();
    const gr = ctx.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, rgba(sr.color, 0.16));
    gr.addColorStop(1, rgba(sr.color, 0.01));
    ctx.fillStyle = gr;
    ctx.fill();
    // the line, coloured by which bot moved it
    ctx.lineWidth = 2.4;
    let px = x;
    let py = yOf(0);
    for (let i = 0; i < n; i++) {
      const nx = x + sr.p[i] * w;
      const ny = yOf(sr.v[i]);
      ctx.strokeStyle = sr.who ? sr.who[i].look.color : sr.color;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      px = nx;
      py = ny;
    }
    ctx.strokeStyle = sr.who ? sr.who[n - 1].look.color : sr.color;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x + p * w, py);
    ctx.stroke();
    const last = sr.v[n - 1];
    const rg = ctx.createRadialGradient(x + p * w, py, 0, x + p * w, py, 16);
    rg.addColorStop(0, "rgba(255,255,255,1)");
    rg.addColorStop(0.35, rgba(last >= 0 ? COL.green : COL.red, 0.8));
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(x + p * w - 16, py - 16, 32, 32);
    txt(ctx, usd(sr.max), x + w - 6, yOf(sr.max) - 4, { size: 11, color: COL.dim, align: "right" });
    txt(ctx, usd(sr.min), x + w - 6, yOf(sr.min) + 14, { size: 11, color: COL.dim, align: "right" });
  }
  // highlight markers along the bottom
  for (const hl of PLAN.sel) {
    if (hl.kind === "gap" || hl.p > p) continue;
    ctx.fillStyle = hl.B.look.color;
    const mx = x + hl.p * w;
    ctx.beginPath();
    ctx.moveTo(mx, y + h + 4);
    ctx.lineTo(mx + 5, y + h + 10);
    ctx.lineTo(mx, y + h + 16);
    ctx.lineTo(mx - 5, y + h + 10);
    ctx.fill();
  }
  ctx.restore();
  txt(ctx, priced ? "CUMULATIVE P&L (USD)" : "CUMULATIVE P&L", x + 8, y + 16, { size: 12, weight: 700, color: COL.dim, spacing: 2, alpha: a });
}

function ticker(a, p) {
  const n = upperBound(EVENTS.p, p);
  const y0 = 1700;
  for (let k = 0; k < 4; k++) {
    const idx = n - 1 - k;
    if (idx < 0) break;
    const e = EVENTS[idx];
    const y = y0 + k * 40;
    const fade = a * (1 - k * 0.2);
    const age = (p - e.p) * R;
    if (k === 0 && age < 0.5) {
      ctx.save();
      ctx.globalAlpha = a * 0.18 * (1 - age / 0.5);
      ctx.fillStyle = e.kind === "fail" ? COL.mid : e.t.pnl > 0 ? COL.green : COL.red;
      ctx.fillRect(32, y - 27, W - 64, 36);
      ctx.restore();
    }
    txt(ctx, e.B.look.short, 40, y, { size: 16, weight: 700, color: e.B.look.color, alpha: fade });
    if (e.kind === "fail") {
      txt(ctx, shortStamp(e.f.t), 124, y, { size: 16, color: COL.dim, alpha: fade });
      txt(ctx, `${e.f.label} · buy did not fill`, 306, y, { size: 16, weight: 700, color: COL.mid, alpha: fade });
      txt(ctx, e.f.feesSol ? `fee ${num(e.f.feesSol, 6)} SOL` : "no cost", W - 40, y, { size: 16, weight: 700, color: COL.mid, align: "right", alpha: fade });
      continue;
    }
    const t = e.t;
    txt(ctx, shortStamp(t.close), 124, y, { size: 16, color: COL.dim, alpha: fade });
    const what = e.B.key === "bybit" ? `${t.label} ${t.side}${t.why ? ` · ${t.why}` : ""}` : `${t.label}${t.pct !== null ? ` ${signed(t.pct, 0)}%` : ""} · ${t.why}`;
    txt(ctx, what, 306, y, { size: 16, weight: 700, color: COL.text, alpha: fade });
    const amount = e.B.unit === "SOL" ? `${signed(t.pnl, 4)} SOL` : usd(t.pnl);
    txt(ctx, amount, W - 40, y, { size: 16, weight: 700, color: t.pnl > 0 ? COL.green : COL.red, align: "right", alpha: fade });
  }
}

function footer(a) {
  const src = D.demo ? "PREVIEW · SAMPLE NUMBERS · NOT REAL TRADES" : `real records: pump.fun trade logs + Bybit closed P&L · made ${dateText(D.generatedAt)}`;
  txt(ctx, src, W / 2, 1886, { size: 13, weight: 700, color: D.demo ? LOOK.bybit.color : COL.dim, align: "center", alpha: a });
}

// ------------------------------------------------------------------ highlight cards

function cards(sec, cam) {
  for (const h of PLAN.sel) {
    if (h.kind === "gap") continue;
    const [a0, a1] = h.win;
    if (sec < a0 || sec > a1) continue;
    const inA = easeOut((sec - a0) / 0.3);
    const a = inA * (1 - smooth((sec - (a1 - 0.35)) / 0.35));
    const anchor = projectPoint(h.B, h.line, N >> 1, cam);
    const cw = 430;
    const chh = 156;
    const left = anchor.x > W / 2;
    const cx = left ? 40 : W - 40 - cw;
    const cy = clamp(anchor.y - chh / 2, 430, 1060);
    const color = h.kind === "best" || h.kind === "streak" ? COL.green : h.kind === "worst" ? COL.red : h.kind === "stop" ? COL.mid : h.B.look.color;
    ctx.save();
    ctx.globalAlpha = a;
    const sx = left ? cx + cw : cx;
    const sy = cy + chh / 2;
    const k = easeOut((sec - a0) / 0.4);
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (anchor.x - sx) * k, sy + (anchor.y - sy) * k);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 6 + 3 * Math.sin(sec * 8), 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
    const slide = (1 - inA) * (left ? -30 : 30);
    glass(ctx, cx + slide, cy, cw, chh, a, color, 0.9);
    const tag = h.kind === "start" ? `CHAPTER ${h.chapter}` : h.kind === "stop" ? "END OF THE RUN" : "HIGHLIGHT";
    txt(ctx, tag, cx + slide + 20, cy + 30, { size: 13, weight: 700, color: COL.dim, spacing: 2, alpha: a });
    txt(ctx, h.title, cx + slide + 20, cy + 60, { font: SANS, size: 24, weight: 700, color, spacing: 1, alpha: a });
    txt(ctx, h.value, cx + slide + 20, cy + 110, { font: SANS, size: 42, weight: 700, color: COL.text, alpha: a, glow: 10 });
    txt(ctx, h.sub, cx + slide + 20, cy + 140, { size: 15, weight: 700, color: COL.mid, alpha: a });
  }
}

// Three beats: the chapter that ended (and how) -> the pause -> the chapter that starts.
function intermission(sec) {
  for (const h of PLAN.sel) {
    if (h.kind !== "gap") continue;
    const [a0, a1] = h.win;
    if (sec < a0 || sec > a1) continue;
    const f = (sec - a0) / (a1 - a0);
    const a = smooth((sec - a0) / 0.3) * (1 - smooth((sec - (a1 - 0.35)) / 0.35));
    ctx.save();
    ctx.globalAlpha = a * 0.66;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 300, W, 940);
    ctx.restore();
    const chs = D.story.chapters;
    const before = chs.findIndex((c) => Math.abs(c.to - h.gap.from) < 2);
    const after = chs.findIndex((c) => Math.abs(c.from - h.gap.to) < 2);
    const names = (c) => c.bots.map((k) => (LOOK[k] || LOOK.pump).name).join(" + ");
    const colorOf = (c) => (c.bots.length === 1 ? (LOOK[c.bots[0]] || LOOK.pump).color : COL.gold);
    // beat 1: how the chapter ended
    const b1 = a * (1 - smooth((f - 0.3) / 0.08));
    if (before >= 0 && b1 > 0.002) {
      const c = chs[before];
      txt(ctx, `END OF CHAPTER ${before + 1}`, W / 2, 720, { font: SANS, size: 30, weight: 700, color: COL.mid, spacing: 6, align: "center", alpha: b1 });
      txt(ctx, names(c), W / 2, 800, { font: SANS, size: 64, weight: 700, color: colorOf(c), spacing: 6, align: "center", alpha: b1, glow: 18 });
      const stop = D.story.highlights.find((x) => x.kind === "stop" && Math.abs(x.t - h.gap.from) < 1000);
      if (stop) txt(ctx, `${stop.title.replace(/ BOT STOPPED$/, "")} STOPPED · ${stop.value} · ${stop.sub}`, W / 2, 860, { size: 22, weight: 700, color: COL.text, align: "center", alpha: b1 });
    }
    // beat 2: the pause
    const b2 = a * smooth((f - 0.3) / 0.08) * (1 - smooth((f - 0.68) / 0.08));
    if (b2 > 0.002) {
      txt(ctx, "INTERMISSION", W / 2, 760, { font: SANS, size: 76, weight: 700, spacing: 12, align: "center", alpha: b2, glow: 20 });
      txt(ctx, `${h.value} WITHOUT TRADING`, W / 2, 830, { font: SANS, size: 30, weight: 700, color: COL.gold, spacing: 4, align: "center", alpha: b2 });
      txt(ctx, `${dateText(h.gap.from)}  →  ${dateText(h.gap.to)}`, W / 2, 880, { size: 20, weight: 700, color: COL.mid, align: "center", alpha: b2 });
    }
    // beat 3: what comes next
    const b3 = a * smooth((f - 0.68) / 0.08);
    if (after >= 0 && b3 > 0.002) {
      const c = chs[after];
      txt(ctx, `CHAPTER ${after + 1}`, W / 2, 720, { font: SANS, size: 30, weight: 700, color: COL.mid, spacing: 6, align: "center", alpha: b3 });
      txt(ctx, names(c), W / 2, 800, { font: SANS, size: 64, weight: 700, color: colorOf(c), spacing: 6, align: "center", alpha: b3, glow: 18 });
      txt(ctx, `from ${dateText(c.from)}`, W / 2, 860, { size: 22, weight: 700, color: COL.text, align: "center", alpha: b3 });
    }
  }
}

// ------------------------------------------------------------------ acts

function coldOpen(sec) {
  const lines = [
    [BOTS.length === 2 ? "TWO BOTS." : "ONE BOT.", 0.15, 64],
    ["REAL MONEY.", 0.7, 64],
    ["EVERY TRADE, AS IT HAPPENED.", 1.2, 36],
  ];
  const fade = 1 - smooth((sec - 1.95) / 0.25);
  lines.forEach(([s, at, size], i) => {
    const n = Math.floor(clamp((sec - at) * 34, 0, s.length));
    if (!n) return;
    const shown = s.slice(0, n) + (n < s.length && Math.floor(sec * 8) % 2 ? "▌" : "");
    txt(ctx, shown, W / 2, 860 + i * 84, { font: SANS, size, weight: 700, spacing: size > 40 ? 8 : 4, align: "center", alpha: fade, color: i === 2 ? COL.gold : COL.text, glow: 14 });
  });
}

function titleCard(sec) {
  const a = smooth((sec - 2.3) / 0.5) * (1 - smooth((sec - 4.45) / 0.5));
  if (a <= 0.002) return;
  const tr = D.story.totals;
  const trades = tr.reduce((s, t) => s + t.trades, 0);
  const watched = tr.reduce((s, t) => s + (t.watched || 0), 0);
  txt(ctx, D.brand || "BUBAVERSE", W / 2, 820, { font: SANS, size: 112, weight: 700, spacing: 14, align: "center", alpha: a, glow: 30 });
  txt(ctx, BOTS.length === 2 ? "TWO BOTS · ONE STORY" : `${BOTS[0].look.name} · THE STORY`, W / 2, 884, { font: SANS, size: 30, weight: 700, color: COL.gold, spacing: 7, align: "center", alpha: a });
  const meta = `${dateText(CLOCK.start)} — ${dateText(CLOCK.end)}  ·  ${num(trades)} TRADES${watched ? `  ·  ${num(watched)} COINS WATCHED` : ""}`;
  txt(ctx, meta, W / 2, 936, { size: 19, weight: 700, color: COL.mid, align: "center", alpha: a });
}

function finale(sec) {
  const t = sec - T1;
  if (t <= 0) return;
  const tr = D.story.totals;
  const x0 = 56;
  const w = W - 112;
  const y0 = 250;
  const hh = 1440;
  const slide = (1 - easeOut((t - 0.35) / 0.8)) * 70;
  glass(ctx, x0, y0 + slide, w, hh, smooth((t - 0.35) / 0.6), COL.gold, 0.9);
  const y = y0 + slide;
  const rv = (k) => smooth((t - 0.7 - k * 0.07) / 0.35);
  txt(ctx, "THE RECORD", W / 2, y + 82, { font: SANS, size: 34, weight: 700, color: COL.gold, spacing: 10, align: "center", alpha: rv(0) });
  const days = Math.max(1, Math.ceil(CLOCK.span / 86400000));
  txt(ctx, `${dateText(CLOCK.start)}  →  ${dateText(CLOCK.end)}  ·  ${days} DAYS`, W / 2, y + 122, { size: 19, weight: 700, color: COL.mid, align: "center", alpha: rv(1) });
  const priced = D.story.priced;
  const totalUsd = tr.reduce((s, b) => s + (b.usd || 0), 0);
  const count = easeOut((t - 0.8) / 1.3);
  if (priced) {
    txt(ctx, "TOTAL P&L · BOTH BOTS", W / 2, y + 196, { size: 17, weight: 700, color: COL.dim, spacing: 3, align: "center", alpha: rv(2) });
    txt(ctx, usd(totalUsd * count), W / 2, y + 318, { font: SANS, size: 128, weight: 700, color: totalUsd > 0 ? COL.green : totalUsd < 0 ? COL.red : COL.text, align: "center", alpha: rv(2), glow: 26 });
    if (tr.some((b) => b.unit === "SOL")) txt(ctx, "pump.fun counted in USD at each day's SOL price", W / 2, y + 356, { size: 15, color: COL.dim, align: "center", alpha: rv(3) });
  } else {
    txt(ctx, "TOTAL P&L", W / 2, y + 196, { size: 17, weight: 700, color: COL.dim, spacing: 3, align: "center", alpha: rv(2) });
    const parts = tr.map((b) => (b.unit === "SOL" ? `${signed(b.pnl, 4)} SOL` : usd(b.pnl)));
    txt(ctx, parts.join("   "), W / 2, y + 300, { font: SANS, size: 64, weight: 700, align: "center", alpha: rv(2) });
  }
  ctx.save();
  ctx.globalAlpha = rv(3);
  ctx.fillStyle = "rgba(160,190,230,0.2)";
  ctx.fillRect(x0 + 40, y + 392, w - 80, 1);
  ctx.restore();

  const cols = tr.length;
  const cw = (w - 80 - (cols - 1) * 44) / cols;
  // Bybit came first, so it reads first (left)
  const ordered = [...tr].sort((a, b) => (a.first || 0) - (b.first || 0));
  ordered.forEach((b, i) => {
    const look = LOOK[b.key] || LOOK.pump;
    const cx = x0 + 40 + i * (cw + 44);
    let cy = y + 450;
    let k = 4 + i;
    txt(ctx, look.name, cx, cy, { font: SANS, size: 30, weight: 700, color: look.color, spacing: 2, alpha: rv(k++) });
    cy += 54;
    const row = (label, value, color = COL.text) => {
      const al = rv(k++);
      txt(ctx, label, cx, cy, { size: 16, weight: 700, color: COL.dim, alpha: al });
      txt(ctx, value, cx + cw, cy, { size: 22, weight: 700, color, align: "right", alpha: al });
      cy += 44;
    };
    const bars = (title, steps, colorOf) => {
      cy += 10;
      const al = rv(k++);
      txt(ctx, title, cx, cy, { size: 14, weight: 700, color: COL.dim, spacing: 1, alpha: al });
      cy += 16;
      const top = Math.log10(Math.max(...steps.map((s2) => s2[1]), 1) + 1);
      for (const [name, n] of steps) {
        const bw = (cw - 190) * (Math.log10(n + 1) / top) * easeOut((t - 1.2) / 1);
        ctx.save();
        ctx.globalAlpha = al;
        ctx.fillStyle = rgba(colorOf(name), 0.78);
        ctx.fillRect(cx, cy + 6, Math.max(2, bw), 14);
        ctx.restore();
        txt(ctx, `${name} ${num(n)}`, cx + cw, cy + 19, { size: 15, weight: 700, color: COL.mid, align: "right", alpha: al });
        cy += 30;
      }
      cy += 26;
    };
    const money = (v) => (b.unit === "SOL" ? `${signed(v, 4)} SOL` : usd(v));
    row("NET P&L", money(b.pnl), b.pnl > 0 ? COL.green : b.pnl < 0 ? COL.red : COL.text);
    if (b.unit === "SOL" && b.usd !== null) row("IN DOLLARS", `≈ ${usd(b.usd)}`, COL.mid);
    row("TRADES", num(b.trades));
    row("WIN RATE", b.trades ? `${((b.wins / b.trades) * 100).toFixed(1)}%` : "—");
    if (b.fees > 0) row("FEES PAID", usd(b.fees), COL.gold);
    row("BEST TRADE", money(b.best), COL.green);
    row("WORST TRADE", money(b.worst), COL.red);
    if (b.key === "bybit") {
      row("SYMBOLS TRADED", num(b.symbols));
      if (b.logs) {
        if (b.logs.checks) row("MARKET CHECKS", num(b.logs.checks));
        if (b.logs.feeRejects) row("SKIPPED, FEES TOO HIGH", num(b.logs.feeRejects));
        const strat = Object.entries(b.logs.byStrategy || {}).sort((p1, p2) => p2[1] - p1[1]);
        if (strat.length) bars("ENTRIES BY STRATEGY", strat, () => look.color);
      }
    } else {
      // how picky the bot was: watched -> tried -> bought -> won
      const steps = [];
      if (b.watched) steps.push(["watched", b.watched]);
      steps.push(["tried to buy", b.attempts], ["bought", b.trades], ["won", b.wins]);
      bars("FROM COIN TO PROFIT", steps, (name) => (name === "won" ? COL.green : look.color));
      if (b.failedBuys) row("BUYS THAT DIDN'T FILL", num(b.failedBuys), COL.mid);
    }
  });
  const ta = smooth((t - 2.2) / 0.6);
  txt(ctx, "REAL MONEY · REAL TRADES · NOTHING STAGED", W / 2, y + hh - 70, { font: SANS, size: 24, weight: 700, spacing: 4, align: "center", alpha: ta });
  emblem(ctx, W / 2 - 92, y + hh - 32, 9, ta);
  txt(ctx, D.brand || "BUBAVERSE", W / 2 - 70, y + hh - 25, { font: SANS, size: 18, weight: 700, spacing: 4, color: COL.mid, alpha: ta });
}

// ------------------------------------------------------------------ film look

let GRAIN = null;
function makeGrain() {
  GRAIN = [];
  for (let k = 0; k < 4; k++) {
    const c = mk(256, 256);
    const g = c.getContext("2d");
    const img = g.createImageData(256, 256);
    let s = 1234 + k * 999;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const v = (s / 2147483648) * 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 14;
    }
    g.putImageData(img, 0, 0);
    GRAIN.push(ctx.createPattern(c, "repeat"));
  }
}

function filmLook(sec, frame) {
  const v = ctx.createRadialGradient(W / 2, H / 2, 420, W / 2, H / 2, 1250);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.fillStyle = GRAIN[frame % GRAIN.length];
  ctx.translate((frame * 37) % 256, (frame * 91) % 256);
  ctx.fillRect(-256, -256, W + 512, H + 512);
  ctx.restore();
  // letterbox: in for the opening and the record, out for the replay
  const lb = sec < T0 ? 150 * (1 - smooth((sec - 4.4) / 0.7)) : 96 * smooth((sec - T1) / 0.9);
  if (lb > 0.5) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, lb);
    ctx.fillRect(0, H - lb, W, lb);
  }
}

function background(sec) {
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);
  // two soft colour clouds, one per bot
  const a = ctx.createRadialGradient(200, 520, 0, 200, 520, 900);
  a.addColorStop(0, rgba(LOOK.bybit.color, 0.07));
  a.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, W, H);
  const b = ctx.createRadialGradient(880, 1150, 0, 880, 1150, 900);
  b.addColorStop(0, rgba(LOOK.pump.color, 0.07));
  b.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = b;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(90, 140, 200, 0.035)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const off = (sec * 6) % 60;
  for (let x = -60 + off; x <= W; x += 60) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = 0; y <= H; y += 60) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
}

function demoMark(sec) {
  ctx.save();
  ctx.translate(W / 2, 1000);
  ctx.rotate(-0.42);
  txt(ctx, "PREVIEW · SAMPLE DATA", 0, 0, { font: SANS, size: 70, weight: 700, color: LOOK.bybit.color, align: "center", alpha: 0.09 + 0.02 * Math.sin(sec * 3) });
  ctx.restore();
}

// ------------------------------------------------------------------ frame

function drawFrame(sec, frame = Math.round(sec * FPS)) {
  const p = progressAt(sec);
  background(sec);
  const sceneAlpha = sec < T_COLD ? 0 : sec < T0 ? smooth((sec - T_COLD) / 1.2) : 1 - 0.68 * smooth((sec - T1) / 0.9);
  const cam = drawScene(sec, p, sceneAlpha);
  if (sec < T_COLD + 0.1) coldOpen(sec);
  titleCard(sec);
  const hud = smooth((sec - 4.6) / 0.6) * (1 - smooth((sec - T1) / 0.6));
  if (hud > 0.002) {
    const st = stateAt(p);
    topBar(hud, sec);
    dateBlock(hud, p);
    ringTags(hud, st, cam);
    totalBlock(hud, st);
    chart(hud, Math.max(0, p));
    ticker(hud, p);
    footer(hud);
    cards(sec, cam);
    intermission(sec);
  }
  finale(sec);
  if (sec > T1) footer(smooth((sec - T1 - 2) / 0.6));
  if (D.demo) demoMark(sec);
  filmLook(sec, frame);
}

// ------------------------------------------------------------------ record / play

const yieldNow = () => new Promise((r) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});

async function pickCodec() {
  for (const codec of ["avc1.640034", "avc1.640033", "avc1.640032", "avc1.4d0034", "avc1.42e034", "avc1.640028"]) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 16e6, framerate: FPS, avc: { format: "avc" } });
      if (s.supported) return codec;
    } catch {
      /* try the next */
    }
  }
  return null;
}

async function record() {
  if (typeof VideoEncoder === "undefined" || typeof Mp4Muxer === "undefined") {
    throw new Error("this browser can't make videos — open the same link in Google Chrome");
  }
  const codec = await pickCodec();
  if (!codec) throw new Error("this browser has no H.264 video encoder — open the same link in Google Chrome");
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    fastStart: "in-memory",
  });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
  enc.configure({ codec, width: W, height: H, bitrate: 16e6, framerate: FPS, avc: { format: "avc" } });
  const frames = Math.round(FPS * DUR);
  const startedAt = performance.now();
  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    drawFrame(i / FPS, i);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: i % FPS === 0 });
    frame.close();
    while (enc.encodeQueueSize > 3) await yieldNow();
    if (i % 10 === 0) {
      const pct = (i / frames) * 100;
      statusEl.textContent = `making the film… ${pct.toFixed(0)}%  (keep this tab open)`;
      barEl.style.width = `${pct}%`;
      if (i % 60 === 0) fetch("/progress", { method: "POST", body: String(Math.round(pct)) }).catch(() => {});
      await yieldNow();
    }
  }
  await enc.flush();
  if (failure) throw failure;
  muxer.finalize();
  const buf = muxer.target.buffer;
  statusEl.textContent = "saving…";
  const res = await fetch("/upload", { method: "POST", body: buf });
  if (!res.ok) throw new Error(`could not save the video (${res.status})`);
  statusEl.textContent = `done in ${((performance.now() - startedAt) / 1000).toFixed(0)}s — saved. You can close this tab.`;
  barEl.style.width = "100%";
  window.__done = true;
}

async function main() {
  D = await (await fetch("/data.json")).json();
  try {
    await Promise.all(["700 20px 'Space Grotesk'", "500 20px 'Space Grotesk'", "400 20px 'JetBrains Mono'", "700 20px 'JetBrains Mono'"].map((f) => document.fonts.load(f)));
  } catch {
    /* system fonts then */
  }
  prep();
  makeGrain();
  const q = new URLSearchParams(location.search);
  if (q.has("t")) {
    drawFrame(Number(q.get("t")));
    statusEl.textContent = `frame at ${q.get("t")}s`;
    window.__plan = PLAN.sel.map((h) => ({ kind: h.kind, title: h.title, s: +h.s.toFixed(2), win: h.win.map((x) => +x.toFixed(2)) }));
    window.__ready = true;
    return;
  }
  if (q.has("record")) {
    try {
      await record();
    } catch (e) {
      statusEl.textContent = `✗ ${e.message}`;
      fetch("/failed", { method: "POST", body: e.message }).catch(() => {});
      window.__error = e.message;
    }
    return;
  }
  statusEl.textContent = "playing (preview) — the saved film is made with ?record=1";
  const t0 = performance.now();
  const tick = () => {
    drawFrame(((performance.now() - t0) / 1000) % DUR);
    requestAnimationFrame(tick);
  };
  tick();
}

main().catch((e) => {
  statusEl.textContent = `✗ ${e.message}`;
  window.__error = e.message;
});
