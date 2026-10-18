import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

async function runApifySearch(query: string, token: string, maxResults: number): Promise<any[]> {
  const apifyUrl = `https://api.apify.com/v2/acts/apify~google-search-scraper/runs?token=${token}`;

  // Google shows ~10 results per page, so calculate pages needed
  const pagesNeeded = Math.max(1, Math.ceil(maxResults / 10));

  const resp = await fetch(apifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: query,
      maxPagesPerQuery: Math.min(pagesNeeded, 5),
      resultsPerPage: 100,
      languageCode: "en",
      mobileResults: false,
    }),
  });

  if (!resp.ok) {
    console.error("[customer-search] Apify run failed:", resp.status, await resp.text());
    return [];
  }

  const runData = await resp.json();
  const runId = runData?.data?.id;
  if (!runId) return [];

  console.log("[customer-search] Apify run started:", runId, "for query:", query);

  // Poll for results (max 90s)
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    const statusData = await statusRes.json();
    const status = statusData?.data?.status;

    if (status === "SUCCEEDED") {
      const datasetId = statusData?.data?.defaultDatasetId;
      if (datasetId) {
        const dataRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`);
        return await dataRes.json();
      }
      return [];
    } else if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      console.error("[customer-search] Apify run failed:", status);
      return [];
    }
  }
  return [];
}

// Detect query intent and build optimized search queries
// Returns multiple query sets for broader coverage
function buildSearchQueries(query: string): { queries: string[] } {
  const q = query.toLowerCase();
  
  // "similar to @username" or "like @username"
  const similarMatch = q.match(/(?:similar to|like|accounts like|people like|influencers like)\s*@?([a-zA-Z0-9_.]+)/i);
  if (similarMatch) {
    const target = similarMatch[1];
    return { queries: [
      `site:instagram.com ${target}`,
      `site:tiktok.com "@${target}"`,
      `"${target}" instagram OR tiktok similar accounts influencer`,
    ]};
  }

  // Influencer/creator searches  
  const isInfluencerSearch = /\b(influencers?|creators?|bloggers?|vloggers?|content creators?|micro.?influencers?|macro.?influencers?|nano.?influencers?)\b/i.test(q);
  if (isInfluencerSearch) {
    const topic = q.replace(/\b(influencer|creator|blogger|vlogger|content creator|micro.?influencer|macro.?influencer|nano.?influencer)s?\b/gi, "").trim();
    return { queries: [
      `site:instagram.com "${topic}"`,
      `site:tiktok.com "${topic}"`,
      `${topic} top influencers instagram tiktok handles "@"`,
    ]};
  }

  // "people in [location]" or "accounts in [location]"
  const isPeopleSearch = /\b(people|accounts|profiles|users)\s+(in|from|near)\b/i.test(q);
  if (isPeopleSearch) {
    return { queries: [
      `site:instagram.com ${query}`,
      `site:tiktok.com ${query}`,
      `${query} instagram OR tiktok "@"`,
    ]};
  }

  // Default: business/brand search
  return { queries: [
    `${query} instagram OR tiktok`,
    `${query} site:instagram.com`,
    `${query} site:tiktok.com`,
  ]};
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  try {
    const { query, platform = "instagram", maxResults = 10 } = await req.json();

    if (!query || typeof query !== "string" || query.trim().length < 3) {
      return new Response(JSON.stringify({ error: "Please provide a search query (at least 3 characters)." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN");
    if (!APIFY_API_TOKEN) {
      return new Response(JSON.stringify({ error: "Apify API not configured." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const q = query.trim();
    const fetchCount = Math.max(maxResults, 30);
    const queries = buildSearchQueries(q);
    console.log("[customer-search] Smart queries:", JSON.stringify(queries), "maxResults:", maxResults);

    // Run all queries in parallel for maximum coverage
    const allSearchResults = await Promise.all(
      queries.queries.map(qStr => runApifySearch(qStr, APIFY_API_TOKEN, fetchCount))
    );

    // Extract organic results from all searches
    const allOrganic = allSearchResults.flatMap(results => 
      results.flatMap((r: any) => r.organicResults || [])
    );

    // Deduplicate by URL
    const seen = new Set<string>();
    const deduped = allOrganic.filter((r: any) => {
      const url = r.url?.toLowerCase();
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    console.log("[customer-search] Total organic results:", deduped.length, "from", queries.queries.length, "queries");

    if (deduped.length === 0) {
      return new Response(JSON.stringify({ results: [], summary: "No results found. Try a different search." }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Prepare data for AI - include all results for extraction
    const searchDataForAI = deduped.slice(0, 150).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      description: r.description || "",
    }));

    // Detect search type for AI context
    const qLower = q.toLowerCase();
    const isInfluencer = /\b(influencer|creator|blogger|vlogger|content creator)\b/i.test(qLower);
    const isSimilar = /\b(similar to|like|accounts like|people like)\b/i.test(qLower);
    const isPeople = /\b(people|accounts|profiles|users)\b/i.test(qLower);
    
    const searchType = isSimilar ? "SIMILAR_ACCOUNTS" : isInfluencer ? "INFLUENCER" : isPeople ? "PEOPLE" : "BUSINESS";

    const aiPrompt = `You are an expert data extractor for social media lead generation. Given these Google search results, extract structured prospect data.

SEARCH TYPE: ${searchType}
ORIGINAL QUERY: "${q}"

CRITICAL INSTRUCTIONS:
1. You MUST return AT LEAST ${Math.min(maxResults, searchDataForAI.length)} results. Extract EVERY possible prospect - do NOT stop early.
2. PRIORITIZE results that have Instagram or TikTok usernames. Every result SHOULD have at least one social username.
3. Extract Instagram usernames from URLs like instagram.com/USERNAME (ignore /p/, /reel/, /explore/, /accounts/, /stories/, /tv/ paths)
4. Extract TikTok usernames from URLs like tiktok.com/@USERNAME (ignore /video/, /tag/ paths)
5. Also look for @username mentions in titles and descriptions
6. If a URL is an Instagram/TikTok profile, the username IS the main identifier - always extract it
7. Match social profiles to businesses/people: merge duplicate entries
8. Return up to ${maxResults} results maximum

${searchType === "INFLUENCER" ? `INFLUENCER MODE: Focus on individual creators, influencers, and content creators. Every result should ideally have a social username. Look for personal brands and creator accounts.` : ""}
${searchType === "SIMILAR_ACCOUNTS" ? `SIMILAR ACCOUNTS MODE: Find accounts that are similar in niche/content to the referenced account. Focus on discovering related creators and brands.` : ""}
${searchType === "PEOPLE" ? `PEOPLE MODE: Focus on individual people and their social media profiles. Every result should have at least one social username.` : ""}

For each result, extract:
- name: The person or business name (clean, no "Instagram" or "TikTok" suffix, no "(@username)" suffix)
- phone: Phone number if visible (null if not found)
- email: Email if visible (null if not found)  
- instagram_username: Instagram username WITHOUT @ prefix (null if not found)
- tiktok_username: TikTok username WITHOUT @ prefix (null if not found)
- website: The business website URL (NOT instagram/tiktok URLs)
- description: A short 1-line description of the account/person

Username extraction rules:
- instagram.com/thebigchill → instagram_username: "thebigchill"
- instagram.com/p/ABC123 → SKIP (post URL)
- tiktok.com/@foodieplace → tiktok_username: "foodieplace"  
- tiktok.com/video/123 → SKIP (video URL)
- "Follow @miamifoodspot" in text → instagram_username: "miamifoodspot"
- Title like "John Smith (@johnsmith)" → name: "John Smith", instagram_username: "johnsmith"

Return ONLY a valid JSON array. No markdown fences, no explanation.

Search results:
${JSON.stringify(searchDataForAI)}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: aiPrompt }],
      }),
    });

    if (!aiResponse.ok) {
      console.error("[customer-search] AI extraction failed:", aiResponse.status);
      // Fallback: manually extract what we can
      return new Response(JSON.stringify({
        results: manualExtract(deduped, maxResults),
        summary: `Found ${Math.min(deduped.length, maxResults)} prospects (without AI enrichment)`,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiData = await aiResponse.json();
    const aiContent = aiData?.choices?.[0]?.message?.content;

    let parsed;
    try {
      const jsonMatch = aiContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : aiContent.trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      console.error("[customer-search] Failed to parse AI response, using manual extraction");
      return new Response(JSON.stringify({
        results: manualExtract(deduped, maxResults),
        summary: `Found prospects (AI parsing failed, showing raw results)`,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const finalResults = (Array.isArray(parsed) ? parsed : []).slice(0, maxResults).map((r: any) => ({
      name: r.name || "Unknown",
      phone: r.phone || null,
      email: r.email || null,
      instagram_username: r.instagram_username?.replace(/^@/, "").replace(/\/$/, "") || null,
      tiktok_username: r.tiktok_username?.replace(/^@/, "").replace(/\/$/, "") || null,
      website: r.website || null,
      description: r.description || "",
    }));

    const igCount = finalResults.filter((r: any) => r.instagram_username).length;
    const tkCount = finalResults.filter((r: any) => r.tiktok_username).length;

    console.log("[customer-search] Final results:", finalResults.length, "IG:", igCount, "TK:", tkCount);

    return new Response(JSON.stringify({
      results: finalResults,
      summary: `Found ${finalResults.length} prospects for "${q}" (${igCount} with Instagram, ${tkCount} with TikTok)`,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("[customer-search] error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Manual fallback extraction without AI
function manualExtract(results: any[], maxResults: number) {
  const extracted: any[] = [];
  for (const r of results) {
    if (extracted.length >= maxResults) break;
    const url = (r.url || "").toLowerCase();
    let ig = null;
    let tk = null;

    // Extract IG username from URL
    const igMatch = url.match(/instagram\.com\/([a-zA-Z0-9_.]+)\/?$/);
    if (igMatch && !["p", "reel", "explore", "accounts", "stories", "tv"].includes(igMatch[1])) {
      ig = igMatch[1];
    }

    // Extract TikTok username from URL
    const tkMatch = url.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
    if (tkMatch) {
      tk = tkMatch[1];
    }

    extracted.push({
      name: r.title?.replace(/ - Instagram.*$| \| TikTok$/i, "").trim() || "Unknown",
      phone: null,
      email: null,
      instagram_username: ig,
      tiktok_username: tk,
      website: (!url.includes("instagram.com") && !url.includes("tiktok.com")) ? r.url : null,
      description: r.description || "",
    });
  }
  return extracted;
}
