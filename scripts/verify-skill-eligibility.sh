#!/bin/bash
# Validate installation/eligibility of the basht-daftra skill against the pinned OpenClaw (isolated, offline, fake env).
#   scripts/verify-skill-eligibility.sh <dir containing node_modules/openclaw>
# Needs Node >= 24.22.1 / 26.12.1 (OpenClaw refuses older). Touches only a temp state/home/workspace.
set -euo pipefail
OC_DIR="${1:?usage: verify-skill-eligibility.sh <dir with node_modules/openclaw>}"
NODE_BIN="${NODE_BIN:-node}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/state" "$TMP/home" "$TMP/ws/skills"
cp -r "$ROOT/skills/basht-daftra" "$TMP/ws/skills/"
echo "{ agents: { defaults: { workspace: \"$TMP/ws\" } } }" > "$TMP/state/openclaw.json"
export OPENCLAW_STATE_DIR="$TMP/state" OPENCLAW_HOME="$TMP/home" OPENCLAW_CONFIG_PATH="$TMP/state/openclaw.json"
OC=("$NODE_BIN" "$OC_DIR/node_modules/openclaw/openclaw.mjs")
cd "$TMP"
info() { "${OC[@]}" skills info basht-daftra --json 2>/dev/null; }
field() { "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],j);console.log(JSON.stringify(v))})' "$1"; }

A="$(env -u DAFTRA_BASE_URL -u DAFTRA_API_KEY "${OC[@]}" skills info basht-daftra --json 2>/dev/null)"
B="$(DAFTRA_BASE_URL=https://smoke.daftra.com DAFTRA_API_KEY=fake-key-for-eligibility-check "${OC[@]}" skills info basht-daftra --json 2>/dev/null)"
fail=0
chk() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1 (got $2, want $3)"; fail=1; fi; }
chk "skill is discovered from the workspace"            "$(echo "$A" | field source)"            '"openclaw-workspace"'
chk "NOT eligible without DAFTRA_* (fail-safe gating)"   "$(echo "$A" | field eligible)"          'false'
chk "missing env reported"                               "$(echo "$A" | field missing.env)"       '["DAFTRA_BASE_URL","DAFTRA_API_KEY"]'
chk "eligible with the env present (fake values)"        "$(echo "$B" | field eligible)"          'true'
chk "no missing requirements when eligible"              "$(echo "$B" | field missing.env)"       '[]'
chk "node binary requirement satisfied"                  "$(echo "$B" | field missing.bins)"      '[]'
exit $fail
