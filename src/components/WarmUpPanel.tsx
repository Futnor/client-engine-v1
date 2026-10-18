import React from 'react';
import { useWarmupSession } from '@/hooks/useWarmupSession';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Flame,
  Play,
  Square,
  Eye,
  Heart,
  Search,
  MessageCircle,
  ScrollText,
  Coffee,
  ArrowUp,
  Zap,
  Clock,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WarmupAction } from '@/lib/warmupEngine';

const actionIcons: Record<WarmupAction, React.ReactNode> = {
  scroll_feed: <ScrollText className="w-3.5 h-3.5" />,
  scroll_explore: <Search className="w-3.5 h-3.5" />,
  view_story: <Eye className="w-3.5 h-3.5" />,
  like_post: <Heart className="w-3.5 h-3.5" />,
  pause: <Coffee className="w-3.5 h-3.5" />,
  read_comments: <MessageCircle className="w-3.5 h-3.5" />,
  scroll_back: <ArrowUp className="w-3.5 h-3.5" />,
};

const actionColors: Record<WarmupAction, string> = {
  scroll_feed: 'text-primary',
  scroll_explore: 'text-accent',
  view_story: 'text-success',
  like_post: 'text-destructive',
  pause: 'text-muted-foreground',
  read_comments: 'text-primary',
  scroll_back: 'text-muted-foreground',
};

interface WarmUpPanelProps {
  warmupSession?: ReturnType<typeof useWarmupSession>;
}

