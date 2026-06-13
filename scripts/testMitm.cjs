#!/usr/bin/env node
// Simulate Claude Code hitting api.anthropic.com (redirected by hosts → MITM on :443).
// Trust the MITM root CA explicitly via the `ca` option (NODE_EXTRA_CA_CERTS only
// affects newly-spawned processes). Sends an Anthropic Messages request and prints
// what comes back through MITM → /v1/messages → combo.
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, "9router") : path.join(os.homedir(), ".9router");
const CA = fs.readFileSync(path.join(DATA_DIR, "mitm", "rootCA.crt"));

const mode = process.argv[2] || "basic"; // basic | stream | search | count
const wantStream = mode === "stream" || mode === "search";
const isCount = mode === "count";

const body = {
  model: process.argv[3] || "claude-haiku-4-5",
  max_tokens: 256,
  stream: wantStream,
  messages: [{ role: "user", content: mode === "search" ? "Search the web: what is the latest stable Node.js LTS version? cite sources." : "Reply with exactly: ROUTING_OK" }],
};
if (mode === "search") {
  body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
}

const data = JSON.stringify(body);
const reqPath = isCount ? "/v1/messages/count_tokens" : "/v1/messages";
const req = https.request({
  host: "api.anthropic.com", port: 443, path: reqPath, method: "POST",
  servername: "api.anthropic.com", ca: CA,
  headers: {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": "test-cc-key",
    "Content-Length": Buffer.byteLength(data),
    ...(wantStream ? { Accept: "text/event-stream" } : {}),
  },
}, (res) => {
  console.log("HTTP", res.statusCode, "| content-type:", res.headers["content-type"]);
  let buf = "";
  res.on("data", (c) => {
    buf += c;
    if (wantStream) process.stdout.write(c.toString());
  });
  res.on("end", () => {
    if (!wantStream) console.log(buf.slice(0, 4000));
    else console.log("\n--- stream end ---");
  });
});
req.on("error", (e) => console.error("REQ ERROR:", e.message));
req.setTimeout(90000, () => { req.destroy(new Error("timeout")); });
req.write(data);
req.end();
