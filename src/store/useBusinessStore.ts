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
import { SyncService } from "../services/api/SyncService";
import { pushPendingChanges } from "../services/ledgerSyncEngine";

async function pushOrQueue(
  getSyncQueue: () => SyncAction[],
  setSyncQueue: (queue: SyncAction[]) => void,
  table: string,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  payload: any
) {
  const syncAction: SyncAction = {
    id: crypto.randomUUID(),
    table,
    action,
    payload,
    timestamp: Date.now()
  };

  if (navigator.onLine) {
    try {
      await SyncService.pushChanges(table, payload);
      pushPendingChanges().catch(console.error);
    } catch (e) {
      setSyncQueue([...getSyncQueue(), syncAction]);
    }
  } else {
    setSyncQueue([...getSyncQueue(), syncAction]);
  }
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
  addProduct: (product: Omit<Product, "id" | "quantity">) => Product;
  updateProduct: (id: string, updates: Partial<Product>) => void;
  /** Hard delete. Only legal for a product with NO ledger history. */
  removeProduct: (id: string) => void;
  /** Soft-hide (tombstone). What a product WITH ledger history gets. */
  archiveProduct: (id: string) => void;
  /** Clears the tombstone — the product comes back to the active lists. */
  restoreProduct: (id: string) => void;
  addTransaction: (transaction: Transaction) => void;
  addProfitDistribution: (distribution: ProfitDistribution) => void;
  getPartnerLedger: () => ProfitDistribution[];
  addWholesaleClient: (client: Omit<WholesaleClient, "id" | "createdAt" | "updatedAt">) => void;
  updateWholesaleClient: (id: string, updates: Partial<WholesaleClient>) => void;
  addWholesaleInvoice: (invoice: Omit<WholesaleInvoice, "id" | "createdAt" | "updatedAt">) => void;
  recordWholesalePayment: (invoiceId: string, amount: number) => void;
  // Returns the created supplier so a caller that registered one inline (the
  // quick توريد dialog) can attach the receipt to it straight away.
  addSupplier: (supplier: Omit<Supplier, "id" | "createdAt" | "updatedAt">) => Supplier;
  updateSupplier: (id: string, updates: Partial<Supplier>) => void;
  addPurchaseInvoice: (invoice: Omit<PurchaseInvoice, "id" | "createdAt" | "updatedAt">) => void;
  recordSupplierPayment: (invoiceId: string, amount: number) => void;

  // Returns & Exchanges actions
  // The field is `created_at`, not `createdAt` — the old signature omitted a
  // key that does not exist, so callers were asked for one the store fills in.
  addReturnRecord: (record: Omit<ReturnRecord, "id" | "created_at">) => void;

  // Discounts
  addPromoDiscount: (discount: Omit<PromoDiscount, "id" | "createdAt">) => void;
  updatePromoDiscount: (id: string, updates: Partial<PromoDiscount>) => void;
  removePromoDiscount: (id: string) => void;

  // TODO: Analytics Engine integration point
}

