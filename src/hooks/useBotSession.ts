import { useState, useRef, useCallback, useEffect } from 'react';
import {
  BotConfig,
  BotStats,
  LogEntry,
  defaultConfig,
  generateId,
} from '@/lib/botEngine';
import { supabase } from '@/integrations/supabase/client';
import type { SubscriptionTier } from '@/lib/subscriptionTiers';

const STORAGE_KEY = 'futnor_bot_state';
const COMMAND_KEY = 'futnor_command';
const EXT_STATUS_KEY = 'futnor_ext_status';
const RECONNECTING_MESSAGE = 'Reconnecting to extension...';

const EMPTY_STATS: BotStats = {
  dmsSent: 0,
  likesSent: 0,
  followsSent: 0,
  scrolls: 0,
  elapsedTime: 0,
  sessionTime: 0,
};

type SessionStartResult =
  | { status: 'session_started' }
  | { status: 'not_detected' }
  // `message` is optional on rejection — the extension may provide a
  // user-friendly explanation (e.g. for session_cooldown / recent_block)
  // that the dashboard should surface verbatim.
  | { status: 'start_rejected'; reason: string; account?: string; message?: string }
  | { status: 'start_failed'; reason?: string; message: string };

interface SessionStartContext {
  tier?: SubscriptionTier;
  userId?: string | null;
  authReady?: boolean;
}

function saveToLocalStorage(config: BotConfig, stats: BotStats, logs: LogEntry[]) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        config,
        stats,
        logs: logs.slice(0, 50).map((log) => ({
          ...log,
          timestamp: log.timestamp instanceof Date ? log.timestamp.toISOString() : log.timestamp,
        })),
        updatedAt: Date.now(),
      }),
    );
  } catch {}
}

function loadFromLocalStorage(): { config?: BotConfig } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendExtensionCommand(cmd: Record<string, any>) {
  try {
    const payload = { ...cmd, processed: false, timestamp: Date.now() };
    localStorage.setItem(COMMAND_KEY, JSON.stringify(payload));
    window.postMessage({ source: 'futnor-web', command: payload }, '*');
  } catch (error) {
    console.error('[Futnor Web] Error sending extension command:', error);
  }
}

function getExtensionStatus(): {
  connected: boolean;
  bridgeConnected?: boolean;
  isRunning?: boolean;
  isPaused?: boolean;
  stats?: BotStats;
  logs?: any[];
  timestamp?: number;
  warmupOffer?: boolean;
  reconnecting?: boolean;
  extensionVersion?: string;
} | null {
  try {
    const raw = localStorage.getItem(EXT_STATUS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);

    if (data.timestamp && Date.now() - data.timestamp > 20000) {
      return { ...data, connected: false, bridgeConnected: false };
    }

    return data;
  } catch {
    return null;
  }
}

