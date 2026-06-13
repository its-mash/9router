#!/usr/bin/env bash
#
# Make a WSL2 distro (Kali, Ubuntu, …) route Claude Code through the 9Router MITM
# running on the Windows host — and keep it working across reboots automatically.
#
# The Windows half (the :443 listener) is already there; the MITM binds 0.0.0.0:443.
# This installs the Kali-side half AND a self-heal hook so you never re-run it by hand:
#
#   1. Install the 9Router Root CA into the distro trust store + NODE_EXTRA_CA_CERTS
#      (Claude Code / Node / Bun use their own CA list, so the env var is required).
#   2. Install /usr/local/bin/9router-mitm-refresh — repoints api.anthropic.com at the
#      Windows host in /etc/hosts (NAT gateway, or a pinned IP for mirrored mode).
#   3. Passwordless sudoers entry + a ~/.bashrc hook that runs the refresh on every new
#      shell, so the (NAT) host-IP change after `wsl --shutdown` heals itself silently.
#   4. Curl the MITM health endpoint to prove DNS + cert + firewall all line up.
#
# Run INSIDE the distro (as root is fine; it detects the real login user):
#     sudo bash /mnt/d/ionash/9router/scripts/setup-kali-mitm.sh
#   Mirrored-networking mode (stable 127.0.0.1) — pin the host:
#     sudo bash setup-kali-mitm.sh 127.0.0.1
#   Force which login user gets the hook:
#     MITM_USER=benty sudo bash setup-kali-mitm.sh
#   Undo everything:
#     sudo bash setup-kali-mitm.sh --remove
#
# Windows-side prerequisite (run ONCE, elevated PowerShell):
#   New-NetFirewallRule -DisplayName "9router MITM (WSL) 443" -Direction Inbound `
#       -Action Allow -Protocol TCP -LocalPort 443
set -euo pipefail

