#!/usr/bin/env node
// Probe the 9Router MCP endpoint. Usage: node mcpProbe.cjs [port]
const http = require("http");
const { cliToken } = require("./mitmctl.cjs");
const PORT = Number(process.argv[2] || 20131);
const TOKEN = cliToken();

function rpc(method, params, id) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path: "/api/v1/mcp", method: "POST",
      headers: { "Content-Type": "application/json", "x-9r-cli-token": TOKEN, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let buf = ""; res.on("data", c => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf, status: res.statusCode }); } });
    });
    req.on("error", reject); req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } }, 1); if (r?.result) return r; }
    catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("server did not become ready");
}

(async () => {
  const init = await waitReady();
  console.log("initialize →", JSON.stringify(init.result?.serverInfo), "proto", init.result?.protocolVersion, "caps", JSON.stringify(init.result?.capabilities));
  const list = await rpc("tools/list", {}, 2);
  console.log("tools/list →", (list.result?.tools || []).map(t => t.name).join(", "));
  console.log("\ncalling web_search …");
  const call = await rpc("tools/call", { name: "web_search", arguments: { query: "current latest stable Node.js LTS version", max_results: 4 } }, 3);
  const c = call.result?.content?.[0]?.text || JSON.stringify(call).slice(0, 400);
  console.log("web_search isError:", call.result?.isError ?? false);
  console.log(c.slice(0, 900));
})().catch(e => { console.error("PROBE FAILED:", e.message); process.exit(1); });
