/**
 * Supabase Client — Convenience re-export
 *
 * The canonical Supabase singleton lives in `src/lib/supabase.ts`.
 * This file provides a shorthand so the sync layer can import from
 * a predictable path without reaching into the broader lib folder.
 */
export { getSupabaseClient, isSupabaseConfigured, isCloudSyncMode } from '../../lib/supabase';
