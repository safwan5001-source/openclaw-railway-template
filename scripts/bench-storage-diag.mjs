#!/usr/bin/env node
// Benchmark for src/storage-diagnostics.js: cost of one scan and its impact on the wrapper's event loop / proxy latency.
//
//   node scripts/bench-storage-diag.mjs [files=50000]
//
// Builds a synthetic tree (files of 1-8 KB in nested dirs, incl. protected, doctor and plugin-capture paths) in a fresh
// temp directory, then measures in THIS process -- the same process model as the wrapper (server.js), where the scan
// shares the event loop with the HTTP/WS proxy to the gateway (the gateway itself is a separate child process):
//   - baseline vs during-scan latency of a local HTTP endpoint hit back-to-back (stand-in for proxied requests)
//   - scan wall time, process CPU time, RSS / heap before and peak, max event-loop delay
// Synthetic data only; the temp tree is removed at the end. Prints one JSON object.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { buildLines, scanTree } from "../src/storage-diagnostics.js";

const N = Number(process.argv[2]) || 50_000;
const MB = 1024 * 1024;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-bench-"));

function build() {
  const kinds = [
    (i) => `.openclaw/agents/main/sessions/s${i % 97}/${i}.jsonl`,
    (i) => `workspace/memory/d${i % 53}/${i}.md`,
    (i) => `.openclaw/tmp/plugin-captures/inst${i % 7}/captures/p${i % 41}/f${i}.js`,
    (i) => `.openclaw/agents/main/sessions/s${i % 97}/${i}.jsonl.pre-doctor-branch-repair-2026-11-01T10-00-00-000Z.bak`,
    (i) => `.openclaw/npm/node_modules/pkg${i % 211}/lib/f${i}.js`,
    (i) => `.cache/x${i % 31}/blob${i}`,
    (i) => `workspace/exports/r${i % 17}/${i}.pdf`,
    (i) => `.linuxbrew/Cellar/c${i % 89}/f${i}.bin`,
  ];
  const old = new Date(Date.now() - 30 * 864e5);
  for (let i = 0; i < N; i++) {
    const p = path.join(root, kinds[i % kinds.length](i));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(1024 * (1 + (i % 8))));
    if (i % 3 === 0) fs.utimesSync(p, old, old);
  }
}

const pct = (a, q) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
const r1 = (n) => Math.round(n * 10) / 10;

async function hammer(server, untilFn) {
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const lat = [];
  while (!untilFn()) {
    const t = process.hrtime.bigint();
    await new Promise((res, rej) =>
      http.get({ port, path: "/healthz", agent }, (r) => { r.resume(); r.on("end", res); }).on("error", rej),
    );
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  agent.destroy();
  return { n: lat.length, p50: r1(pct(lat, 0.5)), p99: r1(pct(lat, 0.99)), max: r1(Math.max(...lat)) };
}

const t0 = Date.now();
build();
const buildMs = Date.now() - t0;
const server = http.createServer((req, res) => res.end("ok"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));

// warm up + baseline (1.5 s without a scan)
let stop = Date.now() + 1500;
const baseline = await hammer(server, () => Date.now() > stop);

global.gc?.();
const mem0 = process.memoryUsage();
let peakRss = mem0.rss;
let peakHeap = mem0.heapUsed;
const memTimer = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}, 10);
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
let done = false;
const scanP = scanTree(root, { now: Date.now() }).then((r) => ((done = true), r));
const during = await hammer(server, () => done);
const report = await scanP;
lag.disable();
clearInterval(memTimer);
const [summary, detail] = buildLines(report, null, "ok");

server.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      node: process.version,
      cpus: os.cpus().length,
      files: report.files,
      buildMs,
      scan: { ms: report.scanMs, cpuMs: report.cpuMs, truncated: report.truncated, filesPerSec: Math.round(report.files / (report.scanMs / 1000)) },
      memory: {
        rssBeforeMB: r1(mem0.rss / MB),
        rssPeakMB: r1(peakRss / MB),
        rssDeltaMB: r1((peakRss - mem0.rss) / MB),
        heapBeforeMB: r1(mem0.heapUsed / MB),
        heapPeakMB: r1(peakHeap / MB),
      },
      eventLoop: { maxDelayMs: r1(lag.max / 1e6), p99DelayMs: r1(lag.percentile(99) / 1e6) },
      proxyLatencyMs: { baseline, duringScan: during },
      recovery: JSON.parse(summary).recovery,
      logBytes: { summary: summary.length, detail: detail.length },
    },
    null,
    2,
  ),
);
