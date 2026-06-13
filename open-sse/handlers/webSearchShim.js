/**
 * Response-driven web_search shim (Phase 3) + computer-use handling (Phase 5).
 *
 * Claude Code sends a server-side tool `{type:"web_search_20250305", name:"web_search"}`.
 * - Anthropic-native resolved model → caller passes through (native server-side search
 *   just works; this module is never invoked for that case).
 * - NON-Anthropic resolved model → this shim runs an internal NON-STREAMING loop:
 *     1. present web_search to the model as a plain function tool;
 *     2. call the model (via injected `callModel`, stream:false) and inspect the reply;
 *     3. if it emits a `web_search` tool_use → fulfill via the search-wrapper registry
 *        (free-first), append the result, re-call; loop up to MAX_ITERS;
 *     4. if it emits OTHER (client) tool_use, or finishes with text → stop;
 *     5. STREAM the final message back to Claude Code as synthesized Claude SSE,
 *        injecting `server_tool_use` + `web_search_tool_result` blocks so CC renders
 *        native-looking search + citations.
 *
 * On a subsequent turn CC replays our synthesized search blocks; sanitizeHistory()
 * converts them to plain text before they reach the (non-Anthropic) model, which
 * can't consume server_tool_use/web_search_tool_result blocks.
 */

const SEARCH_TOOL_TYPE = "web_search_20250305";
const MAX_ITERS = 4;
const enc = new TextEncoder();

export function isAnthropicNative(provider) {
  return provider === "anthropic" || provider === "claude";
}

/** Does the request carry the Anthropic server-side web_search tool? */
export function requestWantsWebSearch(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some((t) => t?.type === SEARCH_TOOL_TYPE || (typeof t?.type === "string" && t.type.startsWith("web_search")));
}

/** Does the request carry the Anthropic server-side web_fetch tool? */
export function requestWantsWebFetch(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some((t) => typeof t?.type === "string" && t.type.startsWith("web_fetch"));
}

/** Does the request carry ANY server-side tool the shim fulfills (web_search or web_fetch)? */
export function requestWantsServerTool(body) {
  return requestWantsWebSearch(body) || requestWantsWebFetch(body);
}

const isSearchToolName = (n) => typeof n === "string" && /(^|_)web_search$/.test(n.replace(/^proxy_|^claude_/i, ""));
const isFetchToolName = (n) => typeof n === "string" && /(^|_)web_fetch$/.test(n.replace(/^proxy_|^claude_/i, ""));

/**
 * Convert the request for a non-Anthropic model:
 *  - web_search_20250305 (+ web_fetch) server-tools → a plain `web_search` function tool;
 *  - computer_* server-tools → STRIPPED (Phase 5: Remote Desktop can't work off-Anthropic);
 *  - sanitize history of any previously-synthesized server_tool_use/web_search_tool_result.
 * Returns a NEW body (does not mutate the original).
 */
export function prepareBodyForNonAnthropic(body) {
  const out = { ...body };
  out.messages = sanitizeHistory(body.messages);
  out.tools = mapTools(body.tools);
  return out;
}

function mapTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const mapped = [];
  for (const t of tools) {
    const type = t?.type;
    if (type === SEARCH_TOOL_TYPE || (typeof type === "string" && type.startsWith("web_search"))) {
      // CLAUDE-format custom tool (the shim's callModel sends a Claude-source request,
      // so the claude→provider translator expects {name, description, input_schema} —
      // NOT an OpenAI {type:"function",function:{…}} shape).
      mapped.push({
        name: "web_search",
        description: "Search the public web and return relevant results (title, url, snippet) for a query.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "The search query." } },
          required: ["query"]
        }
      });
    } else if (typeof type === "string" && type.startsWith("web_fetch")) {
      // Map web_fetch → a plain function tool; fulfilled via the webFetch combo (exa, …).
      mapped.push({
        name: "web_fetch",
        description: "Fetch the full contents (text) of a web page given its URL.",
        input_schema: {
          type: "object",
          properties: { url: { type: "string", description: "The URL of the page to fetch." } },
          required: ["url"]
        }
      });
    } else if (typeof type === "string" && (type.startsWith("computer_") || type.startsWith("bash_") || type.startsWith("text_editor"))) {
      // Anthropic-only server tools — drop for non-Anthropic models (Phase 5).
      continue;
    } else {
      mapped.push(t);
    }
  }
  return mapped;
}

