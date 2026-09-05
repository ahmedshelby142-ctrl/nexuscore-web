import { create } from "zustand";
import type { ShippingRateRow } from "@/types";
import { writeThrough, deleteThrough } from "@/services/cloudData";
import { getDeviceId } from "@/services/api/storeContext";

/**
 * The shipping price matrix the owner edits in الإعدادات → الشحن.
 *
 * CLOUD-BACKED since migration 018. It used to live in localStorage and
 * nowhere else, which was the last piece of business data in this app a second
 * device could not see — and not cosmetically: `/ecommerce-orders` builds its
 * governorate dropdown from these rows, so a browser without them could not
 * raise an online order at all.
 *
 * These rows are reference CONFIG, not a computed value — storing them is
 * legitimate in a way a balance never is. Every fee is snapshotted into the
 * ledger event at the moment of the movement, so this table prices the FUTURE
 * and never rewrites the past.
 *
 * It still starts EMPTY on purpose. The old code shipped 26 hardcoded
 * governorate fees, which meant the app quoted prices the owner had never
 * agreed to. A shop with no rates entered ships nothing until the owner says
 * what it costs — and the screens now SAY so rather than showing an empty
 * dropdown and a disabled button.
 */
interface ShippingRatesState {
  rows: ShippingRateRow[];
  /** True once a hydration attempt has finished — "empty" vs "not read yet". */
  loaded: boolean;
  addRow: (governorate: string) => Promise<void>;
  updateRow: (id: string, updates: Partial<Omit<ShippingRateRow, "id">>) => Promise<void>;
  removeRow: (id: string) => Promise<void>;
}

export const useShippingRatesStore = create<ShippingRatesState>()((set, get) => ({
  rows: [],
  loaded: false,

  addRow: async (governorate) => {
    const name = governorate.trim();
    if (!name) return;
    // One row per governorate. The unique index enforces this for real — two
    // devices adding the same place at once both pass this check, and only
    // Postgres can settle it.
    if (get().rows.some((r) => r.governorate.trim().toLowerCase() === name.toLowerCase())) return;

    const row = {
      id: crypto.randomUUID(),
      governorate: name,
      delivery: 0,
      return: 0,
      exchange: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      device_id: getDeviceId(),
      updated_at: Date.now(),
    } as ShippingRateRow;

    const saved = (await writeThrough("shipping_rates", row)) as ShippingRateRow;
    set((state) => ({ rows: [...state.rows, saved] }));
  },

  updateRow: async (id, updates) => {
    const current = get().rows.find((r) => r.id === id);
    if (!current) return;
    const merged = {
      ...current,
      ...updates,
      id,
      updatedAt: new Date(),
      updated_at: Date.now(),
    } as ShippingRateRow;
    const saved = (await writeThrough("shipping_rates", merged)) as ShippingRateRow;
    set((state) => ({ rows: state.rows.map((r) => (r.id === id ? { ...r, ...saved } : r)) }));
  },

  removeRow: async (id) => {
    await deleteThrough("shipping_rates", id);
    set((state) => ({ rows: state.rows.filter((r) => r.id !== id) }));
  },
}));
