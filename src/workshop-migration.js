import fs from "node:fs";
import crypto from "node:crypto";

// Only the exact disabled legacy setting observed on the affected installation.
export function migrateDisabledWorkshop(file) {
  const original = fs.readFileSync(file, "utf8");
  const config = JSON.parse(original);
  const workshop = config?.skills?.workshop;
  if (workshop === undefined) return false;
  if (!workshop || Object.keys(workshop).length !== 1 ||
      !workshop.autonomous || Object.keys(workshop.autonomous).length !== 1 ||
      workshop.autonomous.mode !== "off") {
    throw new Error("Unexpected legacy workshop configuration; refusing automatic migration");
  }
  delete config.skills.workshop;
  const suffix = crypto.randomUUID();
  const backup = file + ".pre-workshop-migration-" + suffix + ".bak";
  const tmp = file + ".migration-" + suffix + ".tmp";
  fs.writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (fs.readFileSync(file, "utf8") !== original) throw new Error("Configuration changed during migration");
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return true;
}
