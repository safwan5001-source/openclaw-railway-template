#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

# BASHT Daftra skill: refresh the read-only reference copy inside the persistent workspace. A sync problem must
# never stop the Gateway from starting. No secrets are involved here or anywhere in this container.
/app/skill-sync.sh /app/skills "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" openclaw:openclaw \
  || echo "[entrypoint] skill sync skipped (see message above); OpenClaw starts normally" >&2

exec gosu openclaw node src/server.js
