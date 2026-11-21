#!/bin/bash
# End-to-end proof for the BASHT memory-flush owner-identity patch on the REAL OpenClaw 2026.10.9 runtime.
#
#   bash patches/e2e/memory-flush-e2e.sh [workdir]
#
# Installs the pinned OpenClaw twice into <workdir> (upstream baseline + BASHT-patched), points both at a local
# scripted model (fake-llm.mjs, 127.0.0.1 only) and drives three real `openclaw agent --local` turns per case:
#   1. owner states a fact            (fake model reports a huge prompt so the next turn must compact)
#   2. next turn                      -> pre-compaction memory flush -> compaction (summary)
#   3. "RECALL" turn                  -> model reads memory/<date>.md and answers from it
# TEST-ONLY instrumentation (instrument-cli-owner-run.mjs, applied identically to both installs) gives the CLI
# maintenance run the same fields a WhatsApp owner reply turn carries (senderIsOwner, SenderId/SenderE164,
# provider whatsapp). No WhatsApp, no Railway, no real model, no network beyond the npm install.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WORK=${1:-$(mktemp -d)}
OWNER=+15550001234
IMPOSTOR=+19990001111
VERSION=2026.10.9
mkdir -p "$WORK"
echo "[e2e] workdir $WORK"

if [ ! -x "$WORK/base/node_modules/.bin/openclaw" ]; then
  mkdir -p "$WORK/base" && (cd "$WORK/base" && npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts "openclaw@$VERSION" >/dev/null)
fi
rm -rf "$WORK/patched" && cp -a "$WORK/base" "$WORK/patched"
node "$REPO/patches/openclaw-memory-flush-owner.mjs" "$WORK/patched/node_modules/openclaw"
for d in base patched; do
  f="$WORK/$d/node_modules/openclaw/dist/agent-command-B2Fr8yPI.mjs"
  grep -q bashtE2eOrigCreateCommandMaintenanceFollowup "$f" || node "$HERE/instrument-cli-owner-run.mjs" "$f"
done

DATE=$(date -u +%F)
run_case() { # label pkgdir port [env...]
  local label=$1 pkg=$2 port=$3; shift 3
  local r="$WORK/runs/$label"; rm -rf "$r"; mkdir -p "$r/state" "$r/ws"
  cat > "$r/state/openclaw.json" <<JSON
{
  "models": { "mode": "merge", "providers": { "fake": { "baseUrl": "http://127.0.0.1:$port/v1", "apiKey": "fake", "api": "openai-completions",
    "models": [ { "id": "m1", "name": "Fake", "reasoning": false, "input": ["text"], "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}, "contextWindow": 100000, "maxTokens": 4096 } ] } } },
  "agents": { "defaults": { "model": { "primary": "fake/m1" }, "workspace": "$r/ws", "compaction": { "memoryFlush": { "enabled": true } } },
    "entries": { "main": { "tools": { "alsoAllow": ["message", "browser"] } } } },
  "tools": { "profile": "coding", "toolsBySender": { "e164:$OWNER": { "allow": ["*"] }, "*": { "deny": ["write", "edit", "exec", "apply_patch"] } } },
  "channels": { "whatsapp": { "dmPolicy": "allowlist", "allowFrom": ["$OWNER"] } },
  "commands": { "ownerAllowFrom": ["whatsapp:$OWNER"] }
}
JSON
  LOG="$r/llm.jsonl" PORT=$port RECALL_PATH="memory/$DATE.md" node "$HERE/fake-llm.mjs" > "$r/llm.out" 2>&1 &
  local llm=$!
  sleep 1
  local msg
  for msg in "remember that the warehouse gate code is ZEBRA-4417" "second turn to push context over the compaction threshold" "RECALL: what is the warehouse gate code?"; do
    env OPENCLAW_STATE_DIR="$r/state" OPENCLAW_WORKSPACE_DIR="$r/ws" OPENCLAW_LOG_LEVEL=debug "$@" \
      timeout 300 node "$pkg/node_modules/openclaw/openclaw.mjs" agent --local --session-key "agent:main:whatsapp:direct:$OWNER" --json -m "$msg" >> "$r/agent.out" 2>&1 \
      || echo "exit=$?" >> "$r/agent.out"
  done
  kill "$llm" 2>/dev/null || true
}

FAIL=0
check() { # label expect_write expect_recall
  local r="$WORK/runs/$1" tools file recall
  tools=$(grep '"phase":"flush"' "$r/llm.jsonl" | head -1 | sed 's/.*"tools":\(\[[^]]*\]\).*/\1/')
  file=$(cat "$r/ws/memory/$DATE.md" 2>/dev/null || true)
  recall=$(grep -ao 'RECALLED: [A-Z0-9-]*' "$r/agent.out" | head -1 || true)
  local compacted; compacted=$(grep -ac 'outcome=compacted' "$r/agent.out" || true)
  local ok=1
  if [ "$2" = yes ]; then [ "$tools" = '["read","write"]' ] && [[ "$file" == *ZEBRA-4417* ]] && [ "$recall" = "RECALLED: ZEBRA-4417" ] || ok=0
  else [ "$tools" = '["read"]' ] && [[ "$file" != *ZEBRA-4417* ]] || ok=0; fi
  [ "$compacted" -ge 1 ] || ok=0
  printf '%-28s flushTools=%-17s saved=%-3s compactions=%s recall=%s => %s\n' "$1" "$tools" "$([[ "$file" == *ZEBRA* ]] && echo yes || echo no)" "$compacted" "${recall:-none}" "$([ $ok = 1 ] && echo PASS || echo FAIL)"
  [ $ok = 1 ] || FAIL=1
}

run_case A-upstream-owner        "$WORK/base"    18571 BASHT_E2E_WHATSAPP_OWNER=$OWNER
run_case B-patched-owner         "$WORK/patched" 18572 BASHT_E2E_WHATSAPP_OWNER=$OWNER
run_case C-patched-spoofed-flag  "$WORK/patched" 18573 BASHT_E2E_WHATSAPP_OWNER=$OWNER BASHT_E2E_SENDER=$IMPOSTOR
run_case D-patched-non-owner     "$WORK/patched" 18574 BASHT_E2E_WHATSAPP_OWNER=$OWNER BASHT_E2E_OWNER_FLAG=0
run_case E-patched-cli-no-sender "$WORK/patched" 18575

echo "---- results (A reproduces the production bug; B is the fix; C-E must stay read-only)"
check A-upstream-owner no
check B-patched-owner yes
check C-patched-spoofed-flag no
check D-patched-non-owner no
check E-patched-cli-no-sender no
exit $FAIL
