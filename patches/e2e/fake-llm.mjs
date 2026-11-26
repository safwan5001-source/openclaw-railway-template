// Scripted OpenAI-compatible chat-completions server for the memory-flush E2E. Logs every request to $LOG.
import http from "node:http";
import fs from "node:fs";
const PORT = Number(process.env.PORT || 18555);
const LOG = process.env.LOG;
const BIG = Number(process.env.BIG_PROMPT_TOKENS || 90000);
const FACT = "- BASHT-E2E owner fact: warehouse gate code is ZEBRA-4417";
let n = 0;
const text = (m) => typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? "").join("") : "";
function classify(body) {
  const msgs = body.messages ?? [];
  const all = msgs.map(text).join("\n");
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const last = msgs.at(-1);
  if (/Pre-compaction memory flush/.test(text(lastUser)) || /Pre-compaction memory flush turn/.test(all) && !body.tools?.some((t) => t.function?.name === "exec")) return { phase: "flush", last, lastUser, all };
  if (!body.tools?.length && /summar/i.test(all)) return { phase: "compaction", last, lastUser, all };
  if (/RECALL/.test(text(lastUser))) return { phase: "recall", last, lastUser, all };
  return { phase: "chat", last, lastUser, all };
}
function respond(res, body, reply, usagePrompt) {
  const id = `cmpl-${++n}`;
  const usage = { prompt_tokens: usagePrompt, completion_tokens: 20, total_tokens: usagePrompt + 20 };
  if (!body.stream) {
    const message = reply.toolCall ? { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }] } : { role: "assistant", content: reply.text };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id, object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: reply.toolCall ? "tool_calls" : "stop" }], usage }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (o) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, ...o })}\n\n`);
  if (reply.toolCall) {
    send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }] }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    send({ choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  send({ choices: [], usage });
  res.end("data: [DONE]\n\n");
}
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "m1", object: "model" }] })); }
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const c = classify(body);
    const tools = (body.tools ?? []).map((t) => t.function?.name).sort();
    const datePath = (c.all.match(/memory\/\d{4}-\d{2}-\d{2}\.md/) ?? [])[0];
    let reply;
    if (c.phase === "flush") {
      if (c.last?.role === "tool") reply = { text: "NO_REPLY" };
      else if (!tools.includes("write")) reply = { text: "NO_REPLY" };
      else reply = { toolCall: { name: "write", args: { path: datePath, content: `${FACT}\n` } } };
    } else if (c.phase === "compaction") {
      reply = { text: "## Summary\nOwner set up the BASHT E2E session and shared a warehouse fact." };
    } else if (c.phase === "recall") {
      if (c.last?.role === "tool") reply = { text: `RECALLED: ${/ZEBRA-4417/.test(text(c.last)) ? "ZEBRA-4417" : "NOT-FOUND"}` };
      else reply = { toolCall: { name: "read", args: { path: process.env.RECALL_PATH || datePath || "memory/missing.md" } } };
    } else {
      reply = { text: "ack" };
    }
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ n: n + 1, phase: c.phase, tools, lastRole: c.last?.role, lastUser: text(c.lastUser).slice(-160), datePath, reply: reply.toolCall ? `tool:${reply.toolCall.name}` : reply.text.slice(0, 40) }) + "\n");
    respond(res, body, reply, c.phase === "chat" ? BIG : 2000);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake-llm on ${PORT}`));
