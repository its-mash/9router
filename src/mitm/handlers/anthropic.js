const { log, err } = require("../logger");
const { fetchRouter, pipeSSE } = require("./base");
const https = require("https");
const http = require("http");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { DATA_DIR } = require("../paths");

/**
 * Claude Code ⇄ Anthropic MITM handler.
 *
 * Routing model (see redesign):
 *   • Native Anthropic model id (e.g. claude-opus-4-8) → PURE passthrough to the real
 *     api.anthropic.com with the client's own token/headers. No re-routing, no fallback —
 *     genuine Anthropic behavior (native web_search/computer-use, real rate limits).
 *   • 9router combo id, exposed as "9r/<combo>" → strip the prefix and forward to 9Router's
 *     /v1/messages, which runs the combo (fallback across providers) + the web_search shim.
 *   • GET /v1/models → enrich Anthropic's native model list with the 9router combos (as
 *     "9r/<combo>") so Claude Code (and its subagents) can see + select them.
 *   • /v1/messages/count_tokens → passthrough (it is matched by the broad "/v1/messages"
 *     substring but is NOT a chat completion).
 *
 * 9Router's OWN upstream calls to api.anthropic.com carry x-request-source:local and are
 * passed through by the MITM dispatcher before reaching here (prevents a combo→claude loop).
 */

const COMBO_PREFIX = "9r/";
const ROUTER_BASE = String(process.env.MITM_ROUTER_BASE || "http://localhost:20128").replace(/\/+$/, "");

// Diagnostic capture: when DATA_DIR/mitm-capture.on exists, dump the incoming /v1/messages
// body (model + tools) for any request carrying server tools. Lets us inspect EXACTLY what
// Claude Code sends (web_search version, code_execution, allowed_domains) without dev mode.
function captureSearchRequest(body) {
  try {
    if (!fs.existsSync(path.join(DATA_DIR, "mitm-capture.on"))) return;
    const out = {
      at: new Date().toISOString(),
      model: body?.model,
      stream: body?.stream,
      tools: Array.isArray(body?.tools) ? body.tools.map((t) => ({ type: t?.type, name: t?.name, allowed_domains: t?.allowed_domains })) : [],
      tool_choice: body?.tool_choice,
    };
    fs.writeFileSync(path.join(DATA_DIR, "logs", "cc-search-last.json"), JSON.stringify(out, null, 2));
  } catch { /* never break the request */ }
}

// Detect Anthropic server-side web tools in a /v1/messages body (for console visibility).
function serverToolFlags(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  let search = false, fetch = false;
  for (const t of tools) {
    const ty = typeof t?.type === "string" ? t.type : "";
    if (ty.startsWith("web_search")) search = true;
    else if (ty.startsWith("web_fetch")) fetch = true;
  }
  return { search, fetch, any: search || fetch };
}

// Resolve a hostname via public DNS (8.8.8.8) to bypass the hosts-file MITM redirect.
async function realIp(hostname) {
  const r = new dns.Resolver();
  r.setServers(["8.8.8.8"]);
  const resolve4 = promisify(r.resolve4.bind(r));
  const addrs = await resolve4(hostname);
  return addrs[0];
}

// CLI token (same scheme as the bundled CLI / mitmctl) to reach guarded /api routes.
function cliToken() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, "machine-id"), "utf8").trim();
    let secret = "";
    try { secret = fs.readFileSync(path.join(DATA_DIR, "auth", "cli-secret"), "utf8").trim(); } catch { /* optional */ }
    if (!raw) return "";
    return crypto.createHash("sha256").update(raw + "9r-cli-auth" + secret).digest("hex").substring(0, 16);
  } catch { return ""; }
}

function getJson(url, headers, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, { method: "GET", headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.end();
  });
}

