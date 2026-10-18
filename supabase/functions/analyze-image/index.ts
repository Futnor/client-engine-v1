import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!isOriginAllowed(req)) return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });

  try {
    const body = await req.json();
    const { imageUrl, username } = body;

    if (!imageUrl && !username) {
      return new Response(JSON.stringify({ error: "imageUrl or username is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // Build messages based on input type
    const systemPrompt = `You are an Instagram content analyst. Analyze the input and extract:
1. A detailed description of the person's appearance, style, aesthetic, and vibe
2. Content tags that describe the type of Instagram content this person likely posts
3. Keywords to search for similar Instagram profiles/content

Respond in this exact JSON format:
{
  "description": "Detailed description of the person and their aesthetic",
  "content_tags": ["tag1", "tag2", "tag3"],
  "search_keywords": ["keyword1", "keyword2"],
  "target_audience": "Description of who would follow or engage with this type of content",
  "suggested_message": "A natural, personalized DM message to send to people with similar content"
}`;

    let userContent: any;

    if (username) {
      // Username-based analysis
      userContent = `Analyze the Instagram user @${username}. Based on what you know about this type of username and common Instagram aesthetics, describe:
- What kind of content they likely post
- Their visual style and aesthetic
- What type of similar accounts exist
- Good search keywords to find accounts like theirs
- A personalized DM message that would appeal to people in their niche

Be specific and creative in your analysis. Think about the niche, community, and content style associated with usernames like this.`;
    } else {
      // Image-based analysis
      userContent = [
        {
          type: "text",
          text: "Analyze this image of a person. Describe their style, aesthetic, and the type of Instagram content they represent. Generate search keywords for finding similar profiles."
        },
        {
          type: "image_url",
          image_url: { url: imageUrl }
        }
      ];
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required, please add credits." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI analysis failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    let analysis;
    try {
      const jsonMatch = content?.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      analysis = JSON.parse(jsonMatch[1]?.trim() || content);
    } catch {
      analysis = {
        description: content,
        content_tags: [],
        search_keywords: [],
        target_audience: "",
        suggested_message: "Hey! Love your content, check your DMs 👀"
      };
    }

    return new Response(JSON.stringify({ analysis }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("analyze-image error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
