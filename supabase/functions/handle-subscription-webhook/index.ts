import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS headers for webhook endpoints
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse webhook payload
    const { event, data } = await req.json();

    console.log("Webhook received:", { event, data });

    // Handle different webhook events
    switch (event) {
      case "subscription.created":
      case "subscription.activated":
        await handleSubscriptionActivated(supabase, data);
        break;

      case "subscription.cancelled":
      case "subscription.expired":
        await handleSubscriptionCancelled(supabase, data);
        break;

      case "subscription.updated":
        await handleSubscriptionUpdated(supabase, data);
        break;

      default:
        console.log("Unhandled event:", event);
    }

    return new Response(
      JSON.stringify({ success: true, message: "Webhook processed successfully" }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

/**
 * Handle subscription activation
 * Updates user's is_pro status to true in profiles table
 */
async function handleSubscriptionActivated(supabase: any, data: any) {
  const { user_id, plan_id, expiry_date } = data;

  // Update user's profile to Pro status
  const { error } = await supabase
    .from("profiles")
    .update({
      is_pro: true,
      subscription_plan: plan_id,
      subscription_expiry: expiry_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user_id);

  if (error) {
    throw new Error(`Failed to activate subscription: ${error.message}`);
  }

  console.log(`Subscription activated for user ${user_id}`);
}

/**
 * Handle subscription cancellation
 * Updates user's is_pro status to false in profiles table
 */
async function handleSubscriptionCancelled(supabase: any, data: any) {
  const { user_id } = data;

  // Update user's profile to Free status
  const { error } = await supabase
    .from("profiles")
    .update({
      is_pro: false,
      subscription_plan: null,
      subscription_expiry: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user_id);

  if (error) {
    throw new Error(`Failed to cancel subscription: ${error.message}`);
  }

  console.log(`Subscription cancelled for user ${user_id}`);
}

/**
 * Handle subscription updates
 * Updates subscription details in profiles table
 */
async function handleSubscriptionUpdated(supabase: any, data: any) {
  const { user_id, plan_id, expiry_date } = data;

  // Update user's subscription details
  const { error } = await supabase
    .from("profiles")
    .update({
      subscription_plan: plan_id,
      subscription_expiry: expiry_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user_id);

  if (error) {
    throw new Error(`Failed to update subscription: ${error.message}`);
  }

  console.log(`Subscription updated for user ${user_id}`);
}
