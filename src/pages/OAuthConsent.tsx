import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { AnimatedLogo } from "@/components/AnimatedLogo";
import { Loader2, ShieldCheck, X } from "lucide-react";

// The `supabase.auth.oauth` namespace is beta; type it locally so we don't
// need to grep node_modules or drop to raw REST calls.
type AuthorizationDetails = {
  redirect_url?: string;
  redirect_to?: string;
  client?: { name?: string; logo_uri?: string; client_uri?: string };
  scopes?: string[];
};

interface OAuthAPI {
  getAuthorizationDetails: (
    id: string,
  ) => Promise<{ data: AuthorizationDetails | null; error: { message: string } | null }>;
  approveAuthorization: (
    id: string,
  ) => Promise<{ data: AuthorizationDetails | null; error: { message: string } | null }>;
  denyAuthorization: (
    id: string,
  ) => Promise<{ data: AuthorizationDetails | null; error: { message: string } | null }>;
}

function getOAuth(): OAuthAPI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (supabase.auth as any).oauth as OAuthAPI;
}

/**
 * OAuth 2.1 consent screen at `/.lovable/oauth/consent`.
 *
 * Supabase's authorization server redirects users here after they hit
 * `/oauth/authorize` on the auth issuer. Our job:
 *
 *  1. Ensure the user is signed in (bounce to /login with a `next` handoff).
 *  2. Fetch the authorization details (which client, which scopes).
 *  3. Let the user approve or deny, then send them back to `redirect_url`.
 *
 * This route is what powers "Add to Lovable" for external MCP clients
 * (ChatGPT, Claude, Cursor, etc) connecting to the Client Engine MCP server.
 */
export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id") ?? "";
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) {
        setError("Missing authorization_id");
        return;
      }
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Preserve the FULL consent URL so post-login lands right back here.
        const next = window.location.pathname + window.location.search;
        try {
          sessionStorage.setItem("lovable:postLoginNext", next);
        } catch {}
        window.location.href = "/login";
        return;
      }
      const oauth = getOAuth();
      if (!oauth || typeof oauth.getAuthorizationDetails !== "function") {
        setError("This backend is not configured for OAuth clients yet.");
        return;
      }
      const { data, error } = await oauth.getAuthorizationDetails(authorizationId);
      if (!active) return;
      if (error) {
        setError(error.message);
        return;
      }
      // Some flows can auto-resolve without a consent step (e.g. previously
      // approved). Follow the redirect immediately.
      const immediate = data?.redirect_url ?? data?.redirect_to;
      if (immediate && !data?.client) {
        window.location.href = immediate;
        return;
      }
      setDetails(data);
    })();
    return () => {
      active = false;
    };
  }, [authorizationId]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const oauth = getOAuth();
    const { data, error } = approve
      ? await oauth.approveAuthorization(authorizationId)
      : await oauth.denyAuthorization(authorizationId);
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("No redirect returned by the authorization server.");
      return;
    }
    window.location.href = target;
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4 text-center">
          <X className="w-10 h-10 text-destructive mx-auto" />
          <h1 className="text-xl font-semibold">Could not load this request</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </main>
    );
  }

  if (!details) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading authorization request…</p>
      </main>
    );
  }

  const clientName = details.client?.name ?? "An external app";

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full space-y-6 rounded-2xl border border-border bg-card p-8 shadow-xl">
        <div className="flex items-center gap-3">
          <AnimatedLogo />
          <div className="text-lg font-semibold">Client Engine</div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-primary">
            <ShieldCheck className="w-5 h-5" />
            <h1 className="text-xl font-semibold">Connect {clientName}?</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {clientName} is asking to use Client Engine as you. It will be able to call the tools
            exposed by this app on your behalf.
          </p>
        </div>

        {details.scopes && details.scopes.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Requested access
            </p>
            <ul className="text-sm space-y-0.5">
              {details.scopes.map((s) => (
                <li key={s}>• {s}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Deny
          </Button>
          <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Approve"}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground text-center">
          You can revoke access anytime from your Client Engine account.
        </p>
      </div>
    </main>
  );
}
