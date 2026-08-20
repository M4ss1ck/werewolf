// Which browser origins this deployment answers to.
//
// The packaged Tauri clients load from a fixed webview origin that is a
// property of the client, not of a deployment: an operator cannot know it and
// has no reason to choose it. Leaving it to BETTER_AUTH_TRUSTED_ORIGINS meant
// every deployment had to remember to paste in two magic strings or the desktop
// and Android apps were refused, so they are constants here instead.
//
// BETTER_AUTH_TRUSTED_ORIGINS keeps its real job: origins that genuinely vary
// per deployment, such as the Vite dev server or a web frontend on its own
// domain.
export const PACKAGED_APP_ORIGINS = [
  // Linux and macOS webviews.
  "tauri://localhost",
  // Windows (WebView2) and Android.
  "http://tauri.localhost",
];

/**
 * Every origin allowed to call the API, open a live socket, or act as a Better
 * Auth callback: this server's own origin, whatever the deployment configured,
 * and the packaged clients.
 *
 * The server's own origin is included so that a same-origin deployment — the
 * usual one, where this process also serves the SPA — still recognises its own
 * pages once the list is non-empty.
 */
export function allowedOrigins(authUrl: string, configured: string[]): string[] {
  const origins = [...configured, ...PACKAGED_APP_ORIGINS];
  try {
    origins.unshift(new URL(authUrl).origin);
  } catch {
    // A malformed BETTER_AUTH_URL is caught by env validation; nothing to add.
  }
  return [...new Set(origins)];
}
