import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listRecentSessions from "./tools/list-recent-sessions";
import getBusinessProfile from "./tools/get-business-profile";
import listAgentConversations from "./tools/list-agent-conversations";

const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "client-engine-mcp",
  title: "Client Engine",
  version: "0.1.0",
  instructions:
    "Tools for Client Engine — the outreach automation platform for Instagram, TikTok, and WhatsApp. Use `list_recent_sessions` to inspect bot session history, `list_agent_conversations` to see AI sales-agent chats per platform, and `get_business_profile` to read the configured sales agent context.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listRecentSessions, listAgentConversations, getBusinessProfile],
});
