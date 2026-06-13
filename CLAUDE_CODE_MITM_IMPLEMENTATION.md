# Claude Code → 9router MITM + server-side web_search shim — implementation summary

> Handoff doc to continue this work in a fresh chat. Repo was moved from
> `/home/benty/9router` → `/mnt/d/ionash/9router` (this dir). `git config
> core.filemode false` is set (drvfs reports 777 on every file → otherwise git
> shows all files as modified). `node_modules` is NOT installed here — run
> `npm install` (or `pnpm install`) before running. All work below is **uncommitted**
> (see `git status`).

## Goal

Let Claude Code (the CLI, which calls the Anthropic `/v1/messages` API) run through
9router so its model can be **re-routed to free/alternative backends** (via combos),
while **server-side web search keeps working for every model**:

- Resolved model is **Anthropic-native** → pass through verbatim; native server-side
  `web_search` (and computer-use / "Remote Desktop") just work.
- Resolved model is **non-Anthropic** (OpenRouter/Codex/Gemini/etc.) → 9router
  **fulfills the web search itself** and hands Claude Code back native-looking search
  blocks, so Claude Code *always* sees server-side search working. Computer-use is
  stripped for non-Anthropic (Remote Desktop off — acceptable).

Routing mechanism chosen: **true TLS-MITM** of `api.anthropic.com` (mirrors the
existing antigravity MITM). (Note: Claude Code also honors `ANTHROPIC_BASE_URL`, and
web_search is NOT first-party-host-gated — so a base-URL reverse proxy would also
work — but we went with MITM for transparency/consistency.)

## Status: all 5 phases implemented + load/smoke-verified. NOT yet runtime-tested against a live server.

| Phase | Status | What |
|---|---|---|
| 1. Anthropic TLS-MITM interception path | ✅ code | route `api.anthropic.com` `/v1/messages` through 9router |
| 2. Claude tier→combo selector | ✅ code | dashboard tile auto-renders; tiers (opus/sonnet/haiku) bind to combos |
| 3. Response-driven web_search shim | ✅ code + smoke test | the core: detect→fulfill→synthesize |
| 4. Generic search-provider-wrapper registry | ✅ code | added Claude as a search provider; codex=openai, gemini already present |
| 5. computer-use passthrough/strip | ✅ code | strip Anthropic-only server tools for non-Anthropic models |

## The ONE identifier convention

Everything for this tool keys off the single id **`anthropic`** — `getToolForHost`,
`URL_PATTERNS`, `MODEL_PATTERNS`, `MITM_TOOLS`, `TOOL_HOSTS` (DNS), the mitmAlias
store, AND the search-provider catalog id. Do not introduce `claude-code`/`claude`
variants for the MITM tool (an earlier bug). (`claude` still exists as the separate
deprecated OAuth provider in the catalog — leave it.)

## Files changed (all uncommitted)

### MITM interception (CJS, `src/mitm/`)
- **`src/mitm/config.js`** — added `api.anthropic.com` to `TARGET_HOSTS`;
  `URL_PATTERNS.anthropic = ["/v1/messages"]`; `getToolForHost`→`"anthropic"`;
  `MODEL_PATTERNS.anthropic` folds tiers → alias keys (`/opus/`→`claude-opus`,
  `/haiku/`→`claude-haiku`, `/sonnet|claude/`→`claude-sonnet`).
- **`src/mitm/handlers/anthropic.js`** *(new)* — thin handler: sets `body.model =
  mappedModel`, forwards the Claude body verbatim to local `/v1/messages` via
  `fetchRouter`, `pipeSSE`s back. Mirrors `copilot.js`. **Brains live in the backend.**
- **`src/mitm/server.js`** — registered `anthropic: require("./handlers/anthropic")`
  in the `handlers` map.
- **`src/shared/constants/mitmToolHosts.js`** — `TOOL_HOSTS.anthropic =
  ["api.anthropic.com"]` (DNS hijack).
- **`src/shared/constants/cliTools.js`** — `MITM_TOOLS.anthropic` entry (key + `.id`
  both `"anthropic"`), `modelAliases: ["claude-opus","claude-sonnet","claude-haiku"]`,
  `mitmDomain: "api.anthropic.com"`. Auto-renders as a dashboard card (generic
  `MitmLinkCard`); the generic alias API (`writeAliasForTool`) binds each tier → a combo.