export const useBusinessStore = create<BusinessState>()(
  persist(
    (set, get) => ({
      // Initial state
      syncQueue: [],
      flushSyncQueue: async () => {
        const queue = get().syncQueue;
        if (queue.length > 0) {
          await SyncService.processSyncQueue(queue);
          set({ syncQueue: [] });
        }
      },
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
      addProduct: (productData) => {
        const newProduct: Product = {
          ...productData,
          id: crypto.randomUUID(),
          // Placeholder for the legacy column only. Never read for stock —
          // every screen reads `qtyOf(product.id)` from the ledger.
          quantity: 0,
          updated_at: Date.now(),
        };
        set((state) => ({
          products: [...state.products, newProduct],
        }));
        pushOrQueue(
          () => get().syncQueue,
          (queue) => set({ syncQueue: queue }),
          'products',
          'INSERT',
          newProduct
        );
        // TODO: Analytics Engine - log product addition
        return newProduct;
      },

      updateProduct: (id: string, updates: Partial<Product>) => {
        const updatedProduct = { ...updates, updated_at: Date.now() };
        set((state) => ({
          products: state.products.map((product) =>
            product.id === id ? { ...product, ...updatedProduct } : product,
          ),
        }));
        const product = get().products.find(p => p.id === id);
        if (product) {
          pushOrQueue(
            () => get().syncQueue,
            (queue) => set({ syncQueue: queue }),
            'products',
            'UPDATE',
            product
          );
        }
        // TODO: Analytics Engine - log product updates
      },

      // A real delete, allowed ONLY for a product the ledger has never
      // mentioned — see `removalMode` in `@/lib/product`. It now tells sync,
      // which it never did: the row used to vanish locally and come straight
      // back on the next pull from another device.
      removeProduct: (id: string) => {
        const product = get().products.find((p) => p.id === id);
        set((state) => ({
          products: state.products.filter((product) => product.id !== id),
        }));
        if (product) {
          pushOrQueue(
            () => get().syncQueue,
            (queue) => set({ syncQueue: queue }),
            'products',
            'DELETE',
            product
          );
        }
        // TODO: Analytics Engine - log product removal
      },

      // What a product WITH ledger history gets instead. The record stays so
      // its events keep resolving; `deleted_at` is the tombstone that takes it
      // out of the active lists and syncs that fact to every device.
      archiveProduct: (id: string) => {
        get().updateProduct(id, { deleted_at: Date.now() });
      },

      // Undo. `null`, never `undefined` — see the field's note in `types`.
      restoreProduct: (id: string) => {
        get().updateProduct(id, { deleted_at: null });
      },

      // Transaction management actions
      addTransaction: (transaction) => {
        const newTransaction = { ...transaction, updated_at: Date.now() };
        set((state) => ({
          transactions: [...state.transactions, newTransaction],
        }));
        pushOrQueue(
          () => get().syncQueue,
          (queue) => set({ syncQueue: queue }),
          'transactions',
          'INSERT',
          newTransaction
        );
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

      // Wholesale management actions
      addWholesaleClient: (clientData) => {
        const newClient: WholesaleClient = {
          ...clientData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        set((state) => ({
          wholesaleClients: [...state.wholesaleClients, newClient],
        }));
      },

      updateWholesaleClient: (id, updates) => {
        set((state) => ({
          wholesaleClients: state.wholesaleClients.map((c) =>
            c.id === id ? { ...c, ...updates, updatedAt: new Date() } : c,
          ),
        }));
      },

      // Records the invoice document only. Stock is NOT touched here — the
      // `sale` event the caller appends moves it — and neither are the client
      // totals: debt is SUM(receivable_client) over the ledger, invoiced and
      // paid are summed from these invoice documents on render.
      addWholesaleInvoice: (invoiceData) => {
        const invoice: WholesaleInvoice = {
          ...invoiceData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        set((state) => ({
          wholesaleInvoices: [...state.wholesaleInvoices, invoice],
        }));
      },

      // Updates the invoice document only — how much of THIS invoice is still
      // open. The money moved by the `client_payment` event the caller
      // appends: wallet up, receivable_client down.
      recordWholesalePayment: (invoiceId, amount) => {
        set((state) => {
          const invoice = state.wholesaleInvoices.find((i) => i.id === invoiceId);
          if (!invoice) return state;
          const newPaid = invoice.paidAmount + amount;
          const newRemaining = Math.max(0, invoice.remainingAmount - amount);
          const newStatus: "paid" | "partial" | "unpaid" | "overdue" =
            newRemaining <= 0 ? "paid" : "partial";
          return {
            wholesaleInvoices: state.wholesaleInvoices.map((i) =>
              i.id === invoiceId
                ? {
                    ...i,
                    paidAmount: newPaid,
                    remainingAmount: newRemaining,
                    status: newStatus,
                    updatedAt: new Date(),
                  }
                : i,
            ),
          };
        });
      },

      // Purchasing & Suppliers actions
      addSupplier: (supplierData) => {
        const newSupplier: Supplier = {
          ...supplierData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        set((state) => ({
          suppliers: [...state.suppliers, newSupplier],
        }));
        return newSupplier;
      },

      updateSupplier: (id, updates) => {
        set((state) => ({
          suppliers: state.suppliers.map((s) =>
            s.id === id ? { ...s, ...updates, updatedAt: new Date() } : s,
          ),
        }));
      },

      // Records the invoice document only. Stock is NOT touched here: the
      // `purchase` ledger event the caller appends is what moves it, and a
      // second `p.quantity + item.quantity` here would double-count the
      // receipt against a number that is already a SUM over the ledger.
      //
      // Supplier totals are not touched either. Debt is SUM(payable_supplier)
      // over the ledger; "purchased" and "paid" are summed from these invoice
      // documents on render. A supplier row carries no running total to drift.
      addPurchaseInvoice: (invoiceData) => {
        const invoice: PurchaseInvoice = {
          ...invoiceData,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        set((state) => ({
          purchaseInvoices: [...state.purchaseInvoices, invoice],
        }));
      },

      // Updates the invoice document only — how much of THIS invoice is still
      // open. The money moved by the `supplier_payment` event the caller
      // appends: wallet down, payable_supplier down.
      recordSupplierPayment: (invoiceId, amount) => {
        set((state) => {
          const invoice = state.purchaseInvoices.find((i) => i.id === invoiceId);
          if (!invoice) return state;
          const newPaid = invoice.paidAmount + amount;
          const newRemaining = Math.max(0, invoice.remainingAmount - amount);
          const newStatus: "paid" | "partial" | "unpaid" | "overdue" =
            newRemaining <= 0 ? "paid" : "partial";
          return {
            purchaseInvoices: state.purchaseInvoices.map((i) =>
              i.id === invoiceId
                ? {
                    ...i,
                    paidAmount: newPaid,
                    remainingAmount: newRemaining,
                    status: newStatus,
                    updatedAt: new Date(),
                  }
                : i,
            ),
          };
        });
      },

      // ── E-commerce Manual Orders ───────────────────────────




      // ── Returns & Exchanges ─────────────────────────────────

      addReturnRecord: (recordData) => {
        const newRecord: ReturnRecord = {
          ...recordData,
          id: crypto.randomUUID(),
          created_at: new Date(),
        };
        set((state) => ({
          returnRecords: [newRecord, ...state.returnRecords],
        }));
      },

      addPromoDiscount: (discount) => {
        const newDiscount: PromoDiscount = {
          ...discount,
          id: crypto.randomUUID(),
          createdAt: new Date(),
        };
        set((state) => ({
          promoDiscounts: [newDiscount, ...state.promoDiscounts],
        }));
      },
      updatePromoDiscount: (id, updates) => {
        set((state) => ({
          promoDiscounts: state.promoDiscounts.map((d) => (d.id === id ? { ...d, ...updates } : d)),
        }));
      },
      removePromoDiscount: (id) => {
        set((state) => ({
          promoDiscounts: state.promoDiscounts.filter((d) => d.id !== id),
        }));
      },
    }),
    {
      name: "business-storage",
    },
  ),
);
