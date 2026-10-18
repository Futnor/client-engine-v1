// Content script for the Futnor dashboard — bridges web app ↔ extension
// Runs on the dashboard website, syncs config/stats/commands bidirectionally

const STORAGE_KEY = 'futnor_bot_state';
const COMMAND_KEY = 'futnor_command';
const EXT_STATUS_KEY = 'futnor_ext_status';
const SYNC_INTERVAL = 1500;

const DM_HISTORY_KEY_BASE = 'dm_history';
const PROCESSED_ACCOUNTS_KEY_BASE = 'processed_accounts_history';
const SESSION_STATE_KEY_BASE = 'futnor_session';
let dashboardActiveAccount = null;

function normalizeDMHistoryEntry(value) {
  const raw = (value || '').toString().toLowerCase().trim();
  if (!raw) return null;
  if (raw.startsWith('thread_')) return raw;
  return raw.replace(/^@/, '');
}

function normalizeAccountEntry(value) {
  const normalized = (value || '').toString().toLowerCase().replace(/^@/, '').trim();
  return normalized || null;
}

function getDMHistoryKey() {
  return dashboardActiveAccount ? `${DM_HISTORY_KEY_BASE}_${dashboardActiveAccount}` : DM_HISTORY_KEY_BASE;
}

function getProcessedAccountsKey() {
  return dashboardActiveAccount ? `${PROCESSED_ACCOUNTS_KEY_BASE}_${dashboardActiveAccount}` : PROCESSED_ACCOUNTS_KEY_BASE;
}

function getSessionStateKey(accountOverride = dashboardActiveAccount) {
  const normalized = normalizeAccountEntry(accountOverride);
  return normalized ? `${SESSION_STATE_KEY_BASE}_${normalized}` : SESSION_STATE_KEY_BASE;
}

// Load active account from extension storage and mirror to localStorage for React app
function setActiveAccountEverywhere(username) {
  dashboardActiveAccount = normalizeAccountEntry(username);
  try {
    if (dashboardActiveAccount) {
      localStorage.setItem('futnor_active_account', dashboardActiveAccount);
    } else {
      localStorage.removeItem('futnor_active_account');
    }
  } catch {}
}

function requestActiveAccountDetection(reason) {
  // Ask the SW to attempt an immediate detection (with built-in retry+backoff).
  // The result lands in chrome.storage.local.futnor_active_account, which our
  // onChanged listener below mirrors into the dashboard's localStorage.
  try {
    chrome.runtime.sendMessage({ type: 'REQUEST_ACTIVE_ACCOUNT_DETECTION' }, (resp) => {
      if (chrome.runtime.lastError) return;
      console.log(`[Futnor Dashboard Bridge] Detection requested (${reason}):`, resp?.username || '(none yet)');
    });
  } catch {}
}

try {
  chrome.storage.local.get({ futnor_active_account: null }, (data) => {
    if (data.futnor_active_account) {
      setActiveAccountEverywhere(data.futnor_active_account);
      console.log('[Futnor Dashboard Bridge] Active account loaded:', dashboardActiveAccount);
    } else {
      // No mirror yet — push the SW to detect now instead of waiting for the next IG tab event.
      // Critical for users who installed the extension AFTER opening Instagram.
      requestActiveAccountDetection('initial-empty-mirror');
      // Keep retrying every 8s until we get something, capped at ~80s of dashboard uptime.
      let retries = 0;
      const retryInterval = setInterval(() => {
        retries++;
        if (dashboardActiveAccount || retries > 10) {
          clearInterval(retryInterval);
          return;
        }
        requestActiveAccountDetection(`retry-${retries}`);
      }, 8000);
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.futnor_active_account) {
      const previousAccount = dashboardActiveAccount;
      const newAccount = changes.futnor_active_account.newValue || null;
      setActiveAccountEverywhere(newAccount);
      console.log('[Futnor Dashboard Bridge] Active account updated:', dashboardActiveAccount);

      if (previousAccount !== dashboardActiveAccount) {
        writeBridgeStatus({ connected: false });
        syncDurableHistory().finally(() => syncFromExtension());
      }
    }
  });
} catch {}
const DURABLE_BACKUP_KEY = 'futnor_extension_durable_backup';
const COMMAND_LOCK_KEY = 'futnor_command_lock';
const BRIDGE_INSTANCE_ID = `bridge_${Math.random().toString(36).slice(2, 10)}`;
const RECENT_COMMAND_TTL_MS = 10000;
const handledCommands = new Set();

