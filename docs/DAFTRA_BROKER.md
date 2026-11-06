# BASHT × Daftra — Privileged Broker (agent / operator separation)

Status: **implemented and tested; NOT deployed.** I did **not** change the Dockerfile, `entrypoint.sh`, Railway variables, volumes, the OpenClaw Gateway or any model setting. Deploying this needs the owner's explicit approval (section 6).

## 1. Why

Without a broker, the agent process holds `DAFTRA_API_KEY` and (to run `propose`/`execute`) `DAFTRA_APPROVAL_SECRET` in its environment. Anything that can read that environment can compute approval phrases, forge proposals/ledger lines and call Daftra directly (review finding #10). A software check inside the same process cannot fix that. Separation must come from the OS: two users, secrets in files only the privileged user can read.

```
 agent (OpenClaw, user `openclaw`)                      broker (user `root` or `basht-broker`)
 ┌─────────────────────────────────┐   unix socket     ┌──────────────────────────────────────────┐
 │ env: DAFTRA_BASE_URL            │  /run/basht/      │ files (0400, not in any env):            │
 │      DAFTRA_API_KEY  (READ key) │  broker.sock      │   approval.secret   write-api.key        │
 │      DAFTRA_BROKER_SOCKET       │ ───────────────►  │ state dir (0700): proposals + ledger     │
 │ reads, exports, PDF: local      │  1 JSON line in,  │ ping | propose | show | execute | resolve │
 │ propose/show/execute/resolve:   │  1 JSON line out  │ HMAC-signed proposals + chained ledger   │
 │   forwarded, never run locally  │                   │ only process that can POST to Daftra     │
 └─────────────────────────────────┘                   └──────────────────────────────────────────┘
        human (trusted shell as the broker user): node daftra-approve.mjs show <id>  → approval phrase
```

## 2. Components (`skills/basht-daftra/scripts/`)

| File | Role |
| --- | --- |
| `daftra-broker.mjs` | Socket server + `createBroker()`. Run as the operator. |
| `daftra-broker-client.mjs` | `callBroker(socket, payload)` used by the agent CLI. |
| `daftra-public.mjs` | `publicProposal()` — the only view of a proposal the agent receives (never a phrase/code/MAC). |
| `daftra-auth.mjs` | `readSecretFile`, `readSecret(env, NAME)`: `NAME_FILE` wins over `NAME`. |
| `daftra-approve.mjs` | Operator/human tool: shows the stored request and prints the approval phrase. Works with the secret file. |
| `daftra-cli.mjs` | With `DAFTRA_BROKER_SOCKET` set, `propose|show|execute|resolve` are **only** forwarded; they never run in-process, even if a secret is present in the env (fail closed). `capabilities` reports `broker_mode` and warns if operator secrets are in the agent env. |

## 3. Broker configuration (broker's own environment only)

| Variable | Meaning |
| --- | --- |
| `DAFTRA_BROKER_SOCKET` | absolute socket path (directory must exist and not be world-writable; a symlink or a non-socket at that path is refused; a stale socket nobody answers is replaced) |
| `DAFTRA_BROKER_SOCKET_MODE` | octal, default `600`; no "other" bits allowed (e.g. `660`) |
| `DAFTRA_BROKER_SOCKET_GID` | numeric gid that may connect (with mode `660`), e.g. the `openclaw` group |
| `DAFTRA_APPROVAL_SECRET_FILE` | regular file (symlinks refused), `0400/0600`, ≥ 32 chars |
| `DAFTRA_WRITE_API_KEY_FILE` | the write-capable Daftra key (or `DAFTRA_WRITE_API_KEY`); all broker→Daftra calls use it |
| `DAFTRA_WRITES_ENABLED=1` | operator kill switch (default off) |
| `DAFTRA_BASE_URL`, `OPENCLAW_WORKSPACE_DIR` | tenant root; **the broker's private state dir** (proposals + ledger) — *not* the agent's workspace |

Agent environment must contain only: `DAFTRA_BASE_URL`, `DAFTRA_API_KEY` (a **read-only-role** key), `DAFTRA_BROKER_SOCKET`, `OPENCLAW_WORKSPACE_DIR` (its own, for exports). Daftra roles are per entity, not per method, so the read key cannot be made GET-only; its protection is that it is a different key with the narrowest entity list, and that no write path exists in the agent's process.

Protocol: newline-delimited JSON, one request → one reply → close; 256 KiB cap; 30 s timeout; ≤ 64 concurrent connections. Commands: `ping`, `propose{type,input,actor?}`, `show{id}`, `execute{id,phrase,actor?}`, `resolve{id,created,recordId?,code,actor?}`. Unknown commands or fields (including `env`, `secret`, `path`), wrong types and malformed JSON are rejected with `BAD_REQUEST`. The whole serialised reply is scrubbed of the key and secret before it leaves the broker.

## 4. Deployment recipe (sketch — needs approval to apply)

Railway runs one container whose `entrypoint.sh` starts as root and then `exec gosu openclaw node src/server.js`. Today every Railway variable is inherited by the gateway and therefore by the agent.

1. **Variables:** stop exposing the operator values as plain service variables to the agent process. Keep Railway variables `DAFTRA_APPROVAL_SECRET` and `DAFTRA_WRITE_API_KEY` only long enough for the entrypoint to move them into files, and keep only the read key as `DAFTRA_API_KEY`.
2. **Entrypoint (as root, before dropping privileges):**
   ```bash
   install -d -m 0700 -o root -g root /etc/basht /data/.basht-broker
   umask 077
   printf '%s' "$DAFTRA_APPROVAL_SECRET" > /etc/basht/approval.secret
   printf '%s' "$DAFTRA_WRITE_API_KEY"  > /etc/basht/write-api.key
   unset DAFTRA_APPROVAL_SECRET DAFTRA_WRITE_API_KEY        # never reach the gateway/agent environment
   install -d -m 0755 /run/basht
   env -i PATH="$PATH" DAFTRA_BASE_URL="$DAFTRA_BASE_URL" DAFTRA_WRITES_ENABLED="${DAFTRA_WRITES_ENABLED:-}" \
       DAFTRA_APPROVAL_SECRET_FILE=/etc/basht/approval.secret DAFTRA_WRITE_API_KEY_FILE=/etc/basht/write-api.key \
       OPENCLAW_WORKSPACE_DIR=/data/.basht-broker DAFTRA_BROKER_SOCKET=/run/basht/broker.sock \
       DAFTRA_BROKER_SOCKET_MODE=660 DAFTRA_BROKER_SOCKET_GID="$(getent group openclaw | cut -d: -f3)" \
       node /app/skills/basht-daftra/scripts/daftra-broker.mjs &
   ```
   The existing `chown -R openclaw:openclaw /data` must **exclude** `/data/.basht-broker` (otherwise the agent owns the ledger). The Dockerfile must also copy `skills/` into the image.
3. **Agent:** `DAFTRA_BROKER_SOCKET=/run/basht/broker.sock` in the gateway environment.
4. **Human approval:** `railway shell` (root) → `OPENCLAW_WORKSPACE_DIR=/data/.basht-broker DAFTRA_APPROVAL_SECRET_FILE=/etc/basht/approval.secret node /app/skills/basht-daftra/scripts/daftra-approve.mjs show <proposal-id>`; read the stored request, then send the printed phrase to the agent in chat. `resolve` codes come from `daftra-approve.mjs resolve <id> true|false`.

## 5. What it protects, and what it does not

Verified on this machine (root broker, `0400` root-owned secret files, client as uid 65534 via `setpriv`; real transcript in the PR report):
- the agent user **cannot read** the secret file, the write-key file, the state/ledger directory, or the broker's `/proc/<pid>/environ` (which only contains file *paths*);
- the agent **can** propose through the socket and receives no phrase; guesses, replays and a stale phrase are refused; extra/forbidden fields on the socket are rejected;
- only the operator-derived phrase makes the broker POST; a second use of it is refused.

Does **not** protect against:
- Anything running as the broker user or root (including `railway shell`, anyone with the Railway project).
- A kernel/container escape, or an agent allowed to run as root / `sudo` / ptrace the broker. Keep OpenClaw's exec tool unprivileged.
- **Ledger rollback by renaming the state directory:** if the broker state lives under `/data` (owned by the agent user), the agent may rename the root-owned `daftra-ledger` directory (it cannot read or edit it); the broker would then start with an empty ledger and lose duplicate protection. Prefer a separate path the agent cannot rename in (a second volume or a root-owned parent directory) — not possible with a single Railway volume owned by `openclaw`; treat as a residual risk and keep `DAFTRA_WRITES_ENABLED` off outside supervised sessions.
- The agent's own read key: it can read everything that key's role allows.
- A human who approves without actually reading the preview.

## 6. Needs the owner's approval before anything changes

Dockerfile (`COPY skills`), `entrypoint.sh`, Railway variables split (read key vs write key vs approval secret), where the broker state lives, and enabling `DAFTRA_WRITES_ENABLED`. Until then the system runs in the original single-process mode (still HMAC-protected, but the agent environment can read the secret).
