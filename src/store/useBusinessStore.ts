import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Partner,
  BusinessMode,
  Product,
  Transaction,
  WholesaleClient,
  WholesaleInvoice,
  Supplier,
  PurchaseInvoice,
  ReturnRecord,
  PromoDiscount,
  SyncAction,
} from "../types";
import type { ProfitDistribution } from "../services/financeService";
import { writeThrough, deleteThrough } from "../services/cloudData";
import { applyMovesToProducts, expandBundleMoves, type StockMove } from "../lib/stockMirror";

/**
 * Write one reference record to Supabase, then commit WHAT SUPABASE STORED.
 *
 * The order is the whole point. The previous helper updated local state first
 * and pushed in the background; when the push failed it re-read the table to
 * undo itself, which is how a product could appear, survive a click or two, and
 * then silently vanish. Nothing is committed here until the database has
 * confirmed the row, so a failed write leaves the screen exactly as it was and
 * the user sees an error instead of a disappearing act.
 *
 * Throws on failure. Callers await it and let the error reach the form.
 */
async function commitRow<T extends { id: string }>(
  set: (fn: (state: any) => any) => void,
  table: string,
  field: string,
  row: T,
  place: "append" | "prepend" = "append",
): Promise<T> {
  const saved = (await writeThrough(table, row)) as T;
  set((state: any) => {
    const list: T[] = state[field] ?? [];
    const at = list.findIndex((r) => r.id === saved.id);
    if (at >= 0) {
      const next = list.slice();
      next[at] = { ...list[at], ...saved };
      return { [field]: next };
    }
    return { [field]: place === "prepend" ? [saved, ...list] : [...list, saved] };
  });
  return saved;
}

/** Delete one row, then drop it locally. Throws on failure, dropping nothing. */
async function removeRow(
  set: (fn: (state: any) => any) => void,
  table: string,
  field: string,
  id: string,
): Promise<void> {
  await deleteThrough(table, id);
  set((state: any) => ({ [field]: (state[field] ?? []).filter((r: any) => r.id !== id) }));
}

/**
 * Fire-and-forget push for the legacy `quantity` mirror on the product record.
 *
 * ponytail: deliberately NOT awaited, and deliberately not rolled back. This
 * column is documented as never read for stock — every screen reads
 * `qtyOf(product.id)` from the ledger, which is the awaited authority. Losing a
 * mirror write costs nothing a reload does not fix. If the column ever becomes
 * load-bearing, route it through `commitRow` like everything else.
 */
function mirrorRow(table: string, row: any): void {
  void writeThrough(table, row).catch(() => {
    /* announced by writeThrough; the ledger already holds the real number */
  });
}

/**
 * Global State Manager for the Intelligent Core
 * This store serves as the central hub for business operations and settings
 */
interface BusinessState {
  // Sync
  syncQueue: SyncAction[];
  flushSyncQueue: () => Promise<void>;

  // Business configuration
  businessMode: BusinessMode;
  partnershipEnabled: boolean;

  // Partner management
  partners: Partner[];

  // Product management
  products: Product[];

  // Transaction management
  transactions: Transaction[];

  // Partner ledger for profit distribution tracking
  partnerLedger: ProfitDistribution[];

  // Wholesale management
  wholesaleClients: WholesaleClient[];
  wholesaleInvoices: WholesaleInvoice[];

  // Purchasing & Suppliers management
  suppliers: Supplier[];
  purchaseInvoices: PurchaseInvoice[];

  // Returns & Exchanges
  returnRecords: ReturnRecord[];

  // Discounts
  promoDiscounts: PromoDiscount[];

