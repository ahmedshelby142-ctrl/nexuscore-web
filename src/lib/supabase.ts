import { createClient, RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

let supabaseClient: SupabaseClient | null = null;
let operationMode: "offline_local" | "cloud_sync" | null = null;

/**
 * Determine the operation mode based on environment variables.
 * 
 * Priority:
 *   1. If VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are both provided and valid → cloud_sync
 *   2. Otherwise → offline_local (fallback)
 * 
 * This allows zero-code-touch environment toggle: just add the keys to .env
 * and the app automatically switches to Supabase.
 */
export function getOperationMode(): "offline_local" | "cloud_sync" {
  if (operationMode !== null) {
    return operationMode;
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

  // Both keys must be present and non-empty to enable cloud mode
  if (supabaseUrl && supabaseAnonKey) {
    operationMode = "cloud_sync";
  } else {
    operationMode = "offline_local";
  }

  return operationMode;
}

/**
 * Lazy initialization of Supabase client
 * Only initializes if environment variables are configured
 * Returns null if Supabase is not configured, allowing app to run offline
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

  // Return null if Supabase is not configured
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  try {

    if (!supabaseUrl || !supabaseUrl.startsWith('http')) {
        console.error("CRITICAL: Supabase URL is missing or invalid in .env.local!");
    }

    supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
    return supabaseClient;
  } catch (error) {
    console.error("Failed to initialize Supabase client:", error);
    return null;
  }
}

/**
 * Check if Supabase is configured and available
 */
export function isSupabaseConfigured(): boolean {
  return getSupabaseClient() !== null;
}

/**
 * Check if the app is running in cloud sync mode
 */
export function isCloudSyncMode(): boolean {
  return getOperationMode() === "cloud_sync";
}

/**
 * Real-time subscription to user profile changes
 * Automatically updates UI when subscription status changes
 * Only works if Supabase is configured, otherwise returns null
 */
export function subscribeToProfileChanges(
  userId: string,
  callback: (profile: any) => void,
): RealtimeChannel | null {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn("Supabase not configured, real-time subscriptions disabled");
    return null;
  }
  return supabase
    .channel(`profile-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "profiles",
        filter: `id=eq.${userId}`,
      },
      (payload: { new: any }) => {
        callback(payload.new);
      },
    )
    .subscribe();
}