ANTHROPIC_HOST="api.anthropic.com"
CA_DEST="/usr/local/share/ca-certificates/9router-mitm.crt"
REFRESH_BIN="/usr/local/bin/9router-mitm-refresh"
HOST_OVERRIDE="/etc/9router-mitm.host"     # if present, refresh uses this IP instead of the gateway
SUDOERS_FILE="/etc/sudoers.d/9router-mitm"
RC_BEGIN="# >>> 9router-mitm >>>"
RC_END="# <<< 9router-mitm <<<"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
info() { printf '\033[36m▶ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { red "Run as root (sudo): sudo bash $0 ${*:-}"; exit 1; }
grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null || ylw "Warning: doesn't look like WSL — continuing."

# ── Identify the interactive login user (so we hook THEIR ~/.bashrc, not root's) ──
TARGET_USER="${MITM_USER:-${SUDO_USER:-}}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  # First regular (uid>=1000) account, falling back to root.
  TARGET_USER="$(getent passwd | awk -F: '$3>=1000 && $3<65534 {print $1; exit}')"
  [[ -z "$TARGET_USER" ]] && TARGET_USER="root"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[[ -d "$TARGET_HOME" ]] || TARGET_HOME="/root"

rc_files() { for f in "$TARGET_HOME/.bashrc" "$TARGET_HOME/.zshrc"; do [[ -f "$f" ]] && echo "$f"; done; }
strip_block() { sed -i "/$RC_BEGIN/,/$RC_END/d" "$1" 2>/dev/null || true; }

# ── --remove ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--remove" ]]; then
  info "Removing 9router MITM hooks (user: $TARGET_USER)"
  sed -i "/[[:space:]]${ANTHROPIC_HOST}\$/d" /etc/hosts || true
  sed -i "/${ANTHROPIC_HOST} # 9router-mitm/d" /etc/hosts || true
  rm -f "$CA_DEST" "$REFRESH_BIN" "$SUDOERS_FILE" "$HOST_OVERRIDE"
  update-ca-certificates --fresh >/dev/null 2>&1 || true
  for f in $(rc_files); do strip_block "$f"; done
  grn "Removed CA, hosts entry, refresh helper, sudoers, and shell hooks."
  exit 0
fi

PINNED_HOST="${1:-}"   # e.g. 127.0.0.1 for mirrored networking
info "Login user: $TARGET_USER  (home: $TARGET_HOME)"

# ── 1. Install the Root CA ───────────────────────────────────────────────────
WIN_APPDATA="$(cmd.exe /c 'echo %APPDATA%' 2>/dev/null | tr -d '\r' || true)"
CA_SRC=""
[[ -n "$WIN_APPDATA" ]] && CA_SRC="$(wslpath -u "${WIN_APPDATA}\\9router\\mitm\\rootCA.crt" 2>/dev/null || true)"
[[ -f "$CA_SRC" ]] || CA_SRC="/mnt/c/Users/Myko/AppData/Roaming/9router/mitm/rootCA.crt"
[[ -f "$CA_SRC" ]] || { red "Root CA not found ($CA_SRC). Start 9router on Windows once, then re-run."; exit 1; }
install -m 0644 "$CA_SRC" "$CA_DEST"
update-ca-certificates >/dev/null
grn "Installed CA → $CA_DEST"

# ── 2. Install the refresh helper ────────────────────────────────────────────
cat > "$REFRESH_BIN" <<'EOS'
#!/usr/bin/env bash
# Repoint api.anthropic.com at the 9Router MITM on the Windows host. Idempotent;
# safe to run on every shell. Uses /etc/9router-mitm.host if present (mirrored mode),
# else the WSL2 NAT default-route gateway (= the Windows host).
set -e
H="api.anthropic.com"; MARK="# 9router-mitm"; OVR="/etc/9router-mitm.host"
if [[ -s "$OVR" ]]; then
  WINHOST="$(tr -d '[:space:]' < "$OVR")"
else
  WINHOST="$(ip route show default 2>/dev/null | awk '/default/{print $3; exit}')"
  [[ -n "$WINHOST" ]] || WINHOST="$(awk '/nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
fi
[[ -n "$WINHOST" ]] || exit 0
LINE="$WINHOST $H $MARK"
grep -qxF "$LINE" /etc/hosts 2>/dev/null && exit 0
sed -i "/$MARK/d;/[[:space:]]$H\$/d" /etc/hosts
echo "$LINE" >> /etc/hosts
EOS
chmod 0755 "$REFRESH_BIN"
grn "Installed refresh helper → $REFRESH_BIN"

# Pin host for mirrored mode if an IP was passed.
if [[ -n "$PINNED_HOST" ]]; then
  echo "$PINNED_HOST" > "$HOST_OVERRIDE"
  grn "Pinned MITM host = $PINNED_HOST (from $HOST_OVERRIDE)"
else
  rm -f "$HOST_OVERRIDE"   # fall back to dynamic gateway detection
fi

# ── 3. Passwordless sudoers + shell hook ─────────────────────────────────────
if [[ "$TARGET_USER" != "root" ]]; then
  echo "$TARGET_USER ALL=(root) NOPASSWD: $REFRESH_BIN" > "$SUDOERS_FILE"
  chmod 0440 "$SUDOERS_FILE"
  if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
    rm -f "$SUDOERS_FILE"; red "sudoers validation failed — skipped passwordless rule."
  else
    grn "Passwordless sudo for refresh → $SUDOERS_FILE"
  fi
  HOOK_CMD="sudo -n $REFRESH_BIN 2>/dev/null || true"
else
  HOOK_CMD="$REFRESH_BIN 2>/dev/null || true"
fi

for f in $(rc_files); do
  strip_block "$f"
  {
    echo "$RC_BEGIN"
    echo "export NODE_EXTRA_CA_CERTS=$CA_DEST"
    echo "$HOOK_CMD"
    echo "$RC_END"
  } >> "$f"
  chown "$TARGET_USER": "$f" 2>/dev/null || true
  grn "Hooked $f"
done
# Guarantee at least .bashrc exists with the hook even on a bare profile.
if [[ -z "$(rc_files)" ]]; then
  f="$TARGET_HOME/.bashrc"
  { echo "$RC_BEGIN"; echo "export NODE_EXTRA_CA_CERTS=$CA_DEST"; echo "$HOOK_CMD"; echo "$RC_END"; } >> "$f"
  chown "$TARGET_USER": "$f" 2>/dev/null || true
  grn "Created + hooked $f"
fi

# ── 4. One-shot refresh + health check ───────────────────────────────────────
"$REFRESH_BIN"
WINHOST_NOW="$(awk -v h="$ANTHROPIC_HOST" '$2==h{print $1; exit}' /etc/hosts)"
info "/etc/hosts: $WINHOST_NOW $ANTHROPIC_HOST"
info "Testing https://$ANTHROPIC_HOST/_mitm_health …"
set +e
OUT="$(NODE_EXTRA_CA_CERTS="$CA_DEST" curl -fsS --max-time 8 "https://$ANTHROPIC_HOST/_mitm_health" 2>/tmp/9r_curl_err)"
RC=$?
set -e
if [[ $RC -eq 0 ]] && echo "$OUT" | grep -q '"ok":true'; then
  grn "✅ MITM reachable AND certificate trusted: $OUT"
  grn "   Done. Open a NEW Kali shell (or: source ~/.bashrc) and run: claude"
  exit 0
fi
ERR="$(cat /tmp/9r_curl_err 2>/dev/null || true)"
red "❌ Health check failed (curl exit $RC): $ERR"
if echo "$ERR" | grep -qiE "self.signed|local issuer|certificate"; then
  red "   → CA not trusted. Confirm $CA_DEST exists and update-ca-certificates ran."
elif echo "$ERR" | grep -qiE "refused|timed out|connect|no route"; then
  red "   → Network blocked. On Windows (elevated PowerShell), add the firewall rule:"
  red "       New-NetFirewallRule -DisplayName '9router MITM (WSL) 443' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443"
  red "     and confirm 9router is running (it owns :443)."
fi
red "   Isolate cert vs connectivity:  curl -vk https://$ANTHROPIC_HOST/_mitm_health"
exit 1
