import { useState, useRef, useCallback, useEffect } from 'react';
import {
  WarmupAction,
  DEFAULT_WARMUP_SESSION,
  pickChaosAction,
  getChaosDelay,
  resetChaosState,
  getActionLabel,
} from '@/lib/warmupEngine';

export interface WarmupLog {
  id: string;
  timestamp: Date;
  action: WarmupAction;
  message: string;
}

export interface WarmupStats {
  storiesViewed: number;
  postsLiked: number;
  feedScrolls: number;
  exploreScrolls: number;
  commentsRead: number;
  commentsPosted: number;
  totalActions: number;
  elapsedTime: number;
  sessionTime: number;
}

const emptyStats: WarmupStats = {
  storiesViewed: 0,
  postsLiked: 0,
  feedScrolls: 0,
  exploreScrolls: 0,
  commentsRead: 0,
  commentsPosted: 0,
  totalActions: 0,
  elapsedTime: 0,
  sessionTime: 0,
};

// v2.4.157: this used to be its own broken variant instead of the sender every
// other command path uses (see useBotSession.ts). Three defects, and warm-up
// only ever worked once per page load because of them:
//
//   1. It wrote `ts` instead of `timestamp`. The bridge's
//      getCommandFingerprint() reads Number(cmd.timestamp) || 0, so EVERY
//      warm-up command fingerprinted identically as "START_WARMUP:...:0".
//      claimCommandLock() sees that fingerprint in handledCommands from the
//      first click onward and returns false, so the second and every later
//      click were dropped as duplicates.
//
//   2. `window.dispatchEvent(new Event('storage'))` creates an event with no
//      `key` property. The bridge listener gates on `e.key === COMMAND_KEY`,
//      so the synthetic event matched nothing. Real storage events only fire
//      in OTHER tabs/frames, which is why the command sometimes limped through
//      via an iframe instance of the bridge and sometimes vanished entirely.
//
//   3. No `processed: false`, so the bridge's freshness logic had nothing sane
//      to reason about.
//
// Matching useBotSession.ts exactly: real timestamp, processed flag, and the
// postMessage path that delivers instantly within the same tab.
function sendExtensionCommand(cmd: Record<string, unknown>) {
  try {
    const payload = { ...cmd, processed: false, timestamp: Date.now() };
    localStorage.setItem('futnor_command', JSON.stringify(payload));
    window.postMessage({ source: 'futnor-web', command: payload }, '*');
  } catch (error) {
    console.error('[Futnor Web] Error sending warm-up command:', error);
  }
}

function getExtensionStatus(): { connected: boolean; warmup?: any } | null {
  try {
    const raw = localStorage.getItem('futnor_ext_status');
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - (data.timestamp || 0) > 5000) return null;
    return data;
  } catch {
    return null;
  }
}

