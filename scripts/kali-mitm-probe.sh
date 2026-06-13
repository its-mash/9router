#!/usr/bin/env bash
# Run INSIDE Kali to prove the FULL path CC uses: Kali → NAT gateway → MITM :443 →
# combo → web_search shim. Uses the system CA (installed by setup-kali-mitm.sh), so a
# clean TLS handshake here = the proxy is trusted end-to-end from Kali.
#   bash /mnt/d/ionash/9router/scripts/kali-mitm-probe.sh [model] [web_search_version]
MODEL="${1:-9r/9opus}"
TOOLV="${2:-web_search_20260209}"
H="api.anthropic.com"

echo "== 1) health (transport + cert) =="
curl -sS --max-time 8 "https://$H/_mitm_health" && echo || echo "  ^ FAILED"

echo
echo "== 2) hosts entry =="
grep "$H" /etc/hosts || echo "  (none — run setup-kali-mitm.sh)"

echo
echo "== 3) real web_search request ($MODEL, $TOOLV) =="
REQ=$(cat <<JSON
{"model":"$MODEL","max_tokens":512,"stream":false,
 "messages":[{"role":"user","content":"Use web_search to find the current latest stable Node.js LTS version, then state it with a source URL."}],
 "tools":[{"type":"$TOOLV","name":"web_search","max_uses":3}]}
JSON
)
START=$(date +%s%3N 2>/dev/null || date +%s000)
RESP=$(curl -sS --max-time 90 "https://$H/v1/messages" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: kali-probe" \
  -d "$REQ" 2>/tmp/9r_probe_err)
RC=$?
END=$(date +%s%3N 2>/dev/null || date +%s000)
echo "curl exit=$RC  elapsed=$((END-START))ms"
if [[ $RC -ne 0 ]]; then
  echo "TRANSPORT/TLS ERROR: $(cat /tmp/9r_probe_err)"
  exit 1
fi
# Summarize the JSON without needing jq.
echo "$RESP" | grep -o '"type":"[a-z_]*"' | sort | uniq -c
echo "--- first 700 chars ---"
echo "$RESP" | head -c 700
echo
if echo "$RESP" | grep -q 'web_search_tool_result'; then
  echo "RESULT: ✅ search blocks present — pipeline works from Kali. If CC still shows 0,"
  echo "        the gap is CC-client side (stale process / connection pool / model option)."
else
  echo "RESULT: ❌ no search blocks. See the body above for the real failure."
fi
