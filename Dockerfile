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
  && command -v chromium \
  && chromium --version \
  && fc-cache -f \
  && fc-match 'Noto Naskh Arabic' | grep -qi 'NotoNaskhArabic' \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    --allow-scripts=openclaw \
    openclaw@2026.10.9 \
  && node --version | grep -Eq '^v26\.' \
  && openclaw --version | grep -Eq '^OpenClaw 2026\.10\.9( |$)'
RUN npm install -g clawhub@latest

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.24.0 \
  && pnpm install --frozen-lockfile --prod

COPY src ./src
# Self-contained BASHT Daftra skill; entrypoint.sh syncs it into the persistent workspace at boot (skill-sync.sh).
COPY skills ./skills
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
COPY --chmod=755 skill-sync.sh ./skill-sync.sh

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

USER openclaw
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
