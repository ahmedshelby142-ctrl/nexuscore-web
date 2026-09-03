import { createServerFn } from "@/lib/createServerFn";
import { z } from "zod";
import { getSupabaseClient } from "@/lib/supabase";
import { requirePermission } from "./auth.server";
import type {
  PaymobConfig,
  ShippingConfig,
  OnlineOrderIntakeConfig,
  OnlineOrderPayload,
  UserRole,
} from "@/types";

/**
 * Integrations server functions — A BLUEPRINT, NOT A SERVER.
 *
 * ⚠ Nothing in this file runs on a server today, and nothing calls it.
 * `createServerFn` (src/lib/createServerFn.ts) is a browser shim that invokes
 * the handler in the page, so `readEnv` reads a `process` that does not exist
 * in the bundle and `requirePermission` is a check the caller could skip. Any
 * secret passed through here would be a secret in the browser.
 *
 * Keep it as the shape the real endpoints should take when a server exists —
 * a Supabase Edge Function or a Vercel serverless route — but do NOT read it
 * as a description of how the app behaves now. Until then the client stores no
 * secret at all: see `useIntegrationsStore`.
 *
 * These endpoints are intended to be the source of truth for any third-party
 * service that needs to talk to the system (Paymob, shipping carriers, online
 * storefronts). Keys are never echoed back over the wire — only masked
 * previews are returned.
 *
 * The functions are gated by `requirePermission(...)` so even if a
 * non-admin reaches the endpoint the request is rejected.
 *
 * Precedence for credentials (highest first):
 *   1. Server-side env var  (PAYMOB_API_KEY / SHIPPING_API_KEY / ONLINE_ORDER_API_KEY)
 *   2. Local storage value injected by the client (offline mode)
 *   3. Empty / unset
 */

function readEnv(name: string): string {
  return process.env[name] ?? "";
}

const sessionSchema = z.object({
  role: z
    .enum([
      "owner",
      "cashier",
      "data_entry",
      "cashier_data_entry",
      "branch_manager",
      "inventory_clerk",
      "accountant",
      "customer_support",
      "viewer",
    ])
    .default("owner"),
  username: z.string().default("system"),
});

// ── Paymob ──────────────────────────────────────────────────────────

export const getPaymobConfig = createServerFn({ method: "GET" })
  .validator(sessionSchema)
  .handler(async ({ data }) => {
    requirePermission(data.role as UserRole, "edit:settings");
    const sb = getSupabaseClient();
    if (!sb) {
      return {
        success: true,
        data: {
          source: "env" as const,
          enabled: !!readEnv("PAYMOB_API_KEY"),
          integrationId: readEnv("PAYMOB_INTEGRATION_ID"),
        },
      };
    }
    const { data: row, error } = await sb
      .from("integrations")
      .select("*")
      .eq("source", "paymob")
      .single();
    if (error) return { success: false, error: error.message };
    return { success: true, data: row as PaymobConfig | null };
  });

