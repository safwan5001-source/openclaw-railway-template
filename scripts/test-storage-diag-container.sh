#!/bin/bash
# shellcheck disable=SC2016,SC2034  # chk() evals its single-quoted conditions; variables are used there
# Container integration test for the opt-in storage heartbeat (src/storage-diagnostics.js) on the REAL OpenClaw image,
# SYNTHETIC data only. Usage: test-storage-diag-container.sh <image> [files=40000]
#
# Seeds a fresh volume with sessions, memory, WhatsApp creds, backups, secrets, OpenClaw doctor snapshots and
# tmp/plugin-captures (every file carries a canary string; names carry a phone number), configures a local gateway, then:
#   1. DIAG_STORAGE=0  -> no [storage-diag] line at all, gateway healthy
#   3. DIAG_STORAGE_ROOT inside a protected tree (workspace/memory) -> anonymous totals only, no names, no candidates
#   2. DIAG_STORAGE=1  -> exactly one "enabled" line + 2 JSON lines after the first scan; recovery bucket populated;
#                         no canary / protected / identifying name in any log; seeded files byte-identical afterwards;
#                         wrapper + gateway healthy, /setup/healthz latency and container CPU/RAM sampled during the scan
set -uo pipefail
IMG="${1:?usage: test-storage-diag-container.sh <image> [files]}"; FILES="${2:-40000}"
N=bashtdiag; P="${DIAG_PORT:-18990}"; PW=synthetic-diag-pw; TOK=synthetic-diag-gateway-token-0123456789
CANARY=CANARY_DIAG_SECRET_7c1e; PHONE=966501234567
pass=0; fail=0; ok() { echo "PASS  $1"; pass=$((pass+1)); }; ko() { echo "FAIL  $1"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }
cleanup() { docker rm -f $N >/dev/null 2>&1; docker volume rm -f ${N}-data >/dev/null 2>&1; }
cleanup; trap cleanup EXIT

run() { docker run -d --name $N -p $P:8080 -v ${N}-data:/data -e SETUP_PASSWORD=$PW -e OPENCLAW_GATEWAY_TOKEN=$TOK \
  -e OPENCLAW_STATE_DIR=/data/.openclaw -e OPENCLAW_WORKSPACE_DIR=/data/workspace "$@" "$IMG" >/dev/null; }
wait_gw() { for _ in $(seq 1 90); do curl -s http://127.0.0.1:$P/setup/healthz | grep -q '"gatewayReachable":true' && return 0; sleep 2; done; return 1; }
logs() { docker logs $N 2>&1; }

# ---- seed the volume (as the openclaw user, before first boot of the wrapper)
docker run --rm -v ${N}-data:/data --entrypoint bash "$IMG" -c "chown openclaw:openclaw /data" >/dev/null
docker run --rm -u openclaw -v ${N}-data:/data --entrypoint node "$IMG" -e '
  const fs = require("fs"), path = require("path");
  const [C, PH, NF] = [process.argv[1], process.argv[2], Number(process.argv[3])];
  const old = new Date(Date.now() - 30 * 864e5);
  const put = (rel, n = 2048) => { const p = path.join("/data", rel); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, (C + " ").repeat(Math.ceil(n / C.length)).slice(0, n)); fs.utimesSync(p, old, old); };
  fs.mkdirSync("/data/.openclaw", { recursive: true });
  fs.writeFileSync("/data/.openclaw/openclaw.json", JSON.stringify({ gateway: { mode: "local" } }));
  put(`.openclaw/agents/main/sessions/${PH}.jsonl`); put(`.openclaw/agents/main/sessions/${PH}.jsonl.pre-doctor-branch-repair-2026-11-01T10-00-00-000Z.bak`);
  put(`.openclaw/credentials/whatsapp/default/creds.json`); put(`.openclaw/credentials/whatsapp/default/creds.json.bak`);
  put("workspace/MEMORY.md"); put(`workspace/memory/${PH}.md`); put("workspace/memory/Alice/notes.md.bak"); put("workspace/memory/Alice/draft.tmp"); put("workspace/AGENTS.md.doctor-backup-2026-11-01T10-00-00-000Z");
  put("workspace/customers.sqlite.bak"); put("backups/basht-backup-2026-11-01.bkp"); put("workspace/.env.local");
  put(".openclaw/logs/config-audit.jsonl.migrated.raw"); put(`workspace/notes-${PH}.md.migrated-2026-11-01`);
  for (let i = 0; i < 50; i++) put(`.openclaw/tmp/plugin-captures/inst1/captures/pkg${i % 5}/f${i}.js`, 8192);
  put(".openclaw/tmp/old-download.tmp"); put("workspace/scratch.md.bak");
  for (let i = 0; i < NF; i++) put(`workspace/bulk/d${i % 200}/f${i}.txt`, 512);
