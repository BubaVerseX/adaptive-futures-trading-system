"use strict";
/* global Mp4Muxer */
/*
 * Draws the bot video frame by frame from /data.json (the bots' real records) and,
 * in record mode, encodes it to an MP4 in the browser and posts it back to make.cjs.
 *
 *   /?record=1   render all frames, encode, upload        (what make.cjs opens)
 *   /?t=12.5     draw one frame at 12.5 s                  (stills / checks)
 *   /?play=1     play it live in the page                  (look around)
 */

const W = 1080;
const H = 1920;
const FPS = 30;
const DUR = 30;
const T0 = 1.4; // replay starts (video seconds)
const T1 = 25.6; // replay ends; the rest holds the final numbers
const N = 72; // points per ring line
const FONT = "Menlo, 'SF Mono', 'DejaVu Sans Mono', Consolas, monospace";
const COL = {
  bg: "#03050b",
  panel: "rgba(9, 16, 30, 0.78)",
  edge: "rgba(110, 175, 235, 0.26)",
  edgeHi: "rgba(140, 205, 255, 0.55)",
  dim: "#5f7690",
  mid: "#93a9c0",
  text: "#dce9f6",
  cyan: "#5fd4ff",
  teal: "#3fe0c8",
  gold: "#ffc24a",
  orange: "#ff9b3d",
  green: "#3dff9a",
  red: "#ff4d6d",
  violet: "#b59cff",
};

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d", { alpha: false });
const statusEl = document.getElementById("status");
const barEl = document.querySelector("#bar i");

