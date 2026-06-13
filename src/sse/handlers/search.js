import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getCombos } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleSearchCore } from "open-sse/handlers/search/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { saveUsageStats, buildRequestDetail } from "open-sse/handlers/chatCore/requestDetail.js";
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";

/**
 * Record a successful web-search request into the usage + request-details store so it
 * shows in the usage tab (with the upstream request body + cache token usage).
 */
function recordSearchUsage({ providerId, data, connectionId, apiKey }) {
  try {
    if (!data) return;
    const u = data.usage || {};
    const model = data.answer?.model || providerId;
    const tokens = {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? u.llm_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
    };
    saveUsageStats({ provider: providerId, model, tokens, connectionId, apiKey, endpoint: "/v1/search", label: "SEARCH" });
    saveRequestDetail(buildRequestDetail({
      provider: providerId, model, connectionId, tokens,
      request: { query: data.query, provider: providerId, results: (data.results || []).length },
      providerRequest: data.providerRequest || null,
      providerResponse: { results: data.results, answer: data.answer },
      response: { content: data.answer?.text || `${(data.results || []).length} results`, finish_reason: "stop" },
      status: "success",
    }, { endpoint: "/v1/search" })).catch(() => {});
    appendRequestLog({ provider: providerId, model, connectionId, tokens, status: "200 OK" }).catch(() => {});
  } catch { /* never break search */ }
}

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
  const providerInput = body.provider || body.model;
  const query = body.query;

  log.request("POST", `${url.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("SEARCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!query || typeof query !== "string" || !query.trim()) {
    log.warn("SEARCH", "Missing query");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("SEARCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey, settings),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderSearch(body, providerInput, request, apiKey, settings);
}

/**
 * Internal fulfiller for the Claude-Code web_search shim (open-sse/handlers/webSearchShim.js).
 *
 * Reuses the full search dispatch — combo fallback + dedicated (exa) and chat-based
 * (gemini, …) backends with their real credentials — by auto-selecting the user's
 * configured `webSearch` combo (e.g. "search-combo": gemini → exa), falling back to a
 * single `gemini` provider if none is configured. Returns the unified result shape
 * the shim expects: { ok, results, answer }.
 *
 * @param {string} query
 * @param {{maxResults?:number, log?:object}} [opts]
 */
export async function runSearchQuery(query, { maxResults = 8, log: logger, target: explicitTarget } = {}) {
  if (!query || typeof query !== "string" || !query.trim()) return { ok: false, results: [] };

  // Target priority: explicit caller override (MCP picks its own combo) → MITM setting
  // (a combo name OR a single provider id) → first webSearch-kind combo → single "gemini"
  // provider. So the search backend is a user choice, configurable in the UI.
  let target = "gemini";
  if (explicitTarget && String(explicitTarget).trim()) {
    target = String(explicitTarget).trim();
  } else {
    try {
      const settings = await getSettings();
      const chosen = settings?.mitmSearchCombo && String(settings.mitmSearchCombo).trim();
      if (chosen) {
        target = chosen;
      } else {
        const combos = await getCombos();
        const ws = (combos || []).find((c) => c && c.kind === "webSearch" && Array.isArray(c.models) && c.models.length);
        if (ws?.name) target = ws.name;
      }
    } catch { /* use fallback */ }
  }

  const req = new Request("http://localhost/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: target, query: query.trim(), max_results: maxResults }),
  });

  try {
    const resp = await handleSearch(req);
    const data = await resp.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : [];
    logger?.info?.("CHAT", `[web-search shim] backend=${target} results=${results.length}`);
    return { ok: results.length > 0, results, answer: data?.answer?.text || "" };
  } catch (e) {
    logger?.warn?.("CHAT", `[web-search shim] search failed: ${e?.message}`);
    return { ok: false, results: [] };
  }
}

async function handleSingleProviderSearch(body, providerInput, request, apiKey, settings) {
  const query = body.query;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("SEARCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.searchConfig;
  const supportsSearch = !!providerConfig || !!resolvedProvider.searchViaChat;

  if (!supportsSearch) {
    log.warn("SEARCH", "Provider does not support web search", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web search`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // Sanitized body forwarded to core
  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  // No-auth providers (e.g. searxng) bypass credential lookup
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: null,
      log
    });
    if (result.success) { recordSearchUsage({ providerId, data: result.data, connectionId: null, apiKey }); return result.response; }
    return result.response;
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    let credentials = await getProviderCredentials(providerId, excludeConnectionIds);
    // The Haiku/Claude search wrapper ("anthropic") can run on a Claude Code OAuth
    // connection (provider "claude") when no dedicated "anthropic" connection exists.
    if (!credentials && providerId === "anthropic") {
      credentials = await getProviderCredentials("claude", excludeConnectionIds);
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SEARCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("SEARCH", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials);
      }
    });

    if (result.success) { recordSearchUsage({ providerId, data: result.data, connectionId: credentials.connectionId, apiKey }); return result.response; }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, providerId);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
