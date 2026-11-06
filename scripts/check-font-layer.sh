#!/bin/bash
# Builds ONLY the apt/font layer taken verbatim from the root Dockerfile on the same base image, then verifies that
# Chromium resolves Arabic fonts (Noto Naskh Arabic) inside that image. No OpenClaw, Homebrew or app code involved.
#   scripts/check-font-layer.sh            (set DOCKER_BUILD_ARGS="--network=host" in sandboxes without a bridge)
#   RUN_RTL_TEST=1 scripts/check-font-layer.sh   additionally runs the offline Arabic/RTL PDF test INSIDE that image
#                                                with the Debian chromium + Noto fonts the Railway image will have
#                                                (DOCKER_RUN_ARGS="--network=host" likewise)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE="$(grep -m1 '^FROM ' "$ROOT/Dockerfile")"
# first RUN instruction = apt layer (ends at the line that removes the apt lists)
awk '/^RUN apt-get update/{f=1} f{print} f&&/rm -rf \/var\/lib\/apt\/lists/{exit}' "$ROOT/Dockerfile" > "$TMP/apt-layer"
grep -q 'fonts-noto-core' "$TMP/apt-layer" || { echo "not ok - apt layer extraction failed or fonts-noto-core missing"; exit 1; }
{
  echo "$BASE"
  cat "$TMP/apt-layer"
  echo "RUN fc-match 'Noto Naskh Arabic' | grep -q 'NotoNaskhArabic' && fc-list :lang=ar family | grep -qi 'Noto' && echo FONT_LAYER_OK"
} > "$TMP/Dockerfile"
# shellcheck disable=SC2086
docker build ${DOCKER_BUILD_ARGS:-} --progress=plain -t basht-font-layer-test -f "$TMP/Dockerfile" "$TMP" 2>&1 | tee "$TMP/build.log" | tail -n 15
grep -q FONT_LAYER_OK "$TMP/build.log" && echo "ok - the Dockerfile's apt layer installs Chromium plus Noto Arabic fonts and fontconfig resolves them"

if [ "${RUN_RTL_TEST:-0}" = 1 ]; then
  # poppler is only a test-time tool (pdftotext/pdffonts); it is not part of the production image.
  # shellcheck disable=SC2086
  docker run --rm ${DOCKER_RUN_ARGS:-} -v "$ROOT":/repo:ro -w /repo -e EXPECT_NOTO=1 -e CHROMIUM_PATH=/usr/bin/chromium basht-font-layer-test \
    sh -c 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends poppler-utils >/dev/null && node --test skills/basht-daftra/scripts/daftra-pdf-rtl.test.mjs' \
    | tee "$TMP/rtl.log" | tail -n 12
  # Node 26's default reporter prints "ℹ pass 5", older ones "# pass 5": accept both.
  grep -qE '^(#|ℹ) pass 5$' "$TMP/rtl.log" && grep -qE '^(#|ℹ) fail 0$' "$TMP/rtl.log" && grep -qE '^(#|ℹ) skipped 0$' "$TMP/rtl.log" \
    && echo "ok - Arabic/RTL PDF test passed inside the Railway font layer (NotoNaskhArabic embedded, nothing skipped)"
fi
