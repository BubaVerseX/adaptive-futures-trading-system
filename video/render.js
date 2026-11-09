"use strict";
/* global Mp4Muxer */
/*
 * The bot film: both bots' real records played back as one dashboard, frame by frame,
 * from /data.json. In record mode it encodes an MP4 in the browser and posts it to
 * make.cjs.
 *
 *   /?record=1   render every frame, encode, upload   (what make.cjs opens)
 *   /?t=12.5     draw one frame at 12.5 s             (stills / checks)
 *   /?play=1     play it live in the page
 *
 * Layout: header and clock on top; the two linked rings (one per bot) in the main
 * window with instrument panels down the right side; a P&L stream and three panels
 * along the bottom. Results are shown in percent only, never in dollars or SOL.
 * The replay runs from the first trade to today and slows down on real highlights.
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
  edge: "rgba(120, 180, 240, 0.20)",
  edgeHi: "rgba(150, 205, 255, 0.5)",
  green: "#3dff9a",
  red: "#ff4d6d",
  gold: "#ffd36a",
  orange: "#ff9b3d",
};
const LOOK = {
  bybit: { name: "BYBIT FUTURES", short: "BYBIT", color: "#ffad42", win: "#ffd76e", loss: "#ff4f4f", base: [255, 196, 120] },
  pump: { name: "PUMP.FUN", short: "PUMP", color: "#47e1ff", win: "#52ffc6", loss: "#ff4d8d", base: [150, 214, 255] },
};

// layout
const RING = { x: 28, y: 322, w: 686, h: 1008 };
const SIDE = { x: 728, w: 324 };
const RING_CX = RING.x + RING.w / 2;
const RING_CY = RING.y + RING.h / 2 + 6;

let DUR = 30;
const T0 = 1.0; // replay starts (after the dashboard fades in)
let T1 = 26; // replay ends, final result holds
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
const pct = (v, dec = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${sign(v)}${num(v, dec)}%`);
const pctPlain = (v, dec = 0) => (v === null || !Number.isFinite(v) ? "—" : `${num(v, dec)}%`);
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
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const signColor = (v) => (v > 0 ? COL.green : v < 0 ? COL.red : COL.text);

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

// panel: dark glass, hairline border, corner ticks, tiny caps title
function panel(x, y, w, h, title, alpha = 1, right = "", accent = null, fill = 0.66) {
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = `rgba(5, 10, 21, ${fill})`;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = accent ? rgba(accent, 0.5) : COL.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.strokeStyle = accent ? rgba(accent, 0.9) : COL.edgeHi;
  ctx.lineWidth = 2;
  const k = 8;
  ctx.beginPath();
  ctx.moveTo(x, y + k);
  ctx.lineTo(x, y);
  ctx.lineTo(x + k, y);
  ctx.moveTo(x + w - k, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w, y + h - k);
  ctx.stroke();
  ctx.restore();
  if (title) txt(ctx, title, x + 12, y + 20, { size: 11, weight: 700, color: COL.dim, spacing: 1.5, alpha });
  if (right) txt(ctx, right, x + w - 12, y + 20, { size: 11, weight: 700, color: COL.dim, align: "right", alpha });
}

// ------------------------------------------------------------------ data prep

let D;
let BOTS;
let CLOCK;
let ALL;
let PLAN;

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
    const i = upperBound(times, ms);
    const before = i > 0 ? cumW[i - 1] : 0;
    const t0 = i > 0 ? times[i - 1] : start;
    const frac = (ms - t0) / Math.max(1, times[i] - t0);
    const q = (before + (cumW[i] - before) * frac) / totalW;
    return LIN * ((ms - start) / span) + (1 - LIN) * q;
  };
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
  B.mode = count === 1 ? "solo" : bot.key === "bybit" ? "top" : "bottom";
  B.spin = bot.key === "bybit" ? 0.2 : -0.17;
  B.dust = [];
  for (let k = 0; k < 70; k++) {
    const s = index * 1000 + k;
    B.dust.push([hash(s, 11) * Math.PI * 2, hash(s, 12) * Math.PI * 2, 0.3 + 0.75 * hash(s, 13), hash(s, 14)]);
  }
  // P&L shape in units of this bot's average stake (no money shown, only the shape)
  const stake = B.trades.reduce((s, t) => s + (t.stake || 0), 0);
  const avgStake = B.trades.length && stake > 0 ? stake / B.trades.length : 1;
  let r = 0;
  B.shape = Float64Array.from(B.trades.map((t) => (r += t.pnl / avgStake)));
  // fine activity histogram over the replay
  B.act = new Float32Array(1200);
  for (const v of B.pClose) B.act[Math.min(1199, Math.floor(v * 1200))]++;
  return B;
}

function prep() {
  DUR = D.seconds || 30;
  T1 = DUR - 4;
  R = T1 - T0;
  CLOCK = buildClock();
  BOTS = D.bots.map((b, i) => prepBot(b, i, D.bots.length));
  ALL = [];
  BOTS.forEach((B) => B.trades.forEach((t, i) => ALL.push({ B, i, p: B.pClose[i], t })));
  ALL.sort((a, b) => a.p - b.p);
  ALL.p = Float64Array.from(ALL.map((x) => x.p));
  // P&L shape across both bots, each trade in units of its bot's average stake
  const avgStake = new Map(
    BOTS.map((B) => {
      const s = B.trades.reduce((sum, t) => sum + (t.stake || 0), 0);
      return [B, B.trades.length && s > 0 ? s / B.trades.length : 1];
    }),
  );
  let run = 0;
  ALL.shape = Float64Array.from(ALL.map((x) => (run += x.t.pnl / avgStake.get(x.B))));
  ALL.min = Math.min(0, ...ALL.shape);
  ALL.max = Math.max(0, ...ALL.shape);
  PLAN = planStory();
}

// ------------------------------------------------------------------ story plan: highlights + slow motion

const E_HL = 1.15; // extra seconds of slow motion per highlight
const E_GAP = 2.6; // seconds an intermission takes
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
  if (h.kind === "gap") return [map.secOf(h.p0) - 0.25, map.secOf(h.p1) + 0.4];
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
    let pnl = 0;
    let stake = 0;
    let best = null;
    let worst = null;
    let peak = 0;
    let exit = 0;
    let peakN = 0;
    const why = {};
    for (let i = 0; i < n; i++) {
      const t = B.trades[i];
      if (t.pnl > 0) wins++;
      pnl += t.pnl;
      stake += t.stake || 0;
      if (t.pct !== null) {
        best = best === null ? t.pct : Math.max(best, t.pct);
        worst = worst === null ? t.pct : Math.min(worst, t.pct);
      }
      if (t.peak !== null && t.peak !== undefined && t.pct !== null) {
        peak += t.peak;
        exit += t.pct;
        peakN++;
      }
      if (t.why) why[t.why] = (why[t.why] || 0) + 1;
      else if (B.key === "bybit") why["~" + t.side] = (why["~" + t.side] || 0) + 1;
    }
    const lines = upperBound(B.pAppear, p);
    return {
      n,
      wins,
      ret: stake > 0 ? (pnl / stake) * 100 : null,
      best,
      worst,
      avgPeak: peakN ? peak / peakN : null,
      avgExit: peakN ? exit / peakN : null,
      why,
      lines,
      watched: B.watched === null ? null : Math.min(B.watched, lines * B.perLine),
    };
  });
  const m = upperBound(ALL.p, p);
  let won = 0;
  let put = 0;
  let priced = true;
  for (let i = 0; i < m; i++) {
    const t = ALL[i].t;
    if (t.usdStake === null || t.usdStake === undefined) priced = false;
    won += t.usd || 0;
    put += t.usdStake || 0;
  }
  return {
    bots,
    m,
    trades: bots.reduce((s, b) => s + b.n, 0),
    wins: bots.reduce((s, b) => s + b.wins, 0),
    ret: priced && put > 0 && D.story.priced ? (won / put) * 100 : null,
  };
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
    scale: BOTS.length === 1 ? 210 : 168,
    cx: RING_CX,
    cy: RING_CY,
    sec,
  };
}

function camera(sec) {
  const cam = baseCamera(sec);
  let zoom = 0.86 + 0.14 * easeOut(sec / 1.2);
  let sx = 0;
  let sy = 0;
  for (const h of PLAN.sel) {
    const e = envelope(h, sec);
    if (e <= 0) continue;
    const a = projectPoint(h.B, h.line, N >> 1, cam);
    zoom += 0.14 * e;
    sx += (a.x - cam.cx) * 0.25 * e;
    sy += (a.y - cam.cy) * 0.25 * e;
  }
  cam.scale *= zoom;
  cam.cx -= sx;
  cam.cy -= sy;
  return cam;
}

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
      wy = y1 + 0.62;
      wz = z;
    } else if (mode === "bottom") {
      wx = z;
      wy = y1 - 0.62;
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
  c.strokeStyle = rgba(look.color, 0.04 + 0.08 * ignite);
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

  for (const [u, v, r, ph] of B.dust) {
    const rr = 0.42 * r;
    proj((1 + rr * Math.cos(v)) * Math.cos(u), (1 + rr * Math.cos(v)) * Math.sin(u), rr * Math.sin(v), tmp);
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(sec * (1.3 + ph * 2) + ph * 10));
    c.fillStyle = rgba(look.color, (0.2 + 0.45 * ignite) * tw);
    c.fillRect(tmp[0] - 1.1, tmp[1] - 1.1, 2.2, 2.2);
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
  // In a busy stretch dozens of trades close each second: only the newest few flash.
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
      const rg = c.createRadialGradient(s[o], s[o + 1], 0, s[o], s[o + 1], 18);
      rg.addColorStop(0, "rgba(255,255,255,0.95)");
      rg.addColorStop(0.3, rgba(color, 0.7));
      rg.addColorStop(1, rgba(color, 0));
      c.fillStyle = rg;
      c.fillRect(s[o] - 18, s[o + 1] - 18, 36, 36);
    }
  }
  c.restore();
}

function drawScene(sec, p, alpha) {
  const cam = camera(sec);
  if (alpha <= 0.002) return cam;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, W, H);
  sctx.save();
  sctx.beginPath();
  sctx.rect(RING.x + 1, RING.y + 1, RING.w - 2, RING.h - 2);
  sctx.clip();
  const g = sctx.createRadialGradient(cam.cx, cam.cy, 20, cam.cx, cam.cy, 520);
  g.addColorStop(0, "rgba(60, 120, 220, 0.10)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  sctx.fillStyle = g;
  sctx.fillRect(RING.x, RING.y, RING.w, RING.h);
  const ignite = smooth(sec / 1.2);
  for (const B of BOTS) drawRing(sctx, B, cam, sec, p, ignite);
  sctx.restore();
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(sceneCv, 0, 0);
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

// ------------------------------------------------------------------ header

function chapterAt(ms) {
  const chs = D.story.chapters;
  for (let i = 0; i < chs.length; i++) if (ms >= chs[i].from - 1 && ms <= chs[i].to + 1) return { n: i + 1, ch: chs[i] };
  return null;
}

function header(a, sec, p, final) {
  txt(ctx, `| ${D.brand || "BUBAVERSE"} LAB / TRADE ARCHITECTURE`, 28, 44, { size: 15, weight: 700, color: COL.mid, spacing: 1, alpha: a });
  if (final) txt(ctx, "■ FINAL", W - 28, 44, { size: 15, weight: 700, color: COL.gold, align: "right", alpha: a });
  else {
    txt(ctx, D.demo ? "REPLAY · SAMPLE DATA" : "REPLAY · REAL TRADES", W - 52, 44, { size: 15, weight: 700, color: COL.mid, align: "right", alpha: a });
    if (Math.floor(sec * 2) % 2 === 0) {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = COL.red;
      ctx.beginPath();
      ctx.arc(W - 36, 39, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  const title = BOTS.map((B) => `${B.look.name === "BYBIT FUTURES" ? "BYBIT" : B.look.name} BOT`).join("  +  ");
  txt(ctx, title, 28, 90, { font: SANS, size: 34, weight: 700, color: COL.orange, alpha: a });
  const days = Math.max(1, Math.ceil(CLOCK.span / 86400000));
  txt(ctx, `${days} DAYS  ·  ${BOTS.length} ENGINES  ·  ${D.demo ? "PREVIEW" : "NOTHING SIMULATED"}`, W - 28, 88, { size: 13, weight: 700, color: COL.dim, align: "right", alpha: a });
  chips(a, sec, p);
  dateBlock(a, p);
}

function chips(a, sec, p) {
  // real parts of the bots; a chip lights up when that part just did something
  const recent = (B, kind) => {
    const arr = kind === "open" ? B.pOpen : B.pClose;
    for (let i = 0; i < arr.length; i++) {
      const d = (p - arr[i]) * R;
      if (d >= 0 && d < 0.22 && (kind === "close" || B.trades[i].open)) return true;
    }
    return false;
  };
  const list = [];
  for (const B of BOTS) {
    if (B.key === "bybit") {
      list.push(["v5.closed-pnl", B, recent(B, "close")]);
      for (const name of ["supertrend", "pullback", "breakout"]) {
        let on = false;
        for (let i = 0; i < B.trades.length && !on; i++) {
          const d = (p - B.pClose[i]) * R;
          if (d >= 0 && d < 0.25 && B.trades[i].why === name) on = true;
        }
        list.push([name, B, on]);
      }
    } else {
      const n = upperBound(B.pAppear, p);
      const fresh = n > 0 && (p - B.pAppear[n - 1]) * R < 0.12;
      list.push(["feed.logs", B, fresh], ["tracker.curve", B, fresh], ["broker.buy", B, recent(B, "open")], ["broker.sell", B, recent(B, "close")]);
    }
  }
  let x = 28;
  const y = 106;
  ctx.font = `700 12px ${MONO}`;
  for (const [name, B, on] of list) {
    const tw = ctx.measureText(name).width + 18;
    if (x + tw > W - 28) break;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = on ? rgba(B.look.color, 0.24) : "rgba(16, 26, 44, 0.85)";
    ctx.fillRect(x, y, tw, 24);
    ctx.strokeStyle = on ? B.look.color : COL.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, 23);
    ctx.restore();
    txt(ctx, name, x + 9, y + 17, { size: 12, weight: 700, color: on ? COL.text : COL.dim, alpha: a });
    x += tw + 6;
  }
}

function dateBlock(a, p) {
  const ms = CLOCK.msOf(Math.max(0, p));
  txt(ctx, dateText(ms), 26, 208, { font: SANS, size: 60, weight: 700, alpha: a });
  const chap = chapterAt(ms);
  const color = chap && chap.ch.bots.length === 1 ? (LOOK[chap.ch.bots[0]] || LOOK.pump).color : COL.gold;
  txt(ctx, timeText(ms), W - 28, 208, { font: MONO, size: 38, weight: 700, color, align: "right", alpha: a });
  const label = chap ? `CHAPTER ${chap.n} · ${chap.ch.bots.map((k) => (LOOK[k] || LOOK.pump).name).join(" + ")}` : "PAUSE · NO TRADING";
  txt(ctx, label, 28, 246, { font: SANS, size: 19, weight: 700, color: chap ? color : COL.mid, spacing: 3, alpha: a });
  const day = Math.floor((ms - CLOCK.start) / 86400000) + 1;
  const days = Math.max(1, Math.ceil(CLOCK.span / 86400000));
  txt(ctx, `DAY ${day} / ${days}`, W - 28, 246, { size: 14, weight: 700, color: COL.mid, align: "right", alpha: a });
  // timeline: real calendar, where each bot was busy, the playhead
  const x0 = 28;
  const w = W - 56;
  const y = 282;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(120,170,230,0.14)";
  ctx.fillRect(x0, y, w, 2);
  for (const B of BOTS) {
    const bins = new Float32Array(200);
    for (const t of B.trades) bins[Math.min(199, Math.floor(((t.close - CLOCK.start) / CLOCK.span) * 200))]++;
    const max = Math.max(1, ...bins);
    for (let i = 0; i < 200; i++) {
      if (!bins[i]) continue;
      const v = Math.sqrt(bins[i] / max);
      ctx.fillStyle = rgba(B.look.color, 0.3 + 0.6 * v);
      ctx.fillRect(x0 + (i / 200) * w, y - v * 12, Math.max(2, w / 200), v * 12);
    }
  }
  const d0 = new Date(CLOCK.start);
  let m = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
  while (m.getTime() < CLOCK.end) {
    const mx = x0 + ((m.getTime() - CLOCK.start) / CLOCK.span) * w;
    ctx.fillStyle = "rgba(160,190,230,0.35)";
    ctx.fillRect(mx, y + 4, 1, 6);
    txt(ctx, MONTHS[m.getMonth()], mx + 4, y + 19, { size: 11, weight: 700, color: COL.dim });
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  const px = x0 + clamp((ms - CLOCK.start) / CLOCK.span, 0, 1) * w;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = 10;
  ctx.fillRect(px - 1.5, y - 16, 3, 26);
  ctx.restore();
}

// ------------------------------------------------------------------ main window (rings)

function ringFrame(a, sec, st, cam) {
  // frame + labels around the rings, like an instrument
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = COL.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(RING.x + 0.5, RING.y + 0.5, RING.w - 1, RING.h - 1);
  ctx.strokeStyle = COL.edgeHi;
  ctx.lineWidth = 2;
  const k = 14;
  const { x, y, w, h } = RING;
  ctx.beginPath();
  ctx.moveTo(x, y + k); ctx.lineTo(x, y); ctx.lineTo(x + k, y);
  ctx.moveTo(x + w - k, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + k);
  ctx.moveTo(x, y + h - k); ctx.lineTo(x, y + h); ctx.lineTo(x + k, y + h);
  ctx.moveTo(x + w - k, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - k);
  ctx.stroke();
  ctx.restore();
  const lines = st.bots.reduce((s, b) => s + b.lines, 0);
  txt(ctx, `CORE // ${BOTS.length} ENGINES · ${num(lines)} LINES`, RING.x + 14, RING.y + 24, { size: 12, weight: 700, color: COL.mid, spacing: 1, alpha: a });
  const deg = ((cam.theta * 180) / Math.PI).toFixed(1);
  txt(ctx, `orbit ${deg}° · tilt ${((cam.pitch * 180) / Math.PI).toFixed(1)}°`, RING.x + RING.w - 14, RING.y + 24, { size: 12, color: COL.dim, align: "right", alpha: a });
  // which ring is which
  BOTS.forEach((B) => {
    const top = B.mode !== "bottom";
    const tx = top ? RING.x + RING.w - 14 : RING.x + 14;
    const ty = top ? RING.y + 56 : RING.y + RING.h - 44;
    const live = B.status === "LIVE";
    txt(ctx, B.look.name, tx, ty, { font: SANS, size: 18, weight: 700, color: B.look.color, spacing: 2, align: top ? "right" : "left", alpha: a });
    txt(ctx, live ? "● LIVE" : "■ STOPPED", tx, ty + 18, { size: 11, weight: 700, color: live ? COL.green : COL.dim, align: top ? "right" : "left", alpha: a });
  });
  const legend = BOTS.length === 2 ? "1 line = 1 trade (bybit) · 1 coin watched (pump.fun)" : `1 line = 1 ${BOTS[0].lineWord}`;
  txt(ctx, legend, RING.x + RING.w - 14, RING.y + RING.h - 14, { size: 11, color: COL.dim, align: "right", alpha: a });
}

function cards(sec, cam) {
  for (const h of PLAN.sel) {
    if (h.kind === "gap") continue;
    const [a0, a1] = h.win;
    if (sec < a0 || sec > a1) continue;
    const inA = easeOut((sec - a0) / 0.3);
    const a = inA * (1 - smooth((sec - (a1 - 0.35)) / 0.35));
    const anchor = projectPoint(h.B, h.line, N >> 1, cam);
    const cw = 300;
    const chh = 128;
    const left = anchor.x > RING_CX;
    const cx = left ? RING.x + 16 : RING.x + RING.w - 16 - cw;
    const cy = clamp(anchor.y - chh / 2, RING.y + 70, RING.y + RING.h - chh - 60);
    const color = h.kind === "best" || h.kind === "streak" ? COL.green : h.kind === "worst" ? COL.red : h.kind === "stop" ? COL.mid : h.B.look.color;
    ctx.save();
    ctx.globalAlpha = a;
    const sx = left ? cx + cw : cx;
    const sy = cy + chh / 2;
    const k = easeOut((sec - a0) / 0.4);
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (anchor.x - sx) * k, sy + (anchor.y - sy) * k);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 5 + 3 * Math.sin(sec * 8), 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
    const slide = (1 - inA) * (left ? -24 : 24);
    panel(cx + slide, cy, cw, chh, h.kind === "start" ? `CHAPTER ${h.chapter}` : h.kind === "stop" ? "END OF RUN" : "HIGHLIGHT", a, "", color, 0.9);
    txt(ctx, h.title, cx + slide + 14, cy + 48, { font: SANS, size: 19, weight: 700, color, spacing: 1, alpha: a });
    txt(ctx, h.value, cx + slide + 14, cy + 90, { font: SANS, size: 34, weight: 700, color: COL.text, alpha: a });
    txt(ctx, h.sub, cx + slide + 14, cy + 114, { size: 13, weight: 700, color: COL.mid, alpha: a });
  }
}

// pause between chapters: how the chapter ended -> the pause -> the next chapter
function intermission(sec) {
  for (const h of PLAN.sel) {
    if (h.kind !== "gap") continue;
    const [a0, a1] = h.win;
    if (sec < a0 || sec > a1) continue;
    const f = (sec - a0) / (a1 - a0);
    const a = smooth((sec - a0) / 0.3) * (1 - smooth((sec - (a1 - 0.3)) / 0.3));
    const bw = 520;
    const bh = 170;
    const bx = RING_CX - bw / 2;
    const by = RING_CY - bh / 2;
    panel(bx, by, bw, bh, "", a, "", COL.gold, 0.9);
    const chs = D.story.chapters;
    const before = chs.findIndex((c) => Math.abs(c.to - h.gap.from) < 2);
    const after = chs.findIndex((c) => Math.abs(c.from - h.gap.to) < 2);
    const names = (c) => c.bots.map((k) => (LOOK[k] || LOOK.pump).name).join(" + ");
    const colorOf = (c) => (c.bots.length === 1 ? (LOOK[c.bots[0]] || LOOK.pump).color : COL.gold);
    const beat = (x, from, to) => a * smooth((x - from) / 0.06) * (1 - smooth((x - to) / 0.06));
    const b1 = before >= 0 ? beat(f, -1, 0.3) : 0;
    if (b1 > 0.002) {
      const c = chs[before];
      txt(ctx, `END OF CHAPTER ${before + 1}`, RING_CX, by + 46, { size: 13, weight: 700, color: COL.dim, spacing: 2, align: "center", alpha: b1 });
      txt(ctx, names(c), RING_CX, by + 98, { font: SANS, size: 40, weight: 700, color: colorOf(c), spacing: 3, align: "center", alpha: b1 });
      const stop = D.story.highlights.find((x) => x.kind === "stop" && Math.abs(x.t - h.gap.from) < 1000);
      if (stop) txt(ctx, `stopped · ${stop.value} · ${stop.sub}`, RING_CX, by + 136, { size: 14, weight: 700, color: COL.mid, align: "center", alpha: b1 });
    }
    const b2 = beat(f, 0.3, 0.68);
    if (b2 > 0.002) {
      txt(ctx, "PAUSE", RING_CX, by + 46, { size: 13, weight: 700, color: COL.dim, spacing: 2, align: "center", alpha: b2 });
      txt(ctx, `${h.value} WITHOUT TRADING`, RING_CX, by + 98, { font: SANS, size: 38, weight: 700, color: COL.gold, spacing: 2, align: "center", alpha: b2 });
      txt(ctx, `${dateText(h.gap.from)}  →  ${dateText(h.gap.to)}`, RING_CX, by + 136, { size: 14, weight: 700, color: COL.mid, align: "center", alpha: b2 });
    }
    const b3 = after >= 0 ? beat(f, 0.68, 2) : 0;
    if (b3 > 0.002) {
      const c = chs[after];
      txt(ctx, `CHAPTER ${after + 1}`, RING_CX, by + 46, { size: 13, weight: 700, color: COL.dim, spacing: 2, align: "center", alpha: b3 });
      txt(ctx, names(c), RING_CX, by + 98, { font: SANS, size: 40, weight: 700, color: colorOf(c), spacing: 3, align: "center", alpha: b3 });
      txt(ctx, `from ${dateText(c.from)}`, RING_CX, by + 136, { size: 14, weight: 700, color: COL.mid, align: "center", alpha: b3 });
    }
  }
}

// ------------------------------------------------------------------ side column

function side(a, st, p, sec) {
  const x = SIDE.x;
  const w = SIDE.w;
  let y = RING.y;
  const fade = (k) => a * smooth((sec - 0.15 - k * 0.08) / 0.5);

  // 1. activity
  let h = 140;
  let al = fade(0);
  panel(x, y, w, h, "ACTIVITY", al, "trades over time");
  {
    const bins = 46;
    const per = 5; // fine bins per bar
    const end = Math.floor(clamp(p, 0, 1) * 1200);
    const bw = (w - 24) / bins;
    const vals = [];
    let max = 1;
    for (let b = 0; b < bins; b++) {
      const hi = end - (bins - 1 - b) * per;
      const row = BOTS.map((B) => {
        let v = 0;
        for (let i = hi - per; i < hi; i++) if (i >= 0 && i < 1200) v += B.act[i];
        return v;
      });
      vals.push(row);
      max = Math.max(max, row.reduce((s, v) => s + v, 0));
    }
    ctx.save();
    ctx.globalAlpha = al;
    vals.forEach((row, b) => {
      let base = y + h - 12;
      row.forEach((v, k) => {
        const hh = (v / max) * (h - 44);
        ctx.fillStyle = rgba(BOTS[k].look.color, 0.35 + 0.5 * (b / bins));
        ctx.fillRect(x + 12 + b * bw, base - hh, Math.max(1, bw - 2), hh);
        base -= hh;
      });
    });
    ctx.restore();
  }
  y += h + 12;

  // 2. win rate
  h = 150;
  al = fade(1);
  panel(x, y, w, h, "WIN RATE", al);
  txt(ctx, st.trades ? pctPlain((st.wins / st.trades) * 100, 1) : "—", x + 12, y + 70, { font: SANS, size: 40, weight: 700, alpha: al });
  txt(ctx, `of ${num(st.trades)} trades`, x + w - 12, y + 68, { size: 12, weight: 700, color: COL.dim, align: "right", alpha: al });
  BOTS.forEach((B, k) => {
    const s = st.bots[k];
    const ry = y + 96 + k * 26;
    const v = s.n ? s.wins / s.n : 0;
    txt(ctx, B.look.short, x + 12, ry + 10, { size: 12, weight: 700, color: B.look.color, alpha: al });
    ctx.save();
    ctx.globalAlpha = al;
    ctx.fillStyle = "rgba(120,170,230,0.14)";
    ctx.fillRect(x + 70, ry, w - 150, 10);
    ctx.fillStyle = B.look.color;
    ctx.fillRect(x + 70, ry, (w - 150) * v, 10);
    ctx.restore();
    txt(ctx, s.n ? pctPlain(v * 100) : "—", x + w - 12, ry + 10, { size: 13, weight: 700, align: "right", alpha: al });
  });
  y += h + 12;

  // 3. return per trade
  h = 150;
  al = fade(2);
  panel(x, y, w, h, "RETURN / TRADE", al, "size-weighted");
  const big = st.ret !== null ? st.ret : BOTS.length === 1 ? st.bots[0].ret : null;
  txt(ctx, big === null ? "—" : pct(big, 2), x + 12, y + 70, { font: SANS, size: 40, weight: 700, color: big === null ? COL.dim : signColor(big), alpha: al });
  txt(ctx, st.ret !== null ? "both bots" : "", x + w - 12, y + 68, { size: 12, weight: 700, color: COL.dim, align: "right", alpha: al });
  const scale = Math.max(1, ...D.story.totals.map((t) => Math.abs(t.ret || 0))) * 1.25;
  BOTS.forEach((B, k) => {
    const s = st.bots[k];
    const ry = y + 96 + k * 26;
    txt(ctx, B.look.short, x + 12, ry + 10, { size: 12, weight: 700, color: B.look.color, alpha: al });
    const cx = x + 70 + (w - 150) / 2;
    ctx.save();
    ctx.globalAlpha = al;
    ctx.fillStyle = "rgba(120,170,230,0.14)";
    ctx.fillRect(x + 70, ry, w - 150, 10);
    ctx.fillStyle = "rgba(220,235,255,0.5)";
    ctx.fillRect(cx - 0.5, ry - 3, 1, 16);
    if (s.ret !== null) {
      const len = clamp(s.ret / scale, -1, 1) * ((w - 150) / 2);
      ctx.fillStyle = signColor(s.ret);
      ctx.fillRect(Math.min(cx, cx + len), ry, Math.abs(len), 10);
    }
    ctx.restore();
    txt(ctx, s.ret === null ? "—" : pct(s.ret, 2), x + w - 12, ry + 10, { size: 13, weight: 700, color: s.ret === null ? COL.dim : signColor(s.ret), align: "right", alpha: al });
  });
  y += h + 12;

  // 4. distribution of trade results
  h = 176;
  al = fade(3);
  panel(x, y, w, h, "TRADE RESULTS", al, "% per trade");
  {
    const edges = [-Infinity, -40, -25, -15, -8, -3, 0, 3, 8, 15, 25, 40, Infinity];
    const counts = new Array(edges.length - 1).fill(0);
    for (let i = 0; i < st.m; i++) {
      const v = ALL[i].t.pct;
      if (v === null) continue;
      let b = 0;
      while (b < counts.length - 1 && v >= edges[b + 1]) b++;
      counts[b]++;
    }
    const max = Math.max(1, ...counts);
    const bw = (w - 24) / counts.length;
    ctx.save();
    ctx.globalAlpha = al;
    counts.forEach((c, b) => {
      const hh = (c / max) * (h - 66);
      ctx.fillStyle = b < 6 ? rgba(COL.red, 0.8) : rgba(COL.green, 0.8);
      ctx.fillRect(x + 12 + b * bw + 1, y + h - 30 - hh, bw - 3, hh);
    });
    ctx.fillStyle = "rgba(220,235,255,0.5)";
    ctx.fillRect(x + 12 + 6 * bw - 1, y + 34, 1, h - 62);
    ctx.restore();
    txt(ctx, "−40%", x + 12, y + h - 12, { size: 11, color: COL.dim, alpha: al });
    txt(ctx, "0", x + 12 + 6 * bw, y + h - 12, { size: 11, color: COL.dim, align: "center", alpha: al });
    txt(ctx, "+40%", x + w - 12, y + h - 12, { size: 11, color: COL.dim, align: "right", alpha: al });
  }
  y += h + 12;

  // 5. how trades ended (for the bot trading right now)
  h = 176;
  al = fade(4);
  const lastBot = st.m ? ALL[st.m - 1].B : BOTS[0];
  const ls = st.bots[BOTS.indexOf(lastBot)];
  // Bybit: which strategy opened the trades (from the bot's logs); without logs, long vs short
  const tagged = Object.entries(ls.why).filter(([k]) => !k.startsWith("~"));
  const useTags = lastBot.key !== "bybit" || tagged.length > 0;
  const title = lastBot.key === "bybit" ? (useTags ? "BYBIT · STRATEGY" : "BYBIT · DIRECTION") : "PUMP.FUN · HOW IT ENDED";
  const taggedN = tagged.reduce((s2, x2) => s2 + x2[1], 0);
  panel(x, y, w, h, title, al, lastBot.key === "bybit" && useTags && taggedN < ls.n ? `${pctPlain((taggedN / Math.max(1, ls.n)) * 100)} tagged` : "");
  {
    const source = useTags ? tagged : Object.entries(ls.why).map(([k, v]) => [k.slice(1), v]);
    const rows = source.sort((a2, b2) => b2[1] - a2[1]).slice(0, 5);
    const total = Math.max(1, rows.reduce((s2, x2) => s2 + x2[1], 0));
    rows.forEach(([name, n], k) => {
      const ry = y + 40 + k * 26;
      txt(ctx, name.toLowerCase(), x + 12, ry + 10, { size: 12, weight: 700, color: COL.mid, alpha: al });
      ctx.save();
      ctx.globalAlpha = al;
      ctx.fillStyle = "rgba(120,170,230,0.12)";
      ctx.fillRect(x + 140, ry, w - 200, 10);
      ctx.fillStyle = lastBot.look.color;
      ctx.fillRect(x + 140, ry, (w - 200) * (n / total), 10);
      ctx.restore();
      txt(ctx, pctPlain((n / total) * 100), x + w - 12, ry + 10, { size: 12, weight: 700, align: "right", alpha: al });
    });
    if (!rows.length) txt(ctx, "waiting for the first trade", x + 12, y + 60, { size: 12, color: COL.dim, alpha: al });
  }
  y += h + 12;

  // 6. live feed: the latest trades, percent only
  h = RING.y + RING.h - y;
  al = fade(5);
  panel(x, y, w, h, "LIVE FEED", al);
  const rows = Math.floor((h - 34) / 27);
  for (let k = 0; k < rows; k++) {
    const i = st.m - 1 - k;
    if (i < 0) break;
    const e = ALL[i];
    const ry = y + 50 + k * 27;
    const age = (p - e.p) * R;
    if (k === 0 && age < 0.5) {
      ctx.save();
      ctx.globalAlpha = al * 0.2 * (1 - age / 0.5);
      ctx.fillStyle = e.t.pnl > 0 ? COL.green : COL.red;
      ctx.fillRect(x + 4, ry - 17, w - 8, 24);
      ctx.restore();
    }
    const fa = al * (1 - k * 0.14);
    txt(ctx, e.B.look.short, x + 12, ry, { size: 12, weight: 700, color: e.B.look.color, alpha: fa });
    const label = e.B.key === "bybit" ? `${e.t.label.replace(/USDT$/, "")} ${e.t.side}` : e.t.label;
    txt(ctx, label.slice(0, 16), x + 66, ry, { size: 13, weight: 700, alpha: fa });
    txt(ctx, pct(e.t.pct), x + w - 12, ry, { size: 13, weight: 700, color: signColor(e.t.pnl), align: "right", alpha: fa });
  }
}

// ------------------------------------------------------------------ bottom

function stream(a, p) {
  const x = 28;
  const y = 1342;
  const w = W - 56;
  const h = 70;
  panel(x, y, w, h, "P&L STREAM", a, "shape only · both bots");
  const span = Math.max(1e-9, ALL.max - ALL.min);
  const yOf = (v) => y + h - 8 - ((v - ALL.min) / span) * (h - 38);
  ctx.save();
  ctx.globalAlpha = a;
  for (const g of D.story.gaps) {
    const a0 = CLOCK.pOf(g.from);
    const a1 = CLOCK.pOf(g.to);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(x + a0 * w, y + 24, Math.max(2, (a1 - a0) * w), h - 26);
  }
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = "rgba(160,190,230,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, yOf(0));
  ctx.lineTo(x + w, yOf(0));
  ctx.stroke();
  ctx.setLineDash([]);
  const n = upperBound(ALL.p, p);
  let px = x;
  let py = yOf(0);
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const nx = x + ALL.p[i] * w;
    const ny = yOf(ALL.shape[i]);
    ctx.strokeStyle = ALL[i].B.look.color;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    px = nx;
    py = ny;
  }
  if (p >= 0) {
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "#fff";
    ctx.shadowBlur = 10;
    ctx.fillRect(x + clamp(p, 0, 1) * w - 1, y + 22, 2, h - 24);
  }
  ctx.restore();
}

function bottom(a, st, sec) {
  const y = 1422;
  const h = 448;
  const gap = 12;
  const w = (W - 56 - gap * 2) / 3;
  const fade = (k) => a * smooth((sec - 0.4 - k * 0.1) / 0.5);

  // A. results by bot (donut)
  let x = 28;
  let al = fade(0);
  panel(x, y, w, h, "RESULTS BY BOT", al);
  {
    const cx = x + w / 2;
    const cy = y + 190;
    const r = 112;
    const segs = [];
    BOTS.forEach((B, k) => {
      const s = st.bots[k];
      segs.push([s.wins, B.look.win], [s.n - s.wins, B.look.loss]);
    });
    const total = segs.reduce((s, x2) => s + x2[0], 0);
    ctx.save();
    ctx.globalAlpha = al;
    ctx.lineWidth = 30;
    if (!total) {
      ctx.strokeStyle = "rgba(120,170,230,0.12)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    let ang = -Math.PI / 2;
    for (const [n, color] of segs) {
      if (!n) continue;
      const da = (n / total) * Math.PI * 2;
      ctx.strokeStyle = rgba(color, 0.85);
      ctx.beginPath();
      ctx.arc(cx, cy, r, ang + 0.012, ang + da - 0.012);
      ctx.stroke();
      ang += da;
    }
    ctx.restore();
    txt(ctx, st.trades ? pctPlain((st.wins / st.trades) * 100) : "—", cx, cy + 10, { font: SANS, size: 44, weight: 700, align: "center", alpha: al });
    txt(ctx, "WON", cx, cy + 36, { size: 12, weight: 700, color: COL.dim, spacing: 2, align: "center", alpha: al });
    BOTS.forEach((B, k) => {
      const s = st.bots[k];
      const ly = y + 352 + k * 30;
      const share = st.trades ? (s.n / st.trades) * 100 : 0;
      ctx.save();
      ctx.globalAlpha = al;
      ctx.fillStyle = B.look.color;
      ctx.fillRect(x + 16, ly - 10, 10, 10);
      ctx.restore();
      txt(ctx, B.look.short, x + 34, ly, { size: 13, weight: 700, color: B.look.color, alpha: al });
      txt(ctx, `${pctPlain(share)} of trades`, x + w - 14, ly, { size: 12, weight: 700, color: COL.mid, align: "right", alpha: al });
    });
  }

  // B. range per trade (worst ... best), and how far pump.fun coins went before the exit
  x += w + gap;
  al = fade(1);
  panel(x, y, w, h, "RANGE PER TRADE", al, "worst · avg · best");
  {
    const rows = [];
    BOTS.forEach((B, k) => {
      const s = st.bots[k];
      rows.push({ name: B.look.short, color: B.look.color, lo: s.worst, mid: s.ret, hi: s.best, kind: "range" });
    });
    const pump = BOTS.findIndex((B) => B.key === "pump");
    if (pump >= 0 && st.bots[pump].avgPeak !== null) {
      const s = st.bots[pump];
      rows.push({ name: "PUMP PEAK → EXIT", color: LOOK.pump.color, lo: s.avgExit, hi: s.avgPeak, kind: "peak" });
    }
    rows.forEach((r, k) => {
      const ry = y + 70 + k * 120;
      txt(ctx, r.name, x + 14, ry, { size: 13, weight: 700, color: r.color, spacing: 1, alpha: al });
      const tx0 = x + 22;
      const tw = w - 44;
      const ty = ry + 34;
      const ext = Math.max(5, Math.abs(r.lo || 0), Math.abs(r.hi || 0)) * 1.1;
      const X = (v) => tx0 + ((clamp(v, -ext, ext) + ext) / (2 * ext)) * tw;
      ctx.save();
      ctx.globalAlpha = al;
      ctx.fillStyle = "rgba(120,170,230,0.14)";
      ctx.fillRect(tx0, ty - 1, tw, 3);
      ctx.fillStyle = "rgba(220,235,255,0.4)";
      ctx.fillRect(X(0) - 0.5, ty - 8, 1, 17);
      if (r.lo !== null && r.hi !== null) {
        const g = ctx.createLinearGradient(X(r.lo), 0, X(r.hi), 0);
        g.addColorStop(0, rgba(r.kind === "peak" ? "#ffffff" : COL.red, 0.8));
        g.addColorStop(1, rgba(r.kind === "peak" ? r.color : COL.green, 0.8));
        ctx.fillStyle = g;
        ctx.fillRect(X(r.lo), ty - 1, X(r.hi) - X(r.lo), 3);
        const dot = (v, color) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(X(v), ty + 0.5, 7, 0, Math.PI * 2);
          ctx.fill();
        };
        dot(r.lo, r.kind === "peak" ? "#ffffff" : COL.red);
        dot(r.hi, r.kind === "peak" ? r.color : COL.green);
        if (r.mid !== null && r.mid !== undefined) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(X(r.mid) - 1.5, ty - 10, 3, 21);
        }
      }
      ctx.restore();
      if (r.lo !== null && r.hi !== null) {
        txt(ctx, pct(r.lo, 1), tx0, ty + 34, { size: 13, weight: 700, color: r.kind === "peak" ? COL.text : COL.red, alpha: al });
        txt(ctx, pct(r.hi, 1), tx0 + tw, ty + 34, { size: 13, weight: 700, color: r.kind === "peak" ? r.color : COL.green, align: "right", alpha: al });
        if (r.kind === "peak") txt(ctx, "avg exit → avg peak", tx0 + tw / 2, ty + 34, { size: 11, color: COL.dim, align: "center", alpha: al });
        else if (r.mid !== null && r.mid !== undefined) txt(ctx, `avg ${pct(r.mid, 2)}`, tx0 + tw / 2, ty + 34, { size: 11, weight: 700, color: COL.mid, align: "center", alpha: al });
      } else txt(ctx, "no trades yet", tx0, ty + 34, { size: 12, color: COL.dim, alpha: al });
    });
  }

  // C. most traded markets (pareto)
  x += w + gap;
  al = fade(2);
  panel(x, y, w, h, "MOST TRADED", al, "share of trades");
  {
    const counts = new Map();
    for (let i = 0; i < st.m; i++) {
      const e = ALL[i];
      const k = `${e.B.key}|${e.t.label}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a2, b2) => b2[1] - a2[1]).slice(0, 7);
    const total = Math.max(1, st.m);
    const max = top.length ? top[0][1] : 1;
    const bx = x + 18;
    const bwAll = w - 36;
    const bw = bwAll / 7;
    const base = y + h - 70;
    const hmax = h - 130;
    let cum = 0;
    const pts = [];
    ctx.save();
    ctx.globalAlpha = al;
    top.forEach(([k, n], i) => {
      const [bot] = k.split("|");
      const hh = (n / max) * hmax;
      ctx.fillStyle = rgba((LOOK[bot] || LOOK.pump).color, 0.8);
      ctx.fillRect(bx + i * bw + 3, base - hh, bw - 8, hh);
      cum += n;
      pts.push([bx + i * bw + bw / 2, base - (cum / total) * hmax]);
    });
    if (pts.length) {
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
      ctx.fillStyle = "#fff";
      for (const [px, py] of pts) ctx.fillRect(px - 2.5, py - 2.5, 5, 5);
    }
    ctx.restore();
    top.forEach(([k], i) => {
      const label = k.split("|")[1].replace(/USDT$/, "").slice(0, 6);
      txt(ctx, label, bx + i * bw + bw / 2, base + 20, { size: 10, weight: 700, color: COL.mid, align: "center", alpha: al });
    });
    if (pts.length) txt(ctx, `top ${top.length}: ${pctPlain((cum / total) * 100)}`, x + w - 14, base + 48, { size: 12, weight: 700, color: COL.text, align: "right", alpha: al });
    else txt(ctx, "no trades yet", bx, base, { size: 12, color: COL.dim, alpha: al });
  }
}

function footer(a) {
  const src = D.demo ? "preview · sample data" : `real record · pump.fun trade logs + Bybit closed P&L · ${dateText(D.generatedAt)}`;
  txt(ctx, src, W / 2, 1900, { size: 11, weight: 700, color: COL.dim, align: "center", alpha: a });
}

// ------------------------------------------------------------------ the end: final result over the rings

function finalCard(sec) {
  const t = sec - T1;
  if (t <= 0) return;
  const a = smooth((t - 0.2) / 0.6);
  const tr = [...D.story.totals].sort((x2, y2) => (x2.first || 0) - (y2.first || 0));
  const bw = 640;
  const bh = 150 + tr.length * 70 + (D.story.overallRet !== null && tr.length > 1 ? 70 : 0);
  const bx = RING_CX - bw / 2;
  const by = RING_CY - bh / 2 + (1 - easeOut((t - 0.2) / 0.7)) * 30;
  panel(bx, by, bw, bh, "FINAL RESULT", a, `${dateText(CLOCK.start)} → ${dateText(CLOCK.end)}`, COL.gold, 0.9);
  const cols = [bx + 390, bx + 500, bx + bw - 24];
  txt(ctx, "RETURN/TRADE", cols[0], by + 66, { size: 11, weight: 700, color: COL.dim, align: "right", alpha: a });
  txt(ctx, "WON", cols[1], by + 66, { size: 11, weight: 700, color: COL.dim, align: "right", alpha: a });
  txt(ctx, "TRADES", cols[2], by + 66, { size: 11, weight: 700, color: COL.dim, align: "right", alpha: a });
  let y = by + 116;
  tr.forEach((b, i) => {
    const look = LOOK[b.key] || LOOK.pump;
    const ra = a * smooth((t - 0.5 - i * 0.15) / 0.4);
    txt(ctx, look.name, bx + 24, y, { font: SANS, size: 21, weight: 700, color: look.color, spacing: 1, alpha: ra });
    txt(ctx, pct(b.ret, 2), cols[0], y, { font: SANS, size: 28, weight: 700, color: b.ret === null ? COL.dim : signColor(b.ret), align: "right", alpha: ra });
    txt(ctx, b.trades ? pctPlain((b.wins / b.trades) * 100) : "—", cols[1], y, { font: SANS, size: 28, weight: 700, align: "right", alpha: ra });
    txt(ctx, num(b.trades), cols[2], y, { font: SANS, size: 28, weight: 700, color: COL.mid, align: "right", alpha: ra });
    y += 70;
  });
  if (D.story.overallRet !== null && tr.length > 1) {
    const ra = a * smooth((t - 0.9) / 0.4);
    ctx.save();
    ctx.globalAlpha = ra;
    ctx.fillStyle = "rgba(160,190,230,0.25)";
    ctx.fillRect(bx + 24, y - 44, bw - 48, 1);
    ctx.restore();
    const wins = tr.reduce((s, b) => s + b.wins, 0);
    const n = tr.reduce((s, b) => s + b.trades, 0);
    txt(ctx, "BOTH BOTS", bx + 24, y, { font: SANS, size: 22, weight: 700, color: COL.gold, spacing: 1, alpha: ra });
    txt(ctx, pct(D.story.overallRet, 2), cols[0], y, { font: SANS, size: 28, weight: 700, color: signColor(D.story.overallRet), align: "right", alpha: ra });
    txt(ctx, n ? pctPlain((wins / n) * 100) : "—", cols[1], y, { font: SANS, size: 28, weight: 700, align: "right", alpha: ra });
    txt(ctx, num(n), cols[2], y, { font: SANS, size: 28, weight: 700, color: COL.mid, align: "right", alpha: ra });
  }
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
      img.data[i + 3] = 10;
    }
    g.putImageData(img, 0, 0);
    GRAIN.push(ctx.createPattern(c, "repeat"));
  }
}

function filmLook(frame) {
  const v = ctx.createRadialGradient(W / 2, H / 2, 520, W / 2, H / 2, 1300);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.fillStyle = GRAIN[frame % GRAIN.length];
  ctx.translate((frame * 37) % 256, (frame * 91) % 256);
  ctx.fillRect(-256, -256, W + 512, H + 512);
  ctx.restore();
}

function background() {
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);
  const a = ctx.createRadialGradient(RING_CX, 620, 0, RING_CX, 620, 800);
  a.addColorStop(0, rgba(LOOK.bybit.color, 0.05));
  a.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, W, H);
  const b = ctx.createRadialGradient(RING_CX, 1080, 0, RING_CX, 1080, 800);
  b.addColorStop(0, rgba(LOOK.pump.color, 0.05));
  b.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = b;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(90, 140, 200, 0.03)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 40) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();
}

// ------------------------------------------------------------------ frame

function drawFrame(sec, frame = Math.round(sec * FPS)) {
  const p = progressAt(sec);
  background();
  const a = smooth(sec / 0.8); // the dashboard fades in from black
  const cam = drawScene(sec, p, a);
  const st = stateAt(p);
  const final = sec >= T1;
  header(a, sec, p, final);
  ringFrame(a, sec, st, cam);
  side(a, st, p, sec);
  stream(a, p);
  bottom(a, st, sec);
  footer(a);
  cards(sec, cam);
  intermission(sec);
  finalCard(sec);
  filmLook(frame);
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
      const done = (i / frames) * 100;
      statusEl.textContent = `making the film… ${done.toFixed(0)}%  (keep this tab open)`;
      barEl.style.width = `${done}%`;
      if (i % 60 === 0) fetch("/progress", { method: "POST", body: String(Math.round(done)) }).catch(() => {});
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
