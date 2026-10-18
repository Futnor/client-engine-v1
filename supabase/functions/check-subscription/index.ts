import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });

    if (customers.data.length === 0) {
      logStep("No Stripe customer found");
      return new Response(JSON.stringify({ subscribed: false, has_stripe_customer: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    // Include trialing subscriptions too
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      limit: 5,
    });

    // Find active or trialing subscription
    const activeSub = subscriptions.data.find(s => s.status === 'active' || s.status === 'trialing');
    const hasActiveSub = !!activeSub;
    let productId = null;
    let priceId = null;
    let subscriptionEnd = null;
    let trialDaysLeft = null;

    if (hasActiveSub) {
      const subscription = activeSub;
      
      // Safely convert period end – guard against non-numeric or missing values
      const periodEnd = subscription.current_period_end;
      if (periodEnd && typeof periodEnd === 'number' && periodEnd > 0) {
        try {
          subscriptionEnd = new Date(periodEnd * 1000).toISOString();
        } catch {
          logStep("Failed to parse current_period_end", { periodEnd });
        }
      }

      productId = subscription.items.data[0].price.product;
      priceId = subscription.items.data[0].price.id;
      
      // Check if currently in trial
      if (subscription.status === 'trialing') {
        const trialEnd = subscription.trial_end;
        if (trialEnd && typeof trialEnd === 'number' && trialEnd > 0) {
          try {
            const trialEndDate = new Date(trialEnd * 1000);
            const now = new Date();
            trialDaysLeft = Math.max(0, Math.ceil((trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
          } catch {
            logStep("Failed to parse trial_end", { trialEnd });
          }
        } else {
          // Trialing but no trial_end – use current_period_end as fallback
          if (periodEnd && typeof periodEnd === 'number' && periodEnd > 0) {
            try {
              const fallbackEnd = new Date(periodEnd * 1000);
              const now = new Date();
              trialDaysLeft = Math.max(0, Math.ceil((fallbackEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
            } catch {
              trialDaysLeft = 7; // safe fallback
            }
          } else {
            trialDaysLeft = 7;
          }
        }
      }
      
      logStep("Active subscription found", { productId, priceId, subscriptionEnd, status: subscription.status, trialDaysLeft });

      // ── Auto-migrate intro subscriptions to a schedule ──
      // If the subscription has renewal_price_id metadata and hasn't been
      // migrated yet, create a subscription schedule so the price changes
      // automatically after the first billing period.
      const renewalPriceId = subscription.metadata?.renewal_price_id;
      const alreadyMigrated = subscription.metadata?.schedule_migrated === 'true';

      if (renewalPriceId && !alreadyMigrated && !subscription.schedule && subscription.status !== 'trialing') {
        try {
          logStep("Migrating subscription to schedule", { renewalPriceId });

          // Create a schedule from the existing subscription
          const schedule = await stripe.subscriptionSchedules.create({
            from_subscription: subscription.id,
          });

          // Update the schedule: keep current phase, add a second phase at renewal price
          const currentPhase = schedule.phases[0];
          await stripe.subscriptionSchedules.update(schedule.id, {
            end_behavior: 'release',
            phases: [
              {
                items: [{ price: priceId!, quantity: 1 }],
                start_date: currentPhase.start_date,
                end_date: currentPhase.end_date,
              },
              {
                items: [{ price: renewalPriceId, quantity: 1 }],
                iterations: undefined,
              },
            ],
          });

          // Mark as migrated so we don't repeat
          await stripe.subscriptions.update(subscription.id, {
            metadata: { ...subscription.metadata, schedule_migrated: 'true' },
          });

          logStep("Subscription schedule created", { scheduleId: schedule.id });
        } catch (scheduleErr) {
          logStep("Schedule migration failed (non-fatal)", {
            message: scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr),
          });
        }
      }
    }

    // Also detect "stale" customers — Stripe customer exists but has a
    // non-active sub (canceled, past_due, unpaid, incomplete, etc). These
    // users need access to the billing portal to cancel/manage even
    // though `subscribed` is false. Without this flag, the UI hides the
    // Manage button and they're stuck — case in point: a customer
    // whose trial expired/canceled but couldn't reach Stripe to clean up.
    const hasAnyNonActiveSub = subscriptions.data.length > 0 && !hasActiveSub;

    return new Response(JSON.stringify({
      subscribed: hasActiveSub,
      has_stripe_customer: true,
      has_inactive_subscription: hasAnyNonActiveSub,
      product_id: productId,
      price_id: priceId,
      subscription_end: subscriptionEnd,
      trial_days_left: trialDaysLeft,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