// ------------------------------------------------------------------ helpers

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
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
function groupDigits(s) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function num(v, dec = 0) {
  const [i, d] = Math.abs(v).toFixed(dec).split(".");
  return groupDigits(i) + (d ? "." + d : "");
}
function signed(v, dec) {
  const s = v > 0 ? "+" : v < 0 ? "−" : "";
  return s + num(v, dec);
}
const pad2 = (n) => String(n).padStart(2, "0");
function stamp(ms, withDate = true) {
  const d = new Date(ms);
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withDate ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${t}` : t;
}
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function longDate(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function font(size, weight = 400) {
  return `${weight} ${size}px ${FONT}`;
}
function text(str, x, y, { size = 14, weight = 400, color = COL.text, align = "left", alpha = 1 } = {}) {
  ctx.globalAlpha = alpha;
  ctx.font = font(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(str, x, y);
  ctx.globalAlpha = 1;
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------------ data prep

function prepare(bot, index) {
  const lines = bot.lines;
  const trades = bot.trades;
  const times = [];
  for (const l of lines) times.push(l.t);
  for (const t of trades) {
    if (t.open) times.push(t.open);
    times.push(t.close);
  }
  times.sort((a, b) => a - b);
  const empty = trades.length === 0 && lines.length === 0;
  const start = empty ? 0 : times[0];
  const end = empty ? 1 : times[times.length - 1];
  const span = Math.max(1, end - start);

  // Replay clock: mostly follows activity (quiet nights pass quickly), partly real time.
  const K = 2000;
  const tab = new Float64Array(K + 1);
  for (let i = 0; i <= K; i++) {
    const p = i / K;
    let q = start + p * span;
    if (times.length > 1) {
      const f = p * (times.length - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(times.length - 1, i0 + 1);
      q = times[i0] + (times[i1] - times[i0]) * (f - i0);
    }
    tab[i] = 0.3 * (start + p * span) + 0.7 * q;
  }
  const pOf = (ms) => {
    if (ms <= tab[0]) return 0;
    if (ms >= tab[K]) return 1;
    const j = upperBound(tab, ms) - 1;
    const f = (ms - tab[j]) / Math.max(1e-9, tab[j + 1] - tab[j]);
    return (j + f) / K;
  };
  const timeOf = (p) => {
    const f = clamp(p, 0, 1) * K;
    const j = Math.min(K - 1, Math.floor(f));
    return tab[j] + (tab[j + 1] - tab[j]) * (f - j);
  };

  const pAppear = new Float64Array(lines.length);
  lines.forEach((l, i) => (pAppear[i] = pOf(l.t)));
  const pClose = new Float64Array(trades.length);
  const pOpen = new Float64Array(trades.length);
  trades.forEach((t, i) => {
    pClose[i] = pOf(t.close);
    pOpen[i] = t.open ? Math.min(pOf(t.open), pClose[i]) : pClose[i];
  });

  const cum = new Float64Array(trades.length);
  let run = 0;
  let maxAbs = 1e-12;
  trades.forEach((t, i) => {
    run += t.pnl;
    cum[i] = run;
    maxAbs = Math.max(maxAbs, Math.abs(t.pnl));
  });
  let cumMin = 0;
  let cumMax = 0;
  for (const v of cum) {
    cumMin = Math.min(cumMin, v);
    cumMax = Math.max(cumMax, v);
  }

  // Ring geometry: each line is a helix wound around a torus, its shape fixed by its seed.
  const geom = new Float32Array(lines.length * N * 3);
  const group = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    const s = l.seed;
    const u0 = hash(s, 1) * Math.PI * 2;
    const spanU = Math.PI * (0.55 + 1.15 * hash(s, 2));
    const wind = (hash(s, 3) < 0.5 ? -1 : 1) * (1.6 + 5.5 * hash(s, 6)); // turns around the tube
    const v0 = hash(s, 4) * Math.PI * 2;
    const rr = 0.42 * (0.5 + 0.55 * hash(s, 5)) + 0.06 * (l.w || 0);
    for (let j = 0; j < N; j++) {
      const u = u0 + (spanU * j) / (N - 1);
      const v = v0 + wind * (u - u0);
      const o = (i * N + j) * 3;
      geom[o] = (1 + rr * Math.cos(v)) * Math.cos(u);
      geom[o + 1] = (1 + rr * Math.cos(v)) * Math.sin(u);
      geom[o + 2] = rr * Math.sin(v);
    }
    const hue = hash(s, 7);
    const colorBucket = hue < 0.8 ? 0 : hue < 0.92 ? 1 : 2;
    const w = l.w || 0;
    const alphaBucket = w < 0.15 ? 0 : w < 0.5 ? 1 : 2;
    group[i] = colorBucket * 3 + alphaBucket;
  });
  const tradeOfLine = new Int32Array(lines.length).fill(-1);
  trades.forEach((t, i) => {
    if (t.line >= 0 && t.line < lines.length) tradeOfLine[t.line] = i;
  });

  // Log events in order.
  const events = [];
  trades.forEach((t, i) => {
    if (t.open && bot.key === "pump") events.push({ p: pOpen[i], kind: "open", i });
    events.push({ p: pClose[i], kind: "close", i });
  });
  events.sort((a, b) => a.p - b.p);
  const eventP = Float64Array.from(events.map((e) => e.p));

  // Activity histogram for the footer.
  const BINS = 140;
  const bins = new Float32Array(BINS);
  for (const v of pClose) bins[Math.min(BINS - 1, Math.floor(v * BINS))]++;
  const binMax = Math.max(1, ...bins);

  return {
    ...bot,
    index,
    empty,
    start,
    end,
    timeOf,
    pAppear,
    pOpen,
    pClose,
    cum,
    cumMin,
    cumMax,
    maxAbs,
    geom,
    scr: new Float32Array(lines.length * N * 2),
    group,
    tradeOfLine,
    events,
    eventP,
    bins,
    binMax,
    spin0: index * 2.1,
  };
}

function statsAt(B, p) {
  const n = upperBound(B.pClose, p);
  let wins = 0;
  let best = -Infinity;
  let worst = Infinity;
  let fees = 0;
  let hold = 0;
  let holdN = 0;
  const symbols = new Set();
  for (let i = 0; i < n; i++) {
    const t = B.trades[i];
    if (t.pnl > 0) wins++;
    best = Math.max(best, t.pnl);
    worst = Math.min(worst, t.pnl);
    fees += t.fee || 0;
    symbols.add(t.label);
    if (t.open) {
      hold += t.close - t.open;
      holdN++;
    }
  }
  let open = 0;
  for (let i = 0; i < B.trades.length; i++) if (B.pOpen[i] <= p && B.pClose[i] > p) open++;
  const linesShown = upperBound(B.pAppear, p);
  return {
    n,
    wins,
    pnl: n ? B.cum[n - 1] : 0,
    best: n ? best : 0,
    worst: n ? worst : 0,
    fees,
    avgHold: holdN ? hold / holdN : 0,
    symbols: symbols.size,
    open,
    linesShown,
    watched: B.watched === null ? null : Math.min(B.watched, linesShown * B.perLine),
  };
}

// ------------------------------------------------------------------ timing

function progressAt(sec) {
  if (sec < T0) return -1; // before the replay starts nothing has happened yet
  const x = clamp((sec - T0) / (T1 - T0), 0, 1);
  return 0.82 * x + 0.18 * smooth(x);
}
const REPLAY_SEC = T1 - T0;

// ------------------------------------------------------------------ drawing: frame parts

function panel(x, y, w, h, title, right, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = COL.panel;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COL.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // corner ticks
  ctx.strokeStyle = COL.edgeHi;
  ctx.lineWidth = 2;
  const k = 9;
  ctx.beginPath();
  ctx.moveTo(x, y + k); ctx.lineTo(x, y); ctx.lineTo(x + k, y);
  ctx.moveTo(x + w - k, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + k);
  ctx.moveTo(x, y + h - k); ctx.lineTo(x, y + h); ctx.lineTo(x + k, y + h);
  ctx.moveTo(x + w - k, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - k);
  ctx.stroke();
  if (title) text(title, x + 12, y + 22, { size: 13, weight: 700, color: COL.mid, alpha });
  if (right) text(right, x + w - 12, y + 22, { size: 13, color: COL.dim, align: "right", alpha });
  ctx.globalAlpha = 1;
}

function background(sec) {
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);
  // faint grid
  ctx.strokeStyle = "rgba(90, 140, 200, 0.045)";
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
  const g = ctx.createRadialGradient(W / 2, 640, 50, W / 2, 640, 900);
  g.addColorStop(0, "rgba(40, 90, 160, 0.10)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // slow scanline
  const sy = ((sec * 140) % (H + 200)) - 100;
  const sg = ctx.createLinearGradient(0, sy - 60, 0, sy + 60);
  sg.addColorStop(0, "rgba(95,212,255,0)");
  sg.addColorStop(0.5, "rgba(95,212,255,0.035)");
  sg.addColorStop(1, "rgba(95,212,255,0)");
  ctx.fillStyle = sg;
  ctx.fillRect(0, sy - 60, W, 120);
}

function header(D, bots, stats, sec) {
  const a = smooth(sec / 0.6);
  text("| BUBAVERSE LAB / LIVE TRADE ARCHITECTURE", 28, 46, { size: 15, weight: 700, color: COL.mid, alpha: a });
  const right = `${longDate(D.generatedAt)}  ·  REC`;
  text(right, W - 50, 46, { size: 15, weight: 700, color: COL.mid, align: "right", alpha: a });
  if (Math.floor(sec * 2) % 2 === 0) {
    ctx.fillStyle = COL.red;
    ctx.beginPath();
    ctx.arc(W - 36, 41, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  const title = bots.map((b) => b.title + " BOT").join("  +  ");
  const typed = title.slice(0, Math.floor(clamp((sec - 0.1) / 0.9, 0, 1) * title.length));
  text(typed, 28, 86, { size: 30, weight: 800, color: COL.orange });
  const totalTrades = stats.reduce((s, x) => s + x.n, 0);
  const totalLines = stats.reduce((s, x) => s + x.linesShown, 0);
  text(
    `REAL TRADE RECORD  |  2 ENGINES  |  ${num(totalTrades)} TRADES  |  ${num(totalLines)} RING LINES  |  NOTHING SIMULATED`,
    28, 114, { size: 13, color: COL.dim, alpha: a },
  );
}

function kpis(bots, stats, sec, y) {
  const tiles = [];
  const all = stats.reduce((s, x) => s + x.n, 0);
  const wins = stats.reduce((s, x) => s + x.wins, 0);
  tiles.push({ k: "TRADES", v: num(all), c: COL.text });
  tiles.push({ k: "WIN RATE", v: all ? `${((wins / all) * 100).toFixed(1)}%` : "—", c: COL.text });
  const pump = bots.findIndex((b) => b.key === "pump");
  const bybit = bots.findIndex((b) => b.key === "bybit");
  if (pump >= 0) {
    const s = stats[pump];
    tiles.push({ k: s.watched === null ? "PUMP OPEN" : "COINS SEEN", v: s.watched === null ? String(s.open) : num(s.watched), c: COL.cyan });
    tiles.push({ k: "PUMP P&L SOL", v: signed(s.pnl, 4), c: s.pnl > 0 ? COL.green : s.pnl < 0 ? COL.red : COL.text });
  }
  if (bybit >= 0) {
    const s = stats[bybit];
    tiles.push({ k: "BYBIT P&L $", v: signed(s.pnl, 2), c: s.pnl > 0 ? COL.green : s.pnl < 0 ? COL.red : COL.text });
    tiles.push({ k: "BYBIT FEES $", v: num(s.fees, 2), c: COL.gold });
  }
  const gap = 10;
  const w = (W - 56 - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const a = smooth((sec - 0.15 - i * 0.07) / 0.5);
    const x = 28 + i * (w + gap);
    panel(x, y, w, 74, "", "", a);
    text(t.k, x + 12, y + 24, { size: 12, weight: 700, color: COL.dim, alpha: a });
    text(t.v, x + 12, y + 58, { size: 25, weight: 800, color: t.c, alpha: a });
  });
}

function chips(B, x, y, w, sec, p) {
  // Each chip lights up when the bot really did that step at this point of the replay.
  const recentClose = B.eventP.length && B.events.some((e, i) => e.kind === "close" && Math.abs(p - B.eventP[i]) * REPLAY_SEC < 0.25);
  const recentOpen = B.eventP.length && B.events.some((e, i) => e.kind === "open" && Math.abs(p - B.eventP[i]) * REPLAY_SEC < 0.25);
  const newLine = (() => {
    const n = upperBound(B.pAppear, p);
    return n > 0 && (p - B.pAppear[n - 1]) * REPLAY_SEC < 0.12;
  })();
  const lit = B.key === "pump"
    ? [newLine, newLine || recentOpen, recentOpen, recentOpen, recentClose]
    : [recentClose, true, true, true, recentClose];
  let cx = x;
  ctx.font = font(12, 700);
  B.chips.forEach((name, i) => {
    const tw = ctx.measureText(name).width + 16;
    if (cx + tw > x + w) return;
    const on = lit[i] && sec > T0 - 0.2;
    ctx.fillStyle = on ? rgba(B.key === "pump" ? COL.cyan : COL.orange, 0.22) : "rgba(20,30,48,0.8)";
    ctx.fillRect(cx, y, tw, 24);
    ctx.strokeStyle = on ? (B.key === "pump" ? COL.cyan : COL.orange) : COL.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx + 0.5, y + 0.5, tw - 1, 23);
    text(name, cx + 8, y + 17, { size: 12, weight: 700, color: on ? COL.text : COL.dim });
    cx += tw + 6;
  });
}

function scaffold(cx, cy, scale, ang, tilt, rho, alpha) {
  // faint torus wireframe so the ring has a shape before the lines arrive
  const ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(rho), sr = Math.sin(rho);
  const D = 4.5;
  ctx.strokeStyle = `rgba(120, 190, 255, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const v = (k / 10) * Math.PI * 2;
    for (let j = 0; j <= 90; j++) {
      const u = (j / 90) * Math.PI * 2;
      const x = (1 + 0.42 * Math.cos(v)) * Math.cos(u);
      const y = (1 + 0.42 * Math.cos(v)) * Math.sin(u);
      const z = 0.42 * Math.sin(v);
      const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
      const y2 = y1 * ct - z * st, z2 = y1 * st + z * ct;
      const kk = (scale * D) / (D - z2);
      const X = x1 * kk, Y = y2 * kk;
      const px = cx + X * cr - Y * sr, py = cy + X * sr + Y * cr;
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

const LINE_COLORS = [
  [150, 212, 255],
  [90, 255, 215],
  [200, 160, 255],
];

function strokeLine(s, i, from = 0, to = N) {
  const o = i * N * 2;
  ctx.moveTo(s[o + from * 2], s[o + from * 2 + 1]);
  for (let j = from + 1; j < to; j++) ctx.lineTo(s[o + j * 2], s[o + j * 2 + 1]);
}

function ring(B, cx, cy, scale, sec, p) {
  const ang = B.spin0 + sec * 0.3;
  const tilt = 0.66;
  const rho = B.index === 0 ? -0.35 : 0.35;
  const intro = smooth((sec - 0.2) / 0.8);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // center glow
  const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, scale * 1.7);
  g.addColorStop(0, "rgba(70, 150, 255, 0.10)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(cx - scale * 2, cy - scale * 2, scale * 4, scale * 4);
  scaffold(cx, cy, scale, ang, tilt, rho, 0.05 * intro);

  const vis = upperBound(B.pAppear, p);
  const ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(rho), sr = Math.sin(rho);
  const D = 4.5;
  const gm = B.geom;
  const s = B.scr;
  for (let i = 0, n = vis * N; i < n; i++) {
    const x = gm[i * 3], y = gm[i * 3 + 1], z = gm[i * 3 + 2];
    const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
    const y2 = y1 * ct - z * st, z2 = y1 * st + z * ct;
    const k = (scale * D) / (D - z2);
    const X = x1 * k, Y = y2 * k;
    s[i * 2] = cx + X * cr - Y * sr;
    s[i * 2 + 1] = cy + X * sr + Y * cr;
  }

  // Brightness follows how many lines are showing, so the ring stays see-through
  // instead of turning solid white as thousands of coins pile up.
  const baseAlpha = clamp(1.35 / Math.sqrt(Math.max(1, vis)), 0.012, 0.28);
  const GROW = 0.5; // seconds a new line takes to weave in
  const newFrom = upperBound(B.pAppear, p - GROW / REPLAY_SEC);

  // settled lines that are not trades, batched by colour and brightness
  ctx.lineWidth = 0.9;
  for (let gid = 0; gid < 9; gid++) {
    const [r, gg, bb] = LINE_COLORS[Math.floor(gid / 3)];
    const a = baseAlpha * [0.7, 1.1, 1.6][gid % 3];
    ctx.strokeStyle = `rgba(${r},${gg},${bb},${a})`;
    ctx.beginPath();
    let c = 0;
    for (let i = 0; i < newFrom; i++) {
      if (B.group[i] !== gid || B.tradeOfLine[i] >= 0) continue;
      strokeLine(s, i);
      if (++c % 70 === 0) {
        ctx.stroke();
        ctx.beginPath();
      }
    }
    ctx.stroke();
  }

  // lines being woven in right now
  for (let i = newFrom; i < vis; i++) {
    if (B.tradeOfLine[i] >= 0) continue;
    const age = (p - B.pAppear[i]) * REPLAY_SEC;
    const len = Math.max(2, Math.floor(N * clamp(age / GROW, 0, 1)));
    ctx.strokeStyle = `rgba(220, 240, 255, ${0.5 * (1 - age / GROW) + baseAlpha})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    strokeLine(s, i, 0, len);
    ctx.stroke();
  }

  // trades: gold while open, then green (profit) or red (loss)
  const settled = { [COL.green]: [], [COL.red]: [] };
  const fresh = [];
  for (let t = 0; t < B.trades.length; t++) {
    const line = B.trades[t].line;
    if (line >= vis && B.pOpen[t] > p) continue;
    if (B.pOpen[t] > p) continue;
    if (line >= vis) continue;
    if (B.pClose[t] > p) {
      fresh.push({ line, kind: "open", age: (p - B.pOpen[t]) * REPLAY_SEC });
      continue;
    }
    const age = (p - B.pClose[t]) * REPLAY_SEC;
    const color = B.trades[t].pnl > 0 ? COL.green : COL.red;
    if (age < 1.3) fresh.push({ line, kind: "close", color, age });
    else settled[color].push(line);
  }
  const nSettled = settled[COL.green].length + settled[COL.red].length;
  const tradeAlpha = clamp(4.5 / Math.sqrt(Math.max(1, nSettled)), 0.16, 0.6);
  for (const color of [COL.green, COL.red]) {
    ctx.strokeStyle = rgba(color, tradeAlpha);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    settled[color].forEach((line, k) => {
      strokeLine(s, line);
      if ((k + 1) % 60 === 0) {
        ctx.stroke();
        ctx.beginPath();
      }
    });
    ctx.stroke();
  }
  for (const f of fresh) {
    const color = f.kind === "open" ? COL.gold : f.color;
    const flash = f.kind === "open" ? 0.55 + 0.35 * Math.sin(sec * 9) : Math.exp(-f.age / 0.45);
    ctx.strokeStyle = rgba(color, 0.16 + 0.2 * flash);
    ctx.lineWidth = 7;
    ctx.beginPath();
    strokeLine(s, f.line);
    ctx.stroke();
    ctx.strokeStyle = rgba(color, clamp(tradeAlpha + 0.6 * flash, 0, 1));
    ctx.lineWidth = 1.6 + 1.6 * flash;
    ctx.beginPath();
    strokeLine(s, f.line);
    ctx.stroke();
    if (f.kind === "close") {
      // spark running along the line
      const j = Math.min(N - 1, Math.floor((f.age / 1.3) * N));
      const o = f.line * N * 2 + j * 2;
      const rg = ctx.createRadialGradient(s[o], s[o + 1], 0, s[o], s[o + 1], 16);
      rg.addColorStop(0, "rgba(255,255,255,0.95)");
      rg.addColorStop(0.3, rgba(color, 0.7));
      rg.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(s[o] - 16, s[o + 1] - 16, 32, 32);
    }
  }
  ctx.restore();
  return vis;
}

function botColumn(B, S, x, w, sec, p) {
  const accent = B.key === "pump" ? COL.cyan : COL.orange;
  const a = smooth((sec - 0.3 - B.index * 0.15) / 0.6);
  let y = 270;

  // title + status
  text(B.title, x, y, { size: 30, weight: 800, color: accent, alpha: a });
  const live = B.status === "LIVE";
  const st = live ? "● LIVE" : "■ STOPPED";
  text(st, x + w, y - 2, { size: 15, weight: 700, color: live ? COL.green : COL.red, align: "right", alpha: a * (live && Math.floor(sec * 2) % 2 ? 0.55 : 1) });
  y += 24;
  text(B.subtitle, x, y, { size: 13, color: COL.dim, alpha: a });
  const clock = B.empty ? "no records" : `replay ${stamp(B.timeOf(p))}`;
  text(clock, x + w, y, { size: 13, weight: 700, color: COL.mid, align: "right", alpha: a });
  y += 14;

  // ring
  const ringH = 500;
  panel(x, y, w, ringH, `CORE // ${num(S.linesShown)} LINES`, `spin ${(((B.spin0 + sec * 0.3) * 180) / Math.PI % 360).toFixed(1)}°`, a);
  if (!B.empty) ring(B, x + w / 2, y + ringH / 2 + 4, 142, sec, p);
  else text("waiting for the first trade", x + w / 2, y + ringH / 2, { size: 16, color: COL.dim, align: "center" });
  const unit = B.perLine > 1 ? `1 line ≈ ${B.perLine} ${B.lineWord}s` : `1 line = 1 ${B.lineWord}`;
  text(unit, x + 12, y + ringH - 14, { size: 12, color: COL.mid, alpha: a });
  const legend = B.key === "pump" ? [["open", COL.gold], ["win", COL.green], ["loss", COL.red]] : [["win", COL.green], ["loss", COL.red]];
  let lx = x + w - 12;
  ctx.font = font(12, 700);
  for (const [name, c] of legend.reverse()) {
    const tw = ctx.measureText(name).width;
    text(name, lx, y + ringH - 14, { size: 12, weight: 700, color: COL.mid, align: "right", alpha: a });
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(lx - tw - 9, y + ringH - 18, 4, 0, Math.PI * 2);
    ctx.fill();
    lx -= tw + 26;
  }
  y += ringH + 12;

  // P&L
  panel(x, y, w, 104, "NET P&L", `${num(S.n)} trades`, a);
  const pnlColor = S.pnl > 0 ? COL.green : S.pnl < 0 ? COL.red : COL.text;
  const final = sec >= T1;
  text(`${signed(S.pnl, B.decimals)} ${B.unit}`, x + 12, y + 80, { size: 46, weight: 800, color: pnlColor, alpha: a });
  const wr = S.n ? `${((S.wins / S.n) * 100).toFixed(0)}% win` : "";
  text(wr, x + w - 12, y + 78, { size: 16, weight: 700, color: COL.mid, align: "right", alpha: a });
  if (final) {
    const fa = smooth((sec - T1) / 0.5);
    ctx.globalAlpha = fa;
    ctx.fillStyle = rgba(accent, 0.18);
    ctx.fillRect(x + w - 92, y + 34, 80, 22);
    ctx.globalAlpha = 1;
    text("FINAL", x + w - 52, y + 51, { size: 14, weight: 800, color: accent, align: "center", alpha: fa });
  }
  y += 116;

  // cumulative P&L chart
  const ch = 196;
  panel(x, y, w, ch, "CUMULATIVE P&L", B.unit, a);
  equity(B, x + 14, y + 36, w - 28, ch - 50, p);
  y += ch + 12;

  // last trades as bars
  const bh = 128;
  panel(x, y, w, bh, "LAST 40 TRADES", "", a);
  bars(B, S, x + 14, y + 34, w - 28, bh - 44, p);
  y += bh + 12;

  // numbers grid
  const cells = B.key === "pump"
    ? [["WATCHED", S.watched === null ? "—" : num(S.watched)], ["BOUGHT", num(S.n + S.open)], ["OPEN NOW", String(S.open)],
       ["AVG HOLD", S.avgHold ? `${Math.round(S.avgHold / 1000)}s` : "—"], ["BEST", signed(S.best, 4)], ["WORST", signed(S.worst, 4)]]
    : [["SYMBOLS", num(S.symbols)], ["TRADES", num(S.n)], ["WINS", num(S.wins)],
       ["FEES $", num(S.fees, 2)], ["BEST $", signed(S.best, 2)], ["WORST $", signed(S.worst, 2)]];
  const cw = (w - 10) / 3;
  cells.forEach(([k, v], i) => {
    const cx = x + (i % 3) * (cw + 5);
    const cy = y + Math.floor(i / 3) * 62;
    panel(cx, cy, cw, 56, "", "", a);
    text(k, cx + 10, cy + 20, { size: 11, weight: 700, color: COL.dim, alpha: a });
    const c = k.startsWith("BEST") ? COL.green : k.startsWith("WORST") ? COL.red : COL.text;
    text(v, cx + 10, cy + 45, { size: 20, weight: 800, color: c, alpha: a });
  });
  y += 128;

  // trade log
  const lh = 1716 - y - 12;
  panel(x, y, w, lh, `tail -f ${B.key}.trades`, `${S.n} closed`, a);
  log(B, x + 12, y + 46, w - 24, lh - 54, p, sec);
}

function equity(B, x, y, w, h, p) {
  ctx.strokeStyle = "rgba(140,190,240,0.18)";
  ctx.setLineDash([4, 5]);
  const span = Math.max(1e-12, B.cumMax - B.cumMin);
  const yOf = (v) => y + h - ((v - B.cumMin) / span) * h;
  ctx.beginPath();
  ctx.moveTo(x, yOf(0));
  ctx.lineTo(x + w, yOf(0));
  ctx.stroke();
  ctx.setLineDash([]);
  const n = upperBound(B.pClose, p);
  if (!n) return;
  ctx.beginPath();
  ctx.moveTo(x, yOf(0));
  for (let i = 0; i < n; i++) ctx.lineTo(x + B.pClose[i] * w, yOf(B.cum[i]));
  const lastX = x + p * w;
  const lastY = yOf(B.cum[n - 1]);
  ctx.lineTo(lastX, lastY);
  const line = B.cum[n - 1] >= 0 ? COL.green : COL.red;
  ctx.strokeStyle = COL.cyan;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(lastX, yOf(0));
  ctx.lineTo(x, yOf(0));
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "rgba(95,212,255,0.20)");
  g.addColorStop(1, "rgba(95,212,255,0.02)");
  ctx.fillStyle = g;
  ctx.fill();
  const rg = ctx.createRadialGradient(lastX, lastY, 0, lastX, lastY, 14);
  rg.addColorStop(0, "rgba(255,255,255,0.95)");
  rg.addColorStop(0.35, rgba(line, 0.8));
  rg.addColorStop(1, rgba(line, 0));
  ctx.fillStyle = rg;
  ctx.fillRect(lastX - 14, lastY - 14, 28, 28);
  text(signed(B.cumMax, B.decimals), x + w, y + 10, { size: 11, color: COL.dim, align: "right" });
  text(signed(B.cumMin, B.decimals), x + w, y + h, { size: 11, color: COL.dim, align: "right" });
}

function bars(B, S, x, y, w, h, p) {
  const n = S.n;
  const from = Math.max(0, n - 40);
  const mid = y + h / 2;
  ctx.strokeStyle = "rgba(140,190,240,0.18)";
  ctx.beginPath();
  ctx.moveTo(x, mid);
  ctx.lineTo(x + w, mid);
  ctx.stroke();
  const bw = w / 40;
  let maxAbs = 1e-12;
  for (let i = from; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(B.trades[i].pnl));
  for (let i = from; i < n; i++) {
    const t = B.trades[i];
    const hh = (Math.abs(t.pnl) / maxAbs) * (h / 2 - 2);
    const age = (p - B.pClose[i]) * REPLAY_SEC;
    const flash = Math.exp(-age / 0.35);
    ctx.fillStyle = rgba(t.pnl > 0 ? COL.green : COL.red, 0.55 + 0.45 * flash);
    const bx = x + (i - from + (40 - (n - from))) * bw + 1;
    if (t.pnl > 0) ctx.fillRect(bx, mid - hh, bw - 2, hh);
    else ctx.fillRect(bx, mid, bw - 2, Math.max(1, hh));
  }
}

function log(B, x, y, w, h, p, sec) {
  const rowH = 25;
  const rows = Math.floor(h / rowH);
  const n = upperBound(B.eventP, p);
  const from = Math.max(0, n - rows);
  for (let k = from; k < n; k++) {
    const e = B.events[k];
    const t = B.trades[e.i];
    const ry = y + (k - from) * rowH;
    const age = (p - e.p) * REPLAY_SEC;
    if (k === n - 1 && age < 0.6) {
      ctx.fillStyle = rgba(e.kind === "open" ? COL.gold : t.pnl > 0 ? COL.green : COL.red, 0.16 * (1 - age / 0.6));
      ctx.fillRect(x - 6, ry - 18, w + 12, rowH - 2);
    }
    const when = stamp(e.kind === "open" ? t.open : t.close);
    let action;
    let amount;
    let color;
    if (e.kind === "open") {
      action = "BUY ";
      amount = `${num(t.size, 3)} ${B.unit}`;
      color = COL.gold;
    } else {
      action = B.key === "pump" ? "SELL" : t.side;
      const pct = t.pct === null ? "" : `${signed(t.pct, 1)}%`;
      amount = `${pct.padStart(7)} ${signed(t.pnl, B.decimals)}`;
      color = t.pnl > 0 ? COL.green : COL.red;
    }
    text(when, x, ry, { size: 14, color: COL.dim });
    text(action, x + 118, ry, { size: 14, weight: 700, color });
    text(t.label.slice(0, B.key === "pump" ? 10 : 12), x + 170, ry, { size: 14, weight: 700, color: COL.text });
    text(amount, x + w, ry, { size: 14, weight: 700, color, align: "right" });
  }
  if (!n) text(sec < T0 ? "starting replay…" : "no trades yet", x, y, { size: 14, color: COL.dim });
}

function footer(D, bots, sec, p) {
  const y = 1728;
  const h = 150;
  const a = smooth((sec - 0.6) / 0.6);
  panel(28, y, W - 56, h, "ACTIVITY STREAM // trades over each bot's own timeline", "", a);
  const x0 = 44;
  const w = W - 88;
  const mid = y + 92;
  bots.forEach((B) => {
    const color = B.key === "pump" ? COL.cyan : COL.orange;
    const dir = B.index === 0 ? -1 : 1;
    const bw = w / B.bins.length;
    for (let i = 0; i < B.bins.length; i++) {
      const v = B.bins[i] / B.binMax;
      const past = (i + 0.5) / B.bins.length <= p;
      ctx.fillStyle = rgba(color, past ? 0.85 : 0.14);
      const hh = Math.max(1, v * 44);
      if (dir < 0) ctx.fillRect(x0 + i * bw, mid - hh - 1, bw - 1, hh);
      else ctx.fillRect(x0 + i * bw, mid + 1, bw - 1, hh);
    }
  });
  const px = x0 + Math.max(0, p) * w;
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, y + 40);
  ctx.lineTo(px, y + h - 8);
  ctx.stroke();
  text(`${(Math.max(0, p) * 100).toFixed(0)}%`, Math.min(px + 8, W - 80), y + 52, { size: 12, weight: 700, color: COL.text });
  const legend = bots.map((b) => `▲ ${b.title.toLowerCase()}`).join("    ");
  text(legend, W - 44, y + 22, { size: 12, weight: 700, color: COL.dim, align: "right", alpha: a });

  const src = D.demo
    ? "PREVIEW · SAMPLE NUMBERS · NOT REAL TRADES"
    : `source: data/pump/trades-live-*.jsonl + Bybit closed-pnl · made ${stamp(D.generatedAt)}`;
  text(src, W / 2, 1904, { size: 13, weight: 700, color: D.demo ? COL.orange : COL.dim, align: "center", alpha: a });
}

function demoBanner(sec) {
  ctx.fillStyle = "rgba(255,155,61,0.16)";
  ctx.fillRect(0, 196, W, 0);
  const a = 0.85 + 0.15 * Math.sin(sec * 4);
  ctx.save();
  ctx.translate(W / 2, 1000);
  ctx.rotate(-0.42);
  text("PREVIEW · SAMPLE DATA", 0, 0, { size: 64, weight: 800, color: COL.orange, align: "center", alpha: 0.10 * a });
  ctx.restore();
}

// ------------------------------------------------------------------ frame

let DATA;
let BOTS;

function drawFrame(sec) {
  const p = progressAt(sec);
  const stats = BOTS.map((B) => statsAt(B, p));
  background(sec);
  header(DATA, BOTS, stats, sec);
  kpis(BOTS, stats, sec, 132);
  const colW = (W - 56 - 24) / 2;
  BOTS.forEach((B, i) => {
    const x = 28 + i * (colW + 24);
    chips(B, x, 218, colW, sec, p);
  });
  BOTS.forEach((B, i) => botColumn(B, stats[i], 28 + i * (colW + 24), colW, sec, p));
  footer(DATA, BOTS, sec, p);
  if (DATA.demo) demoBanner(sec);
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
      const s = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 14e6, framerate: FPS, avc: { format: "avc" } });
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
  enc.configure({ codec, width: W, height: H, bitrate: 14e6, framerate: FPS, avc: { format: "avc" } });
  const frames = FPS * DUR;
  const startedAt = performance.now();
  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    drawFrame(i / FPS);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: i % FPS === 0 });
    frame.close();
    while (enc.encodeQueueSize > 3) await yieldNow();
    if (i % 10 === 0) {
      const pct = (i / frames) * 100;
      statusEl.textContent = `making video… ${pct.toFixed(0)}%  (keep this tab open)`;
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
  const secs = ((performance.now() - startedAt) / 1000).toFixed(0);
  statusEl.textContent = `done in ${secs}s — saved. You can close this tab.`;
  barEl.style.width = "100%";
  window.__done = true;
}

async function main() {
  DATA = await (await fetch("/data.json")).json();
  BOTS = DATA.bots.map((b, i) => prepare(b, i));
  const q = new URLSearchParams(location.search);
  if (q.has("t")) {
    drawFrame(Number(q.get("t")));
    statusEl.textContent = `frame at ${q.get("t")}s`;
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
  statusEl.textContent = "playing (preview) — the saved video is made with ?record=1";
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