function getExtensionVersion() {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getManifest) {
      return chrome.runtime.getManifest().version || null;
    }
  } catch {}
  return null;
}

function writeBridgeStatus(overrides = {}) {
  try {
    const raw = localStorage.getItem(EXT_STATUS_KEY);
    const current = raw ? JSON.parse(raw) : {};
    const extensionVersion = getExtensionVersion();
    localStorage.setItem(EXT_STATUS_KEY, JSON.stringify({
      ...current,
      bridgeConnected: true,
      ...(extensionVersion ? { extensionVersion } : {}),
      ...overrides,
      timestamp: Date.now(),
    }));
  } catch {}
}

function dedupeEntries(values, normalizer) {
  const out = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizer(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function readDurableBackup() {
  try {
    const dmKey = getDMHistoryKey();
    const paKey = getProcessedAccountsKey();
    const sessionKey = getSessionStateKey();
    const raw = localStorage.getItem(DURABLE_BACKUP_KEY);
    if (!raw) {
      return {
        [dmKey]: [],
        [paKey]: [],
        [sessionKey]: null,
      };
    }

    const parsed = JSON.parse(raw);
    return {
      [dmKey]: Array.isArray(parsed?.[dmKey]) ? parsed[dmKey] : [],
      [paKey]: Array.isArray(parsed?.[paKey]) ? parsed[paKey] : [],
      [sessionKey]: parsed?.[sessionKey] || null,
    };
  } catch {
    const dmKey = getDMHistoryKey();
    const paKey = getProcessedAccountsKey();
    const sessionKey = getSessionStateKey();
    return {
      [dmKey]: [],
      [paKey]: [],
      [sessionKey]: null,
    };
  }
}

function writeDurableBackup(data) {
  try {
    const dmKey = getDMHistoryKey();
    const paKey = getProcessedAccountsKey();
    const sessionKey = getSessionStateKey();
    const existingRaw = localStorage.getItem(DURABLE_BACKUP_KEY);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};

    localStorage.setItem(DURABLE_BACKUP_KEY, JSON.stringify({
      ...existing,
      [dmKey]: dedupeEntries(data?.[dmKey], normalizeDMHistoryEntry),
      [paKey]: dedupeEntries(data?.[paKey], normalizeAccountEntry),
      [sessionKey]: data?.[sessionKey] || null,
      updatedAt: Date.now(),
    }));
  } catch {}
}

function syncDurableHistory() {
  return new Promise((resolve) => {
    try {
      const dmKey = getDMHistoryKey();
      const paKey = getProcessedAccountsKey();
      const sessionKey = getSessionStateKey();
      const backup = readDurableBackup();

      chrome.storage.local.get({
        [dmKey]: [],
        [paKey]: [],
        [sessionKey]: null,
      }, (extData) => {
        const mergedDMHistory = dedupeEntries(
          [...(extData?.[dmKey] || []), ...(backup?.[dmKey] || [])],
          normalizeDMHistoryEntry
        );

        const mergedProcessedAccounts = dedupeEntries(
          [...(extData?.[paKey] || []), ...(backup?.[paKey] || [])],
          normalizeAccountEntry
        );

        const mergedSession = extData?.[sessionKey] || backup?.[sessionKey] || null;

        const payload = {
          [dmKey]: mergedDMHistory,
          [paKey]: mergedProcessedAccounts,
        };

        if (mergedSession) {
          payload[sessionKey] = mergedSession;
        }

        chrome.storage.local.set(payload, () => {
          writeDurableBackup({
            [dmKey]: mergedDMHistory,
            [paKey]: mergedProcessedAccounts,
            [sessionKey]: mergedSession,
          });
          resolve(payload);
        });
      });
    } catch (err) {
      console.error('[Futnor Dashboard Bridge] syncDurableHistory error:', err);
      resolve(null);
    }
  });
}

// ─── Dashboard → Extension: sync config ───
function syncToExtension() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    chrome.storage.local.set({ futnor_sync: data });
  } catch {}
}

