import type { SyncAction } from '../../types';
import { getSupabaseClient, isCloudSyncMode } from './supabaseClient';
import {
  toRemoteRow,
  fromRemoteRow,
  noteMissingColumn,
  unknownColumnFrom,
} from './fieldMapping';
import { getSyncIdentity } from './storeContext';

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

    // The row must carry `store_id` or RLS refuses it. Every reference table's
    // policy is `WITH CHECK (has_role(store_id, …))`, and a missing store_id
    // makes that check false — a 403 that used to be logged and swallowed,
    // which is the whole reason reference data never left the device.
    const identity = await getSyncIdentity();
    if (!identity) {
      // Not an error: a device that has not been bound to a store yet has
      // nothing valid to tag rows with. Throwing puts the row in the caller's
      // sync queue, so it goes out on the next attempt once login has bound it
      // — far better than pushing rows the server will reject or orphan.
      throw new Error(
        `[SyncService] no active store yet — [${table}] queued until this device is bound`,
      );
    }

    // One stamp for the whole batch, so rows written together sort together and
    // a pull cannot see half of a multi-row write.
    const stamp = Date.now();

    // A column the server does not have sinks the WHOLE upsert, so a rejection
    // naming one is recorded and the push retried without it. That is what lets
    // `metadata` (the per-درجة stock) be sent optimistically: a server that has
    // the column stores the variants, one that does not costs a single extra
    // request per session and still syncs everything else. See `fieldMapping`.
    //
    // Bounded, and each pass drops one more column, so it always terminates.
    for (let attempt = 0; ; attempt++) {
      const payload = Array.isArray(data)
        ? data.map((row) =>
            toRemoteRow(table, row, {
              storeId: identity.storeId,
              deviceId: identity.deviceId,
              stamp,
            }),
          )
        : toRemoteRow(table, data, {
            storeId: identity.storeId,
            deviceId: identity.deviceId,
            stamp,
          });

      const { error } = await supabase.from(table).upsert(payload, { onConflict: 'id' });
      if (!error) return;

      const missing = unknownColumnFrom(error);
      if (missing && attempt < 8) {
        console.warn(
          `[SyncService] [${table}] has no '${missing}' column — retrying without it.`,
        );
        noteMissingColumn(table, missing);
        continue;
      }

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

    // Columns → the field names the local stores read.
    return (data ?? []).map((row) => fromRemoteRow(table, row));
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
