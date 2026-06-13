#!/usr/bin/env node
// Probe how the RUNNING build handles each web_search tool VERSION (CC picks the version
// from the model name: opus/sonnet → web_search_20260209). Usage:
//   node searchVersionTest.cjs <model> <toolType>
//   e.g. node searchVersionTest.cjs 9opus web_search_20260209
const http = require("http");
const { cliToken } = require("./mitmctl.cjs");

const model = process.argv[2] || "9opus";
const toolType = process.argv[3] || "web_search_20260209";
const body = JSON.stringify({
  model, max_tokens: 512, stream: false,
  messages: [{ role: "user", content: "Use web_search to find the current latest stable Node.js LTS version, then state it with a source URL." }],
  tools: [{ type: toolType, name: "web_search", max_uses: 3 }],
});

const req = http.request({
  hostname: "localhost", port: 20128, path: "/v1/messages", method: "POST",
  headers: {
    "Content-Type": "application/json", "anthropic-version": "2023-06-01",
    "x-api-key": "probe", "x-9r-cli-token": cliToken(),
    "Content-Length": Buffer.byteLength(body),
  },
}, (res) => {
  let buf = ""; res.on("data", (c) => (buf += c));
  res.on("end", () => {
    let j; try { j = JSON.parse(buf); } catch { console.log("non-JSON:", buf.slice(0, 400)); return; }
    const blocks = Array.isArray(j.content) ? j.content : [];
    const searches = blocks.filter((b) => b.type === "server_tool_use" && b.name === "web_search").length;
    const results = blocks.filter((b) => b.type === "web_search_tool_result").length;
    console.log(`tool=${toolType} model=${model} → HTTP ${res.statusCode}`);
    console.log(`  server_tool_use(web_search)=${searches}  web_search_tool_result=${results}`);
    console.log(`  block types: ${blocks.map((b) => b.type).join(", ") || "(none)"}`);
    if (searches === 0) console.log("  ⚠️  NO SEARCH ENGAGED — this is the 'Did 0 searches' bug for this tool version.");
  });
});
req.on("error", (e) => console.error("ERR", e.message));
req.setTimeout(120000, () => req.destroy(new Error("timeout")));
req.write(body); req.end();
