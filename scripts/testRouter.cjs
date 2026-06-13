#!/usr/bin/env node
// Direct claude-format probe against /v1/messages (no MITM, no TLS) to check whether
// the response is translated back to Anthropic Messages format. Usage:
//   node testRouter.cjs <model> <stream:true|false>
const http = require("http");
const { cliToken } = require("./mitmctl.cjs");

const model = process.argv[2] || "cx/gpt-5.5";
const stream = (process.argv[3] || "true") === "true";
const mode = process.argv[4]; // "search" | "fetch" | undefined

let userText = "Reply with exactly: ROUTING_OK";
if (mode === "search") userText = "Use web_search to find the current latest stable Node.js LTS version, then state it with a source URL.";
if (mode === "fetch") userText = "Use web_fetch to fetch https://nodejs.org/en/about/previous-releases and tell me the current LTS version with the URL.";

const bodyObj = { model, max_tokens: 512, stream, messages: [{ role: "user", content: userText }] };
if (mode === "search") bodyObj.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
if (mode === "fetch") bodyObj.tools = [{ type: "web_fetch_20250305", name: "web_fetch", max_uses: 3 }];
const body = JSON.stringify(bodyObj);

const req = http.request({
  hostname: "localhost", port: 20128, path: "/v1/messages", method: "POST",
  headers: {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": "probe",
    "x-9r-cli-token": cliToken(),
    "Content-Length": Buffer.byteLength(body),
    ...(stream ? { Accept: "text/event-stream" } : {}),
  },
}, (res) => {
  console.log("HTTP", res.statusCode, "| ct:", res.headers["content-type"]);
  let buf = "";
  res.on("data", (c) => (buf += c));
  res.on("end", () => {
    console.log(buf.slice(0, 2500));
    // quick verdict
    if (/event: message_start|"type":"message_start"|"type":"message"/.test(buf)) console.log("\nVERDICT: ✅ Claude/Anthropic format");
    else if (/chat\.completion|"choices"/.test(buf)) console.log("\nVERDICT: ❌ OpenAI format leaked");
    else console.log("\nVERDICT: ? unrecognized");
  });
});
req.on("error", (e) => console.error("ERR", e.message));
req.setTimeout(120000, () => { req.destroy(new Error("timeout")); });
req.write(body);
req.end();
