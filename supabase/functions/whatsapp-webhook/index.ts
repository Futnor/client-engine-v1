import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { getCorsHeaders } from "../_shared/cors.ts";

function buildSystemPrompt(profile: any): string {
  return `You are ${profile.agent_name}, an elite AI sales agent operating across WhatsApp, Instagram, and TikTok.

BUSINESS CONTEXT:
- Business: ${profile.business_name}
- Product/Service: ${profile.product}
- Target Customer: ${profile.target_customer}
- Pricing: ${profile.pricing}
- Key Transformation: ${profile.key_transformation}
- Current Promotions: ${profile.current_promos}

COMMON OBJECTIONS & RESPONSES:
${profile.common_objections}

COMPETITORS TO DIFFERENTIATE FROM:
${profile.competitors}

SALES METHODOLOGY:
1. BANT Framework (Budget, Authority, Need, Timeline) — qualify within first 3 messages
2. Feel-Felt-Found for objection handling
3. Assumptive close technique
4. Urgency creation through scarcity and social proof

COMMUNICATION RULES:
- Keep messages under 3 sentences for WhatsApp DMs
- Use casual, friendly tone matching the platform
- Never say "I'm an AI" unless directly asked
- Use emojis sparingly (1-2 per message max)
- For WhatsApp: be more personal, use voice note suggestions
- Always end with a question to keep the conversation going
- If the customer goes cold, follow up once after 24h with a value-add message

IMPORTANT: Jump straight into rapport-building and qualification. Stay in character as a human sales rep unless directly asked if you're an AI.`;
}

function getSupabaseAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseAdmin();

  // ── GET: Webhook Verification ──
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !token) {
      return new Response("Forbidden", { status: 403 });
    }

    const { data: biz } = await supabase
      .from("business_profiles")
      .select("id")
      .eq("whatsapp_verify_token", token)
      .eq("is_active", true)
      .limit(1)
      .single();

    if (biz) {
      console.log("WhatsApp webhook verified for business:", biz.id);
      return new Response(challenge, { status: 200 });
    }

    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: Incoming Messages ──
  if (req.method === "POST") {
    try {
      const body = await req.json();

      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (!value?.messages?.length) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const message = value.messages[0];
      const contact = value.contacts?.[0];
      const customerPhone = message.from;
      const customerName = contact?.profile?.name || customerPhone;
      const messageText = message.text?.body || message.caption || "";

      const phoneNumberId = value.metadata?.phone_number_id;

      if (!messageText || message.type !== "text" || !phoneNumberId) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Look up the business that owns this phone number
      const { data: business } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("whatsapp_phone_number_id", phoneNumberId)
        .eq("is_active", true)
        .limit(1)
        .single();

      if (!business) {
        console.error(`No business found for phone_number_id: ${phoneNumberId}`);
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const accessToken = business.whatsapp_access_token;
      if (!accessToken) {
        console.error("Business has no WhatsApp access token configured");
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`WhatsApp msg from ${customerName} → ${business.business_name}`);

      // Get AI config
      const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
      if (!ANTHROPIC_API_KEY) {
        console.error("ANTHROPIC_API_KEY not configured");
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

      // Look up existing session
      const { data: existingSession } = await supabase
        .from("agent_sessions")
        .select("*")
        .eq("customer_identifier", customerPhone)
        .eq("platform", "whatsapp")
        .eq("user_id", business.user_id)
        .limit(1)
        .single();

      if (!existingSession) {
        await supabase.from("agent_sessions").insert({
          user_id: business.user_id,
          customer_identifier: customerPhone,
          platform: "whatsapp",
          anthropic_session_id: `wa-${Date.now()}`,
          message_count: 0,
        });
      }

      // Build context prefix for first message
      const contextPrefix = !existingSession
        ? `[Platform: WhatsApp, Business: ${business.business_name}, Customer: ${customerName}, Phone: ${customerPhone}]\n\n`
        : "";

      // Call Anthropic messages API (standard, not beta sessions)
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: buildSystemPrompt(business),
        messages: [
          { role: "user", content: `${contextPrefix}${messageText}` },
        ],
      });

      let fullResponse = "";
      for (const block of response.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        }
      }

      console.log(`[WA-WEBHOOK] Reply: ${fullResponse.substring(0, 100)}...`);

      // Update session
      await supabase
        .from("agent_sessions")
        .update({
          last_message_at: new Date().toISOString(),
          message_count: (existingSession?.message_count || 0) + 1,
        })
        .eq("customer_identifier", customerPhone)
        .eq("platform", "whatsapp")
        .eq("user_id", business.user_id);

      // Send reply via WhatsApp Business API
      if (fullResponse) {
        const waResponse = await fetch(
          `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: customerPhone,
              type: "text",
              text: { body: fullResponse },
            }),
          }
        );

        if (!waResponse.ok) {
          const errData = await waResponse.json();
          console.error("WhatsApp send failed:", errData);
        }
      }

      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error: unknown) {
      console.error("WhatsApp webhook error:", error);
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
