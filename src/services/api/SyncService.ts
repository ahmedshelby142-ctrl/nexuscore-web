import type { SyncAction } from '../../types';
import { getSupabaseClient, isCloudSyncMode } from './supabaseClient';

/**
 * SyncService — Real Supabase Push Engine
 *
 * Bridge between local Zustand stores and the Supabase Cloud Database.
 * Falls back gracefully to a no-op when Supabase is not configured,
 * allowing the app to run in full offline mode without errors.
 */
export class SyncService {
  /**
   * Push a single change to the cloud database.
   * Performs an UPSERT (insert-or-update) for INSERT/UPDATE actions
   * and a DELETE for DELETE actions.
   */
  static async pushChanges(table: string, data: any): Promise<void> {
    if (!isCloudSyncMode()) {
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      console.warn('[SyncService] Supabase client unavailable, skipping push.');
      return;
    }

    const { error } = await supabase.from(table).upsert(data, { onConflict: 'id' });

    if (error) {
      console.error(`[SyncService] Supabase upsert error on [${table}]:`, error.message);
      throw error;
    }
  }

  /**
   * Delete a record from the cloud database by its `id`.
   */
  static async deleteRecord(table: string, id: string): Promise<void> {
    if (!isCloudSyncMode()) return;

    const supabase = getSupabaseClient();
    if (!supabase) return;

    const { error } = await supabase.from(table).delete().eq('id', id);

    if (error) {
      console.error(`[SyncService] Supabase delete error on [${table}]:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch recent changes from the cloud database.
   * Returns records whose `updated_at` is greater than the given timestamp.
   */
  static async fetchChanges(table: string, lastSyncTimestamp: number): Promise<any[]> {
    if (!isCloudSyncMode()) return [];

    const supabase = getSupabaseClient();
    if (!supabase) return [];

    const { data, error } = await supabase
      .from(table)
      .select('*')
      .gt('updated_at', lastSyncTimestamp);

    if (error) {
      console.error(`[SyncService] Supabase fetch error on [${table}]:`, error.message);
      return [];
    }

    return data ?? [];
  }

  /**
   * Process a queue of offline SyncActions.
   * Routes each action to the appropriate Supabase operation.
   */
  static async processSyncQueue(queue: SyncAction[]): Promise<void> {
    if (!queue || queue.length === 0) return;
    if (!isCloudSyncMode()) {
      return;
    }


    for (const action of queue) {
      try {
        if (action.action === 'DELETE') {
          await this.deleteRecord(action.table, action.payload?.id);
        } else {
          // INSERT and UPDATE both resolve to an upsert
          await this.pushChanges(action.table, action.payload);
        }
      } catch (error) {
        console.error(`[SyncService] ✗ Failed to sync action ${action.id}:`, error);
        // Stop processing on first failure so the remaining queue is retried
        // next time the network listener fires.
        throw error;
      }
    }
  }
}
