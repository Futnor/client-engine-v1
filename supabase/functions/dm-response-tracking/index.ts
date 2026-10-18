import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

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
    const userId = userData.user?.id;
    if (!userId) throw new Error("Not authenticated");

    const { action, recipients, recipient, platform, instagramAccount, days, timezoneOffsetMinutes, wasFirstContact } = await req.json();

    if (action === 'record-dm') {
      const rawRecipient = Array.isArray(recipients) ? recipients[0] : (recipient ?? recipients);
      const normalized = String(rawRecipient || '').toLowerCase().replace(/^@/, '').trim();
      if (!normalized) {
        return new Response(JSON.stringify({ error: 'Missing recipient username' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
        });
      }

      // wasFirstContact: true = brand-new outreach into an empty thread,
      // false = follow-up into a thread that already had messages,
      // null = caller didn't capture (legacy or recovery path) — keep NULL
      // so the UI can exclude it from first-contact-only metrics.
      const firstContactValue = typeof wasFirstContact === 'boolean' ? wasFirstContact : null;

      const { error: insertError } = await supabase
        .from('dm_tracking')
        .insert({
          user_id: userId,
          recipient_username: normalized,
          platform: platform || 'instagram',
          instagram_account_username: instagramAccount || null,
          was_first_contact: firstContactValue,
        });

      if (insertError) throw insertError;

      return new Response(JSON.stringify({ recorded: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    if (action === 'check-responses') {
      // Given a list of recipient usernames, mark any that have responded
      // The extension calls this with usernames it detected replies from
      if (!Array.isArray(recipients) || recipients.length === 0) {
        return new Response(JSON.stringify({ updated: 0 }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
        });
      }

      let updated = 0;
      for (const username of recipients) {
        const normalized = String(username || '').toLowerCase().replace(/^@/, '').trim();
        if (!normalized) continue;
        const { data } = await supabase
          .from('dm_tracking')
          .update({ responded: true, responded_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('recipient_username', normalized)
          .eq('responded', false)
          .select('id');
        if (data && data.length > 0) updated += data.length;
      }

      return new Response(JSON.stringify({ updated }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    if (action === 'stats') {
      // Validate and clamp `days` (1..365). Default = 14.
      const rawDays = Number(days);
      const windowDays = Number.isFinite(rawDays) && rawDays > 0
        ? Math.min(365, Math.max(1, Math.floor(rawDays)))
        : 14;

      // Timezone offset in minutes (Date.getTimezoneOffset(): UTC - local).
      // Defaults to 0 (UTC) when missing/invalid.
      const tzOffsetMin = Number.isFinite(Number(timezoneOffsetMinutes))
        ? Math.max(-14 * 60, Math.min(14 * 60, Math.floor(Number(timezoneOffsetMinutes))))
        : 0;

      // Compute window cutoff in UTC.
      // We bucket by the user's *local* calendar day, so the cutoff is the
      // start of (today_local - (windowDays - 1) days) converted back to UTC.
      const nowUtc = new Date();
      // Convert "now" -> user-local epoch by subtracting offset.
      const nowLocalMs = nowUtc.getTime() - tzOffsetMin * 60_000;
      const startOfTodayLocalMs = Math.floor(nowLocalMs / 86_400_000) * 86_400_000;
      const startWindowLocalMs = startOfTodayLocalMs - (windowDays - 1) * 86_400_000;
      const cutoffUtcMs = startWindowLocalMs + tzOffsetMin * 60_000;
      const cutoffIso = new Date(cutoffUtcMs).toISOString();

      // Build query — fetch all rows in the window for this user.
      const query = supabase
        .from('dm_tracking')
        .select('id, recipient_username, platform, instagram_account_username, sent_at, responded, responded_at, was_first_contact')
        .eq('user_id', userId)
        .gte('sent_at', cutoffIso)
        .order('sent_at', { ascending: false });

      if (platform) query.eq('platform', platform);
      if (instagramAccount) query.eq('instagram_account_username', instagramAccount);

      const { data: records, error: queryError } = await query.limit(5000);
      if (queryError) throw queryError;

      const rows = records ?? [];
      const total = rows.length;
      const responded = rows.filter(r => r.responded).length;
      const responseRate = total > 0 ? Math.round((responded / total) * 1000) / 10 : 0;

      // Split rows by first-contact vs follow-up. Rows with NULL
      // `was_first_contact` (legacy/recovery sends) are surfaced separately
      // so the UI can show how many sends weren't classified.
      const buildBucket = (subset: typeof rows) => {
        const t = subset.length;
        const r = subset.filter((row) => row.responded).length;
        return {
          total: t,
          responded: r,
          responseRate: t > 0 ? Math.round((r / t) * 1000) / 10 : 0,
        };
      };
      const firstContact = buildBucket(rows.filter((r) => r.was_first_contact === true));
      const followUp = buildBucket(rows.filter((r) => r.was_first_contact === false));
      const unclassified = buildBucket(rows.filter((r) => r.was_first_contact === null || r.was_first_contact === undefined));

      // Helper: convert a UTC ISO timestamp to the user's local YYYY-MM-DD bucket key.
      const toLocalDayKey = (iso: string): string => {
        const t = new Date(iso).getTime();
        if (Number.isNaN(t)) return '';
        const localMs = t - tzOffsetMin * 60_000;
        const d = new Date(localMs);
        // d's UTC fields now represent the user's local calendar date.
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      // Pre-seed every day in the window so the chart shows zeros for empty days.
      const dailyBreakdown: Record<string, { sent: number; responded: number }> = {};
      for (let i = 0; i < windowDays; i++) {
        const dayLocalMs = startOfTodayLocalMs - i * 86_400_000;
        // Build YYYY-MM-DD from the local-day epoch.
        const d = new Date(dayLocalMs);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        dailyBreakdown[`${y}-${m}-${day}`] = { sent: 0, responded: 0 };
      }

      for (const r of rows) {
        const key = toLocalDayKey(r.sent_at);
        if (key && dailyBreakdown[key]) {
          dailyBreakdown[key].sent++;
          if (r.responded) dailyBreakdown[key].responded++;
        }
      }

      return new Response(JSON.stringify({
        total,
        responded,
        responseRate,
        windowDays,
        dailyBreakdown,
        recentDMs: rows.slice(0, 50),
        firstContact,
        followUp,
        unclassified,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
    });
  } catch (error: any) {
    // PostgrestError, AuthError, and other supabase errors are plain
    // objects — NOT Error instances. String(error) on them produces
    // "[object Object]" which is what the user just saw. Extract a
    // readable message from every shape we might catch.
    let msg: string;
    if (error instanceof Error) {
      msg = error.message;
    } else if (error && typeof error === 'object') {
      msg = error.message
        || error.error_description
        || error.error
        || error.hint
        || error.details
        || error.code
        || JSON.stringify(error);
    } else {
      msg = String(error);
    }
    console.error('[DM-RESPONSE-TRACKING] error:', msg, error);
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
});
