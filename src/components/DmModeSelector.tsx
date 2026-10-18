import { useState } from 'react';
import { BotConfig, HUMAN_MODE_WARMED, HUMAN_MODE_COLD, DmMode, TIKTOK_COMMENTS_COLD, TIKTOK_COMMENTS_WARMED } from '@/lib/botEngine';
import { Switch } from '@/components/ui/switch';
import { Shield, SlidersHorizontal, Flame, Snowflake, AlertTriangle, MessageCircle, User } from 'lucide-react';
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
import { DailyLimits } from '@/components/DailyLimits';
import { SubscriptionTier } from '@/lib/subscriptionTiers';
import { ScriptBulkManager } from '@/components/ScriptBulkManager';

interface DmModeSelectorProps {
  config: BotConfig;
  onChange: (config: BotConfig) => void;
  disabled?: boolean;
  tier?: SubscriptionTier;
}

export function DmModeSelector({ config, onChange, disabled, tier }: DmModeSelectorProps) {
  const [showWarmupConfirm, setShowWarmupConfirm] = useState(false);
  const [personalize, setPersonalize] = useState(true);

  const isHuman = config.dmMode === 'human';
  const isTikTok = config.platform === 'tiktok';
  const label = isTikTok ? 'Comment' : 'DM';
  const labelPlural = isTikTok ? 'Comments' : 'DMs';

  const setMode = (mode: DmMode) => {
    if (mode === 'human') {
      const preset = config.isWarmedUp ? HUMAN_MODE_WARMED : HUMAN_MODE_COLD;
      onChange({ ...config, dmMode: 'human', ...preset });
    } else {
      onChange({ ...config, dmMode: 'manual' });
    }
  };

  const toggleWarmup = (warmed: boolean) => {
    if (warmed) {
      setShowWarmupConfirm(true);
    } else {
      const preset = isHuman ? HUMAN_MODE_COLD : {};
      onChange({ ...config, isWarmedUp: false, ...preset });
    }
  };

  const confirmWarmup = () => {
    const preset = isHuman ? HUMAN_MODE_WARMED : {};
    onChange({ ...config, isWarmedUp: true, ...preset });
    setShowWarmupConfirm(false);
  };

  const warmupDmText = isTikTok
    ? config.isWarmedUp
      ? `Up to ${TIKTOK_COMMENTS_WARMED} comments / 24hrs`
      : `Up to ${TIKTOK_COMMENTS_COLD} comments / 24hrs`
    : config.isWarmedUp
      ? 'Up to 50 DMs / 24hrs'
      : '15–20 DMs / 24hrs';

  const warmupDialogText = isTikTok
    ? {
        safe: `${TIKTOK_COMMENTS_WARMED} comments per 24 hours`,
        cold: `${TIKTOK_COMMENTS_COLD} comment`,
      }
    : {
        safe: '50 DMs per 24 hours',
        cold: '15–20 DM',
      };

  return (
    <div className="glass rounded-xl p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">{label} Mode</h3>
      </div>

      {/* Platform context banner */}
      {isTikTok ? (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
          <svg className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.93a8.2 8.2 0 0 0 4.76 1.52V7a4.84 4.84 0 0 1-1-.31z"/></svg>
          <div>
            <p className="text-sm font-semibold text-cyan-400">TikTok → Public Comments</p>
            <p className="text-xs text-muted-foreground">
              TikTok doesn't support automated DMs. The bot posts <strong>public comments</strong> on videos in your feed instead. Scripts you add below will appear as comments on posts.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-pink-500/10 border border-pink-500/20">
          <MessageCircle className="w-5 h-5 text-pink-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-pink-400">Instagram → Private DMs</p>
            <p className="text-xs text-muted-foreground">
              The bot sends <strong>private direct messages</strong> to users whose content matches your targeting. Scripts below are sent as DMs.
            </p>
          </div>
        </div>
      )}

      {/* Mode Toggle */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setMode('human')}
          disabled={disabled}
          className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
            isHuman
              ? 'border-success bg-success/10 text-foreground'
              : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/50'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <Shield className="w-5 h-5" />
          <span className="text-sm font-semibold">Human</span>
          <span className="text-xs text-muted-foreground text-center">Safe & automatic</span>
        </button>
        <button
          onClick={() => setMode('manual')}
          disabled={disabled}
          className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
            !isHuman
              ? 'border-warning bg-warning/10 text-foreground'
              : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/50'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <SlidersHorizontal className="w-5 h-5" />
          <span className="text-sm font-semibold">Manual</span>
          <span className="text-xs text-muted-foreground text-center">Full control</span>
        </button>
      </div>

      {/* Warmup Toggle */}
      <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
        <div className="flex items-center gap-2">
          {config.isWarmedUp ? (
            <Flame className="w-4 h-4 text-warning" />
          ) : (
            <Snowflake className="w-4 h-4 text-primary" />
          )}
          <div>
            <span className="text-sm font-medium">Account Warmed Up</span>
            <p className="text-xs text-muted-foreground">{warmupDmText}</p>
          </div>
        </div>
        <Switch
          checked={config.isWarmedUp}
          onCheckedChange={toggleWarmup}
          disabled={disabled}
        />
      </div>

      {/* Human Mode Info */}
      {isHuman && (
        <div className="p-3 rounded-lg bg-success/5 border border-success/20 space-y-1">
          <p className="text-xs text-success font-medium">✦ Human Mode Active</p>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {isTikTok ? (
              <>
                <li>• Scroll, like & comment only</li>
                <li>• {config.isWarmedUp ? TIKTOK_COMMENTS_WARMED : TIKTOK_COMMENTS_COLD} comments spread across session</li>
                <li>• Natural timing & behavior patterns</li>
              </>
            ) : (
              <>
                <li>• No following — scroll, like & DM only</li>
                <li>• {config.isWarmedUp ? '50' : '15–20'} DMs spread across 24hr session</li>
                <li>• Natural timing & behavior patterns</li>
              </>
            )}
          </ul>
        </div>
      )}

      {/* Manual Mode Warning */}
      {!isHuman && (
        <div className="p-3 rounded-lg bg-warning/10 border border-warning/30 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-warning font-medium">Manual Mode</p>
            <p className="text-xs text-muted-foreground">
              You have full control. Default values are set to safe limits. Increasing {labelPlural.toLowerCase()} or follows may risk your account.
            </p>
          </div>
        </div>
      )}

      {/* ── Daily Limits (embedded) ──
          Other limits stay locked in Human mode (safe preset), but the
          Daily Session Goal stays editable so users can target e.g. 20 DMs/day
          spread across multiple sessions. */}
      <DailyLimits config={config} onChange={onChange} disabled={disabled || isHuman} tier={tier} goalAlwaysEnabled />

      {/* ── Script Bulks (per-account) ── */}
      <div className="space-y-3 pt-2 border-t border-border">
        <div>
          <h4 className="text-sm font-semibold">{label} Script Bulks</h4>
          <p className="text-xs text-muted-foreground">
            Create named bulks of 5–10 scripts. Each connected account can have ONE bulk active.
            Toggling a bulk only affects the account currently open in the bot tab — other accounts on the same API key keep their own active bulk.
          </p>
        </div>

        {/* Personalize with {name} Toggle */}
        {!isTikTok && (
          <div className="flex items-center justify-between p-3 rounded-lg bg-primary/5 border border-primary/20">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-primary" />
              <div>
                <span className="text-sm font-medium">Personalize with Name</span>
                <p className="text-xs text-muted-foreground">
                  Messages include {'{name}'} — replaced with the recipient's real name at send time
                </p>
              </div>
            </div>
            <Switch
              checked={personalize}
              onCheckedChange={setPersonalize}
              disabled={disabled}
            />
          </div>
        )}

        <ScriptBulkManager platform={config.platform} disabled={disabled} personalize={personalize} />
      </div>

      {/* Warmup Confirmation Dialog */}
      <AlertDialog open={showWarmupConfirm} onOpenChange={setShowWarmupConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Flame className="w-5 h-5 text-warning" />
              Confirm Account Warmup
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                By enabling this, you confirm that your account has been <strong>actively used for at least 2–4 weeks</strong> with regular manual activity (posting, liking, {isTikTok ? 'commenting' : 'messaging'}).
              </p>
              <p>
                A warmed-up account can safely send up to <strong>{warmupDialogText.safe}</strong>. If your account is new or hasn't been active recently, keep this off to stay at the safer {warmupDialogText.cold} limit.
              </p>
              <p className="text-warning font-medium">
                Enabling this on a cold account may result in restrictions or a ban.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, Keep Cold</AlertDialogCancel>
            <AlertDialogAction
              className="bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={confirmWarmup}
            >
              Yes, My Account Is Warmed Up
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
