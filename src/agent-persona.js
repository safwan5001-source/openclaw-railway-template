// Seeds the agent persona files and applies optional agent defaults from environment variables.
// Never overwrites operator-edited persona files, never touches secrets, never fatal to gateway startup.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PERSONA_DIR = path.join(HERE, "persona");
export const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"];

const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/;
const THINKING_RE = /^[a-z]{2,10}$/;
const EXEC_RE = /^\/[A-Za-z0-9._/-]{1,120}$/;
export const DEFAULT_CHROMIUM = "/usr/bin/chromium"; // installed by the Dockerfile (apt chromium)

/** Copy missing persona files into the workspace. Existing files (even empty) and symlinks are left alone. */
export function seedPersonaFiles(workspaceDir, { sourceDir = PERSONA_DIR, disabled = process.env.OPENCLAW_PERSONA_SEED === "0" } = {}) {
  const result = { created: [], skipped: [], errors: [] };
  if (disabled) return { ...result, skipped: [...PERSONA_FILES] };
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (fs.lstatSync(workspaceDir).isSymbolicLink()) {
    result.errors.push("workspace is a symlink");
    return result;
  }
  for (const name of PERSONA_FILES) {
    const target = path.join(workspaceDir, name);
    try {
      const content = fs.readFileSync(path.join(sourceDir, name), "utf8");
      fs.writeFileSync(target, content, { flag: "wx", mode: 0o644 });
      result.created.push(name);
    } catch (err) {
      if (err.code === "EEXIST") result.skipped.push(name);
      else result.errors.push(`${name}: ${err.code || err.message}`);
    }
  }
  return result;
}

/** Config keys to set, derived only from explicitly provided env vars. Invalid values are ignored with a warning. */
export function buildAgentDefaults(env = process.env) {
  const sets = [];
  const warnings = [];
  const model = env.OPENCLAW_DEFAULT_MODEL?.trim();
  if (model) {
    if (MODEL_RE.test(model)) sets.push({ key: "agents.defaults.model.primary", value: model });
    else warnings.push("OPENCLAW_DEFAULT_MODEL ignored: expected <provider>/<model>");
  }
  const thinking = env.OPENCLAW_THINKING_DEFAULT?.trim().toLowerCase();
  if (thinking) {
    if (THINKING_RE.test(thinking)) sets.push({ key: "agents.defaults.thinkingDefault", value: thinking });
    else warnings.push("OPENCLAW_THINKING_DEFAULT ignored: expected a level such as off|low|medium|high");
  }
  // Managed headless browser for the agent's `browser` tool (container: headless, no sandbox as non-root).
  if (env.OPENCLAW_BROWSER?.trim() === "1") {
    const exe = env.OPENCLAW_BROWSER_EXECUTABLE?.trim() || DEFAULT_CHROMIUM;
    if (EXEC_RE.test(exe) && !exe.includes("..")) {
      sets.push(
        { key: "browser.enabled", value: true },
        { key: "browser.headless", value: true },
        { key: "browser.noSandbox", value: true },
        { key: "browser.defaultProfile", value: "openclaw" },
        { key: "browser.executablePath", value: exe },
      );
    } else {
      warnings.push("OPENCLAW_BROWSER_EXECUTABLE ignored: expected an absolute path; browser not configured");
    }
  }
  return { sets, warnings };
}

/** Apply defaults through the CLI (same path the wrapper already uses). `run(args)` resolves {code}. */
export async function applyAgentDefaults(run, env = process.env, log = console) {
  const { sets, warnings } = buildAgentDefaults(env);
  for (const w of warnings) log.warn?.("persona", w);
  for (const { key, value } of sets) {
    const r = await run(["config", "set", "--json", key, JSON.stringify(value)]);
    if (r.code === 0) log.info?.("persona", `set ${key}`);
    else log.warn?.("persona", `failed to set ${key} (exit=${r.code})`);
  }
  return sets.map((s) => s.key);
}