/** Replace synthesized server_tool_use / web_search_tool_result blocks with plain text. */
function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const content = [];
    for (const block of m.content) {
      if (block?.type === "server_tool_use") {
        const label = block.name === "web_fetch"
          ? `[fetched page: ${block.input?.url || ""}]`
          : `[searched the web for: ${block.input?.query || ""}]`;
        content.push({ type: "text", text: label });
      } else if (block?.type === "web_search_tool_result") {
        const items = Array.isArray(block.content) ? block.content : [];
        const lines = items
          .filter((it) => it?.type === "web_search_result")
          .map((it, i) => `${i + 1}. ${it.title || ""} — ${it.url || ""}`);
        content.push({ type: "text", text: `[web search results]\n${lines.join("\n")}` });
      } else if (block?.type === "web_fetch_tool_result") {
        const url = block.content?.url || "";
        content.push({ type: "text", text: `[fetched web page: ${url}]` });
      } else {
        content.push(block);
      }
    }
    return { ...m, content };
  });
}

/** Compact text rendering of results to feed back to the model as a tool_result. */
function resultsToToolResultText(results) {
  if (!results?.length) return "No results found.";
  return results
    .slice(0, 8)
    .map((r, i) => {
      const sn = r.snippet || r.content?.text || "";
      return `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}\n   ${sn ? sn.slice(0, 300) : ""}`.trimEnd();
    })
    .join("\n\n");
}

function openaiUsageToClaude(u) {
  if (!u) return undefined;
  return { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 };
}

/**
 * Normalize a model reply into a Claude-shaped message {content:[…blocks], stop_reason, model, usage}.
 *
 * 9Router's NON-streaming path (handleNonStreamingResponse) always emits OpenAI
 * `chat.completion` regardless of the client's source format — so the shim's internal
 * callModel(stream:false) returns OpenAI here. Convert tool_calls → Claude `tool_use`
 * blocks and content → a `text` block. (Also passes through an already-Claude body in
 * case the non-streaming translation is ever fixed upstream.)
 */
