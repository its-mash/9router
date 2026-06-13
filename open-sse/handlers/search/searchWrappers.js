/**
 * Generic search-provider-wrapper registry (Phase 4).
 *
 * A "search wrapper" turns any model that can do server-side web search into a
 * normalized search backend (query → results[]). The built-in CHAT_SEARCH_CONFIG
 * (chatSearch.js: claude, gemini, openai, xai, kimi, minimax, perplexity) already
 * IS such a registry — each entry knows how to ask its provider to search and how
 * to extract results. This module:
 *
 *   1. lets the UI register EXTRA wrappers as {id, name, format, model, providerId}
 *      where `format` ∈ the built-in config keys (claude|gemini|openai|...). The
 *      wrapper just pins a specific model + provider-connection onto a built-in
 *      format — so "use gpt-4o-mini-search via my OpenAI key" or "use
 *      claude-haiku-4-5 via my Anthropic OAuth" become named, selectable backends
 *      with zero new code.
 *   2. resolves an ordered, FREE-FIRST list of usable backends (skipping any whose
 *      credentials are missing).
 *   3. runSearch(query): tries backends in order until one returns results.
 *
 * Credentials are injected (getCredsForProvider) so this module stays pure/testable
 * and doesn't hard-depend on the DB layer.
 */

import { handleChatSearch, CHAT_SEARCH_CONFIG } from "./chatSearch.js";

// Free-first default ordering of built-in formats (cheapest/free models first).
// gemini-flash + claude-haiku are cheap; the rest need paid keys. The user's
// configured wrappers (settings.searchWrappers) take precedence over this.
const DEFAULT_ORDER = ["gemini", "anthropic", "openai", "perplexity", "xai", "kimi", "minimax"];

/**
 * Build the ordered backend list from settings + built-ins.
 * @param {object} settings - app settings (may contain searchWrappers[] + searchWrapperOrder[])
 * @param {(providerId:string)=>Promise<{apiKey?:string,accessToken?:string}|null>} getCredsForProvider
 * @returns {Promise<Array<{id,name,format,model,credentials}>>}
 */
export async function resolveSearchBackends(settings, getCredsForProvider) {
  const out = [];
  const seen = new Set();

  // 1. User-defined wrappers (from the UI) — highest priority, in their stored order.
  const userWrappers = Array.isArray(settings?.searchWrappers) ? settings.searchWrappers : [];
  for (const w of userWrappers) {
    if (!w || w.enabled === false) continue;
    const format = w.format;
    if (!CHAT_SEARCH_CONFIG[format]) continue; // unknown format → skip
    const creds = await safeCreds(getCredsForProvider, w.providerId || format);
    if (!hasCreds(creds, format)) continue; // no usable creds → skip silently
    const id = w.id || `${format}:${w.model || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: w.name || id, format, model: w.model || CHAT_SEARCH_CONFIG[format].defaultModel, credentials: creds });
  }

  // 2. Built-in formats in free-first order — included only if their provider has creds.
  const order = Array.isArray(settings?.searchWrapperOrder) && settings.searchWrapperOrder.length
    ? settings.searchWrapperOrder
    : DEFAULT_ORDER;
  for (const format of order) {
    if (!CHAT_SEARCH_CONFIG[format] || seen.has(format)) continue;
    const creds = await safeCreds(getCredsForProvider, format);
    if (!hasCreds(creds, format)) continue;
    seen.add(format);
    out.push({ id: format, name: format, format, model: CHAT_SEARCH_CONFIG[format].defaultModel, credentials: creds });
  }

  return out;
}

async function safeCreds(getCredsForProvider, providerId) {
  try { return (await getCredsForProvider?.(providerId)) || null; }
  catch { return null; }
}

function hasCreds(creds, format) {
  // gemini accepts an x-goog-api-key; all others need apiKey or accessToken.
  return !!(creds && (creds.apiKey || creds.accessToken));
}

/**
 * Run a search query against the resolved backends, free-first, until one succeeds.
 * @param {string} query
 * @param {object} opts
 * @param {Array} opts.backends - from resolveSearchBackends()
 * @param {number} [opts.maxResults=8]
 * @param {object} [opts.log]
 * @returns {Promise<{ok:boolean, backend?:string, results:Array, answer?:string}>}
 */
export async function runSearch(query, { backends, maxResults = 8, log } = {}) {
  const list = Array.isArray(backends) ? backends : [];
  if (!query || !list.length) return { ok: false, results: [] };

  for (const b of list) {
    try {
      const res = await handleChatSearch({
        provider: b.format,
        query,
        maxResults,
        model: b.model,
        credentials: b.credentials,
        log
      });
      if (res?.success && res.data) {
        const results = res.data.results || [];
        log?.info?.(`[searchWrappers] backend=${b.id} results=${results.length}`);
        // Even an empty result set from a working backend is a valid "answer" —
        // but prefer a backend that actually returned something; only accept empty
        // if it's the last backend.
        if (results.length || b === list[list.length - 1]) {
          return { ok: true, backend: b.id, results, answer: res.data.answer?.text || "" };
        }
      } else {
        log?.warn?.(`[searchWrappers] backend=${b.id} failed: ${res?.error || "unknown"}`);
      }
    } catch (e) {
      log?.warn?.(`[searchWrappers] backend=${b.id} threw: ${e?.message}`);
    }
  }
  return { ok: false, results: [] };
}

export { DEFAULT_ORDER };