// ─── Dashboard → Extension: sync tier ───
function syncTier() {
  try {
    const tier = localStorage.getItem('futnor_subscription_tier');
    console.log('[Futnor Dashboard Bridge] Syncing tier:', tier);
    if (tier) {
      chrome.storage.local.set({ subscriptionTier: tier }, () => {
        console.log('[Futnor Dashboard Bridge] Tier synced to extension storage:', tier);
      });
    }

    const authStorageKey = Object.keys(localStorage).find(
      (key) => key.startsWith('sb-') && key.endsWith('-auth-token')
    );

    if (!authStorageKey) {
      console.warn('[Futnor Dashboard Bridge] No auth storage key found for extension auth sync');
      return;
    }

    try {
      const authRaw = localStorage.getItem(authStorageKey);
      const auth = authRaw ? JSON.parse(authRaw) : null;
      const projectRef = authStorageKey.replace('sb-', '').replace('-auth-token', '');
      const supabaseUrl = projectRef
        ? `https://${projectRef}.supabase.co`
        : (window.location.origin.includes('localhost')
          ? 'http://localhost:54321'
          : (localStorage.getItem('futnor_supabase_url') || ''));

      let anonKey = localStorage.getItem('futnor_supabase_anon_key') || '';
      if (!anonKey) {
        try {
          const metaEl = document.querySelector('meta[name="supabase-anon-key"]');
          if (metaEl) anonKey = metaEl.getAttribute('content') || '';
        } catch {}
      }

      const payload = {
        futnor_supabase_url: supabaseUrl,
        futnor_supabase_anon_key: anonKey,
      };

      if (auth?.user?.id) {
        payload.futnor_user_id = auth.user.id;
      }

      if (auth?.access_token) {
        payload.futnor_supabase_token = auth.access_token;
      }

      chrome.storage.local.set(payload, () => {
        console.log('[Futnor Dashboard Bridge] Auth synced:', {
          hasUserId: !!payload.futnor_user_id,
          hasAccessToken: !!payload.futnor_supabase_token,
          hasAnonKey: !!payload.futnor_supabase_anon_key,
          supabaseUrl,
        });
      });
    } catch (error) {
      console.error('[Futnor Dashboard Bridge] Failed to sync auth token for extension:', error);
    }
  } catch (err) {
    console.error('[Futnor Dashboard Bridge] syncTier error:', err);
  }
}

function getCommandFingerprint(cmd) {
  const timestamp = Number(cmd?.timestamp) || 0;
  return `${cmd?.type || 'unknown'}:${cmd?.platform || 'unknown'}:${timestamp}`;
}

function markCommandHandled(fingerprint) {
  if (!fingerprint) return;
  handledCommands.add(fingerprint);
  window.setTimeout(() => handledCommands.delete(fingerprint), RECENT_COMMAND_TTL_MS);
}

function claimCommandLock(cmd) {
  const fingerprint = getCommandFingerprint(cmd);
  if (!fingerprint) return false;
  if (handledCommands.has(fingerprint)) return false;

  const now = Date.now();

  try {
    const raw = localStorage.getItem(COMMAND_LOCK_KEY);
    if (raw) {
      const existing = JSON.parse(raw);
      const lockIsFresh = now - Number(existing?.claimedAt || 0) < RECENT_COMMAND_TTL_MS;
      if (existing?.fingerprint === fingerprint && lockIsFresh) {
        if (existing.instanceId === BRIDGE_INSTANCE_ID) {
          markCommandHandled(fingerprint);
          return true;
        }
        return false;
      }
    }

    const nextLock = {
      fingerprint,
      instanceId: BRIDGE_INSTANCE_ID,
      claimedAt: now,
    };

    localStorage.setItem(COMMAND_LOCK_KEY, JSON.stringify(nextLock));
    const confirmed = JSON.parse(localStorage.getItem(COMMAND_LOCK_KEY) || 'null');
    const isOwner = confirmed?.fingerprint === fingerprint && confirmed?.instanceId === BRIDGE_INSTANCE_ID;

    if (isOwner) {
      markCommandHandled(fingerprint);
    }

    return isOwner;
  } catch {
    markCommandHandled(fingerprint);
    return true;
  }
}

function writeCommandResponse(cmd, response, sourceLabel) {
  console.log(`[Futnor Dashboard Bridge] ${sourceLabel} response:`, response);
  try {
    localStorage.setItem(COMMAND_KEY + '_response', JSON.stringify({
      ...(response || {}),
      type: cmd.type,
      timestamp: Date.now(),
    }));
  } catch {}
}

function waitMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function sendRuntimeMessageWithRetry(message, options = {}) {
  const {
    maxAttempts = 4,
    initialDelayMs = 200,
    label = message?.type || 'runtime-message',
  } = options;

  return new Promise((resolve) => {
    let attempt = 0;
    let delayMs = initialDelayMs;
    let lastErrorMessage = '';

    const trySend = () => {
      attempt += 1;

      try {
        chrome.runtime.sendMessage(message, async (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (!runtimeError && response) {
            resolve({ response, error: null });
            return;
          }

          lastErrorMessage = runtimeError?.message || 'No response from extension background worker';
          const canRetry = attempt < maxAttempts;

          if (!canRetry) {
            resolve({ response: null, error: lastErrorMessage });
            return;
          }

          console.warn(
            `[Futnor Dashboard Bridge] ${label} attempt ${attempt}/${maxAttempts} failed:`,
            lastErrorMessage,
          );
          const currentDelay = delayMs;
          delayMs *= 2;
          await waitMs(currentDelay);
          trySend();
        });
      } catch (error) {
        lastErrorMessage = error?.message || String(error);
        if (attempt >= maxAttempts) {
          resolve({ response: null, error: lastErrorMessage });
          return;
        }

        console.warn(
          `[Futnor Dashboard Bridge] ${label} attempt ${attempt}/${maxAttempts} threw:`,
          lastErrorMessage,
        );
        const currentDelay = delayMs;
        delayMs *= 2;
        waitMs(currentDelay).then(trySend);
      }
    };

    trySend();
  });
}

async function forwardCommandToBackground(cmd, sourceLabel, syncStatusAfter = false) {
  const isSessionStart = cmd?.type === 'START_SESSION';

  if (isSessionStart) {
    await sendRuntimeMessageWithRetry(
      { type: 'PING' },
      { maxAttempts: 3, initialDelayMs: 150, label: 'preflight PING' },
    );
  }

  const { response, error } = await sendRuntimeMessageWithRetry(cmd, {
    maxAttempts: isSessionStart ? 4 : 3,
    initialDelayMs: isSessionStart ? 250 : 150,
    label: `${sourceLabel}:${cmd?.type || 'unknown'}`,
  });

  if (error) {
    console.error(`[Futnor Dashboard Bridge] ${sourceLabel} error:`, error);
    writeCommandResponse(cmd, {
      status: 'start_failed',
      reason: 'extension_error',
      message: error,
    }, sourceLabel);
    return;
  }

  writeCommandResponse(cmd, response, sourceLabel);

  if (syncStatusAfter) {
    syncFromExtension();
  }
}

// ─── Dashboard → Extension: handle commands (start/stop/pause/resume) ───
function processCommands() {
  try {
    const raw = localStorage.getItem(COMMAND_KEY);
    if (!raw) return;

    let cmd;
    try {
      cmd = JSON.parse(raw);
    } catch (parseErr) {
      console.warn('[Futnor Dashboard Bridge] processCommands: invalid JSON in', COMMAND_KEY, '— clearing');
      localStorage.removeItem(COMMAND_KEY);
      return;
    }

    if (!cmd || typeof cmd !== 'object') {
      console.warn('[Futnor Dashboard Bridge] processCommands: cmd not an object, dropping:', cmd);
      return;
    }
    if (!cmd.type) {
      console.warn('[Futnor Dashboard Bridge] processCommands: cmd is missing "type" field — payload:', cmd);
      return;
    }

    // A fresh command (timestamp within last 10s) should always be forwarded,
    // even if some other frame already flipped `processed: true`. This covers
    // two real cases that were dropping clicks silently:
    //   1. Another `all_frames` instance of this script flipped processed:true
    //      before sendRuntimeMessage actually fired (race in the storage event
    //      path), so the BG never receives START_SESSION.
    //   2. The dashboard React app writes the command already-marked
    //      processed:true (carrying over a stale flag from a previous payload).
    // claimCommandLock still protects against duplicate forwarding to the BG.
    const tsNum = Number(cmd.timestamp) || 0;
    const ageMs = tsNum > 0 ? Date.now() - tsNum : Infinity;
    const isFresh = ageMs >= 0 && ageMs < RECENT_COMMAND_TTL_MS;

    if (cmd.processed && !isFresh) {
      // v2.4.157: this used to return with no log at all. When a command was
      // dropped here the console showed "Command received via storage event"
      // followed by nothing whatsoever, which made a broken sender impossible
      // to diagnose from outside — exactly what happened with the warm-up
      // button, whose payload carried `ts` instead of `timestamp` and so always
      // computed as infinitely old. A missing timestamp is a sender bug, not a
      // stale command, so name it.
      if (!tsNum) {
        console.warn(
          '[Futnor Dashboard Bridge] Dropping command with no usable "timestamp":',
          cmd.type,
          '— sender must include timestamp: Date.now() (see useBotSession.ts). Payload keys:',
          Object.keys(cmd).join(', '),
        );
      } else {
        console.log('[Futnor Dashboard Bridge] Skipping stale processed command:', cmd.type, `(${ageMs}ms old)`);
      }
      return;
    }
    if (cmd.processed && isFresh) {
      console.log('[Futnor Dashboard Bridge] Reclaiming fresh command marked processed (age',
        ageMs, 'ms):', cmd.type);
    }

    if (!claimCommandLock(cmd)) {
      console.log('[Futnor Dashboard Bridge] Skipping duplicate command from polling:', cmd.type);
      return;
    }

    console.log('[Futnor Dashboard Bridge] Processing command:', cmd.type, 'age:', ageMs, 'ms');
    try {
      localStorage.setItem(COMMAND_KEY, JSON.stringify({ ...cmd, processed: true }));
    } catch {}

    const forwardCommand = () => {
      void forwardCommandToBackground(cmd, 'Command');
    };

    if (cmd.type === 'START_SESSION') {
      syncDurableHistory().finally(forwardCommand);
      return;
    }

    forwardCommand();
  } catch (err) {
    console.error('[Futnor Dashboard Bridge] processCommands error:', err);
  }
}

