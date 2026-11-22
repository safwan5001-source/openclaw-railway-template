#!/bin/bash
# shellcheck disable=SC2016,SC2034,SC2120
# Container smoke test of the OpenClaw image with SYNTHETIC env only. Usage: container-smoke.sh <image>
set -uo pipefail
EXP="$(mktemp)"; trap 'rm -f "$EXP"' EXIT
IMG="${1:?usage: smoke-openclaw-image.sh <image>}"; N=bashtsmoke; P="${SMOKE_PORT:-18888}"; PW=synthetic-container-pw; TOK=synthetic-container-gateway-token-01234567
B=$(printf "admin:$PW" | base64)
pass=0; fail=0; ok() { echo "PASS  $1"; pass=$((pass+1)); }; ko() { echo "FAIL  $1"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }
docker rm -f $N >/dev/null 2>&1; docker volume rm -f ${N}-data >/dev/null 2>&1
run() { docker run -d --name $N -p $P:8080 -v ${N}-data:/data -e SETUP_PASSWORD=$PW -e OPENCLAW_GATEWAY_TOKEN=$TOK \
  -e OPENCLAW_STATE_DIR=/data/.openclaw -e OPENCLAW_WORKSPACE_DIR=/data/workspace -e RAILWAY_PUBLIC_DOMAIN=smoke.example "$@" "$IMG" >/dev/null; }
wait_health() { for i in $(seq 1 ${1:-90}); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$P/setup/healthz); [ "$c" = 200 ] && return 0; sleep 2; done; return 1; }

# ---- image contents
chk "openclaw pinned 2026.10.9" '[ "$(docker run --rm --entrypoint openclaw $IMG --version | grep -c "2026.10.9")" = 1 ]'
chk "clawhub pinned 0.27.0" 'docker run --rm --entrypoint npm $IMG ls -g clawhub 2>/dev/null | grep -q "clawhub@0.27.0"'
chk "chromium + Arabic Naskh font present" 'docker run --rm --entrypoint bash $IMG -c "command -v chromium && fc-match \"Noto Naskh Arabic\" | grep -qi NotoNaskhArabic" >/dev/null'
chk "no SETUP_PASSWORD / gateway token baked into image env" '! docker image inspect $IMG --format "{{json .Config.Env}}" | grep -qiE "SETUP_PASSWORD|GATEWAY_TOKEN|DAFTRA_API|APPROVAL"'

# ---- fresh volume boot (unconfigured)
run; chk "fresh volume: boots and /setup/healthz = 200" 'wait_health'
chk "entrypoint copied Homebrew to the volume and symlinked it" 'docker exec $N bash -c "[ -x /data/.linuxbrew/bin/brew ] && [ -L /home/linuxbrew/.linuxbrew ] && [ ! -e /data/.linuxbrew.partial ]"'
chk "wrapper runs as the unprivileged openclaw user" '[ "$(docker exec $N ps -o user= -p "$(docker exec $N pgrep -f "node src/server.js" | head -1)" | tr -d " ")" = openclaw ]'
chk "/setup requires the password (401 anonymous, 200 with it)" '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:$P/setup)" = 401 ] && [ "$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Basic $B" http://127.0.0.1:$P/setup)" = 200 ]'
chk "export of an unconfigured instance (zip with password) works" '[ "$(curl -s -o "$EXP" -w %{http_code} -H "Authorization: Basic $B" http://127.0.0.1:$P/setup/api/export)" = 200 ] && unzip -tq -P $PW "$EXP" >/dev/null'

