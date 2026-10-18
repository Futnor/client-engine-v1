import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CLAIM-TRIAL] ${step}${detailsStr}`);
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw new Error(`Auth error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not found");

    logStep("User authenticated", { userId: user.id });

    // Get client IP from headers (Supabase edge functions provide this)
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || "unknown";

    logStep("Client IP", { ip });

    const email = user.email?.toLowerCase() ?? null;

    // Check if this user / email / IP has EVER claimed a trial.
    // Any prior claim — even from this same user — means the trial is used.
    const orFilters = [`user_id.eq.${user.id}`];
    if (email) orFilters.push(`email.eq.${email}`);
    if (ip !== 'unknown') orFilters.push(`ip_address.eq.${ip}`);

    const { data: priorClaims } = await supabase
      .from('trial_claims')
      .select('id')
      .or(orFilters.join(','))
      .limit(1);

    if (priorClaims && priorClaims.length > 0) {
      logStep('Trial already used by this user/email/IP');
      return new Response(JSON.stringify({ eligible: false, reason: 'trial_already_used' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Claim the trial
    const { error: insertError } = await supabase
      .from("trial_claims")
      .insert({ user_id: user.id, email, ip_address: ip });

    if (insertError) {
      logStep("Error claiming trial", { error: insertError.message });
      throw new Error(`Failed to claim trial: ${insertError.message}`);
    }

    logStep("Trial claimed successfully");
    return new Response(JSON.stringify({ eligible: true, already_claimed: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
