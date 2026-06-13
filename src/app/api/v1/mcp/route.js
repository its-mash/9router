import { NextResponse } from "next/server";
import { getSettings, getCombos } from "@/lib/localDb";
import { runSearchQuery } from "@/sse/handlers/search.js";
import { runFetchQuery } from "@/sse/handlers/fetch.js";

/**
 * 9Router Search MCP server (Streamable-HTTP transport) at /v1/mcp.
 *
 * Lives under the /v1 (LLM-API) tree so it inherits the same auth model as the rest of the
 * router API: localhost is open; remote callers (e.g. WSL/Kali → host IP) need a valid API
 * key or CLI token (see dashboardGuard PUBLIC_PREFIXES). It is NOT the disabled cowork
 * stdio bridge at /api/mcp/[plugin] — that spawns external processes and is off by design.
 *
 * Exposes `web_search` + `web_fetch` so any MCP client (Claude Code, etc.) can search/fetch
 * through 9Router combos directly — model-agnostic, independent of Anthropic's native
 * server-side web_search or codex's hosted tools. Each tool routes to the user-selected
 * combo/provider; default is the first configured combo.
 *
 * Connect (Claude Code, on the host):
 *   claude mcp add --transport http 9router-search http://localhost:20128/v1/mcp
 * Remote (e.g. WSL/Kali), add an API key header:
 *   claude mcp add --transport http 9router-search http://<host-ip>:20128/v1/mcp --header "x-api-key: <sk_...>"
 *
 * Transport: single POST endpoint speaking JSON-RPC 2.0; single requests get a JSON
 * response (no server-initiated streaming needed for search). GET returns 405.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "9router-search", version: "1" };
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the public web via 9Router and return ranked results (title, URL, snippet). " +
      "Routes through the configured 9Router search combo/provider with fallback. Use for " +
      "current events, docs, prices, or anything outside the model's training data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: { type: "number", description: "Max results to return (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch the readable text content of a specific web page (or PDF) via 9Router. Routes " +
      "through the configured 9Router fetch combo/provider with fallback. Use to read a known URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The absolute URL to fetch." },
        max_characters: { type: "number", description: "Max characters to return (default 8000)." },
      },
      required: ["url"],
    },
  },
];

const log = {
  info: (tag, msg) => console.log(`[MCP] ${tag} ${msg}`),
  warn: (tag, msg) => console.warn(`[MCP] ${tag} ${msg}`),
  error: (tag, msg) => console.error(`[MCP] ${tag} ${msg}`),
};

// Resolve the combo/provider a tool should use. Priority: explicit MCP setting → first
// combo of the matching kind → first combo overall → single provider fallback.
async function resolveTarget(kind) {
  try {
    const settings = await getSettings();
    const key = kind === "webFetch" ? "mcpFetchCombo" : "mcpSearchCombo";
    const chosen = settings?.[key] && String(settings[key]).trim();
    if (chosen) return chosen;
    const combos = await getCombos();
    const list = Array.isArray(combos) ? combos : [];
    const sameKind = list.find((c) => c && c.kind === kind && Array.isArray(c.models) && c.models.length);
    if (sameKind?.name) return sameKind.name;
    const first = list.find((c) => c && c.name && Array.isArray(c.models) && c.models.length);
    if (first?.name) return first.name;
  } catch { /* fall through */ }
  return kind === "webFetch" ? "exa" : "gemini";
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callTool(name, args) {
  if (name === "web_search") {
    const query = typeof args?.query === "string" ? args.query : "";
    if (!query.trim()) return { content: [{ type: "text", text: "Missing 'query'." }], isError: true };
    const target = await resolveTarget("webSearch");
    const r = await runSearchQuery(query, { maxResults: Number(args?.max_results) || 8, target, log });
    const results = Array.isArray(r?.results) ? r.results : [];
    if (!results.length) {
      return { content: [{ type: "text", text: `No results (backend: ${target}).` }] };
    }
    const lines = results.map((x, i) => {
      const sn = x.snippet || x.content?.text || "";
      return `${i + 1}. ${x.title || "(untitled)"}\n   ${x.url || ""}${sn ? `\n   ${String(sn).slice(0, 300)}` : ""}`;
    });
    const head = r.answer ? `${r.answer}\n\n` : "";
    return { content: [{ type: "text", text: `${head}${lines.join("\n\n")}` }] };
  }
  if (name === "web_fetch") {
    const url = typeof args?.url === "string" ? args.url : "";
    if (!url.trim()) return { content: [{ type: "text", text: "Missing 'url'." }], isError: true };
    const target = await resolveTarget("webFetch");
    const r = await runFetchQuery(url, { maxCharacters: Number(args?.max_characters) || 8000, target, log });
    if (!r?.ok || !r?.text) {
      return { content: [{ type: "text", text: `Could not fetch ${url} (backend: ${target}).` }], isError: true };
    }
    const title = r.title ? `# ${r.title}\n${r.url}\n\n` : `${r.url}\n\n`;
    return { content: [{ type: "text", text: `${title}${r.text}` }] };
  }
  return null; // unknown tool
}

// Handle one JSON-RPC message. Returns a response object, or null for notifications.
async function handleRpc(msg) {
  if (!msg || typeof msg !== "object") return rpcError(null, -32600, "Invalid Request");
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "initialized":
      return null; // notification — no response
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await callTool(name, args);
        if (result === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
        return rpcResult(id, result);
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: `Tool error: ${e?.message || e}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // ignore unknown notifications
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(payload)) {
    const out = [];
    for (const m of payload) {
      const r = await handleRpc(m);
      if (r) out.push(r);
    }
    if (!out.length) return new NextResponse(null, { status: 202 });
    return NextResponse.json(out);
  }

  const r = await handleRpc(payload);
  if (!r) return new NextResponse(null, { status: 202 });
  return NextResponse.json(r);
}

export async function GET() {
  return new NextResponse("Method Not Allowed — use POST (JSON-RPC). MCP Streamable HTTP at /v1/mcp.", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
