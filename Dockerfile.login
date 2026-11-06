# BASHT x Daftra LOGIN BROWSER (EXPERIMENTAL, phase 1) — a SEPARATE Railway service. Not the OpenClaw container, not the broker.
#
# Purpose: a short-lived, isolated Chromium that the operator drives from Safari on the iPhone to sign in to Daftra by themselves
# (e-mail + OTP), and to PROVE whether an authorized session can download the official invoice PDF. It holds NO Daftra API key,
# NO broker secret and NO persistent volume; the session lives in memory for <= LOGIN_MAX_MINUTES.
# Not applied by this repo: building/deploying it is an explicit owner action (docs/DAFTRA_LOGIN_BROWSER_PHASE1.md).
#
# Railway wiring: on a NEW service set RAILWAY_DOCKERFILE_PATH=Dockerfile.login (railway.login.toml is an optional reference).
# Variables (all arrive at run time; nothing is baked in): DAFTRA_BASE_URL, LOGIN_ENABLED=1, LOGIN_ACCESS_CODE (>= 32 chars).
FROM node:26-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fontconfig \
    fonts-noto-core \
    tini \
  && fc-cache -f \
  && command -v chromium \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10002 login \
  && useradd --system --uid 10002 --gid login --create-home --home-dir /home/login --shell /usr/sbin/nologin login

WORKDIR /app
# Same relative layout as the repo: daftra-login/ imports the (zero-dependency) skill scripts. Tests are excluded by .dockerignore.
COPY skills/basht-daftra/scripts ./skills/basht-daftra/scripts
COPY daftra-login ./daftra-login

ENV PORT=8080
# Chromium's own sandbox needs user namespaces, which most container platforms do not grant. Compensating controls (docs): non-root user,
# only *.daftra.com resolvable, tenant writes blocked at the request layer, ephemeral profile, one session, hard time limit.
ENV LOGIN_CHROMIUM_NO_SANDBOX=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

USER login
ENTRYPOINT ["tini", "--", "node", "/app/daftra-login/server.mjs"]
