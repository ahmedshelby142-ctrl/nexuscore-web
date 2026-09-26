// Reconstructed types
//
// ⚠ KNOWN DEBT: most of the TYPE aliases below are `any`. That is not a style
// choice — this file was rebuilt after a loss (see recover_types.py in the
// repo root) and the real interfaces were never restored. The practical effect
// is that TypeScript cannot catch a whole class of bug in this codebase: an
// un-awaited Promise used as an object type-checks cleanly, which is exactly
// how the Quick Supply receipt shipped filing itself against `undefined`.
//
// P1-6 (2026-09-26): 66 → 45. Replaced from the LIVE schema or an existing
// canonical type — never invented: the ten ledger types (they shadowed
// `lib/ledger/types`), the order status union, orders and their lines,
// wholesale invoices/lines/clients, return records, purchase invoices,
// suppliers, discount codes, customers. The 45 left, deliberately:
//
//   * `Product` — typing it makes the shared search/filter helpers
//     (`SearchableProduct`) generic across every product screen: a refactor,
//     not a correctness fix (81 errors, all structural). The bug class it
//     would catch — reading `product.price` / `product.cost`, which do not
//     exist — is pinned by `check_p1_closure.mjs` instead.
//   * Integration boundaries for features with no live backend: OnlineOrder*,
//     Paymob*, Shipping*, IntegrationAdapter — external payloads.
//   * Dead code or dead concepts: License* (lib/api/*.server.ts, audit F-8),
//     BusinessProfile/Persona/GatedFeature (F-5), SessionRecord/UserRecord/
//     PublicSession (the disabled legacy auth), SyncAction (the removed queue),
//     Transaction / EcommerceRevenueLedgerEntry / StockLog / Audit* (legacy
//     stores superseded by the ledger).
//   * Local document stores the ledger supersedes for money: Wallet*,
//     Partner*, Expense*/Payroll/FixedAsset/BudgetCap, Branch*, Backup*.
//   * CourierAccount / CourierReceivable — their store carries uncommitted
//     courier work that this phase must not touch.
//
// The CONSTANT MAPS below are a different matter and are now filled in. They
// are read at RUNTIME — an empty `{}` is not a missing type, it is a dropdown
// that renders no options and a lookup that returns `undefined`. Every value
// here was recovered from the call sites and tests that consume it, not
// invented.

import { ROLE_LABELS } from "@/lib/roles";

// The ledger's own types. These names used to be re-declared here as `any`,
// shadowing the real definitions in `lib/ledger/types.ts` — so anything that
// imported them from "@/types" silently lost every check. One definition now.
export type {
  Account,
  Balance,
  BalanceQuery,
  EventKind,
  EventQuery,
  Identity,
  LedgerEvent,
  NewEvent,
  NewLine,
  SyncStatus,
} from "@/lib/ledger/types";
import type { WholesaleInvoiceLine } from "@/lib/ledger/wholesale";
import type { ReturnCause } from "@/lib/shippingRates";
import type { DiscountKind } from "@/lib/math";

