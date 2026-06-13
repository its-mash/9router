/**
 * Shared converter: OpenAI chat.completion → Anthropic Messages format.
 *
 * Both the non-streaming handler and the forced-SSE→JSON handler normalize every provider
 * to OpenAI chat.completion. For a Claude-source client (/v1/messages) the response must be
 * true Anthropic Messages format — this is the single place that conversion lives (kept out
 * of either handler to avoid a circular import between them).
 */
export function openaiToClaudeMessage(o) {
  const choice = o?.choices?.[0] || {};
  const m = choice.message || {};
  const content = [];
  if (m.reasoning_content) content.push({ type: "thinking", thinking: m.reasoning_content });
  if (typeof m.content === "string" && m.content) content.push({ type: "text", text: m.content });
  else if (Array.isArray(m.content)) { for (const b of m.content) content.push(b); }
  for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
    let input = {};
    try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const fr = choice.finish_reason;
  const stop_reason = fr === "tool_calls" ? "tool_use" : fr === "length" ? "max_tokens" : fr === "stop" ? "end_turn" : (fr || "end_turn");
  return {
    id: o?.id || `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: o?.model || "router",
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: o?.usage?.prompt_tokens || 0,
      output_tokens: o?.usage?.completion_tokens || 0,
    },
  };
}