# ---- configured: real gateway starts
docker exec -u openclaw $N bash -c "echo '{\"gateway\":{\"mode\":\"local\"}}' > /data/.openclaw/openclaw.json"
docker restart $N >/dev/null; wait_health 120
for i in $(seq 1 60); do curl -s http://127.0.0.1:$P/setup/healthz | grep -q '"gatewayReachable":true' && break; sleep 3; done
chk "configured: real gateway reachable" 'curl -s http://127.0.0.1:$P/setup/healthz | grep -q "\"gatewayReachable\":true"'
chk "anonymous /tools/invoke from the internet = 401" '[ "$(curl -s -o /dev/null -w %{http_code} -X POST -H "X-Real-IP: 203.0.113.9" -H "Host: smoke.example" --data-binary "{\"tool\":\"session_status\"}" http://127.0.0.1:$P/tools/invoke)" = 401 ]'
chk "anonymous /openclaw = 401 (no token handed out)" '[ "$(curl -s -o /dev/null -w %{http_code} -H "X-Real-IP: 203.0.113.9" http://127.0.0.1:$P/openclaw)" = 401 ]'
# The redirect contains an actual gateway token: never print raw response headers.
# Report only HTTP status and booleans when an intermittent failure occurs.
check_operator_redirect() {
  local hdr status location_seen token_redirect
  hdr=$(mktemp) || return 1
  status=$(curl -sS -o /dev/null -D "$hdr" -w '%{http_code}' -H "Authorization: Basic $B" "http://127.0.0.1:$P/openclaw")
  location_seen=false; token_redirect=false
  grep -qi '^location:' "$hdr" && location_seen=true
  grep -qi '^location: /openclaw?token=' "$hdr" && token_redirect=true
  rm -f "$hdr"
  if [ "$status" = 302 ] && [ "$token_redirect" = true ]; then return 0; fi
  printf '      operator redirect diagnostics: status=%s location_present=%s expected_token_redirect=%s\\n' "$status" "$location_seen" "$token_redirect"
  return 1
}
chk "operator /openclaw = 302 with token" 'check_operator_redirect'
chk "operator /tools/invoke = 200" '[ "$(curl -s -o /dev/null -w %{http_code} -X POST -H "Authorization: Basic $B" -H "X-Real-IP: 203.0.113.9" -H "Host: smoke.example" -H "content-type: application/json" -d "{\"tool\":\"session_status\"}" http://127.0.0.1:$P/tools/invoke)" = 200 ]'
GW=$(docker exec $N pgrep -f openclaw-gateway | head -1)
chk "gateway process env has no SETUP_PASSWORD (read as the same uid)" '[ -n "$GW" ] && docker exec -u openclaw $N test -r /proc/$GW/environ && [ "$(docker exec -u openclaw $N bash -c "tr \"\\0\" \"\\n\" < /proc/$GW/environ | grep -c ^SETUP_PASSWORD=")" = 0 ]'
chk "gateway token not in wrapper log" '! docker exec $N grep -q "$TOK" /data/.openclaw/server.log && ! docker logs $N 2>&1 | grep -q "$TOK"'
docker rm -f $N >/dev/null

# ---- full volume: Homebrew copy fails -> service must still boot
docker volume rm -f ${N}-data >/dev/null
docker run -d --name $N -p $P:8080 --tmpfs /data:rw,size=24m,mode=0755 -e SETUP_PASSWORD=$PW -e OPENCLAW_STATE_DIR=/data/.openclaw -e OPENCLAW_WORKSPACE_DIR=/data/workspace "$IMG" >/dev/null
chk "full volume (24 MB): Homebrew copy fails but the service boots" 'wait_health 60'
chk "full volume: no half-copied .linuxbrew left; image Homebrew in use" 'docker exec $N bash -c "[ ! -e /data/.linuxbrew ] && [ ! -e /data/.linuxbrew.partial ] && [ -x /home/linuxbrew/.linuxbrew/bin/brew ] && [ ! -L /home/linuxbrew/.linuxbrew ]"'
# Avoid grep -q on a live docker-logs pipe with pipefail: early grep exit can SIGPIPE docker logs.
# Preserve the check: require successful log capture and the exact expected warning.
check_full_volume_reason_logged() {
  local log_file
  log_file=$(mktemp) || return 1
  if ! docker logs "$N" >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 1
  fi
  if grep -qF "could not copy Homebrew" "$log_file"; then
    rm -f "$log_file"
    return 0
  fi
  echo "      expected Homebrew failure warning absent from captured container logs"
  rm -f "$log_file"
  return 1
}
chk "full volume: reason logged" 'check_full_volume_reason_logged'
docker rm -f $N >/dev/null; docker volume rm -f ${N}-data >/dev/null
echo "RESULT pass=$pass fail=$fail"; [ $fail = 0 ]
