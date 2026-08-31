import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Shipping carrier status-update webhook.
 *
 * Carriers (Bosta / Aramex / MyShipping / etc.) POST shipment status
 * changes to this endpoint. The system verifies the signature and
 * updates the corresponding courier_financials row + ecommerce order.
 *
 * Environment variables:
 *   - SUPABASE_URL              auto-injected
 *   - SUPABASE_SERVICE_ROLE_KEY auto-injected
 *   - SHIPPING_WEBHOOK_SECRET   shared with the carrier
 *
 * URL to register with the carrier:
 *   https://<project-ref>.functions.supabase.co/handle-shipping-webhook
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ShippingStatusPayload {
  tracking_id: string;
  status: "picked_up" | "in_transit" | "out_for_delivery" | "delivered" | "returned" | "failed";
  courier: string;
  delivered_at?: string;
  failure_reason?: string;
  raw?: Record<string, unknown>;
}

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
    const secret = Deno.env.get("SHIPPING_WEBHOOK_SECRET") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const raw = await req.text();
    const signature = req.headers.get("x-webhook-signature") ?? "";

    // HMAC verification
    if (secret) {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
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
          JSON.stringify({ success: false, error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const payload: ShippingStatusPayload = JSON.parse(raw);

    // Map carrier status to internal ecommerce_order status
    const statusMap: Record<string, string> = {
      picked_up: "shipped",
      in_transit: "shipped",
      out_for_delivery: "shipped",
      delivered: "delivered",
      returned: "returned",
      failed: "returned",
    };
    const internalStatus = statusMap[payload.status] ?? "shipped";

    // Update the order
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .update({
        status: internalStatus,
        delivered_at: payload.delivered_at ?? null,
        failure_reason: payload.failure_reason ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("tracking_id", payload.tracking_id)
      .select()
      .single();

    if (orderErr) {
      console.warn("[shipping-webhook] no matching order", orderErr.message);
    }

    // If delivered, mark courier financials as reconciled-ready
    if (payload.status === "delivered" && order) {
      await supabase
        .from("courier_financials")
        .update({ status: "pending" }) // still pending admin reconciliation
        .eq("order_id", order.id);
    }

    return new Response(JSON.stringify({ success: true, status: internalStatus }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
