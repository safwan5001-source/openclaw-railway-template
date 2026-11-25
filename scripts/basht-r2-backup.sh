#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${R2_ACCESS_KEY_ID:?missing R2 access key}"
: "${R2_SECRET_ACCESS_KEY:?missing R2 secret key}"
: "${R2_ENDPOINT:?missing R2 endpoint}"
: "${R2_BUCKET:?missing R2 bucket}"
: "${BASHT_BACKUP_ENCRYPTION_KEY:?missing encryption key}"
[[ "$R2_BUCKET" == basht-backups ]] || { echo "Unexpected bucket" >&2; exit 1; }
[[ "$R2_ENDPOINT" =~ ^https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com/?$ ]] || { echo "Unexpected endpoint" >&2; exit 1; }
[[ ${#BASHT_BACKUP_ENCRYPTION_KEY} -ge 32 ]] || { echo "Encryption key too short" >&2; exit 1; }
for c in tar gzip openssl aws; do command -v "$c" >/dev/null || { echo "Missing tool: $c" >&2; exit 1; }; done
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true AWS_PAGER=""
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
key="pre-upgrade/$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 8).tar.gz.enc"
# Run only with application writers quiesced; never treat a live SQLite copy as a consistent snapshot.
[[ "${BASHT_BACKUP_QUIESCED:-}" == YES ]] || { echo "Quiesce application writers before backup" >&2; exit 1; }
# Exclude reproducible Homebrew installation, retain the rest of persistent data.
tar -C /data --exclude='./.linuxbrew' --exclude='./.linuxbrew.partial' -cf - . |
  gzip -1 |
  openssl enc -aes-256-ctr -pbkdf2 -iter 600000 -salt -pass env:BASHT_BACKUP_ENCRYPTION_KEY |
  aws --endpoint-url "$R2_ENDPOINT" s3 cp - "s3://$R2_BUCKET/$key" --only-show-errors --expected-size 10000000000
aws --endpoint-url "$R2_ENDPOINT" s3api head-object --bucket "$R2_BUCKET" --key "$key" --query ContentLength --output text
echo "Uploaded $key; restore validation still required"
