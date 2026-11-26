#!/usr/bin/env bash
# Isolated compatibility acceptance: no production config, no Gateway, no real services.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/state" "$TMP/ws/skills"
export HOME="$TMP/home"
export OPENCLAW_HOME="$TMP/home"
export OPENCLAW_STATE_DIR="$TMP/state"
export OPENCLAW_CONFIG_PATH="$TMP/state/openclaw.json"
export OPENCLAW_WORKSPACE_DIR="$TMP/ws"
cat >"$OPENCLAW_CONFIG_PATH" <<EOF
{ agents: { defaults: { workspace: "$TMP/ws" } } }
EOF
NAMES=(
  basht-market-intelligence basht-marketing-strategy basht-creative-direction
  basht-social-media basht-ads-campaigns basht-performance-analytics
  basht-video-creative basht-local-seo basht-conversion-optimization
  basht-marketing-automation
)
for name in "${NAMES[@]}"; do
  cp -R "$ROOT/skills/$name" "$TMP/ws/skills/$name"
done
for name in basht-daftra basht-accounting; do
  cp -R "$ROOT/skills/$name" "$TMP/ws/skills/$name"
done
if ! openclaw --version | grep -Fq '2026.11.10'; then
  echo "FAIL: OpenClaw version mismatch" >&2; exit 1
fi
for name in "${NAMES[@]}" basht-accounting; do
  output="$(openclaw skills info "$name" --json)"
  NAME="$name" node -e '
    let x="";process.stdin.on("data",c=>x+=c).on("end",()=>{
      const j=JSON.parse(x);
      if(j.name!==process.env.NAME || j.source!=="openclaw-workspace" || j.eligible!==true) {
        console.error("FAIL",process.env.NAME,"name/source/eligibility",j.name,j.source,j.eligible);
        process.exit(1);
      }
      console.log("PASS discovered and eligible:",j.name);
    });
  ' <<< "$output"
done
# Daftra has a separate environment requirement; prove it is NOT inadvertently eligible.
output="$(env -u DAFTRA_BASE_URL openclaw skills info basht-daftra --json)"
node -e '
  let x="";process.stdin.on("data",c=>x+=c).on("end",()=>{
    const j=JSON.parse(x);
    if(j.name!=="basht-daftra" || j.source!=="openclaw-workspace" || j.eligible!==false ||
       !j.missing?.env?.includes("DAFTRA_BASE_URL")) {
      console.error("FAIL: Daftra eligibility isolation",j.name,j.source,j.eligible);
      process.exit(1);
    }
    console.log("PASS Daftra remains gated by its env requirement");
  });
' <<< "$output"
echo "PASS OpenClaw discovery: 10 marketing skills + accounting; Daftra retains its guard."