// ─── Extension → Dashboard: sync real session state back ───
// Debounce: require this many consecutive GET_STATE failures before writing
// connected:false to localStorage.  A single failed poll (e.g. caused by a
// brief service worker wake/sleep cycle) no longer flashes "Disconnected" in
// the UI.  With SYNC_INTERVAL=1500ms, threshold=3 means ~4.5 s of true silence
// before the badge changes — well above the ~200ms port-reconnect delay we
// set in content.js, but short enough to detect a genuinely missing extension.
let _syncFailCount = 0;
const SYNC_FAIL_THRESHOLD = 3;

function syncFromExtension() {
  try {
    void sendRuntimeMessageWithRetry(
      { type: 'GET_STATE' },
      { maxAttempts: 2, initialDelayMs: 150, label: 'GET_STATE' },
    ).then(({ response: state, error }) => {
      if (error || !state) {
        _syncFailCount++;
        if (_syncFailCount >= SYNC_FAIL_THRESHOLD) {
          console.warn('[Futnor Dashboard Bridge] GET_STATE failed', _syncFailCount, 'times — background unavailable, keeping bridge detected');
          writeBridgeStatus({ connected: false });
        }
        return;
      }

      _syncFailCount = 0;
      writeBridgeStatus({
        connected: true,
        isRunning: state.isRunning,
        isPaused: state.isPaused || false,
        reconnecting: state.reconnecting || false,
        platform: state.platform,
        tier: state.tier,
        stats: state.stats,
        logs: (state.logs || []).slice(0, 20),
        warmup: state.warmup || null,
        warmupOffer: state.warmupOffer || false,
      });
    });

    // Also sync sales agent status
    chrome.storage.local.get('futnor_sales_agent_status', (result) => {
      if (result?.futnor_sales_agent_status) {
        try {
          localStorage.setItem('futnor_sales_agent_status', JSON.stringify(result.futnor_sales_agent_status));
        } catch {}
      }
    });

    // Mirror Instagram block events + rolling DM timestamps so the dashboard's
    // AccountHealthScore can react to real risk signals (and not show 85% the
    // moment after IG flagged the account).
    chrome.storage.local.get(['futnor_last_block', 'futnor_dm_timestamps', 'futnor_warmup_sessions'], (result) => {
      try {
        if (result?.futnor_last_block) {
          localStorage.setItem('futnor_last_block', JSON.stringify(result.futnor_last_block));
        } else {
          localStorage.removeItem('futnor_last_block');
        }
        if (Array.isArray(result?.futnor_dm_timestamps)) {
          localStorage.setItem('futnor_dm_timestamps', JSON.stringify(result.futnor_dm_timestamps));
        }
        // v2.4.150: timestamped warm-up ledger written by the extension when a
        // warm-up session finishes. AccountHealthScore reads this instead of the
        // old `futnor_warmup_count_7d_<account>` counter, which never expired
        // and was incremented twice for a single session — so an account that
        // warmed up once scored as "warmed" forever after.
        if (Array.isArray(result?.futnor_warmup_sessions)) {
          localStorage.setItem('futnor_warmup_sessions', JSON.stringify(result.futnor_warmup_sessions));
        }
      } catch {}
    });
  } catch {
    _syncFailCount++;
    if (_syncFailCount >= SYNC_FAIL_THRESHOLD) {
      writeBridgeStatus({ connected: false });
    }
  }
}

