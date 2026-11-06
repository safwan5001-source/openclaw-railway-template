// Output-path confinement for exports. All generated files must live in the private
// `<workspace>/exports` directory, never in a public web root or outside the workspace.
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function exportsDir(env = process.env) {
  return resolve(env.OPENCLAW_WORKSPACE_DIR || '/data/workspace', 'exports');
}

export function ensureExportsDir(env = process.env) {
  const dir = exportsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Build a safe file name from an arbitrary label: `<base>-<UTC timestamp>.<ext>`.
export function safeFileName(base, ext, now = new Date()) {
  if (!/^[a-z0-9]{2,5}$/.test(ext)) throw Error('Invalid extension');
  const cleaned = String(base).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'daftra-export';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return cleaned + '-' + stamp + '.' + ext;
}

function inside(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}

// Returns the resolved absolute output path, or throws. The file itself must not exist yet
// (writers use flag 'wx'), so only the parent directory is resolved through symlinks.
export function safeOutputPath(output, ext, env = process.env) {
  if (typeof output !== 'string' || !output || output.includes('\0')) throw Error('Invalid output filename');
  if (!/^[a-z0-9]{2,5}$/.test(ext)) throw Error('Invalid extension');
  const path = resolve(output);
  const base = exportsDir(env);
  if (!path.startsWith(base + sep)) throw Error('Output must be in private exports directory');
  const name = basename(path);
  if (!name.endsWith('.' + ext) || name.length <= ext.length + 1) throw Error('Output must end with .' + ext);
  if (!NAME_RE.test(name)) throw Error('Invalid output filename: use letters, digits, dot, dash, underscore');
  let realBase;
  let realParent;
  try {
    realBase = realpathSync(base);
    realParent = realpathSync(dirname(path));
  } catch {
    throw Error('Output must be in private exports directory (directory does not exist)');
  }
  if (!inside(realBase, realParent)) throw Error('Output must be in private exports directory (symlink escape)');
  return resolve(realParent, name);
}