**Safe-by-default:** if a tier has no alias bound, `getMappedModel` returns null →
the request passes through to the REAL Anthropic API unchanged (native everything).

### Backend shim + search (ESM, `open-sse/` + `src/sse/`)
- **`open-sse/handlers/webSearchShim.js`** *(new, the core)* — exports
  `runWebSearchShim`, `requestWantsWebSearch`, `isAnthropicNative`,
  `prepareBodyForNonAnthropic`. Response-driven loop:
  - `mapTools`: `web_search_20250305` → a plain `web_search` function tool; **strips**
    `computer_*` / `web_fetch` / `bash_` / `text_editor` (Phase 5).
  - `sanitizeHistory`: converts previously-synthesized `server_tool_use` /
    `web_search_tool_result` blocks in the transcript to plain text (the non-Anthropic
    model can't consume them on replay turns).
  - loop (max 4, **non-streaming internally**): call model → if it emits a `web_search`
    tool_use → fulfill via the search registry → append `tool_result` → re-call; if it
    emits other (client) tool_use or finishes → stop.
  - `streamClaude` / `jsonClaude`: synthesize the final Claude response with
    `server_tool_use` + `web_search_tool_result` + text/tool_use blocks (incrementing
    `index`); SSE event order verified: `message_start → (content_block_start/delta/stop)* → message_delta → message_stop`.
  - `encrypted_content` on synthesized results is a base64 placeholder (synthetic
    results never reach a real Anthropic endpoint; stripped from history on replay).
- **`open-sse/handlers/search/searchWrappers.js`** *(new)* — `resolveSearchBackends(settings, getCredsForProvider)`
  (free-first order: `gemini, anthropic, openai, perplexity, xai, kimi, minimax`;
  skips backends without creds) + `runSearch(query, {backends})` (tries each until one
  returns results). The shim's fulfiller.
- **`open-sse/handlers/search/chatSearch.js`** — added an **`anthropic`** entry to
  `CHAT_SEARCH_CONFIG` (key must match the catalog provider id): Haiku
  (`claude-haiku-4-5`) + native `web_search_20250305`; `buildHeaders` handles OAuth
  (`sk-ant-oat*` → Bearer + `oauth-2025-04-20` beta) vs `x-api-key`, with
  `anthropic-beta: web-search-2025-03-05`; `extractAnswer` parses both text-block
  citations and `web_search_tool_result` items (deduped).
- **`src/shared/constants/providers.js`** — the `anthropic` provider entry gained
  `serviceKinds: [...,"webSearch"]` + `searchViaChat: {defaultModel:"claude-haiku-4-5",...}`
  → **Claude now appears in the dashboard's search-provider list** (the existing
  `searchViaChat` catalog IS the "add any server-side-search model from UI" system;
  Codex = the existing `openai` entry, Gemini-free = the existing `gemini` entry).
- **`src/sse/handlers/chat.js`** — the hook. In `handleSingleModelChat`, the
  `handleChatCore({...})` call was extracted to `coreArgs`, then:
  ```js
  if (requestWantsWebSearch(body) && !isAnthropicNative(provider)) {
    const backends = await resolveSearchBackends(chatSettings, getCredsForProvider);
    const search = (q) => runSearch(q, { backends, log });
    const callModel = (messages, stream, tools) =>
      handleChatCore({ ...coreArgs, body: { ...coreArgs.body, messages, stream, tools: tools ?? coreArgs.body.tools } });
    result = await runWebSearchShim({ body: coreArgs.body, callModel, search, log });
  } else {
    result = await handleChatCore(coreArgs);   // anthropic-native passthrough (native search works)
  }
  ```
  Imports added: `runWebSearchShim, requestWantsWebSearch, isAnthropicNative` from
  `webSearchShim.js`; `resolveSearchBackends, runSearch` from `searchWrappers.js`.

## End-to-end flow

```
Claude Code ──TLS-MITM(api.anthropic.com)──▶ src/mitm/handlers/anthropic.js
  body.model = mapped tier-combo  ──▶ POST localhost:20128/v1/messages (handleChat)
    combo resolves → handleSingleModelChat → modelInfo {provider, model}
      provider == anthropic/claude → handleChatCore passthrough  (native web_search + computer-use)
      else + web_search requested  → runWebSearchShim:
          non-streaming loop, fulfill web_search via resolveSearchBackends/runSearch
          (free-first: gemini→anthropic(Haiku)→openai→...), then stream synthesized
          Claude SSE (server_tool_use + web_search_tool_result + text) back to CC
```

