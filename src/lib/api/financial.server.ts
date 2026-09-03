import { createServerFn } from "@/lib/createServerFn";
import { z } from "zod";
import { getSupabaseClient } from "@/lib/supabase";

// ─── Shared Supabase client (server-side only) ────────────────────────────────

function supabase() {
  return getSupabaseClient();
}

// ─── Generic helpers ─────────────────────────────────────────────────────────

async function dbUpsert<T extends Record<string, unknown>>(
  table: string,
  rows: T[],
  onConflict = "id",
): Promise<{ error: string | null }> {
  const sb = supabase();
  if (!sb) return { error: "Supabase not configured" };
  const { error } = await sb.from(table).upsert(rows as any[], { onConflict });
  return { error: error?.message ?? null };
}

async function dbSelect<T>(table: string, filters?: Record<string, string>): Promise<{ data: T[]; error: string | null }> {
  const sb = supabase();
  if (!sb) return { data: [], error: "Supabase not configured" };
  let q = sb.from(table).select("*").order("created_at", { ascending: false });
  if (filters) {
    for (const [key, val] of Object.entries(filters)) {
      q = q.eq(key, val);
    }
  }
  const { data, error } = await q;
  return { data: (data as T[]) ?? [], error: error?.message ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// WALLETS API
// ─────────────────────────────────────────────────────────────────────────────

export const getWallets = createServerFn({ method: "GET" })
  .validator(z.object({}))
  .handler(async () => {
    const { data, error } = await dbSelect("wallets");
    if (error) return { success: false, error, data: [] };
    return {
      success: true,
      data: data.map((w: any) => ({
        id: w.id,
        type: w.type,
        label: w.label,
        balance: Number(w.balance),
      })),
    };
  });

export const updateWalletBalance = createServerFn({ method: "POST" })
  .validator(
    z.object({
      type: z.enum(["inStoreSafe", "vodafoneCash", "instaPay", "bankAccount"]),
      amount: z.number(),
      operation: z.enum(["add", "subtract"]),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    // Fetch current balance
    const { data: wallet, error: fetchErr } = await sb
      .from("wallets")
      .select("balance")
      .eq("type", data.type)
      .single();

    if (fetchErr) return { success: false, error: fetchErr.message };

    // `??` never fires here: Number() returns NaN, not null, for a
    // non-numeric balance — and NaN would propagate straight into the balance
    // written back. `||` catches it. (This file targets the pre-ledger
    // `wallets` table, which 000_master_schema deliberately does not create,
    // so the path is unreachable today — but the trap should not survive.)
    const currentBalance = Number(wallet.balance) || 0;
    const newBalance =
      data.operation === "add"
        ? currentBalance + data.amount
        : Math.max(0, currentBalance - data.amount);

    const { error: updateErr } = await sb
      .from("wallets")
      .update({ balance: newBalance })
      .eq("type", data.type);

    return { success: !updateErr, error: updateErr?.message ?? null, balance: newBalance };
  });

// ─────────────────────────────────────────────────────────────────────────────
// WALLET TRANSFERS API
// ─────────────────────────────────────────────────────────────────────────────

export const getWalletTransfers = createServerFn({ method: "GET" })
  .validator(z.object({ limit: z.string().optional() }))
  .handler(async ({ data }) => {
    const limit = data.limit ? parseInt(data.limit) : 50;
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured", data: [] };

    const { data: rows, error } = await sb
      .from("wallet_transfers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return {
      success: !error,
      error: error?.message ?? null,
      data: (rows ?? []).map((t: any) => ({
        id: t.id,
        fromWallet: t.from_wallet,
        toWallet: t.to_wallet,
        amount: Number(t.amount),
        notes: t.notes,
        timestamp: t.created_at,
      })),
    };
  });

export const createWalletTransfer = createServerFn({ method: "POST" })
  .validator(
    z.object({
      fromWallet: z.enum(["inStoreSafe", "vodafoneCash", "instaPay", "bankAccount"]),
      toWallet: z.enum(["inStoreSafe", "vodafoneCash", "instaPay", "bankAccount"]),
      amount: z.number().positive(),
      notes: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    // Deduct from source wallet
    const fromResult = await updateWalletBalance({ data: {
      type: data.fromWallet,
      amount: data.amount,
      operation: "subtract",
    }});

    if (!fromResult.success) {
      return { success: false, error: `Failed to deduct from source: ${fromResult.error}` };
    }

    // Add to target wallet
    await updateWalletBalance({ data: {
      type: data.toWallet,
      amount: data.amount,
      operation: "add",
    }});

    // Record transfer log
    const { error: insertErr } = await sb.from("wallet_transfers").insert({
      from_wallet: data.fromWallet,
      to_wallet: data.toWallet,
      amount: data.amount,
      notes: data.notes ?? null,
    });

    // Also log as expense for audit trail
    if (!insertErr) {
      const walletLabels: Record<string, string> = {
        inStoreSafe: "الخزينة",
        vodafoneCash: "فودافون كاش",
        bankAccount: "الحساب البنكي",
      };
      await sb.from("expenses").insert({
        category: "other",
        amount: data.amount,
        description: `تحويل من ${walletLabels[data.fromWallet]} إلى ${walletLabels[data.toWallet]}${data.notes ? ` - ${data.notes}` : ""}`,
        date: new Date().toISOString(),
      });
    }

    return { success: !insertErr, error: insertErr?.message ?? null };
  });

// SHAREHOLDERS API — DELETED 2026-08-18.
// This was the THIRD implementation of the same three fields (name, share %,
// capital), behind a route react-router never served. There is one list now:
// `Partner` with a `kind` of شريك / مساهم. See `src/lib/partners.ts`.

// ─────────────────────────────────────────────────────────────────────────────
// STOCK LOGS API (append-only)
// ─────────────────────────────────────────────────────────────────────────────

export const appendStockLog = createServerFn({ method: "POST" })
  .validator(
    z.object({
      productSku: z.string(),
      productName: z.string().optional(),
      actionType: z.enum(["sale", "purchase", "return", "adjustment", "import", "ecommerce_order", "ecommerce_return"]),
      qtyChange: z.number().int(),
      previousQty: z.number().int().min(0),
      newQty: z.number().int().min(0),
      operator: z.string().default("system"),
      referenceId: z.string().optional(),
      notes: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    const { data: row, error } = await sb
      .from("stock_logs")
      .insert({
        product_sku: data.productSku,
        product_name: data.productName ?? null,
        action_type: data.actionType,
        qty_change: data.qtyChange,
        previous_qty: data.previousQty,
        new_qty: data.newQty,
        operator: data.operator,
        reference_id: data.referenceId ?? null,
        notes: data.notes ?? null,
      })
      .select()
      .single();

    if (error) return { success: false, error: error.message };

    return {
      success: true,
      data: {
        id: row.id,
        timestamp: row.created_at,
      },
    };
  });

export const getStockLogs = createServerFn({ method: "GET" })
  .validator(
    z.object({
      productSku: z.string().optional(),
      actionType: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured", data: [] };

    let q = sb.from("stock_logs").select("*").order("created_at", { ascending: false });

    if (data.productSku) q = q.eq("product_sku", data.productSku);
    if (data.actionType) q = q.eq("action_type", data.actionType);
    if (data.startDate) q = q.gte("created_at", data.startDate);
    if (data.endDate) q = q.lte("created_at", data.endDate);
    if (data.limit) q = q.limit(parseInt(data.limit));

    const { data: rows, error } = await q;

    return {
      success: !error,
      error: error?.message ?? null,
      data: (rows ?? []).map((s: any) => ({
        id: s.id,
        timestamp: s.created_at,
        productSku: s.product_sku,
        productName: s.product_name,
        actionType: s.action_type,
        qtyChange: s.qty_change,
        previousQty: s.previous_qty,
        newQty: s.new_qty,
        operator: s.operator,
        referenceId: s.reference_id,
        notes: s.notes,
      })),
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT SESSIONS API
// ─────────────────────────────────────────────────────────────────────────────

export const createAuditSession = createServerFn({ method: "POST" })
  .validator(
    z.object({
      name: z.string().min(1),
      category: z.string().default("all"),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    const { data: row, error } = await sb
      .from("audit_sessions")
      .insert({
        name: data.name,
        category: data.category,
        status: "draft",
      })
      .select()
      .single();

    if (error) return { success: false, error: error.message };

    return { success: true, data: { id: row.id, name: row.name, status: row.status, sessionDate: row.session_date } };
  });

export const confirmAuditSession = createServerFn({ method: "POST" })
  .validator(
    z.object({
      sessionId: z.string().uuid(),
      discrepancies: z.array(
        z.object({
          productSku: z.string(),
          productName: z.string().optional(),
          systemQty: z.number().int().min(0),
          actualQty: z.number().int().min(0),
          discrepancy: z.number().int(),
          unitCost: z.number().optional().default(0),
          financialLoss: z.number().optional().default(0),
        }),
      ),
      closedBy: z.string().default("system"),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    // Upsert discrepancies
    const discRows = data.discrepancies.map((d) => ({
      session_id: data.sessionId,
      product_sku: d.productSku,
      product_name: d.productName ?? null,
      system_qty: d.systemQty,
      actual_qty: d.actualQty,
      discrepancy: d.discrepancy,
      unit_cost: d.unitCost,
      financial_loss: d.financialLoss,
      adjusted: false,
    }));

    if (discRows.length > 0) {
      await sb.from("audit_discrepancies").insert(discRows);
    }

    // Update session to confirmed
    await sb
      .from("audit_sessions")
      .update({ status: "confirmed", closed_at: new Date().toISOString(), closed_by: data.closedBy })
      .eq("id", data.sessionId);

    // Log financial losses as expenses
    for (const d of data.discrepancies) {
      if (d.discrepancy > 0 && d.financialLoss > 0) {
        await sb.from("expenses").insert({
          category: "other",
          amount: d.financialLoss,
          description: `عجز مخزون - ${d.productSku} (${d.discrepancy} وحدة)`,
          date: new Date().toISOString(),
        });
      }
    }

    return { success: true, data: null };
  });

export const getAuditSessions = createServerFn({ method: "GET" })
  .validator(z.object({ status: z.string().optional() }))
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured", data: [] };

    let q = sb.from("audit_sessions").select("*").order("created_at", { ascending: false });
    if (data.status) q = q.eq("status", data.status);

    const { data: rows, error } = await q;
    return {
      success: !error,
      error: error?.message ?? null,
      data: (rows ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        status: s.status,
        sessionDate: s.session_date,
        closedAt: s.closed_at,
        closedBy: s.closed_by,
      })),
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// COURIER FINANCIAL API
// ─────────────────────────────────────────────────────────────────────────────

export const createCourierReceivable = createServerFn({ method: "POST" })
  .validator(
    z.object({
      orderId: z.string(),
      orderNumber: z.string().optional(),
      courierId: z.string(),
      courierName: z.string(),
      orderTotal: z.number().min(0),
      courierFee: z.number().min(0),
      amountDue: z.number().min(0),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    const { error } = await sb.from("courier_financials").insert({
      order_id: data.orderId,
      order_number: data.orderNumber ?? null,
      courier_id: data.courierId,
      courier_name: data.courierName,
      order_total: data.orderTotal,
      courier_fee: data.courierFee,
      amount_due: data.amountDue,
      status: "pending",
    });

    return { success: !error, error: error?.message ?? null };
  });

export const reconcileCourierReceivable = createServerFn({ method: "POST" })
  .validator(
    z.object({
      orderId: z.string(),
      targetWallet: z.enum(["inStoreSafe", "vodafoneCash", "instaPay", "bankAccount"]),
      courierFee: z.number().min(0),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    // Fetch the receivable
    const { data: rec, error: fetchErr } = await sb
      .from("courier_financials")
      .select("*")
      .eq("order_id", data.orderId)
      .single();

    if (fetchErr || !rec) return { success: false, error: fetchErr?.message ?? "Receivable not found" };

    // Mark as reconciled
    const { error: updErr } = await sb
      .from("courier_financials")
      .update({
        status: "reconciled",
        target_wallet: data.targetWallet,
        reconciled_at: new Date().toISOString(),
      })
      .eq("order_id", data.orderId);

    if (updErr) return { success: false, error: updErr.message };

    // Credit wallet
    await updateWalletBalance({ data: { type: data.targetWallet, amount: rec.amount_due, operation: "add" } });

    // Log courier fee as expense
    if (data.courierFee > 0) {
      await sb.from("expenses").insert({
        category: "shipping",
        amount: data.courierFee,
        description: `عمولة شحن - طلب ${rec.order_number ?? data.orderId}`,
        date: new Date().toISOString(),
      });
    }

    return { success: true, data: null };
  });

export const getCourierReceivables = createServerFn({ method: "GET" })
  .validator(z.object({ courierId: z.string().optional(), status: z.string().optional() }))
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured", data: [] };

    let q = sb.from("courier_financials").select("*").order("created_at", { ascending: false });
    if (data.courierId) q = q.eq("courier_id", data.courierId);
    if (data.status) q = q.eq("status", data.status);

    const { data: rows, error } = await q;

    return {
      success: !error,
      error: error?.message ?? null,
      data: (rows ?? []).map((r: any) => ({
        id: r.id,
        orderId: r.order_id,
        orderNumber: r.order_number,
        courierId: r.courier_id,
        courierName: r.courier_name,
        orderTotal: Number(r.order_total),
        courierFee: Number(r.courier_fee),
        amountDue: Number(r.amount_due),
        status: r.status,
        targetWallet: r.target_wallet,
        reconciledAt: r.reconciled_at,
        createdAt: r.created_at,
      })),
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// EXPENSES API
// ─────────────────────────────────────────────────────────────────────────────

export const getExpenses = createServerFn({ method: "GET" })
  .validator(
    z.object({
      category: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured", data: [] };

    let q = sb.from("expenses").select("*").order("date", { ascending: false });
    if (data.category) q = q.eq("category", data.category);
    if (data.startDate) q = q.gte("date", data.startDate);
    if (data.endDate) q = q.lte("date", data.endDate);
    if (data.limit) q = q.limit(parseInt(data.limit));

    const { data: rows, error } = await q;

    return {
      success: !error,
      error: error?.message ?? null,
      data: (rows ?? []).map((e: any) => ({
        id: e.id,
        category: e.category,
        amount: Number(e.amount),
        description: e.description,
        date: e.date,
      })),
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// BULK SYNC API — sync full Zustand state to backend
// ─────────────────────────────────────────────────────────────────────────────

export const syncFinancialState = createServerFn({ method: "POST" })
  .validator(
    z.object({
      wallets: z.array(z.object({ type: z.string(), balance: z.number() })).optional(),
      walletTransfers: z.array(z.object({
        fromWallet: z.string(), toWallet: z.string(), amount: z.number(),
        timestamp: z.string(), notes: z.string().optional(),
      })).optional(),
      stockLogs: z.array(z.object({
        productSku: z.string(), productName: z.string().optional(),
        actionType: z.string(), qtyChange: z.number(), previousQty: z.number(),
        newQty: z.number(), operator: z.string(), referenceId: z.string().optional(),
        notes: z.string().optional(), timestamp: z.string(),
      })).optional(),
      courierReceivables: z.array(z.object({
        orderId: z.string(), orderNumber: z.string().optional(), courierId: z.string(), courierName: z.string(),
        orderTotal: z.number(), courierFee: z.number(), amountDue: z.number(),
        status: z.string(), createdAt: z.string(), reconciledAt: z.string().optional(),
        targetWallet: z.string().optional(),
      })).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: true, synced: false, reason: "Supabase not configured" };

    const results: string[] = [];

    // Sync wallets
    if (data.wallets?.length) {
      const walletRows = data.wallets.map((w) => ({ type: w.type, balance: w.balance }));
      const { error } = await sb.from("wallets").upsert(walletRows, { onConflict: "type" });
      if (error) results.push(`wallets: ${error.message}`);
    }

    // Sync wallet transfers
    if (data.walletTransfers?.length) {
      const transferRows = data.walletTransfers.map((t) => ({
        from_wallet: t.fromWallet, to_wallet: t.toWallet,
        amount: t.amount, notes: t.notes ?? null, created_at: t.timestamp,
      }));
      const { error } = await sb.from("wallet_transfers").insert(transferRows);
      if (error) results.push(`wallet_transfers: ${error.message}`);
    }

    // Sync stock logs (append only — no upsert, only insert)
    if (data.stockLogs?.length) {
      const logRows = data.stockLogs.map((l) => ({
        product_sku: l.productSku, product_name: l.productName ?? null,
        action_type: l.actionType, qty_change: l.qtyChange,
        previous_qty: l.previousQty, new_qty: l.newQty,
        operator: l.operator, reference_id: l.referenceId ?? null,
        notes: l.notes ?? null, created_at: l.timestamp,
      }));
      const { error } = await sb.from("stock_logs").insert(logRows);
      if (error) results.push(`stock_logs: ${error.message}`);
    }

    // Sync courier financials
    if (data.courierReceivables?.length) {
      for (const cr of data.courierReceivables) {
        const existing = await sb
          .from("courier_financials")
          .select("id")
          .eq("order_id", cr.orderId)
          .single();

        if (!existing.data) {
          await sb.from("courier_financials").insert({
            order_id: cr.orderId, order_number: cr.orderNumber ?? null,
            courier_id: cr.courierId, courier_name: cr.courierName,
            order_total: cr.orderTotal, courier_fee: cr.courierFee,
            amount_due: cr.amountDue, status: cr.status,
            target_wallet: cr.targetWallet ?? null,
            reconciled_at: cr.reconciledAt ?? null,
          });
        }
      }
    }

    return {
      success: results.length === 0,
      synced: true,
      errors: results.length ? results : undefined,
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL REPORT API — aggregates data for PDF generation
// ─────────────────────────────────────────────────────────────────────────────

export const getFinancialReport = createServerFn({ method: "GET" })
  .validator(
    z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sb = supabase();
    if (!sb) return { success: false, error: "Supabase not configured" };

    // Fetch wallets
    const { data: wallets } = await (sb as any).from("wallets").select("*");

    // Fetch recent expenses
    let expQ = sb.from("expenses").select("*").order("date", { ascending: false }).limit(50);
    if (data.startDate) expQ = expQ.gte("date", data.startDate);
    if (data.endDate) expQ = expQ.lte("date", data.endDate);
    const { data: expenses } = await expQ;

    // Fetch recent transfers
    const { data: transfers } = await (sb as any)
      .from("wallet_transfers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    // Calculate totals
    const totalExpenses = (expenses ?? []).reduce((s: number, e: any) => s + Number(e.amount), 0);
    const totalWalletBalance = (wallets ?? []).reduce((s: number, w: any) => s + Number(w.balance), 0);

    return {
      success: true,
      data: {
        wallets: (wallets ?? []).map((w: any) => ({
          type: w.type, label: w.label, balance: Number(w.balance),
        })),
        expenses: (expenses ?? []).map((e: any) => ({
          category: e.category, amount: Number(e.amount),
          description: e.description, date: e.date,
        })),
        transfers: (transfers ?? []).map((t: any) => ({
          fromWallet: t.from_wallet, toWallet: t.to_wallet,
          amount: Number(t.amount), timestamp: t.created_at,
        })),
        totalExpenses,
        totalWalletBalance,
      },
    };
  });

// The four shareholder server functions that used to close this file are gone
// with the rest of the duplicate: one list, one `Partner`, one `kind`.
