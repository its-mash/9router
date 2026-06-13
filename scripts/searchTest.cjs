#!/usr/bin/env node
// Probe /v1/search for a provider or combo. Usage: node searchTest.cjs <provider|combo> [query...]
const { request } = require("./mitmctl.cjs");
const target = process.argv[2] || "anthropic";
const query = process.argv.slice(3).join(" ") || "what is the latest Node.js LTS version";
request("POST", "/v1/search", { model: target, query, max_results: 5 }).then((r) => {
  console.log("HTTP", r.status);
  const d = r.body;
  if (d && Array.isArray(d.results)) {
    console.log(`backend=${d.provider} results=${d.results.length}`);
    d.results.slice(0, 4).forEach((x) => console.log(`  - ${x.title || "(untitled)"} :: ${x.url}`));
    if (d.answer?.text) console.log("answer:", d.answer.text.slice(0, 240));
  } else {
    console.log(typeof d === "string" ? d.slice(0, 600) : JSON.stringify(d).slice(0, 600));
  }
});
