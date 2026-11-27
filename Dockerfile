# OpenClaw service image.
# SECURITY BOUNDARY: this image (and its entrypoints) must never contain or receive any BASHT/Daftra broker secret
# (DAFTRA_APPROVAL_SECRET, write-capable DAFTRA_* keys, BROKER_* state or tokens). Those live ONLY in the separate
# broker service (Dockerfile.broker). Enforced by scripts/check-dockerfiles.mjs.
FROM node:26-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    procps \
    python3 \
    tini \
    build-essential \
    zip \
    unzip \
    libnspr4 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdbus-1-3 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libasound2 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libatspi2.0-0 \
    chromium \
    fontconfig \
    fonts-noto-core \
    ffmpeg \
    awscli \
  && command -v chromium \
  && chromium --version \
  && fc-cache -f \
  && fc-match 'Noto Naskh Arabic' | grep -qi 'NotoNaskhArabic' \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    --allow-scripts=openclaw \
    openclaw@2026.11.10 \
  && node --version | grep -Eq '^v26\.' \
  && openclaw --version | grep -Eq '^OpenClaw 2026\.11\.10( |$)'
# Pinned (was @latest): a rebuild must produce the same tool the previous build had. Bump deliberately.
RUN npm install -g clawhub@0.27.0

# Official Claude Code CLI, installed in the image rather than the persistent disk.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.332 \
  && claude --version | grep -Eq '^2\.1\.332( |$)' \
  && npm cache clean --force
ENV CLAUDE_CONFIG_DIR=/data/claude

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.24.0 \
  && pnpm install --frozen-lockfile --prod

COPY src ./src
# Self-contained BASHT Daftra skill; entrypoint.sh syncs it into the persistent workspace at boot (skill-sync.sh).
COPY skills ./skills
# Canonical transport plan stays in docs/; include exactly that file in the image skill reference tree.
# The existing verified skill-sync copies this reference with the skill into the persistent workspace.
COPY docs/business/nebras-transport/NEBRAS-TRANSPORT-MASTER-PLAN.md ./skills/basht-transport-sales/references/MASTER-PLAN.md
# BASHT memory-flush owner-identity patch for the pinned OpenClaw (docs/MEMORY_FLUSH_OWNER_FIX.md). Exact-match and
# hash-checked: the build fails if the installed OpenClaw differs from the version the patch was validated against.
# patches/memory-flush-doctor.mjs and patches/owner-check.mjs are read-only diagnostics for the Railway console.
COPY patches/openclaw-memory-flush-owner.mjs patches/memory-flush-doctor.mjs patches/owner-check.mjs patches/whatsapp-owner.mjs ./patches/
RUN node patches/openclaw-memory-flush-owner.mjs /usr/local/lib/node_modules/openclaw \
  && grep -q 'basht-patch:memory-flush-owner-identity' /usr/local/lib/node_modules/openclaw/dist/agent-runner-memory-Bmk5_PZf.mjs \
  && openclaw --version | grep -Eq '^OpenClaw 2026\.11\.10( |$)'
# BASHT audio-document intake patch (docs/AUDIO_DOCUMENT_INTAKE.md): audio sent as a WhatsApp *document* (mp3/m4a/wav...)
# is classified as audio so it reaches speech-to-text, like a voice note. Exact-match and hash-checked like the patch above.
COPY patches/openclaw-audio-document-intake.mjs ./patches/
RUN node patches/openclaw-audio-document-intake.mjs /usr/local/lib/node_modules/openclaw \
  && grep -q 'basht-patch:audio-document-intake' /usr/local/lib/node_modules/openclaw/dist/attachments.normalize-H6KPb1Ga.mjs \
  && openclaw --version | grep -Eq '^OpenClaw 2026\.11\.10( |$)'
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
COPY --chmod=755 skill-sync.sh ./skill-sync.sh
COPY --chmod=755 scripts/install-marketing-skills.sh ./install-marketing-skills.sh

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

USER openclaw
# Smoke test as the same unprivileged user that runs the Gateway; no login or network request.
RUN set -eu; \
    cfg="$(mktemp -d)"; \
    trap 'rm -rf "$cfg"' EXIT; \
    CLAUDE_CONFIG_DIR="$cfg" claude --version | grep -Eq '^2\.1\.332( |$)'; \
    CLAUDE_CONFIG_DIR="$cfg" claude auth --help >/dev/null; \
    test "$(id -un)" = openclaw

RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
ENV OPENCLAW_SUPERVISOR_MODE=external
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/setup/healthz || exit 1

USER root
ENTRYPOINT ["tini", "--", "./entrypoint.sh"]
