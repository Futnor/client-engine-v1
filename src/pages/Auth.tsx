import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { lovable } from '@/integrations/lovable';
import { rememberUserKeyId } from '@/hooks/useUserKeyWatcher';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { ArrowLeft, Sparkles, Loader2, Key, ArrowRight, ExternalLink, AlertTriangle, Copy } from 'lucide-react';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { useNavigate } from 'react-router-dom';

/**
 * Detect whether the page is loaded inside an in-app WebView from a social
 * platform's app (Instagram, Facebook, TikTok, LinkedIn, etc.).
 *
 * Google explicitly blocks OAuth in embedded WebViews since 2021 for
 * security, so users clicking the ad inside Instagram will hit a "This
 * browser or app may not be secure" error from Google's side regardless
 * of what we do. The only fix is to send them to a real browser.
 */
function detectInAppBrowser(): { isInApp: boolean; appName: string } {
  if (typeof navigator === 'undefined') return { isInApp: false, appName: '' };
  const ua = navigator.userAgent || '';

  if (/Instagram/i.test(ua)) return { isInApp: true, appName: 'Instagram' };
  if (/FBAN|FBAV|FB_IAB|FBSV|FB4A/i.test(ua)) return { isInApp: true, appName: 'Facebook' };
  if (/TikTok|musical_ly/i.test(ua)) return { isInApp: true, appName: 'TikTok' };
  if (/LinkedInApp/i.test(ua)) return { isInApp: true, appName: 'LinkedIn' };
  if (/Twitter|TwitterAndroid/i.test(ua)) return { isInApp: true, appName: 'X' };
  if (/Snapchat/i.test(ua)) return { isInApp: true, appName: 'Snapchat' };
  if (/Line\//i.test(ua)) return { isInApp: true, appName: 'Line' };
  if (/WeChat|MicroMessenger/i.test(ua)) return { isInApp: true, appName: 'WeChat' };
  if (/Pinterest/i.test(ua)) return { isInApp: true, appName: 'Pinterest' };

  return { isInApp: false, appName: '' };
}

/**
 * Auth page — Google primary, User Key secondary.
 *
 * Manual email sign-up was disabled at the Supabase level because users were
 * getting stuck on the email-confirmation step. The auth page therefore shows:
 *
 *   1. PRIMARY:   "Continue with Google" — the recommended path for everyone.
 *   2. SECONDARY: "Sign in with a User Key" — a hidden-by-default disclosure
 *      for existing customers who have generated a User Key from their
 *      dashboard (used by sub-accounts and programmatic clients).
 *
 * Email/password is fully removed from the UI.
 */
export default function Auth() {
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyLoading, setKeyLoading] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [inAppBrowser, setInAppBrowser] = useState<{ isInApp: boolean; appName: string }>({ isInApp: false, appName: '' });
  const navigate = useNavigate();

  // Detect in-app browser on mount. Google blocks OAuth inside Instagram/
  // Facebook/TikTok WebViews, so we need to warn the user BEFORE they hit
  // the broken flow.
  useEffect(() => {
    setInAppBrowser(detectInAppBrowser());
  }, []);

  const copyUrlToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied — paste into Safari or Chrome');
    } catch {
      toast.error('Could not copy. Tap the share button instead.');
    }
  };

  // Try to escape the in-app browser by deep-linking to the system browser.
  // iOS: `x-safari-https://...` opens Safari from most in-app browsers.
  // Android: `intent://...` with browser_fallback_url opens the default
  // browser (Chrome, usually). If neither works, the warning card above
  // already gave the user instructions to do it manually.
  const escapeInAppBrowser = () => {
    const url = window.location.href;
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);

    if (isIOS) {
      // Strip the scheme and prepend x-safari-https://
      const noScheme = url.replace(/^https?:\/\//, '');
      window.location.href = `x-safari-https://${noScheme}`;
      // Fall-through: if x-safari handler doesn't exist, nothing visible
      // happens. The warning card still gives manual instructions.
      return true;
    }

    if (isAndroid) {
      // Android intent URL — opens Chrome (or default browser) directly
      const noScheme = url.replace(/^https?:\/\//, '');
      window.location.href = `intent://${noScheme}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
      return true;
    }

    return false;
  };

  const handleGoogleLogin = async () => {
    if (loading) return;

    // If we're in an in-app browser, try to escape to the system browser
    // FIRST. Google will reject the OAuth flow from inside IG/FB/TikTok
    // WebViews anyway, so attempting OAuth here just wastes the user's tap.
    if (inAppBrowser.isInApp) {
      const escaped = escapeInAppBrowser();
      if (escaped) {
        toast.success(`Opening in your browser... if nothing happens, copy the link.`);
        return;
      }
    }

    setLoading(true);
    try {
      // Let Lovable use its default redirect_uri (the `/~oauth/callback`
      // path on the current origin). We have a /~oauth/callback route
      // wired up in App.tsx that processes the OAuth response and
      // redirects to /app once the session lands.
      const result = await lovable.auth.signInWithOAuth('google');
      if (result.error) {
        console.error('Google OAuth error:', result.error);
        const msg = result.error?.message || String(result.error);
        toast.error(`Sign-in failed: ${msg}`);
        setLoading(false);
        return;
      }
      if (result.redirected) return;
      navigate('/app');
    } catch (err: any) {
      console.error('Google OAuth exception:', err);
      toast.error(`Sign-in unavailable: ${err?.message || 'unknown error'}`);
      setLoading(false);
    }
  };

  const handleApiKeyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      toast.error('Enter your User Key');
      return;
    }
    setKeyLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('api-key', {
        body: { action: 'validate', apiKey: apiKey.trim() },
      });
      if (error) throw error;
      if (!data?.valid) throw new Error(data?.error || 'Invalid User Key');

      if (data.token_hash) {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: data.token_hash,
          type: 'magiclink',
        });
        if (verifyError) throw verifyError;
        if (data.key_id) rememberUserKeyId(data.key_id);
        toast.success('Signed in with User Key!');
        navigate('/app');
      } else {
        throw new Error('Failed to create session');
      }
    } catch (err: any) {
      toast.error(err.message || 'User Key login failed');
    } finally {
      setKeyLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative">
      <button
        type="button"
        onClick={() => navigate('/')}
        aria-label="Back to home"
        className="absolute top-5 left-5 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded-md px-2 py-1"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="w-full max-w-sm space-y-8">
        {/* Logo + branding */}
        <div className="text-center space-y-3">
          <AnimatedLogo size={110} className="mx-auto" />
          <h1 className="text-2xl font-bold gradient-text">Client Engine</h1>
          <p className="text-[11px] tracking-[0.22em] font-semibold text-primary/80 uppercase">
            AI Client Acquisition Bot
          </p>
          <p className="text-base font-medium text-foreground">Never run out of clients again</p>
          <p className="text-sm text-muted-foreground">
            Sign in or create your account with Google
          </p>
        </div>

        {/* In-app browser warning — Google blocks OAuth in IG/FB/TikTok WebViews */}
        {inAppBrowser.isInApp && (
          <div className="rounded-xl border-2 border-amber-500/60 bg-amber-500/10 px-4 py-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-foreground">
                  Open in your real browser
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  You're inside the {inAppBrowser.appName} app. Google blocks sign-in here for security. Tap the
                  {' '}<strong>menu icon (⋯ or ⋮)</strong> at the top and choose
                  {' '}<strong>"Open in Browser"</strong> or
                  {' '}<strong>"Open in Safari/Chrome"</strong>.
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2 h-10 text-sm border-amber-500/40"
              onClick={copyUrlToClipboard}
            >
              <Copy className="w-4 h-4" />
              Copy link instead
            </Button>
          </div>
        )}

        {/* Fast-onboarding hint */}
        {!inAppBrowser.isInApp && (
          <div className="rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 flex items-start gap-2.5">
            <Sparkles className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-foreground">One-click access</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                No password, no email confirmation. Sign in with Google and you're in instantly.
              </p>
            </div>
          </div>
        )}

        {/* Google — the single CTA */}
        <Button
          className="w-full gap-3 h-14 text-base bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-lg hover:opacity-90 hover:shadow-xl transition-all"
          onClick={handleGoogleLogin}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Redirecting to Google...
            </>
          ) : inAppBrowser.isInApp ? (
            <>
              <ExternalLink className="w-5 h-5" />
              Open in browser to continue
            </>
          ) : (
            <>
              <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </>
          )}
        </Button>

        {/* Trust copy */}
        <p className="text-center text-xs text-muted-foreground leading-relaxed">
          We only use your Google account to verify your identity.
          <br />
          We never post, message, or read anything on your behalf.
        </p>

        {/* User Key — secondary, collapsed by default */}
        {!showKeyForm ? (
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => setShowKeyForm(true)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5 underline underline-offset-4"
            >
              <Key className="w-3 h-3" />
              Have a User Key? Sign in here
            </button>
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm font-semibold text-foreground">Sign in with User Key</p>
              </div>
              <button
                type="button"
                onClick={() => { setShowKeyForm(false); setApiKey(''); }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>

            <form onSubmit={handleApiKeyLogin} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="apikey" className="sr-only">User Key</Label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="apikey"
                    type="password"
                    placeholder="ftn_..."
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    className="pl-10 font-mono text-sm"
                    autoComplete="off"
                    required
                  />
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Generated from your dashboard. If the main account deletes the key, sign-in stops working immediately.
                </p>
              </div>
              <Button
                type="submit"
                variant="outline"
                className="w-full gap-2"
                disabled={keyLoading}
              >
                {keyLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Validating...
                  </>
                ) : (
                  <>
                    Sign in with User Key
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>
          </div>
        )}

        {/* Privacy / Terms */}
        <div className="rounded-xl border border-border bg-card/40 px-4 py-3 text-center text-xs text-muted-foreground">
          By continuing, you agree to our{' '}
          <a href="/privacy-policy" className="font-medium text-foreground underline underline-offset-4 hover:text-primary">
            Privacy Policy
          </a>{' '}
          and{' '}
          <a href="/terms" className="font-medium text-foreground underline underline-offset-4 hover:text-primary">
            Terms of Service
          </a>
          .
        </div>
      </div>
    </div>
  );
}
