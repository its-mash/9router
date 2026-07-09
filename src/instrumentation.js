// Next.js instrumentation hook — register() runs ONCE when the server process
// starts (including the standalone/production server the CLI launches).
//
// Why this exists: initializeApp() (MITM auto-start, tunnel/tailscale auto-resume,
// watchdog, quota ping) is wired as an import side-effect of the dashboard root
// layout (src/app/layout.js → @/shared/services/bootstrap). On a headless boot
// (systemd `9router --no-browser`) no browser ever renders a page, the CLI makes
// no warm-up request, and /v1 + /api route handlers don't load layout.js — so that
// side-effect never fires and nothing auto-starts until someone opens the dashboard.
//
// Importing bootstrap here makes it fire at process startup instead. bootstrap.js
// is guarded by global.__appBootstrapped, so the layout import remains a harmless
// no-op if it also runs later.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("@/shared/services/bootstrap");
}
