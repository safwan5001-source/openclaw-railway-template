#!/bin/bash
# Conservative installer for the ten approved BASHT Marketing Skills.
# Installs only missing skills; NEVER replaces an existing workspace skill, even if image content differs.
# Usage: install-marketing-skills.sh <image-skills-dir> <workspace-dir> [owner user:group|-]
set -euo pipefail

SRC_ROOT="${1:?source skills directory required}"
WS="${2:?workspace directory required}"
OWNER="${3:--}"
NAMES=(
  basht-market-intelligence basht-marketing-strategy basht-creative-direction
  basht-social-media basht-ads-campaigns basht-performance-analytics
  basht-video-creative basht-local-seo basht-conversion-optimization
  basht-marketing-automation
)
say() { echo "[marketing-skill-install] $*" >&2; }
die() { say "refusing: $*"; exit 1; }

case "$WS" in /*) ;; *) die "workspace path must be absolute" ;; esac
case "$WS" in *..*|*//*|*$'\n'*) die "workspace path is not normalised" ;; esac
WS="${WS%/}"
[ -n "$WS" ] || die "workspace path cannot be root"
[ -d "$SRC_ROOT" ] && [ ! -L "$SRC_ROOT" ] || die "source root absent or symlinked"
[ ! -L "$WS" ] || die "workspace is a symlink"

# Refuse symlinked path components to avoid writes outside the requested volume.
p=""
IFS=/ read -ra parts <<< "${WS#/}"
for part in "${parts[@]}"; do
  p="$p/$part"
  [ ! -L "$p" ] || die "workspace parent is a symlink"
done
mkdir -p -- "$WS"
SK="$WS/skills"
[ ! -L "$SK" ] || die "skills directory is a symlink"
mkdir -p -- "$SK"

installed=0
unchanged=0
conflicts=0
for name in "${NAMES[@]}"; do
  SRC="$SRC_ROOT/$name"
  DEST="$SK/$name"
  [ -d "$SRC" ] && [ ! -L "$SRC" ] || die "$name missing or symlinked in image"
  [ -f "$SRC/SKILL.md" ] && [ ! -L "$SRC/SKILL.md" ] || die "$name has no safe SKILL.md"
  [ -z "$(find "$SRC" -type l -print -quit)" ] || die "$name image tree contains symlinks"
  grep -qx -- "name: $name" "$SRC/SKILL.md" || die "$name frontmatter name does not match"
  grep -q '^description: ' "$SRC/SKILL.md" || die "$name description missing"
  [ ! -L "$DEST" ] || die "$name destination is a symlink"
  if [ -e "$DEST" ]; then
    [ -d "$DEST" ] || die "$name destination is not a directory"
    [ -z "$(find "$DEST" -type l -print -quit)" ] || die "$name workspace tree contains symlinks"
    if diff -qr -- "$SRC" "$DEST" >/dev/null; then
      say "$name already present, unchanged"
      unchanged=$((unchanged+1))
    else
      say "$name workspace copy differs; preserving user files (manual review required)"
      conflicts=$((conflicts+1))
    fi
    continue
  fi

  # A new, hidden staging directory is built completely before the final rename.
  # If killed mid-copy the destination remains absent; the next boot makes a new stage.
  STAGE="$(mktemp -d "$SK/.$name.new.XXXXXX")"
  if ! cp -a --no-dereference -- "$SRC/." "$STAGE/"; then
    rm -rf -- "$STAGE"
    die "$name could not be staged"
  fi
  [ -z "$(find "$STAGE" -type l -print -quit)" ] || die "$name staged tree contains symlinks"
  find "$STAGE" -type d -exec chmod 755 {} +
  find "$STAGE" -type f -exec chmod 644 {} +
  if [ "$OWNER" != "-" ]; then chown -R -h -- "$OWNER" "$STAGE"; fi
  diff -qr -- "$SRC" "$STAGE" >/dev/null || die "$name staging verification failed"

  # -n prevents replacing a destination created concurrently. An existing skill is never overwritten.
  mv -Tn -- "$STAGE" "$DEST"
  if [ -e "$STAGE" ]; then
    say "$name destination appeared concurrently; preserving it"
    rm -rf -- "$STAGE"
    conflicts=$((conflicts+1))
  else
    say "$name installed"
    installed=$((installed+1))
  fi
done
# No global workspace rewrites and no removals. Conflicts are logged without blocking gateway boot.
say "result installed=$installed unchanged=$unchanged conflicts=$conflicts"
[ "$conflicts" -eq 0 ]
