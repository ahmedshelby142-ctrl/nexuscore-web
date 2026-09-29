/**
 * Where the Mobile Operations app lives — the one client-side source of truth.
 *
 * Desktop and Mobile are two separate builds on two origins (Vercel projects
 * `nexuscore-web1` and `nexuscore-mobile`), each with its own Supabase session
 * storage. MODERATOR is a Mobile-only persona (`mobileCapabilities.ts`); when an
 * auth link or a sign-in brings one to the Desktop origin anyway, the Desktop
 * moves the session to this URL (`mobileSessionTransfer.ts`).
 *
 * Set per deployment with `VITE_MOBILE_APP_URL` (a local pair of dev servers,
 * a preview, a custom domain). The server-side twin is the `MOBILE_APP_URL`
 * function secret read by `supabase/functions/invite-staff`.
 *
 * Deliberately dependency-free so the route/bootstrap tests can load it.
 */
const configured = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MOBILE_APP_URL;

export const MOBILE_APP_URL = (configured?.trim() || "https://nexuscore-mobile.vercel.app").replace(/\/+$/, "");

/** A path on the Mobile app. */
export function mobileAppUrl(path = "/"): string {
  return `${MOBILE_APP_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface TransferableSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
}

/**
 * The Mobile URL that carries an existing Supabase session in its fragment —
 * the exact shape Supabase itself redirects with (`#access_token=…`), which
 * the Mobile client's `detectSessionInUrl` consumes and then clears.
 *
 * The fragment never reaches a server, and the target is this build-time
 * constant — never anything read from the URL — so it cannot be turned into
 * an open redirect. `type` keeps an invite/recovery an invite/recovery, so the
 * Mobile app opens its password screen (`authLinkIntent.ts`).
 */
export function mobileSessionUrl(
  path: "/" | "/set-password",
  session: TransferableSession,
  type?: "invite" | "recovery",
  nowMs = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  const expiresAt = session.expires_at ?? now + (session.expires_in ?? 3600);
  const params = new URLSearchParams({
    access_token: session.access_token,
    expires_at: String(expiresAt),
    expires_in: String(Math.max(1, expiresAt - now)),
    refresh_token: session.refresh_token,
    token_type: session.token_type || "bearer",
  });
  if (type) params.set("type", type);
  return `${mobileAppUrl(path)}#${params.toString()}`;
}
