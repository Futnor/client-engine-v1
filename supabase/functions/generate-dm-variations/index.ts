import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!isOriginAllowed(req)) return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });

  try {
    const { script, context, count, personalize, hashtags, location, platform, contextAware, adaptMode, adaptCta } = await req.json();

    if (!script && !context && !hashtags && !location && !platform) {
      return new Response(JSON.stringify({ error: "script, context, hashtags, location, or platform is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const isTikTok = platform === "tiktok";
    const defaultCount = isTikTok ? 18 : 7;
    const maxCount = isTikTok ? 20 : 10;
    const minCount = isTikTok ? 15 : 5;
    const variationCount = Math.min(Math.max(count || defaultCount, minCount), maxCount);

    const messageType = isTikTok ? "comment" : "DM";
    const platformName = isTikTok ? "TikTok" : "Instagram";

    // Build targeting context
    const targetingParts: string[] = [];
    if (hashtags && hashtags.length > 0) {
      targetingParts.push(`Target hashtags: ${hashtags.join(", ")}`);
    }
    if (location) {
      targetingParts.push(`Target location: ${location}`);
    }
    if (context) {
      targetingParts.push(`Audience context: ${context}`);
    }
    const targetingContext = targetingParts.length > 0 ? targetingParts.join("\n") : "";

    const personalizationRule = personalize
      ? `\n- Include {name} as a placeholder where the recipient's name would go (e.g., "Hey {name}!" or "Hi {name},"). The app will replace {name} with the actual person's name at send time. Every variation MUST include {name} at least once.`
      : "";

    const contextAwareRule = contextAware
      ? `\n- CRITICAL: Each variation must be written as if genuinely reacting to real content. Do NOT include any placeholders like {post_topic} or {name} — write complete, ready-to-send messages.
- Include variations that reference specific aspects of content: the visual quality, the message, the creator's skill, relatability, humor, educational value, etc.
- Some should ask follow-up questions about the content
- Some should share a personal reaction or story triggered by the content`
      : "";

    const ctaText = adaptCta ? adaptCta : "a natural engagement hook";
    const adaptModeRule = adaptMode
      ? `\n- ADAPT MODE (CRITICAL): The bot will analyze exactly what is happening in each post/video before commenting. The user's desired Call-to-Action is: "${ctaText}". Generate comments that:
  1. Describe or react to SPECIFIC things happening in the content (actions, visuals, sounds, text overlays)
  2. Naturally weave in the CTA "${ctaText}" so it doesn't feel forced — it should flow from the observation
  3. Make the creator feel SEEN — reference details only someone who actually watched/read would notice
  4. Use the format: [specific observation about the content] + [genuine reaction/emotion] + [subtle lead-in to "${ctaText}"]
  5. Examples of good adapt comments with CTA "${ctaText}":
     - "The way you flipped that at 0:15 had me shook 😳 ${ctaText}"
     - "This is literally the exact vibe I've been trying to recreate 🔥 ${ctaText}"
     - "Not me watching this 5 times... the transition at the end is insane. ${ctaText}"
  6. The CTA should feel like a natural continuation of the comment, NOT a bolted-on promo
  7. Vary the placement — sometimes CTA at the end, sometimes mid-comment, sometimes as a question`
      : "";

    let userPrompt: string;

    if (isTikTok) {
      if (script) {
        userPrompt = `Here is a base comment style/tone that will be posted on TikTok videos:

"${script}"

${targetingContext ? `\nTargeting info:\n${targetingContext}\n` : ""}
Generate exactly ${variationCount} unique variations of this comment. Each variation MUST:
- Match the tone and energy of the base comment above
- PRESERVE EVERY KEY NOUN exactly as written in the original. If the original says "video", keep "video" — never swap it for "post", "reel", "clip", or "content". If "post", keep "post". Same rule for product names, offers, numbers, and emojis.
- PRESERVE the exact call-to-action mechanic and any literal reward wording verbatim.
- Use different wording, sentence structure, and phrasing for the rest of the comment
- Feel natural and authentic like a real TikTok user wrote it
- Be short (1-2 sentences max, comments are brief)
- Include occasional emojis where natural (🔥 💯 😂 etc.)
- Vary in style (some enthusiastic, some chill, some asking questions)
- Avoid spam triggers (no excessive punctuation, no ALL CAPS, no promotional language)
- Some should be questions to encourage engagement
- Some should be reactions that feel post-specific${contextAwareRule}${adaptModeRule}${personalizationRule}

The variations will be rotated to avoid TikTok spam detection.`;
      } else {
        userPrompt = `Create ${variationCount} unique TikTok video comments for engagement.

${targetingContext ? `Targeting info:\n${targetingContext}\n` : `Context: general TikTok video content`}

Each comment should:
- Sound like a real person genuinely reacting to a video
- Be short (1-2 sentences max)
- Include occasional emojis naturally
- Vary significantly in style (enthusiastic, chill, funny, curious, supportive)
- Some should be questions ("how did you do this??")
- Some should be reactions ("this is insane 🔥")
- Some should be relatable ("me every morning 😂")
- Avoid anything that looks like spam or self-promotion
- Feel authentic to TikTok culture${contextAwareRule}${adaptModeRule}${personalizationRule}

The comments will be rotated to avoid spam detection.`;
      }
    } else {
      if (script) {
        userPrompt = `Here is a DM script/message that will be sent on Instagram:

"${script}"

${targetingContext ? `\nTargeting info:\n${targetingContext}\n` : ""}
Generate exactly ${variationCount} unique variations of this message. Each variation MUST:
- Keep the same intent, tone, and core meaning
- PRESERVE EVERY KEY NOUN exactly as written in the original. If the original says "post", every variation MUST say "post" — never swap it for "video", "reel", "content", "clip", or "story". If the original says "video", keep "video". If "reel", keep "reel". Same rule applies to product names, offers ("300 likes free"), numbers, emojis (🎁, 👍), and any specific instructions ("Reply with a thumbs up").
- PRESERVE the exact call-to-action mechanic (e.g. "Reply with a thumbs up 👍") — do not rephrase it into a different action.
- PRESERVE any literal reward/offer wording (e.g. "300 likes free🎁") — keep the number, the noun, and the emoji intact.
- Use different wording, sentence structure, and phrasing for the rest of the message
- Feel natural and conversational (not robotic or templated)
- Vary in length slightly (some shorter, some a bit longer)
- Include occasional emojis where natural (in addition to the required ones above)
- IMPORTANT: Add line breaks between paragraphs/sentences to make the message easy to read (use \\n\\n between paragraphs). Do NOT write everything in one block.
- Do NOT include any placeholders like {post_topic} — write complete, ready-to-send messages
- Avoid spam triggers (don't use ALL CAPS, excessive punctuation, or salesy language)${contextAwareRule}${adaptModeRule}${personalizationRule}

The variations will be rotated to avoid Instagram spam detection.`;
      } else {
        userPrompt = `Create ${variationCount} unique Instagram DM messages for outreach purposes.

${targetingContext ? `Targeting info:\n${targetingContext}\n` : `Context about the target audience: general Instagram users`}

Each message should:
- Be natural, friendly, and conversational
- Not feel like spam or a template
- Be between 1-3 sentences
- Include occasional emojis where natural
- IMPORTANT: Add line breaks between paragraphs/sentences (use \\n\\n between paragraphs) for readability. Do NOT write everything in one block.
- Do NOT include any placeholders like {post_topic} — write complete, ready-to-send messages
- Have a clear but subtle call to action
- Feel like a real person wrote it
- Vary significantly in style (some casual, some more professional, some playful)${contextAwareRule}${adaptModeRule}${personalizationRule}

The messages will be rotated to avoid spam detection.`;
      }
    }

    const systemContent = isTikTok
      ? `You are a TikTok engagement expert who writes authentic, natural-sounding comments. You understand TikTok culture, trends, and how spam detection works.

Respond in this exact JSON format:
{
  "variations": [
    "comment variation 1",
    "comment variation 2",
    ...
  ],
  "tips": "Brief tip about when/how to use these comments effectively"
}`
      : `You are a DM copywriter who specializes in natural, human-sounding Instagram messages. You understand spam detection and how to write messages that feel authentic.

Respond in this exact JSON format:
{
  "variations": [
    "message variation 1",
    "message variation 2",
    ...
  ],
  "tips": "Brief tip about when/how to use these variations effectively"
}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt }
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required, please add credits." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI generation failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    let result;
    try {
      const jsonMatch = content?.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      result = JSON.parse(jsonMatch[1]?.trim() || content);
    } catch {
      result = {
        variations: [script || (isTikTok ? "Love this! 🔥" : "Hey! Love your content 🔥")],
        tips: "Could not generate variations. Using original message."
      };
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-dm-variations error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
