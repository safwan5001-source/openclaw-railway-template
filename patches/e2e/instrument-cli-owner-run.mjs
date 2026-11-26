// TEST-ONLY: make the CLI maintenance followup carry the same run fields a WhatsApp owner reply turn carries
// (senderIsOwner + SenderId/SenderE164 + whatsapp provider), driven by BASHT_E2E_WHATSAPP_OWNER.
import fs from "node:fs";
const f = process.argv[2];
let t = fs.readFileSync(f, "utf8");
// OpenClaw 2026.11.10 ships this module minified (single line, one-letter parameter names): match the exact header.
const anchor = "function createCommandMaintenanceFollowup(e){";
if (t.split(anchor).length !== 2) throw new Error("anchor");
t = t.replace(anchor, `function createCommandMaintenanceFollowup(e){const f=bashtE2eOrigCreateCommandMaintenanceFollowup(e);const e164=process.env.BASHT_E2E_WHATSAPP_OWNER;if(e164)Object.assign(f.run,{senderIsOwner:process.env.BASHT_E2E_OWNER_FLAG!=="0",senderId:process.env.BASHT_E2E_SENDER??e164,senderE164:process.env.BASHT_E2E_SENDER??e164,messageProvider:"whatsapp",chatType:"direct"});return f}function bashtE2eOrigCreateCommandMaintenanceFollowup(e){`);
fs.writeFileSync(f, t);
