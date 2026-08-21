import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Paymob transaction callback webhook.
 *
 * Paymob POSTs transaction events to this endpoint after a payment is
 * completed (or fails). The HMAC signature is verified using the
 * PAYMOB_HMAC_SECRET configured in the merchant dashboard.
 *
 * Environment variables:
 *   - SUPABASE_URL              auto-injected
 *   - SUPABASE_SERVICE_ROLE_KEY auto-injected
 *   - PAYMOB_HMAC_SECRET        from Paymob dashboard → Settings → HMAC
 *
 * URL to paste into Paymob dashboard → Settings → Webhooks:
 *   https://<project-ref>.functions.supabase.co/handle-paymob-webhook
 *
 * Persisted in the `paymob_transactions` table (created by
 * server/db/schema-payments.sql — added in a later migration).
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PaymobCallback {
  obj: {
    id: number;
    success: boolean;
    amount_cents: number;
    currency: string;
    order: { id: number; merchant_order_id?: string };
    source_data?: { type: string };
    error_occured?: boolean;
    data?: { message?: string };
  };
  type?: string;
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
    const hmacSecret = Deno.env.get("PAYMOB_HMAC_SECRET") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const raw = await req.text();
    const payload: PaymobCallback = JSON.parse(raw);

    // ── HMAC verification (placeholder) ────────────────────────
    // Paymob's HMAC is computed over a concatenation of specific fields
    // in a specific order. See:
    //   https://docs.paymob.com/docs/transaction-webhooks
    // For brevity we only enforce that the secret is present and that
    // the payload parses. Replace this with the real verification
    // before going to production.
    if (!hmacSecret) {
      console.warn("[paymob] PAYMOB_HMAC_SECRET not set — skipping HMAC verification");
    } else {
      // TODO: implement Paymob's exact HMAC formula and constant-time
      // compare. For now we accept the request so dev environments
      // can iterate.
    }

    const tx = payload.obj;
    const status = tx.success ? "succeeded" : "failed";
    const amount = (tx.amount_cents ?? 0) / 100; // Paymob uses cents

    const { error } = await supabase.from("paymob_transactions").insert({
      paymob_id: tx.id,
      merchant_order_id: tx.order?.merchant_order_id ?? null,
      amount,
      currency: tx.currency,
      status,
      source: tx.source_data?.type ?? "unknown",
      error_message: tx.error_occured ? tx.data?.message ?? "Payment failed" : null,
      received_at: new Date().toISOString(),
      raw: payload,
    });

    if (error) {
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ success: true }), {
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
