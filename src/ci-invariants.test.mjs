// Regression guard (source text only, no I/O beyond reading repo files).
//
// Root cause of the PR #26 "patches" CI failure, reproduced on commit 4cbf464 as a non-root user on Node 26:
// `node --test patches/*.test.mjs` runs the test FILES in parallel. OpenClaw's file logger always appends to the shared
// /tmp/openclaw/openclaw-<date>.log, and patches/owner-check.test.mjs asserts that the checker leaves that log (and the
// rest of its sandbox) untouched by snapshotting it before/after. Another test file writing to the same log in between
// makes the snapshot differ ("the checker must not create, modify or delete any file ... /tmp/openclaw logs";
// 3 of 3 parallel runs failed, 3 of 3 runs with --test-concurrency=1 passed). As root the integration tests are skipped,
// which is why it never showed up in root-only sandboxes.
// The fix is to run the patches suite serially everywhere; this test keeps every entry point from regressing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// every shell-ish command that runs the patches test files
function patchesInvocations(text) {
  return text
    .split("\n")
    .filter((l) => /node\s+--test\b/.test(l) && /patches\/\*\.test\.mjs/.test(l))
    .flatMap((l) => l.match(/node\s+--test\b[^&|"'\n]*patches\/\*\.test\.mjs/g) ?? []);
}

test("every invocation of patches/*.test.mjs is serialized with --test-concurrency=1", () => {
  const files = ["package.json", "scripts/ci-local.sh", ...fs.readdirSync(path.join(root, ".github/workflows")).map((f) => `.github/workflows/${f}`)];
  let total = 0;
  for (const f of files) {
    for (const cmd of patchesInvocations(read(f))) {
      total++;
      assert.match(cmd, /--test-concurrency=1\b/, `${f}: parallel patches run (shared /tmp/openclaw log race): ${cmd}`);
    }
  }
  assert.ok(total >= 4, `expected the package.json scripts, ci-local.sh and the memory/security workflow to be checked (found ${total})`);
});

test("the guard recognises a parallel invocation (self-check)", () => {
  assert.equal(patchesInvocations("run: node --test patches/*.test.mjs").length, 1);
  assert.ok(!/--test-concurrency=1/.test(patchesInvocations("run: node --test patches/*.test.mjs")[0]));
  assert.ok(/--test-concurrency=1/.test(patchesInvocations("node --test --test-concurrency=1 patches/*.test.mjs")[0]));
});

test("server.js starts the storage heartbeat only AFTER the boot-time doctor/gateway initialisation (#38)", () => {
  // Race seen on 4cbf464: the heartbeat's 90 s first-scan timer started at listen(), the boot-time `openclaw doctor --fix`
  // + gateway start took ~112 s on a CI runner, so the first scan ran while OpenClaw was still migrating state and the
  // container test's baseline hash was taken after the scan. #38 moved the start behind the initialisation; keep it there.
  const s = read("src/server.js");
  const calls = [...s.matchAll(/startStorageDiagnostics\(/g)].map((m) => m.index);
  assert.equal(calls.length, 2, "exactly two guarded call sites (after init, and when not configured)");
  const listen = s.indexOf("const server = app.listen(");
  const ensure = s.indexOf("await ensureGatewayRunning();", listen);
  const fin = s.indexOf(".finally(", ensure);
  assert.ok(listen > 0 && ensure > listen && fin > ensure, "boot sequence found");
  const callSites = calls.filter((i) => i > listen);
  assert.equal(callSites.length, 2);
  assert.ok(callSites[0] > fin, "first call site is inside the .finally() that follows ensureGatewayRunning()");
  assert.ok(/}\s*else\s*{\s*startStorageDiagnostics/.test(s.slice(callSites[0])), "second call site is the not-configured branch");
});
