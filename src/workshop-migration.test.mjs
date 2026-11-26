import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDisabledWorkshop } from "./workshop-migration.js";

test("migration preserves all other settings and original private backup; idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-"));
  try {
    const file = path.join(dir, "openclaw.json");
    const original = { skills: { entries: { wacli: { enabled: false } }, workshop: { autonomous: { mode: "off" } } }, auth: { profiles: { synthetic: { provider: "test" } } } };
    const raw = JSON.stringify(original);
    fs.writeFileSync(file, raw);
    assert.equal(migrateDisabledWorkshop(file), true);
    const expected = structuredClone(original);
    delete expected.skills.workshop;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), expected);
    const backup = fs.readdirSync(dir).find(name => name.endsWith(".bak"));
    assert.equal(fs.readFileSync(path.join(dir, backup), "utf8"), raw);
    assert.equal(fs.statSync(path.join(dir, backup)).mode & 0o777, 0o600);
    assert.equal(migrateDisabledWorkshop(file), false);
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("migration refuses active or unfamiliar workshop settings unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-"));
  try {
    const file = path.join(dir, "openclaw.json");
    for (const workshop of [{ autonomous: { mode: "on" } }, { autonomous: { mode: "off" }, extra: true }]) {
      const raw = JSON.stringify({ skills: { workshop } });
      fs.writeFileSync(file, raw);
      assert.throws(() => migrateDisabledWorkshop(file), /refusing/);
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
