#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

# Persistent Claude configuration; never follow a pre-existing symlink.
if [ ! -L /data/claude ] && install -d -m 700 -o openclaw -g openclaw /data/claude; then
  export CLAUDE_CONFIG_DIR=/data/claude
else
  echo '[entrypoint] Claude configuration directory unavailable; Claude login must not be attempted' >&2
  unset CLAUDE_CONFIG_DIR
fi

# Homebrew lives on the volume so agent-installed packages survive redeploys. The copy is staged and renamed into
# place, so a failed copy (e.g. a full volume) never leaves a half tree that later boots would trust, and it never
# stops the service: this boot then keeps using the image's Homebrew and the next boot retries.
if [ ! -d /data/.linuxbrew ]; then
  rm -rf /data/.linuxbrew.partial
  if cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew.partial && mv /data/.linuxbrew.partial /data/.linuxbrew; then
    echo "[entrypoint] Homebrew copied to the volume" >&2
  else
    rm -rf /data/.linuxbrew.partial || true
    echo "[entrypoint] could not copy Homebrew to the volume (full?); using the image copy for this boot" >&2
  fi
fi

if [ -d /data/.linuxbrew ]; then
  rm -rf /home/linuxbrew/.linuxbrew
  ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew
fi

# BASHT Daftra skill: refresh the read-only reference copy inside the persistent workspace. A sync problem must
# never stop the Gateway from starting. No secrets are involved here or anywhere in this container.
/app/skill-sync.sh /app/skills "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" openclaw:openclaw \
  || echo "[entrypoint] skill sync skipped (see message above); OpenClaw starts normally" >&2

/app/skill-sync.sh /app/skills "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" openclaw:openclaw basht-accounting \
  || echo "[entrypoint] accounting skill sync skipped (see message above); OpenClaw starts normally" >&2

# Transport skill installation remains separate from marketing and accounting.
/app/skill-sync.sh /app/skills "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" openclaw:openclaw basht-transport-sales \
  || echo "[entrypoint] transport skill sync skipped; OpenClaw starts normally" >&2

# Yemeni voice skill: text/style guidance only, no model or provider changes.
/app/skill-sync.sh /app/skills "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" openclaw:openclaw basht-yemeni-voice \
  || echo "[entrypoint] Yemeni voice skill sync skipped; OpenClaw starts normally" >&2

# Marketing installer is allowlisted and add-only: existing workspace copies are NEVER overwritten.
# A collision is logged for manual review; Gateway still starts normally.
/app/install-marketing-skills.sh /app/skills "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" openclaw:openclaw \
  || echo "[entrypoint] marketing skill installation incomplete; existing workspace skills preserved" >&2

# skill-sync runs as root after the ownership pass above: on a fresh volume it creates the workspace and its skills/
# directory root-owned, and the agent could not write its memory there until the next boot. Hand them back.
WS_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
for d in "$WS_DIR" "$WS_DIR/skills"; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then chown -h openclaw:openclaw "$d" || true; fi
done

exec gosu openclaw node src/server.js
