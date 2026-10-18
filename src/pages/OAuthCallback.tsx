import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthReady } from '@/hooks/useAuthReady';
import { LoadingBot } from '@/components/LoadingBot';

/**
 * OAuth callback handler at `/~oauth/callback`.
 *
 * Lovable's OAuth proxy redirects here after Google completes — it appends
 * `?code=...&state=...` (or `#access_token=...` for implicit flow) and the
 * Lovable client library auto-detects and processes those URL params on
 * any page load, setting the Supabase session under the hood.
 *
 * Our job: render a loading state while that happens, then redirect to
 * `/app` once `useAuthReady` reports a session. Without this route, mobile
 * users land at the 404 / NotFound page and get stuck.
 *
 * Falls back to `/login` with an error toast if no session materialises
 * within 15s (network failure, blocked third-party cookies, etc).
 */
export default function OAuthCallback() {
  const { session, isReady } = useAuthReady();
  const navigate = useNavigate();
  const [timedOut, setTimedOut] = useState(false);

  // Success path: session is set → redirect to /app
  useEffect(() => {
    if (isReady && session) {
      // Honor `?next=` handoff from the MCP consent route (or any deep-link
      // that stashed a same-origin path in sessionStorage before /login).
      let target = '/app';
      try {
        const stashed = sessionStorage.getItem('lovable:postLoginNext');
        if (stashed && stashed.startsWith('/') && !stashed.startsWith('//')) {
          target = stashed;
          sessionStorage.removeItem('lovable:postLoginNext');
        }
      } catch {}
      navigate(target, { replace: true });
    }
  }, [isReady, session, navigate]);


  // Failure path: 15s timeout
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!session) setTimedOut(true);
    }, 15000);
    return () => clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    if (timedOut) {
      navigate('/login?error=oauth_timeout', { replace: true });
    }
  }, [timedOut, navigate]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
      <LoadingBot width={140} />
      <p className="text-sm text-muted-foreground animate-pulse">Signing you in...</p>
      <p className="text-xs text-muted-foreground">Hold on a moment</p>
    </div>
  );
}
