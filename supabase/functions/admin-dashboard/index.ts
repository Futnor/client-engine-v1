import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

const ADMIN_EMAILS = ['admin@futnor.com', 'owner@example.com'];

// Tier mapping must match src/lib/subscriptionTiers.ts
const TIER_PRODUCTS: Record<string, { name: string; price: number }> = {
  prod_UIUkFeugr2w1W5: { name: 'Launch', price: 15 },
  prod_UIUkrkXSkFVkOS: { name: 'Growth', price: 29 },
  prod_UJag61rV7yysI0: { name: 'Growth', price: 49 }, // renewal
  prod_UIUkRqudp8lQqo: { name: 'Scale', price: 129 },
  prod_UJagf1BmWz66EV: { name: 'Scale', price: 250 }, // renewal
};

const TRIAL_DAYS = 7;

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
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
    const email = userData.user?.email;
    if (!email || !ADMIN_EMAILS.includes(email)) {
      return new Response(JSON.stringify({ error: 'Not authorized' }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Stripe init wrapped in try/catch — an invalid API version or missing
    // key shouldn't take the whole admin dashboard down with it.
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    let stripe: Stripe | null = null;
    if (stripeKey) {
      try {
        stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" as any });
      } catch (e) {
        console.error("Stripe init failed:", e);
        stripe = null;
      }
    }

    // ── Resilient parallel fetch ─────────────────────────────────────────
    // Use Promise.allSettled so one failing query (e.g. a table that got
    // renamed/dropped, an RLS policy mismatch) doesn't crash the whole
    // dashboard. Each missing dataset just becomes an empty array. The
    // admin still sees the rest of the panel and can investigate. We log
    // every failure to console so it shows up in Supabase function logs.
    const queries = [
      { name: 'users',            run: () => supabase.auth.admin.listUsers({ perPage: 1000 }) },
      { name: 'profiles',         run: () => supabase.from('profiles').select('*').order('created_at', { ascending: false }) },
      { name: 'sessions',         run: () => supabase.from('session_history').select('*').order('created_at', { ascending: false }).limit(500) },
      { name: 'business_profiles',run: () => supabase.from('business_profiles').select('*').order('created_at', { ascending: false }) },
      { name: 'agent_sessions',   run: () => supabase.from('agent_sessions').select('*').order('created_at', { ascending: false }).limit(200) },
      { name: 'trial_claims',     run: () => supabase.from('trial_claims').select('*').order('claimed_at', { ascending: false }) },
      { name: 'api_keys',         run: () => supabase.from('api_keys').select('id, key_prefix, label, created_at, last_used_at, revoked, user_id') },
      { name: 'outreach_profiles',run: () => supabase.from('outreach_profiles').select('*').order('created_at', { ascending: false }) },
      { name: 'email_send_log',   run: () => supabase.from('email_send_log').select('*').order('created_at', { ascending: false }).limit(500) },
    ];

    const settled = await Promise.allSettled(queries.map(q => q.run()));
    const queryResults: Record<string, any> = {};
    settled.forEach((res, i) => {
      const name = queries[i].name;
      if (res.status === 'rejected') {
        console.error(`Query failed [${name}]:`, res.reason);
        queryResults[name] = { data: null, error: res.reason };
      } else {
        const r: any = res.value;
        if (r?.error) console.error(`Query returned error [${name}]:`, r.error.message || r.error);
        queryResults[name] = r;
      }
    });

    const users            = queryResults.users?.data?.users            ?? [];
    const profiles         = queryResults.profiles?.data                ?? [];
    const sessions         = queryResults.sessions?.data                ?? [];
    const businessProfiles = queryResults.business_profiles?.data       ?? [];
    const agentSessions    = queryResults.agent_sessions?.data          ?? [];
    const trialClaims      = queryResults.trial_claims?.data            ?? [];
    const apiKeys          = queryResults.api_keys?.data                ?? [];
    const outreachProfiles = queryResults.outreach_profiles?.data       ?? [];
    const emailLogs        = queryResults.email_send_log?.data          ?? [];

    // ----- Stripe: subscriptions, invoices -----
    type SubInfo = { email: string; tier: string; price: number; status: string; current_period_end: number | null; trial_end: number | null; created: number };
    const subsByEmail = new Map<string, SubInfo>();
    const planCounts: Record<string, { count: number; revenue: number; price: number }> = {
      Launch: { count: 0, revenue: 0, price: 15 },
      Growth: { count: 0, revenue: 0, price: 29 },
      Scale: { count: 0, revenue: 0, price: 129 },
    };
    let mtdRevenue = 0;
    let yearRevenue = 0;
    let recentTransactions: { description: string; date: number; amount: number; currency: string }[] = [];

    if (stripe) {
      try {
        // List all active+trialing subscriptions (paginated)
        const allSubs: any[] = [];
        let starting_after: string | undefined;
        for (let i = 0; i < 10; i++) { // up to 1000 subs
          const page = await stripe.subscriptions.list({ status: 'all', limit: 100, starting_after, expand: ['data.customer'] });
          allSubs.push(...page.data);
          if (!page.has_more) break;
          starting_after = page.data[page.data.length - 1]?.id;
        }

        for (const sub of allSubs) {
          const cust: any = sub.customer;
          const custEmail = (typeof cust === 'object' && cust?.email) ? String(cust.email).toLowerCase() : null;
          const productId = sub.items?.data?.[0]?.price?.product as string | undefined;
          const tierInfo = productId ? TIER_PRODUCTS[productId] : undefined;
          if (!tierInfo) continue;

          // Track ALL subs, not just active ones — so the admin can see
          // 'expired' status for users whose sub got canceled, and so the
          // status='expired' branch in user-detail logic has a record to
          // hit. Active/trialing/past_due take precedence (overwrite later
          // canceled entries) because Map.set replaces.
          if (custEmail) {
            const existing = subsByEmail.get(custEmail);
            const isCurrentActive = existing && ['active', 'trialing', 'past_due'].includes(existing.status);
            const isNewActive = ['active', 'trialing', 'past_due'].includes(sub.status);
            // Only overwrite when the new sub is active OR no entry exists yet.
            if (!existing || isNewActive || !isCurrentActive) {
              subsByEmail.set(custEmail, {
                email: custEmail,
                tier: tierInfo.name,
                price: tierInfo.price,
                status: sub.status,
                current_period_end: sub.current_period_end ?? null,
                trial_end: sub.trial_end ?? null,
                created: sub.created,
              });
            }
            if (sub.status === 'active' || sub.status === 'past_due') {
              planCounts[tierInfo.name].count += 1;
              planCounts[tierInfo.name].revenue += tierInfo.price;
            }
          }
        }

        // Recent invoices for MTD/year revenue + transactions
        const now = new Date();
        const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
        const yearStart = Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
        const invoicePages: any[] = [];
        let inv_starting_after: string | undefined;
        for (let i = 0; i < 5; i++) {
          const page = await stripe.invoices.list({ status: 'paid', limit: 100, starting_after: inv_starting_after, created: { gte: yearStart } });
          invoicePages.push(...page.data);
          if (!page.has_more) break;
          inv_starting_after = page.data[page.data.length - 1]?.id;
        }
        for (const inv of invoicePages) {
          const amt = (inv.amount_paid ?? 0) / 100;
          yearRevenue += amt;
          if ((inv.created ?? 0) >= monthStart) mtdRevenue += amt;
        }
        recentTransactions = invoicePages
          .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
          .slice(0, 20)
          .map(inv => ({
            description: `${inv.customer_email || 'Customer'} — ${inv.lines?.data?.[0]?.description || 'subscription'}`,
            date: inv.created ?? 0,
            amount: (inv.amount_paid ?? 0) / 100,
            currency: (inv.currency || 'usd').toUpperCase(),
          }));
      } catch (e) {
        console.error('Stripe fetch failed:', e);
      }
    }

    // ----- Stats -----
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const usersLast24h = users.filter(u => new Date(u.created_at) > last24h).length;
    const usersLast7d = users.filter(u => new Date(u.created_at) > last7d).length;
    const usersLast30d = users.filter(u => new Date(u.created_at) > last30d).length;

    const sessionsLast24h = sessions.filter(s => new Date(s.created_at) > last24h).length;
    const sessionsLast7d = sessions.filter(s => new Date(s.created_at) > last7d).length;

    const totalDMs = sessions.reduce((sum, s) => sum + (s.dms_sent || 0), 0);
    const totalLikes = sessions.reduce((sum, s) => sum + (s.likes_sent || 0), 0);
    const totalFollows = sessions.reduce((sum, s) => sum + (s.follows_sent || 0), 0);
    const totalSessionTime = sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);

    const activeUserIds = new Set(sessions.filter(s => new Date(s.created_at) > last7d).map(s => s.user_id));

    // Build user details enriched with subscription info
    const userDetails = users.map(u => {
      const profile = profiles.find(p => p.id === u.id);
      const userSessions = sessions.filter(s => s.user_id === u.id);
      const userBizProfiles = businessProfiles.filter(bp => bp.user_id === u.id);
      const userAgentSessions = agentSessions.filter(as => as.user_id === u.id);
      const trialClaim = trialClaims.find(tc => tc.user_id === u.id);
      const sub = u.email ? subsByEmail.get(u.email.toLowerCase()) : undefined;

      // Trial calculation — Stripe is the source of truth as of the
      // create-checkout fix that stopped the premature trial_claims insert.
      // Only users with an actual Stripe subscription (any status) are
      // considered to have started a trial.
      const isPaid = !!sub && (sub.status === 'active' || sub.status === 'past_due');
      const isTrialing = !!sub && sub.status === 'trialing';

      let trialDaysLeft: number | null = null;
      let trialStartedAt: string | null = null;
      let trialExpiredAt: string | null = null;
      if (isTrialing && sub?.trial_end) {
        const expiresMs = sub.trial_end * 1000;
        trialExpiredAt = new Date(expiresMs).toISOString();
        const msLeft = expiresMs - now.getTime();
        trialDaysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
      }
      if (sub?.created) {
        trialStartedAt = new Date(sub.created * 1000).toISOString();
      }
      // Fallback for very old trial_claims rows when there's no Stripe sub
      // (legacy data prior to the Stripe-only refactor). Not used for
      // status decisions — just so the admin can see the orphan timestamp.
      if (!trialStartedAt && trialClaim) {
        trialStartedAt = new Date(trialClaim.claimed_at).toISOString();
      }

      // Source: Stripe-confirmed only (the only kind that exists going
      // forward). Kept as a field for analytics + future webhook support.
      const trialSource: 'stripe' | 'manual' | null = isTrialing ? 'stripe' : null;

      let status: 'paid' | 'trial' | 'expired' | 'free' = 'free';
      if (isPaid) status = 'paid';
      else if (isTrialing) status = 'trial';
      // "Expired" = had ANY past Stripe sub that's no longer trialing/active.
      // Catches canceled, unpaid, incomplete_expired, etc.
      else if (sub && !['trialing', 'active', 'past_due'].includes(sub.status)) {
        status = 'expired';
      }

      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        display_name: profile?.display_name,
        instagram_username: profile?.instagram_username,
        tiktok_username: profile?.tiktok_username,
        total_sessions: userSessions.length,
        total_dms: userSessions.reduce((s, ss) => s + (ss.dms_sent || 0), 0),
        total_likes: userSessions.reduce((s, ss) => s + (ss.likes_sent || 0), 0),
        total_follows: userSessions.reduce((s, ss) => s + (ss.follows_sent || 0), 0),
        has_business_profile: userBizProfiles.length > 0,
        agent_conversations: userAgentSessions.length,
        has_trial: !!trialClaim,
        status,
        trial_source: trialSource,
        plan: sub?.tier ?? null,
        plan_price: sub?.price ?? null,
        trial_started_at: trialStartedAt,
        trial_expires_at: trialExpiredAt,
        trial_days_left: trialDaysLeft,
      };
    });

    const paidCount = userDetails.filter(u => u.status === 'paid').length;
    const trialCount = userDetails.filter(u => u.status === 'trial').length;
    const expiredTrialCount = userDetails.filter(u => u.status === 'expired').length;
    const trialToPaid = userDetails.filter(u => u.has_trial && u.status === 'paid').length;
    const trialConversionRate = trialClaims.length > 0
      ? Math.round((trialToPaid / trialClaims.length) * 1000) / 10
      : 0;

    // Dedupe email logs by message_id (latest only)
    const seenMsg = new Set<string>();
    const dedupedEmails = emailLogs.filter(e => {
      if (!e.message_id) return true;
      if (seenMsg.has(e.message_id)) return false;
      seenMsg.add(e.message_id);
      return true;
    });

    return new Response(JSON.stringify({
      stats: {
        totalUsers: users.length,
        usersLast24h, usersLast7d, usersLast30d,
        activeUsersLast7d: activeUserIds.size,
        totalSessions: sessions.length,
        sessionsLast24h, sessionsLast7d,
        totalDMs, totalLikes, totalFollows,
        totalSessionTimeHours: Math.round(totalSessionTime / 3600 * 10) / 10,
        totalBusinessProfiles: businessProfiles.length,
        totalAgentConversations: agentSessions.length,
        totalTrialClaims: trialClaims.length,
        totalApiKeys: apiKeys.length,
        totalOutreachProfiles: outreachProfiles.length,
        paidSubscribers: paidCount,
        activeTrials: trialCount,
        expiredTrials: expiredTrialCount,
        trialConversionRate,
        trialAvgLength: TRIAL_DAYS,
        mtdRevenue,
        yearRevenue,
        planBreakdown: planCounts,
      },
      users: userDetails,
      recentSessions: sessions.slice(0, 50),
      recentTransactions,
      recentEmails: dedupedEmails.slice(0, 100),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
