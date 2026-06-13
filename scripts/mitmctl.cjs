#!/usr/bin/env node
// Direct 9router control via the CLI-token auth path (x-9r-cli-token) — same mechanism
// the bundled CLI uses. Lets us drive /api routes (incl. local-only MITM) without a
// browser login. Token = sha256(rawMachineId + "9r-cli-auth" + cliSecret)[:16].
//
// Usage:
//   node mitmctl.cjs <METHOD> <path> [jsonBody]
//   node mitmctl.cjs token
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR
  || (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router"));

function read(f) { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } }

function cliToken() {
  const raw = read(path.join(DATA_DIR, "machine-id"));
  const secret = read(path.join(DATA_DIR, "auth", "cli-secret"));
  if (!raw) return "";
  return crypto.createHash("sha256").update(raw + "9r-cli-auth" + secret).digest("hex").substring(0, 16);
}

function request(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const req = http.request({
      hostname: "localhost", port: Number(process.env.PORT || 20128), path: p, method,
      headers: {
        "Content-Type": "application/json",
        "Host": "localhost",
        "Origin": "http://localhost:20128",
        "x-9r-cli-token": cliToken(),
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let parsed; try { parsed = buf ? JSON.parse(buf) : {}; } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    req.setTimeout(120000, () => { req.destroy(); resolve({ status: 0, body: { error: "timeout" } }); });
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { cliToken, request, DATA_DIR };

if (require.main === module) {
  (async () => {
    const [, , method, p, ...rest] = process.argv;
    if (method === "token") { console.log(cliToken()); return; }
    if (!method || !p) { console.log("usage: mitmctl.cjs <METHOD> <path> [json]"); process.exit(1); }
    const bodyArg = rest.join(" ") || null;
    const r = await request(method.toUpperCase(), p, bodyArg);
    console.log("HTTP", r.status);
    console.log(typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2));
  })();
}
