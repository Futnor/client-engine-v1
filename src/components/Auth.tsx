import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { lovable } from '@/integrations/lovable';
import { rememberUserKeyId } from '@/hooks/useUserKeyWatcher';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Mail, Lock, Eye, EyeOff, ArrowRight, Key } from 'lucide-react';
import logo from '@/assets/logo.png';
import { useNavigate } from 'react-router-dom';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [authMode, setAuthMode] = useState<'email' | 'apikey'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [showSignupHint, setShowSignupHint] = useState(false);
  const navigate = useNavigate();

  const handleApiKeyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) { toast.error('Enter your User Key'); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('api-key', {
        body: { action: 'validate', apiKey: apiKey.trim() },
      });
      if (error) throw error;
      if (!data?.valid) throw new Error(data?.error || 'Invalid User Key');

      // Use the verification URL to complete auth
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
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setShowSignupHint(false);
    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate('/app');
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/app` },
        });
        if (error) throw error;
        toast.success('Check your email to confirm your account!');
      }
    } catch (err: any) {
      const msg = err.message || 'Authentication failed';
      if (isLogin && msg.toLowerCase().includes('invalid login credentials')) {
        setShowSignupHint(true);
        toast.error('Invalid login credentials');
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      const result = await lovable.auth.signInWithOAuth('google', {
        redirect_uri: `${window.location.origin}/app`,
      });
      if (result.error) {
        console.error('Google OAuth error:', result.error);
        toast.error('Google sign-in failed. Please try email/password or try again later.');
        return;
      }
      if (result.redirected) return;
      navigate('/app');
    } catch (err: any) {
      console.error('Google OAuth exception:', err);
      toast.error('Google sign-in is temporarily unavailable. Please use email/password.');
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast.error('Enter your email first'); return; }
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      toast.success('Password reset link sent to your email!');
      setShowForgot(false);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (showForgot) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-xl font-bold">Reset Password</h2>
            <p className="text-sm text-muted-foreground">Enter your email to receive a reset link</p>
          </div>
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input id="reset-email" type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} className="pl-10" required />
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>{loading ? 'Sending...' : 'Send Reset Link'}</Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => setShowForgot(false)}>Back to login</Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="text-center space-y-3">
          <img src={logo} alt="Client Engine" className="w-16 h-16 mx-auto" />
          <h1 className="text-2xl font-bold gradient-text">Client Engine</h1>
          <p className="text-base font-medium text-foreground">Never run out of clients again</p>
          <p className="text-sm text-muted-foreground">
            {isLogin ? 'Sign in to access your dashboard' : 'Create your account to get started'}
          </p>
        </div>

        {/* Google */}
        <Button variant="outline" className="w-full gap-2 h-11" onClick={handleGoogleLogin}>
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border" /></div>
          <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or</span></div>
        </div>

        {/* Auth mode toggle */}
        <div className="flex gap-2">
          <Button
            variant={authMode === 'email' ? 'default' : 'outline'}
            className="flex-1 gap-2"
            size="sm"
            onClick={() => setAuthMode('email')}
          >
            <Mail className="w-4 h-4" />
            Email
          </Button>
          <Button
            variant={authMode === 'apikey' ? 'default' : 'outline'}
            className="flex-1 gap-2"
            size="sm"
            onClick={() => setAuthMode('apikey')}
          >
            <Key className="w-4 h-4" />
            User Key
          </Button>
        </div>

        {/* Email form */}
        {authMode === 'email' ? (
          <form onSubmit={handleEmailAuth} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} className="pl-10" required />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input id="password" type={showPassword ? 'text' : 'password'} placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} className="pl-10 pr-10" required minLength={6} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {isLogin && (
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowForgot(true)}>
                Forgot password?
              </button>
            )}

            {isLogin && showSignupHint && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
                Don't have an account?{' '}
                <button
                  type="button"
                  className="font-medium text-primary underline underline-offset-4"
                  onClick={() => {
                    setIsLogin(false);
                    setShowSignupHint(false);
                  }}
                >
                  Sign up here
                </button>
              </div>
            )}

            <Button type="submit" className="w-full gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground" disabled={loading}>
              {loading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
              <ArrowRight className="w-4 h-4" />
            </Button>
          </form>
        ) : (
          <form onSubmit={handleApiKeyLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apikey">User Key</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="apikey"
                  type="password"
                  placeholder="ftn_..."
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  className="pl-10 font-mono"
                  required
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Generate your User Key from the dashboard → User Key section. Use it to connect other Instagram accounts.
              </p>
            </div>
            <Button type="submit" className="w-full gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground" disabled={loading}>
              {loading ? 'Validating...' : 'Connect Account with User Key'}
              <ArrowRight className="w-4 h-4" />
            </Button>
          </form>
        )}

        <p className="text-center text-sm text-muted-foreground">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button className="text-primary hover:underline font-medium" onClick={() => setIsLogin(!isLogin)}>
            {isLogin ? 'Sign Up' : 'Sign In'}
          </button>
        </p>

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
