#!/bin/bash
# Build-and-run smoke test of the broker image with FAKE environment only (no Daftra, no secrets, no network egress needed).
#   scripts/smoke-broker-image.sh <image-tag>
# Env: SMOKE_HOST_NETWORK=1 -> run with --network host (for sandboxes without a bridge); default publishes loopback ports.
# Proves: the image starts, drops root, prepares a 0700 state dir, answers /healthz and the root-railway.toml
# healthcheck /setup/healthz, serves no agent API on the public port, refuses unauthenticated console/agent calls,
# and never prints the fake secrets. Does NOT prove Railway networking or any real Daftra behaviour.
set -uo pipefail
IMAGE="${1:?usage: smoke-broker-image.sh <image>}"
NAME="basht-broker-smoke-$$"
FAILS=0; N=0
ok()  { N=$((N+1)); echo "ok $N - $1"; }
bad() { N=$((N+1)); FAILS=$((FAILS+1)); echo "not ok $N - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PUB=18080; PRIV=18081
SECRET_A="smoke-approval-secret-0123456789-0123456789-abcdef"
SECRET_T="smoke-agent-token-0123456789-0123456789-abcdef"
SECRET_P="smoke-operator-password-0123456789"
SECRET_S="smoke-operator-totp-seed-0123456789-0123456789"
SECRET_K="smoke-fake-daftra-key-0123456789"
FAKE_ENV=(
  -e "DAFTRA_BASE_URL=https://smoke.daftra.com" -e "DAFTRA_API_KEY=$SECRET_K" -e "DAFTRA_APPROVAL_SECRET=$SECRET_A"
  -e "BROKER_AGENT_TOKEN=$SECRET_T" -e "OPERATOR_PASSWORD=$SECRET_P" -e "OPERATOR_TOTP_SEED=$SECRET_S"
  -e "RAILWAY_PRIVATE_DOMAIN=basht-broker.railway.internal" -e "RAILWAY_PUBLIC_DOMAIN=broker.smoke.test"
  -e "BROKER_PUBLIC_HOST=0.0.0.0" -e "BROKER_PRIVATE_HOST=0.0.0.0"          # CI docker bridges have no IPv6; Railway does (default is ::)
)
# NOTE: DAFTRA_WRITES_ENABLED is deliberately NOT set: writes must be disabled by default.
if [ "${SMOKE_HOST_NETWORK:-0}" = 1 ]; then NET=(--network host -e "PORT=$PUB" -e "BROKER_PRIVATE_PORT=$PRIV"); else NET=(-p "127.0.0.1:$PUB:8080" -p "127.0.0.1:$PRIV:8081"); fi
docker run -d --name "$NAME" "${NET[@]}" "${FAKE_ENV[@]}" "$IMAGE" >/dev/null || { echo "not ok - container failed to start"; exit 1; }

for _ in $(seq 1 40); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PUB/healthz" 2>/dev/null && break; sleep 0.5; done
# uid of the node service process, read from /proc (the slim image has no ps). The [n] trick keeps the probe from matching itself.
proc_uid() { docker exec "$NAME" sh -c 'for p in /proc/[0-9]*; do if tr "\000" " " < "$p/cmdline" 2>/dev/null | grep -q "[n]ode /app/scripts/daftra-broker-service"; then awk "/^Uid:/{print \$2}" "$p/status"; fi; done' | head -1; }
code() { curl -sS -m 5 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
body() { curl -sS -m 5 "$@" 2>/dev/null || true; }

check "/healthz answers ok on the public port" '[ "$(body http://127.0.0.1:$PUB/healthz)" = ok ]'
check "/setup/healthz (root railway.toml healthcheck) answers ok too" '[ "$(body http://127.0.0.1:$PUB/setup/healthz)" = ok ]'
check "console without a session is not served (no 200 on /console)" '[ "$(code http://127.0.0.1:$PUB/console)" != 200 ]'
check "agent API is NOT served on the public port (/v1/status → 404)" '[ "$(code -X POST http://127.0.0.1:$PUB/v1/status)" = 404 ]'
check "agent API is NOT served on the public port even with the agent token" '[ "$(code -X POST -H "Authorization: Bearer $SECRET_T" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:$PUB/v1/status)" = 404 ]'
check "private port without a token is refused (not 200)" 'c=$(code -X POST -H "Host: basht-broker.railway.internal" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:$PRIV/v1/status); [ "$c" = 401 ] || [ "$c" = 403 ]'
check "private port with the WRONG token is refused" 'c=$(code -X POST -H "Host: basht-broker.railway.internal" -H "Authorization: Bearer wrong-token-0123456789-0123456789-abcdef" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:$PRIV/v1/status); [ "$c" = 401 ] || [ "$c" = 403 ]'
check "private port rejects a public Host header (reachable only via the private name)" 'c=$(code -X POST -H "Host: broker.smoke.test" -H "Authorization: Bearer $SECRET_T" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:$PRIV/v1/status); [ "$c" != 200 ]'
check "no agent execute/approve/enable-writes routes exist on the private port" 'for r in execute approve resolve enable_writes writes; do c=$(code -X POST -H "Host: basht-broker.railway.internal" -H "Authorization: Bearer $SECRET_T" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:$PRIV/v1/$r); [ "$c" = 404 ] || [ "$c" = 405 ] || exit 1; done'
check "the node service process runs as uid 10001 (never root)" '[ "$(proc_uid)" = 10001 ] && [ "$(docker exec "$NAME" id -u broker)" = 10001 ]'
check "state dir exists with mode 700 owned by broker" '[ "$(docker exec "$NAME" stat -c "%a %U" /broker-data)" = "700 broker" ]'
check "container logs state that writes are disabled and never contain the fake secrets" 'logs="$(docker logs "$NAME" 2>&1)"; echo "$logs" | grep -qi "writes are DISABLED" && ! echo "$logs" | grep -q -e "$SECRET_A" -e "$SECRET_T" -e "$SECRET_P" -e "$SECRET_S" -e "$SECRET_K"'
check "public responses never contain the fake secrets" '! { body http://127.0.0.1:$PUB/; body http://127.0.0.1:$PUB/console; body http://127.0.0.1:$PUB/healthz; } | grep -q -e "$SECRET_A" -e "$SECRET_T" -e "$SECRET_P" -e "$SECRET_S" -e "$SECRET_K"'
check "image does not contain OpenClaw, Chromium, Python, curl or git" 'docker run --rm --entrypoint sh "$IMAGE" -c "! command -v openclaw && ! command -v chromium && ! command -v python3 && ! command -v curl && ! command -v git && ! command -v gcc" >/dev/null 2>&1'
check "image has no baked-in secrets (docker inspect env)" '! docker inspect "$IMAGE" --format "{{json .Config.Env}}" | grep -qiE "SECRET|TOKEN|PASSWORD|APPROVAL|OPERATOR|DAFTRA_(API|WRITE)"'
check "image ships no test files" '! docker run --rm --entrypoint sh "$IMAGE" -c "ls /app/scripts" | grep -qE "\.test\.mjs|test-helper"'
check "container still running (no crash loop)" '[ "$(docker inspect -f "{{.State.Running}}" "$NAME")" = true ]'

echo "1..$N"; echo "# fails $FAILS"
[ "$FAILS" -eq 0 ]
