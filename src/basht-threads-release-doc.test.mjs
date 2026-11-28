// Integration BUG-3/BUG-4/BUG-6: the operator document must give a disable that keeps the config valid, no plugin config block,
// and a real, runnable §11.2 gate command (source text only).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { CRON_RUNNING_PARAMS, SESSIONS_ACTIVE_PARAMS } from "./gateway-link.js";

const doc = fs.readFileSync(new URL("../docs/BASHT_THREADS_RELEASE.md", import.meta.url), "utf8");
const section = (start, end) => { const i = doc.indexOf(start); assert.ok(i >= 0, start); const j = end ? doc.indexOf(end, i + start.length) : -1; return doc.slice(i, j < 0 ? undefined : j); };
const bashBlocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

test("BUG-3: the documented disable is enabled:false with the load path KEPT; no command removes the path or empties the list", () => {
  const dis = section("**Disable (the rollback)", "**Residual risk");
  const cmds = bashBlocks(dis).join("\n");
  assert.match(cmds, /config set plugins\.entries\.basht-resume-guard\.enabled false/);
  assert.match(cmds, /config validate/);
  assert.ok(!/plugins\.load\.paths/.test(cmds), "no load-path change in the disable commands");
  for (const block of bashBlocks(doc)) {
    assert.ok(!/plugins\.load\.paths\s+'\[\]'/.test(block), "never empties plugins.load.paths");
    assert.ok(!/config unset plugins\.(entries\.basht-resume-guard|load)/.test(block));
  }
  assert.match(dis, /Never remove the path/);
  assert.match(section("## Rollback", "## Release gate"), /enabled false`, keeping the load path/);
});

test("BUG-4: no plugin config block is ever set (a standalone plugin file accepts none)", () => {
  for (const block of bashBlocks(doc)) assert.ok(!/basht-resume-guard\.config\b/.test(block) && !/"config"\s*:/.test(block), block.slice(0, 80));
  assert.match(doc, /Settings: \*\*none\.\*\*/);
});

test("BUG-6: the §11.2 block is the real gate script: no pasted plan text, the counting reads' exact params, valid node code", () => {
  const block = bashBlocks(section("### §11.2 idle command", "### §11.3"))[0];
  assert.ok(block, "a bash block");
  assert.ok(!/[؀-ۿ]/.test(block), "no Arabic plan text in the operator command");
  assert.ok(!/^\|/m.test(block), "no table rows");
  assert.match(block, /^command -v openclaw >\/dev\/null \|\| \{ echo "openclaw not on PATH"; echo NOT_IDLE_OR_UNKNOWN; exit 1; \}$/m);
  const js = /node -e '\n([\s\S]*)'\s*$/.exec(block.trim())?.[1];
  assert.ok(js, "a node -e script");
  assert.doesNotThrow(() => new vm.Script(js), "the script compiles");
  assert.ok(js.includes(`JSON.stringify(${JSON.stringify(SESSIONS_ACTIVE_PARAMS).replace(/"(\w+)":/g, "$1:")})`), "sessions.list params = the engine's counting read");
  assert.ok(js.includes(`JSON.stringify(${JSON.stringify(CRON_RUNNING_PARAMS).replace(/"(\w+)":/g, "$1:")})`), "cron.list params = the engine's counting read");
  for (const s of ['"approvals","pending","--json"', 'console.log(ok?"IDLE":"NOT_IDLE_OR_UNKNOWN")', "UNKNOWN_INPUTS", "inBlackout"]) assert.ok(js.includes(s), s);
});
