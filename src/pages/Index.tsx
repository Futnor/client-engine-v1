import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { LiveSessionBanner } from '@/components/LiveSessionBanner';
import { useBotSession } from '@/hooks/useBotSession';
import { useWarmupSession } from '@/hooks/useWarmupSession';
import { useSubscription } from '@/hooks/useSubscription';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getTierLimits } from '@/lib/subscriptionTiers';
import { StatCard } from '@/components/StatCard';
import { ConfigPanel } from '@/components/ConfigPanel';
import { WeightDistribution } from '@/components/WeightDistribution';
import { DailyLimits } from '@/components/DailyLimits';
import { DmModeSelector } from '@/components/DmModeSelector';
import { ActivityLog } from '@/components/ActivityLog';
import { SessionTimer } from '@/components/SessionTimer';
import { OutreachPanel } from '@/components/OutreachPanel';
import { EngagementMonitor } from '@/components/EngagementMonitor';
import { AIResponseBooster } from '@/components/AIResponseBooster';
import { CustomerAcquisition } from '@/components/CustomerAcquisition';
import { WarmUpPanel } from '@/components/WarmUpPanel';
import { TargetingPanel } from '@/components/TargetingPanel';
import { ApiKeyManager } from '@/components/ApiKeyManager';

import { PlatformLoginGuide } from '@/components/PlatformLoginGuide';
import { QuickStartGuide } from '@/components/QuickStartGuide';
import { CollapsibleSection } from '@/components/CollapsibleSection';
import { SectionSidebar, SectionNavItem } from '@/components/SectionSidebar';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AccountHealthScore } from '@/components/AccountHealthScore';
import { SessionHistory } from '@/components/SessionHistory';
import { UsernameBlacklist } from '@/components/UsernameBlacklist';
import { ResponseRateTracker } from '@/components/ResponseRateTracker';
import { ScrollReveal } from '@/components/ScrollReveal';

