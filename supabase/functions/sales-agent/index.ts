import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

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
- Keep messages under 3 sentences for WhatsApp/Instagram/TikTok DMs
- Use casual, friendly tone matching the platform
- Never say "I'm an AI" unless directly asked
- Use emojis sparingly (1-2 per message max)
- For Instagram: be visual, reference stories/reels
- For TikTok: be trendy, use platform-native language
- For WhatsApp: be more personal, use voice note suggestions
- Always end with a question to keep the conversation going
- If the customer goes cold, follow up once after 24h with a value-add message
- Read the full conversation history to understand the customer's needs and objections before responding
- Reference previous messages naturally to show you remember the conversation

IMPORTANT: Jump straight into rapport-building and qualification. Stay in character as a human sales rep unless directly asked if you're an AI.`;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "AI agent not configured. Contact support." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: userData, error: userError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const userId = userData.user.id;

    const body = await req.json();
    const { action } = body;

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    // ── ONBOARD ──
    if (action === "onboard") {
      const {
        agentName, businessName, product, targetCustomer, pricing,
        commonObjections, competitors, keyTransformation, currentPromos,
      } = body;

      const {
        whatsappPhoneNumberId, whatsappAccessToken, whatsappVerifyToken,
      } = body;

      const profile = {
        agent_name: agentName || "Sales Agent",
        business_name: businessName || "",
        product: product || "",
        target_customer: targetCustomer || "",
        pricing: pricing || "",
        common_objections: commonObjections || "",
        competitors: competitors || "",
        key_transformation: keyTransformation || "",
        current_promos: currentPromos || "",
        whatsapp_phone_number_id: whatsappPhoneNumberId || "",
        whatsapp_access_token: whatsappAccessToken || "",
        whatsapp_verify_token: whatsappVerifyToken || "",
      };

      // System prompt is applied per-session at chat time via agent config

      // Upsert business profile in DB
      const { data: existing } = await supabase
        .from("business_profiles")
        .select("id")
        .eq("user_id", userId)
        .limit(1)
        .single();

      if (existing) {
        await supabase
          .from("business_profiles")
          .update({ ...profile, is_active: true })
          .eq("id", existing.id);
      } else {
        await supabase
          .from("business_profiles")
          .insert({ ...profile, user_id: userId, is_active: true });
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── CHAT ──
    if (action === "chat") {
      const { customerIdentifier, customerMessage, platform, conversationHistory } = body;

      if (!customerIdentifier || !customerMessage) {
        return new Response(
          JSON.stringify({ error: "customerIdentifier and customerMessage are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get business profile for system prompt
      const { data: profile } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true)
        .limit(1)
        .single();

      if (!profile) {
        return new Response(
          JSON.stringify({ error: "No business profile found. Complete onboarding first." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Look up existing session
      const { data: existingSession } = await supabase
        .from("agent_sessions")
        .select("*")
        .eq("user_id", userId)
        .eq("customer_identifier", customerIdentifier)
        .eq("platform", platform || "instagram")
        .limit(1)
        .single();

      if (!existingSession) {
        await supabase.from("agent_sessions").insert({
          user_id: userId,
          customer_identifier: customerIdentifier,
          platform: platform || "instagram",
          anthropic_session_id: `local-${Date.now()}`,
          message_count: 0,
        });
      }

      // Build messages array from conversation history
      const messages: { role: string; content: string }[] = [];

      if (conversationHistory && Array.isArray(conversationHistory)) {
        for (const msg of conversationHistory) {
          messages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: msg.content,
          });
        }
      }

      // Add current message
      const contextPrefix = !existingSession
        ? `[Platform: ${platform || "instagram"}, Customer: ${customerIdentifier}]\n\n`
        : "";
      messages.push({ role: "user", content: `${contextPrefix}${customerMessage}` });

      console.log(`[SALES-AGENT] Chat request: customer=${customerIdentifier}, platform=${platform}, messages=${messages.length}`);

      // Call Anthropic messages API
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: buildSystemPrompt(profile),
        messages: messages as any,
      });

      let fullResponse = "";
      for (const block of response.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        }
      }

      console.log(`[SALES-AGENT] Reply generated: ${fullResponse.substring(0, 100)}...`);

      // Update session in DB
      await supabase
        .from("agent_sessions")
        .update({
          last_message_at: new Date().toISOString(),
          message_count: (existingSession?.message_count || 0) + 1,
        })
        .eq("user_id", userId)
        .eq("customer_identifier", customerIdentifier)
        .eq("platform", platform || "instagram");

      return new Response(
        JSON.stringify({
          reply: fullResponse,
          isNewSession: !existingSession,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── LIST SESSIONS ──
    if (action === "list-sessions") {
      const { data: sessions } = await supabase
        .from("agent_sessions")
        .select("*")
        .eq("user_id", userId)
        .order("last_message_at", { ascending: false })
        .limit(50);

      return new Response(
        JSON.stringify({ sessions: sessions || [] }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── GET PROFILE ──
    if (action === "get-profile") {
      const { data: profile } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true)
        .limit(1)
        .single();

      return new Response(
        JSON.stringify({ profile }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── GET AGENT STATUS ──
    if (action === "get-agent-status") {
      return new Response(
        JSON.stringify({
          name: "Sales Agent",
          status: "active",
          model: "claude-sonnet-4-20250514",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Sales agent error:", error);
    const message = error instanceof Error ? error.message : "Internal error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
