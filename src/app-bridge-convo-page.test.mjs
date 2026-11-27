// anchoredPage: when is another «عرض الرسائل السابقة» page offered? (lab finding, integration e2e: one empty extra page)
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchoredPage, PAGE } from "./app-bridge-convo.js";

const row = (id) => ({ role: "user", content: "x", __openclaw: { id } });
const rows = (n, anchorAt) => Array.from({ length: n }, (_, i) => row(i === anchorAt ? "anchor-0001" : `row-${String(i).padStart(4, "0")}`));
const ctx = (answer) => ({ appKey: "agent:main:app:owner", gatewayCall: async () => answer, ledger: { anchorFor: () => null, list: () => [] } });

test("the engine's own anchor.hasOlder decides: start reached → no extra (empty) page even with many raw rows", async () => {
  const r = await anchoredPage(ctx({ messages: rows(49, 47), anchor: { hasOlder: false } }), "agent:main:main", "anchor-0001", "before");
  assert.equal(r.messages.length, 47);
  assert.equal(r.earlier, null);
});

test("anchor.hasOlder true offers the next page even when fewer than PAGE rows came back (e.g. a byte-limited window)", async () => {
  const r = await anchoredPage(ctx({ messages: rows(12, 10), anchor: { hasOlder: true } }), "agent:main:main", "anchor-0001", "before");
  assert.equal(r.earlier, "row-0000");
});

test("an engine without anchor info keeps the previous rule (a full page before the anchor means more)", async () => {
  assert.equal((await anchoredPage(ctx({ messages: rows(PAGE + 2, PAGE) }), "agent:main:main", "anchor-0001", "before")).earlier, "row-0000");
  assert.equal((await anchoredPage(ctx({ messages: rows(10, 8) }), "agent:main:main", "anchor-0001", "before")).earlier, null);
});
