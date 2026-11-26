import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { restrictToOwner } from "./private-permissions.js";

const mode = (p) => fs.lstatSync(p).mode & 0o7777;

test("restored state: directories become 0700 and files lose group/other bits, never gain any", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "basht-perms-"));
  try {
    const state = path.join(root, ".openclaw");
    fs.mkdirSync(path.join(state, "client"), { recursive: true });
    fs.mkdirSync(path.join(state, "credentials", "whatsapp"), { recursive: true });
    const files = {
      "openclaw.json": 0o644,
      "client/credentials.sqlite": 0o666,
      "credentials/whatsapp/creds.json": 0o600,
      "exec.sh": 0o755,
      "read-only": 0o444,
    };
    for (const [rel, m] of Object.entries(files)) {
      const f = path.join(state, rel);
      fs.writeFileSync(f, "synthetic");
      fs.chmodSync(f, m);
    }
    for (const d of [state, path.join(state, "client"), path.join(state, "credentials"), path.join(state, "credentials", "whatsapp")]) fs.chmodSync(d, 0o755);

    const changed = restrictToOwner(state);
    assert.ok(changed > 0);
    for (const d of [state, "client", "credentials", "credentials/whatsapp"].map((r) => path.join(state, r === state ? "" : r))) assert.equal(mode(d), 0o700, d);
    assert.equal(mode(path.join(state, "openclaw.json")), 0o600);
    assert.equal(mode(path.join(state, "client/credentials.sqlite")), 0o600);
    assert.equal(mode(path.join(state, "credentials/whatsapp/creds.json")), 0o600, "already private: unchanged");
    assert.equal(mode(path.join(state, "exec.sh")), 0o700, "owner execute bit kept");
    assert.equal(mode(path.join(state, "read-only")), 0o400, "owner read-only kept, nothing widened");
    assert.equal(restrictToOwner(state), 0, "idempotent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink is never followed or changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "basht-perms-link-"));
  try {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.chmodSync(outside, 0o755);
    const state = path.join(root, "state");
    fs.mkdirSync(state);
    fs.symlinkSync(outside, path.join(state, "link"));
    restrictToOwner(state);
    assert.equal(mode(outside), 0o755, "target outside the tree is untouched");
    assert.equal(restrictToOwner(path.join(state, "link")), 0, "a symlink root is ignored");
    assert.equal(mode(outside), 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
