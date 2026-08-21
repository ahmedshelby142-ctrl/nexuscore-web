import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ShippingRateRow } from "@/types";

/**
 * The shipping price matrix the owner edits in Settings.
 *
 * This is reference CONFIG, not a computed value — storing it is legitimate in
 * a way a balance never is. Nothing derives from it after the fact: every fee
 * is snapshotted into the ledger event at the moment of the movement, so this
 * table prices the future and never rewrites the past.
 *
 * It starts EMPTY on purpose. The old code shipped 26 hardcoded governorate
 * fees and a seeded 65/45 tariff, which meant the app quoted prices the owner
 * had never agreed to. A shop with no rates entered ships nothing until the
 * owner says what it costs.
 */
interface ShippingRatesState {
  rows: ShippingRateRow[];
  addRow: (governorate: string) => void;
  updateRow: (id: string, updates: Partial<Omit<ShippingRateRow, "id">>) => void;
  removeRow: (id: string) => void;
}

export const useShippingRatesStore = create<ShippingRatesState>()(
  persist(
    (set) => ({
      rows: [],

      addRow: (governorate) => {
        const name = governorate.trim();
        if (!name) return;
        set((state) =>
          // One row per governorate — two rows for the same place would make
          // "the rate" ambiguous, and the lookup would silently pick the first.
          state.rows.some((r) => r.governorate.trim().toLowerCase() === name.toLowerCase())
            ? state
            : {
                rows: [
                  ...state.rows,
                  { id: crypto.randomUUID(), governorate: name, delivery: 0, return: 0, exchange: 0 },
                ],
              },
        );
      },

      updateRow: (id, updates) => {
        set((state) => ({
          rows: state.rows.map((r) => (r.id === id ? { ...r, ...updates } : r)),
        }));
      },

      removeRow: (id) => {
        set((state) => ({ rows: state.rows.filter((r) => r.id !== id) }));
      },
    }),
    { name: "shipping-rates-storage" },
  ),
);
