import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoBackupWriters, r2BackupConfig, uploadEncryptedBackup } from "./backup-r2.js";

test("reject open writable file and allow read-only file", {skip:process.platform !== "linux"}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"backup-writer-test-"));
  try {
    const file = path.join(dir,"db.sqlite");
    await fs.writeFile(file,"synthetic");
    const writer = await fs.open(file,"r+");
    try { await assert.rejects(assertNoBackupWriters([dir]), /writable descriptor/); }
    finally { await writer.close(); }
    const reader = await fs.open(file,"r");
    try { await assertNoBackupWriters([dir]); }
    finally { await reader.close(); }
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test("R2 configuration restricts endpoint and bucket", () => {
  const env = {R2_ENDPOINT:"https://"+"0".repeat(32)+".r2.cloudflarestorage.com",R2_BUCKET:"basht-backups",R2_ACCESS_KEY_ID:"dummy",R2_SECRET_ACCESS_KEY:"dummy"};
  assert.equal(r2BackupConfig(env).env.AWS_REQUEST_CHECKSUM_CALCULATION,"when_required");
  assert.throws(()=>r2BackupConfig({...env,R2_BUCKET:"awj"}));
  assert.throws(()=>r2BackupConfig({...env,R2_ENDPOINT:"https://example.org"}));
});

test("R2 delivery checks SHA256 and rejects corrupted readback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"backup-r2-test-"));
  try {
    const file = path.join(dir,"encrypted.bkp"), remote = path.join(dir,"remote"), aws = path.join(dir,"aws");
    await fs.writeFile(file,"synthetic encrypted bytes");
    await fs.writeFile(aws, '#!/bin/sh\nset -eu\nif [ "$6" = "-" ]; then cat "$MOCK_REMOTE"; if [ "$MOCK_CORRUPT" = yes ]; then printf x; fi; else cp "$5" "$MOCK_REMOTE"; fi\n',{mode:0o700});
    const cfg = {endpoint:"https://example.invalid",bucket:"basht-backups",env:{PATH:dir+":"+process.env.PATH,MOCK_REMOTE:remote,MOCK_CORRUPT:"no"}};
    const ok = await uploadEncryptedBackup(file,cfg);
    assert.equal(ok.verified,true);
    assert.equal(ok.bytes,(await fs.stat(file)).size);
    await assert.rejects(uploadEncryptedBackup(file,{...cfg,env:{...cfg.env,MOCK_CORRUPT:"yes"}}),/readback mismatch/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
