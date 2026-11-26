#!/bin/bash
# Runs the encrypted-backup tests (src/backup.test.mjs, src/backup-r2.test.mjs) inside a Node container.
#
#   bash scripts/run-backup-tests.sh [node-major]      # default: the major of the Node running this script
#
# Why a container: the backup route refuses to snapshot while any process of the same user still holds a writable
# descriptor or a writable shared mapping under the data roots (assertNoBackupWriters in src/backup-r2.js). It must read
# /proc/<pid>/fd, and fails CLOSED (EACCES => backup refused) for a process it cannot inspect. On a shared CI runner
# some same-user processes are not inspectable, so the guard correctly refuses and the route tests cannot reach their
# assertions. In a throw-away container every process is the test's own and inspectable, with CAP_SYS_PTRACE granted
# for /proc inspection. The guard itself is NOT changed, loosened or skipped; only the place the tests run is.
# The repository is mounted read-only; the tests write only to their own temp directories.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAJOR="${1:-$(node -p 'process.versions.node.split(".")[0]')}"
command -v docker >/dev/null || { echo "docker is required to run the backup tests" >&2; exit 2; }
exec docker run --rm --cap-add=SYS_PTRACE -v "$ROOT:/app:ro" -w /app "node:${MAJOR}-bookworm" \
  node --test src/backup.test.mjs src/backup-r2.test.mjs
