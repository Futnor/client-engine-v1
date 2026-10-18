import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { getCorsHeaders, isOriginAllowed } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!isOriginAllowed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized origin' }), { status: 403, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const { action, apiKey, label, keyId } = await req.json();

    if (action === "generate") {
      // Requires auth - generate a new API key for the user
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) throw new Error("Not authenticated");
      const token = authHeader.replace("Bearer ", "");
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user) throw new Error("Auth failed");

      const userId = userData.user.id;

      // Generate a random API key: ftn_XXXX...
      const rawBytes = new Uint8Array(32);
      crypto.getRandomValues(rawBytes);
      const rawKey = "ftn_" + Array.from(rawBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      const prefix = rawKey.slice(0, 12) + "...";

      // Hash the key for storage
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const { error: insertError } = await supabase
        .from("api_keys")
        .insert({ user_id: userId, key_hash: keyHash, key_prefix: prefix, label: label || "Default" });

      if (insertError) throw new Error(insertError.message);

      return new Response(JSON.stringify({ key: rawKey, prefix }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "validate") {
      // Public - validate an API key and return user session info
      if (!apiKey || typeof apiKey !== "string" || !apiKey.startsWith("ftn_")) {
        return new Response(JSON.stringify({ valid: false, error: "Invalid key format" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }

      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const { data: keyRow, error: keyError } = await supabase
        .from("api_keys")
        .select("id, user_id, revoked")
        .eq("key_hash", keyHash)
        .maybeSingle();

      if (keyError || !keyRow) {
        return new Response(JSON.stringify({ valid: false, error: "Invalid or deleted User Key" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        });
      }

      if (keyRow.revoked) {
        return new Response(JSON.stringify({ valid: false, error: "User Key has been deleted" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        });
      }

      // Update last_used_at
      await supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id);

      // Get user email and create a magic link session
      const { data: userData } = await supabase.auth.admin.getUserById(keyRow.user_id);
      if (!userData?.user?.email) {
        return new Response(JSON.stringify({ valid: false, error: "User not found" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }

      // Generate a magic link for the user
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: userData.user.email,
      });

      if (linkError || !linkData) {
        throw new Error(`Failed to generate session: ${linkError?.message}`);
      }

      return new Response(JSON.stringify({
        valid: true,
        key_id: keyRow.id,
        token_hash: linkData.properties?.hashed_token,
        email: userData.user.email,
        verification_url: (linkData.properties as { verification_url?: string | null } | undefined)?.verification_url ?? null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "check") {
      if (!keyId || typeof keyId !== "string") {
        return new Response(JSON.stringify({ alive: false, error: "Missing keyId" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
        });
      }
      const { data: row } = await supabase
        .from("api_keys")
        .select("id, revoked")
        .eq("id", keyId)
        .maybeSingle();
      const alive = !!row && !row.revoked;
      return new Response(JSON.stringify({ alive }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Invalid action");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
