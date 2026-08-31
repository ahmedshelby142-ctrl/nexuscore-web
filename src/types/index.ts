// Reconstructed types
//
// ⚠ KNOWN DEBT: most of the TYPE aliases below are `any`. That is not a style
// choice — this file was rebuilt after a loss (see recover_types.py in the
// repo root) and the real interfaces were never restored. The practical effect
// is that TypeScript cannot catch a whole class of bug in this codebase: an
// un-awaited Promise used as an object type-checks cleanly, which is exactly
// how the Quick Supply receipt shipped filing itself against `undefined`.
//
// The CONSTANT MAPS below are a different matter and are now filled in. They
// are read at RUNTIME — an empty `{}` is not a missing type, it is a dropdown
// that renders no options and a lookup that returns `undefined`. Every value
// here was recovered from the call sites and tests that consume it, not
// invented.

import { ROLE_LABELS } from "@/lib/roles";

export type Account = any;
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
export type Balance = any;
export type BalanceQuery = any;
export type Branch = any;
export type BranchAssignment = any;
export type BudgetCap = any;
export type BusinessMode = string;
export type BusinessPersona = any;
export type BusinessProfile = any;
export type BusinessType = string;
export type CourierAccount = any;
export type CourierReceivable = any;
export type CustomerProfile = any;
export type EcommerceOrder = any;
export type EcommerceOrderItem = any;
export type EcommerceOrderStatus = any;
export type EcommerceRevenueLedgerEntry = any;
export type EventKind = any;
export type EventQuery = any;
export type ExpenseCategory = any;
export type ExpenseRecord = any;
export type FixedAsset = any;
export type GatedFeature = any;
export type Identity = any;
export type IntegrationAdapter = any;
export type LedgerEvent = any;
export type LicenseActivationResult = any;
export type LicenseAuditEvent = any;
export type LicensePlan = any;
export type LicenseRecord = any;
export type NewEvent = any;
export type NewLine = any;
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
export type PromoDiscount = any;
export type PublicSession = any;
export type PurchaseInvoice = any;
export type ReturnRecord = any;
export type SessionRecord = any;
export type ShipmentMovement = any;
export type ShippingConfig = any;
export type ShippingInfo = any;
export type ShippingProvider = any;
export type ShippingRateRow = any;
export type ShippingTariff = any;
export type StockActionType = any;
export type StockLog = any;
export type Supplier = any;
export type SyncAction = any;
export type SyncStatus = any;
export type Transaction = any;
// Re-exported from lib/roles.ts rather than re-typed: that file is the
// authority the RLS policies were written against, and two copies of a role
// list is how the two drift apart.
export const USER_ROLE_LABELS: Record<string, string> = { ...ROLE_LABELS };
export type UserRecord = any;
export type UserRole = string;
export const WALLET_LABELS: Record<string, string> = { 
  inStoreSafe: "خزينة المحل", 
  vodafoneCash: "فودافون كاش", 
  instapay: "انستا باي", 
  bankAccount: "حساب بنكي" 
};
export type Wallet = any;
export type WalletTransfer = any;
export type WalletType = string;
export type WholesaleClient = any;
export type WholesaleInvoice = any;
export type WholesaleInvoiceItem = any;
export function getPlanDefinition(plan: any): any { return {} }
export type Customer = any;

export const PLAN_CATALOG: any = {};