// Fetch a REAL Anthropic endpoint (whatever req.url is) bypassing the hosts redirect,
// using the client's own auth/headers. Used to enrich /v1/models AND /api/claude_cli/bootstrap.
function fetchRealAnthropic(req) {
  return new Promise(async (resolve) => {
    try {
      const ip = await realIp("api.anthropic.com");
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (["host", "content-length", "connection", "accept-encoding"].includes(lk)) continue;
        headers[k] = v;
      }
      headers.host = "api.anthropic.com";
      const r = https.request({ host: ip, servername: "api.anthropic.com", port: 443, path: req.url, method: "GET", headers, rejectUnauthorized: false }, (resp) => {
        let buf = "";
        resp.on("data", (c) => (buf += c));
        resp.on("end", () => { try { resolve({ status: resp.statusCode, json: JSON.parse(buf) }); } catch { resolve({ status: resp.statusCode, json: null }); } });
      });
      r.on("error", () => resolve({ status: 0, json: null }));
      r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, json: null }); });
      r.end();
    } catch { resolve({ status: 0, json: null }); }
  });
}

// 9router chat combos (exclude dedicated webSearch/webFetch combos — those aren't models).
async function fetchComboNames() {
  const { status, json } = await getJson(`${ROUTER_BASE}/api/combos`, { "x-9r-cli-token": cliToken(), "Content-Type": "application/json" });
  if (status !== 200 || !json) return [];
  const combos = Array.isArray(json.combos) ? json.combos : [];
  return combos.filter((c) => c && c.name && c.kind !== "webSearch" && c.kind !== "webFetch").map((c) => c.name);
}

// Fire-and-forget POST of a usage record to 9Router so native-passthrough ("direct")
// traffic also appears in the usage tab (combo traffic is already tracked via /v1/messages).
function postUsage(rec) {
  try {
    const data = JSON.stringify(rec);
    const u = new URL(`${ROUTER_BASE}/api/cli-tools/mitm-usage`);
    const mod = u.protocol === "https:" ? https : http;
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-9r-cli-token": cliToken(), "Content-Length": Buffer.byteLength(data) },
    });
    r.on("error", () => {});
    r.write(data);
    r.end();
  } catch { /* ignore */ }
}

// Parse Anthropic usage from a passthrough response (SSE or JSON) and record it.
function recordPassthroughUsage(reqBody, respBuf, respHeaders) {
  try {
    const ct = String((respHeaders && (respHeaders["content-type"] || respHeaders["Content-Type"])) || "");
    const text = respBuf ? respBuf.toString("utf8") : "";
    let model = (reqBody && reqBody.model) || "unknown";
    let input = 0, output = 0;
    if (ct.includes("text/event-stream") || text.startsWith("event:")) {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        try {
          const j = JSON.parse(t.slice(5).trim());
          if (j.type === "message_start" && j.message) { input = j.message.usage?.input_tokens ?? input; model = j.message.model || model; }
          if (j.type === "message_delta" && j.usage) { output = j.usage.output_tokens ?? output; }
        } catch { /* skip */ }
      }
    } else {
      try { const j = JSON.parse(text); if (j.usage) { input = j.usage.input_tokens || 0; output = j.usage.output_tokens || 0; } model = j.model || model; } catch { /* skip */ }
    }
    if (!input && !output) return; // error / non-usage response
    postUsage({
      provider: "claude",
      model,
      tokens: { input_tokens: input, output_tokens: output },
      endpoint: "/v1/messages",
      request: { model, stream: reqBody?.stream !== false },
    });
  } catch { /* never break passthrough */ }
}

// GET /v1/models → native Anthropic list + 9router combos (as 9r/<combo>).
async function enrichModels(req, res, bodyBuffer, passthrough) {
  try {
    const [real, comboNames] = await Promise.all([fetchRealAnthropic(req), fetchComboNames()]);
    if (!real.json || !Array.isArray(real.json.data)) {
      return passthrough(req, res, bodyBuffer); // can't read native list → leave untouched
    }
    const nowIso = new Date().toISOString();
    const comboModels = comboNames.map((name) => ({
      type: "model",
      id: `${COMBO_PREFIX}${name}`,
      display_name: `9router · ${name}`,
      created_at: nowIso,
    }));
    const merged = { ...real.json, data: [...comboModels, ...real.json.data] };
    res.writeHead(real.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(merged));
  } catch (e) {
    err(`[anthropic] models enrich failed: ${e.message}`);
    return passthrough(req, res, bodyBuffer);
  }
}

