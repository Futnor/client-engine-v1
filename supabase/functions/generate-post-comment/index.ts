import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

/**
 * generate-post-comment  (v2.0 — tier-gated AI Response Booster)
 * --------------------------------------------------
 * Generates ONE highly-accurate, human-like Instagram comment of 7–16 words
 * that ends with a soft, natural CTA so the recipient checks their messages.
 *
 * TIER GATING:
 *  - free / launch  → 403 (feature not available)
 *  - growth          → max 25 comments per UTC day per user (across ALL their accounts)
 *  - scale / admin   → unlimited
 *
 * Counts are tracked in `public.ai_post_comment_usage` (one row per user/day).
 */

const ADMIN_EMAILS = ["admin@futnor.com", "owner@example.com"];
const SCALE_REVIEWER_EMAILS = ["reviewer@example.com"];
const GROWTH_DAILY_LIMIT = 25;

// Stripe product IDs → tier
const TIER_PRODUCT_IDS: Record<string, "launch" | "growth" | "scale"> = {
  prod_UIUkFeugr2w1W5: "launch",
  prod_UIUkrkXSkFVkOS: "growth",
  prod_UJag61rV7yysI0: "growth", // growth renewal
  prod_UIUkRqudp8lQqo: "scale",
  prod_UJagf1BmWz66EV: "scale", // scale renewal
};

const SYSTEM_PROMPT = `You analyze an Instagram post or reel and generate ONE highly accurate, human-like Instagram comment that feels written by a real person who actually watched it.

INPUT YOU MAY RECEIVE:
- Post image (url)
- Caption text
- Username
- Bio
- Topic / niche hint

YOUR JOB:
1. Understand what the content is about from the image + caption.
2. Detect category: personal/selfie/lifestyle, attractive/fashion/beauty, fitness, business, food, travel, music, motivation, meme/funny, other.
3. Detect tone/mood: confident, classy, playful, luxury, funny, inspiring, casual, energetic, emotional, etc.
4. Generate ONE natural comment that feels written by a real person.

COMMENT STRUCTURE:
{Specific compliment about content / look / vibe / result} + {clear soft CTA to notice messages}

CTA GOAL:
The person must easily understand they should check their messages, but it must still sound natural and low-spam.

DO NOT USE: "check dm", "check inbox", "dm me", "📩", "message me now", urgent language.

USE NATURAL CTA EXAMPLES:
- sent you something helpful
- sent you a quick message
- left you a quick message
- sent you a quick idea
- dropped you a message
- left you something useful
- sent something your way
- left you a note

STRICT RULES:
- Must be accurate to the content.
- Must feel personal.
- Never generic comments like "nice pic" / "nice post".
- Never creepy, thirsty, desperate, robotic, or weird.
- Never mention bots, marketing, automation.
- 7 to 16 words total.
- Smooth grammar. Human tone.
- No hashtags.
- Max 1 emoji, occasionally.
- Return ONLY the final comment text — no quotes, no labels, no explanation.

EXAMPLES:
- Selfie: You look unreal here, sent you a quick message
- Fashion mirror: Clean fit honestly, left you a quick message
- Baddie reel: Elite energy here, sent you something helpful
- Gym reel: Strong progress here, sent you a quick idea
- Food reel: That looks perfect, dropped you a message
- Business quote: Real point there, left you something useful
- Travel post: Crazy views there, sent you a quick message`;

