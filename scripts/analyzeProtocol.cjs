// One-off: scan request-details.json (observability log) for Anthropic /v1/messages
// protocol shapes — server_tool_use / web_search_tool_result / citations / SSE blocks —
// to cross-check the webSearchShim synthesized output against real captured traffic.
const fs = require("fs");
const path = require("path");
const os = require("os");

const DATA_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "9router")
  : path.join(os.homedir(), ".9router");
const FILE = path.join(DATA_DIR, "request-details.json");

const raw = fs.readFileSync(FILE, "utf8");
console.log("file bytes:", raw.length);

let data;
try { data = JSON.parse(raw); }
catch (e) { console.log("Not a single JSON doc:", e.message); process.exit(0); }

const records = Array.isArray(data) ? data : (data.records || data.items || data.logs || Object.values(data));
console.log("top-level type:", Array.isArray(data) ? "array" : typeof data, "| record count:", Array.isArray(records) ? records.length : "n/a");

if (!Array.isArray(records)) {
  console.log("top-level keys:", Object.keys(data).slice(0, 40));
  process.exit(0);
}

// Show shape of one record
const sample = records[0];
console.log("\n=== sample record keys ===");
console.log(Object.keys(sample || {}));

// Tally endpoints / models / formats
const tally = (arr, key) => {
  const m = {};
  for (const r of arr) { const v = r?.[key]; if (v != null) m[v] = (m[v] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25);
};
for (const k of ["endpoint", "path", "url", "model", "provider", "format", "inputFormat", "outputFormat", "tool", "status", "statusCode"]) {
  const t = tally(records, k);
  if (t.length) console.log(`\n=== ${k} ===\n` + t.map(([v, c]) => `  ${c}\t${v}`).join("\n"));
}

// Find records that mention web_search / server_tool_use / anthropic message format
const blob = (r) => { try { return JSON.stringify(r); } catch { return ""; } };
const hits = { web_search: [], server_tool_use: [], web_search_tool_result: [], citations: [], v1messages: [] };
records.forEach((r, i) => {
  const s = blob(r);
  if (/web_search/.test(s)) hits.web_search.push(i);
  if (/server_tool_use/.test(s)) hits.server_tool_use.push(i);
  if (/web_search_tool_result/.test(s)) hits.web_search_tool_result.push(i);
  if (/"citations"/.test(s)) hits.citations.push(i);
  if (/\/v1\/messages/.test(s)) hits.v1messages.push(i);
});
console.log("\n=== keyword hits (record indices, capped) ===");
for (const [k, v] of Object.entries(hits)) console.log(`  ${k}: ${v.length}  e.g. [${v.slice(0, 8).join(",")}]`);

// Dump a compact view of the first server_tool_use / web_search record if any
function compact(obj, depth = 0) {
  return JSON.stringify(obj, (key, val) => {
    if (typeof val === "string" && val.length > 300) return val.slice(0, 300) + `…(+${val.length - 300})`;
    return val;
  }, 2);
}
const pick = hits.web_search_tool_result[0] ?? hits.server_tool_use[0] ?? hits.web_search[0];
if (pick != null) {
  console.log(`\n=== record #${pick} (first web_search-related), compacted ===`);
  console.log(compact(records[pick]).slice(0, 6000));
}