// GET /api/claude_cli/bootstrap → Claude Code's firstParty model bootstrap. CC reads
// `additional_model_options: [{model,name,description}]` from it (no model-name filter,
// unlike gateway /v1/models). Inject the 9router combos as 9r/<combo> so they appear in
// Claude Code's model picker for a normal (non-gateway) Anthropic account.
async function enrichBootstrap(req, res, bodyBuffer, passthrough) {
  try {
    const [real, comboNames] = await Promise.all([fetchRealAnthropic(req), fetchComboNames()]);
    if (!real.json || typeof real.json !== "object") {
      return passthrough(req, res, bodyBuffer);
    }
    const injected = comboNames.map((name) => ({
      model: `${COMBO_PREFIX}${name}`,
      name: `9router · ${name}`,
      description: "9Router combo — fallback across providers + web search/fetch",
    }));
    const existing = Array.isArray(real.json.additional_model_options) ? real.json.additional_model_options : [];
    real.json.additional_model_options = [...injected, ...existing];
    res.writeHead(real.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(real.json));
  } catch (e) {
    err(`[anthropic] bootstrap enrich failed: ${e.message}`);
    return passthrough(req, res, bodyBuffer);
  }
}

async function handle(req, res, bodyBuffer, passthrough) {
  const url = req.url || "";
  try {
    // Claude Code firstParty model bootstrap → inject combos as picker options (9r/<combo>)
    if (req.method === "GET" && url.includes("/api/claude_cli/bootstrap")) {
      return await enrichBootstrap(req, res, bodyBuffer, passthrough);
    }
    // Model list (gateway mode) → enrich with combos
    if (req.method === "GET" && url.includes("/v1/models")) {
      return await enrichModels(req, res, bodyBuffer, passthrough);
    }
    // Token counting is not a chat completion → pure passthrough
    if (url.includes("/v1/messages/count_tokens")) {
      return passthrough(req, res, bodyBuffer);
    }
    // Chat completions
    if (req.method === "POST" && url.includes("/v1/messages")) {
      let body;
      try { body = JSON.parse(bodyBuffer.toString()); } catch { return passthrough(req, res, bodyBuffer); }
      const model = typeof body?.model === "string" ? body.model : "";
      const tf = serverToolFlags(body);
      if (tf.any) captureSearchRequest(body);
      if (model.startsWith(COMBO_PREFIX)) {
        // 9router combo → run the combo pipeline (fallback + web_search/fetch shim)
        const combo = model.slice(COMBO_PREFIX.length);
        body.model = combo;
        if (tf.any) {
          const kinds = [tf.search && "web_search", tf.fetch && "web_fetch"].filter(Boolean).join("+");
          log(`🔍 9r/${combo} → combo + ${kinds} shim (fulfilled by 9Router)`);
        } else {
          log(`🔀 9r/${combo} → combo`);
        }
        const routerRes = await fetchRouter(body, "/v1/messages", req.headers);
        return await pipeSSE(routerRes, res);
      }
      // Native Anthropic model → pure passthrough (their token, their limits, no fallback).
      // Tee the response to record usage so native ("direct") traffic shows in the usage tab.
      if (tf.any) {
        const kinds = [tf.search && "web_search", tf.fetch && "web_fetch"].filter(Boolean).join("+");
        log(`🌐 native ${model} passthrough — ${kinds} served by Anthropic (not shimmed)`);
      }
      return passthrough(req, res, bodyBuffer, (respBuf, respHeaders) => recordPassthroughUsage(body, respBuf, respHeaders));
    }
    // Anything else on this host (oauth, usage, etc.) → passthrough
    return passthrough(req, res, bodyBuffer);
  } catch (error) {
    err(`[anthropic] ${error.message}`);
    const isStream = (() => { try { return JSON.parse(bodyBuffer.toString()).stream !== false; } catch { return true; } })();
    if (!res.headersSent) res.writeHead(isStream ? 200 : 500, { "Content-Type": isStream ? "text/event-stream" : "application/json" });
    if (isStream) res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "mitm_error", message: error.message } })}\n\n`);
    else res.end(JSON.stringify({ type: "error", error: { type: "mitm_error", message: error.message } }));
  }
}

// `intercept` kept as an alias for the generic dispatcher signature; `handle` is the entry.
module.exports = { handle, intercept: handle };