export function WarmUpPanel({ warmupSession: warmupSessionProp }: WarmUpPanelProps) {
  // Fallback: if no session passed as prop, create a local one (backward compat)
  const localSession = useWarmupSession();
  const session = warmupSessionProp ?? localSession;

  const {
    isRunning,
    stats,
    logs,
    sessionMinutes,
    setSessionMinutes,
    currentAction,
    enableComments,
    setEnableComments,
    autoStartDM,
    setAutoStartDM,
    startWarmup,
    stopWarmup,
  } = session;

  const progressPct = stats.sessionTime > 0
    ? Math.min(100, (stats.elapsedTime / stats.sessionTime) * 100)
    : 0;

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="glass rounded-xl p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-warning to-destructive flex items-center justify-center">
            <Flame className="w-5 h-5 text-warning-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Account Warm-Up</h3>
            <p className="text-xs text-muted-foreground">Chaotic human behavior — no patterns</p>
          </div>
        </div>
        {isRunning && (
          <Badge variant="outline" className="border-warning text-warning animate-pulse gap-1.5">
            <Activity className="w-3 h-3" />
            Warming up
          </Badge>
        )}
      </div>

      {/* Session Duration Slider */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm">Session Duration</span>
          </div>
          <span className="font-mono text-sm text-primary font-medium">{sessionMinutes} min</span>
        </div>
        <Slider
          value={[sessionMinutes]}
          onValueChange={([v]) => setSessionMinutes(v)}
          min={5}
          max={180}
          step={5}
          disabled={isRunning}
        />
        <p className="text-xs text-muted-foreground">
          Typical human session: 15–30 min. Longer sessions build stronger warmup signals.
        </p>
      </div>

      {/* Auto-Start DM Toggle */}
      <div className="flex items-center gap-3 rounded-lg bg-primary/5 border border-primary/20 p-3">
        <Checkbox
          id="warmup-auto-dm"
          checked={autoStartDM}
          onCheckedChange={(checked) => setAutoStartDM(!!checked)}
          disabled={isRunning}
        />
        <div className="flex-1">
          <label htmlFor="warmup-auto-dm" className="text-sm font-medium cursor-pointer flex items-center gap-2">
            Auto-start DM session after warm-up
            <Zap className="w-3.5 h-3.5 text-primary" />
          </label>
          <p className="text-[10px] text-muted-foreground">
            Automatically begins your outreach session as soon as warm-up completes. Targeting must be configured.
          </p>
        </div>
      </div>


      <div className="flex items-center gap-3 rounded-lg bg-secondary/30 border border-border p-3">
        <Checkbox
          id="warmup-comments"
          checked={enableComments}
          onCheckedChange={(checked) => setEnableComments(!!checked)}
          disabled={isRunning}
        />
        <div className="flex-1">
          <label htmlFor="warmup-comments" className="text-sm font-medium cursor-pointer">
            Leave comments during warm-up
          </label>
          <p className="text-[10px] text-muted-foreground">
            Posts generic reactions (🔥, 💯, Nice!) to look more active. Disable if you prefer stealth mode.
          </p>
        </div>
      </div>

      {/* Current Action Display */}
      {isRunning && currentAction && (
        <div className="rounded-lg bg-secondary/50 border border-border p-3 flex items-center gap-3">
          <Zap className="w-4 h-4 text-warning animate-pulse" />
          <span className="text-sm font-medium">{currentAction}</span>
        </div>
      )}

      {/* Progress */}
      {(isRunning || stats.elapsedTime > 0) && (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatTime(stats.elapsedTime)}</span>
            <span>{formatTime(stats.sessionTime)}</span>
          </div>
          <Progress value={progressPct} className="h-2" />
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Stories', value: stats.storiesViewed, icon: Eye, color: 'text-success' },
          { label: 'Liked', value: stats.postsLiked, icon: Heart, color: 'text-destructive' },
          { label: 'Feed', value: stats.feedScrolls, icon: ScrollText, color: 'text-primary' },
          { label: 'Explore', value: stats.exploreScrolls, icon: Search, color: 'text-accent' },
          { label: 'Comments', value: stats.commentsRead, icon: MessageCircle, color: 'text-muted-foreground' },
          ...(enableComments ? [{ label: 'Posted', value: stats.commentsPosted ?? 0, icon: MessageCircle, color: 'text-accent' }] : []),
        ].map(s => (
          <div key={s.label} className="rounded-lg bg-secondary/30 border border-border p-3 text-center">
            <s.icon className={cn('w-4 h-4 mx-auto mb-1', s.color)} />
            <div className="text-lg font-bold font-mono">{s.value}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex gap-3">
        {!isRunning ? (
          <Button
            onClick={startWarmup}
            className="flex-1 gap-2 bg-gradient-to-r from-warning to-destructive text-warning-foreground hover:opacity-90"
            size="lg"
          >
            <Play className="w-4 h-4" />
            Start Warm-Up
          </Button>
        ) : (
          <Button
            onClick={stopWarmup}
            variant="destructive"
            className="flex-1 gap-2"
            size="lg"
          >
            <Square className="w-4 h-4" />
            Stop
          </Button>
        )}
      </div>

      {/* Get Followers CTA */}
      <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 space-y-2">
        <p className="text-[11px] text-muted-foreground">
          💡 Make your account look more credible before outreach — real followers, likes & views help your DMs get noticed.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2 border-primary/30 text-primary hover:bg-primary/10"
          onClick={() => window.open('https://ok-bloom.com/', '_blank')}
        >
          <ArrowUp className="w-4 h-4" />
          Get Followers, Likes & Views for My Account
        </Button>
      </div>

      {/* Activity Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Activity ({logs.length})
          </h4>
          <ScrollArea className="h-40 rounded-lg border border-border bg-secondary/20 p-2">
            <div className="space-y-1">
              {logs.map((log, i) => (
                <div
                  key={log.id}
                  className={cn(
                    'flex items-center gap-2 text-xs py-1 px-2 rounded',
                    i === 0 && 'bg-secondary/40'
                  )}
                >
                  <span className={actionColors[log.action]}>
                    {actionIcons[log.action]}
                  </span>
                  <span className="flex-1 truncate">{log.message}</span>
                  <span className="text-muted-foreground text-[10px] font-mono whitespace-nowrap">
                    {log.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