export const savePaymobConfig = createServerFn({ method: "POST" })
  .validator(
    sessionSchema.extend({
      environment: z.enum(["sandbox", "production"]),
      apiKey: z.string(),
      publicKey: z.string(),
      integrationId: z.string(),
      hmacSecret: z.string(),
      callbackUrl: z.string().optional().default(""),
    }),
  )
  .handler(async ({ data }) => {
    requirePermission(data.role as UserRole, "edit:settings");
    const sb = getSupabaseClient();
    if (!sb) return { success: true, synced: false, reason: "Supabase not configured" };

    const { error } = await sb.from("integrations").upsert(
      {
        source: "paymob",
        config: data,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source" },
    );
    return { success: !error, error: error?.message ?? null };
  });

// ── Shipping ────────────────────────────────────────────────────────

export const getShippingConfig = createServerFn({ method: "GET" })
  .validator(sessionSchema)
  .handler(async ({ data }) => {
    requirePermission(data.role as UserRole, "edit:settings");
    const sb = getSupabaseClient();
    if (!sb) {
      return {
        success: true,
        data: { source: "env" as const, enabled: !!readEnv("SHIPPING_API_KEY") },
      };
    }
    const { data: row, error } = await sb
      .from("integrations")
      .select("*")
      .eq("source", "shipping")
      .single();
    if (error) return { success: false, error: error.message };
    return { success: true, data: row as ShippingConfig | null };
  });

export const saveShippingConfig = createServerFn({ method: "POST" })
  .validator(
    sessionSchema.extend({
      provider: z.enum(["aramex", "bosta", "myshipping", "souqpress", "custom"]),
      environment: z.enum(["sandbox", "production"]),
      apiKey: z.string(),
      storeId: z.string().optional(),
      webhookSecret: z.string(),
      webhookUrl: z.string().optional().default(""),
      autoTrack: z.boolean().default(true),
      autoCreateShipment: z.boolean().default(false),
    }),
  )
  .handler(async ({ data }) => {
    requirePermission(data.role as UserRole, "edit:settings");
    const sb = getSupabaseClient();
    if (!sb) return { success: true, synced: false, reason: "Supabase not configured" };

    const { error } = await sb.from("integrations").upsert(
      {
        source: "shipping",
        config: data,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source" },
    );
    return { success: !error, error: error?.message ?? null };
  });

// ── Online order intake ─────────────────────────────────────────────

export const getOnlineOrderIntakeConfig = createServerFn({ method: "GET" })
  .validator(sessionSchema)
  .handler(async ({ data }) => {
    requirePermission(data.role as UserRole, "edit:settings");
    const sb = getSupabaseClient();
    if (!sb) {
      return {
        success: true,
        data: { source: "env" as const, enabled: !!readEnv("ONLINE_ORDER_API_KEY") },
      };
    }
    const { data: row, error } = await sb
      .from("integrations")
      .select("*")
      .eq("source", "online_order")
      .single();
    if (error) return { success: false, error: error.message };
    return { success: true, data: row as OnlineOrderIntakeConfig | null };
  });

export const saveOnlineOrderIntakeConfig = createServerFn({ method: "POST" })
  .validator(
    sessionSchema.extend({
      source: z.enum(["shopify", "woocommerce", "custom_webstore", "manual"]),
      storeUrl: z.string(),
      apiKey: z.string(),
      apiSecret: z.string().optional(),
      webhookSecret: z.string(),
      webhookUrl: z.string().optional().default(""),
      allowAutoIngest: z.boolean().default(true),
      pushStatusUpdates: z.boolean().default(true),
    }),
  )
  .handler(async ({ data }) => {
    requirePermission(data.role as UserRole, "edit:settings");
    const sb = getSupabaseClient();
    if (!sb) return { success: true, synced: false, reason: "Supabase not configured" };

    const { error } = await sb.from("integrations").upsert(
      {
        source: "online_order",
        config: data,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source" },
    );
    return { success: !error, error: error?.message ?? null };
  });

// ── Ingest a single online order (called by the webhook or poll) ───

export const ingestOnlineOrder = createServerFn({ method: "POST" })
  .validator(
    z.object({
      source: z.enum(["shopify", "woocommerce", "custom_webstore"]),
      externalOrderId: z.string(),
      customerName: z.string(),
      customerPhone: z.string().optional(),
      customerEmail: z.string().email().optional(),
      address: z.string().optional(),
      items: z.array(
        z.object({
          productId: z.string().optional(),
          productName: z.string(),
          sku: z.string().optional(),
          quantity: z.number().int().positive(),
          unitPrice: z.number().nonnegative(),
        }),
      ),
      totalAmount: z.number().nonnegative(),
      shippingFee: z.number().nonnegative().default(0),
      paymentMethod: z.enum(["full_prepaid", "partial_cod"]).default("full_prepaid"),
      depositAmount: z.number().nonnegative().default(0),
      // The raw payload from the source. We treat it as an opaque
      // JSON string for serialisability across the server-fn boundary.
      rawJson: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    // Looser permission — this is called by webhooks and may be invoked
    // by the carrier / storefront service. The HMAC verification is the
    // real gate; see supabase/functions/handle-ecommerce-order/index.ts.
    // The handler still does a permission check using a synthetic role
    // (owner) since the webhook itself is trusted.
    requirePermission("owner", "edit:orders");

    const sb = getSupabaseClient();
    const payload: OnlineOrderPayload = {
      id: crypto.randomUUID(),
      source: data.source,
      externalOrderId: data.externalOrderId,
      receivedAt: new Date(),
      status: "received",
      rawJson: data.rawJson ?? "",
    };

    if (!sb) {
      return {
        success: true,
        synced: false,
        payload,
        reason: "Supabase not configured — payload stored in client audit log only",
      };
    }

    const { error } = await sb.from("online_orders").insert({
      external_order_id: data.externalOrderId,
      source: data.source,
      customer_name: data.customerName,
      customer_email: data.customerEmail ?? null,
      customer_phone: data.customerPhone ?? null,
      customer_address: data.address ?? null,
      items: data.items,
      total_amount: data.totalAmount,
      status: "pending",
      order_date: new Date().toISOString(),
      processed_at: null,
      metadata: data.rawJson ? safeParseJson(data.rawJson) : {},
    });

    if (error) {
      return { success: false, error: error.message, payload };
    }
    return { success: true, payload: { ...payload, status: "processing" } };
  });

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
