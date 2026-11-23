#!/bin/bash
# shellcheck disable=SC2016,SC2034,SC2046
# Disaster-recovery drill on the REAL image + REAL gateway with SYNTHETIC data only.
# backup from container A (volume A) -> volume A destroyed -> fresh container B on an EMPTY volume -> restore via
# /setup Import -> compare hashes, SQLite integrity, gateway health. Usage: restore-drill.sh <image>
set -uo pipefail
IMG="${1:?usage: restore-drill.sh <image>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; TOOL="node $REPO/scripts/basht-backup.mjs"
P="${DRILL_PORT:-18890}"; PW=synthetic-drill-setup-pw; D="$(mktemp -d)"; trap 'rm -rf "$D"; docker rm -f drillA drillB >/dev/null 2>&1; docker volume rm -f drill-a drill-b >/dev/null 2>&1' EXIT
export BASHT_BACKUP_PASSPHRASE=synthetic-drill-passphrase-0123 BASHT_IMPORT_PASSWORD=synthetic-import-pw-123
B=$(printf "admin:$PW" | base64)
pass=0; fail=0; chk() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
health() { for i in $(seq 1 ${2:-90}); do curl -s http://127.0.0.1:$P/setup/healthz | grep -q "\"gatewayReachable\":$1" && return 0; sleep 2; done; return 1; }
up() { docker run -d --name $1 -p $P:8080 -v $2:/data -e SETUP_PASSWORD=$PW -e RAILWAY_PUBLIC_DOMAIN=drill.example \
  -e OPENCLAW_STATE_DIR=/data/.openclaw -e OPENCLAW_WORKSPACE_DIR=/data/workspace -e BASHT_BACKUP_PUBLIC_KEY="$(cat $D/keys/basht-backup-public.pem)" "$IMG" >/dev/null; }
# hashes of everything the backup promises to carry (WAL/SHM/locks excluded: SQLite and the gateway rewrite them at start; integrity is checked instead)
manifest() { docker exec $1 bash -c 'cd /data && find .openclaw workspace \( -path .openclaw/cache -o -path .openclaw/tmp -o -path .openclaw/logs -o -path .openclaw/media/playback-transcode -o -path workspace/skills/basht-daftra -o -path workspace/skills/basht-accounting \) -prune -o -type f ! -name server.log ! -name "*-wal" ! -name "*-shm" ! -name "*.sqlite" ! -name "*.lock" -print0 | sort -z | xargs -0 sha256sum'; }
docker rm -f drillA drillB >/dev/null 2>&1; docker volume rm -f drill-a drill-b >/dev/null 2>&1

$TOOL keygen $D/keys >/dev/null || exit 1
# ---------- A: a running, configured BASHT with synthetic data
up drillA drill-a; health false 60 || health true 5
docker exec -u openclaw drillA bash -c 'set -e
echo "{\"gateway\":{\"mode\":\"local\"},\"note\":\"SYNTHETIC\"}" > /data/.openclaw/openclaw.json
mkdir -p /data/.openclaw/credentials/whatsapp/default /data/workspace/memory /data/workspace/exports
echo "{\"me\":\"+10000000000\",\"synthetic\":true}" > /data/.openclaw/credentials/whatsapp/default/creds.json
echo "{\"preKey\":\"SYNTHETIC\"}" > /data/.openclaw/credentials/whatsapp/default/pre-key-1.json
echo "# MEMORY (synthetic) customer Test Co prefers Arabic invoices" > /data/workspace/MEMORY.md
echo "2026-11-21: synthetic note" > /data/workspace/memory/2026-11-21.md
head -c 3000000 /dev/urandom > /data/workspace/exports/invoice-1-0123456789abcdef0123456789abcdef.pdf'
docker restart drillA >/dev/null; chk "A: real gateway up with synthetic data" 'health true 120'
manifest drillA > $D/before.sha
# Diagnose volume growth using synthetic file metadata only; never read file contents or output credentials.
# Exclude server.log to match the du threshold below.
volume_files() { docker exec drillA bash -c 'find /data -type f ! -name server.log -printf "%P\t%s\n" | LC_ALL=C sort'; }
volume_files > "$D/volume-before.tsv"
USED_BEFORE=$(docker exec drillA bash -c 'du -sb --exclude=server.log /data | cut -f1')
# The gateway stop/restart may checkpoint SQLite WALs and resize database files.
# Measure non-SQLite files independently so normal database lifecycle writes do not mask a backup archive on /data.
NON_DB_BEFORE=$(docker exec drillA bash -c 'du -sb --exclude=server.log --exclude="*.sqlite" --exclude="*.sqlite-*" /data | cut -f1')
T0=$(date +%s%N)
CODE=$(curl -s -o $D/drill.bkp -w '%{http_code}' -X POST -H "Authorization: Basic $B" -H "Origin: http://127.0.0.1:$P" http://127.0.0.1:$P/setup/api/backup)
T1=$(date +%s%N)
chk "A: backup downloaded (HTTP 200, $(stat -c %s $D/drill.bkp 2>/dev/null) bytes, $(( (T1-T0)/1000000 )) ms)" '[ "$CODE" = 200 ]'
USED_AFTER=$(docker exec drillA bash -c 'du -sb --exclude=server.log /data | cut -f1')
NON_DB_AFTER=$(docker exec drillA bash -c 'du -sb --exclude=server.log --exclude="*.sqlite" --exclude="*.sqlite-*" /data | cut -f1')
volume_files > "$D/volume-after.tsv"
echo "      volume used before/after backup: $USED_BEFORE / $USED_AFTER bytes (delta $((USED_AFTER-USED_BEFORE)))"
echo "      non-SQLite volume used before/after backup: $NON_DB_BEFORE / $NON_DB_AFTER bytes (delta $((NON_DB_AFTER-NON_DB_BEFORE)))"
chk "A: backup leaves less than 1 MiB of non-SQLite volume growth" '[ $((NON_DB_AFTER-NON_DB_BEFORE)) -lt 1048576 ]'
chk "A: no encrypted backup archives are left on the persistent volume" '[ -z "$(docker exec drillA find /data -type f -name "basht-backup-*.bkp" -print -quit)" ]'
if [ $((USED_AFTER-USED_BEFORE)) -ge 1048576 ] || [ $((NON_DB_AFTER-NON_DB_BEFORE)) -ge 1048576 ]; then
  # File-size deltas only. The 1 MiB limit remains enforced for non-SQLite files;
  # WAL checkpointing during gateway restart is reported separately.
  python3 - "$D/volume-before.tsv" "$D/volume-after.tsv" <<'PY'
import sys
from pathlib import Path

def read_sizes(filename):
    result = {}
    for row in Path(filename).read_text(errors="replace").splitlines():
        name, sep, size = row.rpartition("\t")
        if sep and size.isdigit():
            result[name] = int(size)
    return result

before, after = [read_sizes(arg) for arg in sys.argv[1:]]
changes = sorted(((after.get(name, 0) - before.get(name, 0), name)
                  for name in before.keys() | after.keys()
                  if before.get(name) != after.get(name)), reverse=True)
print("      volume growth diagnostics (synthetic file metadata; top 20 by absolute delta):")
for delta, name in sorted(changes, key=lambda t: abs(t[0]), reverse=True)[:20]:
    print(f"      {delta:+d} bytes: {name}")
print(f"      changed files: {len(changes)}; net file size delta: {sum(d for d, _ in changes):+d} bytes")
PY
fi
chk "A: no backup leftovers in the container temp dir" '[ -z "$(docker exec drillA bash -c "ls /tmp | grep basht-backup")" ]'
chk "A: gateway restarted by itself after the backup" 'health true 60'
docker logs drillA 2>&1 | grep -o "encrypted backup ready.*" | tail -1 | sed 's/^/      /'
chk "ciphertext contains no plaintext" '! grep -q "SYNTHETIC\|creds.json\|MEMORY" $D/drill.bkp'

# ---------- disaster: container and volume A are gone
docker rm -f drillA >/dev/null; docker volume rm -f drill-a >/dev/null

# ---------- operator's computer: decrypt + build the import archive
chk "decrypt with the offline private key (tag verified)" '$TOOL decrypt $D/drill.bkp $D/keys/basht-backup-private.pem $D/drill.tar.gz >/dev/null'
chk "convert to /setup Import archive" '$TOOL to-import-zip $D/drill.tar.gz $D/restore.zip >/dev/null'

# ---------- B: brand-new container, EMPTY volume (unconfigured)
up drillB drill-b; sleep 5; health false 60
chk "B: fresh instance is unconfigured" 'curl -s http://127.0.0.1:$P/setup/healthz | grep -q "\"configured\":false"'
R=$(curl -s -w ' HTTP%{http_code}' -X POST -H "Authorization: Basic $B" -H "Origin: http://127.0.0.1:$P" -H "Content-Type: application/zip" \
  -H "X-Archive-Password: $(printf %s "$BASHT_IMPORT_PASSWORD" | base64)" --data-binary @$D/restore.zip http://127.0.0.1:$P/setup/api/import)
chk "B: /setup Import accepted the restore archive" 'echo "$R" | grep -q "\"ok\":true.*HTTP200"'
chk "B: configured and real gateway reachable after restore" 'health true 120'
manifest drillB > $D/after.sha
chk "B: every protected file is byte-identical ($(wc -l < $D/before.sha) files: config, WhatsApp session, memory, exports, plugins)" 'diff -q $D/before.sha $D/after.sha >/dev/null'
for db in $(docker exec drillB bash -c 'cd /data && find .openclaw -name "*.sqlite" ! -path "*/tmp/*"'); do
  chk "B: SQLite integrity ok: $db" '[ "$(docker exec -u openclaw drillB node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/data/$db\",{readOnly:true});console.log(d.prepare(\"PRAGMA integrity_check\").get().integrity_check)" 2>/dev/null)" = ok ]'
done
chk "B: restored files owned by the openclaw user" '[ -z "$(docker exec drillB find /data/.openclaw /data/workspace ! -user openclaw -print -quit)" ]'
docker rm -f drillB >/dev/null; docker volume rm -f drill-b >/dev/null
echo "RESULT pass=$pass fail=$fail"; [ $fail = 0 ]
