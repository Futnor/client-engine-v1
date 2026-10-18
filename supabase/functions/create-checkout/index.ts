import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

// Maps intro priceId → renewal priceId for subscription-schedule pricing
const INTRO_TO_RENEWAL: Record<string, string> = {
  // Growth: $29 intro → $49 renewal
  'price_1TJtkyJUNIkx2ukikbhldH6d': 'price_1TKxUsJUNIkx2ukihePaJHOJ',
  // Scale: $129 intro → $250 renewal
  'price_1TJtlFJUNIkx2ukiGH7cQXD3': 'price_1TKxVFJUNIkx2uki29R1qRUc',
};

const BLOCKED_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active', 'past_due', 'incomplete']);
// If the customer has EVER had a subscription with one of these statuses,
// they have already consumed (or are consuming) a free trial and cannot get another.
const TRIAL_CONSUMED_STATUSES = new Set([
  'trialing', 'active', 'past_due', 'incomplete', 'incomplete_expired',
  'canceled', 'unpaid', 'paused',
]);

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  // Use SERVICE ROLE so we can read & insert into trial_claims (RLS-protected)
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");

    const { priceId, withTrial } = await req.json();
    if (!priceId) throw new Error("priceId is required");

    const email = user.email.toLowerCase();
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || "unknown";

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;

      const existingSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });

      const blockingSubscription = existingSubscriptions.data.find((subscription) =>
        BLOCKED_SUBSCRIPTION_STATUSES.has(subscription.status)
      );

      if (blockingSubscription) {
        throw new Error(
          blockingSubscription.status === 'trialing'
            ? 'You already have an active free trial. You will not be charged until the trial ends.'
            : 'You already have an active subscription. Please manage your existing plan instead of starting a new checkout.'
        );
      }

      // ── Trial-abuse check #1: prior Stripe history ──
      // If this email has ANY past subscription on Stripe (including canceled
      // ones from a failed trial), they cannot start another free trial.
      if (withTrial) {
        const usedAnyTrial = existingSubscriptions.data.some((s) =>
          TRIAL_CONSUMED_STATUSES.has(s.status) || s.trial_end || s.trial_start
        );
        if (usedAnyTrial) {
          throw new Error(
            'You have already used your free trial. Please choose a paid plan to continue.'
          );
        }
      }
    }

    // ── Trial-abuse: Stripe-only enforcement ──────────────────────────────
    // We used to ALSO check the `trial_claims` table here and insert a row
    // BEFORE returning the Stripe Checkout URL. That created a UX bug:
    // users who abandoned the Stripe page (didn't enter card details, no
    // subscription ever created) were still locked in as "trial used" and
    // couldn't pick a different plan. The trial_claims insert ran whether
    // or not the user actually finished the flow.
    //
    // New rule: Stripe is the only source of truth. Check #1 above already
    // covers all trial-abuse cases — any past Stripe subscription
    // (trialing, canceled, unpaid, etc.) means trial-consumed. If the user
    // never reached Stripe (or abandoned Checkout), there's no subscription
    // and we let them retry freely.

    const origin = req.headers.get("origin") || "http://localhost:3000";
    const renewalPriceId = INTRO_TO_RENEWAL[priceId];

    let sessionUrl: string | null;

    if (renewalPriceId) {
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        customer_email: customerId ? undefined : user.email,
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${origin}/app?checkout=success`,
        cancel_url: `${origin}/pricing`,
        metadata: { renewal_price_id: renewalPriceId },
        ...(withTrial ? { payment_method_collection: 'always' } : {}),
        subscription_data: {
          metadata: { renewal_price_id: renewalPriceId, intro_price_id: priceId },
          ...(withTrial ? {
            trial_period_days: 7,
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          } : {}),
        },
      });
      sessionUrl = session.url;
    } else {
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        customer_email: customerId ? undefined : user.email,
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${origin}/app?checkout=success`,
        cancel_url: `${origin}/pricing`,
        ...(withTrial ? {
          payment_method_collection: 'always',
          subscription_data: {
            trial_period_days: 7,
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          },
        } : {}),
      });
      sessionUrl = session.url;
    }

    // No upfront trial_claims insert (see comment above check #1). Stripe
    // is the source of truth. If/when a webhook handler is added for
    // customer.subscription.created, we could populate trial_claims there
    // for analytics, but it's NEVER used to block re-attempts anymore.

    return new Response(JSON.stringify({ url: sessionUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
