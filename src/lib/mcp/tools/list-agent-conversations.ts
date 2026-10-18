import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_agent_conversations",
  title: "List AI sales agent conversations",
  description:
    "Return the signed-in user's recent AI sales-agent conversations across Instagram / TikTok / WhatsApp (customer identifier, platform, message count, last message time).",
  inputSchema: {
    platform: z
      .enum(["instagram", "tiktok", "whatsapp"]) 
      .optional()
      .describe("Optional platform filter."),
    limit: z.number().int().min(1).max(50).optional().describe("Max rows (1-50). Defaults to 20."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ platform, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("agent_sessions")
      .select("customer_identifier, platform, message_count, last_message_at, created_at")
      .eq("user_id", ctx.getUserId())
      .order("last_message_at", { ascending: false })
      .limit(limit ?? 20);
    if (platform) query = query.eq("platform", platform);
    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { conversations: data ?? [] },
    };
  },
});
