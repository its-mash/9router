import { NextResponse } from "next/server";
import { getProviderCredentials, markAccountUnavailable } from "@/sse/services/auth.js";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";

/**
 * MITM native-passthrough account selector + load-balancer.
 *
 * The Claude MITM (src/mitm/handlers/anthropic.js) calls this to load-balance NATIVE
 * Anthropic traffic across the connected Anthropic/Claude accounts — instead of riding the
 * client's single token. It returns the active, non-rate-limited account's FRESH token so the
 * MITM swaps ONLY the auth header and forwards the body byte-for-byte to api.anthropic.com.
 *
 * Rotation: on a 429 (or 401/403/529) the MITM re-calls with `failed` (locks that account via
 * markAccountUnavailable) + `exclude` (skip it this request) → getProviderCredentials then
 * hands back the next available account. When every account is locked it returns
 * {none, reason:"all_rate_limited"}; when none are connected, {none, reason:"no_accounts"}.
 *
 * Reuses the exact selection/round-robin/rate-limit machinery the /v1/messages pipeline uses.
 * Localhost-only (same convention as the sibling mitm-usage route).
 */
// Native Anthropic traffic from Claude Code can be served by either a Claude Code OAuth
// SUBSCRIPTION (provider "claude") or an Anthropic API-key account (provider "anthropic").
// These are DISTINCT providers in 9router. Prefer the Claude Code subscription (the accounts
// users connect for this MITM), then fall back to Anthropic API keys — mirrors the
// search.js claude↔anthropic fallback. Without this, a setup that only has Claude Code
// accounts connected finds nothing under "anthropic" and the MITM falls back to the
// client's own (rate-limited) token.
const DEFAULT_PROVIDER_ORDER = ["claude", "anthropic"];

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { exclude = [], model = null, failed = null, provider = null } = body || {};

    // When the caller pins a provider, honor only it; otherwise try subscription then API key.
    const providers = provider ? [provider] : DEFAULT_PROVIDER_ORDER;

    // A prior attempt rate-limited/failed → lock that account+model so selection skips it.
    // provider=null lets markAccountUnavailable resolve the connection across all pools.
    if (failed && failed.connectionId) {
      await markAccountUnavailable(
        failed.connectionId,
        failed.status || 429,
        failed.error || "mitm native rotation",
        provider || null,
        model,
        failed.resetsAtMs || null
      ).catch(() => {});
    }

    const excludeSet = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);

    // Walk the provider candidates: first one with a usable account wins. Remember the
    // soonest rate-limit reset so we can report a meaningful retry when every pool is locked.
    let creds = null;
    let pickedProvider = null;
    let rateLimited = null;
    for (const p of providers) {
      const c = await getProviderCredentials(p, excludeSet, model);
      if (!c) continue;
      if (c.allRateLimited) {
        if (!rateLimited || (c.retryAfter && c.retryAfter < rateLimited.retryAfter)) rateLimited = c;
        continue;
      }
      creds = c;
      pickedProvider = p;
      break;
    }

    if (!creds) {
      if (rateLimited) {
        return NextResponse.json({
          none: true,
          reason: "all_rate_limited",
          retryAfter: rateLimited.retryAfter || null,
          retryAfterHuman: rateLimited.retryAfterHuman || null,
        });
      }
      return NextResponse.json({ none: true, reason: "no_accounts" });
    }

    // Refresh the OAuth access token if it is near expiry, so the MITM gets a usable Bearer.
    try {
      const refreshed = await checkAndRefreshToken(pickedProvider, creds);
      if (refreshed) creds = refreshed;
    } catch {
      /* fall through with the existing token */
    }

    const apiKey = creds.apiKey || null;
    const accessToken = creds.accessToken || null;
    if (!apiKey && !accessToken) {
      return NextResponse.json({ none: true, reason: "no_token", connectionId: creds.connectionId });
    }

    return NextResponse.json({
      connectionId: creds.connectionId,
      connectionName: creds.connectionName || creds.connectionId,
      authType: apiKey ? "x-api-key" : "bearer",
      token: apiKey || accessToken,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || "failed" }, { status: 500 });
  }
}
