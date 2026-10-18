import { useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { BotConfig, TIKTOK_COMMENTS_COLD, TIKTOK_COMMENTS_WARMED } from '@/lib/botEngine';
import { SubscriptionTier } from '@/lib/subscriptionTiers';
import { Shield, Heart, UserPlus, MessageCircle, AlertTriangle, Target, Timer, Hourglass } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface DailyLimitsProps {
  config: BotConfig;
  onChange: (config: BotConfig) => void;
  disabled?: boolean;
  tier?: SubscriptionTier;
  /** When true, the Daily Session Goal slider stays enabled even if `disabled` is true.
   *  Used so users can set a daily target in Human mode (where other limits
   *  are locked to the safe preset). */
  goalAlwaysEnabled?: boolean;
}

const TIKTOK_DM_MAX = 15;

export function DailyLimits({ config, onChange, disabled, tier, goalAlwaysEnabled }: DailyLimitsProps) {
  const [pendingDmValue, setPendingDmValue] = useState<number | null>(null);
  const isHuman = config.dmMode === 'human';
  const isManual = config.dmMode === 'manual';
  const isUnlimited = tier === 'scale' || tier === 'admin';

  const updateLimit = (key: 'dailyMaxDMs' | 'dailyMaxLikes' | 'dailyMaxFollows', value: number) => {
    onChange({ ...config, [key]: value });
  };

  const isTikTok = config.platform === 'tiktok';
  const tiktokCommentMax = config.isWarmedUp ? TIKTOK_COMMENTS_WARMED : TIKTOK_COMMENTS_COLD;
  const humanSafeMax = config.isWarmedUp ? 50 : 20;
  const dmSliderMax = isUnlimited
    ? 999
    : isTikTok
      ? tiktokCommentMax
      : isManual ? 100 : humanSafeMax;
  const likesSliderMax = isUnlimited ? 999 : 200;
  const followsSliderMax = isUnlimited ? 999 : 50;

  const handleDmChange = (value: number) => {
    if (isUnlimited) { updateLimit('dailyMaxDMs', value); return; }
    if (isTikTok) {
      updateLimit('dailyMaxDMs', Math.min(value, tiktokCommentMax));
      return;
    }
    const safeMax = config.isWarmedUp ? 50 : 20;
    if (isManual && value > safeMax) {
      setPendingDmValue(value);
    } else {
      updateLimit('dailyMaxDMs', value);
    }
  };

  const handleFollowChange = (value: number) => {
    if (isUnlimited) { updateLimit('dailyMaxFollows', value); return; }
    if (isHuman) return;
    updateLimit('dailyMaxFollows', value);
  };

  return (
    <>
      <div className="glass rounded-xl p-6 space-y-6 animate-fade-in">
        <div className="flex items-center gap-3">
          <Shield className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">Daily Limits</h3>
          {isHuman && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-success/20 text-success font-medium">
              Human
            </span>
          )}
        </div>

        {/* Likes */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Heart className="w-4 h-4 text-success" />
              <span className="text-sm">Max Likes</span>
            </div>
            <span className="font-mono text-success font-medium">{config.dailyMaxLikes}</span>
          </div>
          <Slider
            value={[config.dailyMaxLikes]}
            onValueChange={([v]) => updateLimit('dailyMaxLikes', v)}
            min={1}
            max={likesSliderMax}
            step={1}
            disabled={disabled}
          />
        </div>

        {/* Follows */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-warning" />
              <span className="text-sm">Enable Following</span>
              {isHuman && (
                <span className="text-xs text-muted-foreground">(disabled in Human mode)</span>
              )}
            </div>
            <Switch
              id="follow-enabled"
              checked={!!config.followEnabled}
              onCheckedChange={(checked) => onChange({ ...config, followEnabled: checked })}
              disabled={disabled || (!isUnlimited && isHuman)}
            />
          </div>
          {config.followEnabled && (
            <>
              <div className="flex items-center justify-between">
                <Label htmlFor="follow-enabled" className="text-sm text-muted-foreground pl-6">Max Follows</Label>
                <span className="font-mono text-warning font-medium">{config.dailyMaxFollows}</span>
              </div>
              <Slider
                value={[config.dailyMaxFollows]}
                onValueChange={([v]) => handleFollowChange(v)}
                min={0}
                max={followsSliderMax}
                step={5}
                disabled={disabled || (!isUnlimited && isHuman)}
              />
            </>
          )}
        </div>

        {/* DMs — slider supports 1 to 50 (and beyond on unlimited tiers) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-accent" />
              <span className="text-sm">{isTikTok ? 'Max Comments' : 'Max DMs'}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={dmSliderMax}
              value={config.dailyMaxDMs}
              onChange={(e) => {
                const v = Math.max(1, Math.min(dmSliderMax, parseInt(e.target.value || '1', 10)));
                if (!Number.isNaN(v)) handleDmChange(v);
              }}
              className="w-20 h-8 text-right font-mono text-accent"
              disabled={disabled && !goalAlwaysEnabled}
            />
          </div>
          <Slider
            value={[config.dailyMaxDMs]}
            onValueChange={([v]) => handleDmChange(v)}
            min={1}
            max={dmSliderMax}
            step={1}
            disabled={disabled && !goalAlwaysEnabled}
          />
          <p className="text-xs text-muted-foreground">
            Set anywhere from 1 to {dmSliderMax} {isTikTok ? 'comments' : 'DMs'}/day. Lower is safer, especially on cold accounts.
          </p>
          {!isTikTok && config.dailyMaxDMs > (config.isWarmedUp ? 50 : 20) && (
            <div className="flex items-center gap-1.5 text-xs text-warning">
              <AlertTriangle className="w-3 h-3" />
              <span>Above safe limit — risk of account restriction</span>
            </div>
          )}
          {isTikTok && (
            <p className="text-xs text-muted-foreground">
              {config.isWarmedUp ? 'Warmed up: up to 200 comments/day' : 'Cold account: up to 100 comments/day'}
            </p>
          )}
        </div>

        {/* Daily Session Goal — accumulates across every session run today.
            DMs from earlier sessions today count toward the goal, so the user
            can split a 20-DM target across several short sessions instead of
            forcing it all into one. The whole counter resets at the user's
            LOCAL midnight (uses the device's timezone). */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              <span className="text-sm">{isTikTok ? 'Daily Session Comment Goal' : 'Daily Session DM Goal'}</span>
            </div>
            <Input
              type="number"
              min={0}
              max={dmSliderMax}
              value={config.sessionDmGoal}
              onChange={(e) => {
                const v = Math.max(0, Math.min(dmSliderMax, parseInt(e.target.value || '0', 10)));
                if (!Number.isNaN(v)) onChange({ ...config, sessionDmGoal: v });
              }}
              className="w-20 h-8 text-right font-mono text-primary"
              disabled={disabled && !goalAlwaysEnabled}
            />
          </div>
          <Slider
            value={[config.sessionDmGoal]}
            onValueChange={([v]) => onChange({ ...config, sessionDmGoal: v })}
            min={0}
            max={dmSliderMax}
            step={1}
            disabled={disabled && !goalAlwaysEnabled}
          />
          <p className="text-xs text-muted-foreground">
            {config.sessionDmGoal === 0
              ? `Off — session runs until time limit or manual stop. Drag to set 1–${dmSliderMax}.`
              : `Counts ${isTikTok ? 'comments' : 'DMs'} from every session today. Auto-stops once ${config.sessionDmGoal} total is reached. Resets at your local midnight.`}
          </p>
        </div>

        {/* ── DM Pacing (between-DM cooldown + burst pause) ── */}
        {!isTikTok && (
          <div className="pt-4 border-t border-border space-y-5">
            <div className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-semibold">DM Pacing</h4>
            </div>

            {/* Between-DM cooldown (in minutes) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Timer className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm">Pause between each DM</span>
                </div>
                <span className="font-mono text-primary font-medium">
                  {(() => {
                    const sec = config.dmCooldownSec ?? 0;
                    if (sec === 0) return 'Off';
                    if (sec < 60) return `${sec}s`;
                    const m = sec / 60;
                    return `${m % 1 === 0 ? m : m.toFixed(1)} min`;
                  })()}
                </span>
              </div>
              <Slider
                value={[Math.round((config.dmCooldownSec ?? 0) / 30)]}
                onValueChange={([v]) => onChange({ ...config, dmCooldownSec: v * 30 })}
                min={0}
                max={40}
                step={1}
                disabled={disabled}
              />
              <p className="text-[11px] text-muted-foreground">
                Off (0) up to 20 minutes between sends. Most ban-safe outreach uses ≥1 min between DMs.
              </p>
            </div>

            {/* Burst pause: every N DMs, pause M minutes */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Hourglass className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm">Burst pause</span>
                </div>
                <span className="font-mono text-primary font-medium text-xs">
                  {(() => {
                    const size = config.dmBurstSize ?? 0;
                    const pauseSec = config.dmBurstPauseSec ?? 0;
                    if (size === 0 || pauseSec === 0) return 'Off';
                    const min = Math.round(pauseSec / 60);
                    return `every ${size} → ${min}m`;
                  })()}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Every N DMs</span>
                    <span className="font-mono">{config.dmBurstSize ?? 0}</span>
                  </div>
                  <Slider
                    value={[config.dmBurstSize ?? 0]}
                    onValueChange={([v]) => onChange({ ...config, dmBurstSize: v })}
                    min={0}
                    max={20}
                    step={1}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Pause (min)</span>
                    <span className="font-mono">
                      {Math.round((config.dmBurstPauseSec ?? 0) / 60)}
                    </span>
                  </div>
                  <Slider
                    value={[Math.round((config.dmBurstPauseSec ?? 0) / 60)]}
                    onValueChange={([v]) => onChange({ ...config, dmBurstPauseSec: v * 60 })}
                    min={0}
                    max={60}
                    step={1}
                    disabled={disabled}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                After every N DMs, pause M minutes before the next batch. Set either to 0 to disable.
                Defaults to 5 DMs → 10 min pause — mimics a human who DMs in bursts.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* DM Warning Dialog */}
      <AlertDialog open={pendingDmValue !== null} onOpenChange={(open) => !open && setPendingDmValue(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" />
              High DM Limit Warning
            </AlertDialogTitle>
            <AlertDialogDescription>
              You're setting DMs to <strong>{pendingDmValue}</strong>, which exceeds the safe limit of{' '}
              <strong>{config.isWarmedUp ? 50 : 20}</strong> for a{' '}
              {config.isWarmedUp ? 'warmed up' : 'cold'} account. This may trigger Instagram's spam detection and risk your account being restricted or banned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDmValue(null)}>
              Keep Safe Limit
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => {
                if (pendingDmValue !== null) {
                  updateLimit('dailyMaxDMs', pendingDmValue);
                  setPendingDmValue(null);
                }
              }}
            >
              I Understand, Set Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}