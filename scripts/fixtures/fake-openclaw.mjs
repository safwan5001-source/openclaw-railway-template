// Test double for the OpenClaw CLI entry (OPENCLAW_ENTRY), used by src/server-security.test.mjs.
// `gateway run --port N` starts a loopback HTTP server that ECHOES what the wrapper forwarded (Authorization header,
// body, whether SETUP_PASSWORD leaked into its environment). Every other subcommand succeeds without doing anything.
// No network beyond 127.0.0.1, no real OpenClaw, no secrets.
import http from "node:http";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("OpenClaw 0.0.0-fake");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "run") {
  const port = Number(args[args.indexOf("--port") + 1]);
  const envHasSetupPassword = Object.prototype.hasOwnProperty.call(process.env, "SETUP_PASSWORD");
  const server = http.createServer((req, res) => {
    if (req.url === "/startupz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"ok":true}');
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          fake: true,
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
          envHasSetupPassword,
        }),
      );
    });
  });
  server.on("upgrade", (req, socket) => {
    const seen = (req.headers.authorization ?? "none").replace(/[\r\n]/g, "");
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `X-Seen-Authorization: ${seen}\r\n\r\n`,
    );
  });
  server.listen(port, "127.0.0.1");
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  // config get/set, doctor, models, pairing, devices ...: succeed silently.
  process.exit(args[0] === "config" && args[1] === "get" ? 1 : 0);
}
