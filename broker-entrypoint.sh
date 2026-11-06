#!/bin/bash
# Entrypoint of the BASHT Daftra broker service.
# 1. (root) validate and prepare the state volume: mkdir, chown, chmod 700 — refusing symlinks / odd paths.
# 2. drop privileges with gosu and exec node. It never runs the service as root and never prints secrets.
set -euo pipefail

STATE="${BROKER_STATE_DIR:-/broker-data}"
APP=/app/scripts/daftra-broker-service.mjs
RUN_USER=broker

die() { echo "[broker-entrypoint] refusing to start: $*" >&2; exit 1; }

# --- state dir validation: absolute, normalised, not a symlink anywhere, not a system directory -------------------
case "$STATE" in /*) ;; *) die "BROKER_STATE_DIR must be an absolute path" ;; esac
case "$STATE" in *$'\n'*|*..*|*//*|*/) die "BROKER_STATE_DIR is not normalised" ;; esac
case "$STATE" in /|/bin|/boot|/dev|/etc|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var|/app|/home|/data|/data/*) die "BROKER_STATE_DIR points at a reserved location" ;; esac
[ ! -L "$STATE" ] || die "BROKER_STATE_DIR is a symlink"

if [ "$(id -u)" = "0" ]; then
  command -v gosu >/dev/null 2>&1 || die "gosu is missing: cannot drop privileges"
  mkdir -p -- "$STATE"
  [ ! -L "$STATE" ] || die "BROKER_STATE_DIR became a symlink"
  [ -d "$STATE" ] || die "BROKER_STATE_DIR is not a directory"
  [ "$(realpath -- "$STATE")" = "$STATE" ] || die "BROKER_STATE_DIR resolves through a symlink"
  chown -R -h "$RUN_USER:$RUN_USER" -- "$STATE"
  chmod 700 -- "$STATE"
  echo "[broker-entrypoint] state dir ready; dropping privileges to '$RUN_USER'" >&2
  exec gosu "$RUN_USER:$RUN_USER" node "$APP"
fi

# Started unprivileged (e.g. RAILWAY_RUN_UID set): the volume must already be ours, otherwise fail closed.
[ -d "$STATE" ] && [ -w "$STATE" ] && [ -O "$STATE" ] || die "not root and BROKER_STATE_DIR is not a writable directory owned by uid $(id -u)"
[ "$(realpath -- "$STATE")" = "$STATE" ] || die "BROKER_STATE_DIR resolves through a symlink"
chmod 700 -- "$STATE"
exec node "$APP"
