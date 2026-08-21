import { create } from "zustand";
import { persist } from "zustand/middleware";
import { upsertTarget } from "@/lib/customers";
import type { CustomerProfile, EcommerceOrder } from "@/types";
import { safeInvoke, isDesktop } from "@/lib/tauri";
import { pushPendingChanges } from "@/services/ledgerSyncEngine";
import { SyncService } from "@/services/api/SyncService";

async function syncCustomerToDb(customer: CustomerProfile) {
  try {
    if (isDesktop) {
      const identity: any = await safeInvoke("ledger_identity", {
        candidateStoreId: "dummy",
        candidateDeviceId: "dummy",
      });
      if (!identity || identity.store_provisional) return;
      
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const dbPath = await safeInvoke<string | null>("ledger_db_path");
      if (!dbPath) return;
      
      const db = await Database.load(`sqlite:${dbPath}`);
      
      await db.execute(
        `INSERT INTO customers (id, name, phone, address, deleted_at, store_id, device_id, sync_status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT(id) DO UPDATE SET 
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           address = EXCLUDED.address,
           deleted_at = EXCLUDED.deleted_at,
           sync_status = 'pending'`,
        [
          customer.id, 
          customer.name, 
          customer.phone, 
          customer.address || "", 
          customer.deleted_at,
          identity.store_id,
          identity.device_id
        ]
      );
      
      await pushPendingChanges();
    } else {
      await SyncService.pushChanges("customers", customer);
    }
  } catch (err) {
    console.error("Failed to sync customer to DB:", err);
  }
}

interface CustomerState {
  customers: CustomerProfile[];
  /** Register someone by hand, from قاعدة العملاء. Returns the new id. */
  addCustomer: (
    customer: Omit<
      CustomerProfile,
      "id" | "deleted_at"
    >,
  ) => string;
  /** Correct a customer's details. Reference write — no ledger event. */
  updateCustomer: (id: string, updates: Partial<CustomerProfile>) => void;
  /** Hard delete. Only legal when the customer has NO history — see
   *  `customerRemovalMode`; the screen asks the ledger before calling this. */
  removeCustomer: (id: string) => void;
  /** Tombstone, for a customer who DOES have history. */
  archiveCustomer: (id: string) => void;
  /** Undo an archive. `null`, never `undefined`, so the field stays present. */
  restoreCustomer: (id: string) => void;
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
  upsertCustomerFromOrder: (order: EcommerceOrder) => string;
}

export const useCustomerStore = create<CustomerState>()(
  persist(
    (set, get) => ({
      customers: [],

      addCustomer: (customer) => {
        const id = crypto.randomUUID();
        const newCustomer: CustomerProfile = {
          id,
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          deleted_at: null,
        };
        
        syncCustomerToDb(newCustomer).catch(console.error);

        set((state) => ({
          customers: [...state.customers, newCustomer],
        }));
        return id;
      },

      updateCustomer: (id, updates) => {
        set((state) => {
          const newCustomers = state.customers.map((customer) =>
            customer.id === id ? { ...customer, ...updates } : customer,
          );
          const updated = newCustomers.find((c) => c.id === id);
          if (updated) {
            syncCustomerToDb(updated).catch(console.error);
          }
          return { customers: newCustomers };
        });
      },

      removeCustomer: (id) => {
        set((state) => ({
          customers: state.customers.filter((customer) => customer.id !== id),
        }));
      },

      // Archiving is reference data, exactly like a partner's or a product's:
      // a tombstone, no ledger event, and every past order and `customer_ltv`
      // line keeps pointing at this id and still renders their name.
      archiveCustomer: (id) => {
        set((state) => {
          const newCustomers = state.customers.map((customer) =>
            customer.id === id ? { ...customer, deleted_at: new Date().toISOString() } : customer,
          );
          const updated = newCustomers.find((c) => c.id === id);
          if (updated) {
            syncCustomerToDb(updated).catch(console.error);
          }
          return { customers: newCustomers };
        });
      },

      restoreCustomer: (id) => {
        set((state) => {
          const newCustomers = state.customers.map((customer) =>
            // `null`, never `undefined`: the field stays present so a synced
            // row cannot read as "this device never knew about the tombstone".
            customer.id === id ? { ...customer, deleted_at: null } : customer,
          );
          const updated = newCustomers.find((c) => c.id === id);
          if (updated) {
            syncCustomerToDb(updated).catch(console.error);
          }
          return { customers: newCustomers };
        });
      },

      upsertCustomerFromOrder: (order) => {
        // Who this order belongs to — `@/lib/customers` owns the decision, so
        // the §1.3 scenario can be tested without a browser.
        const existing0 = upsertTarget(get().customers, order);
        const resolvedId = existing0?.id ?? crypto.randomUUID();

        set((state) => {
          const existing = existing0;
          if (!existing) {
            const newCustomer: CustomerProfile = {
              id: resolvedId,
              name: order.customerName,
              phone: order.customerPhone,
              address: order.address,
              deleted_at: null,
            };
            
            syncCustomerToDb(newCustomer).catch(console.error);
            
            return {
              customers: [
                newCustomer,
                ...state.customers,
              ],
            };
          }

          // An order updates this customer's ACTIVITY and nothing about who
          // they are. It used to spread the order's name / phone / address
          // over the record, so re-ordering silently renamed a customer whose
          // spelling the owner had just corrected in قاعدة العملاء — an edit
          // undone by the next order. Identity is hers to set on that screen;
          // the order only reports what was bought and when.
          return state;
        });

        return resolvedId;
      },
    }),
    { name: "customer-storage" },
  ),
);
