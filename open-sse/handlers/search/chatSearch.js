/**
 * Wrap chat-completions endpoints (with built-in web search) into the unified
 * /v1/search response format. Supports gemini, openai, xai, kimi, minimax, perplexity.
 */
import { PROVIDER_MEDIA } from "../../providers/index.js";

// Default search model + endpoint derive from registry searchViaChat (single source)
const searchModel = (id) => PROVIDER_MEDIA[id]?.searchViaChat?.defaultModel;
const searchEndpoint = (id, model) =>
  (PROVIDER_MEDIA[id]?.searchViaChat?.endpoint || "").replace("{model}", model || "");

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 10;

/**
 * Normalize a citation entry into the unified result shape.
 * @param {{url:string, title?:string, snippet?:string}} c
 * @param {number} index
 * @param {string} provider
 * @param {string} retrievedAt
 */
function toResult(c, index, provider, retrievedAt) {
  return {
    title: c.title || "",
    url: c.url,
    snippet: c.snippet || "",
    position: index + 1,
    score: null,
    published_at: null,
    favicon_url: null,
    content: null,
    metadata: {},
    citation: { provider, retrieved_at: retrievedAt, rank: index + 1 },
    provider_raw: null
  };
}

/** Coerce a citation that might be a raw URL string or an object. */
function normalizeCitation(c) {
  if (!c) return null;
  if (typeof c === "string") return { url: c };
  if (typeof c === "object" && c.url) return c;
  return null;
}

/**
 * Provider-specific configuration map. All providers must implement:
 * { endpoint, defaultModel, buildBody, buildHeaders, extractAnswer }
 */
