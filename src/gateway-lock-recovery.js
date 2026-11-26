// A restored state archive may carry the Gateway owner lease of the instance it was copied from (a live export is taken
// while that Gateway runs). OpenClaw 2026.11.10 keeps such a lease from another PID namespace/host protected for good
// ("cannot verify Gateway ownership from this process"), so the Gateway of the restored instance would never start.
// OpenClaw's documented operator recovery is `openclaw gateway recover-lock` (inspect) followed by the exact
// `--confirm <fingerprint>` it prints; it refuses a locally verified live holder and any record that changed in between.
//
// This runs ONLY from the import route, after the restored tree is in place and while our own Gateway is stopped under the
// wrapper's maintenance lock, so a lease still present cannot belong to this instance: it describes the source of the copy,
// which keeps running on its own volume. It uses only the official command with the fingerprint from the same inspection.
// Any failure is returned, never thrown, and never blocks the import (the Gateway then starts or waits exactly as before).
const FINGERPRINT = /^[a-f0-9]{64}$/;

function parseInspection(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** @param run async (args: string[]) => ({ code: number, output: string }) executing the OpenClaw CLI for this state dir */
export async function recoverRestoredGatewayLock(run) {
  let inspection;
  try {
    inspection = parseInspection((await run(["gateway", "recover-lock", "--json"])).output);
  } catch (err) {
    return { recovered: false, reason: `inspection failed: ${err.message}` };
  }
  if (!inspection || typeof inspection !== "object") return { recovered: false, reason: "inspection output unreadable" };
  if (inspection.present !== true) return { recovered: false, reason: "no foreign owner recorded" };
  const holders = Array.isArray(inspection.holders) ? inspection.holders.length : 0;
  if (typeof inspection.confirmation !== "string" || !FINGERPRINT.test(inspection.confirmation)) {
    return { recovered: false, holders, reason: "inspection returned no valid confirmation" };
  }
  try {
    const done = await run(["gateway", "recover-lock", "--confirm", inspection.confirmation]);
    return done.code === 0 ? { recovered: true, holders } : { recovered: false, holders, reason: `recovery exited ${done.code}` };
  } catch (err) {
    return { recovered: false, holders, reason: `recovery failed: ${err.message}` };
  }
}
