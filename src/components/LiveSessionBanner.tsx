import { useEffect, useState } from 'react';
import { BotStats, LogEntry } from '@/lib/botEngine';
import { Button } from '@/components/ui/button';
import {
  Activity,
  Heart,
  UserPlus,
  MessageCircle,
  Eye,
  AlertTriangle,
  Radio,
  Pause,
  Play,
  Square,
} from 'lucide-react';

interface LiveSessionBannerProps {
  isRunning: boolean;
  isPaused: boolean;
  stats: BotStats;
  logs: LogEntry[];
  platform: string;
  limitWarning: string | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onContinuePastLimit: () => void;
}

export function LiveSessionBanner({ isRunning, isPaused, stats, logs, platform, limitWarning, onPause, onResume, onStop, onContinuePastLimit }: LiveSessionBannerProps) {
  const [dots, setDots] = useState('');
  const latestLog = logs[0];
  const isReconnectWarning = limitWarning === 'Reconnecting to extension...';

  useEffect(() => {
    if (!isRunning || isPaused) return;
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);
    return () => clearInterval(interval);
  }, [isRunning, isPaused]);

  useEffect(() => {
    if (!isRunning) {
      document.title = 'Client Engine';
      return;
    }

    const interval = setInterval(() => {
      const platformLabel = platform === 'tiktok' ? 'TikTok' : 'Instagram';
      const prefix = isReconnectWarning ? '🔄 Reconnecting' : isPaused ? '⏸ Paused' : '🤖 Bot Active';
      document.title = `${prefix} — ${stats.dmsSent} DMs · ${stats.likesSent} Likes | ${platformLabel}`;
    }, 1000);

    return () => {
      clearInterval(interval);
      document.title = 'Client Engine';
    };
  }, [isRunning, isPaused, isReconnectWarning, stats.dmsSent, stats.likesSent, platform]);

  if (!isRunning) return null;

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const progress = stats.sessionTime > 0 ? (stats.elapsedTime / stats.sessionTime) * 100 : 0;

  return (
    <div
      className={`rounded-xl border-2 p-4 space-y-4 animate-fade-in ${
        isReconnectWarning
          ? 'border-warning/40 bg-warning/5'
          : isPaused
            ? 'border-warning/40 bg-warning/5'
            : 'border-success/40 bg-success/5'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${
              isReconnectWarning
                ? 'bg-warning/20 text-warning'
                : isPaused
                  ? 'bg-warning/20 text-warning'
                  : 'bg-success/20 text-success'
            }`}
          >
            <Radio className={`w-3 h-3 ${isReconnectWarning || isPaused ? '' : 'animate-pulse'}`} />
            {isReconnectWarning ? 'Reconnecting' : isPaused ? 'Paused' : 'Live Session'}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatTime(stats.elapsedTime)} / {formatTime(stats.sessionTime)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {isReconnectWarning ? null : isPaused ? (
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-success/30 text-success hover:bg-success/10" onClick={onResume}>
              <Play className="w-3 h-3" /> Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-warning/30 text-warning hover:bg-warning/10" onClick={onPause}>
              <Pause className="w-3 h-3" /> Pause
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-destructive/30 text-destructive hover:bg-destructive/10" onClick={onStop}>
            <Square className="w-3 h-3" /> Stop
          </Button>
        </div>
      </div>

      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${
            isReconnectWarning || isPaused
              ? 'bg-gradient-to-r from-warning to-warning'
              : 'bg-gradient-to-r from-success to-success'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="grid grid-cols-4 gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          <Eye className="w-3.5 h-3.5 text-blue-400" />
          <span className="font-semibold">{stats.scrolls}</span>
          <span className="text-muted-foreground hidden sm:inline">scrolls</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <Heart className="w-3.5 h-3.5 text-pink-400" />
          <span className="font-semibold">{stats.likesSent}</span>
          <span className="text-muted-foreground hidden sm:inline">likes</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <UserPlus className="w-3.5 h-3.5 text-purple-400" />
          <span className="font-semibold">{stats.followsSent}</span>
          <span className="text-muted-foreground hidden sm:inline">follows</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <MessageCircle className="w-3.5 h-3.5 text-cyan-400" />
          <span className="font-semibold">{stats.dmsSent}</span>
          <span className="text-muted-foreground hidden sm:inline">DMs</span>
        </div>
      </div>

      {limitWarning && (
        <div className="rounded-lg border-2 border-warning/40 bg-warning/10 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {limitWarning}
          </div>
          <div className="flex gap-2">
            {!isReconnectWarning && (
              <Button size="sm" className="h-7 text-xs gap-1 bg-success text-success-foreground hover:bg-success/90" onClick={onContinuePastLimit}>
                <MessageCircle className="w-3 h-3" /> Continue DMs
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 border-destructive/30 text-destructive hover:bg-destructive/10" onClick={onStop}>
              <Square className="w-3 h-3" /> Stop Session
            </Button>
          </div>
        </div>
      )}

      {latestLog && !limitWarning && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
          <Activity className={`w-3.5 h-3.5 shrink-0 ${isPaused ? 'text-warning' : 'text-success animate-pulse'}`} />
          <span className="truncate">{isPaused ? 'Session paused — click Resume to continue' : `${latestLog.message}${dots}`}</span>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-warning">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>⚠️ Keep the {platform === 'tiktok' ? 'TikTok' : 'Instagram'} tab open — the bot runs there. Do NOT close or navigate away from it.</span>
      </div>
    </div>
  );
}
