import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useAuthReady } from "@/hooks/useAuthReady";
import { useUserKeyWatcher, clearUserKeyId } from "@/hooks/useUserKeyWatcher";
import { installActiveAccountGuard } from "@/lib/activeAccountGuard";
import { LoadingBot } from "@/components/LoadingBot";
import Index from "./pages/Index";
import Home from "./pages/Home";
import Auth from "./pages/Auth";
import Pricing from "./pages/Pricing";
import ResetPassword from "./pages/ResetPassword";
import Terms from "./pages/Terms";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import NotFound from "./pages/NotFound";
import Unsubscribe from "./pages/Unsubscribe";
import Admin from "./pages/Admin";
import Support from "./pages/Support";
import InstallExtension from "./pages/InstallExtension";
import OAuthCallback from "./pages/OAuthCallback";
import OAuthConsent from "./pages/OAuthConsent";

const queryClient = new QueryClient();

/**
 * Canonical hostname enforcement.
 *
 * Lovable's OAuth allowlist is exact-match per origin. We allowlist the
 * bare `futnormarketing.com` form; users landing on `www.futnormarketing.com`
 * (typed manually, ad cross-promo, etc.) get a redirect_uri-mismatch error.
 *
 * Run this SYNCHRONOUSLY at module load — before React mounts and before
 * any auth UI gets a chance to fire OAuth with the wrong origin. Using
 * `location.replace` (not `location.href = `) so the www URL doesn't
 * pollute browser history.
 */
if (typeof window !== 'undefined' && window.location.hostname === 'www.futnormarketing.com') {
  const canonical = window.location.href.replace('://www.', '://');
  window.location.replace(canonical);
}

function ProtectedRoute({ children, session }: { children: React.ReactNode; session: Session | null }) {
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// If the user is already signed in and a deep-link (e.g. the MCP consent
// route) stashed a same-origin `next` path in sessionStorage before bouncing
// to /login, honor it instead of the default /app redirect.
function LoginRedirect() {
  let target = '/app';
  try {
    const stashed = sessionStorage.getItem('lovable:postLoginNext');
    if (stashed && stashed.startsWith('/') && !stashed.startsWith('//')) {
      target = stashed;
      sessionStorage.removeItem('lovable:postLoginNext');
    }
  } catch {}
  return <Navigate to={target} replace />;
}

const App = () => {
  const { session, isReady } = useAuthReady();
  useUserKeyWatcher(!!session);
  useEffect(() => { if (isReady && !session) clearUserKeyId(); }, [isReady, session]);

  // Install the active-account guard once at app startup. This watches
  // localStorage.futnor_active_account and rejects bogus values like
  // "notifications", "explore", "reels" that the extension's URL→username
  // parser writes when the bot navigates to non-profile IG pages during
  // warm-up. Restores the last known good username so AccountHealthScore
  // and other consumers always see the real account.
  // Runs purely on the dashboard — does NOT require a Web Store extension update.
  useEffect(() => {
    const cleanup = installActiveAccountGuard();
    return cleanup;
  }, []);

  if (!isReady) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <LoadingBot width={140} />
        <p className="text-sm text-muted-foreground animate-pulse">Loading...</p>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={session ? <LoginRedirect /> : <Auth />} />
            <Route path="/auth" element={<Navigate to="/login" replace />} />
            <Route path="/.lovable/oauth/consent" element={<OAuthConsent />} />
            {/* Lovable OAuth callback — must NOT be behind ProtectedRoute
                because the session is still being established when this
                renders. The component waits for useAuthReady to report a
                session, then redirects to /app. */}
            <Route path="/~oauth/callback" element={<OAuthCallback />} />
            <Route path="/app" element={<ProtectedRoute session={session}><Index /></ProtectedRoute>} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/pricing" element={<ProtectedRoute session={session}><Pricing /></ProtectedRoute>} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy-policy" element={<PrivacyPolicy />} />
            <Route path="/admin" element={<ProtectedRoute session={session}><Admin /></ProtectedRoute>} />
            <Route path="/unsubscribe" element={<Unsubscribe />} />
            <Route path="/support" element={<Support />} />
            <Route path="/install-extension" element={<ProtectedRoute session={session}><InstallExtension /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
