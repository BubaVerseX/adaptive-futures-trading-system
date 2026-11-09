#!/usr/bin/env node
"use strict";

const HELP = `Make a 30-second vertical video (1080×1920 MP4) of what both bots really did.

  node video/make.cjs              pump.fun (left) + Bybit (right), whole history
  node video/make.cjs --days 1     only the last day (good for a daily clip)
  node video/make.cjs --demo       preview with SAMPLE numbers (marked on screen)

Where the numbers come from:
  pump.fun  data/pump/trades-live-*.jsonl and data/pump/research-*.jsonl
  Bybit     your closed positions, read from Bybit with the keys in .env
            (read-only; saved to data/video/bybit-closed-pnl.json, so later
            runs only fetch what is new)

The video is drawn and encoded in your browser (Chrome or Safari), then saved
to video/out/. Keep the tab open until it says done (about 1-2 minutes).

Options:
  --days N              only the last N days
  --bybit-from DATE     first day to read from Bybit (default 2026-06-01)
  --no-bybit / --no-pump   leave one bot out
  --chrome              open in Google Chrome instead of the default browser
  --no-open             just print the link
  --paper               use the pump bot's paper trades instead of live ones
`;

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const data = require("./lib/data.cjs");

const ROOT = path.join(__dirname, "..");
const DAY = 24 * 3600 * 1000;

function parseArgs(argv) {
  const a = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--demo") a.demo = true;
    else if (k === "--days") a.days = Number(argv[++i]);
    else if (k === "--bybit-from") a.bybitFrom = argv[++i];
    else if (k === "--no-bybit") a.noBybit = true;
    else if (k === "--no-pump") a.noPump = true;
    else if (k === "--chrome") a.chrome = true;
    else if (k === "--no-open") a.open = false;
    else if (k === "--paper") a.paper = true;
    else if (k === "--port") a.port = Number(argv[++i]);
    else throw new Error(`unknown option ${k} (see --help)`);
  }
  return a;
}

function openUrl(url, chrome) {
  if (process.platform === "darwin") execFile("open", chrome ? ["-a", "Google Chrome", url] : [url]);
  else if (process.platform === "win32") execFile("cmd", ["/c", "start", "", url]);
  else execFile("xdg-open", [url], () => {});
}

async function collect(args) {
  if (args.demo) return { demo: true, bots: data.demoBots() };
  const fromMs = Number.isFinite(args.days) ? Date.now() - args.days * DAY : 0;
  const bots = [];
  if (!args.noPump) {
    const pump = data.loadPump(ROOT, { fromMs, mode: args.paper ? "paper" : "live" });
    const seen = pump.watched === null ? "no watched-coin files" : `${pump.watched.toLocaleString("en-US")} coins watched`;
    console.log(`pump.fun: ${pump.trades.length} trades, ${seen}, status ${pump.status}`);
    bots.push(pump);
  }
  if (!args.noBybit) {
    const from = Date.parse(`${args.bybitFrom || "2026-06-01"}T00:00:00Z`);
    try {
      const { rows, note } = await data.fetchBybitClosedPnl(ROOT, { fromMs: from, log: (m) => console.log(m) });
      const bybit = data.bybitTimeline(rows, { fromMs });
      console.log(`Bybit: ${bybit.trades.length} closed trades${note ? ` (${note})` : ""}, status ${bybit.status}`);
      bots.push(bybit);
    } catch (e) {
      console.log(`Bybit: could not read your trades — ${e.message}`);
      console.log("       (run with --no-bybit to make the video without it)");
      const empty = data.bybitTimeline([]);
      bots.push(empty);
    }
  }
  if (!bots.length) throw new Error("nothing to show: both bots were left out");
  return { demo: false, bots };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function serve(payload, args) {
  const outDir = path.join(__dirname, "out");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET") {
        if (url.pathname === "/data.json") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          return res.end(JSON.stringify(payload));
        }
        const file = url.pathname === "/" ? "render.html" : url.pathname.slice(1);
        const allowed = ["render.html", "render.js", "vendor/mp4-muxer.js"];
        if (!allowed.includes(file)) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "content-type": TYPES[path.extname(file)], "cache-control": "no-store" });
        return res.end(fs.readFileSync(path.join(__dirname, file)));
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (url.pathname === "/progress") {
          process.stdout.write(`\rmaking video… ${body.toString()}%   `);
          res.end("ok");
        } else if (url.pathname === "/failed") {
          console.log(`\n✗ the browser said: ${body.toString()}`);
          console.log(`  open this link in Google Chrome instead: http://127.0.0.1:${server.address().port}/?record=1`);
          res.end("ok");
        } else if (url.pathname === "/upload") {
          fs.mkdirSync(outDir, { recursive: true });
          const d = new Date();
          const name = `bot-video-${d.toISOString().slice(0, 10)}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${payload.demo ? "-PREVIEW" : ""}.mp4`;
          const file = path.join(outDir, name);
          fs.writeFileSync(file, body);
          res.end("ok");
          console.log(`\n✓ saved ${path.relative(process.cwd(), file)} (${(body.length / 1e6).toFixed(1)} MB)`);
          server.close();
          resolve(file);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.on("error", reject);
    server.listen(args.port || 0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/?record=1`;
      console.log(`\nmaking the video in your browser: ${url}`);
      console.log("keep that tab open until it says done.");
      if (args.open) openUrl(url, args.chrome);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const { demo, bots } = await collect(args);
  const payload = { demo, generatedAt: Date.now(), bots };
  const file = await serve(payload, args);
  if (args.open && process.platform === "darwin") execFile("open", ["-R", file]);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, collect };