async function pingBackground() {
  const { response } = await sendRuntimeMessageWithRetry(
    { type: 'PING' },
    { maxAttempts: 3, initialDelayMs: 150, label: 'PING' },
  );
  return response || null;
}

async function confirmExtensionConnection(pingId) {
  const response = await pingBackground();
  const connected = response?.status === 'connected';

  writeBridgeStatus({ connected });

  if (connected) {
    // A successful PING means the extension is alive — reset the fail counter
    _syncFailCount = 0;
    syncFromExtension();
    if (pingId) {
      window.postMessage({ source: 'futnor-extension', type: 'PONG', pingId }, '*');
    }
  }

  return connected;
}

// ─── Run all syncs ───
console.log('[Futnor Dashboard Bridge] Initializing...');
// Don't reset connected to false on init — preserve previous status so the UI
// doesn't flash "disconnected" before confirmExtensionConnection() resolves.
writeBridgeStatus({});
syncToExtension();
syncTier();
syncFromExtension();
processCommands();
syncDurableHistory();

confirmExtensionConnection();

setInterval(() => {
  confirmExtensionConnection();
  syncToExtension();
  syncTier();
  syncFromExtension();
  processCommands();
}, SYNC_INTERVAL);

// Less frequent durable backup sync to survive extension reinstalls/updates
setInterval(() => {
  syncDurableHistory();
}, 8000);

// Listen for storage events (commands from web app in OTHER tabs)
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    console.log('[Futnor Dashboard Bridge] Storage changed:', STORAGE_KEY);
    syncToExtension();
  }
  if (e.key === COMMAND_KEY) {
    console.log('[Futnor Dashboard Bridge] Command received via storage event');
    processCommands();
  }
});

// Listen for postMessage from the web app (INSTANT command delivery, same tab)
window.addEventListener('message', (event) => {
  // Respond to PING from web app (legacy)
  if (event.data?.source === 'futnor-web' && event.data?.command?.type === 'PING_EXTENSION') {
    confirmExtensionConnection();
    return;
  }

  // Respond to active PING with PONG (new handshake)
  if (event.data?.source === 'futnor-web' && event.data?.type === 'PING') {
    console.log('[Futnor Dashboard Bridge] PING received, confirming background connection');
    confirmExtensionConnection(event.data.pingId);
    return;
  }

  // Sales agent commands via postMessage
  if (event.data?.source === 'futnor-web' && event.data?.salesAgent) {
    const cmd = event.data.salesAgent;
    console.log('[Futnor Dashboard Bridge] Sales agent command via postMessage:', cmd.type);
    forwardCommandToBackground(cmd, 'salesAgent postMessage', true);
    return;
  }

  if (event.data?.source === 'futnor-web' && event.data?.command) {
    console.log('[Futnor Dashboard Bridge] Command received via postMessage:', event.data.command.type);
    const cmd = event.data.command;
    if (!cmd || !cmd.type || cmd.processed) return;

    if (!claimCommandLock(cmd)) {
      console.log('[Futnor Dashboard Bridge] Skipping duplicate command from postMessage:', cmd.type);
      return;
    }

    try {
      localStorage.setItem(COMMAND_KEY, JSON.stringify({ ...cmd, processed: true }));
    } catch {}

    const forwardCommand = () => forwardCommandToBackground(cmd, 'postMessage command', true);

    if (cmd.type === 'START_SESSION') {
      syncDurableHistory().finally(forwardCommand);
      return;
    }

    forwardCommand();
  }
});

console.log('[Futnor Dashboard Bridge] Loaded — extension ↔ web app sync active (with postMessage)');
