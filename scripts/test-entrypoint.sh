#!/bin/bash
# Offline simulation of skill-sync.sh (OpenClaw service) and broker-entrypoint.sh (broker service).
# Uses only temp directories and fake gosu/id/chown binaries on PATH: nothing real is touched, no network.
# Variables are consumed inside eval'd check strings, which shellcheck cannot see.
# shellcheck disable=SC2034
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAILS=0; N=0
ok()   { N=$((N+1)); echo "ok $N - $1"; }
bad()  { N=$((N+1)); FAILS=$((FAILS+1)); echo "not ok $N - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
SYNC="$ROOT/skill-sync.sh"; BRK="$ROOT/broker-entrypoint.sh"

mk_src() { # <dir> <content-tag>
  rm -rf "$1"; mkdir -p "$1/basht-daftra/scripts"
  echo "---
name: basht-daftra
---
v:$2" > "$1/basht-daftra/SKILL.md"
  echo "export const v='$2'" > "$1/basht-daftra/scripts/a.mjs"
}

# ---------------- skill-sync ----------------
S="$TMP/s1"; W="$TMP/ws1"; mk_src "$S" one
mkdir -p "$W/skills/other-skill" "$W/notes"; echo keep > "$W/skills/other-skill/SKILL.md"; echo mem > "$W/notes/memory.md"
"$SYNC" "$S" "$W" - >/dev/null 2>&1
check "sync installs the skill" '[ -f "$W/skills/basht-daftra/SKILL.md" ] && grep -q v:one "$W/skills/basht-daftra/SKILL.md"'
check "other workspace content preserved" '[ "$(cat "$W/skills/other-skill/SKILL.md")" = keep ] && [ "$(cat "$W/notes/memory.md")" = mem ]'
check "no staging/old leftovers" '[ -z "$(ls -A "$W/skills" | grep "^\.basht" || true)" ]'
M1="$(stat -c %Y "$W/skills/basht-daftra/SKILL.md")"; sleep 1.1
out="$("$SYNC" "$S" "$W" - 2>&1)"
check "re-run is idempotent (reports up to date, file untouched)" 'echo "$out" | grep -q "up to date" && [ "$(stat -c %Y "$W/skills/basht-daftra/SKILL.md")" = "$M1" ]'
mk_src "$S" two; echo extra > "$S/basht-daftra/scripts/new.mjs"
"$SYNC" "$S" "$W" - >/dev/null 2>&1
check "upgrade replaces changed files and adds new ones" 'grep -q v:two "$W/skills/basht-daftra/SKILL.md" && [ -f "$W/skills/basht-daftra/scripts/new.mjs" ]'
rm "$S/basht-daftra/scripts/new.mjs"; "$SYNC" "$S" "$W" - >/dev/null 2>&1
check "files removed upstream disappear (no stale code)" '[ ! -e "$W/skills/basht-daftra/scripts/new.mjs" ]'
echo tampered >> "$W/skills/basht-daftra/scripts/a.mjs"; "$SYNC" "$S" "$W" - >/dev/null 2>&1
check "local tampering is overwritten at the next sync" '! grep -q tampered "$W/skills/basht-daftra/scripts/a.mjs"'
check "file modes normalised (dirs 755, files 644)" '[ "$(stat -c %a "$W/skills/basht-daftra/scripts")" = 755 ] && [ "$(stat -c %a "$W/skills/basht-daftra/SKILL.md")" = 644 ]'

# missing source tolerated
"$SYNC" "$TMP/does-not-exist" "$TMP/ws2" - >/dev/null 2>&1; check "missing /app/skills tolerated (exit 0)" '[ $? -eq 0 ]'
mkdir -p "$TMP/emptyskills"; "$SYNC" "$TMP/emptyskills" "$TMP/ws2" - >/dev/null 2>&1; check "skills dir without basht-daftra tolerated" '[ $? -eq 0 ]'

# symlink refusals
W3="$TMP/ws3"; mkdir -p "$W3" "$TMP/elsewhere"; ln -s "$TMP/elsewhere" "$W3/skills"
"$SYNC" "$S" "$W3" - >/dev/null 2>&1; check "symlinked workspace/skills refused" '[ $? -ne 0 ] && [ -z "$(ls -A "$TMP/elsewhere")" ]'
W4="$TMP/ws4"; mkdir -p "$W4/skills" "$TMP/victim"; echo precious > "$TMP/victim/f"; ln -s "$TMP/victim" "$W4/skills/basht-daftra"
"$SYNC" "$S" "$W4" - >/dev/null 2>&1; check "symlink planted at the target refused; victim untouched" '[ $? -ne 0 ] && [ "$(cat "$TMP/victim/f")" = precious ] && [ "$(ls "$TMP/victim")" = f ]'
ln -s "$TMP/elsewhere" "$TMP/wslink"; "$SYNC" "$S" "$TMP/wslink/inner" - >/dev/null 2>&1; check "symlink on the workspace path refused" '[ $? -ne 0 ] && [ -z "$(ls -A "$TMP/elsewhere")" ]'
S5="$TMP/s5"; mk_src "$S5" five; ln -s /etc/passwd "$S5/basht-daftra/scripts/evil"; "$SYNC" "$S5" "$TMP/ws5" - >/dev/null 2>&1
check "symlink inside the source skill refused; nothing installed" '[ $? -ne 0 ] && [ ! -e "$TMP/ws5/skills/basht-daftra" ]'
"$SYNC" "$S" "relative/path" - >/dev/null 2>&1; check "relative workspace path refused" '[ $? -ne 0 ]'
"$SYNC" "$S" "$TMP/a/../b" - >/dev/null 2>&1; check "path with .. refused" '[ $? -ne 0 ]'
W6="$TMP/ws6"; mkdir -p "$W6/skills"; echo file > "$W6/skills/basht-daftra"; "$SYNC" "$S" "$W6" - >/dev/null 2>&1
check "target that is a regular file refused" '[ $? -ne 0 ] && [ "$(cat "$W6/skills/basht-daftra")" = file ]'

# interrupted swap recovery
W7="$TMP/ws7"; mkdir -p "$W7/skills/.basht-daftra.old/scripts"; echo "v:old" > "$W7/skills/.basht-daftra.old/SKILL.md"; touch "$W7/skills/.basht-daftra.new.ABC"
"$SYNC" "$TMP/does-not-exist" "$W7" - >/dev/null 2>&1
mk_src "$TMP/s7" seven; "$SYNC" "$TMP/s7" "$W7" - >/dev/null 2>&1
check "interrupted update recovered and replaced; stale staging removed" 'grep -q v:seven "$W7/skills/basht-daftra/SKILL.md" && [ -z "$(ls -A "$W7/skills" | grep "^\.basht" || true)" ]'
# chown path is exercised with a fake chown that records its arguments
mkdir -p "$TMP/bin"; printf '#!/bin/bash\necho "$@" >> "%s/chown.log"\n' "$TMP" > "$TMP/bin/chown"; chmod +x "$TMP/bin/chown"
PATH="$TMP/bin:$PATH" "$SYNC" "$S" "$TMP/ws8" openclaw:openclaw >/dev/null 2>&1
check "owner applied with chown -R -h (never following symlinks)" 'grep -q -- "-R -h openclaw:openclaw" "$TMP/chown.log"'

# ---------------- broker-entrypoint ----------------
cat > "$TMP/bin/id" <<'EOS'
#!/bin/bash
if [ "$1" = "-u" ]; then echo "${FAKE_UID:-0}"; else /usr/bin/id "$@"; fi
EOS
cat > "$TMP/bin/gosu" <<'EOS'
#!/bin/bash
echo "GOSU $*" >> "$FAKE_LOG"; exit 0
EOS
cat > "$TMP/bin/chmod" <<'EOS'
#!/bin/bash
echo "CHMOD $*" >> "$FAKE_LOG"; /bin/chmod "$@"
EOS
cat > "$TMP/bin/chown" <<'EOS'
#!/bin/bash
echo "CHOWN $*" >> "$FAKE_LOG"; exit 0
EOS
chmod +x "$TMP/bin/"*
run_brk() { # <state> [extra env...]
  local st="$1"; shift
  FAKE_LOG="$TMP/brk.log" PATH="$TMP/bin:$PATH" BROKER_STATE_DIR="$st" DAFTRA_APPROVAL_SECRET=TOPSECRET-0123456789-0123456789-abcdef "$@" bash "$BRK" 2>"$TMP/brk.err"
}
B="$TMP/data/broker-state-ok"
rm -f "$TMP/brk.log"; run_brk "$B" env FAKE_UID=0; rc=$?
check "root: prepares volume, drops to broker user via gosu, runs the service file" '[ $rc -eq 0 ] && grep -q "GOSU broker:broker node /app/scripts/daftra-broker-service.mjs" "$TMP/brk.log" && grep -q "CHOWN -R -h broker:broker" "$TMP/brk.log" && grep -q "CHMOD 700" "$TMP/brk.log" && [ -d "$B" ]'
check "entrypoint output never contains the secret" '! grep -q TOPSECRET "$TMP/brk.err" "$TMP/brk.log"'
for bad_path in "relative/dir" "/broker/../etc" "/" "/etc" "/data" "/data/openclaw" "/app" "/tmp" "/broker-data/" "/a//b"; do
  rm -f "$TMP/brk.log"; run_brk "$bad_path" env FAKE_UID=0; rc=$?
  check "refuses BROKER_STATE_DIR='$bad_path' and never execs the service" '[ $rc -ne 0 ] && [ ! -e "$TMP/brk.log" ]'
done
mkdir -p "$TMP/real"; ln -s "$TMP/real" "$TMP/linkstate"; rm -f "$TMP/brk.log"; run_brk "$TMP/linkstate" env FAKE_UID=0; rc=$?
check "refuses a symlinked state dir" '[ $rc -ne 0 ] && [ ! -e "$TMP/brk.log" ]'
mkdir -p "$TMP/viaparent/real2"; ln -s "$TMP/viaparent" "$TMP/parentlink"; rm -f "$TMP/brk.log"; run_brk "$TMP/parentlink/real2" env FAKE_UID=0; rc=$?
check "refuses a state dir reached through a symlinked parent" '[ $rc -ne 0 ] && [ ! -e "$TMP/brk.log" ]'
# root but no gosu: must not run the service as root
mkdir -p "$TMP/bin2"; cp "$TMP/bin/id" "$TMP/bin2/id"; rm -f "$TMP/brk.log"
FAKE_UID=0 FAKE_LOG="$TMP/brk.log" PATH="$TMP/bin2:/usr/bin:/bin" BROKER_STATE_DIR="$TMP/nogosu" bash -c 'command -v gosu >/dev/null && exit 99; bash "'"$BRK"'"' 2>/dev/null; rc=$?
check "root without gosu: refuses instead of running as root" '[ $rc -ne 0 ] && [ $rc -ne 99 ]'
# non-root start (RAILWAY_RUN_UID): volume must already be ours
mkdir -p "$TMP/own"; chmod 755 "$TMP/own"
cat > "$TMP/bin/node" <<'EOS'
#!/bin/bash
echo "NODE $*" > "$FAKE_LOG"; exit 0
EOS
chmod +x "$TMP/bin/node"
rm -f "$TMP/brk.log"; run_brk "$TMP/own" env FAKE_UID=1000; rc=$?
if [ "$(/usr/bin/id -u)" != 0 ]; then
  check "non-root with an owned writable volume runs node directly" '[ $rc -eq 0 ] && grep -q "NODE /app/scripts/daftra-broker-service.mjs" "$TMP/brk.log"'
else
  # running this test as root: the -O ownership test passes for root-owned dirs, still must exec node (never gosu) in this branch
  check "non-root branch execs node directly (no gosu)" '[ $rc -eq 0 ] && grep -q "NODE /app/scripts/daftra-broker-service.mjs" "$TMP/brk.log" && ! grep -q GOSU "$TMP/brk.log"'
fi
rm -f "$TMP/brk.log"; run_brk "$TMP/missing-nonroot" env FAKE_UID=1000; rc=$?
check "non-root with a missing/unwritable volume fails closed" '[ $rc -ne 0 ] && [ ! -e "$TMP/brk.log" ]'

echo "1..$N"; echo "# fails $FAILS"
[ "$FAILS" -eq 0 ]
