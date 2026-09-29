import { mobileSessionUrl } from "@/lib/appSurfaces";
import { getSupabaseClient } from "@/lib/supabase";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * Move the current Supabase session from the Desktop origin to the Mobile app.
 *
 * Used only when a MODERATOR ends up on the Desktop: an invite or recovery link
 * Supabase sent to the Site URL (the Desktop root), a Desktop sign-in, or a
 * refresh of an old Desktop tab. The person keeps the session they already
 * have — no second sign-in, no password typed on the Desktop.
 *
 * The Desktop's own copy is dropped WITHOUT a server logout: `signOut()` —
 * even `{ scope: "local" }` — revokes the session server-side, which would
 * kill the one just handed over. Leaving the copy in place would be worse:
 * both origins would refresh the same token family, and Supabase revokes a
 * whole family when a rotated refresh token is reused.
 *
 * Returns false when there is no session to move.
 */
export async function moveSessionToMobile(
  path: "/" | "/set-password",
  type?: "invite" | "recovery",
): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;

  await supabase.auth.stopAutoRefresh();
  const { data } = await supabase.auth.getSession();
  if (!data.session) return false;

  const target = mobileSessionUrl(path, data.session, type);

  const storageKey = (supabase.auth as unknown as { storageKey?: string }).storageKey;
  try {
    if (storageKey) {
      for (const key of Object.keys(window.localStorage)) {
        if (key === storageKey || key.startsWith(`${storageKey}-`)) window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage unavailable: nothing persisted to drop.
  }
  useAuthStore.getState().logout();

  window.location.replace(target);
  return true;
}
