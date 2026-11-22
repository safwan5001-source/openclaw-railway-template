import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const installer = join(root, "scripts/install-marketing-skills.sh");
const names = [
  "basht-market-intelligence", "basht-marketing-strategy", "basht-creative-direction",
  "basht-social-media", "basht-ads-campaigns", "basht-performance-analytics",
  "basht-video-creative", "basht-local-seo", "basht-conversion-optimization",
  "basht-marketing-automation",
];
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "basht-marketing-install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const src = join(base, "src"), ws = join(base, "workspace");
  mkdirSync(src);
  for (const name of names) {
    mkdirSync(join(src, name, "references"), { recursive: true });
    writeFileSync(join(src, name, "SKILL.md"), `---\nname: ${name}\ndescription: "synthetic"\n---\n`);
    writeFileSync(join(src, name, "references", "PLAYBOOK.md"), "synthetic playbook\n");
  }
  return { base, src, ws };
}
function run(src, ws) {
  return spawnSync("bash", [installer, src, ws, "-"], { encoding: "utf8", timeout: 20_000 });
}
function location(ws, name) { return join(ws, "skills", name); }

test("all 10 allowlisted skills install atomically; repeat changes nothing", (t) => {
  const { src, ws } = fixture(t);
  const first = run(src, ws);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(readdirSync(join(ws, "skills")).sort(), [...names].sort());
  assert.match(first.stderr, /installed=10 unchanged=0 conflicts=0/);
  const before = names.map(n => readFileSync(join(location(ws, n), "SKILL.md"), "utf8"));
  const second = run(src, ws);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /installed=0 unchanged=10 conflicts=0/);
  assert.deepEqual(names.map(n => readFileSync(join(location(ws, n), "SKILL.md"), "utf8")), before);
});

test("never overwrites a user-modified marketing skill; installs other nine", (t) => {
  const { src, ws } = fixture(t);
  const existing = location(ws, names[0]);
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, "SKILL.md"), "OWNER MODIFIED - DO NOT TOUCH\n");
  const result = run(src, ws);
  assert.notEqual(result.status, 0, "must flag a conflict");
  assert.match(result.stderr, /installed=9 unchanged=0 conflicts=1/);
  assert.equal(readFileSync(join(existing, "SKILL.md"), "utf8"), "OWNER MODIFIED - DO NOT TOUCH\n");
  for (const n of names.slice(1)) assert.ok(existsSync(join(location(ws, n), "SKILL.md")));
});

test("never modifies unrelated existing skills", (t) => {
  const { src, ws } = fixture(t);
  const unrelated = location(ws, "basht-daftra");
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, "SKILL.md"), "OWNED BY OTHER INSTALLER");
  assert.equal(run(src, ws).status, 0);
  assert.equal(readFileSync(join(unrelated, "SKILL.md"), "utf8"), "OWNED BY OTHER INSTALLER");
});

test("refuses symlinked workspace and destination paths", (t) => {
  const { base, src, ws } = fixture(t);
  const safe = join(base, "safe");
  mkdirSync(safe);
  symlinkSync(safe, ws);
  assert.notEqual(run(src, ws).status, 0);
  rmSync(ws);
  mkdirSync(join(ws, "skills"), { recursive: true });
  symlinkSync(safe, location(ws, names[0]));
  assert.notEqual(run(src, ws).status, 0);
});

test("refuses source symlinks and mismatched frontmatter", (t) => {
  const { src, ws } = fixture(t);
  rmSync(join(src, names[0], "references"), { recursive: true });
  symlinkSync("/tmp", join(src, names[0], "references"));
  assert.notEqual(run(src, ws).status, 0);
  rmSync(join(src, names[0], "references"));
  writeFileSync(join(src, names[0], "SKILL.md"), "---\nname: wrong-name\ndescription: x\n---\n");
  assert.notEqual(run(src, ws).status, 0);
});

test("abandoned hidden staging tree is ignored; no existing skill is removed", (t) => {
  const { src, ws } = fixture(t);
  const stage = join(ws, "skills", "." + names[0] + ".new.abandoned");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "marker"), "prior interrupted staging");
  const result = run(src, ws);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(stage, "marker"), "utf8"), "prior interrupted staging");
  assert.ok(existsSync(join(location(ws, names[0]), "SKILL.md")));
});
