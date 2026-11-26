#!/bin/bash
# BASHT CI — the same checks GitHub Actions runs (.github/workflows/basht-ci.yml), runnable anywhere with Node >= 24
# (an isolated dev container, a laptop, a Claude Code cloud session). Offline except for the optional OpenClaw install.
#
#   bash scripts/ci-local.sh                  # all offline checks
#   bash scripts/ci-local.sh --with-openclaw  # + install the PINNED OpenClaw in a temp dir (npm registry) and run the
#                                             #   skill-eligibility check and patches/*.test.mjs (if present)
#
# Every run writes .ci-results/<commit>.log (full output) and .ci-results/<commit>.summary (one line per step), keyed
# by commit SHA (+ "-dirty" when the tree has uncommitted changes). No secrets are read; tests use fakes and temp dirs.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

WITH_OPENCLAW=0
for a in "$@"; do case "$a" in --with-openclaw) WITH_OPENCLAW=1 ;; *) echo "unknown option: $a" >&2; exit 2 ;; esac; done

SHA="$(git rev-parse HEAD 2>/dev/null || echo nogit)"
[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || SHA="$SHA-dirty"
OUT="$ROOT/.ci-results"; mkdir -p "$OUT"
LOG="$OUT/$SHA.log"; SUM="$OUT/$SHA.summary"; : > "$LOG"; : > "$SUM"
FAILED=0

note() { echo "$*" | tee -a "$SUM"; }
step() { # <name> <command...>
  local name="$1"; shift
  echo "::group::$name" >>"$LOG"
  local start; start=$(date +%s)
  if "$@" >>"$LOG" 2>&1; then note "PASS  $name ($(( $(date +%s) - start ))s)"
  else note "FAIL  $name ($(( $(date +%s) - start ))s)"; FAILED=1; fi
  echo "::endgroup::" >>"$LOG"
}
skip() { note "SKIP  $1 — $2"; }

note "# BASHT CI  commit=$SHA  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)  node=$(node --version)  date=$(date -u +%FT%TZ)"
case "$(node --version)" in v2[4-9]*|v[3-9][0-9]*) ;; *) note "FAIL  node >= 24 required (production image is Node 26)"; exit 1 ;; esac

if [ ! -d node_modules/express ] || [ ! -d node_modules/http-proxy ]; then
  step "install wrapper deps (pnpm, frozen lockfile)" npx -y pnpm@11.24.0 install --frozen-lockfile --prod
fi

step "syntax: src/server.js" node -c src/server.js
# The encrypted-backup tests need to inspect every process of the user (the residual-writer guard fails closed on one it
# cannot read), which a shared runner or sandbox does not allow: they run in a container with CAP_SYS_PTRACE below.
WRAPPER_TESTS=()
for f in src/*.test.mjs; do
  case "$f" in src/backup.test.mjs|src/backup-r2.test.mjs) ;; *) WRAPPER_TESTS+=("$f") ;; esac
done
step "unit + integration: wrapper (src, backup tests below) and basht-daftra skill" node --test "${WRAPPER_TESTS[@]}" skills/basht-daftra/scripts/*.test.mjs
if docker info >/dev/null 2>&1; then
  step "backup: encrypted archive, writer guard and R2 readback (container with process inspection)" bash scripts/run-backup-tests.sh
else
  skip "backup tests (src/backup*.test.mjs)" "need a Docker daemon for process inspection: run in GitHub Actions or 'bash scripts/run-backup-tests.sh'"
fi
step "packaging + security invariants" node --test scripts/check-dockerfiles.mjs scripts/test-entrypoint.mjs scripts/check-security-invariants.mjs
step "marketing installer: synthetic safety and idempotence" node --test scripts/test-marketing-installer.mjs

check_skills() {
  local f n
  for f in skills/*/SKILL.md; do
    n="$(basename "$(dirname "$f")")"
    node -e "
      const t=require('fs').readFileSync(process.argv[1],'utf8'); const n=process.argv[2];
      const m=t.match(/^---\n([\s\S]*?)\n---/); if(!m) throw Error(n+': no frontmatter');
      if(!new RegExp('^name: '+n+'\$','m').test(m[1])) throw Error(n+': name must equal directory');
      if(!/^description: /m.test(m[1])) throw Error(n+': description missing');
      if(/\.\.\/\.\.\/src|\bsrc\/daftra/.test(t)) throw Error(n+': references repo paths outside the skill bundle');
      console.log(n+': frontmatter ok');" "$f" "$n" || return 1
  done
  ! grep -rEn "from '\.\./|require\('\.\./" skills/*/scripts/*.mjs 2>/dev/null
}
step "skills: frontmatter valid and bundles self-contained" check_skills

if command -v shellcheck >/dev/null 2>&1; then
  step "shellcheck (all shell scripts)" shellcheck -S warning entrypoint.sh broker-entrypoint.sh skill-sync.sh scripts/*.sh
else
  skip "shellcheck" "not installed (bash -n is covered by check-dockerfiles)"
fi

if [ "$WITH_OPENCLAW" = 1 ]; then
  OC_VER="$(grep -oE 'openclaw@[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | head -1 | cut -d@ -f2)"
  OC_TMP="$(mktemp -d)"; trap 'rm -rf "$OC_TMP"' EXIT
  install_openclaw() { (cd "$OC_TMP" && npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts "openclaw@$OC_VER"); }
  step "install pinned OpenClaw $OC_VER (scripts disabled, temp dir)" install_openclaw
  step "OpenClaw discovers the skill; eligible only with DAFTRA_* env" bash scripts/verify-skill-eligibility.sh "$OC_TMP"
  if compgen -G "patches/*.test.mjs" >/dev/null; then
    step "patches: unit + integration against pinned OpenClaw" env OPENCLAW_PACKAGE_ROOT="$OC_TMP/node_modules/openclaw" OPENCLAW_STATE_DIR="$OC_TMP/state" node --test --test-concurrency=1 patches/*.test.mjs
  else
    skip "patches tests" "no patches/ directory on this commit"
  fi
else
  skip "OpenClaw-dependent checks" "run with --with-openclaw"
fi

skip "Docker image builds (broker smoke, RTL font layer)" "need a Docker daemon: run in GitHub Actions or 'npm run build:broker-image && npm run smoke:broker-image'"

if [ "$FAILED" = 0 ]; then note "RESULT PASS  $SHA"; else note "RESULT FAIL  $SHA  (details: $LOG)"; fi
exit "$FAILED"
