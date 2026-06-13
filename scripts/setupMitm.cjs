#!/usr/bin/env node
// Full MITM-for-Claude-Code setup via the CLI-token API path. Bodies are real JS
// objects (no shell quoting). Idempotent-ish: safe to re-run.
const { request } = require("./mitmctl.cjs");

const ALIASES = {
  "claude-opus": "claude-opus-4-8",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-haiku": "claude-haiku-4-5",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("1) status (before)");
  let s = await request("GET", "/api/cli-tools/antigravity-mitm");
  console.log("   ", JSON.stringify(s.body));

  if (!s.body?.running) {
    console.log("2) start MITM server (cert + 443)…");
    const start = await request("POST", "/api/cli-tools/antigravity-mitm", {
      apiKey: "sk-9router-mitm",
      forceKillPort443: true,
    });
    console.log("   HTTP", start.status, JSON.stringify(start.body));
    if (start.status !== 200) { console.log("   ABORT: start failed"); process.exit(1); }
  } else {
    console.log("2) MITM already running (pid", s.body.pid, ")");
  }

  // Poll until healthy + cert present
  for (let i = 0; i < 20; i++) {
    s = await request("GET", "/api/cli-tools/antigravity-mitm");
    if (s.body?.running && s.body?.certExists) break;
    await sleep(750);
  }
  console.log("3) status (after start):", JSON.stringify(s.body));

  console.log("4) enable DNS for anthropic (hosts → 127.0.0.1 api.anthropic.com)…");
  const dns = await request("PATCH", "/api/cli-tools/antigravity-mitm", {
    tool: "anthropic",
    action: "enable",
  });
  console.log("   HTTP", dns.status, JSON.stringify(dns.body));

  console.log("5) bind tier → combo aliases:", JSON.stringify(ALIASES));
  const alias = await request("PUT", "/api/cli-tools/antigravity-mitm/alias", {
    tool: "anthropic",
    mappings: ALIASES,
  });
  console.log("   HTTP", alias.status, JSON.stringify(alias.body));

  console.log("6) final status");
  s = await request("GET", "/api/cli-tools/antigravity-mitm");
  console.log("   ", JSON.stringify(s.body));

  const cur = await request("GET", "/api/cli-tools/antigravity-mitm/alias?tool=anthropic");
  console.log("   aliases:", JSON.stringify(cur.body));
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
