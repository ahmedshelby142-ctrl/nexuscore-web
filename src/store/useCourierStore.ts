import { create } from "zustand";
import { writeThrough, deleteThrough } from "@/services/cloudData";
import type { CourierAccount } from "@/types";

interface CourierState {
  accounts: CourierAccount[];
  addCourier: (courier: { name: string; phone?: string; notes?: string }) => Promise<CourierAccount>;
  updateCourier: (id: string, updates: Partial<CourierAccount>) => Promise<void>;
  removeCourier: (id: string) => Promise<void>;
  settleBalance: (id: string, amount: number, note?: string) => void;
}

/**
 * WHO the couriers are. Not what they owe — that is the ledger's.
 *
 * ## What changed, and why it had to
 *
 * This store used to be `persist`ed to **localStorage** under `courier-storage`,
 * with no table behind it and no entry in `CLOUD_SCHEMA`. So a courier
 * registered on the shop's laptop did not exist on the phone, and the order form
 * had no list worth offering — which is exactly why «اسم شركة الشحن» was a
 * free-text box, and why «أرامكس» typed twice became two couriers whose money
 * could never be reconciled into one account.
 *
 * Migration 030 gives couriers a real store-scoped table, so the writes now go
 * through `writeThrough` — the same await-the-database-then-commit path every
 * other reference record uses. A failed write leaves the screen unchanged and
 * raises, rather than showing a courier that quietly disappears on reload.
 *
 * ## No `recalc`, still
 *
 * What a courier owes us is `SUM(receivable_courier)` and what we owe them is
 * `SUM(payable_courier)`, both read straight from the ledger. The four stored
 * totals this store once maintained are gone and are not coming back.
 */
export const useCourierStore = create<CourierState>()((set) => ({
  accounts: [],

  addCourier: async (courier) => {
    const now = new Date();
    const row: CourierAccount = {
      id: crypto.randomUUID(),
      name: courier.name.trim(),
      phone: courier.phone?.trim(),
      notes: courier.notes?.trim(),
      orderIds: [],
      settlements: [],
      createdAt: now,
      updatedAt: now,
    } as CourierAccount;

    // `couriers_name_per_store` is UNIQUE on (store_id, lower(name)) among live
    // rows, so a duplicate is refused by the DATABASE rather than by a check
    // this store could race with. The error reaches the form.
    const saved = (await writeThrough("couriers", row)) as CourierAccount;
    set((state) => ({ accounts: [...state.accounts, saved] }));
    return saved;
  },

  updateCourier: async (id, updates) => {
    const current = (useCourierStore.getState().accounts ?? []).find((a) => a.id === id);
    if (!current) return;
    const saved = (await writeThrough("couriers", {
      ...current,
      ...updates,
      id,
      updatedAt: new Date(),
    })) as CourierAccount;
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, ...saved } : a)),
    }));
  },

  removeCourier: async (id) => {
    // Soft delete, like every other directory: past orders keep pointing at
    // this courier and their money must still resolve to a name.
    await deleteThrough("couriers", id);
    set((state) => ({ accounts: state.accounts.filter((account) => account.id !== id) }));
  },

  settleBalance: (id, amount, note) => {
    if (amount <= 0) return;
    set((state) => ({
      accounts: state.accounts.map((account) => {
        if (account.id !== id) return account;
        // Records the settlement DOCUMENT only. The cash and the debts move
        // on the `courier_settlement` event the caller appends.
        return {
          ...account,
          settlements: [
            ...account.settlements,
            {
              id: crypto.randomUUID(),
              courierId: account.id,
              amount,
              note,
              createdAt: new Date(),
            },
          ],
          updatedAt: new Date(),
        };
      }),
    }));
  },
}));
