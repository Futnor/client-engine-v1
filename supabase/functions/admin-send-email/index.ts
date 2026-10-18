import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

const ADMIN_EMAILS = ['admin@futnor.com', 'owner@example.com'];

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
    const adminEmail = userData.user?.email;
    if (!adminEmail || !ADMIN_EMAILS.includes(adminEmail)) {
      return new Response(JSON.stringify({ error: 'Not authorized' }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const body = await req.json().catch(() => ({}));
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();

    if (!subject || subject.length > 200) {
      return new Response(JSON.stringify({ error: 'Subject required (max 200 chars)' }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (!message || message.length > 5000) {
      return new Response(JSON.stringify({ error: 'Message required (max 5000 chars)' }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Build recipient list: either single (recipientEmail) or bulk (recipients[])
    type Recipient = { email: string; name?: string };
    let recipients: Recipient[] = [];

    if (Array.isArray(body.recipients) && body.recipients.length > 0) {
      for (const r of body.recipients) {
        if (typeof r === 'string') {
          recipients.push({ email: r });
        } else if (r && typeof r.email === 'string') {
          recipients.push({ email: r.email, name: r.name ? String(r.name) : undefined });
        }
      }
    } else if (body.recipientEmail) {
      recipients.push({
        email: String(body.recipientEmail),
        name: body.recipientName ? String(body.recipientName).trim() : undefined,
      });
    }

    // Normalize, validate, dedupe
    const seen = new Set<string>();
    recipients = recipients
      .map(r => ({ ...r, email: r.email.trim().toLowerCase() }))
      .filter(r => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return false;
        if (seen.has(r.email)) return false;
        seen.add(r.email);
        return true;
      });

    if (recipients.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid recipients provided' }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (recipients.length > 1000) {
      return new Response(JSON.stringify({ error: 'Maximum 1000 recipients per request' }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let queued = 0;
    let failed = 0;
    const errors: { email: string; error: string }[] = [];
    const batchId = `admin-bulk-${adminEmail}-${Date.now()}`;

    for (const r of recipients) {
      try {
        const idempotencyKey = `${batchId}-${r.email}`;
        const { error } = await supabase.functions.invoke('send-transactional-email', {
          body: {
            templateName: 'admin-message',
            recipientEmail: r.email,
            idempotencyKey,
            templateData: { subject, body: message, name: r.name },
          },
        });
        if (error) throw error;
        queued++;
      } catch (e) {
        failed++;
        errors.push({ email: r.email, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, queued, failed, total: recipients.length, errors }), {
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
