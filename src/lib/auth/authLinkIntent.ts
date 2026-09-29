/**
 * Invitation and password-recovery links: send them to the password screen.
 *
 * A Supabase invite or recovery email opens the app with the session in the
 * URL fragment (`#access_token=…&type=invite|recovery`). supabase-js turns
 * that into a session silently (`detectSessionInUrl`) and then CLEARS the
 * fragment — so a link that landed anywhere but `/set-password` (a recovery
 * link sent to the project's Site URL, which is the root) signed the user in
 * with no chance to set a password, and the router sent them to their role's
 * home. For MODERATOR on Desktop that was «التفضيلات الشخصية» and nothing
 * else.
 *
 * This module is imported FIRST by both entry points (`src/main.tsx`,
 * `src/mobile/main.tsx`), before anything can construct the Supabase client:
 * it reads the fragment while it is still there and, for an invite, a
 * recovery, or a failed/expired link, moves the URL to `/set-password` WITH
 * the fragment intact — supabase-js then consumes it there, and the password
 * screen decides what to show. Nothing about the session is decided here.
 *
 * Deliberately dependency-free: importing anything would let another module
 * (and possibly the Supabase client) evaluate first.
 */

export type AuthLinkIntent = "invite" | "recovery" | "link_error" | null;

/** What kind of auth link this URL is, from its fragment or query. */
export function parseAuthLinkIntent(href: string): AuthLinkIntent {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  for (const [key, value] of url.searchParams) if (!params.has(key)) params.set(key, value);

  const type = params.get("type");
  if (type === "invite") return "invite";
  if (type === "recovery") return "recovery";
  // Supabase reports an expired or already-used link as `#error=…&error_code=…`.
  // Only when it carries an auth error code — a plain `?error=` elsewhere is not ours.
  if (params.get("error_code") && (params.get("error") || params.get("error_description"))) {
    return "link_error";
  }
  return null;
}

let captured: AuthLinkIntent = null;

/** The intent the page was opened with. Read by the password screens. */
export function authLinkIntent(): AuthLinkIntent {
  return captured;
}

/**
 * Capture the intent and move an auth link to `/set-password`, keeping the
 * query and fragment so supabase-js can still consume the session there.
 * Returns the captured intent. Idempotent.
 */
export function routeAuthLinkToPasswordSetup(
  win: { location: { href: string; pathname: string; search: string; hash: string }; history: { replaceState: (data: unknown, unused: string, url: string) => void } } | undefined =
    typeof window === "undefined" ? undefined : window,
): AuthLinkIntent {
  if (!win) return null;
  const intent = parseAuthLinkIntent(win.location.href);
  if (!intent) return captured;
  captured = intent;
  if (win.location.pathname !== "/set-password") {
    win.history.replaceState(null, "", "/set-password" + win.location.search + win.location.hash);
  }
  return intent;
}

// Runs on import — see the module comment for why it must be the first import.
routeAuthLinkToPasswordSetup();
