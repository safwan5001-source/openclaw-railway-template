# BASHT encrypted backup & restore (off-Railway, no plan upgrade)

Railway Hobby offers no volume backups from the dashboard, so BASHT backs itself up through its own admin surface.
The server only ever holds a **public** key: a backup cannot be opened on Railway, by the agent, or by anyone who
obtains the file. Only the operator's offline private key (plus its passphrase) opens it.

## What is backed up

| Path (under `/data`) | Contents | In backup |
|---|---|---|
| `.openclaw/openclaw.json` (+ `.bak*`, `.last-good`) | config, model/provider keys, channel config | yes |
| `.openclaw/credentials/whatsapp/default/` | WhatsApp (Baileys) session — restoring avoids re-linking by QR | yes |
| `.openclaw/credentials/*` | other OAuth credentials | yes |
| `.openclaw/state/*.sqlite*` | gateway state: paired devices, pairing, cron, … | yes |
| `.openclaw/agents/*/agent/*.sqlite*` | agent sessions / conversation history | yes |
| `.openclaw/npm`, `plugin-skills` | installed plugins (incl. WhatsApp) | yes |
| `workspace/MEMORY.md`, `workspace/memory/` | long-term memory | yes |
| `workspace/{SOUL,IDENTITY,USER,AGENTS}.md`, `exports/` | persona, official invoice PDFs | yes |
| `.openclaw/{cache,tmp,logs,server.log,media/playback-transcode}` | rebuildable / volatile | no |
| `workspace/skills/basht-*`, `node_modules`, `.cache` | re-synced from the image / rebuildable | no |
| `/data/.linuxbrew` | Homebrew, re-copied from the image | no |

Only regular files and directories are stored (symlinks and sockets never are). The broker service has its own volume
and is not part of this backup.

## How it works

`POST /setup/api/backup` (setup login, same-origin only — the **Download Encrypted Backup** button in `/setup`):

1. pauses the gateway (SQLite databases and the WhatsApp session must not change mid-copy);
2. streams `find | tar | gzip | AES-256-GCM` into the container's temporary disk — plaintext is never written, and
   **nothing is written to the volume**;
3. restarts the gateway as soon as the archive is complete (measured pause: ~0.6–1.3 s for a few MB);
4. sends the `.bkp` file and deletes the temporary copy.

Format: `BASHT-BACKUP-1` header (key id, date, wrapped key) + AES-256-GCM ciphertext + tag; the data key is wrapped
with RSA-OAEP-SHA256 (≥ 3072-bit, keygen makes 4096). Any modified, truncated or wrong-key file is refused and produces
no output (`src/backup-format.js`). Disabled (HTTP 503) until `BASHT_BACKUP_PUBLIC_KEY` is set.

## One-time setup (operator's computer)

```bash
# 1. key pair (Node >= 20, from a checkout of this repo). Use a password-manager-generated passphrase.
export BASHT_BACKUP_PASSPHRASE='…'           # >= 12 characters; never stored next to the key
node scripts/basht-backup.mjs keygen ~/basht-backup-keys
```

- `basht-backup-private.pem` (encrypted with the passphrase): **two offline copies** — password manager (secure file
  attachment) and an encrypted USB kept elsewhere. The passphrase lives in the password manager only.
- `basht-backup-public.pem`: its full text goes into the Railway variable `BASHT_BACKUP_PUBLIC_KEY` on the OpenClaw
  service (a variable change redeploys the service — owner approval).
- Every backup records the key id (`inspect` shows it). Rotate the pair yearly or on suspicion; keep old private keys
  to open old backups.

## Routine (weekly, and before every deploy)

1. `/setup` → **Download Encrypted Backup** → `basht-backup-<date>.bkp`.
2. `node scripts/basht-backup.mjs inspect <file>` (date + key id; needs no key).
3. Keep two copies: the computer and one cloud folder (iCloud/Google Drive/OneDrive — ciphertext only).
4. Retention: last 8 weekly + last 3 monthly.

### Before the security deploy (endpoint not live yet)

The current production already has `/setup` → **Export Data** (ZIP protected with the setup password, weak ZipCrypto).
As a pre-deploy safety net: export, then immediately seal it with the public key and delete the plain ZIP:

```bash
node scripts/basht-backup.mjs seal openclaw-export-<ts>.zip ~/basht-backup-keys/basht-backup-public.pem export-<ts>.bkp
rm openclaw-export-<ts>.zip
```

(The export is a live copy — the gateway is not paused — so it is a safety net, not the primary backup.)

## Restore

```bash
export BASHT_BACKUP_PASSPHRASE='…' BASHT_IMPORT_PASSWORD='a-fresh-one-time-password'
node scripts/basht-backup.mjs decrypt basht-backup-<date>.bkp ~/basht-backup-keys/basht-backup-private.pem restore.tar.gz
node scripts/basht-backup.mjs to-import-zip restore.tar.gz restore.zip
```

Then `/setup` → **Import Data** → choose `restore.zip` → archive password = `BASHT_IMPORT_PASSWORD`. The import
validates every entry, refuses symlinks, swaps directories atomically, rolls back on failure and restarts the gateway.
Delete `restore.tar.gz` / `restore.zip` afterwards (they are plaintext).

## Volume impact (volume at ~78 % of 5 GB ≈ 1.1 GB free)

- **Backup:** 0 bytes on the volume (measured in the drill). Needs temporary container disk ≈ the compressed backup
  size; if that runs out the request returns 507 and the gateway is already running again.
- **Restore:** the import writes the uploaded ZIP to `/data` and extracts it there before swapping, so it needs free
  space ≈ ZIP + extracted size (old data is renamed, not copied). Upload limit: 250 MB ZIP. With ~1.1 GB free this
  covers state + workspace up to roughly 400–500 MB. The `.bkp` size from the first backup is the measurement to check
  against; `DIAG_STORAGE=1` (PR #26) reports what fills the volume.

## Verified by

- `src/backup.test.mjs`: round trip; wrong key / flipped byte / truncation refused with no output; route auth, CSRF,
  exclusions, no plaintext in the file, no files on the volume, gateway back up; the restore ZIP satisfies the import's
  exact entry rules.
- `scripts/restore-drill.sh <image>` (real image + real gateway, synthetic data): backup from a running instance →
  container **and volume destroyed** → fresh container on an **empty** volume → import → 17/17 protected files
  byte-identical, SQLite `integrity_check` ok, gateway healthy, files owned by `openclaw`. Run it quarterly.