async function pingExtension(timeoutMs = 4000): Promise<boolean> {
  const singlePing = () => new Promise<boolean>((resolve) => {
    let resolved = false;
    const pingId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const handleMessage = (event: MessageEvent) => {
      if (
        event.data?.source === 'futnor-extension' &&
        event.data?.type === 'PONG' &&
        event.data?.pingId === pingId
      ) {
        resolved = true;
        window.removeEventListener('message', handleMessage);
        resolve(true);
      }
    };

    window.addEventListener('message', handleMessage);
    window.postMessage({ source: 'futnor-web', type: 'PING', pingId }, '*');

    window.setTimeout(() => {
      if (resolved) return;
      window.removeEventListener('message', handleMessage);
      resolve(false);
    }, timeoutMs);
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await singlePing();
    if (ok) return true;
    if (attempt < 2) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }

  return false;
}

function waitForCommandResponse(cmdType: string, timeoutMs = 30000): Promise<any | null> {
  return new Promise((resolve) => {
    const responseKey = `${COMMAND_KEY}_response`;
    const startTime = Date.now();
    const interval = window.setInterval(() => {
      try {
        const raw = localStorage.getItem(responseKey);
        if (raw) {
          const response = JSON.parse(raw);
          if (response.type === cmdType && response.timestamp > startTime - 1000) {
            window.clearInterval(interval);
            resolve(response);
            return;
          }
        }
      } catch {}

      if (Date.now() - startTime > timeoutMs) {
        window.clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });
}

function mapExtensionLogs(rawLogs: any[] | undefined): LogEntry[] {
  return Array.isArray(rawLogs)
    ? rawLogs.map((log) => ({
        id: log?.id || generateId(),
        timestamp: log?.timestamp ? new Date(log.timestamp) : new Date(),
        action: log?.action || 'scroll',
        message: log?.message || '',
      }))
    : [];
}

export function useBotSession() {
  const [config, setConfigState] = useState<BotConfig>(() => {
    const loaded = loadFromLocalStorage()?.config;
    if (loaded) {
      const em = loaded.engagementMonitor || defaultConfig.engagementMonitor;
      return {
        ...defaultConfig,
        ...loaded,
        engagementMonitor: {
          ...defaultConfig.engagementMonitor,
          ...em,
          postUrls: em.postUrls || (em.postUrl ? [em.postUrl] : []),
        },
      };
    }
    return defaultConfig;
  });
  const [stats, setStats] = useState<BotStats>(EMPTY_STATS);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [limitWarning, setLimitWarning] = useState<string | null>(null);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [warmupOffer, setWarmupOffer] = useState(false);
  const startCommandSentAt = useRef(0);
  const isRunningRef = useRef(false);
  const hookMountedAtRef = useRef(Date.now());
  // Reconnect grace window — track when the extension first reported
  // `reconnecting`/disconnected so brief flaps during normal in-session
  // navigation (e.g. opening a commenter profile) don't strobe the UI
  // between "Running" and "Reconnecting…".
  const reconnectingSinceRef = useRef<number | null>(null);
  const disconnectedSinceRef = useRef<number | null>(null);
  const RECONNECT_UI_GRACE_MS = 3000;
  const activeAccountRef = useRef<string | null>(
    typeof window !== 'undefined'
      ? ((localStorage.getItem('futnor_active_account') || '').toLowerCase().replace(/^@/, '').trim() || null)
      : null,
  );

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    saveToLocalStorage(config, stats, logs);
  }, [config, stats, logs]);

  // Push delay changes to the running extension session so the user can slow
  // the bot down mid-session via the AccountHealthScore "Adjust" button.
  useEffect(() => {
    if (!isRunning) return;
    sendExtensionCommand({
      type: 'UPDATE_CONFIG',
      config: {
        sessionMin: config.sessionMin,
        sessionMax: config.sessionMax,
        scrollWeight: config.scrollWeight,
        likeWeight: config.likeWeight,
        dmWeight: config.dmWeight,
        minActionDelay: config.minActionDelay,
        maxActionDelay: config.maxActionDelay,
        dailyMaxDMs: config.dailyMaxDMs,
        dailyMaxLikes: config.dailyMaxLikes,
        dailyMaxFollows: config.dailyMaxFollows,
        sessionDmGoal: config.sessionDmGoal || 0,
        dmMode: config.dmMode,
        // DM pacing controls (added v2.4.92)
        dmCooldownSec: config.dmCooldownSec ?? 0,
        dmBurstSize: config.dmBurstSize ?? 0,
        dmBurstPauseSec: config.dmBurstPauseSec ?? 0,
      },
    });
  }, [
    isRunning,
    config.minActionDelay,
    config.maxActionDelay,
    config.dmCooldownSec,
    config.dmBurstSize,
    config.dmBurstPauseSec,
  ]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      const activeAccount = ((localStorage.getItem('futnor_active_account') || '').toLowerCase().replace(/^@/, '').trim()) || null;
      if (activeAccount !== activeAccountRef.current) {
        const previousActiveAccount = activeAccountRef.current;
        activeAccountRef.current = activeAccount;

        const shouldResetForRealAccountSwitch = Boolean(previousActiveAccount) && Boolean(activeAccount);

        if (shouldResetForRealAccountSwitch) {
          setStats(EMPTY_STATS);
          setLogs([]);
          setIsRunning(false);
          setIsPaused(false);
          setLimitWarning(null);
          setWarmupOffer(false);
        }
      }

      const extensionStatus = getExtensionStatus();
      const freshBackgroundStatus = Boolean(
        extensionStatus?.connected === true &&
        extensionStatus?.timestamp &&
        extensionStatus.timestamp >= hookMountedAtRef.current,
      );
      const reconnecting = Boolean(extensionStatus?.reconnecting);

      // Track reconnect/disconnect duration so we only flip the UI after a
      // sustained signal (avoids strobing during normal short tab navs).
      const now = Date.now();
      if (reconnecting) {
        if (reconnectingSinceRef.current === null) reconnectingSinceRef.current = now;
      } else {
        reconnectingSinceRef.current = null;
      }
      if (!freshBackgroundStatus) {
        if (disconnectedSinceRef.current === null) disconnectedSinceRef.current = now;
      } else {
        disconnectedSinceRef.current = null;
      }

      const sustainedReconnecting =
        reconnectingSinceRef.current !== null &&
        now - reconnectingSinceRef.current >= RECONNECT_UI_GRACE_MS;
      const sustainedDisconnected =
        disconnectedSinceRef.current !== null &&
        now - disconnectedSinceRef.current >= RECONNECT_UI_GRACE_MS;

      // Only mark the bridge as disconnected after the grace window. Until
      // then keep the previous "connected" state so brief background-worker
      // wake/sleep cycles don't toggle the badge.
      if (freshBackgroundStatus) {
        setExtensionConnected(true);
      } else if (sustainedDisconnected) {
        setExtensionConnected(false);
      }

      if (extensionStatus?.extensionVersion) {
        setExtensionVersion(extensionStatus.extensionVersion);
      }

      if (!freshBackgroundStatus) {
        if (isRunningRef.current && sustainedDisconnected) {
          setIsPaused(true);
          setLimitWarning((current) => current ?? RECONNECTING_MESSAGE);
        }
        return;
      }

      if (extensionStatus?.stats) {
        setStats({ ...EMPTY_STATS, ...extensionStatus.stats });
      }

      if (Array.isArray(extensionStatus?.logs)) {
        setLogs(mapExtensionLogs(extensionStatus.logs));
      }

      setIsPaused(sustainedReconnecting ? true : Boolean(extensionStatus?.isPaused));

      if (typeof extensionStatus?.isRunning === 'boolean') {
        const recentStart = Date.now() - startCommandSentAt.current < 8000;
        if (!(recentStart && isRunningRef.current && !extensionStatus.isRunning)) {
          setIsRunning(extensionStatus.isRunning);
        }
      }

      setLimitWarning((current) => {
        if (sustainedReconnecting) return RECONNECTING_MESSAGE;
        return current === RECONNECTING_MESSAGE ? null : current;
      });

      setWarmupOffer(Boolean(extensionStatus?.warmupOffer && !extensionStatus?.isRunning));
    }, 800);

    return () => window.clearInterval(poll);
  }, []);

  useEffect(() => {
    window.postMessage(
      {
        source: 'futnor-web',
        command: { type: 'PING_EXTENSION', processed: false, timestamp: Date.now() },
      },
      '*',
    );
  }, []);

  const setConfig = useCallback((newConfig: BotConfig) => {
    setConfigState(newConfig);
  }, []);

  const startSession = useCallback(async (context?: SessionStartContext): Promise<SessionStartResult> => {
    if (context?.authReady === false) {
      return { status: 'start_rejected', reason: 'auth_not_ready' };
    }

    const { data: { session } } = await supabase.auth.getSession();
    const resolvedUserId = context?.userId ?? session?.user?.id ?? null;
    const resolvedTier = context?.tier;

    if (!resolvedUserId) {
      return { status: 'start_rejected', reason: 'auth_not_ready' };
    }

    const extensionAlive = await pingExtension(4000);
    const extensionStatus = getExtensionStatus();
    const freshBackgroundStatus = Boolean(
      extensionStatus?.connected === true &&
      extensionStatus?.timestamp &&
      extensionStatus.timestamp >= hookMountedAtRef.current,
    );

    if (!extensionAlive && !freshBackgroundStatus) {
      setExtensionConnected(false);
      return { status: 'not_detected' };
    }

    setExtensionConnected(true);
    setLimitWarning(null);

    let dmTemplates: string[] = [];

    const parseScripts = (raw: string): string[] => {
      if (!raw || !raw.trim()) return [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((s: unknown) => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n') : ''))
            .filter((s) => s.trim().length > 0);
        }
        if (typeof parsed === 'string' && parsed.trim()) return [parsed.replace(/\r\n?/g, '\n')];
      } catch {
        return [raw.replace(/\r\n?/g, '\n')];
      }
      return [];
    };

    try {
      const tag = config.platform === 'tiktok' ? 'comment-scripts' : 'dm-scripts';
      const currentAccount = activeAccountRef.current;

      // Per-account bulks: each connected account independently picks ONE active bulk.
      // The active account is encoded in `content_tags` as `account:<handle>`.
      // RLS scopes rows to the current user; we further filter by the active account.

      // 1) Active "script-bulk" for this user+platform+account
      if (currentAccount) {
        const { data: bulkData } = await supabase
          .from('outreach_profiles')
          .select('custom_message, content_tags')
          .contains('content_tags', ['script-bulk', `account:${currentAccount}`])
          .eq('platform', config.platform)
          .order('created_at', { ascending: false });

        if (bulkData) {
          for (const row of bulkData) {
            const scripts = parseScripts(row.custom_message);
            if (scripts.length > 0) {
              dmTemplates = scripts;
              break;
            }
          }
        }
      }

      // 2) Legacy fallback: only when NO account is selected (single-account legacy users).
      // When an account IS selected, we must NOT fall back to a global query — doing so
      // would leak another account's bulk into this account's session.
      if (dmTemplates.length === 0 && !currentAccount) {
        const { data } = await supabase
          .from('outreach_profiles')
          .select('custom_message')
          .contains('content_tags', [tag])
          .eq('platform', config.platform)
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .limit(1);

        if (data) {
          for (const row of data) {
            const scripts = parseScripts(row.custom_message);
            if (scripts.length > 0) {
              dmTemplates = scripts;
              break;
            }
          }
        }
      }
    } catch (error) {
      console.error('[Futnor Web] Error loading DM templates:', error);
    }

    if (dmTemplates.length === 0) {
      const currentAccount = activeAccountRef.current;
      return {
        status: 'start_rejected',
        reason: currentAccount ? 'missing_dm_script_for_account' : 'missing_dm_script',
        account: currentAccount || undefined,
      };
    }

    saveToLocalStorage(config, stats, logs);

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (dmTemplates.length > 0) {
          data.config = { ...data.config, dmTemplates };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        }
      }
    } catch {}

    startCommandSentAt.current = Date.now();
    sendExtensionCommand({
      type: 'START_SESSION',
      platform: config.platform,
      tier: resolvedTier,
      userId: resolvedUserId,
      config: {
        sessionMin: config.sessionMin,
        sessionMax: config.sessionMax,
        scrollWeight: config.scrollWeight,
        likeWeight: config.likeWeight,
        dmWeight: config.dmWeight,
        minActionDelay: config.minActionDelay,
        maxActionDelay: config.maxActionDelay,
        dailyMaxDMs: config.dailyMaxDMs,
        dailyMaxLikes: config.dailyMaxLikes,
        dailyMaxFollows: config.dailyMaxFollows,
        sessionDmGoal: config.sessionDmGoal || 0,
        dmMode: config.dmMode,
        // DM pacing controls
        dmCooldownSec: config.dmCooldownSec ?? 0,
        dmBurstSize: config.dmBurstSize ?? 0,
        dmBurstPauseSec: config.dmBurstPauseSec ?? 0,
        dmTemplates,
      },
      targeting: config.targeting,
      aiTargeting: config.aiTargeting,
    });

    const response = await waitForCommandResponse('START_SESSION', 45000);

    if (response?.status === 'session_started') {
      setStats(EMPTY_STATS);
      setLogs([]);
      setIsPaused(false);
      setIsRunning(true);
      setWarmupOffer(false);
      return { status: 'session_started' };
    }

    if (response?.status === 'start_rejected' || response?.ok === false) {
      return {
        status: 'start_rejected',
        reason: response.reason || 'unknown',
        // Forward any user-friendly message the extension supplied (e.g. the
        // 90-min session-gap cooldown timer or 24h post-block lockout text).
        ...(typeof response.message === 'string' ? { message: response.message } : {}),
        ...(typeof response.account === 'string' ? { account: response.account } : {}),
      };
    }

    // No response landed in localStorage within the 45s wait — almost always
    // the SW being slow to acknowledge (active-account detection, platform
    // tab priming, or a chrome.storage round trip stalling the handler).
    // The session itself may still start in the background, so we surface
    // a diagnostic toast instead of a generic "failed".
    return {
      status: 'start_failed',
      reason: response?.reason || 'no_ack',
      message: response
        ? (response.message || 'Extension acknowledged but could not start the session — check the activity log and try again.')
        : 'The extension didn\'t respond in time. The session may still be starting — wait a few seconds and check the activity log before clicking Start again.',
    };
  }, [config, logs, stats]);

  const stopSession = useCallback(() => {
    setLimitWarning(null);
    sendExtensionCommand({ type: 'STOP_SESSION' });
  }, []);

  const pauseSession = useCallback(() => {
    sendExtensionCommand({ type: 'PAUSE_SESSION' });
  }, []);

  const resumeSession = useCallback(() => {
    sendExtensionCommand({ type: 'RESUME_SESSION' });
  }, []);

  const continuePastLimit = useCallback(() => {
    setLimitWarning(null);
  }, []);

  const resetStats = useCallback(() => {
    setLimitWarning(null);
    sendExtensionCommand({ type: 'RESET_STATS' });
  }, []);

  const acceptWarmup = useCallback(() => {
    setWarmupOffer(false);
    sendExtensionCommand({ type: 'CLEAR_WARMUP_OFFER' });
    sendExtensionCommand({
      type: 'START_WARMUP',
      platform: config.platform,
      sessionMinutes: 15,
      enableComments: false,
    });
  }, [config.platform]);

  const dismissWarmup = useCallback(() => {
    setWarmupOffer(false);
    sendExtensionCommand({ type: 'CLEAR_WARMUP_OFFER' });
  }, []);

  return {
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
  };
}