const CHAT_SEARCH_CONFIG = {
  // Anthropic (Claude) as a search wrapper — a cheap Haiku call with the native
  // server-side web_search tool. Key is "anthropic" to match the provider catalog
  // id (providers.js) that index.js passes as `provider`. Highest-quality fulfiller
  // for the web_search shim AND a standalone /v1/search backend. Credentials: an
  // Anthropic OAuth token (sk-ant-oat*) → Bearer + oauth beta, or an x-api-key.
  anthropic: {
    endpoint: () => "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-haiku-4-5",
    buildBody: (query, model) => ({
      model,
      max_tokens: 1024,
      // Optimized + cache-friendly: a STABLE system + tools prefix that is byte-identical
      // across every search query, with a cache_control breakpoint at the end of that prefix.
      // Only the user message (the query) changes, so Anthropic prompt-caching can serve the
      // tools+system prefix as cache_read on subsequent searches (when the prefix is large
      // enough to be cache-eligible). Keeps each search a clean single-turn call.
      system: [
        {
          type: "text",
          text: "You are a precise web search assistant. For the user's query, call the web_search tool to gather current authoritative sources, then answer concisely and cite the source URLs. Prefer official / primary sources.",
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
    }),
    buildHeaders: (token) => {
      const isOAuth = typeof token === "string" && token.startsWith("sk-ant-oat");
      const betas = ["web-search-2025-03-05"]; // harmless if web_search is GA; required while beta
      if (isOAuth) betas.push("oauth-2025-04-20");
      return {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": betas.join(","),
        // MITM bypass: when api.anthropic.com is hosts-redirected into the 9Router MITM,
        // this header makes the MITM pass our own search call straight through to the real
        // API instead of re-routing it (so Claude works as a search provider under MITM).
        "x-request-source": "local",
        ...(isOAuth ? { Authorization: `Bearer ${token}` } : { "x-api-key": token })
      };
    },
    extractAnswer: (data) => {
      // Anthropic Messages response: content[] holds text blocks (with citations) +
      // web_search_tool_result blocks (each .content[] = web_search_result items).
      const content = Array.isArray(data?.content) ? data.content : [];
      let text = "";
      const citations = [];
      const seen = new Set();
      const push = (url, title, snippet) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        citations.push({ url, title: title || "", snippet: snippet || "" });
      };
      for (const block of content) {
        if (block?.type === "text") {
          text += block.text || "";
          for (const c of block.citations || []) push(c?.url, c?.title, c?.cited_text);
        } else if (block?.type === "web_search_tool_result") {
          const items = Array.isArray(block.content) ? block.content : [];
          for (const it of items) {
            if (it?.type === "web_search_result") push(it.url, it.title, null);
          }
        }
      }
      const tokens = (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0);
      return { text, citations, tokens };
    }
  },

  gemini: {
    endpoint: (model) => searchEndpoint("gemini", model),
    buildBody: (query) => ({
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      "x-goog-api-key": token
    }),
    extractAnswer: (data) => {
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const text = parts.map((p) => p?.text || "").filter(Boolean).join("");
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const citations = chunks
        .map((ch) => ch?.web)
        .filter(Boolean)
        .map((w) => ({ url: w.uri || w.url, title: w.title || "" }))
        .filter((c) => c.url);
      const tokens = data?.usageMetadata?.totalTokenCount || 0;
      return { text, citations, tokens };
    }
  },

  openai: {
    endpoint: () => searchEndpoint("openai"),
    buildBody: (query, model) => {
      const body = {
        model,
        messages: [{ role: "user", content: query }]
      };
      // Non-search-preview models need explicit web_search tool
      if (!/search/i.test(model)) {
        body.tools = [{ type: "web_search" }];
      }
      return body;
    },
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
      const fromAnn = annotations
        .map((a) => a?.url_citation)
        .filter(Boolean)
        .map((u) => ({ url: u.url, title: u.title || "" }));
      const fromTop = Array.isArray(data?.citations)
        ? data.citations.map(normalizeCitation).filter(Boolean)
        : [];
      const citations = fromAnn.length ? fromAnn : fromTop;
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  xai: {
    endpoint: () => searchEndpoint("xai"),
    buildBody: (query, model) => ({
      model,
      input: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      // /v1/responses returns output[] array of message/tool blocks
      const output = Array.isArray(data?.output) ? data.output : [];
      let text = "";
      const citations = [];
      for (const item of output) {
        const parts = Array.isArray(item?.content) ? item.content : [];
        for (const p of parts) {
          if (typeof p?.text === "string") text += p.text;
          const anns = Array.isArray(p?.annotations) ? p.annotations : [];
          for (const a of anns) {
            const c = normalizeCitation(a?.url ? a : a?.url_citation);
            if (c) citations.push(c);
          }
        }
      }
      // Fallback: top-level citations array (some response variants)
      if (!citations.length && Array.isArray(data?.citations)) {
        for (const c of data.citations) {
          const n = normalizeCitation(c);
          if (n) citations.push(n);
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  kimi: {
    endpoint: () => searchEndpoint("kimi"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }],
      tools: [
        { type: "builtin_function", function: { name: "$web_search" } }
      ]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const citations = [];
      for (const call of calls) {
        const argStr = call?.function?.arguments;
        if (!argStr) continue;
        let parsed;
        try {
          parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
        } catch {
          continue;
        }
        const items =
          parsed?.search_results ||
          parsed?.results ||
          parsed?.references ||
          [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const url = it?.url || it?.link;
            if (!url) continue;
            citations.push({
              url,
              title: it.title || "",
              snippet: it.snippet || it.summary || ""
            });
          }
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  minimax: {
    endpoint: () => searchEndpoint("minimax"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const citations = [];
      const direct = Array.isArray(data?.web_search_results)
        ? data.web_search_results
        : [];
      for (const it of direct) {
        const url = it?.url || it?.link;
        if (url) {
          citations.push({
            url,
            title: it.title || "",
            snippet: it.snippet || it.summary || ""
          });
        }
      }
      if (!citations.length) {
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const call of calls) {
          const argStr = call?.function?.arguments;
          if (!argStr) continue;
          let parsed;
          try {
            parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
          } catch {
            continue;
          }
          const items = parsed?.results || parsed?.search_results || [];
          if (Array.isArray(items)) {
            for (const it of items) {
              const url = it?.url || it?.link;
              if (!url) continue;
              citations.push({
                url,
                title: it.title || "",
                snippet: it.snippet || ""
              });
            }
          }
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  perplexity: {
    endpoint: () => searchEndpoint("perplexity"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const raw = data?.citations || [];
      const citations = Array.isArray(raw)
        ? raw.map(normalizeCitation).filter(Boolean)
        : [];
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  }
};

// Claude Code OAuth connections are stored under provider id "claude" (not "anthropic").
// Alias the chat-search config so the connected Claude subscription works as a Haiku-based
// web_search backend (selectable in the dashboard + addable to a webSearch combo).
CHAT_SEARCH_CONFIG.claude = CHAT_SEARCH_CONFIG.anthropic;

/**
 * Execute a chat-search request against the chosen provider.
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.query
 * @param {number} [params.maxResults]
 * @param {string} [params.model]
 * @param {{apiKey?:string, accessToken?:string}} params.credentials
 * @param {{info?:Function, warn?:Function, error?:Function}} [params.log]
 * @returns {Promise<{success:boolean, status?:number, error?:string, data?:object}>}
 */
export async function handleChatSearch({
  provider,
  query,
  maxResults,
  model,
  credentials,
  log
}) {
  const startTime = Date.now();
  const cfg = CHAT_SEARCH_CONFIG[provider];

  if (!cfg) {
    return {
      success: false,
      status: 400,
      error: `Unsupported chat-search provider: ${provider}`
    };
  }

  if (!query || typeof query !== "string") {
    return { success: false, status: 400, error: "Missing query" };
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return {
      success: false,
      status: 401,
      error: "Missing credentials (apiKey or accessToken)"
    };
  }

  const limit =
    Number.isFinite(maxResults) && maxResults > 0
      ? Math.floor(maxResults)
      : DEFAULT_MAX_RESULTS;
  const useModel = model || searchModel(provider);
  const url = cfg.endpoint(useModel);
  const body = cfg.buildBody(query, useModel);
  const headers = cfg.buildHeaders(token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let upstreamStart = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      log?.warn?.(`[chatSearch] timeout provider=${provider}`);
      return { success: false, status: 504, error: "Upstream timeout" };
    }
    log?.error?.(`[chatSearch] network error provider=${provider}: ${err?.message}`);
    return {
      success: false,
      status: 502,
      error: `Network error: ${err?.message || "unknown"}`
    };
  }
  clearTimeout(timer);
  const upstreamLatency = Date.now() - upstreamStart;

  let data;
  try {
    data = await resp.json();
  } catch {
    return {
      success: false,
      status: 502,
      error: `Invalid upstream response (status ${resp.status})`
    };
  }

  if (!resp.ok) {
    const errMsg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `Upstream HTTP ${resp.status}`;
    log?.warn?.(`[chatSearch] upstream error provider=${provider} status=${resp.status}`);
    return {
      success: false,
      status: resp.status,
      error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)
    };
  }

  const { text, citations, tokens } = cfg.extractAnswer(data);
  const retrievedAt = new Date().toISOString();
  const limited = (citations || []).slice(0, limit);
  const results = limited.map((c, i) => toResult(c, i, provider, retrievedAt));
  const rawUsage = (data && data.usage) || {};

  return {
    success: true,
    status: 200,
    data: {
      provider,
      query,
      results,
      answer: { source: provider, text: text || "", model: useModel },
      // The exact body sent upstream — so the usage tab's request-details show it (and the
      // cache_control / cache token fields, to confirm caching).
      providerRequest: body,
      usage: {
        queries_used: 1, search_cost_usd: 0, llm_tokens: tokens || 0,
        input_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens,
        output_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens,
        cache_read_input_tokens: rawUsage.cache_read_input_tokens,
        cache_creation_input_tokens: rawUsage.cache_creation_input_tokens
      },
      metrics: {
        response_time_ms: Date.now() - startTime,
        upstream_latency_ms: upstreamLatency,
        total_results_available: null
      },
      errors: []
    }
  };
}

export { CHAT_SEARCH_CONFIG };