## Runtime activation (NOT done yet — needs the live server)

1. `cd /mnt/d/ionash/9router && npm install` (no node_modules here). Start 9router.
   ⚠ node/next on `/mnt/d` (drvfs) is slow; consider running from an ext4 path if perf matters.
2. Dashboard → MITM tools → **Claude Code (anthropic)**: enable **DNS** (writes
   `127.0.0.1 api.anthropic.com` to hosts) and **bind** `claude-opus` / `claude-sonnet`
   / `claude-haiku` each to a combo (unbound tier = passthrough to real Anthropic).
3. Trust the 9router root CA in Claude Code's Node: `export
   NODE_EXTRA_CA_CERTS=<9router MITM rootCA.crt>` (path under the MITM data dir;
   see `src/mitm/paths.js` / `src/mitm/cert/rootCA.js`).
4. Add an **Anthropic** provider connection (API key or OAuth) so the Haiku search
   wrapper + native passthrough have creds; enable Anthropic (and/or Gemini) in the
   search combo for the shim's fulfiller.
5. Test: pick a **non-Anthropic** combo, prompt Claude Code to "search the web for X",
   confirm citations render. Then a `claude-opus`→Anthropic combo to confirm native
   passthrough still works.

## Known items to VERIFY at runtime (isolated, easy to tune)

1. **web-search beta header** — `chatSearch.js` `anthropic.buildHeaders` sends
   `anthropic-beta: web-search-2025-03-05`. If web_search is GA it's harmless; if the
   exact header differs it could 400 — verify and adjust.
2. **Synthesized SSE block shapes** — `webSearchShim.js` `streamClaude` emits
   `server_tool_use` (start + `input_json_delta` + stop) and `web_search_tool_result`
   (whole block in `content_block_start`). Confirm Claude Code's renderer accepts this
   exact shape; tune indices/fields if citations don't render.
3. **Credentials resolver** — `chat.js` uses `getProviderCredentials(pid, new Set(),
   null)` (maps `claude`→`anthropic`). Confirm it returns usable `{apiKey|accessToken}`
   for the search backends.
4. **Tool-name prefixing** — for Claude-OAuth, the translator prefixes client tool
   names (`CLAUDE_OAUTH_TOOL_PREFIX`). The shim matches `web_search` via
   `isSearchToolName` (strips `proxy_`/`claude_` prefixes, `/(^|_)web_search$/`).
   Verify the actual emitted tool_use name matches.
5. **Replay/desync** — multi-turn conversations: confirm `sanitizeHistory` correctly
   strips synthesized blocks so a later non-Anthropic turn doesn't choke, and a later
   Anthropic-native turn doesn't get fed invalid `encrypted_content`.

## Verification already done (no server needed)
- All CJS files `node -c` clean; all ESM modules import cleanly.
- `webSearchShim` smoke test: mock model (turn1 web_search tool_use → turn2 text) →
  correct streaming event order + `server_tool_use`/`web_search_tool_result`/text
  present; non-streaming returns the 3 block types.
- `chatSearch.anthropic` buildBody/headers/extractAnswer unit-verified.
- `providers.anthropic` has `webSearch` + `searchViaChat`; `MITM_TOOLS.anthropic`
  resolves with the 3 tier aliases.

## Open / future (optional)
- A dedicated "add search wrapper" UI form writing `settings.searchWrappers`
  (`resolveSearchBackends` already reads it) — currently extra wrappers also come
  free via the existing `searchViaChat` catalog, so this is a nicety.
- `web_fetch_20250305` shim (currently stripped for non-Anthropic; could be fulfilled
  like web_search).
- A standalone test script driving a fake `/v1/messages` through the shim end-to-end
  without the full stack.

## Key integration points (file:line at time of writing)
- dispatch / model-map: `src/mitm/server.js` ~338-372 (`getToolForHost`, `getMappedModel`, `handlers[tool].intercept`)
- backend hook: `src/sse/handlers/chat.js` ~200-250 (`coreArgs` + shim branch)
- response translation (where native blocks would appear): `open-sse/translator/response/openai-to-claude.js`
- search dispatch (chat-search vs dedicated): `open-sse/handlers/search/index.js`
