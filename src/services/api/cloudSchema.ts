/**
 * The cloud schema, as one definition both directions read.
 *
 * ## What was actually broken
 *
 * Reference data saved locally and never reached Supabase. Three causes, all
 * silent:
 *
 *   1. NO `store_id` ON THE PAYLOAD. Every reference table's RLS policy is
 *      `WITH CHECK (has_role(store_id, …))`. With `store_id` absent the check
 *      is never true, so Postgres rejected the row — a 403 the push logged and
 *      swallowed. This alone stopped everything.
 *   2. ONLY `products` WAS MAPPED. Every other table was pushed verbatim, so a
 *      record carrying a nested object (the `supplier` on a purchase line), a
 *      `Date`, or any local-only field named a column the table does not have.
 *      PostgREST rejects the WHOLE upsert for one unknown column.
 *   3. NO `updated_at`. The pull watermark is `updated_at`, so even a row that
 *      landed was invisible to every other device's next pull.
 *
 * ## Why this is a whitelist, not a camelCase → snake_case converter
 *
 * The obvious fix is to snake_case every key. It would break this schema badly:
 * the tables are deliberately MIXED. `products` has `image_url` next to
 * `"unitPrice"`; `suppliers` has `"companyName"` and `"contactPerson"` as
 * quoted camelCase columns. Converting those yields `company_name`, which does
 * not exist, and the upsert fails exactly as before.
 *
 * The schema was generated from the local record shapes, so most names already
 * match. What is needed is not translation but a fence: send the columns that
 * exist, drop everything else, and rename only the handful that truly differ.
 *
 * Dropping is also what strips the nested objects — no special case for
 * `supplier` is needed, because a key that is not a column never goes out.
 *
 * ## Divergences are logged, never silent
 *
 * A dropped key is reported once per table per session. The failure mode this
 * replaces was invisible; the replacement must not be.
 */

/** Added to every synced table by the §6 patch loop in 000_master_schema.sql. */
const COMMON = ["store_id", "updated_at", "device_id", "sync_status", "deleted_at"] as const;

export interface TableSchema {
  /** Every column the table has. Anything else is dropped on the way out. */
  columns: readonly string[];
  /** Local field → remote column, only where the two genuinely differ. */
  rename?: Readonly<Record<string, string>>;
  /**
   * Local fields deliberately never sent, even though a column exists.
   * Distinct from "unknown": these are known and withheld on purpose.
   */
  localOnly?: readonly string[];
}

export const CLOUD_SCHEMA: Readonly<Record<string, TableSchema>> = {
  products: {
    columns: [
      "id", "name", "sku", "barcode", "category", "description", "image_url",
      "quantity", "unitPrice", "wholesale_price", "minStockLevel",
      "maxStockLevel", "isActive", "isBundle", "bundleItems", "metadata",
      ...COMMON,
    ],
    rename: {
      // `stockMirror` writes totalQuantity; the column is `quantity`. This one
      // rename is why stock never synced before Phase 2.
      totalQuantity: "quantity",
      wholesalePrice: "wholesale_price",
    },
    // Cost is the ledger's weighted average of what was actually paid. A stored
    // one can be edited after the fact and re-price history.
    localOnly: ["costPrice"],
  },

  customers: {
    columns: ["id", "name", "phone", "address", "returned_orders_count", ...COMMON],
  },

  suppliers: {
    // Quoted camelCase in Postgres — see the note above about why these must
    // NOT be snake_cased.
    columns: [
      "id", "companyName", "contactPerson", "phone", "email", "address",
      "taxId", "notes", "createdAt", "updatedAt", ...COMMON,
    ],
  },

  discount_codes: {
    columns: [
      "id", "code", "type", "value", "active", "maxUses", "expiryDate",
      "createdAt", ...COMMON,
    ],
  },

  return_records: {
    columns: [
      "id", "original_order_id", "type", "customer_name", "customer_phone",
      "governorate", "returned_items", "exchanged_item", "pending_replacement",
      "financial_difference", "processed_by", "notes", "created_at", ...COMMON,
    ],
  },

  branches: {
    columns: ["id", "name", "code", "address", "phone", "isActive", "createdAt", ...COMMON],
  },

  purchase_invoices: {
    // Quoted camelCase, matching `suppliers` — see the note above about why
    // these must NOT be snake_cased.
    //
    // `items` is jsonb: a receipt's lines are only ever read back with their
    // invoice, never queried across invoices, so a child table would buy
    // nothing but a join. The LEDGER is what aggregate questions are asked of.
    columns: [
      "id", "invoiceNumber", "supplierId", "supplierName", "items",
      "totalAmount", "paidAmount", "remainingAmount", "dueDate", "status",
      "notes", "createdAt", "updatedAt", ...COMMON,
    ],
  },

  orders: {
    columns: [
      "id", "orderNumber", "status", "customerId", "customerName",
      "customerPhone", "governorate", "city", "address", "items", "stockItems",
      "totalAmount", "discountCodeId", "discountAmount", "shippingFee",
      "depositAmount", "depositWallet", "expectedCod", "cogsAmount",
      "paymentMethod", "courierName", "courierId", "courierFee",
      "revenueLogged", "codSettledAt", "returnConfirmedAt", "returnType",
      "isExchange", "original_order_id", "wholesaleClientId", "createdAt",
      "updatedAt", ...COMMON,
    ],
  },
} as const;

export type SyncedTable = keyof typeof CLOUD_SCHEMA;

export function isSyncedTable(table: string): table is SyncedTable {
  return table in CLOUD_SCHEMA;
}

/** Remote column → local field, per table. Inverse of `rename`. */
export function inverseRename(table: string): Record<string, string> {
  const rename = CLOUD_SCHEMA[table]?.rename;
  if (!rename) return {};
  return Object.fromEntries(Object.entries(rename).map(([local, remote]) => [remote, local]));
}

// ── Divergence reporting ────────────────────────────────────────────────────

const reported = new Map<string, Set<string>>();

/**
 * Say once, per table per session, that a field is not being sent.
 *
 * Not a silent drop and not a per-write flood: the point is that a schema
 * divergence becomes visible the first time it happens, so "it saves locally
 * but never appears on the other device" is never again a mystery.
 */
export function reportDropped(table: string, keys: string[]): void {
  if (keys.length === 0) return;
  const seen = reported.get(table) ?? new Set<string>();
  const fresh = keys.filter((k) => !seen.has(k));
  if (fresh.length === 0) return;
  for (const k of fresh) seen.add(k);
  reported.set(table, seen);
  console.warn(
    `[CloudSchema] [${table}] these fields are not columns and were not sent: ` +
      `${fresh.join(", ")}. If one of them is real data, add the column in ` +
      `docs/migrations/ and list it in cloudSchema.ts.`,
  );
}

/** Test seam. */
export function resetDroppedReport(): void {
  reported.clear();
}