  // Actions
  setBusinessMode: (mode: BusinessMode) => void;
  togglePartnership: (enabled: boolean) => void;
  addPartner: (partner: Omit<Partner, "id">) => void;
  updatePartner: (id: string, updates: Partial<Partner>) => void;
  /** Hard delete. Only legal for a part-owner with NO ledger history. */
  removePartner: (id: string) => void;
  /** Soft-hide (tombstone). What a part-owner WITH history gets. */
  archivePartner: (id: string) => void;
  /** Clears the tombstone — they hold a claim again. */
  restorePartner: (id: string) => void;
  updatePartnerEquity: (id: string, equityPercentage: number) => void;
  addCapitalContribution: (partnerId: string, amount: number) => void;
  // Returns the created product so the caller can append an opening-balance
  // event against its id. The id is generated here, so without this a caller
  // could not name the product it just created.
  // `quantity` is NOT accepted: stock is the ledger's SUM (§1.1), and the field
  // still on the record is dead weight read by nothing that shows stock. The
  // importer passing it there is exactly how imported shops opened at zero —
  // the signature now makes that unsayable. Opening stock goes through
  // `appendOpeningBalance`.
  addProduct: (product: Omit<Product, "id" | "quantity">) => Promise<Product>;
  updateProduct: (id: string, updates: Partial<Product>) => Promise<void>;
  /**
   * The ONE way stock moves on the product record.
   *
   * Every transaction — a POS sale, a توريد, a مرتجع, an online order and
   * every state it passes through — routes its lines through here. See
   * `applyStockMoves` below for why a per-screen loop is not allowed to do
   * this itself.
   */
  applyStockMoves: (moves: StockMove[]) => void;
  /** Hard delete. Only legal for a product with NO ledger history. */
  removeProduct: (id: string) => Promise<void>;
  /** Soft-hide (tombstone). What a product WITH ledger history gets. */
  archiveProduct: (id: string) => Promise<void>;
  /** Clears the tombstone — the product comes back to the active lists. */
  restoreProduct: (id: string) => Promise<void>;
  addTransaction: (transaction: Transaction) => void;
  addProfitDistribution: (distribution: ProfitDistribution) => void;
  getPartnerLedger: () => ProfitDistribution[];
  // All four write to Supabase and resolve only once it confirms — see
  // migration 016. They were synchronous local writes until Phase 6.
  addWholesaleClient: (
    client: Omit<WholesaleClient, "id" | "createdAt" | "updatedAt">,
  ) => Promise<WholesaleClient>;
  updateWholesaleClient: (id: string, updates: Partial<WholesaleClient>) => Promise<void>;
  addWholesaleInvoice: (
    invoice: Omit<WholesaleInvoice, "id" | "createdAt" | "updatedAt">,
  ) => Promise<WholesaleInvoice>;
  recordWholesalePayment: (invoiceId: string, amount: number) => Promise<void>;
  /** Soft-hide (tombstone). What a client WITH invoice history gets. */
  archiveWholesaleClient: (id: string) => Promise<void>;
  // Returns the created supplier so a caller that registered one inline (the
  // quick توريد dialog) can attach the receipt to it straight away.
  addSupplier: (supplier: Omit<Supplier, "id" | "createdAt" | "updatedAt">) => Promise<Supplier>;
  updateSupplier: (id: string, updates: Partial<Supplier>) => Promise<void>;
  addPurchaseInvoice: (invoice: Omit<PurchaseInvoice, "id" | "createdAt" | "updatedAt">) => Promise<PurchaseInvoice>;
  recordSupplierPayment: (invoiceId: string, amount: number) => Promise<void>;

  // Returns & Exchanges actions
  // The field is `created_at`, not `createdAt` — the old signature omitted a
  // key that does not exist, so callers were asked for one the store fills in.
  addReturnRecord: (record: Omit<ReturnRecord, "id" | "created_at">) => Promise<void>;

  // Discounts
  addPromoDiscount: (discount: Omit<PromoDiscount, "id" | "createdAt">) => Promise<void>;
  updatePromoDiscount: (id: string, updates: Partial<PromoDiscount>) => Promise<void>;
  removePromoDiscount: (id: string) => Promise<void>;

  // TODO: Analytics Engine integration point
}

