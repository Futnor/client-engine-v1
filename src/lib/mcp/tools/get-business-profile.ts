import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "get_business_profile",
  title: "Get sales agent business profile",
  description:
    "Return the signed-in user's active sales-agent business profile (business name, product, pricing, target customer, objections, promos).",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("business_profiles")
      .select(
        "agent_name, business_name, product, target_customer, pricing, common_objections, competitors, key_transformation, current_promos, is_active, updated_at",
      )
      .eq("user_id", ctx.getUserId())
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }],
      structuredContent: { profile: data ?? null },
    };
  },
});
