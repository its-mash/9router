# 9router — fresh-Ubuntu setup (Claude-Code TLS-MITM account pool)

This fork of 9router adds a **host-level TLS-MITM of `api.anthropic.com`** so Claude Code transparently
**load-balances across a pool of connected Claude (Pro/Max OAuth) accounts** — no per-agent env, no wrapper.
This doc stands it up from scratch on a clean Ubuntu box.

> **Build from THIS fork's source — do NOT `npm install -g 9router`.** The public npm package does not have
> the Claude MITM account-load-balancing (fork commits `e8ef951` native account load-balancing + `d289d67`
> headless auto-start). Clone + build instead.

## Two runtime data planes
| Plane | Listens | Runs as | What |
|---|---|---|---|
| Dashboard / router backend | `http://localhost:20128` | your user | Next.js standalone server (config UI + `/v1/messages` combo pipeline) |
| **TLS-MITM** | `:443` | **root** (spawned via `sudo` by the dashboard) | intercepts `api.anthropic.com`, presents leaf certs signed by the 9Router Root CA, rotates the account pool |

## 0. Prereqs
- **Node 22** + npm (global prefix `~/.local` → global bins in `~/.local/bin`, which must be on `PATH`).
- `git`, `sudo` (port 443 needs root), a graphical/login session for the one-time OAuth + sudo prompt.
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

## 1. Clone + build + install the CLI
```bash
git clone git@github.com:its-mash/9router.git ~/9router
cd ~/9router
npm install                 # root Next-app deps
npm run build:install        # scripts/buildAndInstall.cjs: builds cli/ (Next standalone + src/mitm + open-sse
                             # copied into cli/app/) then `npm link` → global `9router` bin
```
Result: `~/.local/bin/9router` → `~/.local/lib/node_modules/9router` → symlink to the repo's `cli/`. Because
it's `npm link`, later `npm run build:cli` rebuilds are picked up with no re-link. Build-only: `npm run build:cli`.

## 2. Run it + auto-start at boot
Foreground (dashboard `:20128` + MITM `:443`):
```bash
9router --no-browser --skip-update --log     # --skip-update is REQUIRED (custom fork; don't self-update over your build)
```
systemd **--user** service (the real auto-start) — write `~/.config/systemd/user/9router.service`:
```ini
[Unit]
Description=9router — AI proxy + Claude MITM (http://localhost:20128)
After=network-online.target
Wants=network-online.target
[Service]
Environment=NODE_ENV=production
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=INITIAL_PASSWORD=change-me       # seeds the dashboard admin pw on FIRST run only
ExecStart=%h/.local/bin/9router --no-browser --skip-update --log
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
```
```bash
systemctl --user daemon-reload
systemctl --user enable --now 9router.service
sudo loginctl enable-linger "$USER"          # start at boot without a login session
journalctl --user -u 9router -f              # logs
```
(A Docker path exists — `Dockerfile`, `docker-compose.yml`, `DATA_DIR=/var/lib/9router`, port 20128 — but the
systemd user service above is the supported host setup.)

## 3. Enable the MITM + trust the CA
In the dashboard (`http://localhost:20128`) → **MITM tools → Claude Code (anthropic)**: toggle **DNS** and
**MITM on**. This:
1. writes `127.0.0.1  api.anthropic.com` into `/etc/hosts` (DNS-hijack; stripped again on shutdown),
2. generates the Root CA at `~/.9router/mitm/rootCA.crt` (+ **`rootCA.key` — SECRET**, RSA-2048, 10-yr),
3. installs the CA into the system trust store via `sudo` (**first enable prompts for the sudo password**).

The interception is **DNS-hijack + transparent TLS-MITM** (not an HTTP/SOCKS proxy, not a base-URL override):
Claude Code → TLS to `api.anthropic.com:443` → resolves to `127.0.0.1` (the MITM) → MITM mints a leaf cert
signed by the Root CA, terminates TLS, re-originates to the REAL Anthropic (resolved via `8.8.8.8`, bypassing
its own hosts entry) over HTTP/2.

