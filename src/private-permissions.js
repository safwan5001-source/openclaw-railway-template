import fs from "node:fs";
import path from "node:path";

// Restored OpenClaw state must be private to the service user. OpenClaw 2026.11.10 refuses to start when its client
// credential directory (<state>/client) is reachable by group/other ("Client credential directory is unsafe"), and an
// import ZIP carries no directory entries (zip -D), so `unzip` creates every directory with the umask default (0755).
// This only ever REMOVES access: directories become 0700 and files lose their group/other bits (owner bits kept).
// Symlinks are never followed or changed (the import has already rejected them); anything else is left alone.
export function restrictToOwner(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return 0;
  let changed = 0;
  const visit = (target, st) => {
    if (st.isDirectory()) {
      if ((st.mode & 0o7777) !== 0o700) {
        fs.chmodSync(target, 0o700);
        changed++;
      }
      for (const name of fs.readdirSync(target)) {
        const child = path.join(target, name);
        visit(child, fs.lstatSync(child));
      }
    } else if (st.isFile() && (st.mode & 0o077) !== 0) {
      fs.chmodSync(target, st.mode & 0o7700);
      changed++;
    }
  };
  visit(root, stat);
  return changed;
}
