/**
 * Cancel-subscription edge function.
 *
 * Allows an authenticated user to cancel their own active or trialing
 * Stripe subscription DIRECTLY via the Stripe API — no billing-portal
 * detour required. This is the bullet-proof escape hatch for users who:
 *   • Can't find the cancel button inside Stripe's portal UI
 *   • Have the portal misconfigured (Cancel toggle off in Stripe Dashboard)
 *   • Are on mobile and get confused navigating Stripe's hosted page
 *
 * Behaviour:
 *   • Trialing subs   → canceled IMMEDIATELY (no charge happens anyway,
 *                       so cancel_at_period_end would just keep the
 *                       countdown showing — confusing UX).
 *   • Active subs     → cancel_at_period_end=true so the user keeps the
 *                       benefits they paid for through the end of the
 *                       current billing period.
 *
 * Returns { cancelled: true, mode: 'immediate' | 'at_period_end', sub_id }
 * on success, or { error } on failure.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not configured");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Auth error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (customers.data.length === 0) {
      throw new Error("No Stripe customer found for this account.");
    }
    const customerId = customers.data[0].id;

    // Find an active or trialing subscription to cancel.
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    });
    const targetSub = subs.data.find(s => s.status === 'trialing' || s.status === 'active' || s.status === 'past_due');
    if (!targetSub) {
      throw new Error("No active or trialing subscription found to cancel.");
    }

    console.log(`[CANCEL-SUBSCRIPTION] target sub ${targetSub.id} status=${targetSub.status} for ${user.email}`);

    // Trialing: cancel immediately. The user hasn't been charged and a
    // pending-cancel countdown would just confuse them.
    // Active/past_due: cancel at period end so they keep what they paid
    // for. Stripe will still send the renewal-skipped notice.
    if (targetSub.status === 'trialing') {
      await stripe.subscriptions.cancel(targetSub.id);
      return new Response(JSON.stringify({
        cancelled: true,
        mode: 'immediate',
        sub_id: targetSub.id,
        message: 'Your free trial has been cancelled. You will not be charged.',
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    } else {
      const updated = await stripe.subscriptions.update(targetSub.id, {
        cancel_at_period_end: true,
      });
      const endDate = updated.current_period_end
        ? new Date(updated.current_period_end * 1000).toLocaleDateString()
        : 'the end of your billing period';
      return new Response(JSON.stringify({
        cancelled: true,
        mode: 'at_period_end',
        sub_id: targetSub.id,
        period_end: updated.current_period_end ?? null,
        message: `Your subscription will end on ${endDate}. You'll keep access until then.`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[CANCEL-SUBSCRIPTION] error:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
