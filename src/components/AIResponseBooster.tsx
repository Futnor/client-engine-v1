import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { SubscriptionTier, getTierLimits } from '@/lib/subscriptionTiers';
import { Sparkles, Lock, Infinity as InfinityIcon, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface Props {
  tier: SubscriptionTier;
}

/**
 * Surfaces the post-DM AI commenting feature ("AI Response Booster") in the
 * dashboard. The actual comments are sent automatically by the extension after
 * every DM — this panel just shows the user their plan status and daily usage.
 *
 * Tier behavior:
 *  - free / launch  → locked (upsell)
 *  - growth         → 25 comments/day (per user, across all connected accounts)
 *  - scale / admin  → unlimited
 */
export function AIResponseBooster({ tier }: Props) {
  const limits = getTierLimits(tier);
  const quota = (limits as any).aiResponseBooster as number; // 0 locked | -1 unlimited | 25
  const [used, setUsed] = useState<number | null>(null);

  const isLocked = quota === 0;
  const isUnlimited = quota === -1;

  useEffect(() => {
    if (isLocked || isUnlimited) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const today = new Date().toISOString().slice(0, 10);
        const { data } = await supabase
          .from('ai_post_comment_usage')
          .select('count')
          .eq('user_id', user.id)
          .eq('usage_date', today)
          .maybeSingle();
        if (!cancelled) setUsed(data?.count ?? 0);
      } catch {}
    };
    void load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isLocked, isUnlimited]);

  return (
    <div className="glass rounded-xl p-5 space-y-3 animate-fade-in">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              AI Response Booster
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-success bg-success/10 border border-success/20 rounded px-1.5 py-0.5">
                <TrendingUp className="w-2.5 h-2.5" /> Higher reply rate
              </span>
            </h3>
            <p className="text-xs text-muted-foreground">
              After every DM, the bot leaves a relevant AI comment on the recipient's latest post — they get a notification, check messages, and reply much more often.
            </p>
          </div>
        </div>
      </div>

      {isLocked && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/40 border border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="w-4 h-4" />
            <span>Unlock on <strong className="text-foreground">Growth</strong> (25/day) or <strong className="text-foreground">Scale</strong> (unlimited).</span>
          </div>
          <Button asChild size="sm" variant="default" className="shrink-0">
            <Link to="/pricing">Upgrade</Link>
          </Button>
        </div>
      )}

      {isUnlimited && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20 text-xs text-success">
          <InfinityIcon className="w-4 h-4" />
          <span><strong>Unlimited</strong> AI post comments — running automatically after every DM.</span>
        </div>
      )}

      {!isLocked && !isUnlimited && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Today's usage <span className="text-[10px]">(per account, shared across all your connected accounts)</span>
            </span>
            <span className="font-mono font-semibold text-foreground">
              {used ?? '…'} / {quota}
            </span>
          </div>
          <Progress value={used != null ? Math.min(100, (used / quota) * 100) : 0} className="h-1.5" />
          {used != null && used >= quota && (
            <p className="text-[11px] text-warning">
              Daily cap reached. Upgrade to <Link to="/pricing" className="underline font-medium">Scale</Link> for unlimited.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
