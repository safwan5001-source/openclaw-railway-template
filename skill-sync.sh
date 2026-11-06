#!/bin/bash
# Idempotently install the self-contained basht-daftra skill into the persistent OpenClaw workspace.
#   skill-sync.sh <skills-source-dir> <workspace-dir> <owner user:group | ->
# Copies <skills-source-dir>/basht-daftra -> <workspace-dir>/skills/basht-daftra:
#   - everything else in the workspace is left untouched; unchanged content is not rewritten;
#   - symlinks are never followed or copied (a symlink anywhere on the path or in the source => refuse);
#   - the new tree is staged next to the target and swapped in with renames, so the target is always either the
#     complete old tree or the complete new tree (a crash leaves a recoverable *.old directory, restored next run);
#   - a missing source is tolerated (exit 0). Prints no secrets (it handles none).
set -euo pipefail

SRC_ROOT="${1:?usage: skill-sync.sh <skills-source-dir> <workspace-dir> <owner|->}"
WS="${2:?workspace dir required}"
OWNER="${3:--}"
NAME=basht-daftra
say() { echo "[skill-sync] $*" >&2; }
die() { say "refusing: $*"; exit 1; }

[ -d "$SRC_ROOT" ] || { say "no skills directory at $SRC_ROOT; nothing to do"; exit 0; }
SRC="$SRC_ROOT/$NAME"
[ -d "$SRC" ] || { say "no $NAME skill in $SRC_ROOT; nothing to do"; exit 0; }
[ ! -L "$SRC_ROOT" ] && [ ! -L "$SRC" ] || die "source is a symlink"
[ -f "$SRC/SKILL.md" ] || die "source skill has no SKILL.md"
[ -z "$(find "$SRC" -type l -print -quit)" ] || die "source skill tree contains a symlink"

case "$WS" in /*) ;; *) die "workspace path must be absolute" ;; esac
case "$WS" in *..*|*//*|*$'\n'*) die "workspace path is not normalised" ;; esac
WS="${WS%/}"
[ -n "$WS" ] || die "workspace path is /"

# Walk the target path: no component may be a symlink.
p=""
IFS=/ read -ra parts <<< "${WS#/}"
for c in "${parts[@]}"; do
  p="$p/$c"
  if [ -L "$p" ]; then die "symlink on workspace path: $p"; fi
done
mkdir -p -- "$WS"
SK="$WS/skills"
[ ! -L "$SK" ] || die "workspace skills dir is a symlink"
mkdir -p -- "$SK"
DEST="$SK/$NAME"
[ ! -L "$DEST" ] || die "target is a symlink"
[ ! -e "$DEST" ] || [ -d "$DEST" ] || die "target exists and is not a directory"

tree_hash() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }

# Recover from an interrupted swap, drop stale staging dirs.
OLD="$SK/.$NAME.old"
if [ ! -e "$DEST" ] && [ -d "$OLD" ] && [ ! -L "$OLD" ]; then mv -- "$OLD" "$DEST"; say "restored interrupted update"; fi
rm -rf -- "$OLD" "$SK"/."$NAME".new.* 2>/dev/null || true

if [ -d "$DEST" ] && [ -z "$(find "$DEST" -type l -print -quit)" ] && [ "$(tree_hash "$SRC")" = "$(tree_hash "$DEST")" ]; then
  say "$NAME already up to date"
  exit 0
fi

STAGE="$(mktemp -d "$SK/.$NAME.new.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
cp -a --no-dereference -- "$SRC/." "$STAGE/"
[ -z "$(find "$STAGE" -type l -print -quit)" ] || die "staged tree contains a symlink"
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
if [ "$OWNER" != "-" ]; then chown -R -h "$OWNER" -- "$STAGE"; fi
[ "$(tree_hash "$SRC")" = "$(tree_hash "$STAGE")" ] || die "staged copy differs from source"

if [ -d "$DEST" ]; then mv -- "$DEST" "$OLD"; fi
if mv -- "$STAGE" "$DEST"; then
  trap - EXIT
  rm -rf -- "$OLD"
  say "$NAME installed/updated in $SK"
else
  [ ! -d "$OLD" ] || mv -- "$OLD" "$DEST"
  die "swap failed; previous version restored"
fi
