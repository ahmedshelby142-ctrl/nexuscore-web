import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * E-commerce order intake webhook.
 *
 * This function is invoked when a connected storefront (Shopify,
 * WooCommerce, custom) POSTs a new order to the system. It:
 *   1. Verifies the HMAC signature against the configured webhook secret.
 *   2. Maps the external order shape to the internal orders table.
 *   3. Inserts into the `online_orders` table for the admin to review.
 *
 * Environment variables (set in your Supabase project's secrets):
 *   - SUPABASE_URL                      auto-injected
 *   - SUPABASE_SERVICE_ROLE_KEY         auto-injected
 *   - ONLINE_ORDER_HMAC_SECRET          shared with the storefront
 *
 * URL to register in the storefront:
 *   https://<project-ref>.functions.supabase.co/handle-ecommerce-order
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const hmacSecret = Deno.env.get("ONLINE_ORDER_HMAC_SECRET") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const raw = await req.text();
    const signature = req.headers.get("x-webhook-signature") ?? "";

    // ── HMAC verification ──────────────────────────────────────
    // Compute HMAC-SHA256 over the raw body, compare to signature header.
    // In production, replace this with a real constant-time comparison.
    if (hmacSecret) {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(hmacSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
      const computed = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (computed !== signature) {
        return new Response(
          JSON.stringify({ success: false, error: "Invalid webhook signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const payload = JSON.parse(raw);
    const { source = "custom_webstore", order } = payload;

    if (!order) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing order in payload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Persist to online_orders table ─────────────────────────
    const { data, error } = await supabase
      .from("online_orders")
      .insert({
        external_order_id: order.order_id ?? order.id ?? `EXT-${Date.now()}`,
        source,
        customer_name: order.customer?.name ?? "Unknown",
        customer_email: order.customer?.email ?? null,
        customer_phone: order.customer?.phone ?? null,
        customer_address: order.customer?.address ?? null,
        items: order.items ?? [],
        total_amount: order.total ?? order.totalAmount ?? 0,
        status: "pending",
        order_date: order.order_date ?? new Date().toISOString(),
        metadata: order,
      })
      .select()
      .single();

    if (error) {
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: { id: data.id } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