**Manual CA trust** (equivalent to what the dashboard does with sudo):
```bash
sudo cp ~/.9router/mitm/rootCA.crt /usr/local/share/ca-certificates/9router-root-ca.crt
sudo update-ca-certificates          # → /etc/ssl/certs/ca-certificates.crt
```
- The native `claude` binary (bun-compiled ELF) uses the **system OpenSSL trust store**, so the step above is
  sufficient — **no `NODE_EXTRA_CA_CERTS` needed**.
- **Node-based** clients ignore the system store — for those also: `export NODE_EXTRA_CA_CERTS=~/.9router/mitm/rootCA.crt` (or Node 22+: `export NODE_OPTIONS=--use-system-ca`).

## 4. Connect the Claude account pool (never hand-edit tokens)
Dashboard → **Providers → Connect "Claude Code"** → OAuth-login with a Claude Pro/Max account. 9router stores
the OAuth token (in `~/.9router/db/data.sqlite`, table `providerConnections.data` — **SECRET**) and
**auto-refreshes** it. Repeat per account; set each account's **priority** in the UI. On `401/403/429/529` the
MITM rotates to the next account (up to 4 attempts), then returns a clean `429` so Claude Code backs off
correctly. If no managed accounts are connected, it passes the client's own token straight through — nothing
breaks.

## 5. Model-id routing
- **Native ids** (`opus`, `sonnet`, `claude-opus-4-8`, `claude-opus-4-7[1m]`, `claude-haiku-4-5`, …) → the
  **account-pool rotation path** (what every downstream agent uses by default). "Direct to Anthropic" still
  flows *through* the MITM — it just rotates accounts transparently.
- **`9r/<combo>`** ids → the MITM strips `9r/` and forwards to the local `/v1/messages` **combo pipeline**
  (multi-provider fallback + the web_search/web_fetch shim). `<combo>` must be a combo you define in the
  dashboard (e.g. `9r/opus`). See `CLAUDE_CODE_MITM_IMPLEMENTATION.md` for the shim internals.

## 6. Verify
```bash
systemctl --user is-active 9router                                   # active
getent hosts api.anthropic.com                                        # -> 127.0.0.1 (when MITM DNS is on)
openssl s_client -connect 127.0.0.1:443 -servername api.anthropic.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject                              # issuer=CN=9Router MITM Root CA
claude -p "say ok"                                                    # routes through the pool
```

## 7. Gotchas & secrets
- **Do NOT `npm i -g 9router`** (public package, no Claude MITM). Build the fork (§1).
- **Port 443 needs root** → the MITM child is `sudo`-spawned. The cached sudo password
  (`settings.mitmSudoEncrypted`) is **machine-id-bound**, so after a fresh install / machine move you re-enter
  it once on the MITM toggle. (Or grant passwordless sudo for the MITM binary.)
- **Per-machine SECRET state under `~/.9router/`** — never print or commit any of these; regenerate/re-provision
  on a new box (the CA auto-generates; accounts re-connect via OAuth):
  `mitm/rootCA.key` (CA private key — forge-anything), `jwt-secret`, `machine-id`, `auth/cli-secret`,
  and `db/data.sqlite` (`providerConnections.data` = OAuth tokens). `.env` is gitignored — keep it that way.
- **Remote/hub use:** to let *another* LAN machine route through this box's 9router, on that machine add
  `<hub-ip>  api.anthropic.com` to `/etc/hosts` and install this CA — see the bb-team repo's
  `infra/remote/SETUP.md`.

## Key paths
| Path | Role |
|---|---|
| `src/mitm/server.js` | MITM https server (`:443`, SNI leaf-cert signing) |
| `src/mitm/handlers/anthropic.js` | native account-rotation + `9r/<combo>` routing |
| `src/mitm/dns/dnsConfig.js` | `/etc/hosts` hijack |
| `src/mitm/cert/{rootCA,install}.js` | CA generation + system-store install |
| `scripts/buildAndInstall.cjs` | build + `npm link` installer |
| `cli/app/…` | built standalone bundle the service actually runs |
| `~/.9router/mitm/rootCA.crt` | CA cert (install into the trust store) |
| `~/.9router/mitm/rootCA.key` | **CA private key — SECRET** |
| `~/.9router/db/data.sqlite` | account pool + settings/combos |
| `~/.config/systemd/user/9router.service` | boot service |