export type AuditAction = any;
export type AuditEntry = any;
export const BUSINESS_PROFILE_DESCRIPTIONS: Record<string, string> = {
  omnichannel: "نقطة بيع في المحل وطلبات أونلاين على نفس المخزون",
  retail_only: "نقطة بيع وجرد ومشتريات، من غير شاشات الأونلاين",
  ecommerce_only: "طلبات وشحن ومرتجعات، من غير نقطة بيع",
};
// The three cards on the login screen. Empty, these rendered as three
// unlabelled icons — which is exactly how the screen looked.
export const BUSINESS_PROFILE_LABELS: Record<string, string> = {
  omnichannel: "محل + أونلاين",
  retail_only: "محل تجاري فقط",
  ecommerce_only: "متجر إلكتروني فقط",
};
// Empty, this returned `undefined` — so `setBusinessType(undefined)` ran on
// EVERY login and the dashboard had no idea what kind of business it was.
export const BUSINESS_PROFILE_TO_BUSINESS_TYPE: Record<string, string> = {
  omnichannel: "retail",
  retail_only: "retail",
  ecommerce_only: "ecommerce",
};
export const BUSINESS_TYPE_LABELS: Record<string, string> = {
  retail: "محل تجاري",
  ecommerce: "متجر إلكتروني",
};
export const BUSINESS_TYPE_TO_MODE: Record<string, string> = {
  retail: "retail",
  ecommerce: "ecommerce",
};
export type BackupBundle = any;
export type BackupRecord = any;
export type Branch = any;
export type BranchAssignment = any;
export type BudgetCap = any;
export type BusinessMode = string;
export type BusinessPersona = any;
export type BusinessProfile = any;
export type BusinessType = string;
export type CourierAccount = any;
export type CourierReceivable = any;
/** A customer — the columns of `customers` (live table). */
export interface CustomerProfile {
  id: string;
  name: string;
  phone: string;
  address: string;
  /** How many orders this person sent back — drives the double-shipping penalty. */
  returned_orders_count: number;
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
/**
 * Columns that are NOT NULL with a DEFAULT in `orders`. Every STORED order has
 * them — the row the store keeps is the one Postgres returned — but an order
 * being assembled for its first write may leave them to the database.
 */
export type DbDefaultedOrderField =
  | "address"
  | "paymentMethod"
  | "depositAmount"
  | "expectedCod"
  | "courierFee"
  | "cogsAmount"
  | "discountAmount"
  | "revenueLogged"
  | "isExchange"
  | "shippingPenaltyApplied"
  | "return_cause";

/** `orders_paymentMethod_check`, live schema. */
export type OrderPaymentMethod = "full_prepaid" | "partial_cod";

/**
 * An order document — the columns of `orders` (live table, 40 columns). Money
 * and stock are NOT here: they are ledger events keyed by `orderNumber`. What
 * this row carries is the document and its lifecycle.
 */
export interface EcommerceOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  address: string;
  governorate?: string | null;
  city?: string | null;
  items: EcommerceOrderItem[];
  stockItems?: EcommerceOrderItem[];
  totalAmount: number;
  shippingFee: number;
  paymentMethod: OrderPaymentMethod;
  depositAmount: number;
  depositWallet?: string | null;
  expectedCod: number;
  status: EcommerceOrderStatus;
  courierId?: string | null;
  courierName?: string | null;
  courierFee: number;
  cogsAmount: number;
  customerId?: string | null;
  discountCodeId?: string | null;
  discountAmount: number;
  revenueLogged: boolean;
  codSettledAt?: Date | string | null;
  returnConfirmedAt?: Date | string | null;
  returnType?: string | null;
  isExchange: boolean;
  /** The order this one replaces (an exchange's Order B points at Order A). */
  original_order_id?: string | null;
  /** Set when the order is a trader's — the returns flow settles against it. */
  wholesaleClientId?: string | null;
  shippingPenaltyApplied: boolean;
  return_cause: ReturnCause;
  createdAt: Date | string;
  updatedAt: Date | string;
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
/** An order before its first write: the database fills the defaulted fields. */
export type NewEcommerceOrder = Omit<EcommerceOrder, DbDefaultedOrderField> &
  Partial<Pick<EcommerceOrder, DbDefaultedOrderField>>;

/**
 * One line of an order — in `items` (what was sold) or `stockItems` (what left
 * the shelf, bundles expanded). Shape from `expandStockItems` and the order
 * form, the two writers.
 */
export interface EcommerceOrderItem {
  id: string;
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  /** Frozen at the sale, so a return reverses COGS at what the units carried. */
  unitCost?: number;
  variantName?: string;
  /** Knowingly sold short — what تقرير النواقص sums. */
  shortfall?: number;
  bundleId?: string;
  bundleName?: string;
  /** On lines of an order delivered in وضع الجملة: the invoice a trader return resolves against. */
  wholesaleInvoiceId?: string;
}
/**
 * An order's lifecycle state — exactly `orders_status_check` (live schema).
 * A union, not `any`: `orderLifecycle.ts` keys its transition table on this,
 * and only a closed union lets TypeScript prove every status has an entry.
 */
export type EcommerceOrderStatus = "pending" | "shipped" | "delivered" | "returned" | "cancelled";
export type EcommerceRevenueLedgerEntry = any;
export type ExpenseCategory = any;
export type ExpenseRecord = any;
export type FixedAsset = any;
export type GatedFeature = any;
export type IntegrationAdapter = any;
export type LicenseActivationResult = any;
export type LicenseAuditEvent = any;
export type LicensePlan = any;
export type LicenseRecord = any;
export const OPERATION_MODE_LABELS: Record<string, string> = {
  offline_local: "محلي على الجهاز",
  cloud_sync: "سحابي (Supabase)",
};
export type OnlineOrder = any;
export type OnlineOrderIntakeConfig = any;
export type OnlineOrderPayload = any;
export type OnlineOrderSource = any;
export type OperationMode = string;
export const PARTNER_KIND_HINTS: Record<string, string> = {
  working: "بيشتغل في المحل، وله نصيب في الأرباح، ويقدر يسحب من نصيبه",
  investor: "شريك برأس مال فقط — له نصيب في الأرباح، من غير مسحوبات",
};
// Two kinds, per docs/NEXUSCORE_PLAN.md §7.2 and scripts/check_partners.mjs:
// a working شريك may take an `owner_draw`, a مساهم holds capital only.
// The partner-kind picker iterates THIS map, so an empty one meant no kind
// could be chosen and no partner could be registered at all.
export const PARTNER_KIND_LABELS: Record<string, string> = {
  working: "شريك",
  investor: "مساهم",
};
export type Partner = any;
export type PartnerKind = any;
export type PaymobConfig = any;
export type PayrollRecord = any;
export type Product = any;
/**
 * A discount code — the columns of `discount_codes` (live table). The store
 * keeps them as `promoDiscounts`.
 */
export interface PromoDiscount {
  id: string;
  code: string;
  type: DiscountKind;
  value: number;
  active: boolean;
  maxUses?: number | null;
  expiryDate?: Date | string | null;
  createdAt?: Date | string | null;
  /**
   * Server-owned counters, moved only by `claim_discount_use` /
   * `release_discount_use` / `adjust_discount_total` and trigger-guarded.
   * `cloudSchema` never sends them. Present on every stored row (NOT NULL,
   * default 0); absent on a code the client is still creating.
   */
  usedCount?: number;
  totalDiscount?: number;
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
export type PublicSession = any;
/** A line on a supplier receipt, as `commitReceipt` stores it. */
export interface PurchaseInvoiceItem {
  id: string;
  productId: string;
  productName: string;
  sku?: string;
  variantName?: string;
  quantity: number;
  /** What was actually paid per unit — the cost a supplier return reverses at. */
  unitCost: number;
  isBundle?: boolean;
  bundleItems?: { productId: string; quantity: number; unitCost: number }[];
  total: number;
}

/**
 * A supplier receipt — the columns of `purchase_invoices` (migration 010, live
 * table). `status` has no CHECK in the table; `commitReceipt` writes these
 * three. What we still owe the supplier is `payable_supplier` in the ledger.
 */
export interface PurchaseInvoice {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  items: PurchaseInvoiceItem[];
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  dueDate?: string | null;
  status: "paid" | "partial" | "unpaid";
  notes?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
/** One returned line, as every writer stores it in `returned_items`. */
export interface ReturnedItem {
  /** The invoice line it came back from — wholesale returns key their ceiling on it. */
  line_id?: string;
  product_id: string;
  product_name: string;
  quantity: number;
  /** The price actually paid (wholesale). */
  unit_price?: number;
  /** Set by every writer (returns screen, POS, wholesale); 0 of 21 live rows lack it. */
  refund_amount: number;
}

/** What goes OUT on an exchange, as `exchanged_item` / `pending_replacement` store it. */
export interface ReplacementItem {
  product_id: string;
  product_name: string;
  quantity: number;
  price: number;
}

/**
 * A return or exchange document — the columns of `return_records` (live
 * table). `type` is free text by design: "return", "exchange", and
 * `WHOLESALE_RETURN_TYPE` all share this table.
 */
export interface ReturnRecord {
  id: string;
  /** An order id — or, for a wholesale return, the source INVOICE id. */
  original_order_id: string;
  type: string;
  customer_name: string;
  customer_phone: string;
  governorate: string;
  returned_items: ReturnedItem[];
  /**
   * An array since the exchange fix; rows written before it hold ONE object.
   * `exchangedItems()` normalises on read — so both shapes are typed.
   */
  exchanged_item?: ReplacementItem[] | ReplacementItem | null;
  pending_replacement?: ReplacementItem | null;
  financial_difference: number;
  processed_by: string;
  notes?: string | null;
  /** Stamped by `addReturnRecord` on every write (the column has no default). */
  created_at: string | Date;
  /** `return_records_return_cause_check`. The column defaults when a writer omits it. */
  return_cause?: ReturnCause;
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
export type SessionRecord = any;
export type ShipmentMovement = any;
export type ShippingConfig = any;
export type ShippingInfo = any;
export type ShippingProvider = any;
/**
 * One governorate's tariff. Shape proven by migration 018 and by the screens
 * that read it — the three movement keys are indexed BY NAME in
 * `rateFor(rows, gov, movement)`, so they must stay exactly `delivery` /
 * `return` / `exchange`, matching `ShipmentMovement`.
 */
export interface ShippingRateRow {
  id: string;
  governorate: string;
  delivery: number;
  return: number;
  exchange: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  /** Sync columns every cloud-backed row carries. */
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
export type ShippingTariff = any;
export type StockActionType = any;
export type StockLog = any;
/** A supplier — the columns of `suppliers` (live table). */
export interface Supplier {
  id: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  email?: string | null;
  address?: string | null;
  taxId?: string | null;
  notes?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  updated_at?: number;
  deleted_at?: string | null;
}
export type SyncAction = any;
export type Transaction = any;
// Re-exported from lib/roles.ts rather than re-typed: that file is the
// authority the RLS policies were written against, and two copies of a role
// list is how the two drift apart.
export const USER_ROLE_LABELS: Record<string, string> = { ...ROLE_LABELS };
export type UserRecord = any;
export type UserRole = string;
/**
 * The four tills, and the ONLY keys a wallet subject may use.
 *
 * `instapay` used to be spelled with a lowercase p HERE while every writer —
 * `useFinancialStore`'s seed, the e-commerce deposit default, and the zod enums
 * in `financial.server.ts` — wrote `instaPay`. `WalletType` is a bare `string`,
 * so nothing caught it, and the ledger ended up holding BOTH subjects.
 *
 * Measured on QA-STORE, 2026-09-14: `instaPay` held +5,040.00 over 15 lines
 * and `instapay` held −2,700.00 over 5. Every screen iterates these keys, so
 * the till showed «انستا باي −٢٬٧٠٠» while 5,040 of real deposits sat in the
 * other spelling, invisible. The true balance was +2,340.
 *
 * The key now matches the writers. `canonicalWallet` folds the historical
 * spelling in on read, so no ledger history has to be rewritten.
 */
export const WALLET_LABELS: Record<string, string> = {
  inStoreSafe: "خزينة المحل",
  vodafoneCash: "فودافون كاش",
  instaPay: "انستا باي",
  bankAccount: "حساب بنكي",
};

/**
 * Any stored wallet subject → the canonical key above.
 *
 * Case-insensitive, because that is the only way the two spellings ever
 * differed. An unknown subject is returned untouched rather than forced onto a
 * till it does not belong to — a wallet nobody recognises must stay visible as
 * itself, not be quietly folded into another shop account.
 */
export function canonicalWallet(subject: string): string {
  if (!subject) return subject;
  if (WALLET_LABELS[subject]) return subject;
  const lower = subject.toLowerCase();
  for (const key of Object.keys(WALLET_LABELS)) {
    if (key.toLowerCase() === lower) return key;
  }
  return subject;
}
export type Wallet = any;
export type WalletTransfer = any;
export type WalletType = string;
/** A trader — the columns of `wholesale_clients` (migration 016, live table). */
export interface WholesaleClient {
  id: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  email?: string | null;
  notes?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  // Stamped at the cloud boundary (`toRemoteRow`); absent on a row the
  // client is still assembling.
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  /** Epoch-ms sync clock — the one realtime Last-Write-Wins compares. */
  updated_at?: number;
  deleted_at?: string | null;
}
/** `wholesale_invoices_status_check`, live schema. */
export type WholesaleInvoiceStatus = "paid" | "partial" | "unpaid" | "overdue";

/**
 * A wholesale invoice — the columns of `wholesale_invoices` (migration 016,
 * verified against the live table). `remainingAmount` is the DOCUMENT's open
 * balance; what the trader actually owes is `receivable_client` in the ledger.
 */
export interface WholesaleInvoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  items: WholesaleInvoiceItem[];
  /** List value of the goods, before any discount. */
  goodsTotal: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  dueDate?: string | null;
  status: WholesaleInvoiceStatus;
  notes?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  // Stamped at the cloud boundary (`toRemoteRow`); absent on a row the
  // client is still assembling.
  store_id?: string;
  device_id?: string;
  sync_status?: string;
  /** Epoch-ms sync clock — the one realtime Last-Write-Wins compares. */
  updated_at?: number;
  deleted_at?: string | null;
}
/** A line on a wholesale invoice — the shape the return resolver validates. */
export type WholesaleInvoiceItem = WholesaleInvoiceLine;
export function getPlanDefinition(plan: any): any { return {} }
export type Customer = any;

export const PLAN_CATALOG: any = {};