function normalizeReply(raw) {
  if (Array.isArray(raw?.content)) {
    return { id: raw.id, content: raw.content, stop_reason: raw.stop_reason, model: raw.model, usage: raw.usage };
  }
  const choice = raw?.choices?.[0];
  const m = choice?.message || {};
  const blocks = [];
  const text = typeof m.content === "string" ? m.content : "";
  if (text) blocks.push({ type: "text", text });
  for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
    let input = {};
    try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
    blocks.push({ type: "tool_use", id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`, name: tc.function?.name, input });
  }
  const fr = choice?.finish_reason;
  const stop_reason = fr === "tool_calls" ? "tool_use" : fr === "stop" ? "end_turn" : (fr || "end_turn");
  return { id: raw?.id, content: blocks, stop_reason, model: raw?.model, usage: openaiUsageToClaude(raw?.usage) };
}

/**
 * Run the shim. Returns a `{ success, response }` shaped like handleChatCore's result.
 * @param {object} p
 * @param {object} p.body - original Claude-format request (with web_search_20250305)
 * @param {(messages:Array, stream:boolean)=>Promise<{success:boolean,response?:Response,status?:number,error?:string}>} p.callModel
 *        - calls the resolved model with the given messages; stream:false returns Claude-format JSON.
 * @param {(query:string)=>Promise<{ok:boolean,results:Array}>} p.search - fulfiller (searchWrappers.runSearch bound to backends)
 * @param {object} [p.log]
 */
export async function runWebSearchShim({ body, callModel, search, fetch, log }) {
  const wantStream = body.stream !== false;
  const prepared = prepareBodyForNonAnthropic(body);
  let messages = prepared.messages.slice();
  const serverCalls = []; // { id, kind:"search"|"fetch", query?/url?, results?/fetched? }
  log?.info?.("SHIM", `web-tool shim engaged (search=${requestWantsWebSearch(body)} fetch=${requestWantsWebFetch(body)}) model=${body?.model || "?"}`);

  let finalMessage = null;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const res = await callModel(messages, false /* non-streaming */, prepared.tools);
    if (!res?.success || !res.response) {
      // Bubble the failure up; caller will handle fallback/error.
      return res || { success: false, status: 502, error: "shim: model call failed" };
    }
    let raw;
    try { raw = await res.response.json(); }
    catch { return { success: false, status: 502, error: "shim: non-JSON model response" }; }
    const msg = normalizeReply(raw);

    const content = Array.isArray(msg?.content) ? msg.content : [];
    const toolUses = content.filter((b) => b?.type === "tool_use");
    const serverUses = toolUses.filter((b) => isSearchToolName(b.name) || isFetchToolName(b.name));
    const otherUses = toolUses.filter((b) => !isSearchToolName(b.name) && !isFetchToolName(b.name));

    // Model wants a CLIENT tool (Read/Bash/etc.) or finished with text → stop looping.
    if (otherUses.length > 0 || serverUses.length === 0) {
      finalMessage = msg;
      break;
    }

    // Fulfill each server tool (web_search / web_fetch), then loop with results appended.
    messages.push({ role: "assistant", content });
    const toolResults = [];
    for (const tu of serverUses) {
      if (isFetchToolName(tu.name)) {
        const url = tu.input?.url || tu.input?.uri || "";
        log?.info?.("SHIM", `iter ${iter + 1}: model called web_fetch → ${url}`);
        let fetched = null;
        try { fetched = await fetch?.(url); } catch (e) { log?.error?.("SHIM", `web_fetch threw: ${e?.message}`); }
        log?.info?.("SHIM", `web_fetch ${fetched?.ok ? "ok" : "miss"} (${(fetched?.text || "").length} chars)`);
        serverCalls.push({ id: tu.id, kind: "fetch", url, fetched });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: fetched?.text ? fetched.text.slice(0, 6000) : `Could not fetch ${url}` });
      } else {
        const query = tu.input?.query || tu.input?.q || tu.input?.search_query || "";
        log?.info?.("SHIM", `iter ${iter + 1}: model called web_search → "${query}"`);
        let results = [];
        try {
          const r = await search?.(query);
          results = r?.results || [];
        } catch (e) { log?.error?.("SHIM", `web_search threw: ${e?.message}`); }
        log?.info?.("SHIM", `web_search → ${results.length} results`);
        serverCalls.push({ id: tu.id, kind: "search", query, results });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultsToToolResultText(results) });
      }
    }
    messages.push({ role: "user", content: toolResults });

    if (iter === MAX_ITERS - 1) {
      // Out of iterations — emit what we have.
      finalMessage = { role: "assistant", content: [{ type: "text", text: "(tool budget exhausted)" }], model: msg.model, usage: msg.usage };
    }
  }

  if (!finalMessage) finalMessage = { role: "assistant", content: [{ type: "text", text: "" }] };

  const response = wantStream
    ? streamClaude(finalMessage, serverCalls)
    : jsonClaude(finalMessage, serverCalls);
  return { success: true, response };
}

// ── Claude output synthesis ────────────────────────────────────────────────

function b64(s) { try { return Buffer.from(String(s || "")).toString("base64"); } catch { return ""; } }

function searchResultBlocks(results) {
  return (results || []).slice(0, 10).map((r) => ({
    type: "web_search_result",
    url: r.url,
    title: r.title || "",
    // Synthesized results can't carry valid Anthropic-encrypted content; a base64
    // placeholder keeps the block well-formed for CC's renderer (and these blocks
    // are stripped from history before they'd ever reach a real Anthropic endpoint).
    encrypted_content: b64(r.snippet || r.content?.text || r.url),
    page_age: r.published_at || null
  }));
}

/** Anthropic web_fetch result block (single object, not an array — unlike web_search). */
function fetchResultBlock(url, fetched) {
  return {
    type: "web_fetch_result",
    url,
    content: {
      type: "document",
      title: fetched?.title || "",
      source: { type: "text", media_type: "text/plain", data: (fetched?.text || "").slice(0, 8000) }
    },
    retrieved_at: null
  };
}

/** Build the assembled content-block list: [server_tool_use, web_(search|fetch)_tool_result]* + model's own blocks. */
function assembleBlocks(finalMessage, serverCalls) {
  const blocks = [];
  for (const c of (serverCalls || [])) {
    if (c.kind === "fetch") {
      blocks.push({ type: "server_tool_use", id: c.id, name: "web_fetch", input: { url: c.url } });
      blocks.push({ type: "web_fetch_tool_result", tool_use_id: c.id, content: fetchResultBlock(c.url, c.fetched) });
    } else {
      blocks.push({ type: "server_tool_use", id: c.id, name: "web_search", input: { query: c.query } });
      blocks.push({ type: "web_search_tool_result", tool_use_id: c.id, content: searchResultBlocks(c.results) });
    }
  }
  for (const b of (finalMessage.content || [])) blocks.push(b);
  return blocks;
}

// Anthropic reports server-tool counts under usage.server_tool_use; Claude Code reads
// usage.server_tool_use.web_search_requests to render "Did N searches" and to treat the
// search as having actually run. Without it CC shows "0 searches" and thrashes other
// tools. Populate it from the calls we actually fulfilled.
function withServerToolUse(usage, serverCalls) {
  const web_search_requests = (serverCalls || []).filter((c) => c.kind === "search").length;
  const web_fetch_requests = (serverCalls || []).filter((c) => c.kind === "fetch").length;
  return { ...(usage || {}), server_tool_use: { web_search_requests, web_fetch_requests } };
}

function jsonClaude(finalMessage, searches) {
  const message = {
    id: finalMessage.id || `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: finalMessage.model || "router",
    content: assembleBlocks(finalMessage, searches),
    stop_reason: finalMessage.stop_reason || "end_turn",
    stop_sequence: null,
    usage: withServerToolUse(finalMessage.usage || { input_tokens: 0, output_tokens: 0 }, searches)
  };
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function sse(event, data) { return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

function streamClaude(finalMessage, searches) {
  const id = finalMessage.id || `msg_${Date.now().toString(36)}`;
  const model = finalMessage.model || "router";
  const blocks = assembleBlocks(finalMessage, searches);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
      }));

      let index = 0;
      for (const block of blocks) {
        if (block.type === "text") {
          controller.enqueue(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
          if (block.text) controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }));
          controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
        } else if (block.type === "server_tool_use") {
          controller.enqueue(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "server_tool_use", id: block.id, name: block.name, input: {} } }));
          controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } }));
          controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
        } else if (block.type === "tool_use") {
          controller.enqueue(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
          controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } }));
          controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
        } else {
          // web_search_tool_result and any other whole blocks: emit start (with the
          // full block) + stop; CC reads content_block.content directly.
          controller.enqueue(sse("content_block_start", { type: "content_block_start", index, content_block: block }));
          controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index }));
        }
        index++;
      }

      const hasClientTool = blocks.some((b) => b.type === "tool_use");
      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: hasClientTool ? "tool_use" : (finalMessage.stop_reason || "end_turn"), stop_sequence: null },
        usage: withServerToolUse(finalMessage.usage || { output_tokens: 0 }, searches)
      }));
      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" }
  });
}
