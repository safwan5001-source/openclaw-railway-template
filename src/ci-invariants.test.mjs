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

test("the container storage test gives the first scan a deterministic margin over a slow start", () => {
  // 4cbf464: the gateway became reachable ~112 s after wrapper start on a CI runner, after the default 90 s first scan,
  // so the 'baseline hash before the first scan' check failed. The test must delay the first scan beyond the wait_gw bound.
  const s = read("scripts/test-storage-diag-container.sh");
  const m = s.match(/DIAG_STORAGE_FIRST_DELAY_SEC=(\d+)/);
  assert.ok(m, "phase 2 must set DIAG_STORAGE_FIRST_DELAY_SEC");
  const waitGwSeconds = Number(s.match(/seq 1 (\d+)\); do curl -s [^\n]*sleep (\d+)/)?.slice(1).reduce((a, b) => a * Number(b), 1));
  assert.ok(Number(m[1]) > 90, "must be longer than the 90 s production default");
  assert.ok(waitGwSeconds > 0 && Number(m[1]) >= waitGwSeconds + 30, `first-scan delay ${m[1]} s must exceed the wait_gw bound ${waitGwSeconds} s by >= 30 s`);
});
