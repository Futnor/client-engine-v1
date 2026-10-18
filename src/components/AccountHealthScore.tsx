import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { BotStats } from '@/lib/botEngine';
import { cn } from '@/lib/utils';
import { ShieldCheck, AlertTriangle, ShieldAlert, TrendingUp, TrendingDown, Minus, User, Flame, Timer, Sparkles, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface AccountHealthScoreProps {
  stats: BotStats;
  hasWarmedUp: boolean;
  dmMode: string;
  isRunning: boolean;
  onGoToWarmup?: () => void;
  onGoToDelays?: () => void;
  canWarmUp?: boolean;
  onUpgrade?: () => void;
  /** Per-session DM/comment goal (0 = off). When > 0, a progress bar is shown
   *  using `dmsToday + live stats.dmsSent` so the user can track goal completion. */
  sessionDmGoal?: number;
  goalLabel?: string;
}

interface HealthSignals {
  recentSessions: number;
  avgSessionDuration: number;
  avgDmsPerSession: number;
  totalDmsLast7Days: number;
  totalActionsLast7Days: number;
  totalDmsLast30Days: number;
  warmupSessionsLast7Days: number;
  dmToActionRatio: number;
  sessionsToday: number;
  sessionsLast24h: number;
  longestSessionToday: number;
  dmsToday: number;
  dmsLastHour: number;
  // Block / challenge events surfaced by the extension.
  // Populated from localStorage 'futnor_last_block' (mirror of chrome.storage).
  lastBlockReason: string | null;
  lastBlockAtMs: number | null;
  // User-configured limits (the request itself is a risk signal — a user who
  // sets dailyMaxDMs to 100 is asking to be banned, regardless of actual count).
  configDailyMaxDMs: number | null;
  configHourlyMaxDMs: number | null;
  configMinActionDelay: number | null;
}

const defaultSignals: HealthSignals = {
  recentSessions: 0,
  avgSessionDuration: 0,
  avgDmsPerSession: 0,
  totalDmsLast7Days: 0,
  totalActionsLast7Days: 0,
  totalDmsLast30Days: 0,
  warmupSessionsLast7Days: 0,
  dmToActionRatio: 0,
  sessionsToday: 0,
  sessionsLast24h: 0,
  longestSessionToday: 0,
  dmsToday: 0,
  dmsLastHour: 0,
  lastBlockReason: null,
  lastBlockAtMs: null,
  configDailyMaxDMs: null,
  configHourlyMaxDMs: null,
  configMinActionDelay: null,
};

// Scoring model — recalibrated v2.4.90 in response to a real-world account
// suspension that occurred while this score read 85% ("Healthy").
//
// The previous thresholds were calibrated as if the bot's job was "stay under
// IG's hard ceilings" — but cold DM outreach to non-followers is a Terms of Use
// violation regardless of volume, and Instagram's actual ban triggers are:
//   1. Recipient reports (we can't see this directly)
//   2. Block/challenge dialogs the user keeps actioning past
//   3. Accumulated cold-DM volume (lifetime + rolling)
//   4. Bursty hourly sends (not just daily totals)
//   5. Aggressive user configuration (asking for 100 DMs/day = asking for ban)
//
// New rules:
//  - Any block/challenge in last 7 days → instant At-Risk (≤30) regardless of other factors.
//  - Lower DM thresholds across the board, matching unofficial soft caps.
//  - 30-day cumulative DM signal added.
//  - Hourly DM signal added (catches burst patterns the daily check misses).
//  - Aggressive `dailyMaxDMs` configuration penalised even without sending yet.
//  - Color bands shifted: 80+ Healthy is now harder to reach.
function calculateHealthScore(
  signals: HealthSignals,
  currentStats: BotStats,
  hasWarmedUp: boolean,
  dmMode: string,
): {
  score: number;
  factors: { label: string; impact: 'positive' | 'negative' | 'neutral'; detail: string; action?: 'warmup' | 'delays' }[];
} {
  let score = 100;
  const factors: {
    label: string;
    impact: 'positive' | 'negative' | 'neutral';
    detail: string;
    action?: 'warmup' | 'delays';
  }[] = [];
  const isWarmed = hasWarmedUp || signals.warmupSessionsLast7Days > 0;

  // ── 0. RECENT IG BLOCK / CHALLENGE — overrides everything else ────────────
  // If Instagram showed an Action Blocked / Try Again Later / checkpoint /
  // suspicious-activity dialog within the last 7 days, the account is in real
  // trouble. The bot stopped on detection (v2.4.90) but the IG-side flag is
  // still there. Show it loudly.
  if (signals.lastBlockAtMs !== null) {
    const ageMs = Date.now() - signals.lastBlockAtMs;
    const oneDay = 24 * 60 * 60 * 1000;
    const reasonLabel = (signals.lastBlockReason || 'block').replace(/_/g, ' ');
    if (ageMs < 24 * oneDay) {
      // Past 24h — this is the most predictive single signal we have.
      score -= 60;
      factors.push({
        label: 'Recent IG block',
        impact: 'negative',
        detail: `Instagram flagged this account ${Math.max(1, Math.round(ageMs / 3600000))}h ago (${reasonLabel}) — do not run sessions for 24h+ and resolve any in-app verification`,
        action: 'delays',
      });
    } else if (ageMs < 7 * oneDay) {
      score -= 35;
      factors.push({
        label: 'Block within 7d',
        impact: 'negative',
        detail: `IG flag from ${Math.round(ageMs / oneDay)}d ago (${reasonLabel}) — keep volumes low and avoid back-to-back sessions`,
      });
    } else if (ageMs < 30 * oneDay) {
      score -= 15;
      factors.push({
        label: 'Block in last 30d',
        impact: 'negative',
        detail: `IG flag from ${Math.round(ageMs / oneDay)}d ago (${reasonLabel}) — this account is on the list, treat as fragile`,
      });
    }
  }

  // ── 1. Warm-up ────────────────────────────────────────────────────────────
  if (isWarmed) {
    factors.push({
      label: 'Warm-up active',
      impact: 'positive',
      detail: `${signals.warmupSessionsLast7Days || 1} warm-up session(s) in last 7 days`,
    });
  } else {
    score -= 30;
    factors.push({
      label: 'No warm-up',
      impact: 'negative',
      detail: 'Cold accounts trigger spam filters fast — warm up before DMing',
      action: 'warmup',
    });
  }

  // ── 2. Daily DM volume (REALISTIC bands) ──────────────────────────────────
  // Unofficial soft cap for established accounts is ~50/day, often less for cold
  // outreach. Cold/un-warmed: halved. Previous bands (>50 elevated, >150 critical)
  // were calibrated as if the bot's volume itself wasn't the problem — it is.
  const liveDmsToday = signals.dmsToday + (currentStats.dmsSent || 0);
  const dayCritical = isWarmed ? 50 : 25;
  const dayHigh     = isWarmed ? 30 : 15;
  const dayElev     = isWarmed ? 15 : 8;
  if (liveDmsToday > dayCritical) {
    score -= 40;
    factors.push({
      label: 'Daily DMs critical',
      impact: 'negative',
      detail: `${liveDmsToday} DMs today — stop, this is in the action-block zone for cold outreach`,
      action: 'delays',
    });
  } else if (liveDmsToday > dayHigh) {
    score -= 22;
    factors.push({
      label: 'Daily DMs high',
      impact: 'negative',
      detail: `${liveDmsToday} DMs today — back off, you're in the danger zone for cold outreach`,
      action: 'delays',
    });
  } else if (liveDmsToday > dayElev) {
    score -= 10;
    factors.push({
      label: 'Daily DMs elevated',
      impact: 'negative',
      detail: `${liveDmsToday} DMs today — monitor closely, especially without warmup`,
    });
  } else if (liveDmsToday > 0) {
    factors.push({
      label: 'Daily DMs safe',
      impact: 'positive',
      detail: `${liveDmsToday} DMs today — within conservative range`,
    });
  }

  // ── 3. Hourly DM burst (NEW) ──────────────────────────────────────────────
  // Even within a daily budget, sending 8 DMs in an hour is a strong bot signal.
  // The bot's own hourlyMaxDMs default is 6.
  if (signals.dmsLastHour > 10) {
    score -= 20;
    factors.push({
      label: 'Hourly burst critical',
      impact: 'negative',
      detail: `${signals.dmsLastHour} DMs in the last hour — bursty pacing is a textbook bot signal`,
      action: 'delays',
    });
  } else if (signals.dmsLastHour > 6) {
    score -= 10;
    factors.push({
      label: 'Hourly burst high',
      impact: 'negative',
      detail: `${signals.dmsLastHour} DMs in the last hour — slow the cadence`,
      action: 'delays',
    });
  }

  // ── 4. Weekly DMs (TIGHTENED) ─────────────────────────────────────────────
  if (signals.totalDmsLast7Days > 250) {
    score -= 25;
    factors.push({
      label: 'Weekly DMs critical',
      impact: 'negative',
      detail: `${signals.totalDmsLast7Days} DMs this week — restriction is imminent at this rate`,
    });
  } else if (signals.totalDmsLast7Days > 120) {
    score -= 12;
    factors.push({
      label: 'Weekly DMs high',
      impact: 'negative',
      detail: `${signals.totalDmsLast7Days} DMs this week — reduce daily volume`,
    });
  } else if (signals.totalDmsLast7Days > 50) {
    score -= 6;
    factors.push({
      label: 'Weekly DMs elevated',
      impact: 'negative',
      detail: `${signals.totalDmsLast7Days} DMs this week`,
    });
  }

  // ── 5. 30-day cumulative DMs (NEW) ────────────────────────────────────────
  // Catches trickle-spammers who pace under daily/weekly limits but accumulate.
  if (signals.totalDmsLast30Days > 800) {
    score -= 15;
    factors.push({
      label: '30d DMs critical',
      impact: 'negative',
      detail: `${signals.totalDmsLast30Days} DMs in 30d — sustained cold outreach pattern, very high ban risk`,
    });
  } else if (signals.totalDmsLast30Days > 400) {
    score -= 8;
    factors.push({
      label: '30d DMs high',
      impact: 'negative',
      detail: `${signals.totalDmsLast30Days} DMs in 30d — accumulated volume is reaching ban-trigger range`,
    });
  }

  // ── 6. Session frequency (TIGHTENED) ──────────────────────────────────────
  if (signals.sessionsToday > 4) {
    score -= 18;
    factors.push({
      label: 'Too many sessions',
      impact: 'negative',
      detail: `${signals.sessionsToday} sessions today — real users don't run 5+ bot sessions/day`,
    });
  } else if (signals.sessionsToday > 2) {
    score -= 8;
    factors.push({
      label: 'Session count high',
      impact: 'negative',
      detail: `${signals.sessionsToday} sessions today — keep it to 1–2 spaced 90+ min apart`,
    });
  }
  // Back-to-back sessions in 24h
  if (signals.sessionsLast24h > 6) {
    score -= 10;
    factors.push({
      label: '24h session count',
      impact: 'negative',
      detail: `${signals.sessionsLast24h} sessions in last 24h — looks automated`,
    });
  }

  // ── 7. Longest session today ─────────────────────────────────────────────
  if (signals.longestSessionToday > 2700) {
    score -= 18;
    factors.push({
      label: 'Session too long',
      impact: 'negative',
      detail: `${Math.round(signals.longestSessionToday / 60)}min continuous — IG flags runs >45min`,
    });
  } else if (signals.longestSessionToday > 1500) {
    score -= 8;
    factors.push({
      label: 'Long session',
      impact: 'negative',
      detail: `${Math.round(signals.longestSessionToday / 60)}min continuous — keep under 25min`,
    });
  }

  // ── 8. DM-to-action ratio (TIGHTENED) ─────────────────────────────────────
  // Real users send <2% DMs of total feed activity. >25% means the account
  // exists primarily to message strangers — Instagram knows that pattern.
  const currentTotal =
    currentStats.dmsSent + currentStats.likesSent + currentStats.followsSent + currentStats.scrolls;
  const currentDmRatio = currentTotal > 10 ? currentStats.dmsSent / currentTotal : signals.dmToActionRatio;

  if (currentDmRatio > 0.40) {
    score -= 22;
    factors.push({
      label: 'DM ratio critical',
      impact: 'negative',
      detail: `${Math.round(currentDmRatio * 100)}% of actions are DMs — drop DM weight, raise scroll`,
    });
  } else if (currentDmRatio > 0.25) {
    score -= 12;
    factors.push({
      label: 'DM ratio high',
      impact: 'negative',
      detail: `${Math.round(currentDmRatio * 100)}% DMs — humans send <5% of their actions as DMs`,
    });
  } else if (currentDmRatio > 0.15) {
    score -= 6;
    factors.push({
      label: 'DM ratio elevated',
      impact: 'negative',
      detail: `${Math.round(currentDmRatio * 100)}% DMs`,
    });
  } else if (currentDmRatio > 0) {
    factors.push({
      label: 'DM ratio safe',
      impact: 'positive',
      detail: `${Math.round(currentDmRatio * 100)}% DMs — mixed with organic activity`,
    });
  }

  // ── 9. Actions-per-minute in live session ─────────────────────────────────
  if (currentStats.sessionTime > 60 && currentStats.elapsedTime > 0) {
    const totalActions =
      currentStats.dmsSent + currentStats.likesSent + currentStats.followsSent + currentStats.scrolls;
    const elapsedMin = Math.max(currentStats.elapsedTime, 60) / 60;
    const actionsPerMin = totalActions / elapsedMin;
    if (actionsPerMin > 15) {
      score -= 15;
      factors.push({
        label: 'Pace critical',
        impact: 'negative',
        detail: `${actionsPerMin.toFixed(1)} actions/min — slow down, this looks automated`,
        action: 'delays',
      });
    } else if (actionsPerMin > 10) {
      score -= 6;
      factors.push({
        label: 'Pace elevated',
        impact: 'negative',
        detail: `${actionsPerMin.toFixed(1)} actions/min — consider longer delays`,
        action: 'delays',
      });
    } else if (actionsPerMin > 0) {
      factors.push({
        label: 'Natural pace',
        impact: 'positive',
        detail: `${actionsPerMin.toFixed(1)} actions/min — within safe range`,
      });
    }
  }

  // ── 10. DM mode ───────────────────────────────────────────────────────────
  if (dmMode === 'human') {
    factors.push({
      label: 'Human mode',
      impact: 'positive',
      detail: 'Randomized delays and natural flow',
    });
  } else {
    score -= 5;
    factors.push({
      label: 'Manual mode',
      impact: 'neutral',
      detail: 'Human mode is safer — consider switching',
    });
  }

  // ── 11. Aggressive configured limits (NEW) ────────────────────────────────
  // The user's chosen `dailyMaxDMs` is itself a risk signal — they're telling
  // the bot what ceiling they want it to walk up to.
  if (typeof signals.configDailyMaxDMs === 'number') {
    if (signals.configDailyMaxDMs >= 100) {
      score -= 18;
      factors.push({
        label: 'Aggressive daily cap',
        impact: 'negative',
        detail: `Configured ${signals.configDailyMaxDMs} DMs/day — this ceiling itself triggers bans regardless of warm-up`,
        action: 'delays',
      });
    } else if (signals.configDailyMaxDMs >= 50) {
      score -= 8;
      factors.push({
        label: 'High daily cap',
        impact: 'negative',
        detail: `Configured ${signals.configDailyMaxDMs} DMs/day — recommended is ≤30 for cold outreach`,
        action: 'delays',
      });
    }
  }
  if (typeof signals.configMinActionDelay === 'number' && signals.configMinActionDelay > 0 && signals.configMinActionDelay < 20) {
    score -= 6;
    factors.push({
      label: 'Delay too short',
      impact: 'negative',
      detail: `Min action delay ${signals.configMinActionDelay}s — humans don't act every 5–10s for an hour straight`,
      action: 'delays',
    });
  }

  // ── 12. Cold account sending DMs ──────────────────────────────────────────
  if (!isWarmed && signals.recentSessions === 0 && liveDmsToday > 0) {
    score -= 20;
    factors.push({
      label: 'Cold account',
      impact: 'negative',
      detail: 'First-ever DMs from a brand new bot session — highest ban risk',
      action: 'warmup',
    });
  }

  return { score: Math.max(0, Math.min(100, score)), factors };
}

export function AccountHealthScore({ stats, hasWarmedUp, dmMode, isRunning, onGoToWarmup, onGoToDelays, canWarmUp = true, onUpgrade, sessionDmGoal = 0, goalLabel = 'DMs' }: AccountHealthScoreProps) {
  const [signals, setSignals] = useState<HealthSignals>(defaultSignals);
  const [loadingSignals, setLoadingSignals] = useState(true);
  const [activeAccount, setActiveAccount] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem('futnor_active_account') || '';
      const normalized = raw.toLowerCase().replace(/^@/, '').trim();
      return normalized || null;
    } catch {
      return null;
    }
  });

  // Detect account switches: storage event for cross-tab changes (instant) +
  // 5-second fallback poll for same-tab writes (e.g. from the extension content script).
  useEffect(() => {
    const readAccount = () => {
      try {
        const raw = localStorage.getItem('futnor_active_account') || '';
        const normalized = raw.toLowerCase().replace(/^@/, '').trim() || null;
        setActiveAccount((current) => (current === normalized ? current : normalized));
      } catch {}
    };

    // Read once immediately on mount
    readAccount();

    // Instant update for cross-tab changes
    window.addEventListener('storage', readAccount);

    // 5s safety-net poll catches same-tab changes (e.g. extension bridge writes)
    const poll = setInterval(readAccount, 5000);

    return () => {
      window.removeEventListener('storage', readAccount);
      clearInterval(poll);
    };
  }, []);

  // Single unified effect for all signals — merges Supabase data + localStorage warmup
  // to prevent two separate effects fighting over the same state and showing stale scores.
  useEffect(() => {
    let cancelled = false;

    const fetchSignals = async () => {
      if (!activeAccount) {
        if (!cancelled) { setSignals(defaultSignals); setLoadingSignals(false); }
        return;
      }

      // Warm-up sessions in the last 7 days, from the extension's timestamped
      // ledger (`futnor_warmup_sessions`, mirrored by the dashboard bridge).
      //
      // This used to read `futnor_warmup_count_7d_<account>` — a plain counter
      // that, despite the name, had no 7-day window at all: nothing ever
      // decremented or expired it, and two separate code paths incremented it
      // for the same session. An account warmed up once in March still reported
      // "2 warm-up sessions in the last 7 days" in September, which flipped the
      // health model onto its warmed-account DM thresholds (50/day instead of
      // 25/day) and silently suppressed the "No warm-up" −30 penalty. The
      // counter is still read as a fallback for installs that have not run a
      // warm-up since upgrading, but it can no longer invent a warm history.
      let warmupCount = 0;
      try {
        const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const ledgerRaw = localStorage.getItem('futnor_warmup_sessions');
        if (ledgerRaw) {
          const ledger = JSON.parse(ledgerRaw);
          if (Array.isArray(ledger)) {
            warmupCount = ledger.filter((entry: any) =>
              entry
              && typeof entry.at === 'number'
              && entry.at >= sevenDaysAgoMs
              && (!entry.account || entry.account === 'unknown' || entry.account === activeAccount)
            ).length;
          }
        } else {
          const legacyKey = `futnor_warmup_count_7d_${activeAccount}`;
          warmupCount = parseInt(localStorage.getItem(legacyKey) || '0', 10) || 0;
        }
      } catch {}

      // Read block / DM-timestamp signals mirrored by the dashboard bridge
      // from chrome.storage.local. These reflect REAL ban-risk signals the
      // extension observed (Action Blocked dialogs, recent DM bursts).
      let lastBlockReason: string | null = null;
      let lastBlockAtMs: number | null = null;
      let dmsLastHour = 0;
      try {
        const blockRaw = localStorage.getItem('futnor_last_block');
        if (blockRaw) {
          const parsed = JSON.parse(blockRaw);
          if (parsed && typeof parsed.at === 'number') {
            lastBlockAtMs = parsed.at;
            lastBlockReason = parsed.reason || 'unknown';
          }
        }
      } catch {}
      try {
        const tsRaw = localStorage.getItem('futnor_dm_timestamps');
        if (tsRaw) {
          const arr = JSON.parse(tsRaw);
          if (Array.isArray(arr)) {
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            dmsLastHour = arr.filter((t: any) => typeof t === 'number' && t > oneHourAgo).length;
          }
        }
      } catch {}

      // Read user-configured limits — the chosen ceiling itself is a risk signal.
      let configDailyMaxDMs: number | null = null;
      let configHourlyMaxDMs: number | null = null;
      let configMinActionDelay: number | null = null;
      try {
        const stateRaw = localStorage.getItem('futnor_bot_state');
        if (stateRaw) {
          const parsed = JSON.parse(stateRaw);
          const c = parsed?.config;
          if (c) {
            if (typeof c.dailyMaxDMs === 'number') configDailyMaxDMs = c.dailyMaxDMs;
            if (typeof c.hourlyMaxDMs === 'number') configHourlyMaxDMs = c.hourlyMaxDMs;
            if (typeof c.minActionDelay === 'number') configMinActionDelay = c.minActionDelay;
          }
        }
      } catch {}

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user || cancelled) return;

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Pull 30 days so we can compute 7d, 24h, and 30d signals from one query.
      const { data: sessions30 } = await (supabase
        .from('session_history')
        .select('*')
        .eq('platform', 'instagram')
        .eq('instagram_account_username', activeAccount)
        .gte('started_at', thirtyDaysAgo.toISOString())
        .order('started_at', { ascending: false })
        .limit(400) as any);

      if (cancelled) return;

      if (!sessions30 || sessions30.length === 0) {
        setSignals({
          ...defaultSignals,
          warmupSessionsLast7Days: warmupCount,
          lastBlockReason,
          lastBlockAtMs,
          dmsLastHour,
          configDailyMaxDMs,
          configHourlyMaxDMs,
          configMinActionDelay,
        });
        setLoadingSignals(false);
        return;
      }

      const sessions7 = sessions30.filter((s: any) => new Date(s.started_at) >= sevenDaysAgo);
      const sessions24h = sessions30.filter((s: any) => new Date(s.started_at) >= oneDayAgo);
      const todaySessions = sessions30.filter((s: any) => new Date(s.started_at) >= todayStart);

      const sumField = (arr: any[], field: string) =>
        arr.reduce((a: number, s: any) => a + (s[field] || 0), 0);

      const totalDms7 = sumField(sessions7, 'dms_sent');
      const totalDms30 = sumField(sessions30, 'dms_sent');
      const totalLikes7 = sumField(sessions7, 'likes_sent');
      const totalFollows7 = sumField(sessions7, 'follows_sent');
      const totalScrolls7 = sumField(sessions7, 'scrolls');
      const totalAll7 = totalDms7 + totalLikes7 + totalFollows7 + totalScrolls7;
      const avgDuration = sumField(sessions7, 'duration_seconds') / Math.max(1, sessions7.length);
      const longestToday = todaySessions.reduce((max: number, s: any) => Math.max(max, s.duration_seconds || 0), 0);
      const dmsToday = sumField(todaySessions, 'dms_sent');

      setSignals({
        recentSessions: sessions7.length,
        avgSessionDuration: avgDuration,
        avgDmsPerSession: sessions7.length > 0 ? totalDms7 / sessions7.length : 0,
        totalDmsLast7Days: totalDms7,
        totalActionsLast7Days: totalAll7,
        totalDmsLast30Days: totalDms30,
        warmupSessionsLast7Days: warmupCount,
        dmToActionRatio: totalAll7 > 0 ? totalDms7 / totalAll7 : 0,
        sessionsToday: todaySessions.length,
        sessionsLast24h: sessions24h.length,
        longestSessionToday: longestToday,
        dmsToday,
        dmsLastHour,
        lastBlockReason,
        lastBlockAtMs,
        configDailyMaxDMs,
        configHourlyMaxDMs,
        configMinActionDelay,
      });
      setLoadingSignals(false);
    };

    setLoadingSignals(true);
    fetchSignals();
    const interval = setInterval(fetchSignals, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeAccount, isRunning]);

  const { score, factors } = calculateHealthScore(signals, stats, hasWarmedUp, dmMode);

  // While loading first batch of data, show a spinner so stale scores aren't displayed
  if (activeAccount && loadingSignals) {
    return (
      <div className="glass rounded-xl p-5 animate-fade-in">
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-5 h-5 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Account Health</h3>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <User className="w-4 h-4 shrink-0 animate-spin" />
          <span>Loading health data for <span className="font-mono">@{activeAccount}</span>…</span>
        </div>
      </div>
    );
  }

  // Bands shifted down vs the previous calibration. 80+ now requires the
  // account to genuinely be in a low-risk state — warmed, low volume, no recent
  // block, conservative configuration. Anything cold-outreach-shaped lands in
  // Fair (50–69) or Caution (35–49) by design.
  const getColor = () => {
    if (score >= 80) return { ring: 'stroke-success', text: 'text-success', bg: 'bg-success/10', label: 'Healthy' };
    if (score >= 65) return { ring: 'stroke-success', text: 'text-success', bg: 'bg-success/10', label: 'Stable' };
    if (score >= 50) return { ring: 'stroke-warning', text: 'text-warning', bg: 'bg-warning/10', label: 'Fair' };
    if (score >= 35) return { ring: 'stroke-warning', text: 'text-warning', bg: 'bg-warning/10', label: 'Caution' };
    return { ring: 'stroke-destructive', text: 'text-destructive', bg: 'bg-destructive/10', label: 'At Risk' };
  };

  const { ring, text, bg, label } = getColor();
  const Icon = score >= 65 ? ShieldCheck : score >= 35 ? AlertTriangle : ShieldAlert;
  const TrendIcon = score >= 65 ? TrendingUp : score >= 35 ? Minus : TrendingDown;

  const size = 100;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);

  // No account detected — show a clear "per-account only" placeholder
  if (!activeAccount) {
    return (
      <div className="glass rounded-xl p-5 animate-fade-in">
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-5 h-5 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Account Health</h3>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <User className="w-4 h-4 shrink-0" />
          <span>No Instagram account detected. Open Instagram in your browser to see per-account health stats.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="glass rounded-xl p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn('w-5 h-5', text)} />
        <h3 className="text-sm font-semibold">Account Health</h3>
        <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', bg, text)}>
          {label}
        </span>
        <TrendIcon className={cn('w-3.5 h-3.5 ml-auto', text)} />
      </div>
      {/* Active account label */}
      <div className="flex items-center gap-1.5 mb-4">
        <User className="w-3 h-3 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground font-mono">@{activeAccount}</span>
      </div>

      <div className="flex items-start gap-6">
        {/* Gauge */}
        <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="-rotate-90">
            <circle cx={size/2} cy={size/2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-secondary" />
            <circle
              cx={size/2} cy={size/2} r={radius} fill="none"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              className={cn('transition-all duration-1000 ease-out', ring)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn('text-2xl font-bold font-mono', text)}>{score}</span>
            <span className="text-[9px] text-muted-foreground">/ 100</span>
          </div>
        </div>

        {/* Factors */}
        <div className="flex-1 space-y-1.5 min-w-0">
          {factors.slice(0, 8).map((f, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0',
                f.impact === 'positive' ? 'bg-success' :
                f.impact === 'negative' ? 'bg-destructive' :
                'bg-muted-foreground/40'
              )} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{f.label}</span>
                  {f.action === 'warmup' && canWarmUp && onGoToWarmup && (
                    <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-accent hover:text-accent gap-1" onClick={onGoToWarmup}>
                      <Flame className="w-3 h-3" /> Warm Up
                    </Button>
                  )}
                  {f.action === 'warmup' && !canWarmUp && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-primary hover:text-primary gap-1">
                          <Lock className="w-3 h-3" /> Upgrade
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-3" align="start">
                        <div className="flex items-start gap-2">
                          <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                            <Sparkles className="w-3.5 h-3.5 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold">Upgrade to warm up your account</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                              Warm-up is available on Growth and Scale plans. Prime your account to safely send more DMs.
                            </p>
                            {onUpgrade && (
                              <Button size="sm" className="h-6 px-2 text-[10px] mt-2 gap-1" onClick={onUpgrade}>
                                <Sparkles className="w-3 h-3" /> See plans
                              </Button>
                            )}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                  {f.action === 'delays' && onGoToDelays && (
                    <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-warning hover:text-warning gap-1" onClick={onGoToDelays}>
                      <Timer className="w-3 h-3" /> Adjust
                    </Button>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground truncate">{f.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Daily session goal progress — counts DMs from every session run
          today (since the user's local midnight), not just the live session.
          Reads from the same `futnor_dm_timestamps` ledger the extension
          uses to enforce the goal, so the bar matches the bot's auto-stop
          trigger. The browser's `new Date(y, m, d)` constructor uses local
          time, so this naturally reflects the user's timezone. */}
      {sessionDmGoal > 0 && (() => {
        let dailySent = 0;
        try {
          const raw = localStorage.getItem('futnor_dm_timestamps');
          if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
              const now = new Date();
              const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
              dailySent = arr.filter((t) => typeof t === 'number' && t >= todayStart).length;
            }
          }
        } catch {}
        // Fall back to live session DMs if the ledger isn't mirrored yet (first
        // few seconds after extension load). Otherwise the bar would show 0/N
        // even while the user is actively sending in the current session.
        const liveSent = stats.dmsSent || 0;
        const sent = Math.max(dailySent, liveSent);
        const pct = Math.min(100, Math.round((sent / sessionDmGoal) * 100));
        const complete = sent >= sessionDmGoal;
        return (
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">Daily {goalLabel.toLowerCase()} goal</span>
                {complete && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-success/20 text-success font-medium">
                    Complete
                  </span>
                )}
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                {sent} / {sessionDmGoal} ({pct}%)
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className={cn('h-full transition-all duration-500', complete ? 'bg-success' : 'bg-primary')}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })()}

      {/* Quick stats bar */}
      <div className="mt-4 pt-3 border-t border-border grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-lg font-bold font-mono text-foreground">{signals.dmsToday + (stats.dmsSent || 0)}</p>
          <p className="text-[10px] text-muted-foreground">DMs today</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-foreground">{signals.totalDmsLast7Days}</p>
          <p className="text-[10px] text-muted-foreground">DMs this week</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-foreground">{signals.sessionsToday}</p>
          <p className="text-[10px] text-muted-foreground">Sessions today</p>
        </div>
      </div>
    </div>
  );
}