import { ConnectAccountBanner } from '@/components/ConnectAccountBanner';
import { MobileDesktopNotice } from '@/components/MobileDesktopNotice';
import { VideoTutorial, VideoTutorialButton } from '@/components/VideoTutorial';
import { LockedFeatureCard } from '@/components/LockedFeatureCard';
import { SupportWidget } from '@/components/SupportWidget';
import { TiltCard } from '@/components/TiltCard';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Platform, AITargetingData, defaultAITargeting, defaultEngagementMonitor } from '@/lib/botEngine';
import { PUBLIC_EXTENSION_VERSION, compareExtensionVersions } from '@/lib/extensionVersions';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { 
  Play, 
  Square, 
  RotateCcw, 
  Heart, 
  UserPlus, 
  MessageCircle,
  Eye,
  
  Instagram,
  MonitorPlay,
  CreditCard,
  Lock,
  LogOut,
  Shield,
  Settings2,
  PieChart,
  MessageSquare,
  Flame,
  Sparkles,
  Key,
  Activity,
  Target,
  History,
  Ban,
  Zap,
  
  TrendingUp,
  Chrome,
  Download,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const Index = () => {
  const { 
    config, 
    setConfig, 
    stats, 
    logs, 
    isRunning, 
    isPaused,
    limitWarning,
    extensionConnected,
    extensionVersion,
    warmupOffer,
    startSession, 
    stopSession, 
    pauseSession,
    resumeSession,
    continuePastLimit,
    resetStats,
    acceptWarmup,
    dismissWarmup,
  } = useBotSession();
  const { tier, trialDaysLeft, loading: subLoading } = useSubscription();
  const { isReady: authReady, user } = useAuthReady();
  const limits = getTierLimits(tier);
  const navigate = useNavigate();
  const canUseBot = tier !== 'free';
  const [hasStartedOnce, setHasStartedOnce] = useState(false);
  const [targetingMode, setTargetingMode] = useState<'manual' | 'ai'>(
    config.aiTargeting?.enabled ? 'ai' : 'manual'
  );

  // Lift warmup hook to Index so it survives WarmUpPanel collapse
  const warmupSession = useWarmupSession();

  const isTargetingReady = (() => {
    if (targetingMode === 'ai') {
      const ai = config.aiTargeting;
      return ai?.enabled && (ai.searchTerms?.length > 0 || ai.keywords?.length > 0);
    }
    const t = config.targeting;
    if (!t?.targetTypes?.length) return false;
    const type = t.targetTypes[0];
    switch (type) {
      case 'hashtags': return !!t.hashtags?.trim();
      case 'location': return !!t.location?.trim();
      case 'followers':
      case 'following': return !!t.targetUsername?.trim();
      case 'likers':
      case 'commenters': return !!t.targetPostLink?.trim();
      case 'custom': return (t.customUsernames?.length || 0) > 0;
      default: return false;
    }
  })();

  const startDisabledReason = !authReady
    ? 'Checking account...'
    : !canUseBot 
      ? 'Subscribe to start' 
      : !isTargetingReady 
        ? 'Set up targeting first' 
        : null;

  const focusOrOpenPlatform = () => {
    try {
      const payload = {
        type: 'FOCUS_BOT_TAB',
        platform: config.platform,
        processed: false,
        timestamp: Date.now(),
      };
      localStorage.setItem('futnor_command', JSON.stringify(payload));
      window.postMessage({ source: 'futnor-web', command: payload }, '*');
    } catch {
      const url = config.platform === 'tiktok'
        ? 'https://www.tiktok.com'
        : 'https://www.instagram.com';
      window.open(url, 'futnor_platform_tab');
    }
  };

  const handleStart = async () => {
    if (!authReady || !user) {
      toast.error('Authentication is still loading. Please try again in a moment.');
      return;
    }

    if (!canUseBot) { navigate('/pricing'); return; }
    if (!isTargetingReady) {
      toast.error('Set up your targeting first — choose who to reach before starting.');
      return;
    }
    setHasStartedOnce(true);

    try {
      localStorage.setItem('futnor_bot_state', JSON.stringify({
        config: { ...config, aiTargeting: config.aiTargeting },
        stats,
        platform: config.platform,
      }));
    } catch {}

    const result = await startSession({
      authReady,
      tier,
      userId: user.id,
    });

    if (result.status === 'session_started') {
      setTimeout(focusOrOpenPlatform, 500);
      return;
    }

    if (result.status === 'not_detected') {
      toast.error('No chrome extension detected');
      return;
    }

    if (result.status === 'start_failed') {
      toast.error(result.message);
      return;
    }

    // Pull a user-friendly message for the rejection. Order of preference:
    //   1. Specific known reasons keep their bespoke copy.
    //   2. Safety-gate reasons added in v2.4.90+ (session_cooldown, recent_block)
    //      — surface the message field the extension supplied verbatim because
    //      it includes the actual countdown ("~87 min") or block reason.
    //   3. If the extension supplied a message but the reason is unknown, show
    //      that instead of the legacy generic text — it's almost always more useful.
    //   4. Last-resort: legacy generic.
    const rejectionMessage = (() => {
      switch (result.reason) {
        case 'auth_not_ready':
          return 'Authentication is still syncing. Please try again.';
        case 'no_targeting':
          return 'Set up your targeting first.';
        case 'missing_dm_script_for_account':
          return `No script bulk active for @${result.account}. Open Scripts and toggle a bulk on for this account.`;
        case 'missing_dm_script':
          return 'Add at least one DM script in DM Mode before starting.';
        case 'no_subscription':
          return 'Subscription required before starting a session.';
        case 'session_cooldown':
          // Extension's message includes the live countdown.
          return result.message
            || 'Inter-session cooldown active — wait before starting another session.';
        case 'daily_goal_met':
          // Extension's message includes the actual count vs. goal.
          return result.message
            || 'Daily session goal already reached. Raise the goal or wait until midnight to start another session.';
        case 'recent_block':
          // Extension's message includes the block reason and how long ago.
          return result.message
            || 'Instagram flagged this account recently. Wait at least 24h and resolve any in-app verification before resuming.';
        default:
          return result.message || 'Extension is connected but failed to start session';
      }
    })();
    toast.error(rejectionMessage);
  };

  // Wire warmup auto-DM callback at this level so it survives panel collapse
  useEffect(() => {
    if (isTargetingReady && canUseBot) {
      warmupSession.setOnWarmupComplete(handleStart);
    } else {
      warmupSession.setOnWarmupComplete(null);
    }
    return () => warmupSession.setOnWarmupComplete(null);
  }, [isTargetingReady, canUseBot, warmupSession.setOnWarmupComplete]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/auth');
  };

  // Store the anon key in localStorage so the extension bridge can sync it
  useEffect(() => {
    const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (anonKey) {
      localStorage.setItem('futnor_supabase_anon_key', anonKey);
    }
  }, []);

  // Save session history ONCE when session ends — use a ref to prevent duplicates
  const sessionSavedRef = useRef(false);
  const prevIsRunningRef = useRef(false);

  useEffect(() => {
    // Detect transition from running → stopped
    if (prevIsRunningRef.current && !isRunning && hasStartedOnce && !sessionSavedRef.current) {
      sessionSavedRef.current = true;

      // Delay slightly to let final stats sync from extension
      const saveTimeout = setTimeout(async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) return;

        const instagramAccountUsername = (() => {
          try {
            const raw = localStorage.getItem('futnor_active_account') || '';
            const normalized = raw.toLowerCase().replace(/^@/, '').trim();
            return normalized || null;
          } catch {
            return null;
          }
        })();

        // Only save if there was meaningful activity
        if (stats.elapsedTime < 3 && stats.dmsSent === 0 && stats.likesSent === 0 && stats.followsSent === 0 && stats.scrolls === 0) {
          return;
        }

        await supabase.from('session_history').insert({
          user_id: session.user.id,
          platform: config.platform,
          instagram_account_username: config.platform === 'instagram' ? instagramAccountUsername : null,
          duration_seconds: stats.elapsedTime,
          dms_sent: stats.dmsSent,
          likes_sent: stats.likesSent,
          follows_sent: stats.followsSent,
          scrolls: stats.scrolls,
          targeting_mode: targetingMode,
        } as any);
      }, 1500); // Wait 1.5s for final stats sync

      return () => clearTimeout(saveTimeout);
    }

    prevIsRunningRef.current = isRunning;

    // Reset the saved flag when a new session starts
    if (isRunning) {
      sessionSavedRef.current = false;
    }
  }, [isRunning, hasStartedOnce]);

  if (subLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-6 lg:p-8 pb-24 lg:pb-8">
      <div className="max-w-6xl mx-auto flex gap-6">
        {/* ── Desktop Sidebar Nav ── */}
        {(
          <SectionSidebar
            items={[
              { id: 'section-customer-acquisition', label: 'AI Search', icon: Sparkles },
              { id: 'section-targeting', label: 'Targeting', icon: Target },
              { id: 'section-dm-mode', label: config.platform === 'tiktok' ? 'Comments' : 'DM Mode', icon: MessageSquare },
              ...(config.platform === 'instagram' ? [{ id: 'section-engagement-monitor', label: 'Engage → DM', icon: Zap }] : []),
              { id: 'section-blacklist', label: 'Blacklist', icon: Ban },
              { id: 'section-config', label: 'Config', icon: Settings2 },
              { id: 'section-distribution', label: 'Distribution', icon: PieChart },
              { id: 'section-history', label: 'History', icon: History },
              { id: 'section-warmup', label: 'Warm-Up', icon: Flame, badge: 'Pro+' },
              { id: 'section-api-keys', label: 'User Keys', icon: Key },
              { id: 'section-response-rate', label: 'Response Rate', icon: TrendingUp },
              { id: 'section-activity', label: 'Activity', icon: Activity },
            ] as SectionNavItem[]}
          />
        )}
        <div className="flex-1 min-w-0 max-w-4xl mx-auto space-y-6">

        {/* ── Header ── */}
        <ScrollReveal direction="down" duration={500}>
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AnimatedLogo size={80} />
            <div>
              <h1 className="text-xl font-bold gradient-text leading-tight">Client Engine</h1>
              <p className="text-[10px] tracking-[0.22em] font-semibold text-primary/80 uppercase mt-0.5">
                AI Client Acquisition Bot
              </p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary font-semibold capitalize">
                  {tier === 'admin' ? '👑 Admin' : trialDaysLeft !== null && trialDaysLeft > 0 ? `🎁 Trial (${trialDaysLeft}d)` : tier}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  extensionConnected
                    ? 'bg-success/20 text-success'
                    : 'bg-warning/20 text-warning'
                }`}>
                  {extensionConnected ? '🔌 Extension connected' : '⚠️ No extension detected'}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            {tier === 'admin' && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/admin')}>
                <Shield className="w-4 h-4" />
                <span className="hidden sm:inline">Admin</span>
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/pricing')}>
              <CreditCard className="w-4 h-4" />
              <span className="hidden sm:inline">Plans</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>
        </ScrollReveal>

        {/* ── Mobile users: prominent "open on your computer" notice ──
              Detects mobile via UA and shows a friendly step-by-step card
              explaining that the bot itself runs as a Chrome extension and
              they need to continue setup on desktop. Dismissible per session
              so they aren't nagged on every refresh. Auto-hides on desktop. */}
        <MobileDesktopNotice variant="dashboard" />

        {/* ── Extension install / update button ──
              Uses PUBLIC_EXTENSION_VERSION (the version actually published
              on the Chrome Web Store), NOT the internal latest build. We
              never want to tell regular users to update to a version that
              isn't on the store yet — they'd just see the same old version
              when they click through. The constant lives in
              src/lib/extensionVersions.ts and only gets bumped after the
              Web Store has published the new build. */}
        {(() => {
          const LATEST_VERSION = PUBLIC_EXTENSION_VERSION;
          const compareVersions = compareExtensionVersions;
          // If extension is connected but doesn't report a version, it's an old build
          // (version reporting was added in v2.4.48). Treat missing version as outdated.
          const hasVersion = Boolean(extensionVersion);
          const isOutdated =
            extensionConnected &&
            (!hasVersion || compareVersions(extensionVersion as string, LATEST_VERSION) < 0);
          const displayVersion = hasVersion ? (extensionVersion as string) : 'older';
          const showBanner = !extensionConnected || isOutdated;
          if (!showBanner) return null;

          return (
            <ScrollReveal direction="up" delay={100}>
              <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/5 to-accent/5 p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                    <Chrome className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                      {isOutdated ? 'Extension Update Available' : 'Chrome Extension Required'}
                      <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border-0 text-[10px]">
                        {isOutdated
                          ? hasVersion
                            ? `v${extensionVersion} → v${LATEST_VERSION}`
                            : `Older build → v${LATEST_VERSION}`
                          : 'New version available'}
                      </Badge>
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                      {isOutdated
                        ? hasVersion
                          ? `You're running an older build (v${extensionVersion}). Update to v${LATEST_VERSION} from the Chrome Web Store to get the latest fixes and improvements.`
                          : `You're running an older build of the extension that doesn't report its version. Update to v${LATEST_VERSION} from the Chrome Web Store to get the latest fixes and improvements.`
                        : 'Install Client Engine from the Chrome Web Store — one click, no manual setup.'}
                    </p>
                  </div>
                </div>
                <Button onClick={() => navigate('/install-extension')} className="gap-2 w-full sm:w-auto shrink-0">
                  <Download className="w-4 h-4" />
                  {isOutdated ? 'Update Extension' : 'Install Extension'}
                </Button>
              </div>
            </ScrollReveal>
          );
        })()}

        {/* ── Connect Instagram/TikTok account ── */}
        {extensionConnected && (
          <ScrollReveal direction="up" delay={100}>
            <ConnectAccountBanner platform={config.platform} extensionConnected={extensionConnected} />
          </ScrollReveal>
        )}

        {/* Free-tier slim banner. Free users now see all sections so they can
            browse + understand the product; a thin sticky-feel banner explains
            the bot itself stays locked until they subscribe. Replaces the
            old full-screen "Subscribe to Unlock" gate. */}
        {!canUseBot && (
          <ScrollReveal direction="up">
            <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-accent/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <Lock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-tight">You're on the free tier — browse everything, run the bot after upgrading.</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Pro features are labeled <span className="font-semibold text-primary">Pro+</span>. Starting a session requires any paid plan or trial.</p>
                </div>
              </div>
              <Button onClick={() => navigate('/pricing')} size="sm" className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground flex-shrink-0">
                <CreditCard className="w-4 h-4" /> View Plans
              </Button>
            </div>
          </ScrollReveal>
        )}

        {/* ── Quick Start Guide ── */}
        {(
          <QuickStartGuide
            platform={config.platform}
            isRunning={isRunning}
            hasStartedOnce={hasStartedOnce}
          />
        )}

        {/* ── Account Health Score ── */}
        {(
          <AccountHealthScore
            stats={stats}
            hasWarmedUp={config.isWarmedUp}
            dmMode={config.dmMode}
            isRunning={isRunning}
            onGoToWarmup={() => {
              const el = document.getElementById('section-warmup');
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                window.dispatchEvent(new CustomEvent('section-highlight', { detail: { sectionId: 'section-warmup' } }));
              }
            }}
            onGoToDelays={() => {
              const el = document.getElementById('section-config');
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                window.dispatchEvent(new CustomEvent('section-highlight', { detail: { sectionId: 'section-config' } }));
              }
            }}
            canWarmUp={!!limits.warmUp}
            onUpgrade={() => navigate('/pricing')}
            sessionDmGoal={config.sessionDmGoal}
            goalLabel={config.platform === 'tiktok' ? 'comment' : 'DM'}
          />
        )}

        {/* ── Tutorial CTA pill — scrolls to + auto-opens the video below ── */}
        {(
          <div className="flex justify-center -mt-2">
            <VideoTutorialButton targetId="section-tutorial" />
          </div>
        )}

        {/* ── Embedded YouTube tutorial (collapsed by default; expands on click) ── */}
        {<VideoTutorial id="section-tutorial" />}

        {/* ── Status + Main Action ── */}
        {(
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
              <span className="text-sm font-medium">
                {isRunning ? 'Session running…' : hasStartedOnce ? 'Session complete' : 'Ready to start'}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              {!isRunning ? (
                <div className="flex flex-col flex-1 sm:flex-none">
                  <Button
                    onClick={handleStart}
                    disabled={!!startDisabledReason}
                    className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90 glow-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    size="lg"
                  >
                    <Play className="w-5 h-5" />
                    {startDisabledReason || 'Start Session'}
                  </Button>
                  {startDisabledReason && (
                    <span className="text-xs text-muted-foreground mt-1 text-center">
                      {startDisabledReason === 'Set up targeting first' 
                        ? '↓ Configure targeting below to enable' 
                        : 'Choose a plan to unlock'}
                    </span>
                  )}
                </div>
              ) : (
                <Button
                  onClick={stopSession}
                  variant="destructive"
                  className="gap-2 flex-1 sm:flex-none"
                  size="lg"
                >
                  <Square className="w-4 h-4" />
                  Stop Session
                </Button>
              )}
              <div className="flex items-center gap-2">
                <Button 
                  onClick={focusOrOpenPlatform} 
                  variant="outline" size="sm" className="gap-1.5 flex-1 sm:flex-none" disabled={!isRunning}
                >
                  <MonitorPlay className="w-4 h-4" /> Watch Live
                </Button>
                <Button onClick={resetStats} variant="outline" size="sm" className="gap-1.5 flex-1 sm:flex-none" disabled={isRunning}>
                  <RotateCcw className="w-4 h-4" /> Reset
                </Button>
                <SessionTimer elapsed={stats.elapsedTime} total={stats.sessionTime} isRunning={isRunning} />
              </div>
            </div>

            <LiveSessionBanner 
              isRunning={isRunning} 
              isPaused={isPaused}
              stats={stats} 
              logs={logs} 
              platform={config.platform}
              limitWarning={limitWarning}
              onPause={pauseSession}
              onResume={resumeSession}
              onStop={stopSession}
              onContinuePastLimit={continuePastLimit}
            />

            {warmupOffer && !isRunning && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3 animate-fade-in">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center flex-shrink-0">
                    <Flame className="w-5 h-5 text-accent" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-foreground">Daily Limits Reached — Warm Up Your Account?</h3>
                    <p className="text-xs text-muted-foreground">
                      Running a warm-up session after outreach helps keep your account healthy. 
                      The bot will browse, scroll, view stories, and like posts naturally for 15 minutes.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 ml-[52px]">
                  <Button onClick={acceptWarmup} size="sm" className="gap-1.5 bg-gradient-to-r from-accent to-primary text-primary-foreground hover:opacity-90">
                    <Flame className="w-3.5 h-3.5" /> Yes, Warm Up
                  </Button>
                  <Button onClick={dismissWarmup} variant="outline" size="sm">
                    No Thanks
                  </Button>
                </div>
              </div>
            )}

            {/* ── Stats Grid ── */}
            <ScrollReveal direction="up" delay={100}>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Track your bot's activity in real-time</p>
              <div className={`grid ${config.platform === 'tiktok' ? 'grid-cols-3' : 'grid-cols-2 md:grid-cols-4'} gap-3`}>
                <TiltCard maxTilt={8} scale={1.03} className="rounded-xl">
                  <StatCard label="Scrolls" value={stats.scrolls} icon={Eye} variant="primary" />
                </TiltCard>
                <TiltCard maxTilt={8} scale={1.03} className="rounded-xl">
                  <StatCard label="Likes" value={stats.likesSent} max={limits.dailyMaxLikes} icon={Heart} variant="success" />
                </TiltCard>
                {config.platform === 'tiktok' ? (
                  <TiltCard maxTilt={8} scale={1.03} className="rounded-xl">
                    <StatCard 
                      label="Comments"
                      value={stats.dmsSent} max={limits.dailyMaxDMs} icon={MessageCircle} variant="accent"
                    />
                  </TiltCard>
                ) : (
                  <>
                    <TiltCard maxTilt={8} scale={1.03} className="rounded-xl">
                      <StatCard label="Follows" value={stats.followsSent} max={limits.dailyMaxFollows} icon={UserPlus} variant={config.dmMode === 'human' ? 'primary' : 'warning'} />
                    </TiltCard>
                    <TiltCard maxTilt={8} scale={1.03} className="rounded-xl">
                      <StatCard 
                        label="DMs Sent"
                        value={stats.dmsSent} max={limits.dailyMaxDMs} icon={MessageCircle} variant="accent"
                      />
                    </TiltCard>
                  </>
                )}
              </div>
            </div>
            </ScrollReveal>

            {/* ── Activity Log ── */}
            <div id="section-activity">
              <ActivityLog logs={logs} />
            </div>
          </div>
        )}

        <ScrollReveal direction="up" delay={50}>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground px-1">Pick which platform to automate</p>
          <div className="flex gap-3">
            <TiltCard maxTilt={6} scale={1.02} className="flex-1 rounded-xl">
            <button
              onClick={() => setConfig({ ...config, platform: 'instagram', targeting: { ...config.targeting, customUsernames: [] } })}
              disabled={isRunning}
              className={`w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border-2 font-semibold text-sm transition-all ${
                config.platform === 'instagram'
                  ? 'border-pink-500 bg-gradient-to-r from-pink-500/20 to-orange-500/20 text-foreground shadow-lg shadow-pink-500/10'
                  : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/50'
              } ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <Instagram className="w-5 h-5" /> Instagram
            </button>
            </TiltCard>
            <TiltCard maxTilt={6} scale={1.02} className="flex-1 rounded-xl">
            <button
              onClick={() => {
                if (tier !== 'admin') {
                  toast.info('TikTok automation is coming soon! Stay tuned.');
                  return;
                }
                setConfig({ ...config, platform: 'tiktok', targeting: { ...config.targeting, customUsernames: [] } });
              }}
              disabled={isRunning || (tier !== 'admin' && limits.platforms < 2)}
              className={`w-full relative flex items-center justify-center gap-3 py-3 px-4 rounded-xl border-2 font-semibold text-sm transition-all ${
                config.platform === 'tiktok'
                  ? 'border-cyan-400 bg-gradient-to-r from-cyan-400/20 to-pink-500/20 text-foreground shadow-lg shadow-cyan-400/10'
                  : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/50'
              } ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.93a8.2 8.2 0 0 0 4.76 1.52V7a4.84 4.84 0 0 1-1-.31z"/></svg>
              TikTok
              {tier !== 'admin' ? (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold uppercase tracking-wide">Coming Soon</span>
              ) : limits.platforms < 2 ? <Lock className="w-3 h-3 ml-1" /> : null}
            </button>
            </TiltCard>
          </div>
        </div>
        </ScrollReveal>

        {/* ── Collapsible: AI Customer Acquisition ── */}
        {(
          <ScrollReveal direction="up">
          <CollapsibleSection
            id="section-customer-acquisition"
            icon={Sparkles}
            title="A.I Customer Acquisition"
            description="Search → Extract → Filter → Inject → DM in seconds"
          >
            <CustomerAcquisition
              platform={config.platform}
              config={config}
              onApplyTargeting={setConfig}
              disabled={isRunning}
              tier={tier}
            />
          </CollapsibleSection>
          </ScrollReveal>
        )}

        {/* ── Collapsible: Targeting ── */}
        <ScrollReveal direction="up" delay={50}>
        <CollapsibleSection
          id="section-targeting"
          icon={Target}
          title="Targeting"
          description="Choose who to target and filter by account size"
          defaultOpen
        >
          <TargetingPanel config={config} onChange={setConfig} disabled={isRunning} />
        </CollapsibleSection>
        </ScrollReveal>

        {/* ── Collapsible: DM / Comment Mode ── */}
        {limits.dailyMaxDMs > 0 && (
          <ScrollReveal direction="up" delay={50}>
          <CollapsibleSection
            id="section-dm-mode"
            icon={MessageSquare}
            title={config.platform === 'tiktok' ? 'Comment Mode' : 'DM Mode'}
            description={config.platform === 'tiktok' ? 'Choose between automatic and manual comment behavior' : 'Choose between automatic and manual DM behavior'}
          >
            <DmModeSelector config={config} onChange={setConfig} disabled={isRunning} tier={tier} />
          </CollapsibleSection>
          </ScrollReveal>
        )}

        {/* ── Collapsible: Engagement Monitor (Instagram only) ──
            Render for all paying tiers; locked card for free users so they
            can see the feature exists. */}
        {config.platform === 'instagram' && (
          <ScrollReveal direction="up" delay={50}>
          <CollapsibleSection
            id="section-engagement-monitor"
            icon={Zap}
            title="Engagement → DM"
            description="Auto-DM users who comment, like, or follow"
            badge={limits.engageDm ? undefined : 'Pro+'}
          >
            {limits.engageDm ? (
              <EngagementMonitor config={config} onChange={setConfig} disabled={isRunning} tier={tier} />
            ) : (
              <LockedFeatureCard
                featureName="Engagement → DM"
                requiredTier="Growth or Scale"
                description="Auto-DM users who comment on or like your posts, or who follow your account. Highest-converting outreach because targets are already engaged."
              />
            )}
          </CollapsibleSection>
          </ScrollReveal>
        )}

        {/* ── AI Response Booster (post-DM commenting) — Instagram only ── */}
        {config.platform === 'instagram' && (
          <ScrollReveal direction="up" delay={50}>
            <AIResponseBooster tier={tier} />
          </ScrollReveal>
        )}

        <ScrollReveal direction="up" delay={50}>
        <CollapsibleSection
          id="section-blacklist"
          icon={Ban}
          title="Username Blacklist"
          description="Accounts the bot should never engage with"
        >
          <UsernameBlacklist />
        </CollapsibleSection>
        </ScrollReveal>

        {/* ── Collapsible: Configuration ── */}
        <ScrollReveal direction="up" delay={50}>
        <CollapsibleSection
          id="section-config"
          icon={Settings2}
          title="Configuration"
          description="Control session length and action speed"
        >
          <ConfigPanel config={config} onChange={setConfig} disabled={isRunning} isHumanMode={config.dmMode === 'human'} />
        </CollapsibleSection>
        </ScrollReveal>

        {/* ── Collapsible: Weight Distribution ── */}
        <ScrollReveal direction="up" delay={50}>
        <CollapsibleSection
          id="section-distribution"
          icon={PieChart}
          title="Action Distribution"
          description="Control how often each action type occurs"
        >
          <WeightDistribution config={config} onChange={setConfig} disabled={isRunning || config.dmMode === 'human'} />
        </CollapsibleSection>
        </ScrollReveal>

        {/* ── Collapsible: Session History ── */}
        {(
          <ScrollReveal direction="up" delay={50}>
          <CollapsibleSection
            id="section-history"
            icon={History}
            title="Session History"
            description="View past sessions with charts and stats"
          >
            <SessionHistory />
          </CollapsibleSection>
          </ScrollReveal>
        )}

        {/* ── Collapsible: DM Response Rate ── */}
        <ScrollReveal direction="up" delay={50}>
          <CollapsibleSection
            id="section-response-rate"
            icon={TrendingUp}
            title="DM Response Rate"
            description="Track how many people respond to your DMs"
          >
            <ResponseRateTracker />
          </CollapsibleSection>
          </ScrollReveal>

        {/* ── Collapsible: Warm-Up (Pro+) ──
            Always render so free users can discover the feature. If they
            aren't entitled, swap the panel content for a locked card with
            upgrade CTA. */}
        <ScrollReveal direction="up" delay={50}>
        <CollapsibleSection
          id="section-warmup"
          icon={Flame}
          title="Account Warm-Up"
          description={config.platform === 'tiktok' ? 'Gradually increase comment activity to keep your account safe' : 'Gradually increase activity to keep your account safe'}
          badge="Pro+"
        >
          {limits.warmUp ? (
            <WarmUpPanel warmupSession={warmupSession} />
          ) : (
            <LockedFeatureCard
              featureName="Account Warm-Up"
              requiredTier="Growth or Scale"
              description="Run gradual warm-up sessions to safely build account activity before scaling DMs. Protects new accounts from Instagram's rate limits."
            />
          )}
        </CollapsibleSection>
        </ScrollReveal>


        {/* ── Collapsible: API Keys ── */}
        {(
          <ScrollReveal direction="up" delay={50}>
          <CollapsibleSection
            id="section-api-keys"
            icon={Key}
            title="User Keys"
            description="Use these to log in on other Chrome profiles"
          >
            <ApiKeyManager />
          </CollapsibleSection>
          </ScrollReveal>
        )}

      </div>
      </div>

      {/* ── Mobile Bottom Nav ── */}
      {(
        <MobileBottomNav
          items={[
            { id: 'section-customer-acquisition', label: 'AI Search', icon: Sparkles },
            { id: 'section-targeting', label: 'Targeting', icon: Target },
            { id: 'section-dm-mode', label: config.platform === 'tiktok' ? 'Comments' : 'DMs', icon: MessageSquare },
            ...(config.platform === 'instagram' ? [{ id: 'section-engagement-monitor', label: 'Engage', icon: Zap }] : []),
            { id: 'section-blacklist', label: 'Blacklist', icon: Ban },
            { id: 'section-config', label: 'Config', icon: Settings2 },
            { id: 'section-distribution', label: 'Weights', icon: PieChart },
            { id: 'section-history', label: 'History', icon: History },
            { id: 'section-warmup', label: 'Warm-Up', icon: Flame },
            { id: 'section-api-keys', label: 'User Keys', icon: Key },
            { id: 'section-response-rate', label: 'Response', icon: TrendingUp },
            { id: 'section-activity', label: 'Activity', icon: Activity },
          ]}
        />
      )}

      {/* Footer with legal links (required for Google OAuth branding verification) */}
      <footer className="mt-12 pb-6 text-center text-xs text-muted-foreground space-x-2">
        <a href="/privacy-policy" className="hover:underline">Privacy Policy</a>
        <span>·</span>
        <a href="/terms" className="hover:underline">Terms of Service</a>
        <span>·</span>
        <a href="/support" className="hover:underline">Support</a>
      </footer>

      <SupportWidget />
    </div>
  );
};

export default Index;
