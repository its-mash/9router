#!/usr/bin/env node
// Verify settings persist mitmSearchCombo/mitmFetchCombo (what the MITM card dropdown writes)
// and set sensible defaults to the user's existing webSearch/webFetch combos.
const { request } = require("./mitmctl.cjs");
(async () => {
  const p = await request("PATCH", "/api/settings", { mitmSearchCombo: "search-combo", mitmFetchCombo: "fetch-combo" });
  console.log("PATCH /api/settings ->", p.status);
  const g = await request("GET", "/api/settings");
  const s = (g.body && (g.body.settings || g.body)) || {};
  console.log("persisted mitmSearchCombo =", JSON.stringify(s.mitmSearchCombo), "| mitmFetchCombo =", JSON.stringify(s.mitmFetchCombo));
})();
