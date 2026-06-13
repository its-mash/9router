import { NextResponse } from "next/server";
import { saveUsageStats, buildRequestDetail } from "open-sse/handlers/chatCore/requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

/**
 * Record usage for a MITM native-passthrough request.
 *
 * Combo-routed MITM traffic already flows through /v1/messages and is tracked. Native
 * passthrough goes straight to the real Anthropic API (pure behavior), so the MITM tees
 * the response and POSTs the parsed usage here — making ALL MITM traffic (combo + direct)
 * appear in the usage tab. Auth: CLI token (x-9r-cli-token), localhost-originated.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      provider = "anthropic",
      model = "unknown",
      tokens = {},
      endpoint = "/v1/messages",
      connectionId = null,
      request: reqCfg = null,
      response: resp = null,
      latency = null,
    } = body || {};

    // Aggregate usage stats (powers the usage tab totals / per-model breakdown)
    saveUsageStats({ provider, model, tokens, connectionId, endpoint, label: "MITM" });

    // Observability detail row (powers the request list in the usage tab)
    saveRequestDetail(
      buildRequestDetail(
        {
          provider,
          model,
          connectionId,
          latency: latency || { ttft: 0, total: 0 },
          tokens: {
            prompt_tokens: tokens.input_tokens ?? tokens.prompt_tokens ?? 0,
            completion_tokens: tokens.output_tokens ?? tokens.completion_tokens ?? 0,
          },
          request: reqCfg,
          response: resp || {},
          status: "success",
        },
        { endpoint }
      )
    ).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e.message || "failed" }, { status: 500 });
  }
}
