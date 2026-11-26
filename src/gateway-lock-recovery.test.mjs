import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverRestoredGatewayLock } from "./gateway-lock-recovery.js";

const FP = "a".repeat(64);
const inspect = (o) => `[plugins] noise\n${JSON.stringify(o, null, 2)}\n`;
const recorder = (responses) => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const r = responses[calls.length - 1];
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
};

test("a foreign owner is recovered with the exact fingerprint of the same inspection", async () => {
  const { run, calls } = recorder([
    { code: 0, output: inspect({ present: true, holders: ["a", "b"], confirmation: FP, command: "x" }) },
    { code: 0, output: "Gateway lock recovery completed. Start the Gateway again." },
  ]);
  assert.deepEqual(await recoverRestoredGatewayLock(run), { recovered: true, holders: 2 });
  assert.deepEqual(calls, [["gateway", "recover-lock", "--json"], ["gateway", "recover-lock", "--confirm", FP]]);
});

test("nothing recorded: no recovery command is ever run", async () => {
  const { run, calls } = recorder([{ code: 0, output: inspect({ present: false, holders: [], confirmation: FP }) }]);
  assert.equal((await recoverRestoredGatewayLock(run)).recovered, false);
  assert.equal(calls.length, 1, "inspection only");
});

test("unreadable, malformed or fingerprint-less inspections never reach the confirm step", async () => {
  for (const output of ["", "no json here", "{ broken", inspect({ present: true, holders: [] }), inspect({ present: true, confirmation: "short" }), inspect({ present: true, confirmation: `${FP}; rm -rf /` })]) {
    const { run, calls } = recorder([{ code: 0, output }]);
    const r = await recoverRestoredGatewayLock(run);
    assert.equal(r.recovered, false, output);
    assert.equal(calls.length, 1, output);
  }
});

test("a refused or crashing recovery is reported, never thrown", async () => {
  const refused = recorder([{ code: 0, output: inspect({ present: true, holders: ["h"], confirmation: FP }) }, { code: 1, output: "refused: heartbeat renewed" }]);
  assert.deepEqual(await recoverRestoredGatewayLock(refused.run), { recovered: false, holders: 1, reason: "recovery exited 1" });
  const crashing = recorder([new Error("spawn failed")]);
  assert.match((await recoverRestoredGatewayLock(crashing.run)).reason, /inspection failed/);
  const crashingConfirm = recorder([{ code: 0, output: inspect({ present: true, holders: ["h"], confirmation: FP }) }, new Error("boom")]);
  assert.match((await recoverRestoredGatewayLock(crashingConfirm.run)).reason, /recovery failed: boom/);
});
