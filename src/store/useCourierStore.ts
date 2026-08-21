import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CourierAccount } from "@/types";

interface CourierState {
  accounts: CourierAccount[];
  addCourier: (
    courier: Omit<
      CourierAccount,
      | "id"
      | "totalExpectedCod"
      | "cashReceived"
      | "commissionFees"
      | "remainingBalance"
      | "orderIds"
      | "settlements"
      | "updatedAt"
    >,
  ) => void;
  updateCourier: (id: string, updates: Partial<CourierAccount>) => void;
  removeCourier: (id: string) => void;
  settleBalance: (id: string, amount: number, note?: string) => void;
}

/**
 * No `recalc` any more, and no `recordOrderCod`.
 *
 * It kept `remainingBalance` in step with three other stored numbers. All four
 * are gone: what a courier owes us is SUM(receivable_courier) and what we owe
 * them is SUM(payable_courier), both read straight from the ledger. This store
 * now holds only WHO the couriers are.
 *
 * `recordOrderCod` was deleted 2026-08-19: it filled `orderIds` and was the only
 * thing that ever created a courier row — and **nothing called it**, so حسابات
 * الشحن listed no couriers at all while the ledger held real balances for them.
 * The screen derives its couriers from the orders themselves now.
 */

export const useCourierStore = create<CourierState>()(
  persist(
    (set) => ({
      accounts: [],

      addCourier: (courier) => {
        set((state) => ({
          accounts: [
            ...state.accounts,
            {
              id: crypto.randomUUID(),
              name: courier.name,
              phone: courier.phone,
              orderIds: [],
              settlements: [],
              updatedAt: new Date(),
            },
          ],
        }));
      },

      updateCourier: (id, updates) => {
        set((state) => ({
          accounts: state.accounts.map((account) =>
            account.id === id ? { ...account, ...updates, updatedAt: new Date() } : account,
          ),
        }));
      },

      removeCourier: (id) => {
        set((state) => ({
          accounts: state.accounts.filter((account) => account.id !== id),
        }));
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
    }),
    { name: "courier-storage" },
  ),
);