export function useWarmupSession() {
  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<WarmupStats>({ ...emptyStats });
  const [logs, setLogs] = useState<WarmupLog[]>([]);
  const [sessionMinutes, setSessionMinutes] = useState(DEFAULT_WARMUP_SESSION);
  const [currentAction, setCurrentAction] = useState<string | null>(null);
  const [enableComments, setEnableComments] = useState(false);
  const [autoStartDM, setAutoStartDM] = useState(() => {
    try { return localStorage.getItem('futnor_auto_start_dm') === 'true'; } catch { return false; }
  });
  const abortRef = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const onCompleteRef = useRef<(() => void) | null>(null);
  // Guards: prevent auto-DM from firing after a user-initiated stop, and
  // prevent both the extension poll and the local fallback timer from firing
  // the handoff callback twice for the same session.
  const userCancelledRef = useRef(false);
  const autoDmFiredRef = useRef(false);

  const addLog = useCallback((action: WarmupAction, message: string) => {
    setLogs(prev =>
      [
        {
          id: Math.random().toString(36).substring(2, 9),
          timestamp: new Date(),
          action,
          message,
        },
        ...prev,
      ].slice(0, 80)
    );
  }, []);

  const updateStat = useCallback((action: WarmupAction) => {
    setStats(prev => {
      const next = { ...prev, totalActions: prev.totalActions + 1 };
      switch (action) {
        case 'view_story': next.storiesViewed++; break;
        case 'like_post': next.postsLiked++; break;
        case 'scroll_feed': next.feedScrolls++; break;
        case 'scroll_explore': next.exploreScrolls++; break;
        case 'read_comments': next.commentsRead++; break;
        default: break;
      }
      return next;
    });
  }, []);

  // Poll extension for warmup state
  useEffect(() => {
    pollRef.current = setInterval(() => {
      const ext = getExtensionStatus();
      if (ext?.warmup) {
        const w = ext.warmup;
        if (w.stats) {
          setStats(prev => ({
            ...prev,
            ...w.stats,
          }));
        }
        if (w.logs?.length > 0) {
          setLogs(w.logs.map((l: any) => ({
            id: l.id || Math.random().toString(36).substring(2, 9),
            timestamp: new Date(l.timestamp),
            action: 'scroll_feed' as WarmupAction,
            message: l.message,
          })));
          if (w.logs.length > 0) {
            setCurrentAction(w.logs[0].message);
          }
        }
        // Extension reported warmup stopped — sync UI
        if (w.isRunning === false && isRunning) {
          setIsRunning(false);
          setCurrentAction(null);
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          // v2.4.150: the warm-up count is no longer written here. The
          // extension now records each completed warm-up with a timestamp in
          // `futnor_warmup_sessions` (mirrored to localStorage by the dashboard
          // bridge), which AccountHealthScore reads with a real 7-day window.
          // The old `futnor_warmup_count_7d_<account>` key was incremented from
          // BOTH this poll branch and the local auto-complete timer below, so a
          // single warm-up often counted twice — and nothing ever expired it.
          // Auto-start DM if enabled — but only for natural completion,
          // never after a user-initiated stop, and never twice per session.
          if (autoStartDM && onCompleteRef.current && !userCancelledRef.current && !autoDmFiredRef.current) {
            autoDmFiredRef.current = true;
            setTimeout(() => { onCompleteRef.current?.(); }, 2000);
          }
        }
        // Extension reported warmup is running — sync UI
        if (w.isRunning === true && !isRunning) {
          setIsRunning(true);
        }
      }
    }, 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isRunning, autoStartDM]);

  const startWarmup = useCallback(async () => {
    abortRef.current = false;
    userCancelledRef.current = false;
    autoDmFiredRef.current = false;
    resetChaosState();
    setIsRunning(true);

    const totalSeconds = sessionMinutes * 60;
    setStats({ ...emptyStats, sessionTime: totalSeconds });
    setLogs([]);

    addLog('scroll_feed', `Warm-up started — ${sessionMinutes} min session`);

    // Send command to extension — it handles all actual warmup actions
    sendExtensionCommand({
      type: 'START_WARMUP',
      sessionMinutes,
      platform: 'instagram',
      enableComments,
    });

    // Local elapsed timer as fallback display (extension polling updates real stats)
    intervalRef.current = setInterval(() => {
      setStats(prev => {
        const next = { ...prev, elapsedTime: prev.elapsedTime + 1 };
        // Auto-complete if elapsed exceeds session time and extension hasn't reported
        if (next.elapsedTime >= next.sessionTime && next.sessionTime > 0) {
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          setIsRunning(false);
          setCurrentAction(null);
          addLog('scroll_feed', 'Warm-up session complete ✓');
          // v2.4.150: no warm-up counter written here either — see the note in
          // the extension-poll branch above. The extension owns the ledger.
          if (autoStartDM && onCompleteRef.current && !userCancelledRef.current && !autoDmFiredRef.current) {
            autoDmFiredRef.current = true;
            addLog('scroll_feed', '🚀 Auto-starting DM session...');
            setTimeout(() => { onCompleteRef.current?.(); }, 2000);
          }
        }
        return next;
      });
    }, 1000);
  }, [sessionMinutes, addLog, enableComments, autoStartDM]);

  const stopWarmup = useCallback(() => {
    abortRef.current = true;
    // Block the poll loop from auto-firing the DM handoff after the
    // extension reports isRunning=false in response to the STOP_WARMUP below.
    userCancelledRef.current = true;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsRunning(false);
    setCurrentAction(null);
    addLog('pause', 'Warm-up stopped by user');

    // Tell extension to stop
    sendExtensionCommand({ type: 'STOP_WARMUP' });
  }, [addLog]);

  const setAutoStartDMPersisted = useCallback((val: boolean) => {
    setAutoStartDM(val);
    try { localStorage.setItem('futnor_auto_start_dm', String(val)); } catch {}
  }, []);

  const setOnWarmupComplete = useCallback((cb: (() => void) | null) => {
    onCompleteRef.current = cb;
  }, []);

  return {
    isRunning,
    stats,
    logs,
    sessionMinutes,
    setSessionMinutes,
    currentAction,
    enableComments,
    setEnableComments,
    autoStartDM,
    setAutoStartDM: setAutoStartDMPersisted,
    startWarmup,
    stopWarmup,
    setOnWarmupComplete,
  };
}
