import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  try {
    const { description, location, platform = "instagram" } = await req.json();

    if (!description || typeof description !== "string" || description.trim().length < 3) {
      return new Response(JSON.stringify({ error: "Please provide a description of your ideal customer." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const locationContext = location ? ` The target location is: ${location}.` : "";

    const systemPrompt = `You are an expert social media marketing strategist specializing in ${platform} outreach and lead generation.
Given a description of an ideal customer/prospect and optionally a location, generate a comprehensive prospecting plan.

You MUST return a JSON object with these exact fields:
- hashtags: array of 8-15 relevant ${platform} hashtags (without the # symbol) that the ideal customer would use or follow. Mix popular and niche hashtags.
- locationSearchTerms: array of 3-5 Instagram location search terms/place names the user can search for on Instagram (e.g. "Miami Beach", "Downtown Austin"). Only include if location is provided, otherwise empty array.
- competitorAccounts: array of 5-10 Instagram usernames (without @) of popular accounts, influencers, or businesses in the niche whose followers would match the ideal customer profile.
- searchTerms: array of 5-8 keyword phrases for AI-powered content matching and bio scanning.
- summary: a brief 1-2 sentence strategy summary explaining the approach.

Return ONLY valid JSON, no markdown fences or explanation.`;

    const userPrompt = `Find prospects matching this ideal customer description: "${description.trim()}"${locationContext}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
        return new Response(JSON.stringify({ error: "AI rate limit reached. Please wait a moment and try again." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds in Settings > Workspace > Usage." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("AI gateway error:", status, errorText);
      return new Response(JSON.stringify({ error: "AI service error. Please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      return new Response(JSON.stringify({ error: "No response from AI." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse JSON from response (handle optional markdown fences)
    let parsed;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      console.error("Failed to parse AI response:", content);
      return new Response(JSON.stringify({ error: "Failed to parse AI results. Please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Normalize the result
    const result = {
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map((h: string) => h.replace(/^#/, "")) : [],
      locationSearchTerms: Array.isArray(parsed.locationSearchTerms) ? parsed.locationSearchTerms : [],
      competitorAccounts: Array.isArray(parsed.competitorAccounts) ? parsed.competitorAccounts.map((a: string) => a.replace(/^@/, "")) : [],
      searchTerms: Array.isArray(parsed.searchTerms) ? parsed.searchTerms : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "Prospect plan generated successfully.",
    };

    return new Response(JSON.stringify({ prospects: result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("find-prospects error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