export const useBusinessStore = create<BusinessState>()(
  persist(
    (set, get) => ({
      // Initial state
      syncQueue: [],
      // Kept as a no-op so the field's few remaining readers do not have to be
      // special-cased. Nothing can be queued: every write is awaited.
      flushSyncQueue: async () => {},
      businessMode: "retail",
      partnershipEnabled: false,
      partners: [],
      products: [],
      transactions: [],
      partnerLedger: [],
      wholesaleClients: [],
      wholesaleInvoices: [],
      suppliers: [],
      purchaseInvoices: [],
      returnRecords: [],
      promoDiscounts: [],

      // Business mode actions
      setBusinessMode: (mode: BusinessMode) => {
        set({ businessMode: mode });
        // TODO: Analytics Engine - trigger mode change analytics
      },

      // Partnership toggle action
      togglePartnership: (enabled: boolean) => {
        set({ partnershipEnabled: enabled });
        // TODO: Analytics Engine - track partnership toggle events
      },

      // Partner management actions
      addCapitalContribution: (partnerId: string, amount: number) => {
        set((state) => ({
          partners: state.partners.map((p) =>
            p.id === partnerId
              ? { ...p, capitalContribution: (p.capitalContribution || 0) + amount }
              : p,
          ),
        }));
      },
      addPartner: (partnerData) => {
        const newPartner: Partner = {
          ...partnerData,
          id: crypto.randomUUID(),
        };
        set((state) => ({
          partners: [...state.partners, newPartner],
        }));
        // TODO: Analytics Engine - log partner addition
      },

      updatePartner: (id: string, updates: Partial<Partner>) => {
        set((state) => ({
          partners: state.partners.map((partner) =>
            partner.id === id ? { ...partner, ...updates } : partner,
          ),
        }));
        // TODO: Analytics Engine - log partner updates
      },

      removePartner: (id: string) => {
        set((state) => ({
          partners: state.partners.filter((partner) => partner.id !== id),
        }));
        // TODO: Analytics Engine - log partner removal
      },

      // A part-owner the ledger already knows about keeps their record — past
      // reports must still resolve their name — but stops being an active
      // claim: out of the 100% cap, out of رأس المال, out of every future
      // distribution. `updatePartner` stamps the change for LWW.
      archivePartner: (id: string) => {
        get().updatePartner(id, { deleted_at: Date.now(), status: "inactive" });
      },

      // `null`, never `undefined` — an undefined key drops out of a sync
      // payload and the next pull would re-archive them.
      restorePartner: (id: string) => {
        get().updatePartner(id, { deleted_at: null, status: "active" });
      },

      updatePartnerEquity: (id: string, equityPercentage: number) => {
        // Validate equity percentage (0-100)
        if (equityPercentage < 0 || equityPercentage > 100) {
          throw new Error("Equity percentage must be between 0 and 100");
        }

        set((state) => ({
          partners: state.partners.map((partner) =>
            partner.id === id ? { ...partner, equityPercentage } : partner,
          ),
        }));
        // TODO: Analytics Engine - log equity changes and recalculate profit distributions
      },

      // Product management actions
      addProduct: async (productData) => {
        const draft: Product = {
          ...productData,
          id: crypto.randomUUID(),
          // Placeholder for the legacy column only. Never read for stock —
          // every screen reads `qtyOf(product.id)` from the ledger.
          quantity: 0,
          updated_at: Date.now(),
        };
        // Nothing is added to `products` until Supabase has the row. If this
        // throws, the caller's form stays open with the values still in it.
        return commitRow(set, 'products', 'products', draft);
      },

      updateProduct: async (id: string, updates: Partial<Product>) => {
        const current = get().products.find((p) => p.id === id);
        if (!current) return;
        // The FULL row, not the patch: an upsert of `{id, status}` alone would
        // blank every other column.
        await commitRow(set, 'products', 'products', {
          ...current,
          ...updates,
          updated_at: Date.now(),
        });
      },

      /**
       * The ONE way stock moves on the product record.
       *
       * The arithmetic — the variant branch, the plain branch, the floor at
       * zero and why they must share a function — lives in `lib/stockMirror`,
       * which is pure and has a self-check beside it. This is the store half:
       * one `set` and one sync push per affected product, no matter how many
       * lines the transaction had.
       *
       * Bundles are expanded HERE rather than in each selling screen. A بوكس
       * has no shelf of its own, so a move naming one has to become its
       * components before the mirror sees it — and doing that at the single
       * choke point is what stops the next screen from forgetting, the way POS
       * did while الطلبات remembered.
       */
      applyStockMoves: (rawMoves: StockMove[]) => {
        if (rawMoves.length === 0) return;

        let touched: string[] = [];
        set((state) => {
          const moves = expandBundleMoves(rawMoves, state.products);
          const result = applyMovesToProducts(state.products, moves);
          touched = result.touched;
          if (touched.length === 0) return state;
          return { products: result.products };
        });

        // Sync AFTER the write, reading the stored row, so what goes out is
        // what the shop now believes rather than what the caller asked for.
        const products = get().products;
        for (const id of touched) {
          const product = products.find((p) => p.id === id);
          if (!product) continue;
          mirrorRow('products', product);
        }
      },

      // A real delete, allowed ONLY for a product the ledger has never
      // mentioned — see `removalMode` in `@/lib/product`. It now tells sync,
      // which it never did: the row used to vanish locally and come straight
      // back on the next pull from another device.
      removeProduct: async (id: string) => {
        // Deleted in the cloud FIRST. Removing it locally and discovering the
        // delete was refused would show the product coming back on the next
        // reload, which reads as data loss in the other direction.
        await removeRow(set, 'products', 'products', id);
      },

      // What a product WITH ledger history gets instead. The record stays so
      // its events keep resolving; `deleted_at` is the tombstone that takes it
      // out of the active lists and syncs that fact to every device.
      archiveProduct: async (id: string) => {
        await get().updateProduct(id, { deleted_at: Date.now() });
      },

      // Undo. `null`, never `undefined` — see the field's note in `types`.
      restoreProduct: async (id: string) => {
        await get().updateProduct(id, { deleted_at: null });
      },

      // Transaction management actions
      addTransaction: (transaction) => {
        const newTransaction = { ...transaction, updated_at: Date.now() };
        set((state) => ({
          transactions: [...state.transactions, newTransaction],
        }));
        mirrorRow('transactions', newTransaction);
        // TODO: Analytics Engine - log transaction for sales analytics
      },


      // Partner ledger actions
      addProfitDistribution: (distribution) => {
        set((state) => ({
          partnerLedger: [...state.partnerLedger, distribution],
        }));
        // TODO: Analytics Engine - log profit distribution for financial analytics
      },

      getPartnerLedger: () => {
        return get().partnerLedger;
      },

      // ── Wholesale ────────────────────────────────────────────────────────
      //
      // Cloud rows since migration 016. All four used to be synchronous
      // `set()` calls into a persisted slice, so a wholesale client added on
      // the till did not exist in the office — and since an invoice cannot be
      // raised without one, شاشة الجملة was unusable on any browser that had
      // not typed them in by hand. The money was never wrong (it is the
      // ledger's), but the documents were on exactly one machine.
      addWholesaleClient: async (clientData) => {
        return commitRow(set, "wholesale_clients", "wholesaleClients", {
          ...clientData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          updated_at: Date.now(),
        } as WholesaleClient);
      },

      updateWholesaleClient: async (id, updates) => {
        const current = get().wholesaleClients.find((c) => c.id === id);
        if (!current) return;
        await commitRow(set, "wholesale_clients", "wholesaleClients", {
          ...current,
          ...updates,
          id,
          updatedAt: new Date(),
          updated_at: Date.now(),
        } as WholesaleClient);
      },

      // Records the invoice DOCUMENT only. Stock is NOT touched here — the
      // `sale` event the caller appends moves it — and neither are the client
      // totals: debt is SUM(receivable_client) over the ledger, invoiced and
      // paid are summed from these invoice documents on render.
      addWholesaleInvoice: async (invoiceData) => {
        return commitRow(set, "wholesale_invoices", "wholesaleInvoices", {
          ...invoiceData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          updated_at: Date.now(),
        } as WholesaleInvoice);
      },

      // Updates the invoice document only — how much of THIS invoice is still
      // open. The money moved on the `client_payment` event the caller
      // appends: wallet up, receivable_client down.
      recordWholesalePayment: async (invoiceId, amount) => {
        const invoice = get().wholesaleInvoices.find((i) => i.id === invoiceId);
        if (!invoice) return;
        const paidAmount = invoice.paidAmount + amount;
        const remainingAmount = Math.max(0, invoice.remainingAmount - amount);
        await commitRow(set, "wholesale_invoices", "wholesaleInvoices", {
          ...invoice,
          paidAmount,
          remainingAmount,
          status: remainingAmount <= 0 ? "paid" : "partial",
          updatedAt: new Date(),
          updated_at: Date.now(),
        } as WholesaleInvoice);
      },

      /** Soft-hide. A document with ledger history is never hard-deleted. */
      archiveWholesaleClient: async (id) => {
        const current = get().wholesaleClients.find((c) => c.id === id);
        if (!current) return;
        await writeThrough("wholesale_clients", {
          ...current,
          deleted_at: new Date().toISOString(),
          updated_at: Date.now(),
        });
        set((state: any) => ({
          wholesaleClients: state.wholesaleClients.filter((c: any) => c.id !== id),
        }));
      },

      // Purchasing & Suppliers actions
      addSupplier: async (supplierData) => {
        const newSupplier: Supplier = {
          ...supplierData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          // Epoch-ms sync clock. Separate from `updatedAt` above on purpose:
          // that one is a Date for humans, this one is what the inbound pull
          // filters and compares on.
          updated_at: Date.now(),
        };
        return commitRow(set, 'suppliers', 'suppliers', newSupplier);
      },

      updateSupplier: async (id, updates) => {
        const current = get().suppliers.find((s: any) => s.id === id);
        if (!current) return;
        await commitRow(set, 'suppliers', 'suppliers', {
          ...current,
          ...updates,
          updatedAt: new Date(),
          updated_at: Date.now(),
        });
      },

      // Records the invoice document only. Stock is NOT touched here: the
      // `purchase` ledger event the caller appends is what moves it, and a
      // second `p.quantity + item.quantity` here would double-count the
      // receipt against a number that is already a SUM over the ledger.
      //
      // Supplier totals are not touched either. Debt is SUM(payable_supplier)
      // over the ledger; "purchased" and "paid" are summed from these invoice
      // documents on render. A supplier row carries no running total to drift.
      addPurchaseInvoice: async (invoiceData) => {
        // Now a cloud row, not a localStorage-only document. Every quick توريد
        // used to write this invoice to `persist` and nowhere else, so the
        // receipt existed on exactly one browser: it never showed in the
        // supplier's account on another device, and a cache clear erased it
        // while the ledger event it described survived. That mismatch is the
        // drift this codebase deletes everywhere else.
        return commitRow(set, 'purchase_invoices', 'purchaseInvoices', {
          ...invoiceData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          updated_at: Date.now(),
        } as PurchaseInvoice);
      },

      // Updates the invoice document only — how much of THIS invoice is still
      // open. The money moved by the `supplier_payment` event the caller
      // appends: wallet down, payable_supplier down.
      recordSupplierPayment: async (invoiceId, amount) => {
        const invoice = get().purchaseInvoices.find((i) => i.id === invoiceId);
        if (!invoice) return;

        const newRemaining = Math.max(0, invoice.remainingAmount - amount);
        await commitRow(set, 'purchase_invoices', 'purchaseInvoices', {
          ...invoice,
          paidAmount: invoice.paidAmount + amount,
          remainingAmount: newRemaining,
          status: newRemaining <= 0 ? "paid" : "partial",
          updatedAt: new Date(),
          updated_at: Date.now(),
        });
      },

      // ── E-commerce Manual Orders ───────────────────────────




      // ── Returns & Exchanges ─────────────────────────────────

      addReturnRecord: async (recordData) => {
        const newRecord: ReturnRecord = {
          ...recordData,
          id: crypto.randomUUID(),
          created_at: new Date(),
          updated_at: Date.now(),
        };
        await commitRow(set, 'return_records', 'returnRecords', newRecord, "prepend");
      },

      addPromoDiscount: async (discount) => {
        const newDiscount: PromoDiscount = {
          ...discount,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updated_at: Date.now(),
        };
        await commitRow(set, 'discount_codes', 'promoDiscounts', newDiscount, "prepend");
      },
      updatePromoDiscount: async (id, updates) => {
        const current = get().promoDiscounts.find((d: any) => d.id === id);
        if (!current) return;
        await commitRow(set, 'discount_codes', 'promoDiscounts', {
          ...current,
          ...updates,
          updated_at: Date.now(),
        });
      },
      removePromoDiscount: async (id) => {
        // DELETE, not a soft-hide: nothing in the ledger references a promo
        // code by id, so removing it cannot orphan history.
        await removeRow(set, 'discount_codes', 'promoDiscounts', id);
      },
    }),
    {
      name: "business-storage",
      /**
       * ONLINE-ONLY for reference data.
       *
       * `products`, `suppliers`, `promoDiscounts` and `returnRecords` are owned
       * by Supabase now and hydrated from it on boot, so persisting them would
       * only recreate the stale-cache problem this rewrite removes: a device
       * showing 131 products that no longer exist.
       *
       * `purchaseInvoices` and `transactions` joined them: both now have
       * tables and both are hydrated on boot, so keeping a local copy would
       * recreate exactly the stale-cache problem this rewrite removes.
       *
       * What IS still persisted is the data with NO cloud table — partners,
       * wholesale, capital. Dropping those would delete them outright, since
       * there is nowhere to re-read them from.
       */
      partialize: (state: any) => ({
        businessMode: state.businessMode,
        partnershipEnabled: state.partnershipEnabled,
        partners: state.partners,
        partnerLedger: state.partnerLedger,
        // wholesaleClients / wholesaleInvoices are NOT persisted any more.
        // Both are cloud tables now (migration 016) and are hydrated on boot,
        // so a local copy would be exactly the stale cache this contract
        // exists to prevent — and it is what made these documents device-local
        // in the first place.
        capitalContributions: state.capitalContributions,
      }),
    },
  ),
);