function clampWords(text: string): string {
  let t = (text || "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  t = t.split(/\r?\n/)[0].trim();
  t = t.replace(/^(comment|reply|caption)\s*[:\-]\s*/i, "").trim();
  t = t.replace(/#\w+/g, "").replace(/\s{2,}/g, " ").trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 18) {
    t = words.slice(0, 16).join(" ");
  }
  return t;
}

async function resolveTierFromStripe(email: string): Promise<"free" | "launch" | "growth" | "scale"> {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return "free";
  try {
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return "free";
    const subs = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: "all",
      limit: 5,
    });
    const active = subs.data.find((s) => s.status === "active" || s.status === "trialing");
    if (!active) return "free";
    const productId = String(active.items.data[0]?.price?.product || "");
    return TIER_PRODUCT_IDS[productId] || "free";
  } catch (e) {
    console.error("[generate-post-comment] Stripe tier resolution failed:", e);
    return "free";
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized origin" }), {
      status: 403,
      headers: corsHeaders,
    });
  }

  try {
    // ── 1. Authenticate the caller ────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;
    const userEmail = (user.email || "").toLowerCase();

    // ── 2. Resolve tier ───────────────────────────────────────────────────
    let tier: "free" | "launch" | "growth" | "scale" | "admin" = "free";
    if (ADMIN_EMAILS.includes(userEmail)) {
      tier = "admin";
    } else if (SCALE_REVIEWER_EMAILS.includes(userEmail)) {
      tier = "scale";
    } else if (userEmail) {
      tier = await resolveTierFromStripe(userEmail);
    }

    // ── 3. Tier gating ────────────────────────────────────────────────────
    const isUnlimited = tier === "admin" || tier === "scale";
    const isGrowth = tier === "growth";

    if (!isUnlimited && !isGrowth) {
      return new Response(
        JSON.stringify({
          error: "AI Response Booster is available on the Growth and Scale plans only.",
          tier,
          upgradeRequired: true,
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 4. Daily quota check (Growth only) ────────────────────────────────
    const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    let currentCount = 0;
    if (isGrowth) {
      const { data: existing } = await supabaseAdmin
        .from("ai_post_comment_usage")
        .select("count")
        .eq("user_id", user.id)
        .eq("usage_date", today)
        .maybeSingle();
      currentCount = existing?.count ?? 0;
      if (currentCount >= GROWTH_DAILY_LIMIT) {
        return new Response(
          JSON.stringify({
            error: `Daily AI Response Booster limit reached (${GROWTH_DAILY_LIMIT}/day). Upgrade to Scale for unlimited.`,
            tier,
            limit: GROWTH_DAILY_LIMIT,
            used: currentCount,
            quotaExceeded: true,
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── 5. Validate input ─────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const {
      caption = "",
      imageUrl = "",
      username = "",
      bio = "",
      topic = "",
      isReel = false,
    } = body || {};

    if (!caption && !imageUrl && !username) {
      return new Response(
        JSON.stringify({ error: "Need at least one of: caption, imageUrl, username" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const summaryLines = [
      isReel ? "Content type: Instagram REEL" : "Content type: Instagram POST",
      username ? `Account username: @${username}` : "",
      bio ? `Account bio: ${bio.slice(0, 280)}` : "",
      topic ? `Niche/topic hint: ${topic.slice(0, 120)}` : "",
      caption ? `Caption text: """${caption.slice(0, 800)}"""` : "Caption: (none / not visible)",
      "",
      "Now return ONLY ONE final comment following all the rules.",
    ].filter(Boolean);

    const textPart = { type: "text", text: summaryLines.join("\n") };
    const userContent: unknown = imageUrl
      ? [textPart, { type: "image_url", image_url: { url: imageUrl } }]
      : summaryLines.join("\n");

    // ── 6. AI call ────────────────────────────────────────────────────────
    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded, please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiResp.status === 402) {
        return new Response(
          JSON.stringify({ error: "Payment required, please add credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await aiResp.text();
      console.error("AI gateway error:", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI generation failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await aiResp.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const comment = clampWords(typeof raw === "string" ? raw : String(raw));

    if (!comment || comment.split(/\s+/).filter(Boolean).length < 4) {
      return new Response(JSON.stringify({ error: "Empty or too-short comment generated" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 7. Increment usage counter (Growth only — Scale/Admin are unlimited) ──
    let used = currentCount;
    let remaining: number | null = null;
    if (isGrowth) {
      const newCount = currentCount + 1;
      const { error: upsertErr } = await supabaseAdmin
        .from("ai_post_comment_usage")
        .upsert(
          { user_id: user.id, usage_date: today, count: newCount },
          { onConflict: "user_id,usage_date" },
        );
      if (upsertErr) {
        console.error("[generate-post-comment] usage upsert failed:", upsertErr);
      }
      used = newCount;
      remaining = Math.max(0, GROWTH_DAILY_LIMIT - newCount);
    }

    return new Response(
      JSON.stringify({
        comment,
        tier,
        used,
        remaining,
        limit: isGrowth ? GROWTH_DAILY_LIMIT : null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("generate-post-comment error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
