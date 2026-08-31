import { create } from "zustand";
import { persist } from "zustand/middleware";
import { upsertTarget } from "@/lib/customers";
import type { CustomerProfile, EcommerceOrder } from "@/types";
import { writeThrough, deleteThrough } from "@/services/cloudData";

/**
 * Write one customer to Supabase, then commit WHAT SUPABASE STORED.
 *
 * The previous version did the opposite — `set` first, `cloudUpsert().catch()`
 * after — and swallowed the failure with a `console.error`. A customer created
 * while RLS refused the row therefore appeared in قاعدة العملاء, was attached to
 * an order, and was gone on the next reload with nothing to explain it.
 *
 * Throws on failure, having committed nothing.
 */
async function saveCustomer(
  set: (fn: (state: any) => any) => void,
  customer: CustomerProfile,
): Promise<CustomerProfile> {
  const saved = (await writeThrough("customers", customer)) as CustomerProfile;
  set((state: any) => {
    const at = state.customers.findIndex((c: CustomerProfile) => c.id === saved.id);
    if (at < 0) return { customers: [...state.customers, saved] };
    const next = state.customers.slice();
    next[at] = { ...next[at], ...saved };
    return { customers: next };
  });
  return saved;
}

interface CustomerState {
  customers: CustomerProfile[];
  /** Register someone by hand, from قاعدة العملاء. Returns the new id. */
  addCustomer: (
    customer: Omit<
      CustomerProfile,
      "id" | "deleted_at"
    >,
  ) => Promise<string>;
  /** Correct a customer's details. Reference write — no ledger event. */
  updateCustomer: (id: string, updates: Partial<CustomerProfile>) => Promise<void>;
  /** Hard delete. Only legal when the customer has NO history — see
   *  `customerRemovalMode`; the screen asks the ledger before calling this. */
  removeCustomer: (id: string) => Promise<void>;
  /** Tombstone, for a customer who DOES have history. */
  archiveCustomer: (id: string) => Promise<void>;
  /**
   * Record that this person sent an order back.
   *
   * Every future order of theirs is then quoted at double shipping. Called once
   * per confirmed return, from the screens that confirm one.
   */
  recordReturn: (id: string) => Promise<void>;
  /**
   * ONE wasted trip has been paid for. Decrements the debt by exactly one.
   *
   * Called when an order that CHARGED the doubled fee is delivered. Three
   * returns cost the shop three trips, so they take three doubled deliveries to
   * settle — the customer pays back what was actually lost, one trip at a time,
   * and returns to the normal rate the moment the last one is square.
   *
   * Not a reset: zeroing the count would recover one trip and forgive the rest.
   */
  settleWastedTrip: (id: string) => Promise<void>;
  /** Undo an archive. `null`, never `undefined`, so the field stays present. */
  restoreCustomer: (id: string) => Promise<void>;
  /**
   * Find the person this order is for, creating them if this is their first,
   * and return their id.
   *
   * The ONE place a customer record is born from an order. It returns the id
   * because the order document has to carry it — an order that keeps only a
   * name and a phone string forces every later screen to re-derive the person,
   * which is what let one phone number end up as two records.
   *
   * Reference data, so no ledger event: creating a customer moves no money.
   * The `customer_ltv` line is written by `order_delivered`, keyed to the id
   * this returns.
   */
  upsertCustomerFromOrder: (order: EcommerceOrder) => Promise<string>;
}

export const useCustomerStore = create<CustomerState>()(
  persist(
    (set, get) => ({
      customers: [],

      addCustomer: async (customer) => {
        const draft: CustomerProfile = {
          id: crypto.randomUUID(),
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          deleted_at: null,
          // How many orders this person has sent back. Drives the double-shipping
          // penalty — see `shippingFeeFor`.
          returned_orders_count: 0,
          // Stamped so a realtime echo can tell whose copy is newer. Without it
          // every remote row looked newer than every local one and clobbered it.
          updated_at: Date.now(),
        };

        const saved = await saveCustomer(set, draft);
        return saved.id;
      },

      recordReturn: async (id) => {
        const current = get().customers.find((c) => c.id === id);
        if (!current) return;
        await saveCustomer(set, {
          ...current,
          returned_orders_count: (current.returned_orders_count ?? 0) + 1,
          updated_at: Date.now(),
        });
      },

      settleWastedTrip: async (id) => {
        const current = get().customers.find((c) => c.id === id);
        // Nothing owed, nothing to write — and no pointless `updated_at` bump
        // that would beat a real edit from another device.
        if (!current || (current.returned_orders_count ?? 0) <= 0) return;

        await saveCustomer(set, {
          ...current,
          // `Math.max(0, …)` so a count corrupted below zero can never make the
          // debt grow by settling it.
          returned_orders_count: Math.max(0, (current.returned_orders_count ?? 0) - 1),
          updated_at: Date.now(),
        });
      },

      updateCustomer: async (id, updates) => {
        const current = get().customers.find((c) => c.id === id);
        if (!current) return;
        await saveCustomer(set, { ...current, ...updates, updated_at: Date.now() });
      },

      removeCustomer: async (id) => {
        // Deleted in the cloud FIRST. Hard delete is only legal for a customer
        // with no history (the ones with history are archived instead), and
        // dropping them locally before the server agreed is how they used to
        // come back on the next read.
        await deleteThrough("customers", id);
        set((state) => ({
          customers: state.customers.filter((customer) => customer.id !== id),
        }));
      },

      // Archiving is reference data, exactly like a partner's or a product's:
      // a tombstone, no ledger event, and every past order and `customer_ltv`
      // line keeps pointing at this id and still renders their name.
      archiveCustomer: async (id) => {
        const current = get().customers.find((c) => c.id === id);
        if (!current) return;
        await saveCustomer(set, {
          ...current,
          deleted_at: new Date().toISOString(),
          updated_at: Date.now(),
        });
      },

      restoreCustomer: async (id) => {
        const current = get().customers.find((c) => c.id === id);
        if (!current) return;
        // `null`, never `undefined`: the field stays present so a synced row
        // cannot read as "this device never knew about the tombstone".
        await saveCustomer(set, { ...current, deleted_at: null, updated_at: Date.now() });
      },

      upsertCustomerFromOrder: async (order) => {
        // Who this order belongs to — `@/lib/customers` owns the decision, so
        // the §1.3 scenario can be tested without a browser.
        const existing = upsertTarget(get().customers, order);

        if (existing) {
          // An order updates this customer's ACTIVITY and nothing about who
          // they are. It used to spread the order's name / phone / address over
          // the record, so re-ordering silently renamed a customer whose
          // spelling the owner had just corrected in قاعدة العملاء — an edit
          // undone by the next order. Identity is hers to set on that screen.
          return existing.id;
        }

        const saved = await saveCustomer(set, {
          id: crypto.randomUUID(),
          name: order.customerName,
          phone: order.customerPhone,
          address: order.address,
          deleted_at: null,
          updated_at: Date.now(),
        });
        return saved.id;
      },
    }),
    {
      name: "customer-storage",
      // Cloud-owned; hydrated on boot.
      partialize: () => ({}),
    },
  ),
);
