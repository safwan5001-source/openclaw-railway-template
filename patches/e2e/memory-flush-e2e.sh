#!/bin/bash
# End-to-end proof for the BASHT memory-flush owner-identity patch on the REAL OpenClaw 2026.11.10 runtime.
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
VERSION=2026.11.10
mkdir -p "$WORK"
echo "[e2e] workdir $WORK"

if [ ! -x "$WORK/base/node_modules/.bin/openclaw" ]; then
  mkdir -p "$WORK/base" && (cd "$WORK/base" && npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts "openclaw@$VERSION" >/dev/null)
fi
rm -rf "$WORK/patched" && cp -a "$WORK/base" "$WORK/patched"
node "$REPO/patches/openclaw-memory-flush-owner.mjs" "$WORK/patched/node_modules/openclaw"
for d in base patched; do
  f="$WORK/$d/node_modules/openclaw/dist/agent-command-DCE2yuWI.mjs"
  grep -q bashtE2eOrigCreateCommandMaintenanceFollowup "$f" || node "$HERE/instrument-cli-owner-run.mjs" "$f"
done

DATE=$(date -u +%F)
# One state template per install: config + the REAL @openclaw/whatsapp plugin, so OpenClaw resolves the
# "whatsapp:+E164" owner entries exactly as the production gateway does (no WhatsApp account is linked).
make_template() { # pkgdir -> $WORK/tmpl-<name>/state
  local pkg=$1 tmpl
  tmpl="$WORK/tmpl-$(basename "$1")"
  [ -f "$tmpl/.ready" ] && return 0
  rm -rf "$tmpl"; mkdir -p "$tmpl/state"
  cat > "$tmpl/state/openclaw.json" <<JSON
{
  "models": { "mode": "merge", "providers": { "fake": { "baseUrl": "http://127.0.0.1:18570/v1", "apiKey": "fake", "api": "openai-completions",
    "models": [ { "id": "m1", "name": "Fake", "reasoning": false, "input": ["text"], "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}, "contextWindow": 100000, "maxTokens": 4096 } ] } } },
  "agents": { "defaults": { "model": { "primary": "fake/m1" }, "workspace": "/placeholder", "compaction": { "memoryFlush": { "enabled": true } } },
    "entries": { "main": { "tools": { "alsoAllow": ["message", "browser"] } } } },
  "tools": { "profile": "coding", "toolsBySender": { "e164:$OWNER": { "allow": ["*"] }, "*": { "deny": ["write", "edit", "exec", "apply_patch"] } } },
  "channels": { "whatsapp": { "dmPolicy": "allowlist", "allowFrom": ["$OWNER"] } },
  "commands": { "ownerAllowFrom": ["whatsapp:$OWNER"] }
}
JSON
  (cd "$tmpl" && OPENCLAW_STATE_DIR="$tmpl/state" node "$pkg/node_modules/openclaw/openclaw.mjs" plugins install "@openclaw/whatsapp@$VERSION" >/dev/null)
  touch "$tmpl/.ready"
}

run_case() { # label pkgdir [env...]
  local label=$1 pkg=$2; shift 2
  local port=18570 r="$WORK/runs/$label"
  make_template "$pkg"
  rm -rf "$r"; mkdir -p "$r/ws"; cp -a "$WORK/tmpl-$(basename "$pkg")/state" "$r/state"
  local revoke=0; case " $* " in *" BASHT_E2E_REVOKE_OWNER=1 "*) revoke=1 ;; esac
  node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.agents.defaults.workspace=process.argv[2];if(process.argv[3]==="1")delete c.commands.ownerAllowFrom;require("fs").writeFileSync(f,JSON.stringify(c,null,2))' "$r/state/openclaw.json" "$r/ws" "$revoke"
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
  wait "$llm" 2>/dev/null || true
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

run_case A-upstream-owner         "$WORK/base"    BASHT_E2E_WHATSAPP_OWNER=$OWNER
run_case B-patched-owner          "$WORK/patched" BASHT_E2E_WHATSAPP_OWNER=$OWNER
run_case C-patched-spoofed-flag   "$WORK/patched" BASHT_E2E_WHATSAPP_OWNER=$OWNER BASHT_E2E_SENDER=$IMPOSTOR
run_case D-patched-non-owner      "$WORK/patched" BASHT_E2E_WHATSAPP_OWNER=$OWNER BASHT_E2E_OWNER_FLAG=0
run_case E-patched-cli-no-sender  "$WORK/patched"
# F: owner flag + owner number, but the owner was removed from commands.ownerAllowFrom (no authority, not configured)
run_case F-patched-owner-revoked  "$WORK/patched" BASHT_E2E_WHATSAPP_OWNER=$OWNER BASHT_E2E_REVOKE_OWNER=1

echo "---- results (A reproduces the production bug; B is the fix; C-F must stay read-only)"
check A-upstream-owner no
check B-patched-owner yes
check C-patched-spoofed-flag no
check D-patched-non-owner no
check E-patched-cli-no-sender no
check F-patched-owner-revoked no

# G: patches/owner-check.mjs against case B's REAL OpenClaw session store (SQLite + WAL written by real turns).
# Must say READY, print one line without digits, and leave every file byte-identical. Runs unprivileged (it refuses root).
owner_check_g() {
  local src="$WORK/runs/B-patched-owner" dst snap_before snap_after line runas=()
  dst=$(mktemp -d); cp -a "$src/state" "$dst/state"; mkdir -p "$dst/ws" "$dst/home"
  if [ "$(id -u)" = 0 ]; then
    if ! runuser -u nobody -- "$(command -v node)" -e 0 2>/dev/null; then echo "G-owner-check-real-sqlite     SKIP (root and cannot drop to nobody)"; rm -rf "$dst"; return 0; fi
    chown -R nobody: "$dst"; chmod a+rx "$dst"; runas=(runuser -u nobody --)
  fi
  snap() { find "$dst" -type f -printf '%p %s %T@\n' | sort; find "$dst" -type f -exec sha256sum {} + | sort; }
  snap_before=$(snap)
  line=$("${runas[@]}" env -i PATH="$PATH" HOME="$dst/home" OPENCLAW_STATE_DIR="$dst/state" OPENCLAW_WORKSPACE_DIR="$dst/ws" \
    OPENCLAW_PACKAGE_ROOT="$WORK/patched/node_modules/openclaw" node "$REPO/patches/owner-check.mjs" 2>&1)
  snap_after=$(snap)
  local ok=1
  [ "$(printf '%s\n' "$line" | wc -l)" = 1 ] || ok=0
  [[ "$line" == "BASHT_OWNER_CHECK "*'"VERDICT":"READY'* ]] || ok=0
  ! printf '%s' "$line" | grep -qE '[0-9]{7,}' || ok=0
  [ "$snap_before" = "$snap_after" ] || ok=0
  printf '%-28s verdict=%s filesUnchanged=%s => %s\n' "G-owner-check-real-sqlite" "$(printf '%s' "$line" | grep -o '"VERDICT":"[A-Z]*' | cut -d'"' -f4)" \
    "$([ "$snap_before" = "$snap_after" ] && echo yes || echo NO)" "$([ $ok = 1 ] && echo PASS || echo FAIL)"
  rm -rf "$dst"
  [ $ok = 1 ] || FAIL=1
}
owner_check_g
exit $FAIL
