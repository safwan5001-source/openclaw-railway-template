// TEST-ONLY: make the CLI maintenance followup carry the same run fields a WhatsApp owner reply turn carries
// (senderIsOwner + SenderId/SenderE164 + whatsapp provider), driven by BASHT_E2E_WHATSAPP_OWNER.
import fs from "node:fs";
const f = process.argv[2];
let t = fs.readFileSync(f, "utf8");
const anchor = "function createCommandMaintenanceFollowup(params) {";
if (t.split(anchor).length !== 2) throw new Error("anchor");
t = t.replace(anchor, `function createCommandMaintenanceFollowup(params) {
	const f = bashtE2eOrigCreateCommandMaintenanceFollowup(params);
	const e164 = process.env.BASHT_E2E_WHATSAPP_OWNER;
	if (e164) Object.assign(f.run, { senderIsOwner: process.env.BASHT_E2E_OWNER_FLAG !== "0", senderId: process.env.BASHT_E2E_SENDER ?? e164, senderE164: process.env.BASHT_E2E_SENDER ?? e164, messageProvider: "whatsapp", chatType: "direct" });
	return f;
}
function bashtE2eOrigCreateCommandMaintenanceFollowup(params) {`);
fs.writeFileSync(f, t);
