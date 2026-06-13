#!/usr/bin/env node
// Verify the MITM native-passthrough usage endpoint records into the usage store.
const { request } = require("./mitmctl.cjs");
(async () => {
  const rec = {
    provider: "claude",
    model: "claude-opus-4-8",
    tokens: { input_tokens: 1234, output_tokens: 56 },
    endpoint: "/v1/messages",
    request: { model: "claude-opus-4-8", stream: true },
    response: { content: "(native passthrough)", finish_reason: "end_turn" },
  };
  const r = await request("POST", "/api/cli-tools/mitm-usage", rec);
  console.log("POST /api/cli-tools/mitm-usage ->", r.status, JSON.stringify(r.body));

  // Peek the usage API to confirm a row landed
  const u = await request("GET", "/api/usage?limit=5");
  console.log("GET /api/usage ->", u.status);
  const body = u.body;
  const rows = body?.requests || body?.details || body?.records || body?.data || body?.items || [];
  if (Array.isArray(rows) && rows.length) {
    console.log("recent rows:", rows.slice(0, 3).map((x) => `${x.provider}/${x.model} in=${x.tokens?.prompt_tokens ?? x.tokens?.input_tokens ?? "?"} out=${x.tokens?.completion_tokens ?? x.tokens?.output_tokens ?? "?"}`).join(" | "));
  } else {
    console.log("usage body keys:", body && typeof body === "object" ? Object.keys(body) : typeof body);
  }
})();
