#!/bin/bash
# Offline simulation of entrypoint.sh (OpenClaw service): Homebrew-to-volume copy and the boot path.
# The real script is copied into a temp root with /data, /home/linuxbrew and /app re-pointed there; chown and gosu are
# fakes on PATH. Nothing real is touched, no network, no secrets.
# Variables are consumed inside eval'd check strings, which shellcheck cannot see.
# shellcheck disable=SC2034
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAILS=0; N=0
ok()   { N=$((N+1)); echo "ok $N - $1"; }
bad()  { N=$((N+1)); FAILS=$((FAILS+1)); echo "not ok $N - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gosu" <<'EOS'
#!/bin/bash
echo "GOSU $*" >> "$FAKE_LOG"; exit 0
EOS
cat > "$TMP/bin/chown" <<'EOS'
#!/bin/bash
echo "CHOWN $*" >> "$FAKE_LOG"; exit 0
EOS
# cp that copies a few files and then fails like a full disk (ENOSPC) when FAIL_CP=1
cat > "$TMP/bin/cp" <<'EOS'
#!/bin/bash
if [ "${FAIL_CP:-0}" = 1 ]; then
  dest="${!#}"; mkdir -p "$dest"; echo partial > "$dest/partial-file"
  echo "cp: error writing: No space left on device" >&2; exit 1
fi
exec /bin/cp "$@"
EOS
chmod +x "$TMP/bin/"*

# <name>: fresh sandbox root with an "image" Homebrew tree and an entrypoint pointing into it
sandbox() {
  local R="$TMP/$1"; rm -rf "$R"; mkdir -p "$R/data" "$R/home/linuxbrew/.linuxbrew/bin" "$R/app"
  echo brew-v1 > "$R/home/linuxbrew/.linuxbrew/bin/brew"
  printf '#!/bin/bash\nmkdir -p "$2/skills"\nexit 0\n' > "$R/app/skill-sync.sh"; chmod +x "$R/app/skill-sync.sh"
  sed -e "s#/home/linuxbrew#$R/home/linuxbrew#g" -e "s#/data#$R/data#g" -e "s#/app/#$R/app/#g" \
    "$ROOT/entrypoint.sh" > "$R/entrypoint.sh"
  echo "$R"
}
run() { # <root> [env...]
  local R="$1"; shift
  rm -f "$R/log"
  env FAKE_LOG="$R/log" PATH="$TMP/bin:$PATH" OPENCLAW_WORKSPACE_DIR="$R/data/workspace" "$@" bash "$R/entrypoint.sh" >"$R/out" 2>&1
}

R="$(sandbox fresh)"; run "$R"; rc=$?
check "fresh volume: boots (gosu reached)" '[ $rc -eq 0 ] && grep -q "GOSU openclaw node src/server.js" "$R/log"'
check "fresh volume: Homebrew copied to the volume" '[ "$(cat "$R/data/.linuxbrew/bin/brew")" = brew-v1 ]'
check "fresh volume: image path is a symlink to the volume copy" '[ -L "$R/home/linuxbrew/.linuxbrew" ] && [ "$(readlink "$R/home/linuxbrew/.linuxbrew")" = "$R/data/.linuxbrew" ]'
check "fresh volume: no staging leftovers" '[ ! -e "$R/data/.linuxbrew.partial" ]'

check "fresh volume: workspace and skills dirs created by skill-sync are handed to openclaw" 'grep -q "CHOWN -h openclaw:openclaw $R/data/workspace$" "$R/log" && grep -q "CHOWN -h openclaw:openclaw $R/data/workspace/skills$" "$R/log"'

R="$(sandbox existing)"; mkdir -p "$R/data/.linuxbrew/bin"; echo brew-on-volume > "$R/data/.linuxbrew/bin/brew"; run "$R"; rc=$?
check "existing volume copy is kept (not overwritten) and used" '[ $rc -eq 0 ] && [ "$(cat "$R/data/.linuxbrew/bin/brew")" = brew-on-volume ] && [ -L "$R/home/linuxbrew/.linuxbrew" ]'

R="$(sandbox diskfull)"; run "$R" FAIL_CP=1; rc=$?
check "copy failure (disk full): the service still boots" '[ $rc -eq 0 ] && grep -q "GOSU openclaw node src/server.js" "$R/log"'
check "copy failure: no half-copied .linuxbrew is left to be trusted on the next boot" '[ ! -e "$R/data/.linuxbrew" ] && [ ! -e "$R/data/.linuxbrew.partial" ]'
check "copy failure: the image Homebrew stays in place" '[ -d "$R/home/linuxbrew/.linuxbrew" ] && [ ! -L "$R/home/linuxbrew/.linuxbrew" ] && [ "$(cat "$R/home/linuxbrew/.linuxbrew/bin/brew")" = brew-v1 ]'
check "copy failure: reason is logged" 'grep -q "Homebrew" "$R/out"'
run "$R"; rc=$?
check "next boot with space retries the copy and succeeds" '[ $rc -eq 0 ] && [ "$(cat "$R/data/.linuxbrew/bin/brew")" = brew-v1 ] && [ -L "$R/home/linuxbrew/.linuxbrew" ]'

R="$(sandbox stale)"; mkdir -p "$R/data/.linuxbrew.partial"; echo junk > "$R/data/.linuxbrew.partial/x"; run "$R"; rc=$?
check "stale staging dir from a crash is discarded and the copy redone" '[ $rc -eq 0 ] && [ ! -e "$R/data/.linuxbrew.partial" ] && [ "$(cat "$R/data/.linuxbrew/bin/brew")" = brew-v1 ]'

echo "1..$N"; echo "# fails $FAILS"
[ "$FAILS" -eq 0 ]
