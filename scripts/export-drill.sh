#!/bin/bash
# shellcheck disable=SC2016,SC2034
# Export -> restore drill for /setup Export + Import on a REAL image, with a LARGE synthetic data set.
# Measures time-to-first-byte, container memory during the export, behaviour when clients give up (orphans/leftovers),
# then restores onto an EMPTY volume and compares files. Usage: export-drill.sh <image> [MB of data, default 900]
set -uo pipefail
IMG="${1:?usage: export-drill.sh <image> [MB]}"; MB="${2:-900}"; P="${DRILL_PORT:-18893}"; PW=synthetic-export-drill-pw
D="$(mktemp -d)"; trap 'rm -rf "$D"; docker rm -f exA exB >/dev/null 2>&1; docker volume rm -f ex-a ex-b >/dev/null 2>&1' EXIT
B=$(printf "admin:$PW" | base64)
pass=0; fail=0; chk() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
health() { for _ in $(seq 1 "${2:-90}"); do curl -s http://127.0.0.1:$P/setup/healthz | grep -q "\"gatewayReachable\":$1" && return 0; sleep 2; done; return 1; }
up() { docker run -d --name "$1" -p $P:8080 -v "$2":/data -e SETUP_PASSWORD=$PW -e OPENCLAW_STATE_DIR=/data/.openclaw -e OPENCLAW_WORKSPACE_DIR=/data/workspace "$IMG" >/dev/null; }
mem() { docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{v=$1; u=v; gsub(/[0-9.]/,"",u); gsub(/[^0-9.]/,"",v); m=(u=="GiB")?v*1024:(u=="KiB")?v/1024:v; printf "%d", m}'; }
manifest() { docker exec "$1" bash -c 'cd /data && find .openclaw workspace \( -path .openclaw/cache -o -path .openclaw/tmp -o -path .openclaw/logs -o -path workspace/skills \) -prune -o -type f ! -name server.log ! -name "*-wal" ! -name "*-shm" ! -name "*.sqlite" ! -name "*.lock" -print0 | sort -z | xargs -0 sha256sum'; }
docker rm -f exA exB >/dev/null 2>&1; docker volume rm -f ex-a ex-b >/dev/null 2>&1

up exA ex-a; sleep 10
docker exec exA bash -c "set -e
mkdir -p /data/.openclaw/credentials/whatsapp/default /data/.openclaw/agents/main/agent /data/.openclaw/cache /data/workspace/memory /data/workspace/exports
echo '{\"gateway\":{\"mode\":\"local\"},\"note\":\"SYNTHETIC\"}' > /data/.openclaw/openclaw.json
echo '{\"me\":\"+10000000000\"}' > /data/.openclaw/credentials/whatsapp/default/creds.json
for i in \$(seq 1 30); do echo \"{\\\"k\\\":\$i}\" > /data/.openclaw/credentials/whatsapp/default/pre-key-\$i.json; done
echo '# MEMORY (synthetic)' > /data/workspace/MEMORY.md; echo note > /data/workspace/memory/2026-11-21.md
head -c 200000000 /dev/urandom > /data/.openclaw/cache/rebuildable.bin
for i in \$(seq 1 $((MB / 100))); do head -c 100000000 /dev/urandom > /data/workspace/exports/big-\$i.bin; done
chown -R openclaw:openclaw /data"
docker restart exA >/dev/null; chk "A: gateway up ($IMG, ~${MB} MB of data + 200 MB cache)" 'health true 120'
manifest exA > "$D/before.sha"
BASE=$(mem exA); echo "      container memory before export: ${BASE} MiB"

# -- a full export, sampling memory while it runs
( peak=0; while [ ! -e "$D/done" ]; do m=$(mem exA); [ "$m" -gt "$peak" ] && peak=$m && echo "$peak" > "$D/peak"; sleep 1; done ) &
curl -s -o "$D/export.zip" -w '%{http_code} %{time_starttransfer} %{time_total} %{size_download}\n' -H "Authorization: Basic $B" http://127.0.0.1:$P/setup/api/export > "$D/r"
touch "$D/done"; sleep 2; read -r CODE TTFB TOTAL SIZE < "$D/r"
echo "      export: HTTP $CODE, first byte ${TTFB}s, total ${TOTAL}s, ${SIZE} bytes, container memory peak $(cat "$D/peak" 2>/dev/null || echo "$BASE") MiB"
chk "A: export completes" '[ "$CODE" = 200 ] && unzip -tq -P $PW "$D/export.zip" >/dev/null'
chk "A: first byte within 5 s" 'awk "BEGIN{exit !($TTFB < 5)}"'
chk "A: no temp copy left in the container" '[ "$(docker exec exA bash -c "ls /tmp | grep -c openclaw-export")" = 0 ]'

# -- three phones giving up after 3 s
for _ in 1 2 3; do curl -s -o /dev/null -m 3 -H "Authorization: Basic $B" http://127.0.0.1:$P/setup/api/export 2>/dev/null; done
sleep 3
chk "A: abandoned exports leave no running zip" '[ "$(docker exec exA pgrep -c -x zip)" = 0 ]'
chk "A: abandoned exports leave no temp copies" '[ "$(docker exec exA bash -c "ls /tmp | grep -c openclaw-export")" = 0 ]'
chk "A: gateway never restarted during all this" '! docker logs exA 2>&1 | grep -q "exited code=null signal=SIGKILL"'
docker rm -f exA >/dev/null; docker volume rm -f ex-a >/dev/null

# -- restore onto an EMPTY volume
up exB ex-b; sleep 10
( peak=0; while [ ! -e "$D/done2" ]; do m=$(mem exB); [ "$m" -gt "$peak" ] && peak=$m && echo "$peak" > "$D/peak2"; sleep 1; done ) &
R=$(curl -s -w ' HTTP%{http_code}' -X POST -H "Authorization: Basic $B" -H "Content-Type: application/zip" -T "$D/export.zip" http://127.0.0.1:$P/setup/api/import)
touch "$D/done2"; sleep 2
echo "      import: $(echo "$R" | grep -o 'HTTP[0-9]*') of $(stat -c %s "$D/export.zip") bytes, container memory peak $(cat "$D/peak2" 2>/dev/null) MiB"
chk "B: import of the large archive accepted" 'echo "$R" | grep -q "\"ok\":true.*HTTP200"'
chk "B: gateway reachable after restore" 'health true 120'
manifest exB > "$D/after.sha"
chk "B: all $(wc -l < "$D/before.sha") protected files byte-identical" 'diff -q <(awk "{print \$2, \$1}" "$D/before.sha" | grep -v plugin-skills | sort) <(awk "{print \$2, \$1}" "$D/after.sha" | grep -v plugin-skills | sort) >/dev/null'
echo "RESULT pass=$pass fail=$fail"; [ "$fail" = 0 ]
