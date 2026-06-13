#!/usr/bin/env node
// Toggle the MITM hosts redirect for a tool without touching the running MITM server.
//   node dnsToggle.cjs disable [tool]   → remove hosts entry (stop intercepting)
//   node dnsToggle.cjs enable  [tool]   → add hosts entry (resume intercepting)
const { request } = require("./mitmctl.cjs");
const action = (process.argv[2] || "disable").toLowerCase();
const tool = process.argv[3] || "anthropic";
request("PATCH", "/api/cli-tools/antigravity-mitm", { tool, action })
  .then((r) => console.log("HTTP", r.status, JSON.stringify(r.body)))
  .catch((e) => { console.error(e); process.exit(1); });