' "$CANARY" "$PHONE" "$FILES"
# Hash (path + content) of every seeded sensitive/recovery file -- the ones carrying the canary, bulk excluded -- taken
# inside the running container right before the first scan, because the wrapper's boot-time `openclaw doctor --fix`
# legitimately migrates some of them and the live gateway writes its own files (that is OpenClaw, not the scan).
HASH_CMD="cd /data && grep -rlZ --exclude-dir=bulk --exclude-dir=.linuxbrew $CANARY . | sort -z | xargs -0 sha256sum | tee /tmp/diag-seeded.sha | sha256sum"

# ---- 1. DIAG_STORAGE=0
run -e DIAG_STORAGE=0
chk "DIAG_STORAGE=0: gateway healthy" 'wait_gw'
sleep 100   # past the 90 s first-scan delay
chk "DIAG_STORAGE=0: no [storage-diag] line" '[ "$(logs | grep -c "storage-diag")" = 0 ]'
docker rm -f $N >/dev/null

# ---- 2. DIAG_STORAGE=1
# The baseline hash has to be taken after the boot-time `openclaw doctor --fix` and gateway start (wait_gw, <= 180 s)
# but BEFORE the first scan. With the production default (90 s) a slow runner lost that race (gateway reachable ~112 s
# after start on a GitHub runner, first scan at 90 s), so the first scan is delayed past the wait_gw bound here.
run -e DIAG_STORAGE=1 -e DIAG_STORAGE_INTERVAL_HOURS=6 -e DIAG_STORAGE_FIRST_DELAY_SEC=240
chk "DIAG_STORAGE=1: gateway healthy" 'wait_gw'
chk "DIAG_STORAGE=1: one 'enabled' line" '[ "$(logs | grep -c "storage-diag.*enabled root=/data every 6h .*first scan after 240s")" = 1 ]'
GW0=$(docker exec $N pgrep -f openclaw-gateway | head -1)
SEED_SUM=$(docker exec $N bash -c "$HASH_CMD")
chk "baseline hash taken before the first scan" '[ "$(logs | grep -c "\[storage-diag\] {")" = 0 ]'
LAT=$(mktemp); STATS=$(mktemp)
DONE=$(mktemp -u)
( while [ ! -e "$DONE" ]; do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:$P/setup/healthz; sleep 0.2; done ) > "$LAT" &
( while [ ! -e "$DONE" ]; do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' $N; done ) > "$STATS" &
for _ in $(seq 1 200); do [ "$(logs | grep -c '\[storage-diag\] {')" -ge 2 ] && break; sleep 2; done   # <= 400 s (scan fires at 240 s)
sleep 3; touch "$DONE"
wait; rm -f "$DONE"
SUMMARY=$(logs | grep '\[storage-diag\] {"v":1,"ts":[^,]*,"level"' | head -1 | sed 's/.*\[storage-diag\] //')
echo "summary: $SUMMARY"
echo "detail:  $(logs | grep '\[storage-diag\] {"v":1,"ts":[^,]*,"dirs"' | head -1 | sed 's/.*\[storage-diag\] //' | cut -c1-400)..."
chk "first scan: exactly 2 JSON lines" '[ "$(logs | grep -c "\[storage-diag\] {")" = 2 ]'
chk "summary: recovery.doctor counts seeded snapshots + OpenClaw's own .update-captures (>4)" 'echo "$SUMMARY" | node -e "const s=JSON.parse(require(\"fs\").readFileSync(0));process.exit(s.recovery.doctor.n>4&&s.recovery.doctor.mb>0?0:1)"'
chk "summary: recovery.pluginCaptures >= 50 seeded (+ OpenClaw's own)" 'echo "$SUMMARY" | node -e "const s=JSON.parse(require(\"fs\").readFileSync(0));process.exit(s.recovery.pluginCaptures.n>=50?0:1)"'
chk "detail: no update-captures or capture-run names printed" '! logs | grep storage-diag | grep -qE "update-captures|plugin-captures/|inst1"'
chk "summary: backups/secrets never candidates (backup candidates = scratch.md.bak only)" 'echo "$SUMMARY" | node -e "const s=JSON.parse(require(\"fs\").readFileSync(0));process.exit(s.candidates.backup.n===1&&s.protectedMB>0?0:1)"'
chk "no canary, phone number, protected or snapshot name in any log" '! logs | grep -E "$CANARY|$PHONE|MEMORY|creds|sessions|whatsapp|\.bkp|basht-backup|pre-doctor|doctor-backup|migrated|\.env|customers|$TOK|$PW" | grep -q storage-diag && ! docker exec $N grep -E "$CANARY|$PHONE" /data/.openclaw/server.log 2>/dev/null | grep -q .'
chk "no warning/error from storage-diag" '! logs | grep "storage-diag" | grep -qiE "WARN|ERROR|scan failed"'
echo "seeded sensitive/recovery files hashed: $(docker exec $N bash -c 'wc -l < /tmp/diag-seeded.sha')"
chk "protected/recovery files byte-identical across the scan" '[ "$(docker exec $N bash -c "$HASH_CMD")" = "$SEED_SUM" ]'
chk "gateway process not restarted by the scan" '[ -n "$GW0" ] && [ "$(docker exec $N pgrep -f openclaw-gateway | head -1)" = "$GW0" ]'
chk "gateway still reachable after the scan" 'wait_gw'
chk "every healthz request = 200 during the scan window" '[ "$(grep -c . "$LAT")" -gt 50 ] && [ "$(grep -vc "^200 " "$LAT")" = 0 ]'
echo "healthz latency from baseline until the scan finished (s): $(cut -d" " -f2 "$LAT" | sort -n | awk '{a[NR]=$1} END {printf "n=%d p50=%s p99=%s max=%s", NR, a[int(NR*0.5)], a[int(NR*0.99)], a[NR]}')"
echo "container CPU/RAM samples (min/max): $(awk '{gsub("%","",$1); v=$1+0; if(NR==1||v<min)min=v; if(v>max)max=v; m=$2} END {printf "cpu %.1f%%..%.1f%% (n=%d), mem(last) %s", min, max, NR, m}' "$STATS")"
echo "storage-diag lines total: $(logs | grep -c storage-diag)"
rm -f "$LAT" "$STATS"
docker rm -f $N >/dev/null

# ---- 3. DIAG_STORAGE_ROOT inside a protected tree (regression: protection used to be lost when the root was narrowed)
run -e DIAG_STORAGE=1 -e DIAG_STORAGE_ROOT=/data/workspace/memory -e DIAG_STORAGE_FIRST_DELAY_SEC=30
chk "protected root: gateway healthy" 'wait_gw'
for _ in $(seq 1 90); do [ "$(logs | grep -c '\[storage-diag\] {')" -ge 2 ] && break; sleep 2; done
PSUM=$(logs | grep '\[storage-diag\] {"v":1,"ts":[^,]*,"level"' | head -1 | sed 's/.*\[storage-diag\] //')
PDET=$(logs | grep '\[storage-diag\] {"v":1,"ts":[^,]*,"dirs"' | head -1 | sed 's/.*\[storage-diag\] //')
echo "protected-root summary: $PSUM"
chk "protected root: exactly 2 JSON lines" '[ "$(logs | grep -c "\[storage-diag\] {")" = 2 ]'
chk "protected root: the enabled line does not print the protected path" '[ "$(logs | grep -c "storage-diag.*enabled root=/data/workspace/<protected> every 6h")" = 1 ]'
chk "protected root: everything is an anonymous protected total, nothing is a cleanup candidate" 'echo "$PSUM" | node -e "const s=JSON.parse(require(\"fs\").readFileSync(0));const c=s.candidates;process.exit(s.scan.files>=3&&Object.values(c).every(x=>x.n===0)&&s.possibleDupes.n===0&&s.activeExcluded.n===0?0:1)"'
chk "protected root: detail has the single anonymous row" 'echo "$PDET" | node -e "const d=JSON.parse(require(\"fs\").readFileSync(0));process.exit(d.dirs.length===1&&d.dirs[0].p===\"/<protected>\"&&d.sub.length===0?0:1)"'
chk "protected root: no folder/person name, phone number, canary or protected path in any storage-diag line" '! logs | grep storage-diag | grep -qE "Alice|memory|MEMORY|$PHONE|$CANARY|notes|draft|sessions|whatsapp|creds"'
echo "---- $pass passed, $fail failed"
[ "$fail" = 0 ]
