// Content script — runs on instagram.com, performs actual DOM interactions
// Designed to mimic human behavior patterns to minimize detection

// ─── CRITICAL: Register PING handler IMMEDIATELY so background can detect us ───
// This MUST be at the very top, before any other code that might fail
if (!window.__futnorPingRegistered) {
  window.__futnorPingRegistered = true;
  chrome.runtime.onMessage.addListener(function __futnorEarlyPing(msg, sender, sendResponse) {
    if (msg.type === 'PING') {
      sendResponse({ ready: true });
      return true;
    }
  });
  console.log('[Futnor Instagram] Early PING handler registered ✓');
  // Proactively notify background that we're ready
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', platform: 'instagram' });
  } catch {}
}

// ─── MV3 Background Keepalive Port ─────────────────────────────────────────
// Maintaining an open chrome.runtime.Port is the most reliable way to prevent
// the MV3 service worker from being terminated while the Instagram tab is open.
// Without this, the dashboard sees the extension as "disconnected" every ~30s.
if (!window.__futnorKeepalivePortActive) {
  window.__futnorKeepalivePortActive = true;
  let _keepalivePort = null;
  let _keepalivePingInterval = null;

  function _connectKeepalivePort() {
    try {
      _keepalivePort = chrome.runtime.connect({ name: 'futnor-keepalive' });

      _keepalivePort.onDisconnect.addListener(() => {
        _keepalivePort = null;
        clearInterval(_keepalivePingInterval);
        _keepalivePingInterval = null;
        // Reconnect fast — gap must be shorter than the dashboard's 1500ms sync cycle
        // so the website never sees a "disconnected" flash during normal SW restarts.
        setTimeout(_connectKeepalivePort, 200);
      });

      // Send a ping every 15 seconds to keep the port (and worker) alive
      _keepalivePingInterval = setInterval(() => {
        if (_keepalivePort) {
          try { _keepalivePort.postMessage({ type: 'KEEPALIVE_PING' }); } catch {}
        }
      }, 15000);

      console.log('[Futnor Instagram] Background keepalive port connected ✓');
    } catch (e) {
      // Background not ready yet — retry quickly so we reconnect within one sync cycle
      setTimeout(_connectKeepalivePort, 500);
    }
  }

  _connectKeepalivePort();
}

// Guard against duplicate injection — if the script has already been loaded,
// throw to abort the entire re-evaluation.  Without this, `const` / `let`
// declarations crash with "Identifier … has already been declared" because
// Chrome re-executes the whole file in the same global scope.
if (window.__futnorContentLoaded) {
  console.log('[Futnor Instagram] Content script already loaded, aborting duplicate injection');
  throw new Error('[Futnor] Duplicate content script injection blocked');
}
window.__futnorContentLoaded = true;

// Global abort flag — set to true the moment the session is stopped or paused.
// sleep() checks this every 80ms so any in-progress operation exits almost immediately.
let botAborted = false;

// ─── Unthrottled timing via background service worker ────────────────────
// Chrome throttles setTimeout to 1000ms minimum on hidden/minimized tabs in
// document context, which destroys human-simulation delays (50-300ms become
// 1s each, making the bot crawl in background tabs).
//
// Primary path: chrome.runtime.sendMessage to the SW, which uses its own
//   setTimeout. SW timers are NOT subject to tab-visibility throttling, so
//   the bot runs at full speed in background/minimized tabs. This also
//   bypasses the host page's CSP (Instagram disallows worker-src blob:,
//   which silently broke the older Worker-based unthrottling).
// Safety fallback: if the SW reply doesn't arrive within ms + 3s (extension
//   reload, SW eviction race, message loss), resolve locally so sleep()
//   can never hang. The local timer is tab-throttled but always works.
//
// The Worker-probe code further down is left in place as a tested
// fallback but is no longer wired into the active sleep path.
function __futnorBgDelay(ms) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => { if (!resolved) { resolved = true; resolve(); } };
    // Safety net: if bg never replies (SW eviction race, message loss), fall
    // back locally after ms + 3s of slack so sleep() can never hang forever.
    const safety = setTimeout(finish, Math.max(0, ms) + 3000);
    try {
      chrome.runtime.sendMessage({ type: 'TIMER_REQUEST', ms }, () => {
        // chrome.runtime.lastError is set when the SW didn't reply (e.g.,
        // extension reloaded). Either way, just resolve — the safety net
        // already covers the local timing.
        void chrome.runtime.lastError;
        clearTimeout(safety);
        finish();
      });
    } catch {
      clearTimeout(safety);
      // sendMessage threw synchronously (extension context invalidated) —
      // fall through to local setTimeout to keep timing roughly correct.
      setTimeout(finish, ms);
    }
  });
}

let __futnorTimerWorker = null;
let __futnorTimerWorkerProbe = null; // Promise resolving to 'ready' | 'unavailable'
let __futnorTimerSeq = 0;
const __futnorTimerCallbacks = new Map();

// Probe-based worker setup. Instagram's CSP forbids worker-src blob:, but Chrome
// does NOT throw synchronously when the constructor is blocked — the Worker
// object is returned, postMessage succeeds, and the worker silently never runs.
// Without a probe, the very first sleep() would hang forever and the bot would
// stall the instant any action (like extractCommenters) tried to wait.
function __futnorProbeTimerWorker() {
  if (__futnorTimerWorkerProbe) return __futnorTimerWorkerProbe;
  __futnorTimerWorkerProbe = new Promise((resolve) => {
    let worker = null;
    try {
      const workerCode = `
        const timers = new Map();
        self.onmessage = function(e) {
          const { id, ms, cancel, ping } = e.data || {};
          if (ping) { self.postMessage({ ping: true }); return; }
          if (cancel) { const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); } return; }
          const t = setTimeout(() => { timers.delete(id); self.postMessage({ id }); }, ms);
          timers.set(id, t);
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch (err) {
      console.warn('[Futnor] Worker constructor threw, falling back to setTimeout:', err);
      __futnorTimerWorker = null;
      resolve('unavailable');
      return;
    }

    let settled = false;
    const finalize = (state) => {
      if (settled) return;
      settled = true;
      if (state === 'ready') {
        __futnorTimerWorker = worker;
        worker.onmessage = (e) => {
          if (!e.data || e.data.ping) return;
          const cb = __futnorTimerCallbacks.get(e.data.id);
          if (cb) { __futnorTimerCallbacks.delete(e.data.id); cb(); }
        };
        worker.onerror = null;
        console.log('[Futnor] Timer worker ready');
      } else {
        __futnorTimerWorker = null;
        try { worker.terminate(); } catch {}
        console.warn('[Futnor] Timer worker unavailable (likely CSP-blocked), falling back to setTimeout');
      }
      resolve(state);
    };

    worker.onmessage = (e) => {
      if (e.data && e.data.ping) finalize('ready');
    };
    worker.onerror = () => finalize('unavailable');

    try { worker.postMessage({ ping: true }); }
    catch { finalize('unavailable'); return; }

    // CSP-blocked workers never reply — bail out after 1s and use setTimeout.
    setTimeout(() => finalize('unavailable'), 1000);
  });
  return __futnorTimerWorkerProbe;
}

function __futnorWorkerDelay(ms) {
  // Prefer background-routed timing — no tab-visibility throttling, no host
  // CSP issues. The bg path has its own safety fallback to local setTimeout
  // if the service worker is unreachable, so this is always safe to await.
  return __futnorBgDelay(ms);
}

function sleep(ms) {
  if (botAborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const end = Date.now() + ms;
    function tick() {
      if (botAborted || Date.now() >= end) return resolve();
      __futnorWorkerDelay(Math.min(80, end - Date.now())).then(tick);
    }
    __futnorWorkerDelay(Math.min(80, ms)).then(tick);
  });
}

// ─── Background-safe scrolling ────────────────────────────────────────────
// Chrome freezes requestAnimationFrame on hidden tabs, which makes
// `behavior: 'smooth'` scrolls hang indefinitely (rAF never fires until the
// tab is visible again). We patch all scroll APIs to force instant scrolling
// whenever the document is hidden, while preserving smooth scrolling when
// the tab is visible (so the user's experience doesn't change).
(function installBackgroundSafeScroll() {
  if (window.__futnorScrollPatched) return;
  window.__futnorScrollPatched = true;

  const isHidden = () => document.visibilityState === 'hidden' || document.hidden;
  const sanitize = (opts) => {
    if (!opts || typeof opts !== 'object') return opts;
    if (isHidden() && opts.behavior === 'smooth') {
      return { ...opts, behavior: 'auto' };
    }
    return opts;
  };

  const winScrollTo = window.scrollTo.bind(window);
  const winScrollBy = window.scrollBy.bind(window);
  window.scrollTo = function (...args) {
    if (args.length === 1) return winScrollTo(sanitize(args[0]));
    return winScrollTo(...args);
  };
  window.scrollBy = function (...args) {
    if (args.length === 1) return winScrollBy(sanitize(args[0]));
    return winScrollBy(...args);
  };

  const origSIV = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (opts) {
    return origSIV.call(this, sanitize(opts) ?? opts);
  };

  const origElScrollTo = Element.prototype.scrollTo;
  const origElScrollBy = Element.prototype.scrollBy;
  if (origElScrollTo) {
    Element.prototype.scrollTo = function (...args) {
      if (args.length === 1) return origElScrollTo.call(this, sanitize(args[0]));
      return origElScrollTo.apply(this, args);
    };
  }
  if (origElScrollBy) {
    Element.prototype.scrollBy = function (...args) {
      if (args.length === 1) return origElScrollBy.call(this, sanitize(args[0]));
      return origElScrollBy.apply(this, args);
    };
  }
})();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── ACTIVITY LOG BRIDGE ───────────────────────────────────────────────────
// v2.4.150 FIX: three call sites in the DM send path used `logActivity?.(...)`
// on an identifier that was never declared anywhere in this file. Optional
// call syntax does NOT protect an *undeclared* binding — `logActivity?.()`
// throws "ReferenceError: logActivity is not defined" just like a plain call.
// Two of those sites sit on the send-retry path (_attemptSendOnly), so a DM
// that needed a second dispatch attempt blew up instead of retrying and the
// whole send was reported as failed.
//
// Declaring it for real removes the crash and keeps the diagnostics in the
// console where the send-path debugging already lives.
function logActivity(action, message) {
  try {
    console.log(`[Human Behavior Bot] 📝 ${action}: ${message}`);
  } catch {}
}

// Faster human-like delay — tighter range for speed
function humanDelay(baseMs) {
  const jitter = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.round(baseMs * (0.3 + jitter * 0.7));
}

const TRAVERSAL_STATE_KEY = 'futnor_ig_traversal_state';
const LOCATION_RESULTS_STATE_KEY = 'futnor_ig_location_results_state';
const DM_HISTORY_KEY_BASE = 'dm_history';
const PROCESSED_ACCOUNTS_KEY_BASE = 'processed_accounts_history';
let contentActiveAccount = null; // Set from chrome.storage.local.futnor_active_account

// Gate that resolves once contentActiveAccount has been loaded from storage.
// History functions await this so they never use the wrong (unscoped) key.
let _contentAccountReadyResolve;
const contentAccountReady = new Promise(resolve => { _contentAccountReadyResolve = resolve; });
const RESERVED_PROFILE_SEGMENTS = new Set([
  'accounts', 'about', 'explore', 'direct', 'reels', 'stories', 'p', 'reel', 'tv', 'tags', 'locations'
]);
let dmHistoryCache = new Set();
let processedAccountsCache = new Set();

function normalizeUsername(username) {
  const normalized = (username || '').toLowerCase().replace(/^@/, '').trim();
  return normalized || null;
}

function normalizeDMHistoryEntry(entry) {
  const raw = (entry || '').toString().toLowerCase().trim();
  if (!raw) return null;
  if (raw.startsWith('thread_')) return raw;
  return normalizeUsername(raw);
}

function normalizeOutgoingMessage(message) {
  if (!message) return '';

  // Only perform technical normalisations that are required for reliable typing:
  //   • CRLF → LF  (cross-platform line endings)
  //   • non-breaking space → regular space  (prevents invisible character issues)
  //   • trailing whitespace per line removed  (avoids invisible trailing spaces)
  // We deliberately do NOT collapse blank lines or trim the whole message —
  // the user's script must arrive exactly as saved in the dashboard.
  return message
    .toString()
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function normalizeComposerSnapshot(message) {
  return normalizeOutgoingMessage(message)
    .replace(/\u200B/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function composerTextMatchesExpected(actualText, expectedText) {
  const actual = normalizeComposerSnapshot(actualText);
  const expected = normalizeComposerSnapshot(expectedText);
  if (!actual || !expected) return false;
  // Primary: exact match after normalization
  if (actual === expected) return true;
  // Secondary: newline-tolerant match.
  // Lexical's innerText returns \n or \n\n for paragraph boundaries depending
  // on the page's CSS (full-page /direct/ vs widget dialog have different margins).
  // Collapsing all newline runs to \n lets us confirm text was entered correctly
  // without accepting partial scripts — every non-whitespace character must still match.
  const actualNL = actual.replace(/\n+/g, '\n');
  const expectedNL = expected.replace(/\n+/g, '\n');
  return actualNL === expectedNL;
}

async function waitForComposerTextStability(expectedText, contextNode = null, options = {}) {
  const {
    maxChecks = 8,
    requiredConsecutive = 3,
    delayMs = 140,
  } = options;

  let stablePasses = 0;

  for (let attempt = 0; attempt < maxChecks; attempt++) {
    const composer = getDMComposer() || (contextNode instanceof HTMLElement ? contextNode : null);
    if (!composer) return false;

    const composerText = normalizeOutgoingMessage(getComposerText(composer));
    if (composerTextMatchesExpected(composerText, expectedText)) {
      stablePasses += 1;
      if (stablePasses >= requiredConsecutive) return true;
    } else {
      stablePasses = 0;
    }

    await sleep(delayMs);
  }

  return false;
}

const SEND_ATTEMPT_GUARD_TTL_MS = 20000;

function getSendAttemptStore() {
  if (!window.__futnorSendAttemptStore) {
    window.__futnorSendAttemptStore = {};
  }
  return window.__futnorSendAttemptStore;
}

function hashDMSendMessage(message) {
  const text = normalizeComposerSnapshot(message);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

function getActiveDMSendTargetKey() {
  const threadId = normalizeDMHistoryEntry(typeof extractCurrentThreadId === 'function' ? extractCurrentThreadId() : null);
  if (threadId) return threadId;

  const threadUser = normalizeDMHistoryEntry(typeof extractCurrentThreadUsername === 'function' ? extractCurrentThreadUsername() : null);
  if (threadUser) return threadUser;

  const directMatch = window.location.pathname.match(/\/direct\/t\/([^/?#]+)/i);
  if (directMatch?.[1]) return `thread_${directMatch[1]}`;

  const profileMatch = window.location.pathname.match(/^\/([a-z0-9._]+)\/?$/i);
  const profileUser = normalizeUsername(profileMatch?.[1] || '');
  if (profileUser && !RESERVED_PROFILE_SEGMENTS.has(profileUser)) return profileUser;

  return `path:${window.location.pathname || 'unknown'}`;
}

function claimDMSendAttempt(message) {
  const key = `${getActiveDMSendTargetKey()}::${hashDMSendMessage(message)}`;
  const store = getSendAttemptStore();
  const now = Date.now();
  const existing = store[key];

  if (existing && (now - existing.ts) < SEND_ATTEMPT_GUARD_TTL_MS) {
    return {
      claimed: false,
      key,
      ageMs: now - existing.ts,
    };
  }

  store[key] = { ts: now };
  setTimeout(() => {
    const latestStore = getSendAttemptStore();
    if (latestStore[key]?.ts === now) {
      delete latestStore[key];
    }
  }, SEND_ATTEMPT_GUARD_TTL_MS);

  return { claimed: true, key, ageMs: 0 };
}

function releaseDMSendAttempt(message) {
  const key = `${getActiveDMSendTargetKey()}::${hashDMSendMessage(message)}`;
  const store = getSendAttemptStore();
  delete store[key];
}

async function clearDMComposerContent(inputEl, reason = 'reset') {
  let liveEl = getDMComposer() || inputEl;
  if (!liveEl) return null;

  const clearWithCurrentNode = async () => {
    liveEl = getDMComposer() || liveEl;
    liveEl.focus?.({ preventScroll: true });
    await sleep(80);

    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {}

    if (liveEl.tagName === 'TEXTAREA' || liveEl.tagName === 'INPUT') {
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          liveEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(liveEl, '');
        else liveEl.value = '';
      } catch {
        liveEl.value = '';
      }
      liveEl.dispatchEvent(new Event('input', { bubbles: true }));
      liveEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      try {
        liveEl.textContent = '';
        if (typeof liveEl.replaceChildren === 'function') {
          liveEl.replaceChildren();
        } else {
          liveEl.innerHTML = '';
        }
      } catch {}

      liveEl.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'deleteContentBackward',
        data: null,
      }));
      liveEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(150);
    return liveEl;
  };

  let clearedNode = await clearWithCurrentNode();
  let clearedText = normalizeComposerSnapshot(getComposerText(clearedNode));

  if (clearedText.length > 0) {
    console.log(`[Human Behavior Bot] Composer still had ${clearedText.length} chars after ${reason} clear — retrying hard reset`);
    clearedNode = getDMComposer() || clearedNode;
    try {
      clearedNode.innerHTML = '';
      clearedNode.textContent = '';
      clearedNode.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'deleteContentBackward',
        data: null,
      }));
    } catch {}
    await sleep(150);
    clearedText = normalizeComposerSnapshot(getComposerText(clearedNode));
  }

  console.log(`[Human Behavior Bot] Composer clear (${reason}) → ${clearedText.length === 0 ? 'empty' : `${clearedText.length} chars remain`}`);
  return getDMComposer() || clearedNode;
}

function stripNamePlaceholderPreservingLayout(template) {
  return normalizeOutgoingMessage(
    (template || '')
      .replace(/\s*\{name\}\s*/gi, ' ')
      .replace(/\s+,/g, ',')
      .replace(/\(\s+\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t]+/gm, '')
  );
}

function deriveNameFromUsername(usernameHint = '') {
  const normalized = normalizeUsername(usernameHint || extractCurrentThreadUsername() || '');
  if (!normalized || normalized.startsWith('thread_')) return '';

  // Split on separators (._-) and pick the first non-numeric part ≥2 chars.
  // This works for "john.doe" → "John", "futnor_marketing" → "Futnor".
  const parts = normalized.split(/[._-]+/);
  const goodParts = parts
    .map((part) => part.replace(/\d+/g, '').trim())
    .filter((part) => part.length >= 2);

  // GUARD (v2.4.125): if there are no separators AND the whole handle is
  // a long mashed-together word like "journalwithace", DON'T return
  // "Journalwithace" — that's worse than the generic "there" fallback.
  // The personalize helper will skip and use "there" instead. We can't
  // reliably extract "Ace" from "journalwithace" without NLP, and the
  // profile-page display-name path should be where we get the real name.
  if (goodParts.length === 1 && goodParts[0] === normalized && normalized.length > 8) {
    return '';
  }

  const raw = goodParts[0] || normalized;
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// ── Profile display-name cache ───────────────────────────────────────────────
// Captured from the profile page BEFORE we click Message and navigate away.
// On /direct/inbox/ or /direct/t/ the profile DOM is gone, so live extraction
// falls through to the thread header (which often only has the @handle). The
// cache lets us preserve the real display name we saw on the profile.
const profileDisplayNameCache = new Map();
function rememberProfileDisplayName(usernameHint, name) {
  const key = (usernameHint || '').toLowerCase().trim();
  const value = (name || '').trim();
  if (!key || !value) return;
  profileDisplayNameCache.set(key, value);
  // Cap the cache so it can't grow unbounded over a long session
  if (profileDisplayNameCache.size > 500) {
    const firstKey = profileDisplayNameCache.keys().next().value;
    if (firstKey) profileDisplayNameCache.delete(firstKey);
  }
}
function recallProfileDisplayName(usernameHint) {
  const key = (usernameHint || '').toLowerCase().trim();
  if (!key) return '';
  const cached = profileDisplayNameCache.get(key) || '';
  // v2.4.136: reject cached numeric values. A prior session may have
  // cached "1,887" (the follower count) before the v2.4.132 fix
  // landed; we don't want that to keep leaking through.
  if (cached && !/[a-z]/i.test(cached)) {
    profileDisplayNameCache.delete(key);
    return '';
  }
  return cached;
}

// v2.4.138: extract the right name VARIANT from a display-name text.
// Personal names ("John Smith") → first word ("John") feels natural.
// Business names ("The Good Mood Foods") → first word ("The") is wrong;
// use the full name. We detect "business-ness" by:
//   • Leading article (The/A/An/My/Our/Your/Mr/Mrs/Ms/Dr) → business-ish
//   • Word matching common business suffix (Inc/LLC/Co./Foods/Shop/etc)
//   • 3+ words total (most personal names are 1-2 words)
function pickDisplayNameVariant(text) {
  const cleaned = (text || '').trim();
  if (!cleaned) return '';
  const words = cleaned.split(/\s+/).map((w) => w.replace(/[,;.!?:]+$/, '').trim()).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];

  const ARTICLES = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'mr', 'mrs', 'ms', 'dr']);

  // A two-word display name is treated as a person ("John Smith" -> "John")
  // unless one word marks it as a business, in which case the whole name is
  // kept ("SUCU Lashes" -> "SUCU Lashes"). Greeting a salon by half its name
  // reads worse than greeting a person by their full one.
  //
  // v2.4.152: the original list covered generic commerce words but none of the
  // beauty/service trades this bot actually targets, so "SUCU Lashes" went out
  // as "Hey SUCU" and "Bella Nails" as "Hey Bella".
  //
  // Entries are deliberately restricted to words that are NOT also common
  // surnames. "bakery" is in; "baker" is not. Likewise no taylor/mason/cook/
  // fisher/barber — greeting "John Baker" as "John Baker" would be a
  // regression, and the singular trade words are exactly the risky ones.
  const BUSINESS_WORDS = new Set([
    // generic commerce
    'inc', 'llc', 'ltd', 'co', 'company', 'corp', 'corporation',
    'foods', 'food', 'shop', 'studio', 'studios', 'media', 'agency', 'brand', 'brands',
    'official', 'app', 'club', 'team', 'group', 'gear', 'wear', 'apparel',
    'fitness', 'wellness', 'beauty', 'cosmetics', 'collective', 'designs',
    'boutique', 'store', 'market', 'supplies', 'supply', 'solutions',
    'consulting', 'academy', 'training', 'events', 'decor', 'interiors',
    'photography', 'films', 'digital', 'rentals', 'properties', 'realty',
    'logistics', 'motors', 'autos', 'cleaning',
    // beauty & personal care — the core niche
    'lashes', 'lash', 'nails', 'brows', 'skincare', 'skin', 'aesthetics',
    'salon', 'salons', 'spa', 'hair', 'braids', 'locs', 'wigs', 'extensions',
    'makeup', 'mua', 'waxing', 'tanning', 'massage', 'therapy', 'clinic',
    'barbershop', 'barbers', 'nailbar', 'glam',
    // fitness & health
    'gym', 'pilates', 'yoga', 'nutrition', 'coaching',
    // food & drink
    'bakery', 'bakes', 'catering', 'kitchen', 'cafe', 'coffee', 'eats',
    'grill', 'deli', 'juice', 'restaurant',
  ]);

  const firstLower = words[0].toLowerCase();
  if (ARTICLES.has(firstLower)) return words.slice(0, 5).join(' ');

  for (const w of words) {
    if (BUSINESS_WORDS.has(w.toLowerCase())) return words.slice(0, 5).join(' ');
  }

  if (words.length >= 3) return words.slice(0, 5).join(' ');

  // 2-word personal name → first word
  return words[0];
}

// Auto-space a DM for readability: inserts a blank line after every 3 consecutive
// non-blank lines so longer scripts don't arrive as a wall of text.
// Respects spacing the user already added — only inserts where there isn't one yet.
function applyDMLineSpacing(message) {
  if (!message) return message;
  const lines = message.split('\n');
  const result = [];
  let consecutiveNonBlank = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      result.push(lines[i]);
      consecutiveNonBlank = 0;
    } else {
      result.push(lines[i]);
      consecutiveNonBlank++;

      if (consecutiveNonBlank >= 3) {
        // Only insert a blank line if the next line exists AND is not already blank
        const next = lines[i + 1];
        if (next !== undefined && next.trim() !== '') {
          result.push('');
        }
        consecutiveNonBlank = 0;
      }
    }
  }

  // Drop any trailing blank lines left behind
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }

  return result.join('\n');
}

function collapseFragileGreetingLine(message) {
  const normalized = normalizeOutgoingMessage(message);
  const lines = normalized.split('\n');
  if (lines.length < 2) return normalized;

  const [firstLine, secondLine, ...rest] = lines;
  const first = firstLine.trim();
  const second = secondLine.trim();

  if (!first || !second) return normalized;

  const looksLikeShortGreeting = /^(hey|hi|hello|hola|yo|sup)\b/i.test(first)
    && first.split(/\s+/).filter(Boolean).length <= 5
    && first.length <= 40;

  if (!looksLikeShortGreeting) return normalized;

  console.log('[Human Behavior Bot] Collapsing short greeting line so personalization stays attached to the main script');
  return [`${first} ${second}`.replace(/\s+/g, ' ').trim(), ...rest].join('\n');
}

async function triggerTrustedSendButtonClick() {
  try {
    const mainWorldSend = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ success: false, error: 'timeout' }), 4000);
      chrome.runtime.sendMessage(
        { type: 'INJECT_DM_SEND_CLICK' },
        (response) => {
          clearTimeout(timeout);
          resolve(response || { success: false });
        }
      );
    });

    return mainWorldSend?.success === true;
  } catch (e) {
    console.log('[Human Behavior Bot] Main-world send button error:', e.message);
    return false;
  }
}

// Shared helper: personalise {name} placeholder.
// The message is sent EXACTLY as saved — no extra blank lines are inserted,
// no reformatting is applied.  Only {name} is replaced.
// Every code-path that sends a DM script should run the raw template through this.
function personalizeAndFormatDM(rawTemplate, usernameHint = '') {
  const template = normalizeOutgoingMessage(rawTemplate);
  if (!template) return '';

  const effectiveUsernameHint = normalizeUsername(usernameHint || extractCurrentThreadUsername() || '');
  const replacements = {};

  if (/\{username\}/i.test(template)) {
    if (!effectiveUsernameHint) {
      // Don't drop the entire DM — strip the token so the script still sends.
      console.log('[Human Behavior Bot] WARNING: DM personalization — no {username} value, removing token');
      replacements.username = '';
    } else {
      replacements.username = effectiveUsernameHint;
    }
  }

  if (/\{name\}/i.test(template)) {
    // Resolution order for {name}:
    //   1. Cached display name captured on the profile page (highest confidence —
    //      taken when we still had the profile DOM, before navigating to /direct/).
    //   2. Live extraction from the current page (DM thread header link/span on
    //      /direct/t/, or profile header if we never moved away).
    //   3. deriveNameFromUsername — title-cases the first non-numeric segment
    //      of the handle (e.g. john.doe.42 → "John", futnor_marketing →
    //      "Futnor"). This was previously omitted to avoid "bot is using my
    //      whole username" feel, but in practice users report "there" feels
    //      worse than a derived first name. The derivation is sensible for
    //      ~90% of handles. Skipped when the result is too short or looks
    //      like an internal ID (e.g. thread_*).
    //   4. Generic "there" final fallback.
    let firstName = recallProfileDisplayName(effectiveUsernameHint || '')
      || extractProfileDisplayName(effectiveUsernameHint || '');

    // v2.4.147 sanity check: even though every extraction path filters
    // against uiTexts, defend the final output against any UI word that
    // slipped through (e.g. "Link", "Bio", "View profile"). User reported
    // DMs starting with "Hey Link, just a quick note..." — never let that
    // happen again, no matter where the leak originates.
    const isBogusName = (candidate) => {
      if (!candidate) return true;
      const lower = candidate.toLowerCase().trim();
      if (lower.length < 2) return true;
      // Single-word UI controls
      const UI_BLOCKLIST = new Set([
        'link', 'links', 'bio', 'website', 'site', 'web',
        'view', 'see', 'visit', 'open', 'tag', 'tagged', 'tags',
        'subscribe', 'follow', 'message', 'home', 'inbox',
        'profile', 'account', 'menu', 'more', 'back', 'close',
        'about', 'feed', 'posts', 'reels', 'stories', 'highlights',
        'verified', 'official', 'translate', 'edit',
      ]);
      return UI_BLOCKLIST.has(lower);
    };

    if (isBogusName(firstName)) {
      if (firstName) {
        console.log(`[Human Behavior Bot] Rejected bogus name "${firstName}" — falling back`);
      }
      firstName = '';
    }

    if (!firstName && effectiveUsernameHint) {
      const derived = deriveNameFromUsername(effectiveUsernameHint);
      // Only use the derived name if it looks like a real first name —
      // at least 2 letters, no leading digit, not an empty/all-junk handle.
      if (derived && derived.length >= 2 && /^[A-Z][a-z]/.test(derived) && !isBogusName(derived)) {
        firstName = derived;
        console.log(`[Human Behavior Bot] Using derived first-name for {name}: "${firstName}" (from @${effectiveUsernameHint})`);
      }
    }

    if (!firstName) {
      console.log('[Human Behavior Bot] No usable name for {name} — using generic "there"');
      firstName = 'there';
    } else {
      console.log(`[Human Behavior Bot] Using display name for {name}: "${firstName}"`);
    }
    replacements.name = firstName;
  }

  let msg = template;
  if (replacements.username !== undefined) {
    if (replacements.username) {
      msg = msg.replace(/\{username\}/gi, replacements.username);
      console.log(`[Human Behavior Bot] Personalised DM — username: "${replacements.username}"`);
    } else {
      msg = msg.replace(/\{username\}[,\s]*/gi, '').trim();
      console.log('[Human Behavior Bot] Personalised DM — {username} removed (no value available)');
    }
  }
  if (replacements.name) {
    msg = msg.replace(/\{name\}/gi, replacements.name);
    console.log(`[Human Behavior Bot] Personalised DM — display name: "${replacements.name}"`);
  }

  const unresolvedTokens = msg.match(/\{[^}]+\}/g);
  if (unresolvedTokens?.length) {
    // Strip unresolved tokens instead of dropping the DM — the script still sends.
    console.log(`[Human Behavior Bot] WARNING: DM personalization — unresolved variables stripped: ${unresolvedTokens.join(', ')}`);
    msg = msg.replace(/\{[^}]+\}[,\s]*/g, '').trim();
  }

  return msg;
}

// Extract the profile's DISPLAY NAME (not username) from the header of the currently
// viewed profile page OR the DM thread header.  Returns just the first name (first word)
// for use in greetings, or an empty string if no display name can be identified.
function extractProfileDisplayName(pageUsername) {
  const normalizedUsername = (pageUsername || '').toLowerCase().trim();

  // Anything in this set will NEVER be returned as a display name.
  // Includes profile-page CTAs, DM-header navigation chrome (Back/Close/Menu/etc.),
  // and generic state words. Match is case-insensitive (lowercased before lookup).
  const uiTexts = new Set([
    // Profile actions
    'follow', 'following', 'requested', 'unfollow', 'message', 'edit profile',
    'share profile', 'send message', 'send a message', 'active now',
    'mute', 'block', 'report', 'restrict', 'you', 'online', 'typing',
    // DM thread header / navigation chrome — these are the source of bogus
    // display names like "Back" appearing in personalization output.
    'back', 'close', 'minimize', 'menu', 'more', 'options', 'option',
    'details', 'detail', 'info', 'information', 'settings', 'setting',
    'help', 'next', 'cancel', 'save', 'edit', 'delete', 'remove', 'leave',
    'search', 'notifications', 'notification', 'home', 'explore',
    'reels', 'reel', 'audio', 'video', 'call', 'phone',
    'conversation', 'thread', 'chat', 'chats', 'inbox',
    // Verification / account-status badges Instagram renders next to the handle
    'verified', 'official', 'professional account',
    // v2.4.147: link-in-bio / external-link UI chrome. User reported the bot
    // saying "Hey Link, just a quick note..." because IG renders link-in-bio
    // anchors with text/aria-label "Link" and the extraction picked it up.
    'link', 'links', 'external link', 'website', 'site', 'web',
    'bio', 'biography', 'about', 'about this account', 'view profile', 'see profile',
    'view all', 'see all', 'show more', 'show less', 'read more', 'translate',
    'tagged', 'tag', 'tags', 'subscribe', 'subscriber', 'subscribers',
    'feed', 'posts', 'post', 'stories', 'story', 'highlights', 'highlight',
    'create', 'new', 'add', 'profile', 'account', 'feeds', 'see translation',
    'open', 'visit', 'go to', 'switch',
  ]);

  // True if the span belongs to a UI control (button, svg-icon label, nav link
  // pointing to a different profile/page) rather than a content node that
  // carries the display name. Be PERMISSIVE on profile-internal anchors:
  // Instagram often wraps the display name in a self-link to the profile,
  // and we don't want a stray href shape (relative hash, missing slash) to
  // reject a perfectly valid name.
  const isInsideUIControl = (span) => {
    // Direct or ancestor is a button / role=button / menuitem / tab → never a display name
    if (span.closest('button, [role="button"], [role="menuitem"], [role="tab"]')) return true;
    // Inside an <svg> (icon labels) → never a display name
    if (span.closest('svg')) return true;
    // Anchor checks: only reject if we have STRONG evidence it's a nav link to
    // a different page. An anchor whose href parses to a different profile is
    // clearly not the display name. An anchor without a parseable username is
    // ambiguous (could be the self-link or an empty wrapper) — let the text
    // and aria-label filters decide instead of pre-rejecting.
    const anchor = span.closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      const parsed = parseInstagramUsernameFromHref(href);
      if (parsed && normalizedUsername && parsed !== normalizedUsername) return true;
    }
    // Element or any ancestor up to 3 levels declares an aria-label that names a control
    let node = span;
    for (let depth = 0; depth < 3 && node; depth++) {
      const aria = (node.getAttribute?.('aria-label') || '').toLowerCase();
      if (aria) {
        if (uiTexts.has(aria)) return true;
        // Cover labels like "Back to inbox", "Close chat", "More options"
        if (/^(back|close|minimize|menu|more|options|details|info|settings|help)\b/.test(aria)) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  };

  // Modern IG profile renders the display name DIRECTLY in <h1> (sometimes with
  // a child span, sometimes as plain text). The username is in <h2>. We scan
  // h1/h2 contents here in addition to the span walk below — the span walk
  // alone misses <h1>John Smith</h1> (no inner <span>) and used to skip
  // <h1><span>John Smith</span></h1> via the closest('h1') filter.
  const extractFirstNameFromHeading = (container) => {
    if (!container) return '';
    for (const heading of container.querySelectorAll('h1, h2')) {
      const text = (heading.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 60) continue;
      const lower = text.toLowerCase();
      if (uiTexts.has(lower)) continue;
      if (text.startsWith('@')) continue;
      // Skip the username — it's typically in <h2>
      if (normalizedUsername && lower === normalizedUsername) continue;
      if (/^\d[\d,.KkMm%]*$/.test(text)) continue;
      if (/[|\/\\]/.test(text)) continue;
      if (text.split(/\s+/).length > 4) continue;
      const firstWord = pickDisplayNameVariant(text);
      if (firstWord && uiTexts.has(firstWord.toLowerCase())) continue;
      if (firstWord && !/[a-z]/i.test(firstWord)) continue;
      if (firstWord && firstWord.length >= 2) {
        console.log(`[Human Behavior Bot] Display name from <${heading.tagName.toLowerCase()}>: "${firstWord}"`);
        return firstWord;
      }
    }
    return '';
  };

  const extractFirstNameFromSpans = (container) => {
    if (!container) return '';
    for (const span of container.querySelectorAll('span')) {
      const text = (span.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 60) continue;
      const lower = text.toLowerCase();

      if (uiTexts.has(lower)) continue;
      if (/^\d[\d,.KkMm%]*$/.test(text)) continue;
      if (text.includes('Active') || lower.includes(' ago')) continue;
      if (text.startsWith('@')) continue;
      if (normalizedUsername && lower === normalizedUsername) continue;
      // NOTE: we no longer reject `span.closest('h1, h2')` outright — modern IG
      // profiles render the DISPLAY NAME inside <h1>. We rely on the username
      // equality check above to skip the @handle in <h2> instead.
      if (/[|\/\\]/.test(text)) continue;
      if (text.split(/\s+/).length > 4) continue;
      // Reject spans that are part of UI controls (Back arrow, Close, More, etc.)
      if (isInsideUIControl(span)) continue;

      // v2.4.138: use pickDisplayNameVariant — returns full name for
      // businesses (e.g. "The Good Mood Foods"), first word for personal
      // (e.g. "John" from "John Smith").
      const firstWord = pickDisplayNameVariant(text);
      if (firstWord && uiTexts.has(firstWord.toLowerCase())) continue;
      if (firstWord && !/[a-z]/i.test(firstWord)) continue;
      if (firstWord && firstWord.length >= 2) return firstWord;
    }
    return '';
  };

  const extractFirstNameFromLinks = (container) => {
    if (!container) return '';
    for (const link of container.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      const parsedUsername = parseInstagramUsernameFromHref(href);
      if (!parsedUsername) continue;
      if (normalizedUsername && parsedUsername !== normalizedUsername) continue;

      const text = (link.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 60) continue;

      const lower = text.toLowerCase();
      if (uiTexts.has(lower)) continue;
      if (text.startsWith('@')) continue;
      if (lower === parsedUsername) continue;
      if (/[|/\\]/.test(text)) continue;
      if (text.split(/\s+/).length > 4) continue;

      const firstWord = pickDisplayNameVariant(text);
      if (firstWord && uiTexts.has(firstWord.toLowerCase())) continue;
      if (firstWord && !/[a-z]/i.test(firstWord)) continue;
      if (firstWord && firstWord.length >= 2) return firstWord;
    }
    return '';
  };

  // ── Path 0: document.title (most reliable, v2.4.114) ────────────────────
  // Instagram sets the tab title on every profile page to:
  //   "<DisplayName> (@<handle>) • Instagram photos and videos"
  // This is the single most reliable source of the display name —
  // it's populated by IG's SSR before any React hydration, doesn't
  // depend on DOM scraping, and survives every profile-layout
  // redesign. The previous header-scan was returning the derived
  // "Urs" from @urs.jstn because the user's real name "Justin"
  // wasn't being matched by any selector. Try the title FIRST.
  if (window.location.pathname.startsWith(`/${normalizedUsername || ''}/`)
      || window.location.pathname === `/${normalizedUsername || ''}`) {
    try {
      const title = (document.title || '').trim();
      // Match: <name> (@handle) ...   OR   <name> • (@handle) ...   OR   <name> ...
      // The handle anchor is the most specific — we only accept if the (@...)
      // matches our target username, so we can never pick up a different
      // page's title (e.g. notifications, explore).
      const re = new RegExp(`^\\s*([^•\\u2022(]+?)\\s*[•\\u2022]?\\s*\\(@${normalizedUsername.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&')}\\)`, 'i');
      const m = title.match(re);
      if (m && m[1]) {
        const raw = m[1].trim().replace(/[,;.!?:]+$/, '').trim();
        if (raw && raw.length >= 2 && raw.length <= 60 && !uiTexts.has(raw.toLowerCase())) {
          // v2.4.138: use pickDisplayNameVariant on the title text too.
          // For "The Good Mood Foods (@thegoodmoodfoods)" the regex
          // captures "The Good Mood Foods" and the variant picker
          // returns the full name — not just "The".
          const firstWord = pickDisplayNameVariant(raw);
          if (firstWord && firstWord.length >= 2 && !uiTexts.has(firstWord.toLowerCase())
              && /[a-z]/i.test(firstWord)) {
            console.log(`[Human Behavior Bot] Display name from document.title: "${firstWord}" (raw="${raw}")`);
            return firstWord;
          }
        }
      }
    } catch {}
  }

  // Path 1: Profile page header (works when on /@username page)
  // v2.4.125: scan multiple candidate roots — IG has shipped layouts
  // where the display name lives in <main> rather than <header section>,
  // and the old single-root scan missed it entirely. Try each in order
  // and return the first hit.
  const profileSearchRoots = [
    document.querySelector('header section'),
    document.querySelector('header'),
    document.querySelector('main header'),
    document.querySelector('main [role="main"]'),
    document.querySelector('main section'),
    document.querySelector('main'),
  ].filter((el) => el instanceof HTMLElement);

  for (const root of profileSearchRoots) {
    // 1a. Try the heading scan FIRST — modern IG profile renders the display
    //     name in <h1>, sometimes as plain text without an inner <span>.
    const headingName = extractFirstNameFromHeading(root);
    if (headingName) return headingName;
    // 1b. Fall through to scanning every <span> in the search root.
    const profileName = extractFirstNameFromSpans(root);
    if (profileName) return profileName;
    // 1c. Some profile bio layouts wrap the display name in <a href="/{username}/">.
    //     Try the link-text extractor too.
    const linkedProfileName = extractFirstNameFromLinks(root);
    if (linkedProfileName) {
      console.log(`[Human Behavior Bot] Display name from profile-self link: "${linkedProfileName}"`);
      return linkedProfileName;
    }
  }

  // Path 2: DM thread header (works when on /direct/t/... pages)
  // Instagram's DM thread shows the recipient's display name in the thread header
  // area — typically a clickable link with their name above or beside the composer.
  if (window.location.pathname.includes('/direct/')) {
    const threadRoot = getDMThreadRoot(getDMComposer());
    const threadHeaderCandidates = [
      threadRoot?.querySelector?.('header'),
      threadRoot?.querySelector?.('div[role="banner"]'),
      threadRoot?.querySelector?.('div[role="heading"]')?.parentElement,
      threadRoot?.firstElementChild,
      document.querySelector('[role="main"] header'),
    ].filter((node, index, arr) => node instanceof HTMLElement && arr.indexOf(node) === index);

    // Also search inside dialog overlays (chat widget / minichat)
    const dialogEl = document.querySelector('[role="dialog"]');
    if (dialogEl) {
      const dialogHeader = dialogEl.querySelector('header')
        || dialogEl.querySelector('div[role="banner"]')
        || dialogEl.querySelector('div[role="heading"]')?.parentElement
        || dialogEl.firstElementChild;
      if (dialogHeader instanceof HTMLElement && !threadHeaderCandidates.includes(dialogHeader)) {
        threadHeaderCandidates.push(dialogHeader);
      }
    }

    for (const headerNode of threadHeaderCandidates) {
      const linkedName = extractFirstNameFromLinks(headerNode);
      if (linkedName) {
        console.log(`[Human Behavior Bot] Extracted display name from DM thread header link: "${linkedName}"`);
        return linkedName;
      }

      const spanName = extractFirstNameFromSpans(headerNode);
      if (spanName) {
        console.log(`[Human Behavior Bot] Extracted display name from DM thread header span: "${spanName}"`);
        return spanName;
      }
    }
  }

  return ''; // No display name found — caller will strip {name} instead
}

function getThreadIdentifiers(threadEl) {
  if (!threadEl) return [];

  const identifiers = new Set();

  const threadHref = threadEl.getAttribute?.('href') || '';
  const threadMatch = threadHref.match(/\/direct\/t\/(\d+)/);
  if (threadMatch) {
    identifiers.add(`thread_${threadMatch[1]}`);
  }

  const hrefCandidates = [threadHref];
  const nestedLinks = threadEl.querySelectorAll?.('a[href]') || [];
  for (const link of nestedLinks) {
    const href = link.getAttribute('href');
    if (href) hrefCandidates.push(href);
  }

  for (const href of hrefCandidates) {
    const parsed = parseInstagramUsernameFromHref(href);
    if (parsed) identifiers.add(parsed);
  }

  const handleMatch = (threadEl.textContent || '').match(/@([a-z0-9._]{2,30})/i);
  if (handleMatch?.[1]) {
    const handle = normalizeUsername(handleMatch[1]);
    if (handle) identifiers.add(handle);
  }

  const nameEl = threadEl.querySelector?.('span[dir="auto"]') || threadEl.querySelector?.('span');
  const threadName = normalizeUsername(nameEl?.textContent || '');
  if (threadName && /^[a-z0-9._]{2,30}$/.test(threadName)) {
    identifiers.add(threadName);
  }

  return Array.from(identifiers);
}

function threadIsInDMHistory(threadEl) {
  return getThreadIdentifiers(threadEl).some((identifier) => isInDMHistory(identifier));
}

function parseInstagramUsernameFromHref(href) {
  try {
    if (!href || typeof href !== 'string') return null;

    let path = href;
    if (href.startsWith('http://') || href.startsWith('https://')) {
      path = new URL(href).pathname;
    }

    path = path.split('?')[0].split('#')[0];
    if (!path.startsWith('/')) return null;

    const cleanPath = path.replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!cleanPath || cleanPath.includes('/')) return null;
    if (RESERVED_PROFILE_SEGMENTS.has(cleanPath)) return null;
    if (!/^[a-z0-9._]+$/.test(cleanPath)) return null;

    return cleanPath;
  } catch {
    return null;
  }
}

// ─── NO-NAVIGATION USERNAME EXTRACTION HELPERS ──────────────────────────────

// Walk Instagram's React fiber tree from a DOM element to find the post owner
// username stored in component props/state — no page navigation required.
function extractUsernameFromReactFiber(el) {
  if (!el) return null;
  try {
    // React 16+ stores the fiber on the element under __reactFiber$xxx
    const fKey = Object.keys(el).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (!fKey) return null;

    let fiber = el[fKey];
    for (let depth = 0; fiber && depth < 50; depth++, fiber = fiber.return) {
      for (const pk of ['memoizedProps', 'pendingProps']) {
        const p = fiber[pk];
        if (!p || typeof p !== 'object') continue;
        // Try every shape Instagram has used across versions
        const candidates = [
          p?.media?.owner?.username,
          p?.media?.user?.username,
          p?.node?.owner?.username,
          p?.post?.owner?.username,
          p?.owner?.username,
          p?.item?.owner?.username,
          p?.item?.user?.username,
          p?.edge?.node?.owner?.username,
          p?.clip?.media?.owner?.username,
          p?.product?.owner?.username,
        ];
        for (const u of candidates) {
          if (u && typeof u === 'string') {
            const clean = u.toLowerCase().trim();
            if (clean && !RESERVED_PROFILE_SEGMENTS.has(clean) && /^[a-z0-9._]{1,30}$/.test(clean)) {
              return clean;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

// Walk up the DOM tree from el (up to maxAncestors levels) and try React fiber
// on each ancestor — the relevant component is often a parent of the <a>.
function extractUsernameFromReactFiberWithAncestors(el, maxAncestors = 8) {
  let node = el;
  for (let i = 0; node && i <= maxAncestors; i++, node = node.parentElement) {
    const u = extractUsernameFromReactFiber(node);
    if (u) return u;
  }
  return null;
}

// Try to extract a poster's username directly from a grid thumbnail element,
// WITHOUT opening the post.
// Tries: (A) React fiber in-memory data, (B) img alt text, (C) aria-label.
function extractUsernameFromThumbnail(postLinkEl) {
  if (!postLinkEl) return null;

  // Method A: React fiber — reads Instagram's in-memory post data, most reliable
  const fiberUsername = extractUsernameFromReactFiberWithAncestors(postLinkEl, 10);
  if (fiberUsername) return fiberUsername;

  // Method B: img alt "Photo by USERNAME on ..." or "Video by USERNAME on ..."
  const imgs = postLinkEl.querySelectorAll('img[alt]');
  for (const img of imgs) {
    const alt = img.getAttribute('alt') || '';
    const m = alt.match(/^(?:Photo|Video|Image|Clip)\s+by\s+([a-zA-Z0-9_.]{1,30})\b/i);
    if (m) {
      const candidate = m[1].toLowerCase();
      if (!RESERVED_PROFILE_SEGMENTS.has(candidate)) return candidate;
    }
  }

  // Method C: aria-label on the <a> or its children
  const allWithAria = [postLinkEl, ...postLinkEl.querySelectorAll('[aria-label]')];
  for (const el of allWithAria) {
    const aria = el.getAttribute('aria-label') || '';
    const m1 = aria.match(/(?:Photo|Video|Image|Clip)\s+by\s+([a-zA-Z0-9_.]{1,30})\b/i);
    if (m1) {
      const candidate = m1[1].toLowerCase();
      if (!RESERVED_PROFILE_SEGMENTS.has(candidate)) return candidate;
    }
    const m2 = aria.match(/^([a-zA-Z0-9_.]{2,30})'s\s+(?:photo|video|post)/i);
    if (m2) {
      const candidate = m2[1].toLowerCase();
      if (!RESERVED_PROFILE_SEGMENTS.has(candidate)) return candidate;
    }
  }

  return null;
}

// Try to extract all post owner usernames from Instagram's page-level JS state
// (window.__additionalData / window._sharedData) — returns an array, possibly empty.
function extractUsernamesFromInstagramPageState() {
  const results = [];
  const seen = new Set();
  function addUser(u) {
    if (!u || typeof u !== 'string') return;
    const clean = u.toLowerCase().trim();
    if (!clean || seen.has(clean) || RESERVED_PROFILE_SEGMENTS.has(clean)) return;
    if (!/^[a-z0-9._]{1,30}$/.test(clean)) return;
    seen.add(clean);
    results.push(clean);
  }
  function walkObj(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (Array.isArray(obj)) { obj.forEach(item => walkObj(item, depth + 1)); return; }
    // Username leaves we care about
    if (obj.username) addUser(obj.username);
    // Recurse into known containers
    for (const key of ['owner', 'user', 'media', 'node', 'item', 'edge', 'sections',
                       'layout_content', 'medias', 'recent', 'data', 'clips']) {
      if (obj[key]) walkObj(obj[key], depth + 1);
    }
    // Also recurse into arrays stored as values
    if (obj.edges && Array.isArray(obj.edges)) obj.edges.forEach(e => walkObj(e, depth + 1));
  }
  try {
    if (window.__additionalData) walkObj(window.__additionalData, 0);
  } catch {}
  try {
    if (window._sharedData) walkObj(window._sharedData, 0);
  } catch {}
  // Also look in script[type="application/json"] tags Instagram embeds
  try {
    document.querySelectorAll('script[type="application/json"]').forEach(s => {
      try { walkObj(JSON.parse(s.textContent || '{}'), 0); } catch {}
    });
  } catch {}
  return results;
}

function collectPostOwnerCandidates() {
  const owners = new Set();

  const addOwner = (value) => {
    if (!value || typeof value !== 'string') return;
    const normalized = value.toLowerCase().trim().replace(/^@+/, '');
    if (!normalized || RESERVED_PROFILE_SEGMENTS.has(normalized)) return;
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) return;
    owners.add(normalized);
  };

  // Hard-stop safeguard: the logged-in Instagram account should always be treated
  // as the post owner/self account for engagement-monitor exclusion.
  addOwner(contentActiveAccount);

  const ownerLinkSelectors = [
    'article header a[href^="/"]',
    '[role="dialog"] article header a[href^="/"]',
    '[role="dialog"] header a[href^="/"]',
    'main article header a[href^="/"]',
  ];

  for (const selector of ownerLinkSelectors) {
    const links = document.querySelectorAll(selector);
    for (const link of links) {
      addOwner(parseInstagramUsernameFromHref(link.getAttribute('href') || ''));
    }
  }

  const article = document.querySelector('article');
  const fiberSources = [
    article,
    article?.querySelector('header'),
    article?.querySelector('img, video'),
    document.querySelector('[role="dialog"] article'),
    document.querySelector('[role="dialog"] article header'),
  ].filter(Boolean);

  for (const source of fiberSources) {
    addOwner(extractUsernameFromReactFiber(source));
  }

  const stateUsernames = extractUsernamesFromInstagramPageState();
  for (const username of stateUsernames) {
    addOwner(username);
  }

  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const pageTitle = document.title || '';

  addOwner(ogTitle.match(/^@?([a-z0-9._]{1,30})\s+on\s+instagram/i)?.[1] || '');
  addOwner(metaDescription.match(/-\s*([a-z0-9._]{1,30})\s+on\s+instagram:/i)?.[1] || '');
  addOwner(pageTitle.match(/^@?([a-z0-9._]{1,30})\s+on\s+instagram/i)?.[1] || '');

  return owners;
}

function getUsernamesFromNode(node) {
  if (!node?.querySelectorAll) return [];
  return Array.from(new Set(
    Array.from(node.querySelectorAll('a[href]'))
      .map((link) => parseInstagramUsernameFromHref(link.getAttribute('href') || ''))
      .filter(Boolean)
  ));
}

function isLikelyCommentNode(node) {
  if (!(node instanceof Element)) return false;
  if (node.closest('header, nav, footer')) return false;

  const text = (node.innerText || node.textContent || '').trim();
  if (!text || text.length > 400) return false;

  const lower = text.toLowerCase();
  return Boolean(
    node.querySelector('time') ||
    /\breply\b/.test(lower) ||
    /\bedited\b/.test(lower) ||
    /\b(?:now|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))\b/.test(lower)
  );
}

function getCommentContextNode(startNode, rootNode = null) {
  const root = rootNode instanceof Element ? rootNode : null;
  let node = startNode instanceof Element ? startNode : null;

  for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
    if (root && node === root && !isLikelyCommentNode(node)) break;
    if (isLikelyCommentNode(node)) return node;
    if (node === document.body) break;
  }

  return null;
}

function nodeContainsOwner(node, ownerCandidates) {
  if (!node || !(ownerCandidates instanceof Set) || ownerCandidates.size === 0) return false;
  const usernames = getUsernamesFromNode(node);
  return usernames.some((username) => ownerCandidates.has(username));
}

function getModalScrollableContainer(modal) {
  if (!modal) return null;

  const candidates = Array.from(modal.querySelectorAll('div, ul, section')).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const canScroll = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
      && el.scrollHeight > el.clientHeight + 20
      && el.clientHeight > 120;
    return canScroll;
  });

  candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  return candidates[0] || modal.querySelector('ul')?.parentElement || modal;
}

function loadTraversalState() {
  try {
    const raw = sessionStorage.getItem(TRAVERSAL_STATE_KEY);
    if (!raw) return { visitedAccounts: [], modalScrollOffset: 0 };

    const parsed = JSON.parse(raw);
    return {
      visitedAccounts: Array.isArray(parsed?.visitedAccounts) ? parsed.visitedAccounts : [],
      modalScrollOffset: Number.isFinite(parsed?.modalScrollOffset) ? Math.max(0, parsed.modalScrollOffset) : 0,
    };
  } catch {
    return { visitedAccounts: [], modalScrollOffset: 0 };
  }
}

function persistTraversalState() {
  try {
    sessionStorage.setItem(TRAVERSAL_STATE_KEY, JSON.stringify({
      visitedAccounts: Array.from(visitedAccountsThisSession),
      modalScrollOffset,
    }));
  } catch (e) {
    console.warn('[Futnor Instagram] persistTraversalState failed (storage full?):', e?.message || e);
  }
}

function setModalScrollOffset(nextOffset) {
  modalScrollOffset = Math.max(0, Math.floor(nextOffset || 0));
  persistTraversalState();
}

function hasVisitedAccount(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return false;
  // v2.4.121: removed isInProcessedAccounts(normalized) from the filter.
  // The processedAccounts list was accumulating EVERY clicked liker
  // (even ones we never sent a DM to) and persisted across sessions,
  // so after a few sessions ~95% of likers in a popular post's modal
  // were "visited", leaving the bot 1–2 fresh candidates buried mid-
  // list. User saw this as "randomly scrolling and picking up likers".
  //
  // The two remaining checks are sufficient:
  //   • visitedAccountsThisSession → in-session traversal dedup
  //   • isInDMHistory              → permanent record of accounts
  //                                  that ACTUALLY received a DM
  //
  // Old processedAccounts entries become dormant — still written by
  // some flows for compatibility but no longer block liker selection.
  return visitedAccountsThisSession.has(normalized)
    || isInDMHistory(normalized);
}

function markTraversalVisitedAccount(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  visitedAccountsThisSession.add(normalized);
  persistTraversalState();
  return normalized;
}

function markVisitedAccount(username) {
  const normalized = markTraversalVisitedAccount(username);
  if (!normalized) return;
  processedAccountsCache.add(normalized);
  addToProcessedAccounts(normalized).catch(() => {});
}

function resetTraversalState() {
  visitedAccountsThisSession.clear();
  setModalScrollOffset(0);
}

async function scrollModalForFreshAccounts(modal, options = {}) {
  const {
    stepsMin = 4,
    stepsMax = 8,
    jumpMin = 180,
    jumpMax = 420,
  } = options;

  const scrollContainer = getModalScrollableContainer(modal);
  if (!scrollContainer || scrollContainer === modal) return false;

  const before = scrollContainer.scrollTop;
  if (modalScrollOffset > 0) {
    scrollContainer.scrollTop = Math.max(scrollContainer.scrollTop, modalScrollOffset);
    await sleep(humanDelay(250));
  }

  const steps = randomInt(stepsMin, stepsMax);
  for (let i = 0; i < steps; i++) {
    scrollContainer.scrollTop += randomInt(jumpMin, jumpMax);
    await sleep(humanDelay(350));
  }

  const after = scrollContainer.scrollTop;
  setModalScrollOffset(after);
  return after > before + 30;
}

function getUnvisitedModalCandidates(modal) {
  const links = Array.from(modal.querySelectorAll('a[href]'));
  const deduped = [];
  const seen = new Set();
  // Belt-and-braces: filter the post owner here too so the legacy targeting
  // flow can never pick the owner from a likers/followers modal even if
  // upstream filters got bypassed.
  const ownerSet = collectPostOwnerCandidates();

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const username = parseInstagramUsernameFromHref(href);
    if (!username) continue;
    if (seen.has(username)) continue;
    seen.add(username);
    if (ownerSet.has(username)) continue;       // never DM the post owner
    if (!hasVisitedAccount(username)) {
      deduped.push({ link, username });
    }
  }

  return deduped;
}

// Simulate human mouse movement by dispatching mouseover events along a path
function simulateMousePath(targetEl) {
  const rect = targetEl.getBoundingClientRect();
  const endX = rect.left + rect.width / 2 + randomInt(-5, 5);
  const endY = rect.top + rect.height / 2 + randomInt(-5, 5);
  const startX = endX + randomInt(-200, 200);
  const startY = endY + randomInt(-100, 100);
  const steps = randomInt(4, 8);

  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    // Ease-in-out curve
    const ease = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const x = startX + (endX - startX) * ease;
    const y = startY + (endY - startY) * ease;
    targetEl.dispatchEvent(new MouseEvent('mousemove', {
      clientX: x, clientY: y, bubbles: true
    }));
  }
}

// Human-like click: hover → small pause → mousedown → mouseup → click
async function humanClick(element) {
  if (!element) return false;

  // v2.4.134: dispatch coordinates-bearing pointer + mouse events for the
  // full user-gesture sequence. Modern Instagram uses pointer events
  // alongside the mouse-event compatibility ones, and React's
  // SyntheticEvent system sometimes branches based on whether `detail`
  // and screenX/screenY are set on the click event. Without these, IG
  // can degrade the response (the likers popup returns only 2 cached
  // rows instead of the full lazy-paginated list).
  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2 + randomInt(-3, 3);
  const cy = rect.top + rect.height / 2 + randomInt(-3, 3);
  const screenX = window.screenX + cx;
  const screenY = window.screenY + cy;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1,
    clientX: cx,
    clientY: cy,
    screenX,
    screenY,
  };

  simulateMousePath(element);
  await sleep(humanDelay(80));

  try { element.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerType: 'mouse', isPrimary: true })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mouseover', eventInit)); } catch {}
  try { element.dispatchEvent(new PointerEvent('pointerenter', { ...eventInit, pointerType: 'mouse', isPrimary: true })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mouseenter', eventInit)); } catch {}
  await sleep(humanDelay(50));

  try { element.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerType: 'mouse', isPrimary: true })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, detail: 1 })); } catch {}
  await sleep(randomInt(40, 90));
  try { element.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, buttons: 0, pointerType: 'mouse', isPrimary: true })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0, detail: 1 })); } catch {}

  // ── EXACTLY ONE click delivery, of the RIGHT KIND (v2.4.158) ─────────────
  // Originally this dispatched a synthetic MouseEvent('click') AND called
  // element.click(). Both reach React's delegated root listener, so every
  // "human click" fired onClick twice — like-then-unlike, follow-then-unfollow,
  // double-sent DMs. v2.4.150 cut it to one delivery and kept element.click().
  //
  // That was the wrong one to keep for Instagram's own controls. element.click()
  // synthesises a click with clientX/clientY = 0 and detail = 0. Instagram's
  // profile Message button reads the pointer coordinates, so it received a
  // click "at the top-left corner of the page", ignored it, and the DM panel
  // never opened — 20 seconds of waiting per target, then a pointless fall
  // through to the 3-dots menu.
  //
  // So: still exactly one click, but chosen to match the element.
  //   • Anchors, submit buttons, inputs, labels, selects need the browser's
  //     DEFAULT ACTION (navigation, form submit), which only element.click()
  //     performs.
  //   • Everything else on Instagram is a div/span/[role=button] wired to a
  //     React handler, which wants a real event carrying the coordinates the
  //     preceding pointerdown/mouseup already used.
  const tag = (element.tagName || '').toUpperCase();
  const needsBrowserDefaultAction =
    (tag === 'A' && element.hasAttribute('href'))
    || (tag === 'BUTTON' && (element.type === 'submit' || element.form))
    || tag === 'INPUT'
    || tag === 'LABEL'
    || tag === 'SELECT'
    || tag === 'OPTION';

  if (needsBrowserDefaultAction) {
    let nativeWorked = false;
    try { element.click(); nativeWorked = true; } catch {}
    if (!nativeWorked) {
      try { element.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0, detail: 1 })); } catch {}
    }
  } else {
    let dispatched = false;
    try {
      dispatched = element.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0, detail: 1 }));
      dispatched = true;
    } catch {}
    if (!dispatched) {
      try { element.click(); } catch {}
    }
  }

  return true;
}

// ─── SCROLL ────────────────────────────────────────────────
// Smooth, variable-speed scrolling like a real person reading content
async function performScroll() {
  const totalScroll = randomInt(200, 700);
  const steps = randomInt(3, 8);
  const stepAmount = totalScroll / steps;

  for (let i = 0; i < steps; i++) {
    const variation = stepAmount * (0.6 + Math.random() * 0.8);
    window.scrollBy({ top: variation, behavior: 'smooth' });
    await sleep(humanDelay(300));
  }

  // Sometimes pause mid-scroll like reading a post
  if (Math.random() < 0.4) {
    await sleep(randomInt(1500, 4000));
  }

  // Occasionally scroll back up slightly (like re-reading)
  if (Math.random() < 0.15) {
    window.scrollBy({ top: -randomInt(50, 150), behavior: 'smooth' });
    await sleep(humanDelay(800));
  }

  return true;
}

// ─── LIKE ──────────────────────────────────────────────────
async function performLike() {
  const likeButtons = document.querySelectorAll('svg[aria-label="Like"]');
  if (likeButtons.length === 0) return false;

  const visibleButtons = Array.from(likeButtons).filter(btn => {
    const rect = btn.getBoundingClientRect();
    return rect.top >= 50 && rect.top <= window.innerHeight - 50;
  });

  if (visibleButtons.length === 0) return false;

  const target = visibleButtons[randomInt(0, visibleButtons.length - 1)];
  const clickable = target.closest('button') || target.parentElement;

  // Scroll the post into better view first (human behavior)
  const postArticle = clickable?.closest('article');
  if (postArticle) {
    postArticle.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(600));
  }

  // Small chance of reading comments before liking
  if (Math.random() < 0.3) {
    await scrollThroughComments(postArticle);
  }

  return await humanClick(clickable);
}

// ─── FOLLOW ────────────────────────────────────────────────
async function performFollow() {
  const buttons = document.querySelectorAll('button');
  const followButtons = Array.from(buttons).filter(btn => {
    const text = btn.textContent?.trim();
    return text === 'Follow' && !btn.disabled;
  });

  if (followButtons.length === 0) return false;

  const target = followButtons[randomInt(0, followButtons.length - 1)];

  // Scroll to the follow button area first
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(500));

  return await humanClick(target);
}

// ─── COMMENT BROWSING ──────────────────────────────────────
// Scrolls through comments section like a human reading them
async function scrollThroughComments(postArticle) {
  if (!postArticle) return;

  // Look for "View all X comments" link
  const viewAllLink = postArticle.querySelector('a[href*="/p/"] span, a[href*="/reel/"] span');
  const viewCommentsBtn = Array.from(postArticle.querySelectorAll('span')).find(
    s => s.textContent?.match(/View all \d+ comments/i)
  );

  if (viewCommentsBtn) {
    const link = viewCommentsBtn.closest('a') || viewCommentsBtn.closest('button');
    if (link) {
      await humanClick(link);
      await sleep(humanDelay(1200));

      // Scroll through comments in the modal/expanded view
      const commentScrollArea = document.querySelector('ul[class*="comment"], div[class*="comment"]')
        || document.querySelector('[role="dialog"] ul');

      if (commentScrollArea) {
        const scrollPasses = randomInt(2, 5);
        for (let i = 0; i < scrollPasses; i++) {
          commentScrollArea.scrollTop += randomInt(80, 200);
          await sleep(humanDelay(800)); // reading time
        }

        // Sometimes scroll back up
        if (Math.random() < 0.3) {
          commentScrollArea.scrollTop -= randomInt(40, 100);
          await sleep(humanDelay(500));
        }
      }

      await sleep(randomInt(1000, 3000)); // dwell time on comments
    }
  }
}

// ─── SEND CUSTOM TEXT MESSAGE ──────────────────────────────
// Instagram uses Lexical editor — only clipboard paste reliably updates internal state
// ─── INSTAGRAM DM API (primary send path) ──────────────────────────────────
// When we are on a /direct/t/{thread_id}/ page the content script can call
// Instagram's own DM API directly.  This completely bypasses the Lexical
// contenteditable editor and the isTrusted event security gate that blocks
// every synthetic-event approach from a Chrome extension content script.

// Extract thread ID from URL OR from DOM (handles split-view inbox where URL
// stays at /direct/inbox/ even though a thread is visibly open on the right).
function extractThreadIdAnywhere() {
  // 1. From URL (most reliable)
  const urlMatch = window.location.pathname.match(/\/direct\/t\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  // 2. From any aria-selected / aria-current thread link in the left inbox panel
  for (const link of document.querySelectorAll('a[href*="/direct/t/"]')) {
    const href = link.getAttribute('href') || '';
    const m = href.match(/\/direct\/t\/(\d+)/);
    if (!m) continue;
    // An active thread link is typically aria-selected or inside an aria-selected container
    if (
      link.getAttribute('aria-selected') === 'true' ||
      link.getAttribute('aria-current') === 'page' ||
      link.closest('[aria-selected="true"]') ||
      link.closest('[aria-current="page"]') ||
      link.closest('[data-testid*="thread"][aria-selected]')
    ) {
      return m[1];
    }
  }

  // 3. From a DM dialog overlay (message-request popup on profile pages)
  for (const link of document.querySelectorAll('[role="dialog"] a[href*="/direct/t/"]')) {
    const m = (link.getAttribute('href') || '').match(/\/direct\/t\/(\d+)/);
    if (m) return m[1];
  }

  // 4. Last resort: first visible thread link whose bounding rect is in viewport
  for (const link of document.querySelectorAll('a[href*="/direct/t/"]')) {
    const rect = link.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight) {
      const m = (link.getAttribute('href') || '').match(/\/direct\/t\/(\d+)/);
      if (m) return m[1];
    }
  }

  return null;
}

// Multi-source CSRF token extraction: cookie → window._sharedData → meta tag
function extractCSRFToken() {
  // 1. From cookie (standard)
  const fromCookie = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('csrftoken='))
    ?.split('=')[1];
  if (fromCookie) return fromCookie;

  // 2. From Instagram's JS globals
  try {
    const fromShared = window._sharedData?.config?.csrf_token;
    if (fromShared) return fromShared;
  } catch {}
  try {
    const fromBootData = window.__additionalDataLoaded;
    if (fromBootData?.csrf_token) return fromBootData.csrf_token;
  } catch {}

  // 3. From meta tag
  const metaTag = document.querySelector('meta[name="csrf-token"]');
  if (metaTag?.content) return metaTag.content;

  return null;
}

// Extract the Instagram user ID for the currently viewed profile.
// Used when no thread ID is available (new conversation / message-request).
async function extractCurrentProfileUserId() {
  // 1. Instagram JS globals (SPA state)
  try {
    if (window.__additionalDataLoaded) {
      for (const data of Object.values(window.__additionalDataLoaded)) {
        const id = data?.graphql?.user?.id || data?.data?.user?.id;
        if (id) return id;
      }
    }
  } catch {}
  try {
    const id = window._sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user?.id;
    if (id) return id;
  } catch {}

  // 2. Fetch from Instagram's profile API — most reliable for logged-in users
  const usernameFromPath = window.location.pathname
    .replace(/\//g, '').trim().toLowerCase();
  if (usernameFromPath && !['direct', 'explore', 'stories', 'reels', 'p', 'reel'].includes(usernameFromPath)) {
    try {
      const resp = await fetch(
        `/api/v1/users/web_profile_info/?username=${usernameFromPath}`,
        {
          credentials: 'include',
          headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' },
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const id = data?.data?.user?.id;
        if (id) return id;
      }
    } catch {}
  }
  return null;
}

async function sendViaInstagramAPI(message) {
  try {
    const csrfToken = extractCSRFToken();
    if (!csrfToken) {
      console.log('[Human Behavior Bot] sendViaInstagramAPI: no CSRF token found');
      return false;
    }

    const IG_HEADERS = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': csrfToken,
      'X-IG-App-ID': '936619743392459',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Instagram-AJAX': '1',
      'X-Asbd-Id': '198387',
    };

    const clientContext = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
    const threadId = extractThreadIdAnywhere();

    // ── PATH A: Existing thread — POST to /api/v1/direct_v2/threads/{id}/items/ ─
    if (threadId) {
      console.log(`[Human Behavior Bot] API send → existing thread ${threadId}...`);
      const body = new URLSearchParams({
        item_type: 'text',
        text: message,
        client_context: clientContext,
        mutation_token: clientContext,
      });
      const resp = await fetch(`/api/v1/direct_v2/threads/${threadId}/items/`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...IG_HEADERS, 'Referer': `https://www.instagram.com/direct/t/${threadId}/` },
        body: body.toString(),
      });
      const responseText = await resp.text().catch(() => '');
      console.log(`[Human Behavior Bot] Thread API HTTP ${resp.status}: ${responseText.substring(0, 200)}`);
      if (resp.ok) {
        let data = null;
        try { data = JSON.parse(responseText); } catch {}
        // Require a positive confirmation — don't treat null/unparseable body as success
        const ok = data?.status === 'ok' || !!data?.item;
        console.log(`[Human Behavior Bot] Thread API → ${ok ? '✅ sent' : '❌ failed'} (status="${data?.status}")`);
        if (ok) return true;
      }
      // 400 = thread may be a message-request thread that needs accept first; fall through
      console.log('[Human Behavior Bot] Thread API failed — trying broadcast path...');
    } else {
      console.log('[Human Behavior Bot] No thread ID — trying broadcast (new conversation) path...');
    }

    // ── PATH B: New conversation — POST to /api/v1/direct_v2/threads/broadcast/text/ ─
    // Instagram requires the recipient's numeric user ID.  Extract it from the page.
    const userId = await extractCurrentProfileUserId();
    if (!userId) {
      console.log('[Human Behavior Bot] sendViaInstagramAPI: no user ID for broadcast path');
      return false;
    }

    console.log(`[Human Behavior Bot] API send → broadcast to user ${userId}...`);
    const broadcastBody = new URLSearchParams({
      item_type: 'text',
      text: message,
      client_context: clientContext,
      mutation_token: clientContext,
      recipient_users: JSON.stringify([[userId]]),
    });
    const broadcastResp = await fetch('/api/v1/direct_v2/threads/broadcast/text/', {
      method: 'POST',
      credentials: 'include',
      headers: { ...IG_HEADERS, 'Referer': 'https://www.instagram.com/direct/new/' },
      body: broadcastBody.toString(),
    });
    const broadcastText = await broadcastResp.text().catch(() => '');
    console.log(`[Human Behavior Bot] Broadcast API HTTP ${broadcastResp.status}: ${broadcastText.substring(0, 200)}`);
    if (broadcastResp.ok) {
      let bData = null;
      try { bData = JSON.parse(broadcastText); } catch {}
      // Require a positive confirmation — don't treat null/unparseable body as success
      const ok = bData?.status === 'ok' || !!bData?.threads || !!bData?.thread_id;
      console.log(`[Human Behavior Bot] Broadcast API → ${ok ? '✅ sent' : '❌ failed'} (status="${bData?.status}")`);
      return ok;
    }
    return false;
  } catch (e) {
    console.log('[Human Behavior Bot] sendViaInstagramAPI error:', e.message);
    return false;
  }
}

// ── Send-only helper: skips typing, just clicks Send / presses Enter ──────────
// Used when the composer already has the expected text (e.g. retry after failed send).
async function _attemptSendOnly(inputEl, normalizedMessage, beforeSnapshot, composerTextBeforeSend) {
  const isInDialog = !!inputEl.closest('[role="dialog"]');

  const confirmInThread = () => {
    const liveComposer = getDMComposer() || inputEl;
    const afterSnap = analyzeDMConversation(liveComposer);
    const prevCount = beforeSnapshot?.texts?.length || 0;
    if (afterSnap.texts.length > prevCount) return true;
    const normalizedNeedle = normalizeOutgoingMessage(normalizedMessage);
    const first10 = normalizedNeedle.substring(0, 10);
    if (normalizedNeedle.length > 0) {
      const matched = afterSnap.texts.some((t) => {
        const nt = normalizeOutgoingMessage(t);
        return nt && (nt.includes(normalizedNeedle) || normalizedNeedle.includes(nt) || (first10.length > 0 && nt.includes(first10)));
      });
      if (matched) return true;
    }
    return false;
  };

  const checkSent = async (label) => {
    await sleep(600);
    // PRIMARY: message appeared in the thread → confirmed sent, no matter
    // what the composer still shows. This is the authoritative signal and
    // prevents alternate-dispatch from firing a duplicate send.
    if (threadContainsExpectedMessage(normalizedMessage, getDMComposer() || inputEl)) {
      console.log(`[Human Behavior Bot] ✅ ${label}: message visible in thread — send confirmed`);
      return true;
    }
    const c0 = getDMComposer();
    if (!c0) { console.log(`[Human Behavior Bot] ✅ ${label}: composer gone — sent`); return true; }
    for (let w = 0; w < 10; w++) {
      // On every poll, also check thread presence — the instant the message
      // appears in the thread we stop, regardless of composer state.
      if (threadContainsExpectedMessage(normalizedMessage, getDMComposer() || inputEl)) {
        console.log(`[Human Behavior Bot] ✅ ${label}: message visible in thread on poll ${w + 1} — send confirmed`);
        return true;
      }
      const c = getDMComposer();
      if (!c) { console.log(`[Human Behavior Bot] ✅ ${label}: composer gone — sent`); return true; }
      const cText = normalizeComposerSnapshot(getComposerText(c));
      if (cText === '') {
        console.log(`[Human Behavior Bot] ✅ ${label}: composer empty — send confirmed`);
        return true;
      }
      if (w === 0 || w === 4 || w === 9) {
        console.log(`[Human Behavior Bot] ⏳ ${label}: waiting for send confirm — composer still has ${cText.length} chars after ${600 + w * 500}ms (preview: "${cText.substring(0, 30)}")`);
      }
      await sleep(500);
    }
    console.log(`[Human Behavior Bot] ❌ ${label}: composer still has text after 5s — send not confirmed`);
    logActivity?.('send_debug', `send not confirmed after ${label} — composer retained ${normalizeComposerSnapshot(getComposerText(getDMComposer()) || '').length} chars`);
    return false;
  };

  const sendGuard = claimDMSendAttempt(normalizedMessage);
  if (!sendGuard.claimed) {
    console.log(`[Human Behavior Bot] Duplicate send-only dispatch blocked (${sendGuard.key}, ${sendGuard.ageMs}ms old)`);
    return await checkSent('guarded send-only wait');
  }

  const composerStillHasExpectedText = () => {
    const liveComposer = getDMComposer() || inputEl;
    if (!liveComposer) return false;
    // CRITICAL: if the script ALREADY appears in the thread, the first
    // dispatch worked and firing alternate dispatch would double-send.
    // Return false here so the alternate path is skipped.
    if (threadContainsExpectedMessage(normalizedMessage, liveComposer)) {
      console.log('[Human Behavior Bot] composerStillHasExpectedText: message already in thread — blocking alternate dispatch to prevent double-send');
      return false;
    }
    const liveText = normalizeOutgoingMessage(getComposerText(liveComposer));
    return composerTextMatchesExpected(liveText, normalizedMessage);
  };

  const dispatchMainWorldEnter = async () => {
    try {
      const enterInjected = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ success: false }), 4000);
        chrome.runtime.sendMessage({ type: 'INJECT_ENTER_KEY' }, (r) => {
          clearTimeout(timeout);
          resolve(r || { success: false });
        });
      });
      return enterInjected?.success ? 'send-only Enter' : '';
    } catch {
      return '';
    }
  };

  const dispatchSyntheticEnter = async () => {
    inputEl.focus();
    await sleep(100);
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'send-only synthetic Enter';
  };

  // Focus composer
  inputEl.focus({ preventScroll: true });
  await sleep(300);

  // Try Send button click
  const findSendBtn = () => {
    const container = inputEl.closest('[role="dialog"]') || inputEl.closest('form') || inputEl.parentElement?.parentElement?.parentElement || document;
    let foundVia = '';
    for (const svg of container.querySelectorAll('svg')) {
      const lbl = (svg.getAttribute('aria-label') || '').toLowerCase();
      if (lbl === 'send' || lbl.startsWith('send ') || lbl.includes('send message')) {
        const btn = svg.closest('[role="button"]') || svg.closest('button') || svg.parentElement;
        if (btn && btn.getBoundingClientRect().width > 0) {
          foundVia = `svg aria-label="${lbl}"`;
          console.log(`[Human Behavior Bot] 🔎 findSendBtn matched via ${foundVia}`);
          return btn;
        }
      }
    }
    for (const btn of container.querySelectorAll('button, [role="button"]')) {
      const txt = (btn.textContent?.trim() || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (txt === 'send' || aria === 'send' || txt.startsWith('send ') || aria.startsWith('send ')) {
        if (btn.getBoundingClientRect().width > 0) {
          foundVia = `button aria="${aria}" text="${txt}"`;
          console.log(`[Human Behavior Bot] 🔎 findSendBtn matched via ${foundVia}`);
          return btn;
        }
      }
    }
    console.log(`[Human Behavior Bot] 🔎 findSendBtn: NO match inside container (tag=${container.tagName || 'document'}, container has ${container.querySelectorAll ? container.querySelectorAll('button,[role="button"]').length : 0} buttons)`);
    return null;
  };

  let sendBtn = null;
  for (let i = 0; i < 8; i++) {
    sendBtn = findSendBtn();
    if (sendBtn) { if (i > 0) console.log(`[Human Behavior Bot] 🔎 send button appeared on poll ${i + 1}/8`); break; }
    await sleep(400);
  }
  if (!sendBtn) {
    console.log('[Human Behavior Bot] ⚠️ NO send button found after 8 polls (3.2s) — Lexical state may not be synced. Falling through to Enter-key.');
    logActivity?.('send_debug', `no send button visible after 3.2s — falling to Enter-key on ${isInDialog ? 'widget-dialog' : 'other'}`);
  }

  let dispatchLabel = '';

  if (sendBtn) {
    const trustedClickWorked = await triggerTrustedSendButtonClick();
    if (trustedClickWorked) {
      dispatchLabel = 'send-only main-world click';
    } else {
      await humanClick(sendBtn);
      dispatchLabel = 'send-only button click';
    }
  } else {
    if (await triggerTrustedSendButtonClick()) {
      dispatchLabel = 'send-only main-world click';
    } else {
      dispatchLabel = await dispatchMainWorldEnter();
    }
    if (!dispatchLabel) {
      dispatchLabel = await dispatchSyntheticEnter();
    }
  }

  if (dispatchLabel) {
    if (await checkSent(dispatchLabel)) return true;

    // If the exact text is still sitting in the composer, the first dispatch didn't send.
    // Try one alternate send-only dispatch so text entry doesn't stall without sending.
    if (composerStillHasExpectedText()) {
      console.log(`[Human Behavior Bot] ${dispatchLabel} did not send — trying one alternate send-only dispatch`);
      const alternateLabel = dispatchLabel.includes('button')
        ? (await dispatchMainWorldEnter()) || (await dispatchSyntheticEnter())
        : await (async () => {
            const altBtn = findSendBtn();
            if (altBtn) {
              if (await triggerTrustedSendButtonClick()) {
                return 'send-only alternate main-world click';
              }
              await humanClick(altBtn);
              return 'send-only alternate button click';
            }
            return '';
          })();

      if (alternateLabel && await checkSent(alternateLabel)) return true;
    }
  }

  // ── Final fallback: re-focus composer, find send button fresh, and try once more ──
  console.log('[Human Behavior Bot] _attemptSendOnly: primary methods failed — trying final fallback...');
  try {
    const freshComposer = getDMComposer() || inputEl;
    freshComposer.focus({ preventScroll: true });
    await sleep(400);
    // Re-check composer still has text
    const freshText = normalizeOutgoingMessage(getComposerText(freshComposer));
    if (composerTextMatchesExpected(freshText, normalizedMessage)) {
      // Try trusted click one more time
      if (await triggerTrustedSendButtonClick()) {
        if (await checkSent('final-fallback trusted click')) return true;
      }
      const freshForm = freshComposer.closest('form');
      if (freshForm) {
        console.log('[Human Behavior Bot] _attemptSendOnly: trying form submit fallback');
        try {
          if (typeof freshForm.requestSubmit === 'function') {
            freshForm.requestSubmit();
          } else if (typeof freshForm.submit === 'function') {
            freshForm.submit();
          }
          if (await checkSent('final-fallback form submit')) return true;
        } catch (submitError) {
          console.log('[Human Behavior Bot] _attemptSendOnly form submit fallback error:', submitError.message);
        }
      }
      const refreshedSendBtn = findSendBtn();
      if (refreshedSendBtn) {
        console.log('[Human Behavior Bot] _attemptSendOnly: trying refreshed send button fallback');
        if (await triggerTrustedSendButtonClick()) {
          if (await checkSent('final-fallback refreshed trusted click')) return true;
        }
        await humanClick(refreshedSendBtn);
        if (await checkSent('final-fallback refreshed button click')) return true;
      }
      // Try Enter key as absolute last resort
      freshComposer.focus({ preventScroll: true });
      await sleep(200);
      freshComposer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      freshComposer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      if (await checkSent('final-fallback Enter')) return true;
    } else {
      console.log(`[Human Behavior Bot] _attemptSendOnly: composer text lost during fallback (${freshText.length} chars)`);
    }
  } catch (e) {
    console.log('[Human Behavior Bot] _attemptSendOnly final fallback error:', e.message);
  }
  console.log('[Human Behavior Bot] _attemptSendOnly: ALL send methods exhausted — giving up');
  return false;
}

async function sendCustomMessage(message, options = {}) {
  const {
    entryAttempt = 0,
    maxEntryAttempts = 2,
  } = (options && typeof options === 'object') ? options : {};
  const normalizedMessage = normalizeOutgoingMessage(message);
  if (!normalizedMessage) return false;

  console.log(
    `[Human Behavior Bot] Starting DM send process (text attempt ${entryAttempt + 1}/${maxEntryAttempts}) for:`,
    normalizedMessage.substring(0, 30) + '...'
  );

  const retryTextEntry = async (reason, composerOverride = null) => {
    console.log(`[Human Behavior Bot] ${reason} — text entry failed, giving up (no recursive retry)`);
    const staleEl = composerOverride || getDMComposer() || null;
    if (staleEl) await clearDMComposerContent(staleEl, 'retryTextEntry cleanup');
    return false;
  };

  // ── DUPLICATE GUARD: If composer already has our text, skip typing entirely ──
  // This prevents double-typing when sendCustomMessage is retried after a failed
  // send attempt (the first call types the text, the second call should only send).
  const preCheckComposer = getDMComposer();
  if (preCheckComposer) {
    const existingText = normalizeOutgoingMessage(getComposerText(preCheckComposer));
    const existingNorm = normalizeComposerSnapshot(existingText);
    const expectedNorm = normalizeComposerSnapshot(normalizedMessage);
    if (existingNorm.length > 0 && existingNorm === expectedNorm) {
      console.log('[Human Behavior Bot] ✅ Composer already has EXACT expected text — skipping typing, going straight to send');
      const inputEl = preCheckComposer;
      const beforeSnapshot = analyzeDMConversation(inputEl);
      const composerTextBeforeSend = normalizeComposerSnapshot(existingText);
      await sleep(800);
      return await _attemptSendOnly(inputEl, normalizedMessage, beforeSnapshot, composerTextBeforeSend);
    }
    // If composer has OTHER text (stale from a previous failed attempt), clear it
    if (normalizeComposerSnapshot(existingText).length > 0) {
      console.log('[Human Behavior Bot] Composer has stale text — clearing before typing');
      await clearDMComposerContent(preCheckComposer, 'pre-typing stale text');
    }
  }

  // ── API FAST PATH — DISABLED ────────────────────────────────────────────────
  // sendViaInstagramAPI() made direct POST requests to Instagram's internal
  // /api/v1/direct_v2/threads/broadcast/text/ and /threads/{id}/items/ endpoints.
  // Instagram's server-side bot detection identifies these calls as non-human
  // (normal browser users never POST to these URLs directly) and force-expires
  // the session immediately after allowing the message through — the user sees
  // "DM sent → logged out".  DOM-based sending is slower but does not trigger
  // session invalidation because it looks identical to a real human typing.
  // DO NOT re-enable without a proper session-safe proxy implementation.
  // const apiSent = await sendViaInstagramAPI(normalizedMessage);
  // if (apiSent) { console.log('[Human Behavior Bot] ✅ Message sent via API'); return true; }

  // Step 1: Find the message input (Lexical contenteditable)
  let inputEl = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    inputEl = getDMComposer();
    if (inputEl) {
      console.log(`[Human Behavior Bot] ✅ Message input found on attempt ${attempt + 1}/10`);
      break;
    }
    if (attempt < 3 || attempt % 3 === 0) {
      console.log(`[Human Behavior Bot] No message input found (attempt ${attempt + 1}/10), waiting...`);
    }
    // Longer delays for later attempts to allow widget initialization
    const delay = attempt < 4 ? 1500 + attempt * 500 : 2000 + (attempt - 4) * 600;
    await sleep(delay);
  }

  if (!inputEl) {
    console.log('[Human Behavior Bot] ❌ No message input found after 10 attempts (max ~17s total)');
    return false;
  }

  const isInDialog = !!inputEl.closest('[role="dialog"]');
  const isFullPageDirect = window.location.pathname.includes('/direct/') && !isInDialog;
  const widgetType = isInDialog ? 'dialog' : (isFullPageDirect ? 'direct-page' : 'floating/page');
  console.log('[Human Behavior Bot] Found input (' + widgetType + '):', inputEl.tagName,
    'role=' + inputEl.getAttribute('role'),
    'contenteditable=' + inputEl.getAttribute('contenteditable'));

  // Don't scrollIntoView for dialog overlays — it can reposition the dialog and break layout
  if (!isInDialog) {
    inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(250));
  }
  if (!isElementVisibleAndEnabled(inputEl)) {
    const rect = inputEl.getBoundingClientRect();
    console.log('[Human Behavior Bot] ❌ Message input is not visible/clickable (rect:',
      rect.width, 'x', rect.height, ')');
    return false;
  }

  // ── Step 2: Focus the input and establish a solid cursor position ────────────
  // For dialogs: focus the dialog container first (prevents focus-lock from blocking us),
  // then focus the editor itself. Skip humanClick on dialogs (fake mouse events don't help).
  if (isInDialog) {
    const dialogEl = inputEl.closest('[role="dialog"]');
    if (dialogEl && typeof dialogEl.focus === 'function') {
      dialogEl.focus({ preventScroll: true });
      await sleep(50);
    }
    inputEl.focus({ preventScroll: true });
    await sleep(150);
  } else {
    // For floating widgets and page composers: click, wait, then focus
    console.log('[Human Behavior Bot] Focusing composer...');
    await humanClick(inputEl);
    await sleep(300);
    inputEl.focus({ preventScroll: true });
    await sleep(200);
  }

  // Verify focus — if something else stole it, click again.
  // On /direct/t/ pages, activeElement may be a child node (e.g. <p>) inside the
  // Lexical editor, not the editor root itself. Check containment, not strict equality.
  const focusIsInsideComposer = document.activeElement === inputEl || inputEl.contains(document.activeElement);
  if (!focusIsInsideComposer) {
    console.log('[Human Behavior Bot] Focus stolen — re-clicking composer...');
    inputEl.click();
    await sleep(200);
    inputEl.focus({ preventScroll: true });
    await sleep(150);
  }

  // Helper: set selection inside inputEl, handling Lexical's <p><br/> placeholder
  // structure.  Standard selectNodeContents places the cursor OUTSIDE the <p>,
  // which makes execCommand fire at an invalid position and return false.
  const placeSelectionAtEnd = () => {
    try {
      const s = window.getSelection();
      const r = document.createRange();

      // Walk to the deepest last descendant to place the cursor at the true end
      let target = inputEl;
      while (target.lastChild) {
        target = target.lastChild;
        if (target.nodeType === Node.TEXT_NODE) break; // stop at text node
        if (target.nodeName === 'BR') {
          // Lexical placeholder: place cursor BEFORE the <br> so insertText
          // replaces the placeholder rather than appending after the element.
          r.setStartBefore(target);
          r.collapse(true);
          s.removeAllRanges();
          s.addRange(r);
          return;
        }
      }

      if (target.nodeType === Node.TEXT_NODE) {
        r.setStart(target, target.length);
        r.collapse(true);
      } else {
        r.selectNodeContents(inputEl);
        r.collapse(false);
      }
      s.removeAllRanges();
      s.addRange(r);
    } catch {}
  };
  const selectionIsInsideComposer = (composerEl) => {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      return composerEl.contains(selection.getRangeAt(0).commonAncestorContainer);
    } catch {
      return false;
    }
  };

  // Dispatch a full pointer event sequence to properly activate Lexical's event listeners.
  // Just calling .click() or humanClick() sometimes isn't enough because Lexical
  // registers on pointerdown/mousedown, not just click.
  const fullPointerActivate = async (el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    await sleep(30);
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(30);
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    await sleep(20);
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  const ensureComposerReady = async (label) => {
    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') return true;
    const attempts = isFullPageDirect ? 8 : 7;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const liveEl = getDMComposer() || inputEl;
      inputEl = liveEl;

      try {
        await fullPointerActivate(liveEl);
      } catch {}
      await sleep(isFullPageDirect ? 250 : 150);

      liveEl.focus({ preventScroll: true });
      // Also dispatch a focus event in case Lexical listens for it separately
      liveEl.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
      await sleep(isFullPageDirect ? 300 : 250);

      if (!selectionIsInsideComposer(liveEl)) {
        placeSelectionAtEnd();
        await sleep(120);
      }

      const activeInside = document.activeElement === liveEl || liveEl.contains(document.activeElement);
      if (activeInside && selectionIsInsideComposer(liveEl)) {
        console.log(`[Human Behavior Bot] ✅ Composer ready for ${label} on pass ${attempt + 1}/${attempts}`);
        return true;
      }
    }

    console.log(`[Human Behavior Bot] ⚠️ Composer caret not fully confirmed for ${label}`);
    return false;
  };
  // IMPORTANT: Do NOT call placeSelectionAtEnd() here. Lexical manages its own
  // selection state internally. Manipulating the DOM selection externally desyncs
  // Lexical's internal state and causes it to reject execCommand('insertText').
  // Let Lexical's focus handler set up the cursor position.
  await sleep(300); // Give Lexical time to sync its selection after focus
  await ensureComposerReady('initial text entry');
  inputEl = await stabilizeDMComposerForTyping(
    getDMComposer() || inputEl,
    `sendCustomMessage attempt ${entryAttempt + 1}`,
  ) || inputEl;

  let textEntered = false;

  const resetComposerAfterFailedEntry = async (label) => {
    const liveEl = getDMComposer() || inputEl;
    if (!liveEl) return;

    // Wait briefly for any in-flight mutation (e.g. a background injection
    // that timed out on our side but is still typing) to stop changing the DOM.
    // Without this, our clear races the ongoing typing and appears to "fail".
    {
      let prevLen = -1;
      let stable = 0;
      const settleStart = Date.now();
      while (Date.now() - settleStart < 3000) {
        const l = normalizeComposerSnapshot(getComposerText(getDMComposer() || liveEl)).length;
        if (l === prevLen) { stable++; if (stable >= 2) break; }
        else stable = 0;
        prevLen = l;
        await sleep(250);
      }
    }

    const currentText = normalizeComposerSnapshot(getComposerText(getDMComposer() || liveEl));
    if (!currentText) {
      inputEl = getDMComposer() || liveEl;
      return;
    }

    if (composerTextMatchesExpected(currentText, normalizedMessage)) {
      console.log(`[Human Behavior Bot] ${label}: composer already has expected text — marking as entered (preventing duplication)`);
      inputEl = getDMComposer() || liveEl;
      textEntered = true;
      return;
    }

    console.log(`[Human Behavior Bot] ${label}: partial/mismatched composer content detected (${currentText.length} chars) — clearing before next method`);
    inputEl = await clearDMComposerContent(getDMComposer() || liveEl, `${label} cleanup`) || liveEl;
    await sleep(200);
    const afterClear = normalizeComposerSnapshot(getComposerText(getDMComposer() || inputEl));
    if (afterClear.length > 0) {
      // Second-chance clear: wait another 1s for any lingering main-world activity
      // then try ONE more clear before giving up. This often catches cases where
      // the main-world script finished typing RIGHT as we started clearing.
      console.log(`[Human Behavior Bot] ⚠️ ${label}: composer still has ${afterClear.length} chars — waiting 1s then retrying clear once more`);
      await sleep(1000);
      inputEl = await clearDMComposerContent(getDMComposer() || inputEl, `${label} second-chance`) || inputEl;
      await sleep(200);
      const afterSecondClear = normalizeComposerSnapshot(getComposerText(getDMComposer() || inputEl));
      if (afterSecondClear.length > 0) {
        // Last check: if the lingering text is actually our expected script, we're fine.
        if (composerTextMatchesExpected(afterSecondClear, normalizedMessage)) {
          console.log(`[Human Behavior Bot] ${label}: second-chance reveal — composer has expected text, proceeding to send`);
          textEntered = true;
          return;
        }
        console.log(`[Human Behavior Bot] ⚠️ ${label}: composer still has ${afterSecondClear.length} chars after second clear — aborting to prevent accumulation`);
        textEntered = 'ABORT_DIRTY_COMPOSER';
      } else {
        await ensureComposerReady(`${label} cleanup`);
      }
    } else {
      await ensureComposerReady(`${label} cleanup`);
    }
  };

  // Helper: check if text appears in the composer
  const checkTextEntered = (label) => {
    // Re-query in case Lexical replaced the node
    const liveEl = getDMComposer() || inputEl;
    const t = normalizeOutgoingMessage(getComposerText(liveEl));
    if (composerTextMatchesExpected(t, normalizedMessage)) {
      console.log(`[Human Behavior Bot] ✅ ${label} worked! Preview: "${t.substring(0, 40)}"`);
      inputEl = liveEl; // keep inputEl current
      return true;
    }
    console.log(`[Human Behavior Bot] ✗ ${label}: composer mismatch — got "${normalizeComposerSnapshot(t).substring(0, 40)}"`);
    return false;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // METHOD 0: Native textarea/input value setter (fastest, most reliable)
  // ────────────────────────────────────────────────────────────────────────────
  // Instagram's minichat sometimes uses a plain <textarea>.  For those we bypass
  // all Lexical complexity by setting the value directly via the native setter
  // (which React/other frameworks hook into) then dispatching a real input event.
  // ════════════════════════════════════════════════════════════════════════════
  if (textEntered !== true && textEntered !== 'ABORT_DIRTY_COMPOSER' && (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT')) {
    console.log('[Human Behavior Bot] METHOD 0: native textarea setter...');
    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        inputEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(inputEl, normalizedMessage);
      } else {
        inputEl.value = normalizedMessage;
      }
      inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      // For textarea, check .value not .textContent
      const v = inputEl.value || '';
      if (composerTextMatchesExpected(v, normalizedMessage)) {
        console.log('[Human Behavior Bot] ✅ METHOD 0 (textarea setter) worked!');
        textEntered = true;
      }
    } catch (e) {
      console.log('[Human Behavior Bot] METHOD 0 error:', e.message);
    }
    if (!textEntered) await resetComposerAfterFailedEntry('METHOD 0');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // METHOD 1 — Main-world execCommand via background injection (most reliable)
  // ────────────────────────────────────────────────────────────────────────────
  // Content scripts run in Chrome's ISOLATED world.  Although document and DOM
  // are shared, calling execCommand from isolated world can fail to trigger
  // isTrusted events that Instagram's Lexical checks.  By asking the background
  // to inject a function with world:'MAIN', we run in the same JS context as the
  // page — Lexical sees the events as fully native user input.
  // ════════════════════════════════════════════════════════════════════════════
  if (textEntered !== true && textEntered !== 'ABORT_DIRTY_COMPOSER') {
    console.log('[Human Behavior Bot] METHOD 1: main-world execCommand injection via background...');
    try {
      await ensureComposerReady('METHOD 1');
      const injected = await new Promise((resolve) => {
        // 45s: long enough for a 500-char script typed char-by-char (~40ms each)
        // plus every main-world fallback (execCommand → replaceComposerContents
        // → DOM mutation). A shorter timeout causes us to race the main-world
        // script and fight its own typing with clears, producing ABORT_DIRTY.
        const timeout = setTimeout(() => resolve({ success: false, error: 'timeout' }), 45000);
        chrome.runtime.sendMessage(
          { type: 'INJECT_EXECCOMMAND', text: normalizedMessage },
          (response) => {
            clearTimeout(timeout);
            resolve(response || { success: false });
          }
        );
      });
      console.log('[Human Behavior Bot] METHOD 1 injection response:', JSON.stringify(injected));
      if (injected?.success) {
        await sleep(500);
        textEntered = checkTextEntered('METHOD 1 (main-world execCommand)');
      } else if (injected?.error === 'timeout') {
        // Main-world script is STILL running — wait for composer to stop
        // mutating (text length stable for ~1.5s) before we touch it, so
        // our "clear" doesn't race the in-flight typing and cause ABORT_DIRTY.
        console.log('[Human Behavior Bot] METHOD 1 timed out — waiting up to 15s for main-world to settle before attempting cleanup...');
        const settleStart = Date.now();
        let prevLen = -1;
        let stableCount = 0;
        while (Date.now() - settleStart < 15000) {
          const live = getDMComposer() || inputEl;
          const curLen = normalizeComposerSnapshot(getComposerText(live)).length;
          if (curLen === prevLen) {
            stableCount++;
            if (stableCount >= 3) break; // 3 × 500ms = 1.5s stable
          } else {
            stableCount = 0;
          }
          prevLen = curLen;
          await sleep(500);
        }
        // Re-check now that main-world has stopped mutating the DOM
        textEntered = checkTextEntered('METHOD 1 (post-settle)');
        if (textEntered) {
          console.log('[Human Behavior Bot] ✅ Main-world injection succeeded after timeout — text is in composer');
        }
      }
    } catch (e) {
      console.log('[Human Behavior Bot] METHOD 1 error:', e.message);
    }
    if (!textEntered) await resetComposerAfterFailedEntry('METHOD 1');
  }

  // On /direct/ pages, ALWAYS try legacy fallbacks — the MAIN world injection
  // can fail due to Lexical state issues on freshly-navigated DM threads.
  const onDirectPage = window.location.pathname.includes('/direct/');
  const skipLegacyTypingFallbacks = false;

  if (onDirectPage && textEntered !== true) {
    console.log('[Human Behavior Bot] On /direct/ page — will try legacy fallbacks as backup');
  } else if (textEntered !== true) {
    console.log('[Human Behavior Bot] Main-world text entry did not stabilize — running the full fallback chain with cleanup + validation');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // METHOD 1b — Isolated-world execCommand fallback
  // ────────────────────────────────────────────────────────────────────────────
  // Kept as a fallback in case the background injection is unavailable.
  // ════════════════════════════════════════════════════════════════════════════
  if (!skipLegacyTypingFallbacks && textEntered !== true && textEntered !== 'ABORT_DIRTY_COMPOSER') {
    console.log('[Human Behavior Bot] METHOD 1b: isolated-world execCommand fallback...');
    try {
      await ensureComposerReady('METHOD 1b');
      inputEl.focus({ preventScroll: true });
      await sleep(100);
      // Always selectAll first to REPLACE any stale content instead of appending
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, normalizedMessage);
      await sleep(600);
      textEntered = checkTextEntered('METHOD 1b (selectAll+insertText)');
    } catch (e) {
      console.log('[Human Behavior Bot] METHOD 1b error:', e.message);
    }
    if (!textEntered) await resetComposerAfterFailedEntry('METHOD 1b');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // METHOD 2: Direct DOM mutation + input event
  // ────────────────────────────────────────────────────────────────────────────
  // Bypasses the isTrusted gate on beforeinput by mutating the DOM directly.
  // Lexical's MutationObserver + its `input` event handler together reconcile
  // the new content into its EditorState.  We dispatch `input` (not beforeinput)
  // because Lexical's input handler typically does NOT check isTrusted.
  // ════════════════════════════════════════════════════════════════════════════
  if (!skipLegacyTypingFallbacks && textEntered !== true && textEntered !== 'ABORT_DIRTY_COMPOSER') {
    console.log('[Human Behavior Bot] METHOD 2: direct DOM mutation + input event...');
    try {
      inputEl.focus();
      placeSelectionAtEnd();
      await sleep(50);

      // Find the Lexical paragraph node (Lexical renders each line as <p>)
      const para = inputEl.querySelector('p') || inputEl;

      // Build the DOM matching Lexical's expected structure (single or multi-line)
      const lines = normalizedMessage.split('\n');
      if (lines.length === 1) {
        // Single line — replace contents of existing paragraph
        para.textContent = normalizedMessage;
      } else {
        // Multi-line — Lexical uses one <p> per line
        para.textContent = lines[0];
        for (let li = 1; li < lines.length; li++) {
          const np = document.createElement('p');
          np.textContent = lines[li];
          // Insert after para (or after the last sibling we added)
          const ref = inputEl.children[li] || null;
          inputEl.insertBefore(np, ref);
        }
      }

      // Move cursor to end of the last inserted paragraph
      const lastPara = inputEl.lastElementChild || para;
      const selM = window.getSelection();
      const rangeM = document.createRange();
      rangeM.selectNodeContents(lastPara);
      rangeM.collapse(false);
      selM.removeAllRanges();
      selM.addRange(rangeM);

      // Dispatch input immediately after DOM mutation — Lexical's input handler
      // reads the current DOM and syncs it to EditorState (skips isTrusted check)
      inputEl.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        data: normalizedMessage,
      }));
      await sleep(400);

      // Also fire compositionend — some Lexical builds reconcile on this
      inputEl.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        cancelable: false,
        data: normalizedMessage,
      }));
      await sleep(400);
      textEntered = checkTextEntered('METHOD 2 (DOM mutation)');
    } catch (e) {
      console.log('[Human Behavior Bot] METHOD 2 error:', e.message);
    }
    if (!textEntered) await resetComposerAfterFailedEntry('METHOD 2');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // METHOD 3: beforeinput with insertFromPaste + ClipboardEvent paste
  // ────────────────────────────────────────────────────────────────────────────
  // Lexical has dedicated paste handlers that in some builds do not enforce
  // isTrusted.  Try both insertFromPaste beforeinput and a full ClipboardEvent.
  // ════════════════════════════════════════════════════════════════════════════
  if (!skipLegacyTypingFallbacks && textEntered !== true && textEntered !== 'ABORT_DIRTY_COMPOSER') {
    console.log('[Human Behavior Bot] METHOD 3: insertFromPaste beforeinput + ClipboardEvent paste...');
    try {
      inputEl.focus();
      placeSelectionAtEnd();
      await sleep(80);

      const buildDT = () => {
        const dt = new DataTransfer();
        dt.setData('text/plain', normalizedMessage);
        dt.setData('text/html', normalizedMessage
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .split('\n').map(l => `<p>${l || '<br>'}</p>`).join(''));
        return dt;
      };

      // 3a: insertFromPaste beforeinput (Lexical's own paste pipeline)
      inputEl.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true,
        inputType: 'insertFromPaste',
        dataTransfer: buildDT(),
      }));
      await sleep(500);
      textEntered = checkTextEntered('METHOD 3a (insertFromPaste)');

      // 3b: full ClipboardEvent paste
      if (!textEntered) {
        inputEl.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true,
          clipboardData: buildDT(),
        }));
        await sleep(600);
        textEntered = checkTextEntered('METHOD 3b (ClipboardEvent paste)');
      }
    } catch (e) {
      console.log('[Human Behavior Bot] METHOD 3 error:', e.message);
    }
    if (!textEntered) await resetComposerAfterFailedEntry('METHOD 3');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // METHOD 4: Character-by-character execCommand
  // ────────────────────────────────────────────────────────────────────────────
  // Slowest but most persistent — each character fires execCommand which
  // generates a fresh trusted beforeinput event for that character.
  // ════════════════════════════════════════════════════════════════════════════
  if (!skipLegacyTypingFallbacks && textEntered !== true && textEntered !== 'ABORT_DIRTY_COMPOSER') {
    console.log('[Human Behavior Bot] METHOD 4: char-by-char execCommand...');
    try {
      // Clear any existing content first to prevent accumulation
      const preCheck = getDMComposer() || inputEl;
      const preText = normalizeComposerSnapshot(getComposerText(preCheck));
      if (preText.length > 0) {
        if (composerTextMatchesExpected(preText, normalizedMessage)) {
          console.log('[Human Behavior Bot] METHOD 4: composer already has expected text — skipping');
          textEntered = true;
        } else {
          await clearDMComposerContent(preCheck, 'METHOD 4 pre-clear');
        }
      }
      if (textEntered !== true) {
      inputEl.focus();
      await sleep(100); // Let Lexical sync — do NOT call placeSelectionAtEnd

      for (const char of normalizedMessage) {
        if (document.activeElement !== inputEl) {
          inputEl.focus();
          await sleep(50); // Re-focus without selection manipulation
        }
        if (char === '\n') {
          const insertedBreak = document.execCommand('insertLineBreak', false, null)
            || document.execCommand('insertHTML', false, '<br>');
          if (!insertedBreak) {
            throw new Error('line-break insertion failed');
          }
          await sleep(randomInt(30, 80));
          continue;
        }
        document.execCommand('insertText', false, char);
        await sleep(randomInt(25, 75));
      }
      await sleep(500);
      textEntered = checkTextEntered('METHOD 4 (char-by-char execCommand)');
      } // close if (textEntered !== true) inner guard
    } catch (e) {
      console.log('[Human Behavior Bot] METHOD 4 error:', e.message);
    }
    if (!textEntered) await resetComposerAfterFailedEntry('METHOD 4');
  }

  // ── ABORT if composer got dirty and couldn't be cleared ──
  if (textEntered === 'ABORT_DIRTY_COMPOSER') {
    console.log('[Human Behavior Bot] ❌ Aborting DM send — composer accumulated stale text that could not be cleared');
    const dirtyComposer = getDMComposer();
    if (dirtyComposer) await clearDMComposerContent(dirtyComposer, 'abort dirty');
    return false;
  }

  // Verify text was entered
  inputEl = getDMComposer() || inputEl;
  const enteredText = normalizeOutgoingMessage(getComposerText(inputEl));
  console.log('[Human Behavior Bot] Final input content:', JSON.stringify(enteredText.substring(0, 50)));
  console.log('[Human Behavior Bot] Expected length:', normalizedMessage.length, 'Actual length:', enteredText.length);

  if (!enteredText || enteredText.length === 0) {
    return await retryTextEntry('All text entry methods failed', inputEl);
  }

  console.log('[Human Behavior Bot] ✅ Text entry successful via one of the methods');

  inputEl = getDMComposer() || inputEl;
  const verifiedComposerText = normalizeOutgoingMessage(getComposerText(inputEl));
  if (!composerTextMatchesExpected(verifiedComposerText, normalizedMessage)) {
    // Additional length guard: if composer has MORE text than expected, it's duplicated
    const expectedLen = normalizeComposerSnapshot(normalizedMessage).length;
    const actualLen = normalizeComposerSnapshot(verifiedComposerText).length;
    console.log(`[Human Behavior Bot] ❌ Composer text mismatch (expected ${expectedLen} chars, got ${actualLen}) — aborting send`);
    await clearDMComposerContent(inputEl, 'final mismatch abort');
    return await retryTextEntry('Composer text mismatch after entry validation', inputEl);
  }

  const composerSettled = await waitForComposerTextStability(normalizedMessage, inputEl, {
    maxChecks: 10,
    requiredConsecutive: 3,
    delayMs: 140,
  });

  if (!composerSettled) {
    console.log('[Human Behavior Bot] ❌ Composer never stabilized with the full expected script — aborting send');
    await clearDMComposerContent(inputEl, 'unstable composer abort');
    return await retryTextEntry('Composer never stabilized with the expected script', inputEl);
  }

  inputEl = getDMComposer() || inputEl;

  const beforeSnapshot = analyzeDMConversation(inputEl);

  // ── Helper: capture composer text RIGHT NOW (before any send attempt) ────────
  // We capture it here so waitForMessageConfirmation can compare before → after.
  const composerTextBeforeSend = normalizeOutgoingMessage(getComposerText(inputEl));

  // Hard wait — let Instagram's Lexical editor fully register content before send
  await sleep(800);

  // DIAGNOSTIC: verify composer state at moment of send dispatch
  try {
    const dispComposer = getDMComposer() || inputEl;
    const dispText = normalizeComposerSnapshot(getComposerText(dispComposer));
    const dispContainer = dispComposer.closest('[role="dialog"]') || dispComposer.closest('form') || document;
    let dispSendCount = 0;
    for (const b of dispContainer.querySelectorAll('button, [role="button"]')) {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent?.trim() || '').toLowerCase();
      if (a === 'send' || t === 'send' || a.startsWith('send ') || t.startsWith('send ')) dispSendCount++;
    }
    console.log(`[Human Behavior Bot] 🔎 Pre-send snapshot: composerChars=${dispText.length}, expectedChars=${normalizeComposerSnapshot(normalizedMessage).length}, sendBtnsVisible=${dispSendCount}`);
    logActivity?.('send_debug', `pre-send: composer=${dispText.length}ch, expected=${normalizeComposerSnapshot(normalizedMessage).length}ch, sendBtnsVisible=${dispSendCount}, widget=${widgetType}`);
  } catch (_) {}

  console.log('[Human Behavior Bot] Delegating send dispatch to unified send helper...');
  return await _attemptSendOnly(
    inputEl,
    normalizedMessage,
    beforeSnapshot,
    normalizeComposerSnapshot(composerTextBeforeSend),
  );

  // ── Helper: find the Send button scoped to the DM composer container ─────────
  // Rules:
  //  • ONLY return buttons that are clearly the Send button (label, SVG, or adjacent)
  //  • NEVER return 3-dots / Options / More / Info buttons — even if nothing else is found
  //  • Accept disabled send buttons (Instagram enables them async — we click and let Lexical decide)
  const findSendButton = () => {
    const inputRect = inputEl.getBoundingClientRect();

    // Exclude header-area buttons (3-dots, back arrow, profile info, audio/video call, etc.)
    // This filter is CRITICAL — a false negative here causes the bot to click the 3-dots
    // button instead of the Send button, derailing the entire DM flow.
    const isHeaderBtn = (btn) => {
      if (!btn) return true;
      if (btn.closest('nav')) return true;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const svgAria = (btn.querySelector('svg')?.getAttribute('aria-label') || '').toLowerCase();
      const txt = (btn.textContent?.trim() || '').toLowerCase();
      const combinedLabels = aria + ' ' + svgAria + ' ' + txt;

      // ── Reject by aria-label / SVG label keywords ──────────────────────────
      const REJECT_KEYWORDS = [
        'detail', 'info', 'option', 'back', 'close', 'minimize',
        'call', 'audio', 'video', 'phone',          // call buttons in DM header
        'conversation', 'thread',                      // "Conversation information", "Thread actions"
        'action', 'flag', 'report', 'block', 'mute',  // menu/moderation buttons
        'setting', 'preference',                       // settings buttons
        'delete', 'remove', 'leave',                   // destructive action buttons
      ];
      if (REJECT_KEYWORDS.some(kw => combinedLabels.includes(kw))) return true;

      // ── Reject "More" / "More ..." variants (not just exact match) ────────
      if (aria.startsWith('more') || svgAria.startsWith('more')) return true;

      // ── Reject 3-dots / ellipsis text ──────────────────────────────────────
      if (txt === '...' || txt === '⋯' || txt === '⋮' || txt === '…' || txt === '•••') return true;

      // ── Reject icon-only buttons that are clearly NOT send buttons ─────────
      // A button with no text and no send-related aria-label, containing only an SVG,
      // is very likely a 3-dots, info, call, or navigation icon — not a send button.
      const hasSvg = !!btn.querySelector('svg');
      const hasNoText = !txt || txt.length <= 1;
      const hasSendHint = combinedLabels.includes('send') || combinedLabels.includes('submit');
      if (hasSvg && hasNoText && !hasSendHint) {
        // Only reject if it's clearly above the composer (not immediately beside it)
        const rect = btn.getBoundingClientRect();
        if (rect.bottom < inputRect.top - 30) return true;
      }

      // ── Position guard: well above the composer → it's the chat header ────
      const rect = btn.getBoundingClientRect();
      return rect.bottom < inputRect.top - 80;
    };

    // Label matcher — partial so "Send Message Request", "Send", "Submit" all match
    const isSendLabel = (text) => {
      const t = (text || '').toLowerCase().trim();
      return t === 'send' || t === 'submit' || t.startsWith('send ') || t.includes('send message');
    };

    // isVisible: button must be in DOM and have size (accept disabled/aria-disabled buttons —
    // clicking the real Send button even while "disabled" is safe; clicking the 3-dots is not)
    const isVisible = (btn) => {
      if (!btn || !btn.isConnected) return false;
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    // Enabled-only version (for steps 1 & 2 — prefer enabled buttons first)
    const isValidSendEnabled = (btn) =>
      btn && isElementVisibleAndEnabled(btn) && !isHeaderBtn(btn);

    // Visible version (for fallback steps — accepts disabled too, but ONLY for positively identified send btns)
    const isValidSendVisible = (btn) =>
      btn && isVisible(btn) && !isHeaderBtn(btn);

    const dialogEl = inputEl.closest('[role="dialog"]');
    // Climb up to 6 levels to find a reasonable container that includes the send button.
    // Instagram's split-view and chat widget nest the send button at varying depths.
    let autoContainer = inputEl;
    for (let d = 0; d < 6 && autoContainer?.parentElement; d++) autoContainer = autoContainer.parentElement;
    const container = dialogEl
      || inputEl.closest('form')
      || autoContainer
      || document;

    // ── Step 1: SVG aria-label "Send" inside container (enabled first) ──────────
    for (const svg of container.querySelectorAll('svg')) {
      const lbl = (svg.getAttribute('aria-label') || '').toLowerCase();
      if (isSendLabel(lbl)) {
        const btn = svg.closest('[role="button"]') || svg.closest('button') || svg.parentElement;
        if (isValidSendEnabled(btn)) {
          console.log('[Human Behavior Bot] Found Send button via SVG aria-label (enabled):', lbl);
          return btn;
        }
      }
    }

    // ── Step 2: Button text / aria-label match (enabled first) ──────────────────
    for (const btn of container.querySelectorAll('button, [role="button"]')) {
      const txt  = (btn.textContent?.trim() || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (isSendLabel(txt) || isSendLabel(aria)) {
        if (isValidSendEnabled(btn)) {
          console.log('[Human Behavior Bot] Found Send button via text/aria (enabled):', txt || aria);
          return btn;
        }
      }
    }

    // ── Step 3: Proximity — sibling AFTER the input in the compose row ───────────
    // The send arrow is always immediately to the RIGHT of the textbox in Instagram.
    // Accept both enabled AND disabled buttons here (position alone identifies the send button).
    // SAFETY: Only search up to 4 levels (compose row → wrapper → form).
    //         At higher depths we exit the compose section and risk grabbing header buttons.
    //         Also reject buttons that are vertically far from the composer (not in the same row).
    let rowEl = inputEl;
    for (let depth = 0; depth < 4; depth++) {
      rowEl = rowEl?.parentElement;
      if (!rowEl) break;
      const children = Array.from(rowEl.children);
      const inputIdx = children.findIndex((c) => c.contains(inputEl));
      if (inputIdx >= 0) {
        for (let i = inputIdx + 1; i < children.length; i++) {
          const sibling = children[i];
          const candidates = [
            ...(sibling.matches('[role="button"], button') ? [sibling] : []),
            ...sibling.querySelectorAll('[role="button"], button'),
          ].filter((b) => {
            if (!isValidSendVisible(b)) return false;
            // Extra guard: button must be roughly on the same vertical line as the composer
            // (within 60px) — this prevents grabbing header buttons when we climb too high
            const bRect = b.getBoundingClientRect();
            const verticalDistance = Math.abs(bRect.top - inputRect.top);
            if (verticalDistance > 60) {
              console.log(`[Human Behavior Bot] Rejecting proximity candidate: too far vertically (${Math.round(verticalDistance)}px)`);
              return false;
            }
            return true;
          });
          if (candidates.length > 0) {
            console.log('[Human Behavior Bot] Found Send button as post-input sibling (depth', depth, ')');
            return candidates[0];
          }
        }
      }
    }

    // ── Step 4: SVG / label search allowing disabled buttons ────────────────────
    // Only returns buttons whose label EXPLICITLY matches "send" — never generic fallbacks.
    for (const svg of container.querySelectorAll('svg')) {
      const lbl = (svg.getAttribute('aria-label') || '').toLowerCase();
      if (isSendLabel(lbl)) {
        const btn = svg.closest('[role="button"]') || svg.closest('button') || svg.parentElement;
        if (isValidSendVisible(btn) && !isHeaderBtn(btn)) {
          console.log('[Human Behavior Bot] Found Send button via SVG aria-label (disabled ok):', lbl);
          return btn;
        }
      }
    }
    for (const btn of container.querySelectorAll('button, [role="button"]')) {
      const txt  = (btn.textContent?.trim() || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (isSendLabel(txt) || isSendLabel(aria)) {
        if (isValidSendVisible(btn) && !isHeaderBtn(btn)) {
          console.log('[Human Behavior Bot] Found Send button via label (disabled ok):', txt || aria);
          return btn;
        }
      }
    }

    // ── Step 5: Document-wide search (last resort — searches entire page) ──────
    // Only returns buttons whose label explicitly matches "send" AND are near the composer vertically.
    if (container !== document) {
      console.log('[Human Behavior Bot] findSendButton: container search failed — trying document-wide...');
      for (const svg of document.querySelectorAll('svg')) {
        const lbl = (svg.getAttribute('aria-label') || '').toLowerCase();
        if (isSendLabel(lbl)) {
          const btn = svg.closest('[role="button"]') || svg.closest('button') || svg.parentElement;
          if (btn && isVisible(btn) && !isHeaderBtn(btn)) {
            const bRect = btn.getBoundingClientRect();
            if (Math.abs(bRect.top - inputRect.top) < 80) {
              console.log('[Human Behavior Bot] Found Send button via document-wide SVG search');
              return btn;
            }
          }
        }
      }
      for (const btn of document.querySelectorAll('button, [role="button"]')) {
        const txt  = (btn.textContent?.trim() || '').toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (isSendLabel(txt) || isSendLabel(aria)) {
          if (isVisible(btn) && !isHeaderBtn(btn)) {
            const bRect = btn.getBoundingClientRect();
            if (Math.abs(bRect.top - inputRect.top) < 80) {
              console.log('[Human Behavior Bot] Found Send button via document-wide text/aria search');
              return btn;
            }
          }
        }
      }
    }

    console.log('[Human Behavior Bot] findSendButton: no send button found');
    return null;
  };

  // ── Helper: check if message was sent (composer cleared or dialog gone) ───────
  // NOTE: "composer cleared" alone is NOT sufficient proof — Lexical's reconciler
  // also resets the DOM to empty when our text injection fails (e.g. isTrusted issue
  // with the floating chat widget).  We therefore require EITHER the composer to be
  // gone (dialog dismissed) OR the sent text to appear in the thread.
  // Dialog-based sends (minichat overlay) are trusted on empty-composer because the
  // thread is the dialog itself and disappears after send.
  // NOTE: reuse the isInDialog variable declared earlier in this function (line ~791)
  // — do NOT redeclare with const (causes "already been declared" crash on re-injection).

  const confirmInThread = () => {
    // Re-query composer to get a fresh reference — Lexical may have detached/re-rendered
    // inputEl after text insertion, making it an orphaned node. Using the live composer
    // keeps the thread analysis scoped to the ACTIVE pane on /direct/inbox/ split-view.
    const liveComposer = getDMComposer() || inputEl;
    const afterSnap = analyzeDMConversation(liveComposer);
    const prevCount = beforeSnapshot?.texts?.length || 0;

    // A new message appeared in the active thread
    if (afterSnap.texts.length > prevCount) return true;

    // Or the exact/partial message now exists in the active thread text list
    const normalizedNeedle = normalizeOutgoingMessage(normalizedMessage);
    const first10 = normalizedNeedle.substring(0, 10);
    if (normalizedNeedle.length > 0) {
      const matched = afterSnap.texts.some((t) => {
        const normalizedText = normalizeOutgoingMessage(t);
        return normalizedText && (
          normalizedText.includes(normalizedNeedle)
          || normalizedNeedle.includes(normalizedText)
          || (first10.length > 0 && normalizedText.includes(first10))
        );
      });
      if (matched) return true;
    }

    return false;
  };

  const checkSent = async (label) => {
    await sleep(600);

    // Signal A: composer gone (dialog dismissed / page navigated away)
    const c0 = getDMComposer();
    if (!c0) {
      console.log(`[Human Behavior Bot] ✅ ${label}: composer gone immediately — message sent`);
      return true;
    }

    console.log(`[Human Behavior Bot] ${label}: composer still present, polling confirmation...`);

    // Signals B/C: poll up to ~4 seconds for composer to clear AND thread to confirm
    let composerWasCleared = false; // track if composer ever cleared during polling
    for (let w = 0; w < 8; w++) {
      const c = getDMComposer();

      // Signal A (delayed): composer gone
      if (!c) {
        console.log(`[Human Behavior Bot] ✅ ${label}: composer gone (poll #${w + 1}) — message sent`);
        return true;
      }

      const cText = normalizeOutgoingMessage(getComposerText(c));
      const composerCleared = composerTextBeforeSend.length > 0 && cText.length === 0;

      if (w === 0 || w === 3 || w === 7) {
        console.log(`[Human Behavior Bot] ${label}: poll #${w + 1}/8 — composer text length: ${cText.length}, was ${composerTextBeforeSend.length}`);
      }

      if (composerCleared) {
        composerWasCleared = true;
        console.log(`[Human Behavior Bot] ${label}: composer cleared! (poll #${w + 1})`);
        // For dialog-based sends trust empty composer — thread isn't separately visible
        if (isInDialog) {
          console.log(`[Human Behavior Bot] ✅ ${label}: dialog composer cleared — sent`);
          return true;
        }
        // For floating widget / /direct/ page: require the message to appear in thread
        console.log(`[Human Behavior Bot] ${label}: checking if message appeared in thread...`);
        if (confirmInThread()) {
          console.log(`[Human Behavior Bot] ✅ ${label}: composer cleared + message confirmed in thread`);
          return true;
        }
        console.log(`[Human Behavior Bot] ${label}: composer cleared but message not in thread yet — will keep waiting`);
        // Composer is empty but no message in thread yet — could be Lexical reset; keep waiting
      }

      await sleep(500);
    }

    // Final fallback for floating widget: if the composer cleared, do one longer
    // thread confirmation pass before deciding. Do not treat a cleared composer
    // alone as success — Lexical can also clear failed insertions.
    if (!isInDialog && composerWasCleared) {
      const confirmedAfterClear = await waitForMessageConfirmation(normalizedMessage, beforeSnapshot, getDMComposer() || inputEl);
      if (confirmedAfterClear) {
        console.log(`[Human Behavior Bot] ✅ ${label}: composer cleared and thread confirmation arrived on extended check`);
        return true;
      }
      console.log(`[Human Behavior Bot] ${label}: composer cleared but thread never confirmed the message`);
    }

    console.log(`[Human Behavior Bot] ✗ ${label}: send not confirmed after polling (composer still has ${getComposerText(getDMComposer()).length} chars)`);
    return false;
  };

  const sendGuard = claimDMSendAttempt(normalizedMessage);
  if (!sendGuard.claimed) {
    console.log(`[Human Behavior Bot] Duplicate DM send blocked (${sendGuard.key}, ${sendGuard.ageMs}ms old)`);
    return await checkSent('guarded send wait');
  }

  const composerStillHasExpectedText = () => {
    const liveComposer = getDMComposer() || inputEl;
    if (!liveComposer) return false;
    const liveText = normalizeOutgoingMessage(getComposerText(liveComposer));
    return composerTextMatchesExpected(liveText, normalizedMessage);
  };

  const dispatchMainWorldEnter = async () => {
    try {
      const enterInjected = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ success: false, error: 'timeout' }), 4000);
        chrome.runtime.sendMessage(
          { type: 'INJECT_ENTER_KEY' },
          (response) => {
            clearTimeout(timeout);
            resolve(response || { success: false });
          }
        );
      });
      return enterInjected?.success ? 'Enter key (main-world)' : '';
    } catch (e) {
      console.log('[Human Behavior Bot] Main-world Enter error:', e.message);
      return '';
    }
  };

  const dispatchSyntheticEnter = async () => {
    console.log('[Human Behavior Bot] Falling back to one synthetic Enter dispatch...');
    inputEl.focus();
    await sleep(150);
    for (const target of [inputEl, document.body]) {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true,
      }));
    }
    return 'Enter key (synthetic)';
  };

  // Step 3: SEND the message
  await sleep(humanDelay(400));

  console.log('[Human Behavior Bot] Looking for Send button to click...');
  let sendBtn = null;
  for (let wb = 0; wb < 8; wb++) {
    sendBtn = findSendButton();
    if (sendBtn) {
      console.log('[Human Behavior Bot] ✅ Send button found on attempt ' + (wb + 1));
      break;
    }
    if (wb === 0 || wb === 3 || wb === 7) {
      console.log('[Human Behavior Bot] Send button not found yet (attempt ' + (wb + 1) + '/8)');
    }
    await sleep(250);
  }
  let dispatchLabel = '';

  if (sendBtn) {
    console.log('[Human Behavior Bot] Clicking Send button (single dispatch)...');
    sendBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await sleep(200);
    const trustedClickWorked = await triggerTrustedSendButtonClick();
    if (trustedClickWorked) {
      dispatchLabel = 'Send button (main-world click)';
    } else {
      await humanClick(sendBtn);
      dispatchLabel = 'Send button humanClick';
    }
  } else {
    console.log('[Human Behavior Bot] ⚠️ No Send button found after 8 attempts — choosing one fallback dispatch');

    if (await triggerTrustedSendButtonClick()) {
      dispatchLabel = 'Send button (main-world click)';
    }

    if (!dispatchLabel) {
      dispatchLabel = await dispatchMainWorldEnter();
    }

    if (!dispatchLabel) {
      dispatchLabel = await dispatchSyntheticEnter();
    }
  }

  if (dispatchLabel) {
    console.log(`[Human Behavior Bot] Single send dispatched via ${dispatchLabel}`);
    if (await checkSent(dispatchLabel)) return true;

    if (composerStillHasExpectedText()) {
      console.log(`[Human Behavior Bot] ${dispatchLabel} did not send — trying one alternate send dispatch`);
      const alternateLabel = dispatchLabel.includes('button')
        ? (await dispatchMainWorldEnter()) || (await dispatchSyntheticEnter())
        : await (async () => {
            const altBtn = findSendButton();
            if (altBtn) {
              altBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              await sleep(150);
              if (await triggerTrustedSendButtonClick()) {
                return 'Send button alternate main-world click';
              }
              await humanClick(altBtn);
              return 'Send button alternate humanClick';
            }
            return '';
          })();

      if (alternateLabel) {
        console.log(`[Human Behavior Bot] Alternate send dispatched via ${alternateLabel}`);
        if (await checkSent(alternateLabel)) return true;
      }
    }
  }

  // DIAGNOSTIC: snapshot send button availability at the moment we start typing.
  try {
    const diagDialog = inputEl.closest('[role="dialog"]');
    const diagContainer = diagDialog || inputEl.closest('form') || document;
    const diagBtnCount = diagContainer.querySelectorAll ? diagContainer.querySelectorAll('button, [role="button"]').length : 0;
    let diagSendCount = 0;
    if (diagContainer.querySelectorAll) {
      for (const b of diagContainer.querySelectorAll('button, [role="button"]')) {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.textContent?.trim() || '').toLowerCase();
        if (a === 'send' || t === 'send' || a.startsWith('send ') || t.startsWith('send ')) diagSendCount++;
      }
    }
    console.log(`[Human Behavior Bot] 🔎 Pre-type context: widget=${widgetType}, dialog=${!!diagDialog}, totalBtns=${diagBtnCount}, sendBtns=${diagSendCount}, pathname=${window.location.pathname}`);
  } catch (_) {}


  // === SEND METHOD 5: Final Wait (extended polling for floating widgets) ===
  console.log('[Human Behavior Bot] METHOD 5: Extended wait for floating widget to process send...');
  const finalWait = await checkSent('Extended final wait');
  if (finalWait) return true;

  // ── Final check: composer empty AND message confirmed in thread (or dialog gone) ─
  if (composerTextBeforeSend.length > 0) {
    const finalComposer = getDMComposer();
    if (!finalComposer) {
      console.log('[Human Behavior Bot] ✅ Final check: composer gone — message was sent');
      return true;
    }
    const finalText = normalizeOutgoingMessage(getComposerText(finalComposer));
    if (finalText.length === 0) {
      console.log('[Human Behavior Bot] Final check: composer is now empty');
      if (isInDialog || confirmInThread()) {
        console.log('[Human Behavior Bot] ✅ Final check: composer empty + confirmed in thread — message was sent');
        return true;
      }
      console.log('[Human Behavior Bot] Final check: composer empty but message not confirmed in thread');
    } else {
      console.log('[Human Behavior Bot] Final check: composer still has text (' + finalText.length + ' chars)');
    }
  }

  // ── LAST RESORT API — DISABLED ──────────────────────────────────────────────
  // Direct API calls to Instagram's internal endpoints cause force-logout.
  // If all DOM methods failed, log it and return false — do NOT fall back to API.
  const finalComposer = getDMComposer();
  const failureReason = !finalComposer
    ? 'composer disappeared but send not confirmed'
    : 'composer still contains text';
  console.log('[Human Behavior Bot] ❌ All DOM send methods failed (' + failureReason + ') — skipping account');
  console.log('[Human Behavior Bot] ❌ API path disabled to prevent logout — DM send failed for this account');
  return false;
}

// ─── DM HISTORY TRACKING ───────────────────────────────────
// Persists messaged usernames / known-thread ids in chrome.storage.local to avoid duplicates
// Keys are scoped per active Instagram account

function getDMHistoryKey() {
  return contentActiveAccount ? `${DM_HISTORY_KEY_BASE}_${contentActiveAccount}` : DM_HISTORY_KEY_BASE;
}

function getProcessedAccountsKey() {
  return contentActiveAccount ? `${PROCESSED_ACCOUNTS_KEY_BASE}_${contentActiveAccount}` : PROCESSED_ACCOUNTS_KEY_BASE;
}

// Load the active account from storage on startup — resolves contentAccountReady when done
(async () => {
  try {
    const data = await new Promise(resolve => chrome.storage.local.get({ futnor_active_account: null }, resolve));
    if (data.futnor_active_account) {
      contentActiveAccount = data.futnor_active_account;
      console.log('[Futnor Instagram] Active account loaded:', contentActiveAccount);
    }
  } catch (e) {
    console.warn('[Futnor Instagram] Failed to load active account from storage:', e?.message);
  } finally {
    _contentAccountReadyResolve(); // Always unblock — even if null, unscoped key is better than a hang
  }
})();

// ─── Self-detection of the logged-in username ───
// Central place where every detection caller (message handler, background
// scripting fallback, proactive observer) agrees on how to read the username
// from the DOM. Must stay defensive — Instagram's UI varies by locale, feature
// rollouts, and viewport size, so we try many independent signals and accept
// the first one that produces a plausible username.
const DETECTION_RESERVED = new Set([
  'explore','reels','direct','accounts','p','stories','tv','about','shop',
  'developer','legal','privacy','emails','tags','locations','web','s','oauth',
  'api','graphql','channel','challenge','nometa','ads','business','creators',
  'press','jobs','help','invites','nametag','accounts_center',
]);

function isPlausibleUsername(u) {
  return !!u && !u.includes('/') && !DETECTION_RESERVED.has(u) && /^[a-z0-9._]{2,30}$/.test(u);
}

function hrefToCandidateUsername(el) {
  const href = el?.getAttribute('href') || '';
  // Only accept bare /<username>[/] paths — reject /username/followers, /explore, etc.
  const cleaned = href.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!cleaned || cleaned.includes('/')) return null;
  return cleaned;
}

// True if the page currently being viewed is the logged-in user's own
// profile — verified by the presence of an "Edit profile" affordance that
// only IG renders for the account-holder, not for any other profile visitor.
//
// HARDENING NOTE (v2.4.47): the previous regex `bearbeiten|edit profile|...`
// was matched against `el.textContent` for *every* anchor/button/role=button
// on the page. On a commenter's profile whose bio, story highlights, or any
// nested dialog contained those words (or even substrings like "edit profiles"
// in another user's caption), this function falsely returned true. When
// combined with Method 4 in `detectLoggedInUsernameFromDOM` — which reads the
// URL's first path segment as the logged-in username *only* when this check
// passes — the bug let the visited profile's username win. We now require:
//   1) a strict `/<handle>/` URL shape (rules out /p/, /reel/, /direct/ etc),
//   2) at least one anchor whose href points at `/accounts/edit/`
//      (IG's deterministic own-profile settings link; never rendered for
//      someone else's profile), OR an element whose *exact* textContent
//      (trimmed, lowercased) equals one of the locale-specific Edit Profile
//      labels. Loose `.test()` matching against giant textContent blobs is
//      gone — it was the single biggest false-positive source.
const OWN_PROFILE_EXACT_LABELS = new Set([
  'edit profile',
  'editar perfil',
  'profil bearbeiten',
  'profil anpassen',
  'modifier le profil',
  'modifica profilo',
  'profiel bewerken',
  'editar o perfil',
  'perfil editar',
]);

function isOnOwnProfilePage() {
  try {
    // Must be on a profile-shaped URL: /<handle>/ or /<handle>
    const path = (window.location && window.location.pathname) || '';
    if (!/^\/[a-z0-9._]{1,30}\/?$/i.test(path)) return false;
    const handle = path.split('/').filter(Boolean)[0]?.toLowerCase() || '';
    if (!handle || RESERVED_PROFILE_SEGMENTS.has(handle)) return false;

    // Deterministic signal — IG always renders this anchor on your own profile
    // and never on anyone else's. An account-switcher drawer may contain it
    // too, but that drawer is only opened from your own profile.
    if (document.querySelector('a[href="/accounts/edit/"]')) return true;
    if (document.querySelector('a[href^="/accounts/edit/"]')) return true;

    // Fallback: an anchor/button/role=button inside <main> whose EXACT label
    // (no substring matching) is one of the locale "Edit profile" strings.
    // Scope to <main> so we don't pick up an Edit Profile item that lives in
    // a global account-switcher popover rendered on top of someone else's
    // profile page.
    const main = document.querySelector('main, [role="main"]');
    if (!main) return false;
    const candidates = main.querySelectorAll('a, button, div[role="button"]');
    for (const el of candidates) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!txt) continue;
      if (OWN_PROFILE_EXACT_LABELS.has(txt)) return true;
    }
  } catch {}
  return false;
}

// Returns the /<first>/ segment of the current URL (lowercased) when it
// looks like a profile/reel/post path — used to reject detections that
// simply echo the page we're viewing.
function currentUrlFirstSegment() {
  try {
    const parts = (window.location.pathname || '').split('/').filter(Boolean);
    return (parts[0] || '').toLowerCase();
  } catch {
    return '';
  }
}

function detectLoggedInUsernameFromDOM() {
  try {
    // NOTE (v2.4.48): there used to be an `if (isUnsafeOverwriteSurface())
    // return null;` short-circuit here. It was too broad — on non-English
    // IG locales `isOnOwnProfilePage()` can't prove the current page is the
    // user's own profile, which makes `isUnsafeOverwriteSurface()` flag the
    // *own profile URL* as unsafe and block detection entirely. That regression
    // prevented brand-new installs from ever capturing the connected account.
    //
    // It's also redundant: Methods 1–3 are nav-scoped, and IG's nav always
    // renders the logged-in user regardless of which page's main content is
    // showing. Methods 1, 2, 3, and 6 are all wrapped in the `accept()`
    // helper below, which rejects any candidate whose normalized value equals
    // the first URL path segment on a non-own-profile page
    // (`detectedMatchesViewedProfile`). Method 4 — the only one that *expects*
    // a URL-segment match — is gated by the hardened `isOnOwnProfilePage()`.
    // So bad detections can't leak without the short-circuit.

    // Same-origin reject helper: any candidate that equals the first URL
    // path segment on a non-own-profile page is almost certainly the
    // profile we're *viewing* (common during commenters targeting where
    // the bot navigates to every commenter's profile). Gate every return
    // through this so no detection path — Methods 1, 2, 3, or 6 — can
    // leak a "viewed profile" value upstream. Method 4 explicitly opts
    // out because its whole premise is "URL segment == logged-in user".
    const accept = (u) => {
      if (!isPlausibleUsername(u)) return null;
      if (detectedMatchesViewedProfile(u)) return null;
      return u;
    };

    // Method 1: aria-labelled Profile entry in the sidebar — covers many locales.
    // Instagram translates aria-label per locale; match common prefixes only to keep this cheap.
    const ariaProfileLink = document.querySelector(
      'a[aria-label^="Profile" i][href^="/"], a[aria-label^="Profil" i][href^="/"], ' +
      'a[aria-label^="Perfil" i][href^="/"], a[aria-label^="Profiel" i][href^="/"], ' +
      'a[aria-label^="Profilo" i][href^="/"], a[aria-label^="\u041F\u0440\u043E\u0444" i][href^="/"], ' +
      'a[aria-label^="\u500B\u4EBA" i][href^="/"], a[aria-label^="\u4E2A\u4EBA" i][href^="/"], ' +
      'a[aria-label^="\u30D7\u30ED\u30D5" i][href^="/"]'
    );
    if (ariaProfileLink) {
      const u = accept(hrefToCandidateUsername(ariaProfileLink));
      if (u) return u;
    }

    // Method 2: profile avatar image anywhere on the page — IG sets alt to
    // "<username>'s profile picture" / "Foto del perfil de <username>" / etc.
    // We extract the username from the enclosing anchor's href rather than
    // parsing alt text, which avoids locale-specific patterns.
    const avatarImgs = document.querySelectorAll(
      'img[alt*="profile picture" i], img[alt*="profile photo" i], ' +
      'img[alt*="perfil" i], img[alt*="Profilbild" i], img[alt*="profile" i]'
    );
    for (const img of avatarImgs) {
      const anchor = img.closest('a[href^="/"]');
      if (!anchor) continue;
      // Prefer anchors inside the nav — those always point at the logged-in user.
      const inNav = anchor.closest('nav, [role="navigation"]');
      if (!inNav) continue;
      const u = accept(hrefToCandidateUsername(anchor));
      if (u) return u;
    }

    // Method 3: any nav / navigation landmark link that looks like a profile
    // path. IG only puts the logged-in user's profile link inside the nav
    // landmarks, so a match here is trustworthy even without aria-labels.
    // DO NOT include `header a[...]` here: on /p/ and /reel/ pages IG wraps the
    // post in <article><header> where the post AUTHOR's profile link lives; a
    // header-scoped match would return the post author (e.g. the commenters-
    // targeting URL's owner) instead of the logged-in user.
    const navLinks = document.querySelectorAll(
      'nav a[href^="/"], [role="navigation"] a[href^="/"]'
    );
    // First pass: nav links that also carry an avatar — strongest signal.
    for (const link of navLinks) {
      const u = accept(hrefToCandidateUsername(link));
      if (u && link.querySelector('img')) return u;
    }
    // Second pass: any plausible nav link.
    for (const link of navLinks) {
      const u = accept(hrefToCandidateUsername(link));
      if (u) return u;
    }

    // Method 4: we're on our own profile page (URL is /<username>/ and an
    // "Edit profile" link — or a button whose text includes that phrase —
    // exists). The path segment IS the logged-in user — so this method
    // deliberately bypasses the `accept` URL-match guard above.
    if (isOnOwnProfilePage()) {
      const segments = window.location.pathname.split('/').filter(Boolean);
      if (segments.length === 1) {
        const u = segments[0].toLowerCase();
        if (isPlausibleUsername(u)) return u;
      }
    }

    // Method 5 (avatar alt fallback): DISABLED.
    // Iterating every profile-picture <img> page-wide and returning the first
    // alt handle races IG's nav hydration. On a /p/ or /reel/ page — the exact
    // URL a user pastes for commenters targeting — the POST AUTHOR's avatar
    // renders before the left nav does, so this used to return the post
    // owner's username and `persistDetectedUsername` would stamp it into
    // `futnor_active_account`. Health stats + DM scripts then keyed off the
    // wrong account. Methods 1–4 are all nav- or own-profile-scoped and cover
    // every real login surface, so we drop this fallback entirely.

    // Method 6: legacy meta tag (mostly removed by IG, kept as last resort).
    const metaContent = document.querySelector('meta[property="al:ios:url"]');
    if (metaContent) {
      const match = (metaContent.getAttribute('content') || '').match(/user\?username=([a-z0-9._]+)/i);
      if (match) {
        const u = accept(match[1].toLowerCase());
        if (u) return u;
      }
    }

    return null;
  } catch (e) {
    console.warn('[Futnor Instagram] Detection error:', e?.message);
    return null;
  }
}

// Hard guard: if the detected username matches the first path segment of
// the URL (e.g. detected="krishna__oct_15" while viewing /krishna__oct_15/)
// AND the page isn't the logged-in user's own profile, the signal is almost
// certainly the profile we're *viewing*, not the account we're logged in as.
// This is the single biggest source of the "Account Health shows every
// visited profile" bug: during commenters targeting the bot navigates to
// each commenter's profile to DM them, and any detection path that reads
// the profile-header avatar, the profile "follow" link, or a fresh DOM node
// injected by IG's nav-hydrate will happen to return the viewed username.
// Reject those unconditionally.
function detectedMatchesViewedProfile(normalized) {
  const seg = currentUrlFirstSegment();
  if (!seg || seg !== normalized) return false;
  if (RESERVED_PROFILE_SEGMENTS.has(seg)) return false;
  // On our own profile, the match is correct — the URL segment IS our handle.
  return !isOnOwnProfilePage();
}

// Returns true if the current page is a KNOWN-SAFE surface where any
// detected username is guaranteed to be the logged-in user (not a viewed
// profile, not a post author, not a commenter the bot navigated to).
//
// This is the single hard gate on writes to `futnor_active_account`. By
// requiring an allow-listed surface, we make it structurally impossible
// for a visited profile to ever become the "connected account" — even if
// every other guard regresses or DOM scoping shifts in a future IG redesign.
//
// Safe surfaces:
//   - IG home feed: "/" or "/?..."
//   - Direct inbox: "/direct/..." (logged-in-only surface)
//   - Account settings: "/accounts/edit/..."
//   - The user's OWN profile page (URL segment matches a confirmed
//     own-profile signal — "Edit profile" anchor inside <main>).
function isSafeDetectionSurface() {
  try {
    const path = (window.location && window.location.pathname) || '';
    if (path === '/' || path === '') return true;
    if (/^\/accounts\/edit\b/.test(path)) return true;
    if (/^\/direct\b/.test(path)) return true;
    // Logged-in-only surfaces with FIXED routes (no `/<handle>/` segment that
    // could be confused for the viewed user). IG's nav still renders the
    // logged-in user's avatar/handle on these pages, so detection is safe.
    // v2.4.93: added so the active account locks in even when the bot
    // opens the tab directly on /notifications etc.
    if (/^\/notifications\b/.test(path)) return true;
    if (/^\/inbox\b/.test(path)) return true;
    if (/^\/your_activity\b/.test(path)) return true;
    // Own profile: hardened detector confirms an "Edit profile" affordance
    // exists inside <main>, which only renders on the logged-in user's profile.
    if (isOnOwnProfilePage()) return true;
    return false;
  } catch {
    return false;
  }
}

// Returns true if the current page is one where we should NEVER overwrite a
// previously-detected active account. Post/reel pages (the exact URLs a user
// pastes for commenters targeting) and other users' profile pages render a
// prominent non-logged-in-user avatar; a partially-hydrated DOM on those
// surfaces can yield a wrong detection that would clobber the connected
// account in `futnor_active_account` and make health stats + DM scripts show
// the commenter-target's account instead of the user's own.
function isUnsafeOverwriteSurface() {
  try {
    const path = (window.location && window.location.pathname) || '';
    if (/^\/(p|reel|reels|tv|explore|stories|direct)\b/.test(path)) return true;
    // /<someusername>/ or /<someusername>/<sub>/ when it isn't our own profile
    // (no "Edit profile" affordance visible). This catches commenter profile
    // navigations during the network loop.
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 1 && !RESERVED_PROFILE_SEGMENTS.has(segments[0])) {
      if (!isOnOwnProfilePage()) return true;
    }
    const ownProfileLink = document.querySelector('nav a[href^="/"], [role="navigation"] a[href^="/"]');
    if (!ownProfileLink && !isOnOwnProfilePage()) return true;
    return false;
  } catch {
    return false;
  }
}

// Push a detected username to storage so every other surface (dashboard bridge,
// background worker, other content scripts) updates without another round trip.
async function persistDetectedUsername(username) {
  const normalized = (username || '').toString().toLowerCase().trim();
  if (!isPlausibleUsername(normalized)) return false;

  // First hard guard — even before the storage-loaded account resolves,
  // refuse to persist a value that is literally the profile we are
  // viewing (unless it's our own profile). This kills the reinjection
  // race where `contentActiveAccount` hasn't loaded yet and the proactive
  // observer would otherwise stamp the visited commenter as the connected
  // account on first mutation.
  if (detectedMatchesViewedProfile(normalized)) {
    console.log(
      '[Futnor Instagram] Rejecting detection — matches viewed profile URL:',
      window.location.pathname,
      `(detected=${normalized})`
    );
    return false;
  }

  // Wait for the stored active-account load to resolve so the guards below
  // (which compare against `contentActiveAccount`) see a valid value — not
  // the null they'd see during the first few hundred ms of content-script
  // life, when the observer starts firing before the storage read finishes.
  try { await contentAccountReady; } catch {}

  if (contentActiveAccount === normalized) return true;

  // HARD UNIVERSAL GATE (v2.4.51) — never relax this.
  // Persistence is allowed ONLY from a known-safe surface (IG home, /direct,
  // /accounts/edit, or the user's confirmed own-profile page). This makes it
  // structurally impossible for the bot — which navigates to commenter and
  // target profiles during a session — to ever stamp a visited profile as
  // the connected account. Even on a brand-new install with empty storage,
  // the first detection must happen on a safe surface or it is rejected.
  //
  // If you are tempted to widen this gate, DO NOT. The Account Health
  // Score, DM history, processed-account dedupe, and per-account script
  // bulks all key off `futnor_active_account`. A wrong write here corrupts
  // every one of those systems and is exactly the bug that produced
  // "every visited profile shows up in Account Health".
  if (!isSafeDetectionSurface()) {
    console.log(
      '[Futnor Instagram] Rejecting active-account write — page is not a safe detection surface:',
      window.location.pathname,
      `(detected=${normalized}, current=${contentActiveAccount || '(none)'})`
    );
    return false;
  }


  // Legacy unsafe-surface guard kept as defense in depth — even though
  // `isSafeDetectionSurface()` above already blocks every unsafe page,
  // we keep this so a regression to that predicate doesn't immediately
  // re-open the bug.
  if (contentActiveAccount && isUnsafeOverwriteSurface()) {
    console.log(
      '[Futnor Instagram] Skipping active-account overwrite on unsafe page:',
      window.location.pathname,
      `(keep=${contentActiveAccount}, detected=${normalized})`
    );
    return false;
  }


  try {
    await chrome.storage.local.set({ futnor_active_account: normalized });
    contentActiveAccount = normalized;
    console.log('[Futnor Instagram] Pushed detected username to storage:', normalized);
    return true;
  } catch (e) {
    console.warn('[Futnor Instagram] Failed to persist detected username:', e?.message);
    return false;
  }
}

// Proactive self-detection: run once immediately, then again whenever the DOM
// changes (IG is a single-page app that hydrates its nav incrementally). Stop
// as soon as we detect a username or after a 2-minute ceiling — whichever
// comes first — so a permanently-logged-out tab can't keep the observer alive
// indefinitely. This is what makes detection work on tiers without warm-up:
// the user opens IG and within a few seconds the nav hydrates and we push.
(function startProactiveDetection() {
  let resolved = false;
  const finish = () => {
    if (resolved) return;
    const username = detectLoggedInUsernameFromDOM();
    if (username) {
      resolved = true;
      persistDetectedUsername(username);
      observer.disconnect();
      clearInterval(intervalHandle);
      clearTimeout(ceilingHandle);
    }
  };

  // MutationObserver catches SPA hydration. We batch by only checking on
  // childList/subtree mutations since IG's nav renders via DOM insertions.
  const observer = new MutationObserver(() => finish());
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}

  // Belt-and-suspenders poll (handles scripts injected into a mostly-static
  // page where MutationObserver may not fire promptly).
  const intervalHandle = setInterval(finish, 1500);

  // Hard ceiling — stop observing after 2 minutes. If the user hasn't logged
  // in by then, they'll trigger detection again on their next interaction.
  const ceilingHandle = setTimeout(() => {
    observer.disconnect();
    clearInterval(intervalHandle);
  }, 120000);

  // Immediate first attempt — covers cases where the nav is already present.
  finish();
})();

async function refreshDMHistoryCache() {
  await contentAccountReady; // Ensure account is loaded before using scoped key
  const key = getDMHistoryKey();
  const rawHistory = await new Promise((resolve) => {
    chrome.storage.local.get({ [key]: [] }, (data) => resolve(data[key]));
  });

  const normalized = Array.isArray(rawHistory)
    ? rawHistory
        .map(normalizeDMHistoryEntry)
        .filter((entry, idx, arr) => !!entry && arr.indexOf(entry) === idx)
    : [];

  dmHistoryCache = new Set(normalized);
  return normalized;
}

async function refreshProcessedAccountsCache() {
  await contentAccountReady; // Ensure account is loaded before using scoped key
  const key = getProcessedAccountsKey();
  const rawProcessed = await new Promise((resolve) => {
    chrome.storage.local.get({ [key]: [] }, (data) => resolve(data[key]));
  });

  const normalized = Array.isArray(rawProcessed)
    ? rawProcessed
        .map((entry) => normalizeUsername(entry))
        .filter((entry, idx, arr) => !!entry && arr.indexOf(entry) === idx)
    : [];

  processedAccountsCache = new Set(normalized);
  return normalized;
}

async function getDMHistory() {
  return refreshDMHistoryCache();
}

async function addToDMHistory(entry) {
  const normalized = normalizeDMHistoryEntry(entry);
  if (!normalized) return;

  await contentAccountReady; // Ensure account is loaded before using scoped key
  if (!dmHistoryCache.has(normalized)) {
    dmHistoryCache.add(normalized);
    const key = getDMHistoryKey();
    await chrome.storage.local.set({ [key]: Array.from(dmHistoryCache) });
  }
}

async function addToProcessedAccounts(entry) {
  const normalized = normalizeUsername(entry);
  if (!normalized) return;

  await contentAccountReady; // Ensure account is loaded before using scoped key
  if (!processedAccountsCache.has(normalized)) {
    processedAccountsCache.add(normalized);
    const key = getProcessedAccountsKey();
    await chrome.storage.local.set({ [key]: Array.from(processedAccountsCache) });
  }
}

function isInDMHistory(entry) {
  const normalized = normalizeDMHistoryEntry(entry);
  return !!normalized && dmHistoryCache.has(normalized);
}

function isInProcessedAccounts(entry) {
  const normalized = normalizeUsername(entry);
  return !!normalized && processedAccountsCache.has(normalized);
}

// Keep caches hot across long sessions so every targeting method sees newly processed accounts immediately
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Update active account if it changed
  if (changes.futnor_active_account) {
    const newAccount = changes.futnor_active_account.newValue;
    if (newAccount && newAccount !== contentActiveAccount) {
      console.log('[Futnor Instagram] Active account updated:', newAccount);
      contentActiveAccount = newAccount;
      // Reload caches for the new account
      refreshDMHistoryCache();
      refreshProcessedAccountsCache();
    }
  }

  const dmKey = getDMHistoryKey();
  const paKey = getProcessedAccountsKey();

  if (changes[dmKey]) {
    const incoming = changes[dmKey].newValue;
    const normalized = Array.isArray(incoming)
      ? incoming.map(normalizeDMHistoryEntry).filter(Boolean)
      : [];
    dmHistoryCache = new Set(normalized);
  }

  if (changes[paKey]) {
    const incoming = changes[paKey].newValue;
    const normalized = Array.isArray(incoming)
      ? incoming.map((entry) => normalizeUsername(entry)).filter(Boolean)
      : [];
    processedAccountsCache = new Set(normalized);
  }
});

// True for any DM thread URL — including /direct/t/{id}/, the Creator
// /Business "partnerships" inbox at /direct/partnerships/t/{id}/, and the
// /direct/requests/t/{id}/ message-request inbox. Earlier checks only matched
// the bare /direct/t/ shape, so the bot treated partnerships threads as
// "not a thread" and dropped into the wrong composer-detection branches.
function isOnInstagramDirectThread() {
  return /\/direct\/(?:[a-z_]+\/)?t\/\d+/.test(window.location.pathname);
}

function extractCurrentThreadId() {
  const match = window.location.pathname.match(/\/direct\/(?:[a-z_]+\/)?t\/(\d+)/);
  return match ? `thread_${match[1]}` : null;
}


function extractCurrentThreadUsername(contextNode = null) {
  // On /direct/inbox/ split-view, the active thread can render in the right pane while the
  // URL stays /direct/inbox. In that layout, derive the username from the active thread root
  // first, not from the global page header/nav.
  const threadRoot = getDMThreadRoot(contextNode instanceof HTMLElement ? contextNode : getDMComposer());
  if (threadRoot instanceof HTMLElement) {
    const scopedHeaderLink = threadRoot.querySelector('header a[href^="/"]')
      || threadRoot.querySelector('a[href^="/"][role="link"]')
      || threadRoot.querySelector('div[role="heading"] a[href^="/"]');

    if (scopedHeaderLink) {
      const href = scopedHeaderLink.getAttribute('href');
      const parsed = parseInstagramUsernameFromHref(href || '');
      if (parsed) return parsed;
    }
  }

  // On /direct/inbox/ (no specific thread), the generic header query can pick up nav-bar links
  // rather than the conversation partner. Only fall back to page-wide header parsing after the
  // scoped active-thread lookup above.
  const onInboxOnly = window.location.pathname.includes('/direct/inbox')
                   && !isOnInstagramDirectThread();
  if (onInboxOnly) {
    return extractCurrentThreadId();
  }

  // Prefer actual profile links in thread header
  const headerEl = document.querySelector('header a[href^="/"]')
    || document.querySelector('div[role="heading"] a[href^="/"]')
    || document.querySelector('a[role="link"][href^="/"][tabindex="0"]');

  if (headerEl) {
    const href = headerEl.getAttribute('href');
    const parsed = parseInstagramUsernameFromHref(href || '');
    if (parsed) return parsed;
  }

  // If no reliable username is available, fall back to thread id only.
  return extractCurrentThreadId();
}

function getDMThreadRoot(contextNode = null) {
  if (contextNode instanceof HTMLElement) {
    // 0. Inbox split-view / full-page thread: prefer the nearest conversation pane that
    // actually contains the composer/message list, not the whole page main area. This
    // prevents thread analysis from reading the left sidebar/search pane and missing a
    // successful send in the active right-hand thread.
    //
    // CRITICAL: the pane MUST contain BOTH the message grid AND the composer.
    // Returning a composer-only wrapper (a deep <form> parent that doesn't include
    // the message list) made analyzeDMConversation report zero rows, so existing
    // chats and prior DMs were missed and we re-DM'd accounts we shouldn't have.
    const formParent = contextNode.closest('form')?.parentElement;

    // Walk up from contextNode to find the nearest position:fixed ancestor.
    // For the floating chat widget this IS the thread root — it lives outside
    // <main> and contains BOTH the message list and the composer. Without
    // this, the pane-candidate climb stops at a composer-only wrapper and
    // analyzeDMConversation reports zero rows even when the widget has prior
    // messages, which is what made the bot re-DM existing chats in the widget.
    let fixedRoot = null;
    {
      let node = contextNode.parentElement;
      for (let d = 0; d < 25 && node && node !== document.body; d++) {
        try {
          if (window.getComputedStyle(node).position === 'fixed') {
            fixedRoot = node;
            break;
          }
        } catch (_) {}
        node = node.parentElement;
      }
    }

    // Order matters here. We try larger / more inclusive panes FIRST so that
    // a widget without role="grid" doesn't degrade to a composer-only wrapper
    // (formParent) just because that wrapper happened to satisfy "has composer".
    // fixedRoot — the floating chat widget's container — is moved to the top
    // because for widgets it always contains both the message list and the
    // composer, even if the message list uses plain <div>s without role="row".
    const paneCandidates = [
      fixedRoot,
      contextNode.closest('[role="dialog"]'),
      contextNode.closest('[role="presentation"]'),
      formParent?.parentElement?.parentElement,
      formParent?.parentElement,
      contextNode.closest('section'),
      formParent,
      contextNode.closest('[role="main"]'),
      contextNode.closest('main'),
    ].filter((node, idx, arr) => node instanceof HTMLElement && arr.indexOf(node) === idx);

    const hasGrid = (pane) => !!pane.querySelector('[role="grid"]');
    const hasRows = (pane) => !!pane.querySelector('[role="row"], li, article');
    const hasComposer = (pane) =>
      !!pane.querySelector('[role="textbox"], [data-lexical-editor="true"], textarea');

    // Pass 1 (preferred): pane that has BOTH a message grid AND the composer.
    for (const pane of paneCandidates) {
      if (pane instanceof HTMLElement && hasGrid(pane) && hasComposer(pane)) return pane;
    }
    // Pass 2: pane with rows + composer (covers IG layouts without role="grid")
    for (const pane of paneCandidates) {
      if (pane instanceof HTMLElement && hasRows(pane) && hasComposer(pane)) return pane;
    }
    // Pass 3 (legacy): pane with grid OR rows OR composer — last resort
    for (const pane of paneCandidates) {
      if (pane instanceof HTMLElement && (hasGrid(pane) || hasRows(pane) || hasComposer(pane))) {
        return pane;
      }
    }

    // 1. Standard: nearest main-content ancestor (covers /direct/ page and dialog-based DMs)
    const mainArea = contextNode.closest('div[role="main"], main');
    if (mainArea) return mainArea;

    // 2. Floating chat widget: the panel is position:fixed so it has no main ancestor.
    //    Walk up the DOM tree until we find the fixed container — that IS the thread root
    //    for this widget and contains both the message list and the composer.
    let el = contextNode.parentElement;
    for (let d = 0; d < 20 && el && el !== document.body; d++) {
      try {
        if (window.getComputedStyle(el).position === 'fixed') return el;
      } catch (_) {}
      el = el.parentElement;
    }
  }
  return document.querySelector('div[role="main"]') || document.querySelector('main');
}

function analyzeDMConversation(contextNode = null) {
  const mainRoot = getDMThreadRoot(contextNode);

  if (!(mainRoot instanceof HTMLElement)) {
    return {
      hasRows: false,
      hasAnyMessages: false,
      hasOutgoingMessages: false,
      texts: [],
    };
  }

  const outgoingHints = ['you sent', 'your message', 'sent by you', 'you replied'];

  const isComposerNode = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    return !!(
      node.closest('form')
      || node.closest('[role="textbox"]')
      || node.closest('[data-lexical-editor="true"]')
      || node.isContentEditable
    );
  };

  // A row counts as a real message only if it has message-bubble structural signals.
  // This filters out profile headers, "Active now" status, date separators, and
  // Instagram's empty-thread suggestion bubbles ("Hi!", "Hello!", etc.) which otherwise
  // get mis-detected as messages.
  const hasMessageBubbleSignal = (row) => {
    if (!(row instanceof HTMLElement)) return false;
    if (isComposerNode(row)) return false;

    // Walk all descendant aria-labels
    const labeled = row.querySelectorAll('[aria-label]');
    for (const el of labeled) {
      if (isComposerNode(el)) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (!aria) continue;
      if (aria.includes('double tap to like')) return true;
      if (aria.includes('message from')) return true;
      if (aria.includes('you sent') || aria.includes('sent by you')
          || aria.includes('your message') || aria.includes('you replied')) return true;
      if (/\bsent\s+at\b/.test(aria)) return true;
      if (/\bsent:\s/.test(aria)) return true;
      if (/\b(sent|replied)\s+\d/.test(aria)) return true;
    }
    return false;
  };

  const hasOutgoingAlignment = (node) => {
    if (!(node instanceof HTMLElement)) return false;

    let current = node;
    for (let depth = 0; depth < 5 && current; depth++) {
      if (isComposerNode(current)) return false;

      const style = window.getComputedStyle(current);
      if (
        style.justifyContent === 'flex-end'
        || style.alignSelf === 'flex-end'
        || style.marginLeft === 'auto'
      ) {
        return true;
      }

      const inlineStyle = (current.getAttribute('style') || '').toLowerCase();
      if (
        inlineStyle.includes('justify-content: flex-end')
        || inlineStyle.includes('align-self: flex-end')
        || inlineStyle.includes('margin-left: auto')
      ) {
        return true;
      }

      current = current.parentElement;
    }

    return false;
  };

  const scopeCandidates = [
    contextNode instanceof HTMLElement ? contextNode.closest('[role="grid"]') : null,
    mainRoot.querySelector('[role="grid"]'),
    mainRoot.querySelector('section'),
    mainRoot,
  ].filter((scope, idx, arr) => scope instanceof HTMLElement && arr.indexOf(scope) === idx);

  for (const scope of scopeCandidates) {
    const rows = Array.from(scope.querySelectorAll('[role="row"], li, article')).filter(
      (row) => row instanceof HTMLElement && !isComposerNode(row)
    );

    if (rows.length === 0) continue;

    const texts = [];
    const seenTexts = new Set();
    let hasAnyMessages = false;
    let hasOutgoingMessages = false;

    const explicitOutgoingNode = scope.querySelector('[aria-label*="you sent" i], [aria-label*="sent by you" i], [aria-label*="your message" i]');
    if (explicitOutgoingNode && !isComposerNode(explicitOutgoingNode)) {
      hasOutgoingMessages = true;
      hasAnyMessages = true;
    }

    for (const row of rows) {
      // STRICT: only rows with a real message-bubble signal count as messages.
      if (!hasMessageBubbleSignal(row)) continue;

      hasAnyMessages = true;

      const rowText = normalizeOutgoingMessage(row.textContent || '');
      const rowAria = (row.getAttribute('aria-label') || '').toLowerCase();

      if (outgoingHints.some((hint) => `${rowAria} ${rowText.toLowerCase()}`.includes(hint))) {
        hasOutgoingMessages = true;
      }

      if (rowText && !seenTexts.has(rowText)) {
        seenTexts.add(rowText);
        texts.push(rowText);
      }

      const messageNodes = Array.from(row.querySelectorAll('[dir="auto"], span[aria-label], div[aria-label], span, p')).filter(
        (node) => node instanceof HTMLElement && !isComposerNode(node)
      );

      for (const node of messageNodes) {
        const text = normalizeOutgoingMessage(node.textContent || '');
        if (!text) continue;

        if (!seenTexts.has(text)) {
          seenTexts.add(text);
          texts.push(text);
        }

        const aria = (node.getAttribute('aria-label') || '').toLowerCase();
        if (outgoingHints.some((hint) => `${aria} ${text.toLowerCase()}`.includes(hint))) {
          hasOutgoingMessages = true;
        }

        if (hasOutgoingAlignment(node) || hasOutgoingAlignment(row)) {
          hasOutgoingMessages = true;
        }
      }
    }

    return {
      hasRows: true,
      hasAnyMessages,
      hasOutgoingMessages,
      texts,
    };
  }

  return {
    hasRows: false,
    hasAnyMessages: false,
    hasOutgoingMessages: false,
    texts: [],
  };
}

function threadHasExistingMessages(contextNode = null) {
  // ── ONLY DEFINITIVE SIGNAL (v2.4.122) ────────────────────────────────
  // Use ONLY explicit message-bubble aria-labels via analyzeDMConversation.
  // These labels are emitted by Instagram on real message rows:
  //   • "Double tap to like"  (on message bubbles)
  //   • "Message from <user>" (on incoming messages)
  //   • "You sent", "Sent by you", "Your message", "You replied"
  //   • "Sent at HH:MM", "Sent: ...", "Sent N seconds ago"
  // No fresh thread renders these labels.
  //
  // The previous looksLikeExistingConversation heuristic was firing on
  // fresh threads too — patterns like "Sent" appearing in a profile bio
  // ("...help people send better emails...") matched the >20-char "sent"
  // regex; "X:Y am/pm" patterns could come from system text ("Last
  // active 3:45 am"); etc. User repeatedly reported false positives
  // even after v2.4.119 trimmed the row-count fallback. Removed it
  // entirely.
  //
  // Cost of a missed signal is bounded: the alreadySentOurScript
  // duplicate-send guard upstream still catches OUR exact message in
  // the thread, so we can never double-send the same script. Worst
  // case is the user sends a fresh DM into a thread where they had a
  // previous unrelated message — which is exactly what "Allow
  // Existing Chats ON" is supposed to do.
  const analysis = analyzeDMConversation(contextNode);
  return !!analysis.hasAnyMessages;
}

// Heuristic: does the thread body show characteristics of a real conversation?
// True only when we see strong positive signals (date/time markers + text)
// inside the message grid itself — NOT the page chrome / sidebar / header.
// Designed to catch existing chats that bypass aria-label / row detection.
//
// IMPORTANT: scope strictly to the message-list grid. Looking at the entire
// thread root would falsely flag fresh threads on the full-page DM inbox,
// where the left sidebar always contains weekday names + timestamps +
// avatar images for every other conversation in the inbox.
function looksLikeExistingConversation(contextNode = null) {
  // Empty placeholder takes precedence — those threads ARE empty.
  if (detectEmptyThreadPlaceholder(contextNode)) return false;

  // Locate the message area. Order:
  //   1. [role="grid"] inside the composer's pane (full-page DM, modern layouts)
  //   2. document-level [role="grid"]
  //   3. The thread root with the header + composer subtracted (chat widget
  //      fallback — IG's floating widget often does NOT use role="grid"/"row").
  let scanRoot = null;
  let composerForm = null;
  let headerEl = null;
  if (contextNode instanceof HTMLElement) {
    composerForm = contextNode.closest('form');
    const root = getDMThreadRoot(contextNode);
    if (root instanceof HTMLElement) {
      headerEl = root.querySelector('header, [role="banner"], [role="heading"]') || null;
      scanRoot = root.querySelector('[role="grid"]') || null;
      if (!scanRoot) scanRoot = root; // chat-widget fallback
    }
  }
  if (!(scanRoot instanceof HTMLElement)) {
    scanRoot = document.querySelector('[role="grid"]');
  }
  if (!(scanRoot instanceof HTMLElement)) return false;

  // Helper: is this node inside the chrome (header / composer / profile-preview
  // card)? Fresh-thread surfaces show a profile preview above the empty grid
  // (avatar + display name + follower count + bio + "View profile" button),
  // and the floating widget header carries "Active 3h ago" status text. Both
  // would falsely match heuristics if we scanned them. We therefore exclude
  // anything inside <header>, [role="banner"], [role="heading"], links to a
  // profile (View profile / display-name link), and the composer form.
  const profilePreviewLinks = new Set();
  if (scanRoot instanceof HTMLElement) {
    for (const a of scanRoot.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      // Profile-preview cards link to /{username}/ — anything that points to
      // a user profile in the message area is preview chrome, not a message.
      if (/^\/[a-z0-9._]{2,30}\/?$/i.test(href.split('?')[0])) {
        profilePreviewLinks.add(a);
      }
    }
  }
  const isChrome = (node) => {
    if (!(node instanceof Node)) return false;
    if (composerForm && composerForm.contains(node)) return true;
    if (headerEl && headerEl.contains(node)) return true;
    for (const link of profilePreviewLinks) {
      if (link.contains(node)) return true;
    }
    return false;
  };

  // Build a clean text blob from text-bearing leaf nodes that are NOT chrome.
  const messageLeafTexts = [];
  try {
    const leaves = scanRoot.querySelectorAll('span, p, div[dir="auto"]');
    const seen = new Set();
    for (const node of leaves) {
      if (isChrome(node)) continue;
      if (node.children.length > 0) continue; // skip non-leaf containers
      const t = (node.textContent || '').trim();
      if (!t || t.length < 2) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      messageLeafTexts.push(t);
    }
  } catch (_) {}

  const messageText = messageLeafTexts.join(' ').toLowerCase();
  if (messageText.length < 5) return false;

  // ONLY use the strongest signals — patterns that genuinely do not appear
  // on a fresh thread. Earlier versions also fired on "≥2 images" and
  // "≥8 text leaves", but Instagram's profile-preview card on fresh threads
  // shows multiple avatars and many text leaves (display name, handle,
  // follower count, bio lines, "View profile" button), which made the bot
  // mistake fresh threads for existing chats and refuse to send DMs. Those
  // counters have been removed.
  //
  // What's left:
  //   • HH:MM am/pm timestamps in non-chrome text → real message metadata
  //   • "seen" / "delivered" status → only ever next to a sent message
  //   • "sent" as a whole word with ≥20 chars supporting text → sent-status
  //
  // These three signals never appear on a fresh thread's UI chrome.
  if (/\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(messageText)) return true;
  if (/\b(seen|delivered)\b/i.test(messageText) && messageText.length > 15) return true;
  if (/(^|[^a-z])sent($|[^a-z])/.test(messageText) && messageText.length > 20) return true;

  return false;
}

function threadHasAnyMessages(contextNode = null) {
  return threadHasExistingMessages(contextNode);
}

// ─── HARDENED FRESH-THREAD CONFIRMATION ─────────────────────────────────────
// Instagram's floating DM composer sometimes renders the textbox BEFORE existing
// messages are painted. A naive "no messages yet → safe to send" check races the
// renderer and ends up DMing accounts that already have a chat history.
//
// This helper waits for ONE of two definitive verdicts before returning:
//   • 'existing' — bubbles or "you sent" markers appeared (skip the DM)
//   • 'empty'    — Instagram surfaced an explicit empty-thread placeholder
//                  ("Send the first message", "No messages yet", etc.) OR
//                  we observed N consecutive stable polls with zero rows AND
//                  zero loading skeletons in the message area.
//
// If neither verdict is reached within the timeout, we FAIL CLOSED and report
// 'existing' so the bot skips the account rather than risk double-messaging.
function detectEmptyThreadPlaceholder(contextNode = null) {
  const root = getDMThreadRoot(contextNode) || document.body;
  if (!(root instanceof HTMLElement)) return false;
  const PHRASES = [
    'send the first message',
    'no messages yet',
    'start a new conversation',
    'say hi to start the conversation',
    'send a message to start the chat',
    'this is the beginning of your message history',
  ];
  const text = (root.innerText || root.textContent || '').toLowerCase();
  return PHRASES.some((p) => text.includes(p));
}

function detectMessageLoadingSkeleton(contextNode = null) {
  const root = getDMThreadRoot(contextNode) || document.body;
  if (!(root instanceof HTMLElement)) return false;
  // Instagram uses spinners / skeleton placeholders while history hydrates.
  return !!(
    root.querySelector('svg[aria-label="Loading..."]')
    || root.querySelector('[role="progressbar"]')
    || root.querySelector('[aria-label*="loading" i]')
  );
}

// Returns one of: 'existing', 'empty', 'unknown'
//
// SIMPLIFIED (v2.4.122): only consults message-bubble aria-labels via
// threadHasExistingMessages. The previous version also looked at
// analysis.hasRows and looksLikeExistingConversation, both of which
// were firing on FRESH threads (profile-preview rows count as
// hasRows; bio text containing "sent" or "X:Y am" matches the
// heuristic). Now: existing = aria-labels present, empty = not.
async function confirmThreadFreshness(composer, { maxWaitMs = 10000, stableChecks = 3, minWarmupMs = 2500 } = {}) {
  const startedAt = Date.now();
  let stableEmptyCount = 0;

  while (Date.now() - startedAt < maxWaitMs) {
    // 1. Definitive existing-chat signal: explicit message-bubble aria-labels.
    if (threadHasExistingMessages(composer)) return 'existing';

    // 2. Warm-up: give IG up to minWarmupMs to paint message bubbles after
    //    the thread opens before declaring 'empty'. Skipping this races
    //    a slow-hydrating thread.
    if (Date.now() - startedAt < minWarmupMs) {
      await sleep(400);
      continue;
    }

    // 3. Stable empty: no message-bubble aria-labels for `stableChecks`
    //    consecutive polls AND the page isn't still loading. We do NOT
    //    require analysis.hasRows=false anymore — fresh threads render
    //    a profile-preview card as rows, which made the old check never
    //    reach the empty verdict and forced 'unknown' (which then
    //    skipped under Allow-Existing-Chats-OFF).
    const loading = detectMessageLoadingSkeleton(composer);
    if (!loading) {
      stableEmptyCount++;
      if (stableEmptyCount >= stableChecks) return 'empty';
    } else {
      stableEmptyCount = 0;
    }

    await sleep(400);
  }

  // Timed out — best-effort verdict based on the last aria-label scan.
  // Since the bot's allowExistingChats=false path treats 'unknown' as
  // skip-target, default to 'empty' here so a slow page doesn't lose
  // the user a send.
  return 'empty';
}

// ─── DM DELIVERY-FAILURE DETECTION ─────────────────────────────────────────
// Instagram sometimes "sends" a DM (composer clears, message bubble appears)
// but then marks it as undelivered with a red ✕ / "Not delivered" / "Tap to
// retry" indicator — typically because the account just hit a hidden DM rate
// limit. The bot must NOT count these as successful sends, and the session
// must stop immediately so we don't burn through more attempts that will all
// fail and increase the chance of an action-block.
//
// Two surfaces to scan:
//   1. The just-sent message bubble in the active thread (red X / status text)
//   2. Modal dialogs: "We restrict certain activity", "Try again later",
//      "Action blocked", "We limit how often" (true rate-limit modals)
// v2.4.139: TIGHTENED. The previous "try again" entry was matching any
// real message bubble containing those words ("let's try again
// tomorrow", "see you when you try again", etc) — IG would show a
// generic transient "Something went wrong, try again" toast on
// successful sends and our verifier would false-flag the DM as
// not_delivered. User reported "Bot said something went wrong, bot
// continued to successfully send DM but bot is failing to mark DM as
// sent successfully". The bare "try again" was the source.
//
// Now we only match "try again" when it's preceded by "tap to" or
// followed by " later" — both unambiguous error indicators.
const DM_DELIVERY_FAILURE_PHRASES = [
  'not delivered',
  "couldn't send",
  'couldn’t send', // unicode apostrophe variant
  'could not send',
  'message failed',
  'failed to send',
  'tap to retry',
  'tap to try again',
  'message not sent',
  'unable to send',
];

// v2.4.141: REMOVED 'try again later'. IG shows a generic
// "Something went wrong. Please try again later." toast/dialog on
// successful sends sometimes — that toast contains "try again later"
// and was matching our rate-limit detector, flagging real sends as
// action_blocked_modal. Bot logged "DM could not be sent" while the
// DM had actually landed. User reported this for multiple sessions.
//
// Each phrase below is now UNIQUE to IG's actual bot-restriction
// modals. None appear in transient error toasts.
const DM_RATE_LIMIT_MODAL_PHRASES = [
  'we restrict certain activity',
  'we limit how often',
  'action blocked',
  'temporarily blocked',
  'restricted from',
  'this action was blocked',
  'we removed your post', // sometimes shown after spam-flag DMs
];

function _futnorTextContainsAny(text, phrases) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const p of phrases) {
    if (lower.includes(p)) return p;
  }
  return null;
}

// Look for an action-blocked / rate-limit modal anywhere on the page.
// Returns the matched phrase (truthy) or null.
function detectDMRateLimitModal() {
  try {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const d of dialogs) {
      if (!(d instanceof HTMLElement)) continue;
      // Skip the composer dialog itself (which contains the message we're typing)
      if (d.querySelector('[contenteditable="true"], [data-lexical-editor="true"]')) continue;
      const txt = (d.textContent || '').trim();
      if (!txt) continue;
      const hit = _futnorTextContainsAny(txt, DM_RATE_LIMIT_MODAL_PHRASES);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

// Look for a delivery-failure indicator on the most recent outgoing
// message bubble in the active thread. Returns the matched phrase or null.
function detectDMDeliveryFailureInThread(contextNode = null) {
  try {
    const root = (typeof getDMThreadRoot === 'function')
      ? getDMThreadRoot(contextNode)
      : (document.querySelector('[role="grid"]') || document.body);
    if (!(root instanceof HTMLElement)) return null;

    // 1. Direct aria-label / title scan: IG marks failed bubbles with
    //    aria-labels like "Not delivered. Tap to retry."
    const failureNodes = root.querySelectorAll(
      '[aria-label*="not delivered" i],' +
      '[aria-label*="tap to retry" i],' +
      '[aria-label*="failed to send" i],' +
      '[aria-label*="message failed" i],' +
      '[aria-label*="couldn\'t send" i],' +
      '[aria-label*="couldn’t send" i],' +
      '[aria-label*="unable to send" i],' +
      '[title*="not delivered" i],' +
      '[title*="tap to retry" i]'
    );
    if (failureNodes.length > 0) {
      const aria = (failureNodes[0].getAttribute('aria-label')
        || failureNodes[0].getAttribute('title')
        || 'not delivered').toLowerCase();
      return aria;
    }

    // 2. Text-content scan on the LAST 3 rows only — older bubbles can
    //    legitimately contain unrelated text matching our phrases (e.g. a
    //    user reply saying "try again"), so we restrict to recently sent ones.
    const rows = Array.from(root.querySelectorAll('[role="row"], li, article'))
      .filter((r) => r instanceof HTMLElement);
    const tail = rows.slice(-3);
    for (const row of tail) {
      const txt = (row.textContent || '').trim();
      const hit = _futnorTextContainsAny(txt, DM_DELIVERY_FAILURE_PHRASES);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

// Combined check + side-channel signal to background.
// Polls for ~13 seconds because IG can take 8–10s to flip the bubble to
// "not delivered" on slow connections / when shadow-rate-limited. The
// previous 6s window let through ~half of all silently-dropped DMs (user
// reported 11 logged but only 5 actually visible in the chat list).
//
// On the LAST poll we also require a positive "message bubble is present
// with no failure indicator" check — if the composer cleared but no bubble
// rendered (the ghost-send case), we fail closed and DO NOT count the DM.
async function verifyDMDeliveryAndSignal(contextNode = null, label = 'verifyDelivery', expectedText = '') {
  const POLL_MS = 700;
  const POLLS = 18; // ~12.6s total

  const fragments = _futnorBuildExpectedFragments(expectedText);

  // ── DOUBLE-CHECK FAILURE INDICATORS (v2.4.142) ────────────────────────
  // IG sometimes shows a "Something went wrong" toast/modal that lingers
  // in the DOM around a successful send. Every time a failure indicator
  // fires, FIRST check whether our message is actually in the thread. If
  // yes, the indicator is stale chrome — treat as success. Only when an
  // indicator fires AND the message is NOT in the thread do we trust the
  // failure verdict. This is the labelling-accuracy layer.
  const wasOurMessageDelivered = () => {
    if (fragments.length === 0) return false;
    return _futnorOutgoingBubblePresent(contextNode, fragments);
  };

  for (let i = 0; i < POLLS; i++) {
    const modalHit = detectDMRateLimitModal();
    if (modalHit) {
      if (wasOurMessageDelivered()) {
        console.log(`[Human Behavior Bot] ✅ ${label}: "${modalHit}" modal present but message visible in thread — counting as delivered`);
        _futnorTryDismissBlockedModal();
        return { failed: false };
      }
      console.warn(`[Human Behavior Bot] 🛑 ${label}: rate-limit modal detected — "${modalHit}"`);
      _futnorReportDeliveryFailure('action_blocked_modal', modalHit);
      _futnorTryDismissBlockedModal();
      return { failed: true, reason: 'action_blocked_modal', phrase: modalHit };
    }

    const threadHit = detectDMDeliveryFailureInThread(contextNode);
    if (threadHit) {
      if (wasOurMessageDelivered()) {
        console.log(`[Human Behavior Bot] ✅ ${label}: "${threadHit}" indicator visible but message landed — counting as delivered`);
        return { failed: false };
      }
      console.warn(`[Human Behavior Bot] 🛑 ${label}: delivery failure indicator on bubble — "${threadHit}"`);
      _futnorReportDeliveryFailure('not_delivered', threadHit);
      return { failed: true, reason: 'not_delivered', phrase: threadHit };
    }

    if (fragments.length > 0 && _futnorOutgoingBubblePresent(contextNode, fragments)) {
      console.log(`[Human Behavior Bot] ✅ ${label}: outgoing bubble matched expected text on poll ${i + 1}`);
      return { failed: false };
    }

    await sleep(POLL_MS);
  }

  if (fragments.length > 0 && _futnorOutgoingBubblePresent(contextNode, fragments)) {
    console.log(`[Human Behavior Bot] ✅ ${label}: outgoing bubble matched on final check`);
    return { failed: false };
  }

  if (fragments.length > 0) {
    try {
      const finalSnapshot = analyzeDMConversation(contextNode);
      if (finalSnapshot && finalSnapshot.hasOutgoingMessages) {
        console.log(`[Human Behavior Bot] ✅ ${label}: outgoing message present in final snapshot — accepting`);
        return { failed: false };
      }

      // ── GHOST SEND (v2.4.153) ─────────────────────────────────────────
      // We tried to send, waited ~13s, and the thread contains NOT ONE
      // outgoing message. Not "we couldn't match the text" — zero outgoing
      // bubbles at all. Nothing was delivered.
      //
      // This is the case the fail-open below used to swallow. The upstream
      // send-confirm treats "composer went blank" and "composer vanished" as
      // success, which is exactly what a rejected send looks like, so a DM
      // that never left the browser was counted as delivered and the
      // recipient was written into DM history and never retried.
      //
      // `ghost_send` is the one failure reason background.js deliberately
      // does NOT hard-stop the session for — it logs, declines to count the
      // DM, and moves to the next target. That handler has existed since
      // v2.4.x with nothing ever emitting it; this is the missing emitter.
      //
      // Deliberately narrow: it needs a definite empty-outgoing reading, so a
      // flaky text match cannot trigger it. If it is ever wrong the cost is
      // one uncounted DM and one revisit next session, where the pre-send
      // duplicate check in executeValidatedDMFlow catches the existing
      // message and skips. It cannot cause a double-send.
      if (finalSnapshot && finalSnapshot.hasOutgoingMessages === false) {
        console.warn(`[Human Behavior Bot] 👻 ${label}: no outgoing message exists in this thread after send — ghost send, NOT counting`);
        _futnorReportDeliveryFailure('ghost_send', 'composer cleared but no outgoing bubble rendered');
        return { failed: true, reason: 'ghost_send', phrase: 'no outgoing bubble' };
      }
    } catch (e) {
      console.warn(`[Human Behavior Bot] ${label}: final snapshot fallback errored — being permissive:`, e?.message || e);
      return { failed: false };
    }
  }

  // ── INNOCENT-UNTIL-PROVEN-GUILTY (v2.4.138) ─────────────────────────
  // No failure modal or "Not delivered" indicator was seen during the
  // entire ~13s poll window, and the thread does have outgoing traffic —
  // we just couldn't pin our exact text to a bubble. Trust the upstream
  // send-confirm signal.
  // Real account-suspension events ALWAYS surface as detectDMRateLimitModal
  // (action-blocked / temporarily-blocked dialogs) — those still fail
  // hard above, so account safety is unaffected by this fail-open.
  console.log(`[Human Behavior Bot] ✅ ${label}: no failure signals during ${POLLS} polls — counting as delivered`);
  return { failed: false };
}

// Build a list of candidate fragments from the expected message text, ordered
// from most-specific to most-permissive. A successful match against any one
// counts. We keep two parallel forms:
//   • "loose" — lowercased plaintext fragment (preserves spaces/punct)
//   • "compact" — alphanumerics only, so we tolerate Instagram's invisible
//     characters, soft-hyphens, zero-width joiners, etc.
function _futnorBuildExpectedFragments(expectedText) {
  if (!expectedText || typeof expectedText !== 'string') return [];

  const cleaned = expectedText
    .toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-z0-9]+/, '');
  if (!cleaned) return [];

  const compactFull = cleaned.replace(/[^a-z0-9]/g, '');

  const fragments = [];
  const pushUnique = (kind, value, minLen) => {
    if (!value || value.length < minLen) return;
    const tag = `${kind}:${value}`;
    if (!fragments.find((f) => f.tag === tag)) fragments.push({ kind, value, tag });
  };

  pushUnique('loose', cleaned.slice(0, 32), 8);
  pushUnique('loose', cleaned.slice(0, 24), 8);
  pushUnique('loose', cleaned.slice(0, 16), 6);
  pushUnique('compact', compactFull.slice(0, 24), 6);
  pushUnique('compact', compactFull.slice(0, 16), 5);
  pushUnique('compact', compactFull.slice(0, 10), 4);

  return fragments;
}

// Scan the last several rows of the active thread for an outgoing bubble whose
// text contains any of the candidate fragments. We check the last 6 rows
// (instead of 4) because Instagram's virtualized list sometimes pushes our
// bubble below e.g. a "seen at" status row or an inline date separator.
function _futnorOutgoingBubblePresent(contextNode, fragments) {
  try {
    if (!Array.isArray(fragments) || fragments.length === 0) return false;

    const root = (typeof getDMThreadRoot === 'function')
      ? getDMThreadRoot(contextNode)
      : (document.querySelector('[role="grid"]') || document.body);
    if (!(root instanceof HTMLElement)) return false;

    const rows = Array.from(root.querySelectorAll('[role="row"], li, article'))
      .filter((r) => r instanceof HTMLElement);
    const tail = rows.slice(-6);

    // Row-tail scan (preferred): check the last 6 rows for the fragment.
    for (const row of tail) {
      const rowLoose = (row.textContent || '').toLowerCase();
      const rowCompact = rowLoose.replace(/[^a-z0-9]/g, '');
      for (const f of fragments) {
        if (f.kind === 'loose' && rowLoose.includes(f.value)) return true;
        if (f.kind === 'compact' && rowCompact.includes(f.value)) return true;
      }
    }

    // FALLBACK (v2.4.131, restored in v2.4.146): always also scan the
    // entire thread root. IG re-keys virtualized message rows when the
    // thread updates, so a just-sent bubble may briefly exist without
    // the role="row" wrapper — without this fallback we miss it and
    // the verifier falsely flags the send as ghost_send. The scope is
    // the thread root only (getDMThreadRoot), NOT the whole page, so
    // unrelated UI text (sidebars, modals) cannot match.
    const haystackLoose = (root.textContent || '').toLowerCase();
    const haystackCompact = haystackLoose.replace(/[^a-z0-9]/g, '');
    for (const f of fragments) {
      if (f.kind === 'loose' && haystackLoose.includes(f.value)) return true;
      if (f.kind === 'compact' && haystackCompact.includes(f.value)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function _futnorReportDeliveryFailure(reason, phrase) {
  try {
    chrome.runtime.sendMessage({
      type: 'IG_DM_DELIVERY_FAILED',
      reason,
      phrase,
      url: window.location.href,
      ts: Date.now(),
    });
  } catch (e) {
    console.warn('[Human Behavior Bot] Failed to report delivery failure to background:', e?.message || e);
  }
}

// ─── COMMENT POST-SUBMIT VERIFICATION ─────────────────────────────────────
// Mirrors verifyDMDeliveryAndSignal but tuned for the comment composer:
//  • action-blocked / rate-limit modal → hard-stop the session
//  • comment-specific phrases ("comment couldn't be posted", "limited", etc.)
//    that Instagram surfaces inline rather than as a modal
//
// Returns { failed: true, reason, phrase } if a block is detected, otherwise
// { failed: false }. Caller is responsible for whether to count the comment.
const COMMENT_FAILURE_PHRASES = [
  "comment couldn't be posted",
  "comment couldn’t be posted",
  "couldn't post comment",
  "couldn’t post comment",
  'comment failed to post',
  'comment was not posted',
  'unable to post comment',
  'try again',
  'try posting again',
  'comment limit',
  "you've reached your daily limit",
  "you’ve reached your daily limit",
];

async function verifyCommentDeliveryAndSignal(label = 'verifyComment') {
  const POLL_MS = 500;
  const POLLS = 10; // ~5s

  for (let i = 0; i < POLLS; i++) {
    const modalHit = detectDMRateLimitModal();
    if (modalHit) {
      console.warn(`[Human Behavior Bot] 🛑 ${label}: action-blocked modal during comment — "${modalHit}"`);
      try {
        chrome.runtime.sendMessage({
          type: 'IG_COMMENT_DELIVERY_FAILED',
          reason: 'action_blocked_modal',
          phrase: modalHit,
          url: window.location.href,
          ts: Date.now(),
        });
      } catch {}
      _futnorTryDismissBlockedModal();
      return { failed: true, reason: 'action_blocked_modal', phrase: modalHit };
    }

    // Inline failure toast / banner near the composer.
    try {
      const inline = document.body && (document.body.innerText || '').toLowerCase();
      const hit = _futnorTextContainsAny(inline, COMMENT_FAILURE_PHRASES.filter((p) => p !== 'try again'));
      if (hit) {
        console.warn(`[Human Behavior Bot] 🛑 ${label}: inline comment failure phrase — "${hit}"`);
        try {
          chrome.runtime.sendMessage({
            type: 'IG_COMMENT_DELIVERY_FAILED',
            reason: 'comment_limited',
            phrase: hit,
            url: window.location.href,
            ts: Date.now(),
          });
        } catch {}
        return { failed: true, reason: 'comment_limited', phrase: hit };
      }
    } catch {}

    await sleep(POLL_MS);
  }

  return { failed: false };
}

// Best-effort dismiss of the "We restrict certain activity" / "Try again later"
// modal so it doesn't sit on screen blocking the next user interaction.
function _futnorTryDismissBlockedModal() {
  try {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const d of dialogs) {
      if (!(d instanceof HTMLElement)) continue;
      const txt = (d.textContent || '').toLowerCase();
      if (!_futnorTextContainsAny(txt, DM_RATE_LIMIT_MODAL_PHRASES)) continue;
      const buttons = d.querySelectorAll('button, [role="button"]');
      for (const b of buttons) {
        const lbl = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase().trim();
        if (lbl === 'ok' || lbl === 'dismiss' || lbl === 'close' || lbl === 'got it') {
          try { b.click(); } catch {}
          return;
        }
      }
    }
  } catch {}
}

// ─── INSTAGRAM SAFETY: ACTION-BLOCK / CHECKPOINT DETECTION ──────────────────
// Instagram surfaces several dialogs when it suspects automation:
//   • "Action Blocked" / "We restrict certain activity" / "Try Again Later"
//   • Checkpoint / "Help us confirm" / "Suspicious Login Attempt"
//   • Login wall reappearing mid-session
//   • "We've detected automated behavior" warnings
// Continuing to act after any of these escalates a temporary block to a ban.
function detectInstagramBlockState() {
  const haystack = (document.body?.innerText || '').toLowerCase();

  const banSignals = [
    { needle: 'action blocked', reason: 'action_blocked' },
    { needle: 'try again later', reason: 'rate_limited' },
    { needle: 'we restrict certain', reason: 'restricted' },
    { needle: 'we limit how often', reason: 'rate_limited' },
    { needle: 'temporarily blocked', reason: 'temp_blocked' },
    { needle: 'suspicious activity', reason: 'suspicious_activity' },
    { needle: 'suspicious login', reason: 'login_challenge' },
    { needle: 'help us confirm', reason: 'checkpoint' },
    { needle: 'confirm it’s you', reason: 'checkpoint' },
    { needle: 'confirm it\'s you', reason: 'checkpoint' },
    { needle: 'unusual login attempt', reason: 'login_challenge' },
    { needle: 'we’ve detected automated', reason: 'automation_detected' },
    { needle: 'we\'ve detected automated', reason: 'automation_detected' },
    { needle: 'your account has been disabled', reason: 'account_disabled' },
    { needle: 'this account has been disabled', reason: 'account_disabled' },
    { needle: 'enter security code', reason: 'two_factor_challenge' },
    { needle: 'we noticed an attempt', reason: 'login_challenge' },
    { needle: 'please wait a few minutes', reason: 'rate_limited' },
    { needle: 'tell us if you didn’t do this', reason: 'checkpoint' },
  ];

  for (const sig of banSignals) {
    if (haystack.includes(sig.needle)) {
      return { blocked: true, reason: sig.reason, signal: sig.needle };
    }
  }

  const onLoginUrl = window.location.pathname.startsWith('/accounts/login')
                  || window.location.pathname.startsWith('/challenge')
                  || window.location.pathname.startsWith('/auth_platform');
  if (onLoginUrl) {
    return { blocked: true, reason: 'logged_out', signal: window.location.pathname };
  }

  if (window.location.href.includes('/challenge/') || window.location.href.includes('checkpoint')) {
    return { blocked: true, reason: 'checkpoint', signal: 'url' };
  }

  return { blocked: false };
}

async function reportBlockedAndStop(detection) {
  try {
    console.warn(`[Human Behavior Bot] 🛑 Instagram block detected: ${detection.reason} (${detection.signal})`);
    await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'INSTAGRAM_BLOCK_DETECTED', reason: detection.reason, signal: detection.signal },
          () => resolve(),
        );
      } catch { resolve(); }
      setTimeout(resolve, 1500);
    });
  } catch {}
}

function isElementVisibleAndEnabled(element) {
  if (!(element instanceof HTMLElement)) return false;

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  // Must be connected, not disabled, not hidden by CSS
  const basicChecks = element.isConnected
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.pointerEvents !== 'none'
    && !element.hasAttribute('disabled')
    && element.getAttribute('aria-disabled') !== 'true';

  if (!basicChecks) return false;

  // For contenteditable elements (DM composers), be more lenient on size checks
  // because floating widgets might report 0x0 initially even when functional
  const isContentEditable = element.getAttribute('contenteditable') === 'true'
    || element.hasAttribute('data-lexical-editor')
    || element.tagName === 'TEXTAREA';

  if (isContentEditable) {
    // Contenteditable elements don't need positive width/height to be functional
    // (e.g. floating widgets might be hidden until first interaction)
    // Just ensure they're not visually hidden
    return true;
  }

  // For other elements, require positive dimensions
  return !!(rect.width > 0 && rect.height > 0);
}

// Unified text reader: returns the current text from a composer element,
// handling both textarea/input (.value) and contenteditable (.textContent).
function getComposerText(el) {
  if (!el) return '';
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return el.value || '';
  }
  const raw = (typeof el.innerText === 'string' && el.innerText.length > 0)
    ? el.innerText
    : (el.textContent || '');
  return raw.replace(/\u200B/g, '');
}

function getDMComposer() {
  // Helper: reject elements that are search/navigation inputs, not message composers.
  // On the inbox split-view, Instagram renders a search box (aria-label="Search")
  // as the FIRST div[role="textbox"][contenteditable="true"] in the DOM, which used
  // to be grabbed instead of the actual message composer in the right panel.
  const isSearchOrNavInput = (el) => {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const testId = (el.getAttribute('data-testid') || '').toLowerCase();
    return (
      label.includes('search') ||
      label.includes('find') ||
      placeholder.includes('search') ||
      placeholder.includes('find people') ||
      testId.includes('search')
    );
  };

  // Helper: check if element is positioned too high on page (likely nav/header, not composer)
  const isTooHighOnPage = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.top < 50;  // If it's in the top 50px, it's probably not the message composer
  };

  const scoreComposerCandidate = (el) => {
    if (!el) return -Infinity;
    const rect = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    let score = 0;
    score += rect.left;
    score += rect.top * 0.45;
    if (label.includes('message') || placeholder.includes('message')) score += 500;
    if (el.closest('form')) score += 220;
    if (rect.top > window.innerHeight * 0.45) score += 180;
    if (rect.width > 120) score += 40;
    return score;
  };

  // Selectors ordered from most-specific (message composer) to most-generic.
  // Message aria-label selectors MUST come before the generic role="textbox" one
  // so we never accidentally grab the inbox search box on the split-view layout.
  const SELECTORS = [
    'div[contenteditable="true"][aria-label*="Message"]',
    'div[contenteditable="true"][aria-label*="message"]',
    'div[data-lexical-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',  // generic — search box excluded below
    'textarea[placeholder*="essage"]',   // textarea fallback (e.g. simpler chat input)
    'div[contenteditable="true"]',
    'p[contenteditable="true"]',
    'textarea',
  ];

  // When a dialog is visible always prefer its composer — prevents grabbing search
  // boxes or other contenteditable elements on the underlying profile page.
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog) {
    let bestDialogComposer = null;
    let bestDialogScore = -Infinity;

    for (const sel of SELECTORS) {
      for (const el of dialog.querySelectorAll(sel)) {
        if (!el || isSearchOrNavInput(el) || !isElementVisibleAndEnabled(el)) continue;
        const score = scoreComposerCandidate(el) + (el.closest('form') ? 120 : 0);
        if (score > bestDialogScore) {
          bestDialogScore = score;
          bestDialogComposer = el;
        }
      }
    }

    if (bestDialogComposer) return bestDialogComposer;
  }

  // Special handling for /direct/ pages (covers /direct/t/, /direct/inbox split-view,
  // /direct/partnerships/t/ partnerships threads, and /direct/requests/t/).
  const isDirectPage = window.location.pathname.includes('/direct/');
  if (isDirectPage) {
    const onThread = isOnInstagramDirectThread();
    const pageType = onThread ? 'thread' : '/direct/inbox';
    console.log(`[Human Behavior Bot] On ${pageType} page — searching for composer in message containers...`);
    // Try containers that are likely to have the message composer (forms, regions, etc.)
    const containers = document.querySelectorAll('form, [role="region"], main, [class*="compose"], [class*="message"], section');
    let bestDirectComposer = null;
    let bestDirectScore = -Infinity;
    for (const container of containers) {
      for (const sel of SELECTORS.slice(0, 6)) {
        const el = container.querySelector(sel);
        if (el && !isSearchOrNavInput(el) && el.isConnected) {
          // On a real thread page (/direct/t/ or /direct/partnerships/t/) use the
          // isTooHighOnPage filter; on inbox split-view skip it (composer is in right panel).
          if (onThread && isTooHighOnPage(el)) continue;
          if (isElementVisibleAndEnabled(el)) {
            const score = scoreComposerCandidate(el);
            if (score > bestDirectScore) {
              bestDirectScore = score;
              bestDirectComposer = el;
            }
          }
        }
      }
    }
    if (bestDirectComposer) {
      console.log(`[Human Behavior Bot] Found best visible composer in ${pageType} container`);
      return bestDirectComposer;
    }
  }

  // No dialog: find the best visible composer in the whole document.
  // On split-view (/direct/inbox/), there can be multiple matching elements — the
  // search box in the left panel and the actual message composer in the right panel.
  // Prefer the one with the highest x-coordinate (rightmost = conversation panel).
  // NOTE: Do NOT use isTooHighOnPage() here — split-view chat widgets can be positioned anywhere
  let bestComposer = null;
  let bestScore = -Infinity;
  for (const sel of SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el && !isSearchOrNavInput(el) && isElementVisibleAndEnabled(el)) {
        const score = scoreComposerCandidate(el);
        if (score > bestScore) {
          bestScore = score;
          bestComposer = el;
        }
      }
    }
    // If we found a composer with a message-specific selector, use it immediately
    if (bestComposer && (sel.includes('Message') || sel.includes('message') || sel.includes('lexical'))) {
      return bestComposer;
    }
  }
  if (bestComposer) return bestComposer;

  // If no visible one found, try to find ANY contenteditable even if visibility check fails
  // (floating widget might report visibility as false but still work)
  // Be more aggressive on thread pages (/direct/t/ and /direct/partnerships/t/) since
  // floating widgets can be tricky there.
  const isThreadPage = isOnInstagramDirectThread();
  for (const sel of SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el && !isSearchOrNavInput(el) && el.isConnected) {
        // For thread pages, return the first valid element found (more lenient)
        // For other pages, be stricter about visibility
        if (isThreadPage || isElementVisibleAndEnabled(el)) {
          if (isThreadPage) {
            console.log('[Human Behavior Bot] Found connected composer on direct-thread page (visibility check relaxed)');
          }
          return el;
        }
      }
    }
  }

  return null;
}

async function openMatchingInboxThread(targetUsernameHint = null) {
  const normalizedTarget = normalizeUsername(targetUsernameHint);
  // Match standard inbox threads, partnerships inbox threads, and message-request
  // threads — all three live under /direct/.../t/{id}/.
  const threadLinks = Array.from(document.querySelectorAll(
    'a[href*="/direct/t/"], a[href*="/direct/partnerships/t/"], a[href*="/direct/requests/t/"]'
  )).filter((link) => isElementVisibleAndEnabled(link));

  if (threadLinks.length === 0) return false;

  let targetThread = null;
  if (normalizedTarget) {
    targetThread = threadLinks.find((thread) => getThreadIdentifiers(thread).includes(normalizedTarget)) || null;
  }

  if (!targetThread && threadLinks.length === 1) {
    targetThread = threadLinks[0];
  }

  if (!targetThread) return false;

  console.log(`[Human Behavior Bot] Opening inbox thread${normalizedTarget ? ` for @${normalizedTarget}` : ''}...`);
  targetThread.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(350));
  await humanClick(targetThread);
  await sleep(humanDelay(1800));
  return isOnInstagramDirectThread();
}

async function waitForDMComposer(targetUsernameHint = null, maxAttempts = 15) {
  const normalizedTarget = normalizeUsername(targetUsernameHint);
  console.log(`[Human Behavior Bot] waitForDMComposer: Starting search (max ${maxAttempts} attempts)...`);

  // Guard: only attempt to auto-open an inbox thread ONCE per waitForDMComposer call.
  // Previously this fired on every attempt (attempt >= 2), which caused repeated thread
  // clicks that navigated away from the correct thread or spammed the inbox.
  let inboxThreadOpenAttempted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const composer = getDMComposer();

    if (composer) {
      // Don't scrollIntoView for dialog-contained composers — it repositions the overlay
      const isInDialog = !!composer.closest('[role="dialog"]');
      if (!isInDialog) {
        composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(humanDelay(200));
      }
      if (isElementVisibleAndEnabled(composer)) {
        const composerType = isInDialog ? 'dialog' : 'floating widget/page';
        console.log(`[Human Behavior Bot] ✅ DM composer found and ready (${composerType})`);
        return composer;
      } else {
        // Composer found but not yet visible/enabled — likely still initializing
        const rect = composer.getBoundingClientRect();
        console.log(`[Human Behavior Bot] ⚠️ Composer found but not visible/enabled yet (attempt ${attempt + 1}/${maxAttempts}, size: ${rect.width}x${rect.height})`);
      }
    } else {
      if (attempt === 0 || attempt === 4 || attempt === 9 || attempt === maxAttempts - 1) {
        console.log(`[Human Behavior Bot] Still waiting for composer... (attempt ${attempt + 1}/${maxAttempts})`);
      }
    }

    // Auto-open inbox thread only when:
    //  1. We are on /direct/inbox but NOT already on a specific thread
    //     (/direct/t/, /direct/partnerships/t/, /direct/requests/t/)
    //  2. We have given the page at least 2 attempts to render the composer naturally
    //  3. We haven't already tried this once (avoid spamming thread clicks)
    const onInboxOnly = window.location.pathname.includes('/direct/inbox')
                     && !isOnInstagramDirectThread();
    if (onInboxOnly && attempt >= 2 && !inboxThreadOpenAttempted) {
      inboxThreadOpenAttempted = true;
      console.log(`[Human Behavior Bot] On /direct/inbox (no thread open) — trying to auto-open thread...`);
      await openMatchingInboxThread(normalizedTarget);
      // Give the thread panel time to render before the next getDMComposer() check
      await sleep(humanDelay(1500));
      continue;
    }

    // For floating widgets, give them extra time to initialize before checking visibility
    const extraDelay = attempt > 5 ? 800 : 0;
    const sleepTime = 1200 + Math.min(attempt, 4) * 250 + extraDelay;
    if (attempt === maxAttempts - 1) {
      console.log(`[Human Behavior Bot] Last attempt (${attempt + 1}/${maxAttempts}), sleeping ${sleepTime}ms...`);
    }
    await sleep(sleepTime);
  }

  console.log('[Human Behavior Bot] ❌ TIMEOUT: DM composer never appeared after ' + maxAttempts + ' attempts (~' + Math.floor((1200 + Math.min(maxAttempts - 1, 4) * 250) * maxAttempts / 1000) + 's total)');
  return null;
}

function selectionIsInsideDMComposer(composer) {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !composer) return false;
    return composer.contains(selection.getRangeAt(0).commonAncestorContainer);
  } catch {
    return false;
  }
}

function placeCaretAtEndOfDMComposer(composer) {
  if (!composer || composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') return true;

  try {
    const selection = window.getSelection();
    const range = document.createRange();
    let target = composer;

    while (target && target.lastChild) {
      target = target.lastChild;
      if (target.nodeType === Node.TEXT_NODE) break;
      if (target.nodeName === 'BR') {
        range.setStartBefore(target);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      }
    }

    if (target && target.nodeType === Node.TEXT_NODE) {
      range.setStart(target, target.textContent?.length || 0);
      range.collapse(true);
    } else if (composer.lastElementChild) {
      range.selectNodeContents(composer.lastElementChild);
      range.collapse(false);
    } else {
      range.selectNodeContents(composer);
      range.collapse(false);
    }

    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  } catch {
    return false;
  }
}

async function stabilizeDMComposerForTyping(initialComposer, label = 'DM composer') {
  let composer = getDMComposer() || initialComposer;
  if (!composer) return null;

  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    try {
      composer.focus({ preventScroll: true });
    } catch {
      try { composer.focus(); } catch {}
    }
    await sleep(160);
    return getDMComposer() || composer;
  }

  const isDirectPage = window.location.pathname.includes('/direct/');
  const attempts = isDirectPage ? 8 : 6;

  const fullPointerActivate = async (el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    await sleep(30);
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(30);
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    await sleep(20);
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  for (let attempt = 0; attempt < attempts; attempt++) {
    composer = getDMComposer() || composer;
    const isInDialog = !!composer.closest('[role="dialog"]');

    if (!isInDialog) {
      composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(140);
    }

    try {
      await fullPointerActivate(composer);
    } catch {}

    await sleep(isDirectPage ? 250 : 170);

    try {
      composer.focus({ preventScroll: true });
    } catch {
      try { composer.focus(); } catch {}
    }

    try {
      composer.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
    } catch {}

    await sleep(isDirectPage ? 280 : 180);

    if (!selectionIsInsideDMComposer(composer)) {
      placeCaretAtEndOfDMComposer(composer);
      await sleep(120);
    }

    const activeInside = document.activeElement === composer || composer.contains(document.activeElement);
    if (activeInside && selectionIsInsideDMComposer(composer)) {
      console.log(`[Human Behavior Bot] ✅ ${label}: composer focused & cursor ready (${attempt + 1}/${attempts})`);
      await sleep(humanDelay(900));
      return getDMComposer() || composer;
    }
  }

  console.log(`[Human Behavior Bot] ⚠️ ${label}: could not fully confirm caret placement — continuing with current composer`);
  await sleep(humanDelay(700));
  return getDMComposer() || composer;
}

async function resetAndStabilizeDMComposerForRetry(currentComposer, label = 'DM composer retry') {
  let composer = getDMComposer() || (currentComposer instanceof HTMLElement ? currentComposer : null);
  if (!composer) return null;

  composer = await clearDMComposerContent(composer, `${label} reset`) || composer;
  await sleep(180);
  composer = await stabilizeDMComposerForTyping(getDMComposer() || composer, label) || composer;
  await sleep(180);
  return getDMComposer() || composer;
}

async function waitForMessageConfirmation(expectedMessage, beforeSnapshot, contextNode = null) {
  const normalizedExpected = normalizeOutgoingMessage(expectedMessage);
  if (!normalizedExpected) return false;

  // NOTE: We deliberately do NOT capture initialComposerText here.
  // By the time this function is called, Lexical may have already cleared the composer
  // (it processes send synchronously on the Enter event). We rely on the `composerTextBeforeSend`
  // that sendCustomMessage captures before any send attempt.
  // Were we launched from inside a dialog (message-request popup)?
  const wasInDialog = !!(contextNode instanceof HTMLElement && contextNode.closest('[role="dialog"]'));

  for (let attempt = 0; attempt < 8; attempt++) {
    const composer = getDMComposer() || (contextNode instanceof HTMLElement ? contextNode : null);
    const composerText = normalizeOutgoingMessage(getComposerText(composer));
    const afterSnapshot = analyzeDMConversation(contextNode);
    const conversationStarted = !beforeSnapshot?.hasAnyMessages && afterSnapshot.hasAnyMessages;
    const newMessageCount = Math.max(0, afterSnapshot.texts.length - (beforeSnapshot?.texts?.length || 0));

    // ── Signal 1: Composer is gone (dialog dismissed / navigated away) ──────────
    if (!composer) {
      console.log('[Human Behavior Bot] ✅ Composer gone — message sent');
      return true;
    }

    // ── Signal 2: Composer is now empty (Lexical cleared it after send) ─────────
    if (composerText.length === 0) {
      if (wasInDialog) {
        console.log('[Human Behavior Bot] ✅ Composer empty in dialog — message dispatched by Lexical');
        return true;
      }

      if (threadContainsExpectedMessage(expectedMessage, composer || contextNode)) {
        console.log('[Human Behavior Bot] ✅ Composer empty and message confirmed in thread');
        return true;
      }

      if (conversationStarted && newMessageCount > 0) {
        console.log('[Human Behavior Bot] ✅ Composer empty and conversation advanced with a new message');
        return true;
      }

      console.log('[Human Behavior Bot] Composer empty but thread confirmation is still pending...');
    }

    // ── Signal 3: Message-request dialog closed after send ──────────────────────
    // Instagram auto-dismisses the message-request popup once the request is sent.
    if (wasInDialog && !document.querySelector('[role="dialog"] div[contenteditable="true"]')) {
      console.log('[Human Behavior Bot] ✅ DM dialog dismissed — message request sent');
      return true;
    }

    // ── Signal 3: Message text appeared in conversation thread ──────────────────
    const matchingMessageAppeared = afterSnapshot.texts.some((text) => {
      const normalizedText = normalizeOutgoingMessage(text);
      return normalizedText && (
        normalizedText.includes(normalizedExpected)
        || normalizedExpected.includes(normalizedText)
      );
    });

    if (matchingMessageAppeared || (conversationStarted && newMessageCount > 0)) {
      return true;
    }

    await sleep(humanDelay(500 + attempt * 120));
  }

  return false;
}

function threadContainsExpectedMessage(expectedMessage, contextNode = null) {
  const normalizedExpected = normalizeComposerSnapshot(expectedMessage);
  if (!normalizedExpected) return false;

  const compactExpected = normalizedExpected.replace(/\s+/g, ' ').trim();
  const expectedPrefix = compactExpected.substring(0, 24);
  const analysis = analyzeDMConversation(contextNode);

  // Path A: aria-label-tagged rows (strict, fast path)
  const ariaPathHit = analysis.texts.some((text) => {
    const normalizedText = normalizeComposerSnapshot(text);
    if (!normalizedText) return false;
    if (normalizedText.includes(normalizedExpected) || normalizedExpected.includes(normalizedText)) return true;

    const compactText = normalizedText.replace(/\s+/g, ' ').trim();
    if (!compactText || !compactExpected) return false;

    return compactText.includes(compactExpected)
      || compactExpected.includes(compactText)
      || (expectedPrefix.length > 0 && compactText.includes(expectedPrefix));
  });
  if (ariaPathHit) return true;

  // Path B: direct thread-grid prefix scan. IG re-keys virtualized rows
  // when the thread updates, so a just-sent bubble may briefly exist
  // without the aria-label markers Path A relies on. We scan the
  // [role="grid"] only (NOT the composer area) so the message we just
  // staged doesn't self-match.
  try {
    if (compactExpected.length < 12) return false;
    const threadRoot = (typeof getDMThreadRoot === 'function')
      ? getDMThreadRoot(contextNode)
      : null;
    if (!(threadRoot instanceof HTMLElement)) return false;

    const grid = threadRoot.querySelector('[role="grid"]') || threadRoot;
    let haystack = (grid.textContent || '').toLowerCase();
    haystack = haystack.replace(/\s+/g, ' ').trim();
    if (!haystack) return false;

    const needle = expectedPrefix.length > 0 ? expectedPrefix : compactExpected;
    if (needle.length < 12) return false;
    return haystack.includes(needle);
  } catch {
    return false;
  }
}

async function confirmSendAfterFailure(expectedMessage, contextNode = null, label = 'DM send') {
  for (let attempt = 0; attempt < 6; attempt++) {
    const liveComposer = getDMComposer() || (contextNode instanceof HTMLElement ? contextNode : null);
    if (threadContainsExpectedMessage(expectedMessage, liveComposer || contextNode)) {
      console.log(`[Human Behavior Bot] ${label}: message confirmed in thread after fallback check`);
      return true;
    }

    await sleep(400);
  }

  return false;
}

async function executeValidatedDMFlow(rawMessage, options = {}) {
  const {
    label = 'DM send',
    targetUsernameHint = '',
    initialComposer = null,
    maxFlowAttempts = 2,
  } = (options && typeof options === 'object') ? options : {};

  const normalizedMessage = normalizeOutgoingMessage(rawMessage);
  if (!normalizedMessage) {
    console.log(`[Human Behavior Bot] ERROR: DM script is empty or not loaded (${label})`);
    return false;
  }

  console.log(`[Human Behavior Bot] ${label}: DM script loaded (${normalizedMessage.length} chars)`);
  console.log(`[Human Behavior Bot] ${label}: script preview -> ${normalizedMessage.slice(0, 200)}`);

  let composer = initialComposer instanceof HTMLElement ? initialComposer : null;
  let messageInserted = false;
  let messageSent = false;

  composer = getDMComposer() || composer || await waitForDMComposer(targetUsernameHint, 12);
  if (!composer) {
    console.log(`[Human Behavior Bot] ${label}: message input not found`);
    return false;
  }

  composer = await stabilizeDMComposerForTyping(composer, `${label} focus`) || composer;

  if (!isElementVisibleAndEnabled(composer)) {
    console.log(`[Human Behavior Bot] ${label}: message input is not interactable`);
    return false;
  }

  if (threadContainsExpectedMessage(normalizedMessage, composer)) {
    console.log(`[Human Behavior Bot] ${label}: exact script already exists in this chat — skipping to avoid duplicates`);
    return false;
  }

  // Snapshot the thread BEFORE we type/send. If the thread already has any
  // messages (from prior outreach, follow-ups, or a reply we never tracked),
  // this is NOT a true first-contact DM and should be flagged so the
  // response-rate UI can split outreach vs follow-up performance.
  const preSendSnapshot = analyzeDMConversation(composer);
  const wasFirstContact = !preSendSnapshot.hasAnyMessages;
  console.log(`[Human Behavior Bot] ${label}: pre-send snapshot — wasFirstContact=${wasFirstContact} (hasAnyMessages=${preSendSnapshot.hasAnyMessages}, hasOutgoing=${preSendSnapshot.hasOutgoingMessages})`);

  const existingComposerText = normalizeOutgoingMessage(getComposerText(composer));
  if (existingComposerText && !composerTextMatchesExpected(existingComposerText, normalizedMessage)) {
    console.log(`[Human Behavior Bot] ${label}: clearing composer before insert`);
    composer = await clearDMComposerContent(composer, `${label} stale text`) || composer;
    composer = await stabilizeDMComposerForTyping(composer, `${label} refocus`) || composer;
  }

  if (!messageInserted) {
    console.log(`[Human Behavior Bot] ${label}: inserting final script once`);
    messageSent = await sendCustomMessage(normalizedMessage, { maxEntryAttempts: 2 });
    const liveComposer = getDMComposer() || composer;
    const composerText = liveComposer ? normalizeOutgoingMessage(getComposerText(liveComposer)) : '';
    messageInserted = composerTextMatchesExpected(composerText, normalizedMessage);

    if (messageInserted) {
      console.log(`[Human Behavior Bot] ${label}: input verification passed — composer exactly matches final script`);
    } else if (messageSent) {
      messageInserted = true;
    } else {
      console.log(`[Human Behavior Bot] ${label}: input verification failed — expected text not visible after insert`);
      return false;
    }
  }

  if (messageSent || await confirmSendAfterFailure(normalizedMessage, getDMComposer() || composer, label)) {
    console.log(`[Human Behavior Bot] ${label}: message confirmed as sent`);
    const verdict = await verifyDMDeliveryAndSignal(getDMComposer() || composer, `${label} delivery`, normalizedMessage);
    if (verdict.failed) {
      // Last chance before declaring failure: action-blocked modals are
      // real (account safety) — but other "failed" verdicts can be stale
      // toast carryover. Scan the thread one more time.
      try {
        await sleep(800);
        if (verdict.reason !== 'action_blocked_modal'
            && threadContainsExpectedMessage(normalizedMessage, getDMComposer() || composer)) {
          console.log(`[Human Behavior Bot] ✅ ${label}: verifier said failed (${verdict.reason}) but message IS in thread — counting as delivered`);
          return { ok: true, wasFirstContact };
        }
      } catch {}
      console.warn(`[Human Behavior Bot] ${label}: delivery NOT confirmed post-send (${verdict.reason}) — not counting this DM`);
      return false;
    }
    return { ok: true, wasFirstContact };
  }

  if (!messageInserted) {
    console.log(`[Human Behavior Bot] ${label}: send retry aborted — script is not fully present in composer`);
    return false;
  }

  console.log(`[Human Behavior Bot] ${label}: send not confirmed — retrying send once without retyping`);
  releaseDMSendAttempt(normalizedMessage);
  const retryComposer = getDMComposer() || composer;
  const beforeSnapshot = analyzeDMConversation(retryComposer);
  const composerTextBeforeRetry = normalizeComposerSnapshot(getComposerText(retryComposer));

  messageSent = await _attemptSendOnly(
    retryComposer,
    normalizedMessage,
    beforeSnapshot,
    composerTextBeforeRetry,
  );

  if (messageSent || await confirmSendAfterFailure(normalizedMessage, getDMComposer() || retryComposer, `${label} retry`)) {
    console.log(`[Human Behavior Bot] ${label}: message confirmed as sent after single retry`);
    const verdict = await verifyDMDeliveryAndSignal(getDMComposer() || retryComposer, `${label} retry delivery`, normalizedMessage);
    if (verdict.failed) {
      try {
        await sleep(800);
        if (verdict.reason !== 'action_blocked_modal'
            && threadContainsExpectedMessage(normalizedMessage, getDMComposer() || retryComposer)) {
          console.log(`[Human Behavior Bot] ✅ ${label}: retry-verifier said failed (${verdict.reason}) but message IS in thread — counting as delivered`);
          return { ok: true, wasFirstContact };
        }
      } catch {}
      console.warn(`[Human Behavior Bot] ${label}: delivery NOT confirmed post-retry (${verdict.reason}) — not counting this DM`);
      return false;
    }
    return { ok: true, wasFirstContact };
  }

  // ── FINAL SAFETY NET ────────────────────────────────────────────────
  // All earlier checks failed, but the message may still have landed
  // (residual toasts, re-keyed virtualized rows, slow hydration). Scan
  // the thread one last time. Action-blocked modals are NOT overridden
  // here — those mean the account is being rate-limited and we must
  // stop. Only override OTHER kinds of failure.
  try {
    await sleep(800);
    if (!detectDMRateLimitModal()
        && threadContainsExpectedMessage(normalizedMessage, getDMComposer() || composer)) {
      console.log(`[Human Behavior Bot] ✅ ${label}: final-safety scan found message in thread — counting as delivered`);
      return { ok: true, wasFirstContact };
    }
  } catch {}

  console.log(`[Human Behavior Bot] ${label}: failed after a single insert and one send retry`);
  return false;
}

// ─── DM WITH GIF + CUSTOM MESSAGE SUPPORT ─────────────────
// IMPORTANT: This function completes the ENTIRE DM flow in a single call
// (navigate → open thread → send message) and only returns true when a
// message is actually sent.  Previously it returned true after each
// intermediate navigation step, which caused the background to think the
// DM was sent when it had only navigated to the inbox.
async function performDM(customMessage, allowExistingChats = false) {
  // ── Step 1: Navigate to DMs if not already there ──────────────────────────
  if (!window.location.pathname.startsWith('/direct')) {
    console.log('[Human Behavior Bot] Not on /direct — requesting tab navigation to inbox...');
    // IMPORTANT: Do NOT use window.location.href here — that triggers a hard
    // navigation which destroys this content script mid-execution, so the
    // rest of performDM (thread selection + message send) never runs.
    // Instead, try SPA navigation first; if that fails, ask the background
    // to navigate the tab at the browser level and then re-dispatch the DM.
    const dmLink = document.querySelector('a[href="/direct/inbox/"]');
    if (dmLink) {
      await humanClick(dmLink);
      await sleep(humanDelay(2500));
      // Check if SPA navigation succeeded
      for (let waitAttempt = 0; waitAttempt < 10; waitAttempt++) {
        if (window.location.pathname.startsWith('/direct')) break;
        await sleep(500);
      }
    }
    if (!window.location.pathname.startsWith('/direct')) {
      // SPA navigation failed or no link found — signal the background to
      // navigate the tab and re-dispatch the DM action after the page loads.
      console.log('[Human Behavior Bot] SPA nav failed/unavailable — returning needsTabNavigation signal');
      return { needsTabNavigation: true, url: 'https://www.instagram.com/direct/inbox/' };
    }
    console.log('[Human Behavior Bot] ✅ SPA-navigated to inbox, continuing to open thread...');
    // Fall through to Step 2 instead of returning
  }

  // ── Step 2: If in inbox (no thread open), open a conversation ─────────────
  if (!window.location.pathname.match(/\/direct\/t\//)) {
    // Wait for thread links to render — after navigation the inbox DOM may not
    // be ready immediately.  Poll up to ~8 seconds for at least one thread link.
    let threads = document.querySelectorAll('a[href*="/direct/t/"]');
    if (threads.length === 0) {
      console.log('[Human Behavior Bot] No thread links yet — waiting for inbox to render...');
      for (let renderWait = 0; renderWait < 16; renderWait++) {
        await sleep(500);
        threads = document.querySelectorAll('a[href*="/direct/t/"]');
        if (threads.length > 0) {
          console.log(`[Human Behavior Bot] ✅ Thread links appeared after ${(renderWait + 1) * 500}ms (${threads.length} threads)`);
          break;
        }
      }
    }

    if (threads.length > 0) {
      await refreshDMHistoryCache();

      // Scroll through threads briefly first (human browsing)
      const threadList = threads[0]?.closest('[role="list"]') || threads[0]?.parentElement?.parentElement;
      if (threadList) {
        for (let i = 0; i < randomInt(1, 3); i++) {
          threadList.scrollTop += randomInt(50, 150);
          await sleep(humanDelay(500));
        }
      }

      // Try to find a thread we haven't messaged yet
      const allThreads = Array.from(threads);
      let target = null;

      for (const thread of allThreads) {
        const threadIdentifiers = getThreadIdentifiers(thread);
        const isAlreadyMessaged = threadIdentifiers.some((identifier) => isInDMHistory(identifier));

        if (!isAlreadyMessaged) {
          target = thread;
          break;
        }
      }

      if (!target) {
        if (threadList) {
          threadList.scrollTop += randomInt(200, 500);
          await sleep(humanDelay(800));
        }
        console.log('[Human Behavior Bot] All visible threads already messaged, skipping');
        return false;
      }

      await humanClick(target);
      await sleep(humanDelay(1500));

      // Wait for the thread to open — check BOTH URL change (/direct/t/) AND
      // composer appearance (split-view may load the conversation in the right
      // panel without changing the URL on some Instagram layouts).
      let threadReady = false;
      for (let waitAttempt = 0; waitAttempt < 12; waitAttempt++) {
        if (window.location.pathname.match(/\/direct\/t\//)) {
          console.log('[Human Behavior Bot] ✅ URL changed to thread page');
          threadReady = true;
          break;
        }
        // Split-view fallback: composer appeared in the right panel even though
        // URL still shows /direct/inbox (some Instagram layouts do this)
        const composer = getDMComposer();
        if (composer) {
          console.log('[Human Behavior Bot] ✅ Composer detected in split-view panel (URL still inbox)');
          threadReady = true;
          break;
        }
        await sleep(500);
      }
      if (!threadReady) {
        console.log('[Human Behavior Bot] ❌ Thread did not open after clicking (no URL change, no composer)');
        return false;
      }
      // Give the thread time to fully render and Lexical to initialize the composer.
      // On split-view, the composer might appear before Lexical attaches handlers.
      // Wait until the composer has a <p> child (Lexical's initialized structure).
      let composerReady = false;
      for (let readyWait = 0; readyWait < 10; readyWait++) {
        await sleep(500);
        const c = getDMComposer();
        if (c && (c.querySelector('p') || c.hasAttribute('data-lexical-editor') || c.tagName === 'TEXTAREA')) {
          composerReady = true;
          console.log(`[Human Behavior Bot] ✅ Composer initialized (Lexical ready) after ${(readyWait + 1) * 500}ms`);
          break;
        }
      }
      if (!composerReady) {
        console.log('[Human Behavior Bot] ⚠️ Composer may not be fully initialized — proceeding anyway');
      }
      await sleep(humanDelay(500));
      console.log('[Human Behavior Bot] ✅ Thread opened, continuing to send message...');
      // Fall through to Step 3 instead of returning
    } else {
      console.log('[Human Behavior Bot] ❌ No thread links found in inbox after waiting');
      return false;
    }
  }

  // ── Step 3: Inside a conversation — verify and send ───────────────────────
  // Matches any direct-thread URL (/direct/t/, /direct/partnerships/t/,
  // /direct/requests/t/) AND split-view where composer is present.
  const onThreadPage = isOnInstagramDirectThread();
  const composerPresent = !onThreadPage ? !!getDMComposer() : false;
  if (onThreadPage || composerPresent) {
    const threadIdentifier = extractCurrentThreadUsername();
    const threadId = extractCurrentThreadId();

    await refreshDMHistoryCache();

    if ((threadIdentifier && isInDMHistory(threadIdentifier)) || (threadId && isInDMHistory(threadId))) {
      console.log(`[Human Behavior Bot] Already messaged ${threadIdentifier || threadId}, skipping`);
      // Do NOT use window.location.href — that hard-reloads the page and
      // kills this content script mid-flow, which makes the background mark
      // the whole targeting session as completed. The caller will navigate
      // to the next target via SPA-friendly navigateProfile.
      return false;
    }

    // Check if this thread has ANY existing messages (outgoing OR incoming)
    // Skip accounts with existing chats — including manually sent DMs
    // …unless the user enabled "Message Existing Chats" in targeting filters.
    // HARDENED: poll up to 8s for a definitive verdict; fail closed on 'unknown'.
    const allowExistingChats = !!arguments[1];
    const freshness = await confirmThreadFreshness(null, { maxWaitMs: 8000, stableChecks: 3 });
    if (freshness === 'existing' && !allowExistingChats) {
      console.log(`[Human Behavior Bot] Thread with ${threadIdentifier || threadId || 'unknown'} already has messages — skipping (existing chat, performDM)`);
      if (threadIdentifier) await addToDMHistory(threadIdentifier);
      if (threadId) await addToDMHistory(threadId);
      // Do NOT use window.location.href here — see note above.
      return false;
    }
    if (freshness === 'existing' && allowExistingChats) {
      console.log(`[Human Behavior Bot] Thread already has messages — sending anyway (Message Existing Chats is ON)`);
    }
    if (freshness === 'unknown' && !allowExistingChats) {
      console.log(`[Human Behavior Bot] Thread freshness unknown after 8s — failing closed and skipping (performDM)`);
      if (threadIdentifier) await addToDMHistory(threadIdentifier);
      if (threadId) await addToDMHistory(threadId);
      // Do NOT use window.location.href here — see note above.
      return false;
    }

    // Final pre-send guard: re-check immediately before browsing/typing
    if (!allowExistingChats && threadHasExistingMessages()) {
      console.log(`[Human Behavior Bot] Pre-send guard caught existing messages — skipping (performDM)`);
      if (threadIdentifier) await addToDMHistory(threadIdentifier);
      if (threadId) await addToDMHistory(threadId);
      // Do NOT use window.location.href here — see note above.
      return false;
    }


    // This is a fresh thread — browse briefly then send.
    // v2.4.150 FIX: `messageArea` was never declared in this function, so this
    // line threw "ReferenceError: messageArea is not defined" and aborted every
    // fresh-thread send that came through the generic `dm` action. (Same bug
    // class as the v2.4.22 fix; it came back at a different line.)
    const messageArea = getDMThreadRoot(getDMComposer());
    if (messageArea) {
      for (let i = 0; i < randomInt(1, 2); i++) {
        messageArea.scrollTop += randomInt(40, 100);
        await sleep(humanDelay(500));
      }
    }

    // Send the custom DM message (no GIFs) — single attempt to prevent triple-send
    // Personalise {name} and apply readability spacing before sending
    let sent = false;
    if (!customMessage) {
      console.log('[Human Behavior Bot] No custom message configured, skipping DM');
      return false;
    }

    const threadUser = extractCurrentThreadUsername();
    const formattedMsg = personalizeAndFormatDM(customMessage, threadUser || '');

    console.log(`[Human Behavior Bot] sendCustomMessage attempt...`);
    sent = await sendCustomMessage(formattedMsg);

    if (!sent) {
      const postSendComposer = getDMComposer();
      sent = await confirmSendAfterFailure(formattedMsg, postSendComposer, 'performDM');
      if (!sent && postSendComposer) {
        console.log('[Human Behavior Bot] Message still in composer — clearing and moving on (no retry)');
        await clearDMComposerContent(postSendComposer, 'performDM post-send cleanup');
      }
    }

    if (!sent) {
      console.log('[Human Behavior Bot] ❌ DM send failed');
    }

    // Track as messaged
    if (sent) {
      if (threadIdentifier) await addToDMHistory(threadIdentifier);
      if (threadId) await addToDMHistory(threadId);
      console.log(`[Human Behavior Bot] First DM sent to ${threadIdentifier || threadId || 'unknown'}`);
    }

    return sent;
  }

  return false;
}

// ─── SEND GIF ──────────────────────────────────────────────
// Searches for GIFs related to "check your DMs" / "funtor" and sends one
const GIF_SEARCH_TERMS = [
  'check your dms',
  'check dms',
  'funtor',
  'check your messages',
  'slide into dms',
  'open your dms',
];

async function sendGIF() {
  // Look for the GIF/sticker button in the message input area
  const gifButton = document.querySelector('svg[aria-label="Choose a GIF"]')
    || document.querySelector('button[aria-label="Choose a GIF"]')
    || document.querySelector('svg[aria-label="Stickers"]');

  // Fallback: look for emoji/sticker panel trigger
  const emojiTrigger = gifButton
    || document.querySelector('svg[aria-label="Emoji"]')
    || document.querySelector('button svg[aria-label="Choose an emoji"]');

  if (!emojiTrigger) return false;

  const clickTarget = emojiTrigger.closest('button') || emojiTrigger.parentElement;
  await humanClick(clickTarget);
  await sleep(humanDelay(800));

  // Look for GIF tab if emoji panel opened
  const gifTab = Array.from(document.querySelectorAll('button, div[role="tab"]')).find(
    el => el.textContent?.trim().toUpperCase() === 'GIF' || el.textContent?.trim() === 'GIFs'
  );

  if (gifTab) {
    await humanClick(gifTab);
    await sleep(humanDelay(1000));
  }

  // Find the GIF search input and type a search term
  const searchInput = document.querySelector('input[placeholder*="Search GIF"], input[placeholder*="Search"], input[type="text"]');
  if (searchInput) {
    await humanClick(searchInput);
    await sleep(humanDelay(400));

    // Pick a random search term
    const searchTerm = GIF_SEARCH_TERMS[randomInt(0, GIF_SEARCH_TERMS.length - 1)];

    // Type it character by character like a human
    for (const char of searchTerm) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(searchInput, searchInput.value + char);
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(randomInt(50, 180)); // variable typing speed
    }

    // Press Enter to search
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await sleep(humanDelay(1500)); // wait for results

  } else {
    // No search input found, just browse what's available
    await sleep(randomInt(800, 2000));
  }

  // Pick a GIF from results
  const gifImages = document.querySelectorAll('img[src*="giphy"], img[src*="gif"], div[role="button"] img');
  if (gifImages.length > 0) {
    // Pick from the first few results (most relevant)
    const maxIdx = Math.min(gifImages.length - 1, 5);
    const selectedGif = gifImages[randomInt(0, maxIdx)];
    const gifClickable = selectedGif.closest('button') || selectedGif.closest('[role="button"]') || selectedGif;

    // Brief browse before selecting
    const gifContainer = selectedGif.closest('[class*="scroll"]') || selectedGif.parentElement;
    if (gifContainer) {
      gifContainer.scrollTop += randomInt(30, 120);
      await sleep(humanDelay(500));
    }

    await humanClick(gifClickable);
    await sleep(humanDelay(500));
    return true;
  }

  // If no GIFs found, close the panel
  const closeBtn = document.querySelector('svg[aria-label="Close"]');
  if (closeBtn) {
    await humanClick(closeBtn.closest('button') || closeBtn);
  }

  return false;
}

// ─── EXPLORE / SEARCH FOR SIMILAR ACCOUNTS ────────────────
// Navigates to Explore or Search page, searches for a keyword, and finds similar accounts
async function performExploreSearch(keywords) {
  if (!keywords || keywords.length === 0) return false;

  const keyword = keywords[randomInt(0, keywords.length - 1)];
  console.log(`[AI Targeting] Searching explore for: ${keyword}`);

  // Navigate to search/explore
  if (!window.location.pathname.startsWith('/explore')) {
    const searchLink = document.querySelector('a[href="/explore/"]')
      || document.querySelector('svg[aria-label="Search"]')?.closest('a')
      || document.querySelector('a[href*="explore"]');
    
    if (searchLink) {
      await humanClick(searchLink);
      await sleep(humanDelay(2000));
    } else {
      window.location.href = 'https://www.instagram.com/explore/';
      await sleep(3000);
    }
  }

  // Find and click the search input
  const searchInput = document.querySelector('input[placeholder*="Search"]')
    || document.querySelector('input[aria-label*="Search"]')
    || document.querySelector('input[type="text"]');

  if (!searchInput) {
    // Try clicking the search icon first
    const searchIcon = document.querySelector('svg[aria-label="Search"]')?.closest('a, button, div[role="button"]');
    if (searchIcon) {
      await humanClick(searchIcon);
      await sleep(humanDelay(1500));
    }
    return false;
  }

  await humanClick(searchInput);
  await sleep(humanDelay(600));

  // Clear existing text
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(humanDelay(300));

  // Type the keyword character by character
  for (const char of keyword) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(searchInput, searchInput.value + char);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(randomInt(50, 180));
  }

  await sleep(humanDelay(1500)); // Wait for search results

  // Click "Accounts" tab if available
  const accountsTab = Array.from(document.querySelectorAll('a, button, div[role="tab"]')).find(
    el => el.textContent?.trim().toLowerCase() === 'accounts'
  );
  if (accountsTab) {
    await humanClick(accountsTab);
    await sleep(humanDelay(1200));
  }

  return true;
}

// (Recency helpers, profile engagement, and engage functions are defined below after navigation helpers)

// ─── NAVIGATE TO HASHTAG PAGE ──────────────────────────────
async function navigateHashtag(hashtag) {
  if (!hashtag) return false;
  const tag = hashtag.replace(/^#/, '').trim().toLowerCase();
  if (!tag) return false;

  const targetPath = `/explore/tags/${tag}`;

  // If already on this hashtag page (classic or search route), treat that as success
  // and let engageNextHashtagPost handle grid loading.
  if (isInstagramHashtagRoute(tag)) {
    console.log(`[Human Behavior Bot] Already on #${tag} page, results visible or loading`);
    await waitForHashtagGrid(8000).catch(() => false);
    return true;
  }

  // IMPORTANT: do not attempt in-content hashtag navigation here.
  // Instagram can hard-reload this route, which kills the async message channel,
  // makes background.js think the extension disconnected, and causes a reconnect loop.
  // Instead, always hand off non-current hashtag navigation to background.js.
  const targetUrl = `https://www.instagram.com${targetPath}/`;
  console.log(`[Human Behavior Bot] Requesting browser-level navigation to #${tag}: ${targetUrl}`);
  return { needsTabNavigation: true, url: targetUrl };
}

function isInstagramHashtagRoute(expectedTag = null, pathname = window.location.pathname, search = window.location.search) {
  const normalizedPath = normalizeInstagramPath(pathname);
  if (normalizedPath.includes('/explore/tags/')) {
    if (!expectedTag) return true;
    return normalizedPath.includes(`/explore/tags/${expectedTag.toLowerCase()}`);
  }

  if (!normalizedPath.includes('/explore/search/keyword')) {
    return false;
  }

  const query = new URLSearchParams(search || '');
  const rawQ = (query.get('q') || '').trim().toLowerCase();
  const normalizedQ = rawQ.replace(/^%23/, '#');
  if (!normalizedQ.startsWith('#')) {
    return !expectedTag;
  }

  if (!expectedTag) return true;
  return normalizedQ === `#${expectedTag.toLowerCase()}`;
}

function getHashtagResultPostLinks() {
  if (!isInstagramHashtagRoute()) {
    return [];
  }

  const searchRoot = document.querySelector('main') || document;
  const selectors = [
    'main a[href*="/p/"]',
    'main a[href*="/reel/"]',
    'article a[href*="/p/"]',
    'article a[href*="/reel/"]',
    'a[href*="/p/"]',
    'a[href*="/reel/"]',
  ];

  const seen = new Set();
  const links = selectors
    .flatMap((selector) => Array.from(searchRoot.querySelectorAll(selector)))
    .filter((link) => {
      const href = link.getAttribute('href');
      if (!href || seen.has(href)) return false;
      if (!href.includes('/p/') && !href.includes('/reel/')) return false;
      seen.add(href);
      return true;
    });

  links.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    const aTop = window.scrollY + aRect.top;
    const bTop = window.scrollY + bRect.top;

    if (Math.abs(aTop - bTop) > 12) {
      return aTop - bTop;
    }

    const aLeft = window.scrollX + aRect.left;
    const bLeft = window.scrollX + bRect.left;
    return aLeft - bLeft;
  });

  return links;
}

// Wait for the hashtag grid to render with post links
async function waitForHashtagGrid(maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const posts = getHashtagResultPostLinks();
    if (posts.length > 0) {
      await sleep(700);
      const settledPosts = getHashtagResultPostLinks();
      console.log(`[Human Behavior Bot] Hashtag grid detected with ${settledPosts.length} post links`);
      return true;
    }
    await sleep(600);
  }
  console.log('[Human Behavior Bot] Hashtag route loaded but post grid is still settling');
  return false;
}

function normalizeInstagramPath(value) {
  if (!value) return '';
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(value)
      .replace(/^https?:\/\/[^/]+/i, '')
      .split('?')[0]
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

function getLocationExpectedPath(locationUrl) {
  if (!locationUrl) return '/explore/locations';
  const match = locationUrl.match(/(\/explore\/locations\/[^\s?#]+)/i);
  return normalizeInstagramPath(match ? match[1] : locationUrl) || '/explore/locations';
}

function getLocationRecentPath(locationUrl) {
  const basePath = getLocationExpectedPath(locationUrl).replace(/\/recent$/i, '');
  return `${basePath}/recent`;
}

function isLocationRecentRoute(pathname = window.location.pathname) {
  const normalizedPath = normalizeInstagramPath(pathname);
  return normalizedPath.includes('/explore/locations/') && normalizedPath.endsWith('/recent');
}

function isInstagramReelsPath() {
  const path = window.location.pathname.toLowerCase();
  return path.startsWith('/reels') || path.startsWith('/reel/');
}

function isInstagramDirectPath() {
  return window.location.pathname.toLowerCase().startsWith('/direct');
}

function isInstagramProfilePath(username) {
  if (!username) return false;
  const clean = username.replace(/^@/, '').toLowerCase();
  const currentPath = window.location.pathname.toLowerCase();
  return currentPath === `/${clean}` || currentPath === `/${clean}/` || currentPath.startsWith(`/${clean}/`);
}

function getLocationRecentHeading() {
  const labels = new Set(['recent', 'most recent', 'recent posts']);
  const candidates = Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4, main span, main div, main section')).filter((el) => {
    const text = (el.textContent || '').trim().toLowerCase();
    return labels.has(text) && !el.closest('a, button, [role="tab"], [role="button"]');
  });

  return candidates.find((el) => el.parentElement?.querySelector('a[href*="/p/"]')) || candidates[0] || null;
}

function getLocationRecentTabCandidates() {
  const clickableSelector = 'main a, main button, main [role="tab"], main [role="button"], header a, header button, nav a, nav button';
  const seen = new Set();
  return Array.from(document.querySelectorAll(clickableSelector))
    .map((el) => el.closest('a, button, [role="tab"], [role="button"]') || el)
    .filter((el) => {
      if (!el || seen.has(el)) return false;

      const text = (el.textContent || '').trim().toLowerCase();
      const href = normalizeInstagramPath(el.getAttribute('href') || el.href || '');
      const isRecent = text === 'recent' || text === 'most recent' || text === 'recent posts' || href.includes('/recent') || href.includes('recent');
      if (!isRecent) return false;

      seen.add(el);
      return true;
    })
    .sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectA.top - rectB.top || rectA.left - rectB.left;
    });
}

function isLocationRecentTabActive() {
  return getLocationRecentTabCandidates().some((el) => {
    const target = el.closest('a, button, [role="tab"], [role="button"]') || el;
    return target.getAttribute('aria-selected') === 'true'
      || target.getAttribute('aria-current') === 'page'
      || target.getAttribute('aria-pressed') === 'true'
      || target.closest('[aria-selected="true"]') === target.parentElement;
  });
}

function isLocationRecentViewConfirmed() {
  // Primary: URL has /recent or tab is visually active
  if (isLocationRecentRoute() || isLocationRecentTabActive()) return true;
  // Fallback: we're on ANY location page — Instagram SPA navigation often drops
  // the /recent suffix or tab aria state after returning from a profile.
  // If we can see the "Recent" heading text on the page, that's good enough.
  const onLocationPage = normalizeInstagramPath(window.location.pathname).includes('/explore/locations/');
  if (onLocationPage) {
    const heading = getLocationRecentHeading();
    if (heading) return true;
    // Even without heading, if we're on a location page with posts, allow extraction
    // The navigateLocation function already forced /recent before we got here
    const hasPosts = document.querySelectorAll('main a[href*="/p/"]').length > 0;
    if (hasPosts) return true;
  }
  return false;
}

function getVisibleLocationAnchorHref() {
  const posts = getLocationResultPostLinks();
  const visiblePost = posts.find((link) => {
    try {
      const rect = link.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    } catch {
      return false;
    }
  });

  return visiblePost?.getAttribute('href') || posts[0]?.getAttribute('href') || null;
}

function loadLocationResultsState(locationUrl = window.location.pathname) {
  try {
    const raw = sessionStorage.getItem(LOCATION_RESULTS_STATE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const expectedPath = getLocationExpectedPath(locationUrl);
    if (!parsed?.expectedPath || parsed.expectedPath !== expectedPath) return null;

    return parsed;
  } catch {
    return null;
  }
}

function saveLocationResultsState(locationUrl = window.location.pathname) {
  try {
    const expectedPath = getLocationExpectedPath(locationUrl);
    const currentPath = normalizeInstagramPath(window.location.pathname);
    if (!expectedPath.includes('/explore/locations/') || !currentPath.includes(expectedPath)) {
      return;
    }

    sessionStorage.setItem(LOCATION_RESULTS_STATE_KEY, JSON.stringify({
      expectedPath,
      recentPath: getLocationRecentPath(locationUrl),
      scrollY: window.scrollY,
      anchorHref: getVisibleLocationAnchorHref(),
      savedAt: Date.now(),
    }));
  } catch {}
}

async function restoreLocationResultsState(locationUrl = window.location.pathname) {
  const state = loadLocationResultsState(locationUrl);
  if (!state) return false;

  const currentPath = normalizeInstagramPath(window.location.pathname);
  if (!currentPath.includes(state.expectedPath) && !currentPath.includes('/explore/locations/')) {
    return false;
  }

  const allPosts = getLocationResultPostLinks();
  const normalizedAnchor = normalizeInstagramPath(state.anchorHref || '');
  const anchorPost = normalizedAnchor
    ? allPosts.find((link) => normalizeInstagramPath(link.getAttribute('href') || '') === normalizedAnchor)
    : null;

  if (anchorPost) {
    anchorPost.scrollIntoView({ behavior: 'auto', block: 'start' });
    await sleep(120);
    window.scrollTo({ top: Math.max(0, window.scrollY - Math.round(window.innerHeight * 0.18)), behavior: 'auto' });
    await sleep(220);
    return true;
  }

  if (Number.isFinite(state.scrollY)) {
    window.scrollTo({ top: Math.max(0, state.scrollY), behavior: 'auto' });
    await sleep(220);
    return true;
  }

  return false;
}

async function unwindBackToLocationResults(locationUrl, maxAttempts = 6) {
  const expectedPath = getLocationExpectedPath(locationUrl);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentPath = normalizeInstagramPath(window.location.pathname);
    if (currentPath.includes(expectedPath) || currentPath.includes('/explore/locations/')) {
      const recentReady = isLocationRecentViewConfirmed() ? true : await clickLocationRecentTab();
      if (!recentReady || !isLocationRecentViewConfirmed()) return false;
      await waitForLocationGrid(5000).catch(() => false);
      await restoreLocationResultsState(locationUrl);
      saveLocationResultsState(locationUrl);
      return true;
    }

    const modal = document.querySelector('[role="dialog"]');
    if (modal && !isInstagramDirectPath()) {
      const closeBtn = modal.querySelector('svg[aria-label="Close"]')?.closest('button')
        || modal.querySelector('button[aria-label="Close"]');
      if (closeBtn) {
        await humanClick(closeBtn);
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    } else {
      window.history.back();
    }

    await sleep(humanDelay(1350 + attempt * 140));
  }

  return false;
}

function getLocationRecentBoundaryY() {
  const markers = [getLocationRecentHeading(), getLocationRecentTabCandidates()[0]].filter(Boolean);
  if (markers.length === 0) return null;

  const values = markers
    .map((el) => {
      try {
        const rect = el.getBoundingClientRect();
        return window.scrollY + rect.bottom;
      } catch {
        return null;
      }
    })
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? Math.max(...values) : null;
}

function getLocationRecentContentRoot() {
  const recentHeading = getLocationRecentHeading();
  if (!recentHeading) return null;

  const candidates = [
    recentHeading.closest('section'),
    recentHeading.closest('article'),
    recentHeading.parentElement,
    recentHeading.parentElement?.parentElement,
  ].filter(Boolean);

  return candidates.find((container) => {
    try {
      return container.querySelectorAll('a[href*="/p/"]').length > 0;
    } catch {
      return false;
    }
  }) || null;
}

// ─── NAVIGATE TO LOCATION PAGE (paste-link only) ─────────────────────────────
async function navigateLocation(locationUrl) {
  if (!locationUrl) return false;

  const locationPath = getLocationExpectedPath(locationUrl).replace(/\/recent$/i, '');
  const recentPath = getLocationRecentPath(locationUrl);
  if (!locationPath.includes('/explore/locations/')) {
    console.log('[Human Behavior Bot] Invalid location URL — must contain /explore/locations/');
    return false;
  }

  const currentPath = normalizeInstagramPath(window.location.pathname);
  const alreadyOnRecentPage = currentPath === recentPath
    || (currentPath.includes(locationPath) && isLocationRecentViewConfirmed());
  let navigatedToLocation = false;

  if (!alreadyOnRecentPage || isInstagramReelsPath() || isInstagramDirectPath()) {
    const restoredFromHistory = await unwindBackToLocationResults(locationUrl, 6);
    if (restoredFromHistory) {
      return true;
    }

    const targetUrl = `https://www.instagram.com${recentPath}/`;
    let reached = false;

    try {
      const tempLink = document.createElement('a');
      tempLink.href = targetUrl;
      tempLink.style.display = 'none';
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);

      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (normalizeInstagramPath(window.location.pathname) === recentPath) {
          reached = true;
          navigatedToLocation = true;
          break;
        }
      }
    } catch (e) {
      console.log('[Human Behavior Bot] SPA nav to location failed:', e.message);
    }

    if (!reached) {
      window.location.href = targetUrl;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (normalizeInstagramPath(window.location.pathname) === recentPath) {
          reached = true;
          navigatedToLocation = true;
          break;
        }
      }
    }

    if (!reached) {
      const fallbackUrl = `https://www.instagram.com${locationPath}/`;
      window.location.href = fallbackUrl;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (normalizeInstagramPath(window.location.pathname) === locationPath) {
          reached = true;
          navigatedToLocation = true;
          break;
        }
      }
    }

    if (!reached) return false;
  }

  console.log('[Human Behavior Bot] On location page, preparing Recent posts view...');
  if (navigatedToLocation) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(humanDelay(1200));
  }
  const recentReady = isLocationRecentViewConfirmed() ? true : await clickLocationRecentTab();
  if (!recentReady || !isLocationRecentViewConfirmed()) {
    console.log('[Human Behavior Bot] Failed to confirm Recent posts view on location page');
    return false;
  }

  const gridReady = await waitForLocationGrid(10000).catch(() => false);
  if (gridReady && !navigatedToLocation) {
    await restoreLocationResultsState(locationUrl);
  }
  if (gridReady) {
    saveLocationResultsState(locationUrl);
  }
  return Boolean(gridReady);
}

// Click the "Recent" or "Most recent" tab on a location page
async function clickLocationRecentTab() {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isLocationRecentViewConfirmed()) {
      console.log('[Human Behavior Bot] "Recent" tab already active');
      return true;
    }

    const candidates = getLocationRecentTabCandidates();
    const recentTab = candidates[0] || null;

    if (recentTab) {
      const tabHref = recentTab.getAttribute('href') || recentTab.href || '';
      const normalizedTabPath = normalizeInstagramPath(tabHref);

      if (normalizedTabPath && normalizedTabPath.includes('/recent') && normalizedTabPath !== normalizeInstagramPath(window.location.pathname)) {
        console.log('[Human Behavior Bot] Navigating directly to Recent tab route');
        try {
          const tempLink = document.createElement('a');
          tempLink.href = tabHref.startsWith('http') ? tabHref : `https://www.instagram.com${normalizedTabPath}/`;
          tempLink.style.display = 'none';
          document.body.appendChild(tempLink);
          tempLink.click();
          tempLink.remove();
          await sleep(humanDelay(2600));
        } catch {
          window.location.href = tabHref.startsWith('http') ? tabHref : `https://www.instagram.com${normalizedTabPath}/`;
          await sleep(humanDelay(3000));
        }

        if (isLocationRecentViewConfirmed()) {
          return true;
        }
      }

      console.log('[Human Behavior Bot] Clicking "Recent" tab');
      recentTab.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(humanDelay(500));
      await humanClick(recentTab);
      await sleep(humanDelay(2200));

      if (isLocationRecentViewConfirmed()) {
        return true;
      }

      if (tabHref) {
        const currentPath = normalizeInstagramPath(window.location.pathname);
        if (normalizedTabPath && normalizedTabPath !== currentPath) {
          window.location.href = tabHref.startsWith('http') ? tabHref : `https://www.instagram.com${normalizedTabPath}/`;
          await sleep(humanDelay(2500));
          if (isLocationRecentViewConfirmed()) {
            return true;
          }
        }
      }
    }

    const currentRecentPath = getLocationRecentPath(window.location.pathname);
    if (currentRecentPath.includes('/explore/locations/') && currentRecentPath !== normalizeInstagramPath(window.location.pathname)) {
      console.log('[Human Behavior Bot] Forcing direct navigation to location Recent route');
      window.location.href = `https://www.instagram.com${currentRecentPath}/`;
      await sleep(humanDelay(2800));
      if (isLocationRecentViewConfirmed()) {
        return true;
      }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(humanDelay(1000));
  }

  console.log('[Human Behavior Bot] No usable "Recent" tab found on this location page');
  return false;
}

// Wait for location grid to render with post links
async function waitForLocationGrid(maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // Relaxed check: URL-based OR DOM-based confirmation
    const wfgPath = normalizeInstagramPath(window.location.pathname);
    const wfgOnRecent = (wfgPath.includes('/explore/locations/') && wfgPath.endsWith('/recent')) || isLocationRecentViewConfirmed();
    if (!wfgOnRecent) {
      await sleep(600);
      continue;
    }

    const posts = getLocationResultPostLinks();
    if (posts.length > 0) {
      await sleep(700);
      const settled = getLocationResultPostLinks();
      console.log(`[Human Behavior Bot] Location grid detected with ${settled.length} post links`);
      return true;
    }
    await sleep(600);
  }
  console.log('[Human Behavior Bot] Location grid still settling');
  return false;
}

function getLocationResultPostLinks() {
  const recentHeading = getLocationRecentHeading();
  // Relaxed check: also accept URL-based confirmation
  const glrpPath = normalizeInstagramPath(window.location.pathname);
  const glrpOnRecentUrl = glrpPath.includes('/explore/locations/') && glrpPath.endsWith('/recent');
  const glrpOnAnyLocationPage = glrpPath.includes('/explore/locations/');
  // Accept: /recent URL, OR DOM-confirmed Recent view, OR any location page that has posts
  if (!glrpOnRecentUrl && !isLocationRecentViewConfirmed()) {
    if (!glrpOnAnyLocationPage || document.querySelectorAll('main a[href*="/p/"]').length === 0) {
      return [];
    }
  }

  // ONLY select /p/ posts — never /reel/ links to prevent navigating to /reels/ page
  const searchRoot = getLocationRecentContentRoot() || document.querySelector('main') || document;
  const selectors = [
    'main a[href*="/p/"]',
    'article a[href*="/p/"]',
    'a[href*="/p/"]',
  ];
  const seen = new Set();
  const links = selectors.flatMap(sel => Array.from(searchRoot.querySelectorAll(sel))).filter(link => {
    const href = link.getAttribute('href');
    if (!href || seen.has(href)) return false;
    if (!href.includes('/p/')) return false;
    if (href.includes('/reel/') || href.includes('/reels/')) return false;
    seen.add(href);
    return true;
  });

  const boundaryY = getLocationRecentBoundaryY();
  if (boundaryY !== null) {
    const belowBoundaryLinks = links.filter((link) => {
      try {
        return (window.scrollY + link.getBoundingClientRect().top) >= (boundaryY - 40);
      } catch {
        return false;
      }
    });

    if (belowBoundaryLinks.length > 0) {
      return belowBoundaryLinks;
    }
  }

  if (recentHeading) {
    const recentLinks = links.filter((link) => {
      try {
        return Boolean(recentHeading.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING);
      } catch {
        return false;
      }
    });

    if (recentLinks.length > 0) {
      return recentLinks;
    }

    // Fallback: if heading exists but no links after it, return all links on location page
    // This handles cases where Instagram's DOM structure doesn't put posts after the heading
    const onLocationPage = normalizeInstagramPath(window.location.pathname).includes('/explore/locations/');
    if (onLocationPage && links.length > 0) {
      return links;
    }

    return [];
  }

  // If on a location page (even without heading), return all /p/ links found
  const onLocationPage = normalizeInstagramPath(window.location.pathname).includes('/explore/locations/');
  if (onLocationPage && links.length > 0) {
    return links;
  }

  return isLocationRecentRoute() ? links : [];
}

async function scrollLocationResults(maxAttempts = 8) {
  if (isInstagramReelsPath() || isInstagramDirectPath()) {
    console.log('[Human Behavior Bot] Refusing to scroll location results from reels/direct page');
    return false;
  }

  // Resilient Recent check — URL-based first, then DOM, then clickTab
  const currentPath = normalizeInstagramPath(window.location.pathname);
  const isOnRecentUrl = currentPath.includes('/explore/locations/') && currentPath.endsWith('/recent');
  let recentOk = isOnRecentUrl || isLocationRecentViewConfirmed();
  if (!recentOk) {
    const recentReady = await clickLocationRecentTab();
    recentOk = recentReady || isLocationRecentViewConfirmed();
  }
  // Last-resort: on any location page with posts
  if (!recentOk) {
    const onLocationPage = currentPath.includes('/explore/locations/');
    const hasPosts = document.querySelectorAll('main a[href*="/p/"]').length > 0;
    recentOk = onLocationPage && hasPosts;
  }
  if (!recentOk) {
    console.log(`[Human Behavior Bot] Refusing to scroll — not on location Recent page (url=${window.location.pathname})`);
    return false;
  }

  saveLocationResultsState();
  const initialLinks = new Set(getLocationResultPostLinks().map((link) => link.getAttribute('href')).filter(Boolean));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const documentScroller = document.scrollingElement || document.documentElement;
    const mainScroller = document.querySelector('main');
    const beforeHeight = Math.max(documentScroller.scrollHeight, mainScroller?.scrollHeight || 0);

    const visibleLinks = getLocationResultPostLinks();
    const lastVisibleLink = visibleLinks[visibleLinks.length - 1];
    if (lastVisibleLink) {
      lastVisibleLink.scrollIntoView({ behavior: 'smooth', block: 'end' });
      await sleep(humanDelay(900));
    }

    window.scrollBy({ top: Math.max(window.innerHeight * 1.9, 900), behavior: 'smooth' });
    await sleep(humanDelay(1700));

    if (mainScroller && mainScroller.scrollHeight > mainScroller.clientHeight) {
      mainScroller.scrollBy({ top: Math.max(mainScroller.clientHeight * 1.2, 700), behavior: 'smooth' });
      await sleep(humanDelay(1200));
    }

    const currentLinks = getLocationResultPostLinks();
    const currentHrefs = currentLinks.map((link) => link.getAttribute('href')).filter(Boolean);
    const afterHeight = Math.max(documentScroller.scrollHeight, mainScroller?.scrollHeight || 0);

    if (currentHrefs.some((href) => !initialLinks.has(href)) || currentLinks.length > initialLinks.size || afterHeight > beforeHeight) {
      console.log('[Human Behavior Bot] Loaded more location posts after deep scroll');
      saveLocationResultsState();
      return true;
    }

    if (Math.abs(documentScroller.scrollHeight - (documentScroller.scrollTop + window.innerHeight)) < 140) {
      window.scrollBy({ top: -Math.max(window.innerHeight * 0.2, 120), behavior: 'smooth' });
      await sleep(humanDelay(700));
    }
  }

  saveLocationResultsState();
  console.log('[Human Behavior Bot] Deep scroll did not reveal more location posts');
  return false;
}

// Opens the next unvisited location post, finds the poster's username,
// and navigates directly to their profile. Stores the found username in
// chrome.storage (key: futnor_location_target_username) so background.js
// can read it reliably — sendResponse doesn't survive page navigation.
// Returns true/false (success).
async function engageNextLocationPost() {
  // NOTE: background.js clears futnor_location_target_username before calling us.
  // We only SET it (never clear it) so retries don't wipe a valid username.

  await Promise.all([refreshDMHistoryCache(), refreshProcessedAccountsCache()]).catch(() => {});

  if (isInstagramReelsPath() || isInstagramDirectPath()) {
    console.log('[Human Behavior Bot] Cannot engage location posts while off the location page');
    return false;
  }

  // Resilient Recent check — URL-based first, then DOM, then clickTab
  const engCurrentPath = normalizeInstagramPath(window.location.pathname);
  const engOnRecentUrl = engCurrentPath.includes('/explore/locations/') && engCurrentPath.endsWith('/recent');
  let engRecentOk = engOnRecentUrl || isLocationRecentViewConfirmed();
  if (!engRecentOk) {
    const recentReady = await clickLocationRecentTab();
    engRecentOk = recentReady || isLocationRecentViewConfirmed();
  }
  if (!engRecentOk) {
    const onLocPage = engCurrentPath.includes('/explore/locations/');
    const postsExist = document.querySelectorAll('main a[href*="/p/"]').length > 0;
    engRecentOk = onLocPage && postsExist;
  }
  if (!engRecentOk) {
    console.log('[Human Behavior Bot] Cannot engage location posts — not on location page');
    return false;
  }

  saveLocationResultsState();
  await waitForLocationGrid(8000).catch(() => false);

  // Get unvisited posts
  let allPostLinks = getLocationResultPostLinks();
  if (allPostLinks.length === 0) {
    console.log('[Human Behavior Bot] No location result posts found, trying deeper scroll...');
    await scrollLocationResults(4);
    allPostLinks = getLocationResultPostLinks();
    if (allPostLinks.length === 0) return false;
  }

  let unvisitedPosts = allPostLinks.filter(a => {
    const href = a.getAttribute('href');
    return href && !visitedPostsThisSession.has(href) && !href.includes('/reel/') && !href.includes('/reels/');
  });

  // If all visible posts visited, scroll for more
  if (unvisitedPosts.length === 0) {
    console.log('[Human Behavior Bot] All visible location posts visited, scrolling to load more...');
    await scrollLocationResults(10);
    unvisitedPosts = getLocationResultPostLinks().filter(a => {
      const h = a.getAttribute('href');
      return h && !visitedPostsThisSession.has(h) && !h.includes('/reel/') && !h.includes('/reels/');
    });
    if (unvisitedPosts.length === 0) {
      console.log('[Human Behavior Bot] No new location posts after extensive scrolling');
      return false;
    }
    console.log(`[Human Behavior Bot] Found ${unvisitedPosts.length} new posts after scrolling`);
  }

  // ── Helper: find poster username from the current post view ────────────────
  function findPosterUsername() {
    const dialog = document.querySelector('[role="dialog"]');
    const searchArea = dialog || document;
    const isModal = !!dialog;

    // Strategy 1: profile links in post header (multiple selector strategies)
    const candidates = [
      ...searchArea.querySelectorAll('a[href^="/"][role="link"]'),
      ...(dialog ? dialog.querySelectorAll('header a[href^="/"]') : []),
      ...searchArea.querySelectorAll('article header a[href^="/"]'),
      ...searchArea.querySelectorAll('article a[href^="/"]'),
      // Broader fallback: any link in the dialog
      ...(dialog ? dialog.querySelectorAll('a[href^="/"]') : []),
    ];
    const seenHrefs = new Set();
    for (const link of candidates) {
      const linkHref = (link.getAttribute('href') || '').split('?')[0].split('#')[0];
      if (seenHrefs.has(linkHref)) continue;
      seenHrefs.add(linkHref);
      const match = linkHref.match(/^\/([a-zA-Z0-9_.]{2,30})\/?$/);
      if (!match) continue;
      if (/\/(explore|direct|p|reel|reels|stories|tags|accounts|tv|locations|web)\b/.test(linkHref)) continue;
      const uname = match[1].toLowerCase();
      if (RESERVED_PROFILE_SEGMENTS.has(uname)) continue;
      console.log(`[Human Behavior Bot] Username from link href: @${uname}`);
      return uname;
    }

    // Strategy 2: document title — Instagram format: "Username on Instagram: ..."
    const tm = document.title.match(/^([a-zA-Z0-9_.]{2,30})\s*(?:•|\bon\b)/i);
    if (tm) {
      const uname = tm[1].toLowerCase();
      if (!RESERVED_PROFILE_SEGMENTS.has(uname)) {
        console.log(`[Human Behavior Bot] Username from title: @${uname}`);
        return uname;
      }
    }

    // Strategy 3: img alt text inside the post — "Photo by Username on ..."
    const imgs = searchArea.querySelectorAll('img[alt]');
    for (const img of imgs) {
      const alt = img.getAttribute('alt') || '';
      const m = alt.match(/^(?:Photo|Video|Image|Clip|Reel)\s+by\s+([a-zA-Z0-9_.]{2,30})\b/i);
      if (m) {
        const uname = m[1].toLowerCase();
        if (!RESERVED_PROFILE_SEGMENTS.has(uname)) {
          console.log(`[Human Behavior Bot] Username from alt text: @${uname}`);
          return uname;
        }
      }
    }

    console.log(`[Human Behavior Bot] ⚠️ Could not extract username from location post (modal=${isModal}, candidates=${candidates.length})`);
    return null;
  }

  // ── Try each unvisited post ────────────────────────────────────────────────
  for (const postLink of unvisitedPosts.slice(0, 8)) {
    const href = postLink.getAttribute('href');
    if (!href) continue;

    // Mark post as visited
    visitedPostsThisSession.add(href);
    persistVisitedPosts();

    // Scroll into view and click the post
    postLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(800));

    console.log('[Human Behavior Bot] Opening location post:', href);
    postLink.click();
    await sleep(humanDelay(2000));

    // Bail if Instagram redirected into Reels
    if (isInstagramReelsPath()) {
      console.log('[Human Behavior Bot] 🚫 Instagram redirected post into Reels — backing out');
      window.history.back();
      await sleep(humanDelay(1800));
      continue;
    }

    // Wait for post modal/article to render (up to 5s)
    let postReady = false;
    for (let w = 0; w < 25; w++) {
      await sleep(200);
      if (document.querySelector('[role="dialog"]') ||
          document.querySelector('article') ||
          normalizeInstagramPath(window.location.pathname).includes('/p/')) {
        postReady = true;
        break;
      }
    }
    if (!postReady) {
      console.log('[Human Behavior Bot] Post did not load — skipping');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(500);
      if (!normalizeInstagramPath(window.location.pathname).includes('/explore/locations/')) {
        window.history.back();
        await sleep(humanDelay(1500));
      }
      continue;
    }

    // Poll for the poster's username (up to 5s — Instagram lazy-renders headers)
    let posterUsername = null;
    for (let poll = 0; poll < 25; poll++) {
      posterUsername = findPosterUsername();
      if (posterUsername) break;
      await sleep(200);
    }

    if (!posterUsername) {
      console.log('[Human Behavior Bot] Could not find poster username in post — trying next');
      await closePostModal();
      await sleep(300);
      if (!normalizeInstagramPath(window.location.pathname).includes('/explore/locations/')) {
        window.history.back();
        await sleep(humanDelay(1500));
      }
      continue;
    }

    if (hasVisitedAccount(posterUsername)) {
      console.log(`[Human Behavior Bot] @${posterUsername} already visited — skipping`);
      await closePostModal();
      await sleep(300);
      if (!normalizeInstagramPath(window.location.pathname).includes('/explore/locations/')) {
        window.history.back();
        await sleep(humanDelay(1000));
      }
      continue;
    }

    // ── Found a valid username — store it for background.js to handle profile nav ───
    markVisitedAccount(posterUsername);
    // MUST await the storage write before any other action — background.js polls
    // this storage key to know which profile to engage with.
    await chrome.storage.local.set({ futnor_location_target_username: posterUsername });
    console.log(`[Human Behavior Bot] ✅ Found poster @${posterUsername} — stored for background.js`);

    // Close the post modal — don't navigate to profile here.
    // Navigating via window.location.href kills the content script (hard reload).
    // Instead, let background.js navigate to the profile via sendActionToTab,
    // which ensures proper message handling and doesn't break the script.
    await closePostModal();
    await sleep(humanDelay(800));

    // Return success — background.js will navigate to the profile and engage
    console.log(`[Human Behavior Bot] ✅ Post modal closed — ready for background.js to navigate to profile`);
    return true;
  }

  return false;
}

// Navigate BACK to the location grid without reloading the page.
// Uses history.back() to preserve scroll position and loaded posts.
async function returnToLocationGrid(maxBackSteps = 5) {
  // If already on location page, nothing to do
  if (normalizeInstagramPath(window.location.pathname).includes('/explore/locations/')) {
    console.log('[Human Behavior Bot] Already on location page');
    await waitForLocationGrid(4000).catch(() => false);
    return true;
  }

  for (let step = 0; step < maxBackSteps; step++) {
    window.history.back();
    await sleep(1200);

    const currentPath = normalizeInstagramPath(window.location.pathname);
    if (currentPath.includes('/explore/locations/')) {
      console.log(`[Human Behavior Bot] ✅ Returned to location grid via history.back() (${step + 1} steps)`);
      // Wait for the grid to re-render
      await waitForLocationGrid(5000).catch(() => false);
      return true;
    }
  }

  console.log('[Human Behavior Bot] ❌ Could not return to location grid via history.back()');
  return false;
}

async function returnToLocationResults(locationUrl) {
  if (!locationUrl) return false;

  const expectedPath = getLocationExpectedPath(locationUrl);
  
  // Already on location page
  if (normalizeInstagramPath(window.location.pathname).includes(expectedPath) || window.location.pathname.includes('/explore/locations/')) {
    const recentReady = await clickLocationRecentTab();
    if (!recentReady || !isLocationRecentViewConfirmed()) return false;
    await waitForLocationGrid(4000).catch(() => false);
    await restoreLocationResultsState(locationUrl);
    saveLocationResultsState(locationUrl);
    return true;
  }

  return await unwindBackToLocationResults(locationUrl, 6);
}

// ─── EXTRACT LOCATION USERNAMES (batch collection) ──────────────
// Scrolls the location grid and collects poster usernames from post thumbnails.
// Returns an array of unique, unvisited usernames (target: 50-70).
async function extractLocationUsernames(targetCount = 60) {
  await Promise.all([refreshDMHistoryCache(), refreshProcessedAccountsCache()]).catch(() => {});

  if (isInstagramReelsPath() || isInstagramDirectPath()) {
    console.log('[Human Behavior Bot] Cannot extract location usernames from reels/direct page');
    return [];
  }

  // ── Resilient Recent-tab verification with retry ──────────────
  // Instagram SPA can leave the page in a transitional state right
  // after navigation.  Retry the check several times before giving up.
  let recentConfirmed = false;
  for (let retryIdx = 0; retryIdx < 5; retryIdx++) {
    // Quick URL-based check first — most reliable signal
    const currentPath = normalizeInstagramPath(window.location.pathname);
    if (currentPath.includes('/explore/locations/') && currentPath.endsWith('/recent')) {
      console.log(`[Human Behavior Bot] Location Recent confirmed via URL (attempt ${retryIdx + 1})`);
      recentConfirmed = true;
      break;
    }

    // Fall back to the full DOM-based check
    if (isLocationRecentViewConfirmed()) {
      console.log(`[Human Behavior Bot] Location Recent confirmed via DOM (attempt ${retryIdx + 1})`);
      recentConfirmed = true;
      break;
    }

    // Try clicking the Recent tab
    const recentReady = await clickLocationRecentTab();
    if (recentReady || isLocationRecentViewConfirmed()) {
      console.log(`[Human Behavior Bot] Location Recent confirmed after clickTab (attempt ${retryIdx + 1})`);
      recentConfirmed = true;
      break;
    }

    console.log(`[Human Behavior Bot] Recent tab not confirmed yet (attempt ${retryIdx + 1}/5, url=${window.location.pathname})`);
    await sleep(1500 + retryIdx * 500);
  }

  // Last-resort fallback: if we're on ANY location page with posts, proceed anyway
  if (!recentConfirmed) {
    const onLocationPage = normalizeInstagramPath(window.location.pathname).includes('/explore/locations/');
    const hasPosts = document.querySelectorAll('main a[href*="/p/"]').length > 0;
    if (onLocationPage && hasPosts) {
      console.log('[Human Behavior Bot] Recent tab not confirmed but on location page with posts — proceeding anyway');
      recentConfirmed = true;
    }
  }

  if (!recentConfirmed) {
    console.log(`[Human Behavior Bot] Cannot extract location usernames — not on location page (url=${window.location.pathname})`);
    return [];
  }

  await waitForLocationGrid(8000).catch(() => false);

  const collectedUsernames = [];
  const seenUsernames = new Set();
  const openedPostHrefs = new Set(); // posts we've already opened as modal entry points
  let scrollStaleRounds = 0;
  const MAX_SCROLL_ROUNDS = 20;

  // ── Helper: strip query string / hash from href before username matching ────
  function cleanHref(raw) {
    return (raw || '').split('?')[0].split('#')[0];
  }

  // ── Helper: is this href a profile link (not a post/reel/explore/etc.) ─────
  function isProfileHref(ch) {
    if (!ch) return false;
    const blocked = ['/p/', '/reel', '/explore', '/direct', '/stories',
                     '/tags', '/accounts', '/tv/', '/locations', '/web/'];
    if (blocked.some(b => ch.includes(b))) return false;
    const m = ch.match(/^\/([a-zA-Z0-9_.]{2,30})\/?$/);
    if (!m) return false;
    return !RESERVED_PROFILE_SEGMENTS.has(m[1].toLowerCase());
  }

  // ── Helper: extract all poster usernames from the open post header ─────────
  // Reads from the post HEADER only (top of post) — the poster's username and,
  // for paid-partnership posts, the brand username are both shown there.
  // Returns an array (may have 1 or 2 usernames). Returns [] if nothing found.
  function extractUsernamesFromPostHeader() {
    const found = [];
    const seen = new Set();

    function addUsername(u) {
      if (!u) return;
      const c = u.toLowerCase().trim();
      if (!c || seen.has(c) || RESERVED_PROFILE_SEGMENTS.has(c)) return;
      if (!/^[a-z0-9._]{2,30}$/.test(c)) return;
      seen.add(c);
      found.push(c);
    }

    // Locate the post article — it exists inside the dialog or directly on page
    const article = document.querySelector('[role="dialog"] article, article');
    if (!article) return found;

    // The post header is the FIRST section of the article.
    // Instagram renders: [profile-pic-link] [username-link] [• paid partnership with @brand]
    // Prefer to search the <header> element (most precise), then fall back to the
    // full article so older and newer Instagram layouts are both covered.
    const headerEl = article.querySelector('header')
      || article.querySelector('[role="banner"]')
      || article.querySelector('div:first-child'); // legacy layout fallback
    const searchEl = headerEl || article;
    // Also try role="link" anchors first (Instagram's newer markup)
    const roleLinks = Array.from(searchEl.querySelectorAll('a[href^="/"][role="link"]'));
    const plainLinks = Array.from(searchEl.querySelectorAll('a[href^="/"]'));
    // Deduplicate while preserving order: role="link" anchors first
    const seen2 = new Set();
    const allLinks = [...roleLinks, ...plainLinks].filter(l => {
      const h = l.getAttribute('href') || '';
      if (seen2.has(h)) return false;
      seen2.add(h);
      return true;
    });

    for (const link of allLinks) {
      const ch = cleanHref(link.getAttribute('href') || '');
      if (!isProfileHref(ch)) continue;
      const m = ch.match(/^\/([a-zA-Z0-9_.]{2,30})\/?$/);
      if (!m) continue;
      addUsername(m[1]);
      // Collect at most 2 usernames (poster + partner) from the header
      if (found.length >= 2) break;
    }

    // If article links found nothing, try document.title as last resort
    // Instagram title format: "username • Instagram" or "username on Instagram: caption"
    if (found.length === 0) {
      const tm = document.title.match(/^([a-zA-Z0-9_.]{2,30})\s*(?:•|\bon\b)/i);
      if (tm) addUsername(tm[1]);
    }

    return found;
  }

  // ── Helper: close the post modal and restore the location grid ────────────
  async function closeModalAndReturn() {
    // Press Escape to close the modal
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    await sleep(500);

    // If modal still open, use the close button
    if (document.querySelector('[role="dialog"]')) {
      await closePostModal();
      await sleep(500);
    }

    // If we drifted off the location page (e.g. full-page post load), go back
    if (!normalizeInstagramPath(window.location.pathname).includes('/explore/locations/')) {
      window.history.back();
      await sleep(1500);
      await waitForLocationGrid(5000).catch(() => false);
    }
  }

  // ── Main collection loop ──────────────────────────────────────────────────
  // For each unvisited post in the grid:
  //   1. Click it to open the post modal
  //   2. Wait for the header to render (poll up to 3s)
  //   3. Extract username(s) from the header (poster + partnership brand)
  //   4. Close the modal → back to grid
  //   5. Move to next post
  //   6. Scroll grid when all visible posts are processed

  for (let round = 0; round < MAX_SCROLL_ROUNDS && collectedUsernames.length < targetCount; round++) {
    const postLinks = getLocationResultPostLinks();
    const unvisited = postLinks.filter(a => {
      const h = a.getAttribute('href');
      return h && !openedPostHrefs.has(h) && !h.includes('/reel/') && !h.includes('/reels/');
    });

    if (unvisited.length === 0) {
      console.log(`[Human Behavior Bot] All visible posts processed — scrolling for more (round ${round + 1})`);
      const loaded = await scrollLocationResults(6);
      scrollStaleRounds = loaded ? 0 : scrollStaleRounds + 1;
      if (scrollStaleRounds >= 4) {
        console.log('[Human Behavior Bot] No more posts loading — stopping collection');
        break;
      }
      await sleep(humanDelay(1000));
      continue;
    }

    for (const postLink of unvisited) {
      if (collectedUsernames.length >= targetCount) break;

      const postHref = postLink.getAttribute('href');
      openedPostHrefs.add(postHref); // mark before clicking to prevent re-entry

      // ── Fast path: extract username from thumbnail without opening modal ──────
      // extractUsernameFromThumbnail reads React fiber / img alt / aria-label,
      // which avoids the expensive click → wait → close modal cycle entirely.
      const thumbUsername = extractUsernameFromThumbnail(postLink);
      if (thumbUsername) {
        if (!seenUsernames.has(thumbUsername)) {
          seenUsernames.add(thumbUsername);
          if (hasVisitedAccount(thumbUsername)) {
            console.log(`[Human Behavior Bot] @${thumbUsername} already visited — skipping (thumbnail fast-path)`);
          } else {
            collectedUsernames.push(thumbUsername);
            console.log(`[Human Behavior Bot] ✓ Collected @${thumbUsername} via thumbnail (${collectedUsernames.length}/${targetCount})`);
          }
        }
        continue; // no need to open modal for this post
      }

      // ── Slow path: open modal to extract username from post header ────────────
      // Scroll post into view and click to open as modal
      postLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);
      postLink.click();

      // Wait for modal or /p/ URL (up to 4 s)
      let modalReady = false;
      for (let w = 0; w < 25; w++) {
        await sleep(160);
        const onPost = normalizeInstagramPath(window.location.pathname).includes('/p/');
        if (document.querySelector('[role="dialog"]') || onPost) { modalReady = true; break; }
      }

      if (!modalReady) {
        console.log(`[Human Behavior Bot] Modal did not open for ${postHref} — skipping`);
        if (!normalizeInstagramPath(window.location.pathname).includes('/explore/locations/')) {
          window.history.back();
          await sleep(1500);
          await waitForLocationGrid(5000).catch(() => false);
        }
        continue;
      }

      // Poll for usernames to appear in the post header (up to 3 s)
      let headerUsernames = [];
      for (let attempt = 0; attempt < 15; attempt++) {
        await sleep(200);
        headerUsernames = extractUsernamesFromPostHeader();
        if (headerUsernames.length > 0) break;
      }

      console.log(`[Human Behavior Bot] Post ${postHref} → header usernames: [${headerUsernames.join(', ')}] | title: "${document.title.slice(0, 55)}"`);

      // Record each username found (poster + partnership brand)
      for (const u of headerUsernames) {
        if (collectedUsernames.length >= targetCount) break;
        if (seenUsernames.has(u)) continue;
        seenUsernames.add(u);
        if (hasVisitedAccount(u)) {
          console.log(`[Human Behavior Bot] @${u} already visited — skipping`);
          continue;
        }
        collectedUsernames.push(u);
        console.log(`[Human Behavior Bot] ✓ Collected @${u} (${collectedUsernames.length}/${targetCount})`);
      }

      // Close the modal — stay on the location grid
      await closeModalAndReturn();
      await sleep(humanDelay(400)); // small human-like pause between posts
    }

    scrollStaleRounds = 0;
  }

  console.log(`[Human Behavior Bot] Location batch collection complete: ${collectedUsernames.length} usernames`);
  return collectedUsernames;
}

// ─── NAVIGATE TO POST (for likers/commenters) ──────────────
/**
 * Find the clickable element that opens the post's likers dialog.
 * Tries six strategies in order of reliability so the bot stays robust
 * against Instagram's frequent DOM rearrangements:
 *
 *   1. <a href="/p/<id>/liked_by/"> direct link (classic markup)
 *   2. aria-label containing "view likes" / "see likes" / "liked by"
 *   3. Pure-text "<N> likes" or "<N> likes" with thousands separators
 *   4. "Liked by <user> and <N> others" footer text
 *   5. "<N> others" / "and <N> others" partial matches
 *   6. Bare numeric span sitting next to a heart icon (the "view-count
 *      number" pattern Instagram uses on newer post designs)
 *
 * Returns the clickable Element, or null if no likers-opener can be found
 * on the page (e.g. the post owner has like-counts hidden in their
 * privacy settings, or it's a /reel/ that doesn't expose a likers list).
 */
function findLikersOpener() {
  // 1. Direct liked_by link — most reliable on classic post pages.
  const direct = document.querySelector('a[href$="/liked_by/"], a[href*="/liked_by/"]');
  if (direct) return direct;

  // 2. aria-label based — newer markup uses this on the like-count clickable.
  const byAria = document.querySelector(
    '[aria-label*="View likes" i], [aria-label*="See likes" i], a[aria-label*="liked" i], button[aria-label*="liked" i]'
  );
  if (byAria) return byAria;

  // 3 + 4 + 5. Text-based scan — broader patterns than the previous bot used.
  const NOISE_LIMIT = 100; // skip elements with huge text blocks (post bodies, etc.)
  const allClickable = document.querySelectorAll('a, button, span, div[role="button"]');
  for (const el of allClickable) {
    const text = (el.textContent || '').trim();
    if (!text || text.length > NOISE_LIMIT) continue;
    const lower = text.toLowerCase();

    // "1,234 likes" / "1234 likes" / "1.2k likes" / "1 like"
    if (/^\d[\d,.\s]*\s*(?:k|m)?\s*likes?$/i.test(text)) return el;

    // "Liked by <name> and 1,234 others"
    if (lower.startsWith('liked by') && (/\bother/.test(lower) || /\d/.test(lower))) return el;

    // "and 1,234 others" / "1,234 others"
    if (/^(?:and\s+)?\d[\d,.\s]*\s*others?$/i.test(text)) return el;

    // "View all 1,234 likes" / "See all likes"
    if (/^view\s+(?:all\s+)?(?:\d[\d,.\s]*\s+)?likes?$/i.test(text)
        || /^see\s+(?:all\s+)?likes?$/i.test(text)) return el;
  }

  // 6. Bare-number span adjacent to a heart icon. On Reels and some newer
  //    post designs, Instagram shows just the count as a number — the only
  //    way to identify it as the like-count vs (e.g.) a comment count is to
  //    locate the heart svg's siblings.
  const heartSelectors = [
    'svg[aria-label="Like" i]',
    'svg[aria-label="Unlike" i]',
    'svg[aria-label*="like count" i]',
  ];
  for (const sel of heartSelectors) {
    for (const heart of document.querySelectorAll(sel)) {
      // Walk a couple of levels out to find the section/footer that contains
      // both the heart and the count. Cap depth so we never reach <body>.
      let scope = heart.closest('section') || heart.closest('div[role]');
      if (!scope) {
        let cur = heart.parentElement;
        for (let d = 0; d < 4 && cur; d++, cur = cur.parentElement) scope = cur;
      }
      if (!scope) continue;
      // Look for a sibling element whose visible text is JUST a number
      // (allowing "k" / "m" suffixes and thousand separators).
      for (const sib of scope.querySelectorAll('a, button, span, div[role="button"]')) {
        if (sib === heart) continue;
        const t = (sib.textContent || '').trim();
        if (!t || t.length > 12) continue;
        if (/^\d[\d,.\s]*\s*(?:k|m)?$/i.test(t)) {
          // bare number — likely the like count
          return sib.closest('a, button, [role="button"]') || sib;
        }
      }
    }
  }

  return null;
}

async function navigatePost(postLink, targetType) {
  if (!postLink) return false;
  
  // Extract the post URL — handle both full URLs and shortcodes
  let postUrl = postLink;
  if (!postUrl.startsWith('http')) {
    postUrl = `https://www.instagram.com/p/${postLink}/`;
  }
  // Normalize URL
  if (!postUrl.includes('instagram.com')) {
    postUrl = `https://www.instagram.com${postUrl.startsWith('/') ? '' : '/p/'}${postUrl}`;
  }
  
  // Navigate to the post.
  // v2.4.100: only navigate when the URL doesn't already include the post
  // path. The previous v2.4.99 change force-navigated on every iteration
  // when targetType === 'likers', which caused an infinite full-page-reload
  // loop (every iteration replaced window.location.href, killing the
  // content script, the dashboard saw "Reconnecting to extension...", the
  // session re-initialised and tried to navigate again — forever).
  const postPath = postUrl.replace('https://www.instagram.com', '');
  const onPostUrlAlready = window.location.href.includes(postPath);
  if (!onPostUrlAlready) {
    window.location.href = postUrl;
    await sleep(3000);
  }

  if (targetType === 'likers') {
    // If the likers modal is ALREADY open (from the previous iteration on
    // the same page), we don't need to re-click anything — just let the
    // upcoming engageFromModal pick the next candidate. Otherwise, click
    // the likes-link to open a fresh modal.
    //
    // Use the same strict positive-signal match used below so we don't
    // mistakenly "reuse" the post lightbox as the likers modal.
    // v2.4.126: same strict check as below — require an explicit
    // "Likes" / "Liked by" / "N likes" header. Follow-button shortcut
    // dropped because the post lightbox now ships with a "Suggested for
    // you" sidebar that has several Follow buttons.
    const existingLikersDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => {
      if (d.querySelector('article')) return false;
      if (d.querySelector('video')) return false;
      for (const img of d.querySelectorAll('img')) {
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        const cw = img.clientWidth || 0;
        const ch = img.clientHeight || 0;
        if (Math.max(nw, cw) > 200 || Math.max(nh, ch) > 200) return false;
      }
      // v2.4.127: ONLY accept exact "Likes" / "Liked by" / "Liked by X" titles
      // in real heading elements (h1/h2/h3/[role="heading"]). The previous
      // version also matched "<number> likes" in header span/header div —
      // but the POST LIGHTBOX header contains a like-COUNT element (e.g.
      // "630 likes" near the heart button) and that text matched the
      // "\d+ likes" alternative, so the bot accepted the lightbox.
      //
      // The likers modal title is ALWAYS a plain heading element with
      // EXACTLY "Likes" or "Liked by" — never the like count. Restricting
      // to that combination eliminates the lightbox false-positive
      // without breaking any real likers modal.
      for (const h of d.querySelectorAll('h1, h2, h3, [role="heading"]')) {
        const t = (h.textContent || '').trim();
        if (!t) continue;
        if (/^\s*(likes?|liked by)\s*$/i.test(t)) return true;
      }
      return false;
    });
    if (existingLikersDialog) {
      console.log('[Human Behavior Bot] navigatePost: likers modal already open — reusing');
      // Pagination on a fresh-feeling list — make sure we don't carry over
      // a scroll offset that would skip rows.
      setModalScrollOffset(0);
      return true;
    }

    // ── /liked_by/ NAVIGATION FIRST, CLICK FALLBACK (v2.4.135) ───────
    // The popup widget (opened by clicking the likes count) consistently
    // returns only 2 likers because IG's lazy-loader is gated on
    // isTrusted=true scroll events, which JS-dispatched scrolls can
    // never produce. No amount of scroll-trigger tuning bypasses this.
    //
    // Direct /p/<id>/liked_by/ navigation loads ~30 likers in the
    // initial server response — far more useful for actual DM
    // throughput. We trade the popup look for ~15× more DMs per
    // session (2 → 30+).
    //
    // The user previously asked for the popup; that gave them 2 DMs.
    // Restoring the URL approach so they get real volume back.
    const shortcodeMatch = (window.location.pathname || '').match(/^\/(p|reel)\/([^/?#]+)/);
    if (shortcodeMatch) {
      const shortcode = shortcodeMatch[2];
      const likedByPath = `/${shortcodeMatch[1]}/${shortcode}/liked_by/`;
      if (!window.location.pathname.endsWith('/liked_by/')) {
        console.log(`[Human Behavior Bot] navigatePost: pushing state to ${likedByPath} — full-page mode loads ~15× more likers than the popup`);
        try {
          history.pushState({}, '', likedByPath);
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        } catch {}
        await sleep(humanDelay(2500));
      } else {
        console.log('[Human Behavior Bot] navigatePost: already on /liked_by/ URL, reusing');
      }
    } else {
      // Fallback: shortcode unavailable, try the click path
      const likesLink = findLikersOpener();
      if (likesLink) {
        const clickable = likesLink.closest('a') || likesLink.closest('button') || likesLink;
        await humanClick(clickable);
        await sleep(humanDelay(3500));
      }
    }

    {

      // Pagination on a fresh likers list — clear any modalScrollOffset left
      // over from a previous followers/following modal so we don't jump past
      // unloaded rows on the new list.
      setModalScrollOffset(0);

      // ── STRICT LIKERS-DIALOG MATCH (v2.4.126) ────────────────────────
      // v2.4.124's "≥3 Follow buttons" alternative positive signal was
      // accepting the post lightbox — modern IG renders a "Suggested
      // for you" sidebar inside the lightbox with several Follow
      // buttons, which passed the threshold. Bot then "found" a dialog
      // with only 2 visible profile-links (the post owner + a tagged
      // user), couldn't scroll (clientH===scrollH), gave up.
      //
      // Now: require the dialog's HEADER text to explicitly match
      // "Likes" / "Liked by" / "N likes". The likers modal ALWAYS has
      // this header. The lightbox has the post owner's username or
      // post caption as its title, never "Likes". This is a hard
      // positive — no Follow-button shortcut.
      //
      // Negative checks remain:
      //   • <article> in dialog (some post-modal variants)
      //   • <video>
      //   • <img> with natural OR client width/height > 200 (post media)
      //
      // Plus a HEADER-LEVEL diagnostic log so we can see exactly which
      // dialog title text the bot is reading on every attempt.
      const HEADER_RE = /^\s*(likes?|liked by)\s*$/i;
      const dialogHasLikesHeader = (d) => {
        const headers = d.querySelectorAll('h1, h2, h3, [role="heading"]');
        for (const h of headers) {
          const t = (h.textContent || '').trim();
          if (t && HEADER_RE.test(t)) return t;
        }
        return null;
      };
      const isLikersModal = (d) => {
        if (!d) return false;
        if (d.querySelector('article')) return false;
        if (d.querySelector('video')) return false;
        for (const img of d.querySelectorAll('img')) {
          const nw = img.naturalWidth || 0;
          const nh = img.naturalHeight || 0;
          const cw = img.clientWidth || 0;
          const ch = img.clientHeight || 0;
          if (Math.max(nw, cw) > 200 || Math.max(nh, ch) > 200) return false;
        }
        return !!dialogHasLikesHeader(d);
      };

      // Wait up to ~10s for IG to render the modal OR (after pushState
      // navigation) the full-page /liked_by/ list.
      let modal = null;
      let fullPageMode = false;
      for (let w = 0; w < 25; w++) {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        for (let i = dialogs.length - 1; i >= 0; i--) {
          if (isLikersModal(dialogs[i])) { modal = dialogs[i]; break; }
        }
        if (modal) break;
        // Detect full-page mode — /liked_by/ URL with likers rendered
        // in <main>. We accept this as soon as 3+ profile-link rows
        // are present on the page, which is the fastest reliable signal
        // (no header text check needed since the URL itself confirms).
        const onLikedBy = /\/(p|reel)\/[^/]+\/liked_by\/?$/.test(window.location.pathname);
        if (onLikedBy) {
          const mainEl = document.querySelector('main') || document.querySelector('[role="main"]');
          if (mainEl) {
            const handles = new Set();
            for (const link of mainEl.querySelectorAll('a[href^="/"]')) {
              const u = parseInstagramUsernameFromHref(link.getAttribute('href') || '');
              if (u) handles.add(u);
              if (handles.size >= 3) break;
            }
            if (handles.size >= 3) {
              modal = mainEl;
              fullPageMode = true;
              console.log('[Human Behavior Bot] navigatePost: detected full-page /liked_by/ list');
              break;
            }
          }
        }
        await sleep(400);
      }

      // Diagnostic: log what each dialog header looks like when no match.
      // The user reports "only 2 profiles loaded" — if our strict header
      // match misses the real likers modal because IG localised/changed
      // the header text, this log will show the exact string so we can
      // extend the regex precisely.
      if (!modal) {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        const inspected = Array.from(dialogs).slice(-3).map((d, idx) => {
          const headers = Array.from(d.querySelectorAll('h1, h2, h3, [role="heading"]'))
            .map((h) => (h.textContent || '').trim())
            .filter((t) => t && t.length > 0 && t.length < 80)
            .slice(0, 3);
          return `dialog[${idx}] headers=[${headers.map((h) => `"${h}"`).join(', ')}]`;
        });
        console.log(`[Human Behavior Bot] No likers dialog matched. Inspected ${dialogs.length} dialog(s): ${inspected.join(' | ')}`);
      }

      if (modal) {
        // Instagram's likers list is virtualized. The modal nests:
        //   div[role="dialog"]
        //     div (header)
        //     div (overflow-y: auto, the actual scroller)  ← we want this
        //       div (inner row container, has all the profile links)
        //
        // Previous detector walked up from the first profile link and
        // picked the FIRST ancestor with overflow-y:auto/scroll/overlay.
        // That sometimes grabbed an outer WRAPPER that's marked auto but
        // has no actual content overflow (scrollHeight === clientHeight),
        // so scroll triggers fired against it never woke IG's loader. User
        // saw "initial 2 unique profiles", "scrollH=356" stuck for 10
        // rounds on a 630-like post.
        //
        // New detector (v2.4.123):
        //   1. Collect ALL scrollable elements anywhere under the modal
        //   2. Prefer ones that ALREADY overflow (scrollH > clientH + 20)
        //   3. Among those, take the largest by clientHeight (the actual
        //      list scroller; nested overflow-clip children are smaller)
        //   4. If none currently overflow (truly tiny lists OR list
        //      hasn't hydrated past the first 2 rows), fall back to the
        //      heuristic: largest scrollable descendant ≥ 80px tall
        const isScrollableStyle = (el) => {
          const s = window.getComputedStyle(el);
          const oy = s.overflowY;
          return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        };

        // Pool: every potentially scrollable element under the modal
        // (including the modal itself), large enough to be a list.
        const collectScrollables = () => {
          const result = [];
          if (isScrollableStyle(modal) && modal.clientHeight > 80) result.push(modal);
          for (const div of modal.querySelectorAll('div')) {
            if (!isScrollableStyle(div)) continue;
            if (div.clientHeight < 80) continue;
            result.push(div);
          }
          return result;
        };

        const pickScrollContainer = () => {
          const candidates = collectScrollables();
          if (candidates.length === 0) return modal;
          // Prefer ones that ALREADY overflow — guaranteed to be the right
          // scroller because they're already holding more content than fits.
          const overflowing = candidates.filter((el) => el.scrollHeight > el.clientHeight + 20);
          if (overflowing.length > 0) {
            overflowing.sort((a, b) => b.clientHeight - a.clientHeight);
            return overflowing[0];
          }
          // Else: largest scrollable. Tie-broken by being closest to a
          // profile link (deeper in the DOM).
          candidates.sort((a, b) => b.clientHeight - a.clientHeight);
          return candidates[0];
        };

        let scrollContainer = pickScrollContainer();
        console.log(`[Human Behavior Bot] Likers scroll container: clientH=${scrollContainer.clientHeight}, scrollH=${scrollContainer.scrollHeight}`);

        // After the first batch of scrolls, IG hydrates more rows and the
        // "real" scrollable suddenly starts overflowing. Re-pick once after
        // ~1s so we switch from a fallback container to the proper one.
        const reselectScrollContainerIfBetter = () => {
          const next = pickScrollContainer();
          if (next !== scrollContainer && next.scrollHeight > next.clientHeight + 20) {
            console.log(`[Human Behavior Bot] Switched likers scroll container: clientH=${next.clientHeight}, scrollH=${next.scrollHeight}`);
            scrollContainer = next;
          }
        };

        const seen = new Set();
        const harvest = () => {
          for (const link of modal.querySelectorAll('a[href^="/"]')) {
            const u = parseInstagramUsernameFromHref(link.getAttribute('href') || '');
            if (u) seen.add(u);
          }
        };
        harvest();
        console.log(`[Human Behavior Bot] Likers modal opened, initial ${seen.size} unique profiles`);

        // ── SIMPLIFIED SCROLL TRIGGERS (v2.4.128) ─────────────────────
        // User reported pagination going from scrollH=399 → scrollH=0
        // by round 10 — the bot's own triggers were COLLAPSING the
        // modal. Manual click opens the full likers list with all
        // 630 profiles, so IG isn't restricting the account — the
        // bot's scroll events were dismissing the modal.
        //
        // Most likely culprits in the v2.4.123 "aggressive" approach:
        //   • Wheel events on the modal/dialog itself were being
        //     interpreted as "swipe to dismiss" on touch-aware DOM
        //   • KeyboardEvent('PageDown') on the modal was triggering
        //     IG's global navigation handlers (next post, etc)
        //   • Multi-target wheel events from outer wrappers cascaded
        //     into outside listeners
        //
        // New approach: target ONLY the actual scroll container with
        // gentle, single-pass scroll triggers. Same mechanics a human
        // would do — set scrollTop, dispatch a scroll event, use
        // scrollIntoView on the last row. No wheel events, no keyboard
        // events, no broad targets.
        const fireScrollTriggers = () => {
          if (fullPageMode) {
            try {
              window.scrollTo(0, document.documentElement.scrollHeight);
            } catch {}
          } else {
            if (!scrollContainer) return;
            try { scrollContainer.scrollTop = scrollContainer.scrollHeight; } catch {}
            try { scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
          }

          // ── WAKE THE LOADER (v2.4.134) ────────────────────────────────
          // Old approach: scrollIntoView on the last <a> link. Problem:
          // when only 2 rows are loaded, that link IS already visible,
          // so the IntersectionObserver attached to a SENTINEL element
          // (a skeleton or "Loading…" div IG places AFTER the visible
          // rows) never enters the viewport.
          //
          // We now look for IG's sentinel element specifically: it's
          // typically the LAST CHILD of the scroll container (a small
          // div with no profile link), or an element with a loading
          // spinner. Scrolling that into view triggers IG's fetch even
          // when only a couple of rows exist.
          //
          // Fallback to the last profile link only if no sentinel is
          // found — that still works after the first few rows load.
          const target = (() => {
            const candidates = [
              // Loading / spinner anywhere in the container
              modal.querySelector('svg[aria-label="Loading..."]'),
              modal.querySelector('[role="progressbar"]'),
              modal.querySelector('[aria-label*="loading" i]'),
            ].filter(Boolean);
            if (candidates.length > 0) return candidates[0];

            // Otherwise, the LAST descendant element of the scroll
            // container — by document order. This is whatever IG places
            // at the end of its virtualized list (sentinel div).
            const scope = fullPageMode ? (modal.querySelector('section, article, [role="main"]') || modal) : (scrollContainer || modal);
            const all = scope.querySelectorAll('*');
            if (all.length > 0) return all[all.length - 1];

            // Last fallback: last profile-link row.
            const links = modal.querySelectorAll('a[href^="/"]');
            return links.length ? links[links.length - 1] : null;
          })();

          if (target) {
            try { target.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch {}
          }
        };

        // v2.4.132: bumped MAX_ROUNDS 80→150 and STALE_LIMIT 14→25 so
        // pagination is more patient on big lists (3k+ likers). User
        // reported a 3k-like post only loaded ~30 likers — pagination
        // was giving up before IG's lazy-loader could backfill. Each
        // stale round costs ~1.5s of waiting, so 25 rounds is ~40s of
        // patience before declaring the list exhausted. The total cap
        // (150 rounds × ~1.5s) is still bounded at ~4 minutes.
        const MAX_ROUNDS = 150;
        const STALE_LIMIT = 25;
        let staleRounds = 0;
        let lastSize = seen.size;
        for (let round = 0; round < MAX_ROUNDS && staleRounds < STALE_LIMIT; round++) {
          fireScrollTriggers();
          await sleep(humanDelay(randomInt(800, 1300)));
          fireScrollTriggers();
          await sleep(humanDelay(randomInt(600, 1000)));

          // Every few rounds, bounce up slightly then back down — some
          // virtualized lists need this nudge to refetch the next page.
          if (round % 4 === 3) {
            try {
              if (fullPageMode) {
                window.scrollBy(0, -400);
              } else {
                scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollHeight - 800);
                scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
              }
            } catch {}
            await sleep(220);
            fireScrollTriggers();
            await sleep(humanDelay(randomInt(700, 1100)));
          }

          // After each round, re-check if a BETTER scroll container has
          // appeared. (Popup mode only — full-page mode uses window scroll.)
          if (!fullPageMode) reselectScrollContainerIfBetter();

          harvest();
          if (seen.size > lastSize) {
            staleRounds = 0;
            lastSize = seen.size;
          } else {
            staleRounds++;
          }

          if ((round + 1) % 5 === 0) {
            console.log(`[Human Behavior Bot] Likers pagination round ${round + 1}: ${seen.size} unique (stale=${staleRounds}, scrollH=${scrollContainer.scrollHeight})`);
          }
        }
        console.log(`[Human Behavior Bot] Likers modal fully scrolled: ${seen.size} unique profiles surfaced`);
      } else {
        console.log('[Human Behavior Bot] Likers dialog never appeared after click');
      }
      return true;
    }
  } else if (targetType === 'commenters') {
    // Scroll through comments section
    const commentSection = document.querySelector('ul[class*="comment"]')
      || document.querySelector('[role="dialog"] ul')
      || document.querySelector('main ul');
    
    if (commentSection) {
      for (let i = 0; i < randomInt(3, 6); i++) {
        commentSection.scrollTop += randomInt(80, 200);
        await sleep(humanDelay(800));
      }
      
      // Click "View more comments" if available
      const viewMore = Array.from(document.querySelectorAll('button, span')).find(
        el => el.textContent?.toLowerCase().includes('view') && el.textContent?.toLowerCase().includes('comment')
      );
      if (viewMore) {
        await humanClick(viewMore.closest('button') || viewMore);
        await sleep(humanDelay(1500));
      }
      return true;
    }
  }
  
  await performScroll();
  return true;
}

// ─── SEARCH FOR USERNAME (HUMAN-LIKE) ──────────────────────
async function searchAndNavigateProfile(username) {
  if (!username) return false;
  const clean = username.replace(/^@/, '');
  
  console.log(`[Human Behavior Bot] Searching for @${clean} using search bar`);
  
  // Click on search icon/link in sidebar
  const searchIcon = Array.from(document.querySelectorAll('a[href*="/search"], svg[aria-label*="Search"], span')).find(el => {
    const text = el.textContent?.toLowerCase() || '';
    const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
    return text.includes('search') || ariaLabel.includes('search');
  });
  
  if (!searchIcon) {
    console.log('[Human Behavior Bot] Search icon not found, falling back to direct navigation');
    window.location.href = `https://www.instagram.com/${clean}/`;
    await sleep(3000);
    return true;
  }
  
  const clickableSearch = searchIcon.closest('a') || searchIcon.closest('button') || searchIcon.closest('[role="link"]') || searchIcon;
  await humanClick(clickableSearch);
  await sleep(humanDelay(1500));
  
  // Find and click on the search input field
  const searchInput = document.querySelector('input[type="text"][placeholder*="Search"], input[aria-label*="Search"], input[placeholder*="search"]');
  if (!searchInput) {
    console.log('[Human Behavior Bot] Search input not found, falling back to direct navigation');
    window.location.href = `https://www.instagram.com/${clean}/`;
    await sleep(3000);
    return true;
  }
  
  await humanClick(searchInput);
  await sleep(humanDelay(800));
  
  // Type the username with human-like delays
  for (const char of clean) {
    searchInput.value += char;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(randomInt(100, 250));
  }
  
  // Wait for search results to appear
  await sleep(humanDelay(1500));
  
  // Find and click on the profile from search results
  const searchResults = document.querySelectorAll('a[href^="/"][role="link"]');
  let profileLink = null;
  
  for (const result of searchResults) {
    const href = result.getAttribute('href') || '';
    const exactMatch = href === `/${clean}/` || href === `/${clean}`;
    const text = result.textContent?.toLowerCase() || '';
    
    if (exactMatch || text.includes(clean.toLowerCase())) {
      profileLink = result;
      break;
    }
  }
  
  if (!profileLink) {
    console.log(`[Human Behavior Bot] Profile @${clean} not found in search results, falling back to direct navigation`);
    window.location.href = `https://www.instagram.com/${clean}/`;
    await sleep(3000);
    return true;
  }
  
  await humanClick(profileLink);
  await sleep(humanDelay(2500));
  console.log(`[Human Behavior Bot] Successfully navigated to @${clean} via search`);
  return true;
}

// ─── NAVIGATE TO USER'S FOLLOWERS/FOLLOWING ────────────────
async function navigateUserFollowers(username, type) {
  if (!username) return false;
  const clean = username.replace(/^@/, '').toLowerCase();

  // Close any non-followers modal first (e.g. post modal left from profileLike)
  const existingModal = document.querySelector('[role="dialog"]');
  if (existingModal) {
    const modalProfileCount = Array.from(existingModal.querySelectorAll('a[href]'))
      .map((link) => parseInstagramUsernameFromHref(link.getAttribute('href') || ''))
      .filter(Boolean).length;
    const hasPostContent = existingModal.querySelector('img[srcset], video, article');
    const isFollowersModal = modalProfileCount >= 3 && !hasPostContent;

    if (isFollowersModal) {
      console.log('[Human Behavior Bot] Followers modal already open, scrolling deeper to load new accounts...');
      await scrollModalForFreshAccounts(existingModal, {
        stepsMin: 5,
        stepsMax: 9,
        jumpMin: 200,
        jumpMax: 420,
      });
      return true;
    }

    console.log('[Human Behavior Bot] Non-followers modal detected, closing it...');
    const closeBtn = existingModal.querySelector('svg[aria-label="Close"]')?.closest('button')
      || existingModal.querySelector('button[aria-label="Close"]');
    if (closeBtn) {
      await humanClick(closeBtn);
      await sleep(humanDelay(700));
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(humanDelay(700));
    }
  }

  // Navigate to profile if not there
  if (!window.location.pathname.toLowerCase().includes(`/${clean}`)) {
    await searchAndNavigateProfile(clean);
  }

  const selector = type === 'following' ? 'following' : 'followers';
  const expectedPrefix = `/${clean}/`;
  let targetLink = Array.from(document.querySelectorAll('a[href]')).find((link) => {
    const href = (link.getAttribute('href') || '').toLowerCase();
    return href.startsWith(expectedPrefix) && href.includes(`/${selector}`);
  }) || null;

  // Fallback: look for text containing "followers" or "following"
  if (!targetLink) {
    targetLink = Array.from(document.querySelectorAll('a')).find((link) => {
      const text = (link.textContent || '').toLowerCase();
      return type === 'following' ? text.includes('following') : text.includes('follower');
    }) || null;
  }

  if (!targetLink) return false;

  await humanClick(targetLink);
  await sleep(humanDelay(1800));

  const modal = document.querySelector('[role="dialog"]');
  if (modal) {
    await scrollModalForFreshAccounts(modal, {
      stepsMin: 6,
      stepsMax: 10,
      jumpMin: 220,
      jumpMax: 480,
    });
    console.log(`[Human Behavior Bot] Modal scrolled to offset ${modalScrollOffset}`);
  }

  return true;
}

// ─── NAVIGATE TO A SPECIFIC PROFILE ─────────────────────────
async function navigateProfile(username) {
  if (!username) return false;
  const clean = username.replace(/^@/, '').toLowerCase();

  // Check if already on the correct profile
  const currentPath = window.location.pathname.toLowerCase();
  const isOnProfile = currentPath === `/${clean}` || currentPath === `/${clean}/`;

  if (!isOnProfile) {
    await searchAndNavigateProfile(clean);
    await sleep(humanDelay(1000));

    // Verify we actually arrived at the profile
    const newPath = window.location.pathname.toLowerCase();
    const arrivedOk = newPath === `/${clean}` || newPath === `/${clean}/` || newPath.startsWith(`/${clean}/`);

    if (!arrivedOk) {
      console.log(`[Human Behavior Bot] searchAndNavigateProfile didn't land on /${clean}/ (got ${newPath}), trying SPA-friendly link click...`);

      // CRITICAL: do NOT use window.location.href = ... here. Assigning to
      // window.location triggers a FULL PAGE RELOAD, which destroys the
      // running content script. background.js sees the script disappear and
      // marks the targeting session as completed — even though the bot was
      // mid-flow. This is the "session stops after /direct/inbox/" symptom:
      // the bot got stuck on /direct/, search-nav failed, the old fallback
      // hard-reloaded the page, the script died, and the session ended.
      //
      // Instead, dispatch a synthetic anchor click. Instagram's React Router
      // intercepts same-origin link clicks and runs SPA navigation, which
      // keeps the content script alive across the route change.
      const targetUrl = `https://www.instagram.com/${clean}/`;
      let spaNavSucceeded = false;
      try {
        const tempLink = document.createElement('a');
        tempLink.href = targetUrl;
        tempLink.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(tempLink);
        tempLink.click();
        document.body.removeChild(tempLink);
        for (let i = 0; i < 16; i++) {
          await sleep(500);
          const p = window.location.pathname.toLowerCase();
          if (p === `/${clean}` || p === `/${clean}/` || p.startsWith(`/${clean}/`)) {
            spaNavSucceeded = true;
            break;
          }
        }
      } catch (e) {
        console.log('[Human Behavior Bot] SPA nav fallback error:', e?.message || e);
      }

      // Last resort: if SPA nav didn't work, try history.back() to step out
      // of /direct/ before another SPA attempt. Still avoids the page-reload.
      if (!spaNavSucceeded && window.location.pathname.includes('/direct/')) {
        console.log('[Human Behavior Bot] SPA nav stalled on /direct/, stepping back via history...');
        try { window.history.back(); } catch {}
        await sleep(1500);
        try {
          const tempLink2 = document.createElement('a');
          tempLink2.href = targetUrl;
          tempLink2.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
          document.body.appendChild(tempLink2);
          tempLink2.click();
          document.body.removeChild(tempLink2);
          for (let i = 0; i < 12; i++) {
            await sleep(500);
            const p = window.location.pathname.toLowerCase();
            if (p === `/${clean}` || p === `/${clean}/` || p.startsWith(`/${clean}/`)) {
              spaNavSucceeded = true;
              break;
            }
          }
        } catch {}
      }

      if (!spaNavSucceeded) {
        console.log(`[Human Behavior Bot] ❌ Could not SPA-navigate to @${clean} from ${window.location.pathname}`);
        return false;
      }
    }

    // Wait for profile header to render
    for (let w = 0; w < 10; w++) {
      if (document.querySelector('header section')) break;
      await sleep(500);
    }
  }

  // NOTE: Do NOT call performScroll() here — it scrolls the page DOWN which is
  // counterproductive when followed immediately by performProfileDM (which scrolls back up).
  return true;
}

async function returnToHashtagResults(hashtag) {
  if (!hashtag) return false;
  const cleanTag = hashtag.replace(/^#/, '').toLowerCase();
  const expectedPath = `/explore/tags/${cleanTag}`;

  if (isInstagramHashtagRoute(cleanTag)) {
    await waitForHashtagGrid(4000).catch(() => false);
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const modal = document.querySelector('[role="dialog"]');
    if (modal) {
      const closeBtn = modal.querySelector('svg[aria-label="Close"]')?.closest('button')
        || modal.querySelector('button[aria-label="Close"]');
      if (closeBtn) {
        await humanClick(closeBtn);
        await sleep(humanDelay(900));
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(humanDelay(900));
      }
    } else {
      window.history.back();
      await sleep(humanDelay(1600));
    }

    if (isInstagramHashtagRoute(cleanTag)) {
      await waitForHashtagGrid(5000).catch(() => false);
      return true;
    }
  }

  return await navigateHashtag(cleanTag);
}

// ─── DM A SPECIFIC USERNAME ────────────────────────────────
// Now delegates to performProfileDM which handles both the Message button
// AND the 3-dots menu fallback for accounts without a visible chat widget.
async function dmUsername(username, customMessage, allowExistingChats = false) {
  if (!username || !customMessage) return false;
  const clean = normalizeUsername(username);
  if (!clean) return false;

  await refreshDMHistoryCache();
  if (isInDMHistory(clean)) {
    console.log(`[Human Behavior Bot] Already messaged @${clean}, skipping`);
    return false;
  }

  // Navigate to their profile if not already there
  const alreadyOnProfile = window.location.pathname.replace(/\/+$/, '').toLowerCase() === `/${clean}`;
  if (!alreadyOnProfile) {
    const navOk = await searchAndNavigateProfile(clean);
    if (!navOk) {
      console.log(`[Human Behavior Bot] Could not navigate to @${clean}'s profile`);
      return false;
    }
    await sleep(humanDelay(1500));
  }

  // Delegate to performProfileDM — it handles Message button, 3-dots menu,
  // /direct/new/ compose screen, personalization, typing and sending.
  return performProfileDM(customMessage, clean, allowExistingChats);
}

// ─── ENGAGE FROM LIKERS/COMMENTERS MODAL ───────────────────
// Picks a user from the currently open modal (likers or commenters) and visits their profile
async function engageFromModal(options = {}) {
  const {
    persistProcessed = true,
  } = options;

  // Refresh persistent caches so we skip already-processed accounts
  await Promise.all([refreshDMHistoryCache(), refreshProcessedAccountsCache()]).catch(() => {});

  // ── DUAL-MODE TARGET (v2.4.130) ──────────────────────────────────────
  // The likers list can render in either of two shapes depending on how
  // we got to it:
  //   • POPUP WIDGET   — role="dialog" overlay (manual click path)
  //   • FULL PAGE      — main element at /p/<id>/liked_by/ URL
  //                      (pushState navigation path)
  // We accept both. The downstream code only needs the container's
  // profile-link children, scroll behaviour is handled separately
  // for each mode.
  let modal = document.querySelector('[role="dialog"]');
  const onLikedByFullPage = !modal && /\/(p|reel)\/[^/]+\/liked_by\/?$/.test(window.location.pathname);
  if (onLikedByFullPage) {
    modal = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    console.log('[Human Behavior Bot] engageFromModal: using full-page /liked_by/ container');
  }
  if (!modal) return false;

  // Scroll to the top of whichever container we're using so candidates[0]
  // is the actual first liker. On full-page mode we scroll the window;
  // on popup-widget mode we scroll the overflow container inside the dialog.
  try {
    if (onLikedByFullPage) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else {
      const scrollables = modal.querySelectorAll('div');
      for (const el of scrollables) {
        const s = window.getComputedStyle(el);
        const oy = s.overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.clientHeight > 80) {
          el.scrollTop = 0;
        }
      }
    }
    await sleep(humanDelay(450));
  } catch {}

  let candidates = getUnvisitedModalCandidates(modal);

  if (candidates.length === 0) {
    console.log('[Human Behavior Bot] No fresh accounts in modal, scrolling deeper...');
    for (let i = 0; i < 2; i++) {
      if (onLikedByFullPage) {
        // Full-page mode: scroll the window down, wait for IG's
        // IntersectionObserver to load more rows, then re-check candidates.
        for (let step = 0; step < randomInt(6, 10); step++) {
          window.scrollBy(0, randomInt(260, 520));
          await sleep(humanDelay(randomInt(400, 800)));
        }
      } else {
        await scrollModalForFreshAccounts(modal, {
          stepsMin: 6,
          stepsMax: 10,
          jumpMin: 260,
          jumpMax: 520,
        });
      }
      candidates = getUnvisitedModalCandidates(modal);
      if (candidates.length > 0) break;
    }
  }

  if (candidates.length === 0) {
    console.log('[Human Behavior Bot] Still no unvisited accounts after deep modal scroll');
    return false;
  }

  // Pick candidates[0] in DOM order — NOT the topmost VISIBLE row. Using the
  // viewport meant that after a few rounds of modal pagination the bot grabbed
  // an arbitrary mid-list account instead of the next one up. That was
  // originally reported as "not DMing likers in order, randomly DMing random
  // liker".
  //
  // v2.4.155: ALWAYS the next account in list order. `candidates` is built by
  // walking the modal's anchors in DOM order and dropping the ones already
  // handled, so candidates[0] is by definition the next unhandled row from the
  // top.
  //
  // The likers flow was fixed to do this earlier; followers/following was left
  // on a "pick one of the top 3 VISIBLE rows at random" path for humanlike
  // variation. That was not top-3 in practice — the viewport filter means that
  // after the modal has been paginated a few times, the rows on screen are an
  // arbitrary slice from the middle of the list, so the bot jumped around and
  // left gaps behind it. Same defect the likers comment above describes as
  // fixed; it just still applied whenever topN > 1.
  //
  // Ordering is not a detection signal in itself — a person scrolling a
  // follower list also goes top to bottom. The humanlike variation lives in
  // timing and in the organic filler actions, not in skipping people.
  const chosen = candidates[0];
  // Pull the chosen row into view BEFORE clicking so the click target is
  // hit-testable. Without this, scrollIntoView further down does the
  // work but the row may have been below the fold for long enough that
  // IG's lazy hydrator hasn't bound its handlers yet.
  try { chosen.link.scrollIntoView({ behavior: 'instant', block: 'start' }); } catch {}

  if (persistProcessed) {
    markVisitedAccount(chosen.username);
  } else {
    markTraversalVisitedAccount(chosen.username);
  }
  console.log(`[Human Behavior Bot] Next in list: @${chosen.username} (${candidates.length} unhandled remaining in this modal)`);

  chosen.link.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(500));
  await humanClick(chosen.link);
  await sleep(humanDelay(2200));
  return { success: true, username: chosen.username };
}

// ─── BROWSE PROFILE HUMANLY ─────────────────────────────────
// Simulates a human browsing a profile: scroll through posts, maybe view a story
async function browseProfileHumanly() {
  const isProfile = document.querySelector('header section') && !window.location.pathname.startsWith('/direct');
  if (!isProfile) return false;

  // Bail early if we're already on a rate-limit / action-blocked modal —
  // browsing further would just hide the signal that the session needs to
  // stop. Caller will see false and the existing verifier will catch it.
  if (typeof detectDMRateLimitModal === 'function' && detectDMRateLimitModal()) {
    console.warn('[Human Behavior Bot] browseProfile: action-blocked modal present — skipping browse');
    return false;
  }

  console.log('[Human Behavior Bot] 👀 Browsing profile naturally...');

  // Step 1: Read the bio area — pause as if reading. Move the cursor over
  // the header so any mouse-tracking heuristic sees natural attention,
  // not an instant click on a button.
  try {
    const header = document.querySelector('header');
    if (header && typeof simulateMousePath === 'function') {
      simulateMousePath(header);
    }
  } catch {}
  await sleep(randomInt(1500, 3500));

  // Step 2: Maybe view their story (40% chance) if the profile pic has a story ring
  if (Math.random() < 0.4) {
    // Story rings are usually canvas elements or highlighted profile pictures in the header
    const header = document.querySelector('header');
    if (header) {
      const storyIndicator = header.querySelector('canvas')
        || header.querySelector('span[role="link"] img')
        || header.querySelector('div[role="button"] img[alt*="profile picture"]');
      
      // Check for the gradient ring around profile pic (indicates active story)
      const profilePicContainer = header.querySelector('span[role="link"]')
        || header.querySelector('div[role="button"]');
      
      const hasStoryRing = storyIndicator || (profilePicContainer && 
        (profilePicContainer.querySelector('canvas') || 
         getComputedStyle(profilePicContainer).backgroundImage?.includes('gradient')));
      
      if (hasStoryRing && profilePicContainer) {
        console.log('[Human Behavior Bot] 📖 Viewing story...');
        const clickTarget = profilePicContainer.closest('div[role="button"]') 
          || profilePicContainer.closest('span[role="link"]') 
          || profilePicContainer;
        await humanClick(clickTarget);
        await sleep(randomInt(2000, 3000));

        // Watch 1-2 story slides (not all)
        const slidesToWatch = randomInt(1, 2);
        for (let s = 0; s < slidesToWatch; s++) {
          // Wait as if watching the story content
          await sleep(randomInt(3000, 6000));
          
          // Tap right side to advance (only if watching more than 1)
          if (s < slidesToWatch - 1) {
            const storyContainer = document.querySelector('section[role="presentation"]') 
              || document.querySelector('[role="dialog"]')
              || document.body;
            const rect = storyContainer.getBoundingClientRect();
            // Click on the right third to advance
            const clickX = rect.left + rect.width * 0.8;
            const clickY = rect.top + rect.height * 0.5;
            document.elementFromPoint(clickX, clickY)?.click();
            await sleep(randomInt(500, 1000));
          }
        }

        // Close the story viewer
        const closeBtn = document.querySelector('svg[aria-label="Close"]')?.closest('button')
          || document.querySelector('button[aria-label="Close"]');
        if (closeBtn) {
          await humanClick(closeBtn);
        } else {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        await sleep(humanDelay(800));
        console.log(`[Human Behavior Bot] 📖 Watched ${slidesToWatch} story slide(s)`);
      }
    }
  }

  // Step 3: Scroll down through the post grid (as if browsing their content).
  // Mix of small + medium scrolls with occasional brief upward correction —
  // real users don't scroll one direction at a constant speed.
  const scrollSteps = randomInt(2, 5);
  for (let i = 0; i < scrollSteps; i++) {
    window.scrollBy({ top: randomInt(200, 480), behavior: 'smooth' });
    await sleep(randomInt(1100, 2800));
    // ~15% chance per step to pause-and-glance back (small upward scroll)
    if (Math.random() < 0.15) {
      window.scrollBy({ top: -randomInt(80, 180), behavior: 'smooth' });
      await sleep(randomInt(600, 1200));
    }
  }

  // Step 4: Hover over 1-3 post thumbnails as a real user would when
  // skimming the grid — no clicks, just attention-pattern noise.
  const hoverCount = randomInt(1, 3);
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  const visible = Array.from(postLinks).filter((a) => {
    const rect = a.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight && rect.width > 20;
  });
  for (let h = 0; h < hoverCount && visible.length > 0; h++) {
    const pick = visible[randomInt(0, visible.length - 1)];
    try {
      if (typeof simulateMousePath === 'function') simulateMousePath(pick);
      pick.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      pick.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    } catch {}
    await sleep(randomInt(700, 1700));
    try { pick.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })); } catch {}
  }

  // Step 5: Scroll back up so DM/follow buttons are accessible.
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(humanDelay(600 + randomInt(0, 600)));

  // Step 6: Final defensive check — if a rate-limit modal appeared during
  // the browse (e.g. follow/like elsewhere triggered it), bail out so the
  // caller doesn't immediately fire a DM into the block.
  if (typeof detectDMRateLimitModal === 'function' && detectDMRateLimitModal()) {
    console.warn('[Human Behavior Bot] browseProfile: rate-limit modal appeared during browse');
    return false;
  }

  console.log('[Human Behavior Bot] 👀 Done browsing profile');
  return true;
}

// ─── PROFILE ENGAGEMENT ACTIONS ────────────────────────────

// Like a post on the currently viewed profile page
async function performProfileLike() {
  // Make sure we're on a profile page
  const isProfile = document.querySelector('header section') && !window.location.pathname.startsWith('/direct');
  if (!isProfile) return await performLike(); // fallback to feed like

  // Click on a post in the grid to open it
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  const visible = Array.from(postLinks).filter(a => {
    const rect = a.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight;
  });

  if (visible.length === 0) return false;

  const target = visible[randomInt(0, Math.min(visible.length - 1, 5))];
  await humanClick(target);
  await sleep(humanDelay(2000));

  // Now like the post in the modal/page
  const likeBtn = document.querySelector('svg[aria-label="Like"]');
  if (likeBtn) {
    const clickable = likeBtn.closest('button') || likeBtn.parentElement;
    await humanClick(clickable);
    await sleep(humanDelay(800));
  }

  // Always close any open modal/dialog to get back to the profile page
  const openModal = document.querySelector('[role="dialog"]');
  if (openModal) {
    const closeBtn = openModal.querySelector('svg[aria-label="Close"]')?.closest('button')
      || openModal.querySelector('button[aria-label="Close"]');
    if (closeBtn) {
      await humanClick(closeBtn);
      await sleep(humanDelay(800));
    } else {
      // Press Escape as fallback
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(humanDelay(800));
    }
  }

  // Verify we're back on the profile page
  const stillHasModal = document.querySelector('[role="dialog"]');
  if (stillHasModal) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(humanDelay(500));
  }

  return !!likeBtn;
}

// Like multiple posts (1-3) on the currently viewed profile page
async function performProfileMultiLike() {
  const isProfile = document.querySelector('header section') && !window.location.pathname.startsWith('/direct');
  if (!isProfile) {
    const single = await performLike();
    return single ? 1 : 0;
  }

  // Scroll down slightly to ensure post grid is visible
  window.scrollBy({ top: 300, behavior: 'smooth' });
  await sleep(humanDelay(800));

  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  const visible = Array.from(postLinks).filter(a => {
    const rect = a.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight;
  });

  if (visible.length === 0) {
    console.log('[Human Behavior Bot] No visible posts on profile to like');
    return 0;
  }

  const numToLike = Math.min(visible.length, randomInt(1, 3));
  let liked = 0;

  // Shuffle and pick posts to like
  const shuffled = visible.sort(() => Math.random() - 0.5).slice(0, numToLike);

  for (const post of shuffled) {
    try {
      await humanClick(post);
      await sleep(humanDelay(2000));

      // Like the post in the modal
      const likeBtn = document.querySelector('svg[aria-label="Like"]');
      if (likeBtn) {
        const clickable = likeBtn.closest('button') || likeBtn.parentElement;
        await humanClick(clickable);
        liked++;
        console.log(`[Human Behavior Bot] ❤️ Liked post ${liked}/${numToLike}`);
        await sleep(humanDelay(1000));
      }

      // Close the modal to get back to profile
      const modal = document.querySelector('[role="dialog"]');
      if (modal) {
        const closeBtn = modal.querySelector('svg[aria-label="Close"]')?.closest('button')
          || modal.querySelector('button[aria-label="Close"]');
        if (closeBtn) {
          await humanClick(closeBtn);
        } else {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        await sleep(humanDelay(800));
      }

      // Double-check modal is closed
      const stillModal = document.querySelector('[role="dialog"]');
      if (stillModal) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(humanDelay(500));
      }
    } catch (e) {
      console.log('[Human Behavior Bot] Error liking post:', e);
    }

    // Pause between likes
    await sleep(humanDelay(800));
  }

  // Scroll back up to header for follow/DM actions
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(humanDelay(600));

  console.log(`[Human Behavior Bot] Multi-like complete: ${liked}/${numToLike} posts liked`);
  return liked;
}

// Follow the user whose profile we're currently viewing
async function performProfileFollow() {
  const followBtn = Array.from(document.querySelectorAll('button')).find(btn => {
    const text = btn.textContent?.trim();
    return text === 'Follow' && !btn.disabled;
  });

  if (!followBtn) return false;

  followBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(500));
  return await humanClick(followBtn);
}

// DM the user whose profile we're currently viewing
// Flow: scroll to top → close modals → click Message icon (or 3-dots if missing) →
//        wait for composer → check history → type script → send → move on
async function performProfileDM(customMessage, targetUsernameHint = null, allowExistingChats = false) {
  if (!normalizeOutgoingMessage(customMessage)) {
    console.log('[Human Behavior Bot] ERROR: DM script is empty or not loaded (performProfileDM)');
    return false;
  }

  const normalizedHint = normalizeUsername(targetUsernameHint);

  // ── Step 0: Make sure we're on the profile page ──────────────────────────────
  let pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
  let pageUsername = pathMatch ? pathMatch[1].toLowerCase() : null;

  if (!pageUsername && normalizedHint) {
    // After post-liking the page can be on /p/XXX/ — navigate back to profile.
    // IMPORTANT: Use SPA-style navigation (fake link click) instead of window.location.href
    // which would cause a full page reload and kill this content script instance.
    console.log(`[Human Behavior Bot] Not on profile (${window.location.pathname}), SPA-navigating to @${normalizedHint}...`);
    const targetUrl = `https://www.instagram.com/${normalizedHint}/`;
    let spaNavSucceeded = false;
    try {
      const tempLink = document.createElement('a');
      tempLink.href = targetUrl;
      tempLink.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
      // Wait up to 8 seconds for SPA nav to land on the profile
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        const pMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
        if (pMatch && !RESERVED_PROFILE_SEGMENTS.has(pMatch[1].toLowerCase())) {
          pageUsername = pMatch[1].toLowerCase();
          spaNavSucceeded = true;
          console.log(`[Human Behavior Bot] SPA nav succeeded — on @${pageUsername}`);
          break;
        }
      }
    } catch (e) {
      console.log('[Human Behavior Bot] SPA nav error:', e.message);
    }
    // Last resort: try history.back() if we just came from this profile (e.g. post modal)
    if (!spaNavSucceeded) {
      console.log('[Human Behavior Bot] SPA nav failed, trying history.back()...');
      window.history.back();
      await sleep(2500);
      const pMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
      if (pMatch && !RESERVED_PROFILE_SEGMENTS.has(pMatch[1].toLowerCase())) {
        pageUsername = pMatch[1].toLowerCase();
        console.log(`[Human Behavior Bot] history.back() succeeded — on @${pageUsername}`);
      }
    }
  }

  const username = pageUsername || normalizedHint;
  console.log(`[Human Behavior Bot] performProfileDM for @${username || 'unknown'}`);

  if (username) markVisitedAccount(username);

  await refreshDMHistoryCache();
  if (username && isInDMHistory(username)) {
    console.log(`[Human Behavior Bot] Already DM'd @${username} — skipping`);
    return false;
  }

  // ── Step 1: Scroll to top + close non-DM modals ─────────────────────────────
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(humanDelay(1200));

  for (let i = 0; i < 3; i++) {
    const modal = document.querySelector('[role="dialog"]');
    if (!modal) break;
    // IMPORTANT: Never close a DM-composer dialog — that is the minichat we want to use.
    // Only close modals that are NOT DM composers (e.g. post-detail dialogs, story viewers).
    if (modal.querySelector('div[contenteditable="true"], textarea')) {
      console.log('[Human Behavior Bot] Leaving DM composer dialog open — it IS the DM interface');
      break;
    }
    const closeBtn = modal.querySelector('svg[aria-label="Close"]')?.closest('button')
      || modal.querySelector('button[aria-label="Close"]');
    if (closeBtn) {
      await humanClick(closeBtn);
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await sleep(humanDelay(700));
  }

  // ── Step 2: Wait for profile header to render ────────────────────────────────
  for (let w = 0; w < 12; w++) {
    if (document.querySelector('header section') || document.querySelector('header')) break;
    await sleep(800);
  }

  // ── Step 3: Find buttons (Message icon first, then 3-dots near username) ─────
  // Returns the "Message" / "Send message" button in the profile header.
  // Instagram uses both <button> and div[role="button"] for action buttons.
  // We check textContent, aria-label, and inner SVG aria-label on all of them.
  const findMessageButton = () => {
    // isMessageLabel: partial matching so hidden accessibility text ("Message rogue_dynamics"),
    // extra whitespace, or minor label variants don't break detection.
    // Exclude buttons labelled purely as "messages" (inbox nav link) or "direct" links.
    const isMessageLabel = (t) => {
      if (!t) return false;
      const s = t.toLowerCase().trim();
      // Must contain "message" and be short (< 60 chars) — rules out inbox/nav links
      if (!s.includes('message')) return false;
      if (s.length > 60) return false;
      // Exclude purely navigational labels
      if (s === 'messages' || s === 'direct messages' || s === 'open messages') return false;
      return true;
    };

    // getClickables: include <a> tags too — Instagram sometimes renders profile
    // action buttons as anchor elements
    const getClickables = (scope) => [
      ...scope.querySelectorAll('button'),
      ...scope.querySelectorAll('[role="button"]'),
      ...scope.querySelectorAll('a[role="link"]'),
    ];

    // Prefer searching inside main content area (excludes nav sidebar which has an
    // inbox "Messages" link that would otherwise be matched first)
    const main = document.querySelector('main') || document.querySelector('[role="main"]');
    const header = document.querySelector('header section') || document.querySelector('header');
    const searchScope = main || header || document;

    for (const btn of getClickables(searchScope)) {
      // Skip nav elements — the left sidebar has a "Messages" nav link
      if (btn.closest('nav') || btn.closest('[role="navigation"]')) continue;
      const text  = (btn.textContent?.trim() || '').toLowerCase();
      const aria  = (btn.getAttribute('aria-label') || '').toLowerCase();
      const svgAr = (btn.querySelector('svg')?.getAttribute('aria-label') || '').toLowerCase();
      if (isMessageLabel(text) || isMessageLabel(aria) || isMessageLabel(svgAr)) return btn;
    }
    // Full document fallback (catches any remaining edge cases)
    for (const btn of getClickables(document)) {
      if (btn.closest('nav') || btn.closest('[role="navigation"]')) continue;
      const text  = (btn.textContent?.trim() || '').toLowerCase();
      const aria  = (btn.getAttribute('aria-label') || '').toLowerCase();
      const svgAr = (btn.querySelector('svg')?.getAttribute('aria-label') || '').toLowerCase();
      if (isMessageLabel(text) || isMessageLabel(aria) || isMessageLabel(svgAr)) return btn;
    }
    return null;
  };

  const getOptionsClickables = (scope) => [
    ...scope.querySelectorAll('button'),
    ...scope.querySelectorAll('[role="button"]'),
  ];

  const getProfileUsernameAnchor = () => {
    const header = document.querySelector('header section') || document.querySelector('header');
    if (!header) return null;

    const exactNames = new Set([pageUsername, normalizedHint, username].filter(Boolean).map((value) => value.toLowerCase()));
    const ignoreTexts = new Set(['follow', 'following', 'requested', 'message', 'share profile', 'threads']);

    const candidates = Array.from(header.querySelectorAll('h1, h2, span')).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      if (!text || text.length > 40 || ignoreTexts.has(text)) return false;
      if (text.startsWith('@')) return false;
      if (exactNames.has(text)) return true;
      return /^[a-z0-9._]{3,30}$/.test(text) && !RESERVED_PROFILE_SEGMENTS.has(text);
    });

    candidates.sort((a, b) => {
      const aText = (a.textContent || '').trim().toLowerCase();
      const bText = (b.textContent || '').trim().toLowerCase();
      const aExact = exactNames.has(aText) ? 1 : 0;
      const bExact = exactNames.has(bText) ? 1 : 0;
      if (bExact !== aExact) return bExact - aExact;
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    });

    return candidates[0] || null;
  };

  // Returns the 3-dots / Options button that lives near the username in the header.
  // ⚠️  SAFETY-CRITICAL: Instagram's left sidebar has a "More" button that opens
  //     Settings / Log Out. We search ONLY in the profile header/main area to avoid matching it.
  const findOptionsButton = () => {
    const header = document.querySelector('header section') || document.querySelector('header');
    const main = document.querySelector('main') || document.querySelector('[role="main"]');
    const searchScopes = [header, main, document].filter(Boolean);
    const usernameAnchor = getProfileUsernameAnchor();
    const anchorRect = usernameAnchor?.getBoundingClientRect() || null;
    const seen = new Set();

    const knownPrefixes = ['follow', 'following', 'requested', 'unfollow', 'edit profile',
                           'share profile', 'message', 'send message', 'send a message'];
    const isKnownAction = (value) => {
      const text = (value || '').toLowerCase().trim();
      if (!text) return false;
      return knownPrefixes.some((prefix) => text === prefix || text.startsWith(prefix + ' ') || text.startsWith(prefix + '\n'));
    };

    console.log('[Human Behavior Bot] Searching for 3-dots options button...');

    const scoredCandidates = [];
    for (const scope of searchScopes) {
      for (const btn of getOptionsClickables(scope)) {
        if (!(btn instanceof HTMLElement) || seen.has(btn)) continue;
        seen.add(btn);
        if (!isElementVisibleAndEnabled(btn)) continue;
        if (btn.closest('nav') || btn.closest('[role="navigation"]') || btn.closest('article')) continue;

        const text = (btn.textContent?.trim() || '').toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const svgAria = (btn.querySelector('svg')?.getAttribute('aria-label') || '').toLowerCase();
        if (isKnownAction(text) || isKnownAction(aria)) continue;

        const rect = btn.getBoundingClientRect();
        const hasIcon = !!btn.querySelector('svg');
        const hasMenuLabel = [text, aria, svgAria].some((value) => value && (value.includes('option') || value.includes('more') || value.includes('menu') || value.includes('action')));
        const isEllipsis = text === '...' || text === '⋯' || text === '⋮' || text === '…';
        const isSmallButton = rect.width <= 84 && rect.height <= 84;
        const iconLike = hasIcon || isEllipsis || (!text && isSmallButton);

        if (!hasMenuLabel && !iconLike) continue;

        let score = 0;
        if (hasMenuLabel) score += 120;
        if (isEllipsis) score += 90;
        if (hasIcon) score += 25;
        if (!text) score += 20;
        if (isSmallButton) score += 15;

        if (anchorRect) {
          const verticalDelta = Math.abs((rect.top + rect.height / 2) - (anchorRect.top + anchorRect.height / 2));
          const horizontalDelta = rect.left - anchorRect.right;
          if (verticalDelta <= 70) score += 35;
          if (horizontalDelta >= -24) score += 35;
          if (horizontalDelta >= -24 && horizontalDelta <= 260) score += 45;
          score -= Math.max(0, verticalDelta - 20) / 4;
          score -= Math.max(0, Math.abs(horizontalDelta - 40)) / 8;
        }

        scoredCandidates.push({ btn, score, text, aria, svgAria });
      }
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    if (scoredCandidates[0] && scoredCandidates[0].score > 40) {
      console.log(`[Human Behavior Bot] ✅ Found options button via scored candidate (score=${Math.round(scoredCandidates[0].score)} text="${scoredCandidates[0].text || '(empty)'}" aria="${scoredCandidates[0].aria || scoredCandidates[0].svgAria || '(none)'}")`);
      return scoredCandidates[0].btn;
    }

    const exactLabels = ['Options', 'More options', 'More Options', 'More actions', 'options', 'Menu'];
    for (const scope of searchScopes) {
      for (const label of exactLabels) {
        const found = scope.querySelector(`[aria-label="${label}"]`) || scope.querySelector(`svg[aria-label="${label}"]`)?.parentElement;
        const btn = found?.closest('button') || found?.closest('[role="button"]') || found;
        if (btn && !btn.closest('article') && !btn.closest('nav')) {
          console.log(`[Human Behavior Bot] ✅ Found options button via aria-label="${label}"`);
          return btn;
        }
      }
    }

    const headerButtons = header ? getOptionsClickables(header) : [];
    console.log(`[Human Behavior Bot] ❌ Options button NOT found. Searched ${headerButtons.length} header buttons.`);
    for (const btn of headerButtons.slice(0, 12)) {
      const t = btn.textContent?.trim() || '(empty)';
      const a = btn.getAttribute('aria-label') || '(no aria-label)';
      const hasSvg = btn.querySelector('svg') ? 'has SVG' : 'no SVG';
      console.log(`  - ${hasSvg}: text="${t}", aria="${a}"`);
    }

    return null;
  };

  // Capture the profile display name NOW, while we still have the profile DOM.
  // After we click Message we may end up on /direct/inbox/ or /direct/t/ where
  // the profile header is gone, and the only place left for the real display
  // name is the DM thread header (which sometimes only shows the @handle).
  // Caching preserves "real human name → script personalization" across the nav.
  //
  // Wait for Instagram's React hydration before extracting. The user reported
  // {name} falling back to "Sbr" (derived from @sbr_health_and_wellness) when
  // the actual display name visible on the profile is "Sarah" — that happens
  // when extractProfileDisplayName runs before <h1>/<h2> have populated. We
  // retry every 400 ms for up to ~2.5 s so a slow-hydrating profile still
  // yields the real display name.
  if (username) {
    // EXTENDED RETRY WINDOW (v2.4.125): 12 retries × 500ms = 6s of wait.
    // User reported "Journalwithace" being used as the personalised name
    // because all 6 of the previous-window extraction attempts returned
    // null — either document.title hadn't updated yet (post-navigation
    // race) or the slow-hydrating <h1>/<h2>/<span> with the display name
    // hadn't mounted. 6s is long for a tight loop, but it's bounded and
    // only runs once per profile.
    let earlyDisplayName = extractProfileDisplayName(username);
    let attempts = 0;
    while (!earlyDisplayName && attempts < 12) {
      await sleep(500);
      earlyDisplayName = extractProfileDisplayName(username);
      attempts++;
    }
    if (earlyDisplayName) {
      rememberProfileDisplayName(username, earlyDisplayName);
      console.log(`[Human Behavior Bot] Cached profile display name for @${username}: "${earlyDisplayName}"${attempts > 0 ? ` (after ${attempts} retry/retries)` : ''}`);
    } else {
      console.log(`[Human Behavior Bot] No profile display name found for @${username} on profile page (after ${attempts} retries)`);
    }
  }

  let messageBtn = findMessageButton();
  let optionsBtn = messageBtn ? null : findOptionsButton();

  console.log('[Human Behavior Bot] Initial button search: Message=' + (!!messageBtn) + ', Options=' + (!!optionsBtn));

  // Strategy: Try Message button first (fast path), but don't wait forever for it.
  // If not found quickly, pivot to 3-dots menu (slower but more reliable for restricted accounts).
  if (!messageBtn && !optionsBtn) {
    console.log('[Human Behavior Bot] Neither Message button nor 3-dots found — waiting for buttons to render...');

    // First, try harder for the Message button (accounts without restrictions usually have it)
    for (let w = 0; w < 4; w++) {
      if (!messageBtn) messageBtn = findMessageButton();
      if (messageBtn) {
        console.log('[Human Behavior Bot] ✅ Message button found after ' + (w + 1) + 's');
        break;
      }
      await sleep(1000);
    }

    // If no Message button found, quickly find the 3-dots menu (for restricted accounts)
    if (!messageBtn) {
      console.log('[Human Behavior Bot] No Message button found — switching to 3-dots approach...');
      for (let w = 0; w < 8; w++) {
        optionsBtn = findOptionsButton();
        if (optionsBtn) {
          console.log('[Human Behavior Bot] ✅ Options button found after ' + (w + 1) + 's');
          break;
        }
        await sleep(1000);
      }
    }
  }

  if (!messageBtn && !optionsBtn) {
    console.log('[Human Behavior Bot] ⚠️ No Message button or 3-dots menu found after max wait — account may be fully restricted');
    return false;
  }

  // Diagnostic: confirm which button will be used
  if (messageBtn) {
    console.log('[Human Behavior Bot] ✅ Using Message button (direct DM)');
  } else if (optionsBtn) {
    console.log('[Human Behavior Bot] ✅ Using 3-dots Options menu (restricted account)');
  }

  // ── Step 4: Open the DM thread ───────────────────────────────────────────────
  let openedDMThread = false;

  // Helper: wait for /direct/ navigation, a minichat dialog, OR the floating chat
  // widget that Instagram opens at the bottom-right.
  //
  // v2.4.148: MutationObserver + popstate-aware detection so the DM is
  // recognised within ~100ms of appearing instead of always waiting until
  // the next 1-second poll tick. This fixed the user-reported issue where
  // the Message-button-click DID open the DM but waitForDMOpen timed out
  // because the composer rendered between polls.
  const waitForDMOpen = async (maxWaitSecs = 15) => {
    const checkOnce = (sourceTag) => {
      // 1. Full-page navigation to DM thread
      if (window.location.pathname.includes('/direct/')) {
        console.log(`[Human Behavior Bot] ✅ DM opened: navigated to ${window.location.pathname} (${sourceTag})`);
        return true;
      }
      // 2. Classic minichat overlay
      if (document.querySelector('[role="dialog"] div[contenteditable="true"]')) {
        console.log(`[Human Behavior Bot] ✅ DM opened: minichat dialog detected (${sourceTag})`);
        return true;
      }
      // 3. Floating chat widget — Instagram's newer bottom-right messenger panel.
      const anyBlockingOverlay = document.querySelector('[role="dialog"]:not([aria-label*="Direct"])')
                               || document.querySelector('[role="menu"]');
      if (!anyBlockingOverlay) {
        const composer = getDMComposer();
        if (composer) {
          console.log(`[Human Behavior Bot] ✅ DM opened: floating chat widget detected (${sourceTag})`);
          return true;
        }
      }
      return false;
    };

    // Fast initial check — sometimes IG navigates instantly.
    if (checkOnce('initial')) {
      await sleep(300); // brief settle for composer hydration
      return true;
    }

    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let pollTimer = null;
      let timeoutTimer = null;
      let lastLoggedSec = -1;
      const startedAt = Date.now();

      const cleanup = () => {
        if (observer) { try { observer.disconnect(); } catch {} observer = null; }
        if (pollTimer) { try { clearInterval(pollTimer); } catch {} pollTimer = null; }
        if (timeoutTimer) { try { clearTimeout(timeoutTimer); } catch {} timeoutTimer = null; }
        try { window.removeEventListener('popstate', onPopState); } catch {}
      };

      const finish = async (success, source) => {
        if (done) return;
        done = true;
        cleanup();
        if (success) {
          // brief settle so the composer has time to attach Lexical handlers
          await sleep(300);
          resolve(true);
        } else {
          console.log(`[Human Behavior Bot] ⚠️ Timeout waiting for DM to open after ${maxWaitSecs}s (${source})`);
          resolve(false);
        }
      };

      const tryCheck = (sourceTag) => {
        if (done) return;
        if (checkOnce(sourceTag)) {
          finish(true, sourceTag);
        }
      };

      const onPopState = () => tryCheck('popstate');

      // MutationObserver: react instantly to DOM changes (dialog appearance,
      // composer hydration, the floating-widget panel mounting).
      try {
        observer = new MutationObserver(() => tryCheck('mutation'));
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['role', 'aria-label', 'contenteditable'],
        });
      } catch (e) {
        console.warn('[Human Behavior Bot] MutationObserver setup failed, falling back to polling only:', e?.message || e);
      }

      // Popstate fires on IG's pushState SPA navigations (browser back/forward
      // and most programmatic navigations dispatch this).
      try { window.addEventListener('popstate', onPopState, { passive: true }); } catch {}

      // Faster polling backup: 250ms ticks so even if the observer + popstate
      // miss something, we converge to ~250ms detection latency.
      pollTimer = setInterval(() => {
        if (done) return;
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsedSec !== lastLoggedSec && elapsedSec % 3 === 0 && elapsedSec > 0) {
          lastLoggedSec = elapsedSec;
          console.log(`[Human Behavior Bot] Waiting for DM to open (${elapsedSec}s/${maxWaitSecs}s elapsed)...`);
        }
        tryCheck('poll');
      }, 250);

      timeoutTimer = setTimeout(() => finish(false, 'timeout'), maxWaitSecs * 1000);
    });
  };

  if (messageBtn) {
    // ── PATH A: Message icon ─────────────────────────────────────────────────
    // v2.4.147: increased reliability so we don't fall back to the 3-dots
    // menu unnecessarily (which surfaces Block/Restrict/Report items and
    // looks unnatural). Strategy:
    //   • initial humanClick + raw .click() for redundancy (synthetic
    //     events are isTrusted:false; some IG layouts ignore one or the
    //     other depending on which is the "button" host)
    //   • wait up to 8s for DM to open
    //   • if not open, re-click and wait another 12s
    //   • only THEN fall back to 3-dots
    console.log('[Human Behavior Bot] Clicking Message icon...');
    messageBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(500));
    // v2.4.153: click ONCE. humanClick() already ends in a native
    // element.click(), so the bare .click() that used to follow it fired the
    // button a second time — the same double-activation the send-button fix
    // removed. On a Message button the second hit lands on a node React has
    // just replaced, and can re-toggle the freshly-opened widget shut. The
    // fallback below only runs if humanClick itself threw.
    try {
      await humanClick(messageBtn);
    } catch (e) {
      console.log('[Human Behavior Bot] humanClick failed on Message button:', e?.message, '— direct click');
      try { messageBtn.click(); } catch {}
    }
    openedDMThread = await waitForDMOpen(8);

    if (!openedDMThread) {
      // Recheck the composer in case the floating widget opened without
      // matching the dialog/url heuristics above.
      const lateComposer1 = getDMComposer();
      if (lateComposer1) {
        console.log('[Human Behavior Bot] ✅ Floating widget found after first wait — treating as open');
        openedDMThread = true;
      } else {
        // Second try: re-find the message button (DOM may have shifted)
        // and click again, then wait longer before giving up.
        console.log('[Human Behavior Bot] DM did not open after first click — re-clicking Message icon before falling back to 3-dots...');
        let refreshedBtn = null;
        try { refreshedBtn = findMessageButton ? findMessageButton() : messageBtn; } catch { refreshedBtn = messageBtn; }
        const reBtn = refreshedBtn || messageBtn;
        try { reBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
        await sleep(humanDelay(400));
        // v2.4.153: single click — see the note on the first attempt above.
        try {
          await humanClick(reBtn);
        } catch (e) {
          console.log('[Human Behavior Bot] humanClick failed on Message retry:', e?.message, '— direct click');
          try { reBtn.click(); } catch {}
        }
        openedDMThread = await waitForDMOpen(12);
      }
    }

    if (!openedDMThread) {
      // Final safety check: the floating widget may have opened but
      // anyBlockingOverlay in waitForDMOpen blocked its detection every
      // second. Check directly now.
      const lateComposer2 = getDMComposer();
      if (lateComposer2) {
        console.log('[Human Behavior Bot] ✅ Floating chat widget found after extended wait — treating as open (skipping 3-dots)');
        openedDMThread = true;
      } else {
        console.log('[Human Behavior Bot] Message icon click did not open DM after retry — trying 3-dots...');
        optionsBtn = findOptionsButton(); // re-find in case DOM shifted
      }
    }
  }

  if (!openedDMThread && optionsBtn) {
    // ── PATH B: 3-dots near username (RESTRICTED ACCOUNTS) ──────────────────────
    console.log('[Human Behavior Bot] Found 3-dots button — attempting to open menu...');

    // Make sure button is in view
    optionsBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(300));

    // Try clicking the button
    console.log('[Human Behavior Bot] Clicking 3-dots options button...');
    try {
      await humanClick(optionsBtn);
    } catch (e) {
      console.log('[Human Behavior Bot] ⚠️ humanClick failed:', e.message, '— trying direct click');
      optionsBtn.click();
    }

    await sleep(humanDelay(1500));

    // ── SAFETY CHECK: verify this is a profile options menu, NOT the sidebar menu ──
    // The sidebar "More" menu contains "Settings", "Log out" (DANGER_SIGNALS).
    // Profile menus contain "Send message", "Report", "Block", etc. (PROFILE_MENU_SIGNALS).
    // For restricted accounts, the menu may have fewer options, so we check:
    //   1. If it contains DANGER_SIGNALS → definitely wrong menu
    //   2. If it contains PROFILE_MENU_SIGNALS → definitely right menu
    //   3. If unsure → proceed (assume it's correct, might be minimal menu for restricted account)
    const PROFILE_MENU_SIGNALS = ['send message', 'message', 'send a message',
                                  'report', 'block', 'restrict', 'unfollow', 'about this account'];
    const DANGER_SIGNALS = ['log out', 'switch accounts', 'your activity', 'qr code'];

    let sendMsgEl = null;

    // Keep trying to find and click "Send message" — menus sometimes take time to fully render
    for (let menuAttempt = 0; menuAttempt < 6 && !sendMsgEl; menuAttempt++) {
      // Gather clickable elements from ALL possible menu containers — Instagram uses
      // various wrappers: [role="dialog"], [role="menu"], [role="listbox"],
      // [data-focus-lock-disabled], or plain fixed/absolute-positioned divs.
      const menuContainers = [
        ...document.querySelectorAll('[role="dialog"]'),
        ...document.querySelectorAll('[role="menu"]'),
        ...document.querySelectorAll('[role="listbox"]'),
        ...document.querySelectorAll('[data-focus-lock-disabled]'),
      ];

      let openedMenuEls = [];
      const seenEls = new Set();
      for (const container of menuContainers) {
        for (const el of container.querySelectorAll('button, div[role="button"], a, [role="menuitem"]')) {
          if (!seenEls.has(el)) { seenEls.add(el); openedMenuEls.push(el); }
        }
      }

      // Fallback: if no container found, look for any fixed/absolute overlay that appeared
      if (openedMenuEls.length === 0) {
        const allOverlays = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"], div[style*="position: absolute"], div[style*="position:absolute"]');
        for (const overlay of allOverlays) {
          if (overlay.offsetHeight > 50 && overlay.offsetHeight < 600) {
            for (const el of overlay.querySelectorAll('button, div[role="button"], a, span, [role="menuitem"]')) {
              if (!seenEls.has(el)) { seenEls.add(el); openedMenuEls.push(el); }
            }
          }
        }
      }

      const openedMenuTexts = openedMenuEls.map(el => (el.textContent?.trim() || '').toLowerCase());

      if (openedMenuEls.length === 0) {
        if (menuAttempt === 0) {
          console.log('[Human Behavior Bot] Menu not visible yet — retrying click and waiting...');
          optionsBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(300);
          try {
            await humanClick(optionsBtn);
          } catch {
            optionsBtn.click();
          }
        } else if (menuAttempt === 2) {
          // Try dispatching pointer events as a last resort to trigger the menu
          console.log('[Human Behavior Bot] Trying pointer events to open menu...');
          optionsBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          await sleep(50);
          optionsBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          optionsBtn.click();
        } else {
          console.log(`[Human Behavior Bot] Still waiting for menu to open (attempt ${menuAttempt + 1}/6)...`);
        }
        await sleep(humanDelay(800 + menuAttempt * 300));
        continue;
      }

      console.log(`[Human Behavior Bot] ✅ Menu opened with ${openedMenuEls.length} items: ${openedMenuTexts.slice(0, 8).join(', ')}`);

      const isDangerMenu  = openedMenuTexts.some(t => DANGER_SIGNALS.some(s => t.includes(s)));
      const isProfileMenu = openedMenuTexts.some(t => PROFILE_MENU_SIGNALS.some(s => t === s || t.startsWith(s)));

      if (isDangerMenu) {
        console.log('[Human Behavior Bot] ⚠️ WRONG MENU: Detected sidebar menu (contains "log out") — closing');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(humanDelay(600));
        return false;
      }

      if (isProfileMenu) {
        console.log('[Human Behavior Bot] ✅ CORRECT: Profile options menu confirmed');
      } else if (openedMenuEls.length > 0) {
        console.log('[Human Behavior Bot] ⚠️ Menu opened but profile signals not detected (might be restricted account minimal menu)');
      }

      // Find "Send message" inside the dropdown — match broadly
      const sendMessagePatterns = ['send message', 'message', 'send a message', 'enviar mensaje', 'mesaj gönder', 'nachricht senden'];
      for (const el of openedMenuEls) {
        const t = (el.textContent?.trim() || '').toLowerCase();
        if (sendMessagePatterns.some(p => t === p)) {
          sendMsgEl = el;
          console.log('[Human Behavior Bot] ✅ "Send message" option found: "' + el.textContent?.trim() + '"');
          break;
        }
      }

      // Broader partial match fallback
      if (!sendMsgEl) {
        for (const el of openedMenuEls) {
          const t = (el.textContent?.trim() || '').toLowerCase();
          if ((t.includes('send') && t.includes('message')) || (t.includes('message') && t.length < 25 && !t.includes('report'))) {
            sendMsgEl = el;
            console.log('[Human Behavior Bot] ✅ "Send message" option found (partial match): "' + el.textContent?.trim() + '"');
            break;
          }
        }
      }

      if (!sendMsgEl && openedMenuEls.length > 0) {
        console.log('[Human Behavior Bot] "Send message" not in menu yet (attempt ' + (menuAttempt + 1) + '/6) — waiting...');
        await sleep(1200);
      }
    }

    if (!sendMsgEl) {
      console.log('[Human Behavior Bot] ⚠️ "Send message" option never found in 3-dots menu — giving up');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(humanDelay(400));
      return false;
    }

    console.log('[Human Behavior Bot] Clicking "Send message" to open DM...');
    try {
      sendMsgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(humanDelay(300));
      await humanClick(sendMsgEl);
    } catch (e) {
      console.log('[Human Behavior Bot] humanClick failed on "Send message":', e.message, '— trying direct click');
      sendMsgEl.click();
    }

    // Wait longer for the DM to open after clicking "Send message" from menu
    console.log('[Human Behavior Bot] Waiting for DM interface to open after "Send message"...');
    openedDMThread = await waitForDMOpen(20);
  }

  if (!openedDMThread) {
    console.log('[Human Behavior Bot] ⚠️ Could not open DM thread or interface — skipping account');
    return false;
  }

  // ── Post-open recovery: full-page /direct/new/ or /direct/inbox/ redirect ────
  // Instagram sometimes redirects the Message-button click (Path A) OR the
  // "Send message" 3-dots option (Path B) to the full-page direct UI instead
  // of opening the floating chat widget. In split-view, a thread MUST be
  // opened in the right pane before the composer can be addressed — otherwise
  // waitForDMComposer below times out and the DM silently fails.
  // This block runs for BOTH paths (Path A used to skip it, which broke the
  // full-page-inbox case for the Message button).
  if (window.location.pathname.includes('/direct/new') || window.location.pathname.includes('/direct/inbox')) {
    const targetName = (username || normalizedHint || '').toLowerCase();
    const normalizedTarget = normalizeUsername(targetName);
    console.log('[Human Behavior Bot] Landed on ' + window.location.pathname + ' — attempting to open thread for @' + (targetName || 'unknown'));

    // Wait briefly for any auto-navigation to /direct/t/ that Instagram may do on its own
    await sleep(humanDelay(2000));

    if (isOnInstagramDirectThread()) {
      console.log('[Human Behavior Bot] ✅ Auto-navigated to thread');
    } else if (window.location.pathname.includes('/direct/new')) {
      // On "New Message" compose screen — confirm recipient via Next/Chat or search-and-pick
      console.log('[Human Behavior Bot] On /direct/new/ compose screen — looking for pre-selected recipient...');

      const nextButtons = [...document.querySelectorAll('button, div[role="button"]')].filter(btn => {
        const t = (btn.textContent?.trim() || '').toLowerCase();
        return t === 'next' || t === 'chat' || t === 'siguiente' || t === 'weiter';
      });
      if (nextButtons.length > 0) {
        console.log('[Human Behavior Bot] Found "Next/Chat" button — clicking to proceed...');
        await humanClick(nextButtons[0]);
        await sleep(humanDelay(2000));
      }

      const searchInput = document.querySelector('input[placeholder*="Search"], input[placeholder*="search"], input[name="queryBox"]');
      if (searchInput && targetName && !isOnInstagramDirectThread()) {
        console.log('[Human Behavior Bot] Typing username "' + targetName + '" in search field...');
        searchInput.focus();
        await sleep(300);
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
        for (const char of targetName) {
          searchInput.value += char;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(randomInt(50, 120));
        }
        await sleep(humanDelay(1500));

        const results = [...document.querySelectorAll('button, div[role="button"], div[role="option"]')].filter(el => {
          const t = (el.textContent?.trim() || '').toLowerCase();
          return t.includes(targetName);
        });
        if (results.length > 0) {
          console.log('[Human Behavior Bot] Found matching user in search results — clicking...');
          await humanClick(results[0]);
          await sleep(humanDelay(1000));

          const chatBtns = [...document.querySelectorAll('button, div[role="button"]')].filter(btn => {
            const t = (btn.textContent?.trim() || '').toLowerCase();
            return t === 'next' || t === 'chat' || t === 'siguiente' || t === 'weiter';
          });
          if (chatBtns.length > 0) {
            await humanClick(chatBtns[0]);
            await sleep(humanDelay(2000));
          }
        }
      }
    } else if (window.location.pathname.includes('/direct/inbox')) {
      // Full-page inbox — open the matching thread in the right pane.
      // First try the rich identifier match (handles display-name vs @handle cases),
      // then fall back to substring-on-textContent which works for some layouts.
      console.log('[Human Behavior Bot] Landed on /direct/inbox — looking for conversation with @' + (targetName || 'target'));
      let openedThread = false;

      for (let attempt = 0; attempt < 4 && !openedThread; attempt++) {
        // Strategy 1: identifier-based match (parses href + nested @handles + display spans)
        if (normalizedTarget) {
          openedThread = await openMatchingInboxThread(normalizedTarget);
          if (openedThread) {
            console.log('[Human Behavior Bot] ✅ Opened matching inbox thread for @' + normalizedTarget);
            break;
          }
        }

        // Strategy 2: textContent substring match (covers rare layouts where the
        // identifier helpers miss because Instagram only renders a display name)
        const threadLinks = Array.from(document.querySelectorAll('a[href*="/direct/t/"]'))
          .filter((link) => isElementVisibleAndEnabled(link));
        console.log('[Human Behavior Bot] Found ' + threadLinks.length + ' thread links in inbox (attempt ' + (attempt + 1) + '/4)');
        for (const link of threadLinks) {
          const linkText = (link.textContent || '').toLowerCase();
          if (targetName && linkText.includes(targetName)) {
            console.log('[Human Behavior Bot] ✅ Found conversation with @' + (username || normalizedHint) + ' via text — clicking...');
            link.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(humanDelay(300));
            await humanClick(link);
            openedThread = true;
            await sleep(humanDelay(1800));
            break;
          }
        }
        if (openedThread) break;

        if (attempt < 3) {
          console.log('[Human Behavior Bot] Conversation not found (attempt ' + (attempt + 1) + '/4), waiting and retrying...');
          await sleep(1000);
        }
      }

      // Strategy 3: no existing thread for this user. Try to open Instagram's
      // own "New message" composer via the pencil icon in the inbox sidebar —
      // this is an SPA action that keeps the content script alive.
      //
      // CRITICAL: do NOT use window.location.href = '/direct/new/' here. That
      // causes a full page reload, which DESTROYS the running content script
      // mid-DM. The background's runSession sees the script disappear and
      // marks the targeting session as completed, even though the DM never
      // got sent. (This was the v2.4.77 regression.)
      if (!openedThread && targetName) {
        console.log('[Human Behavior Bot] No existing thread for @' + targetName + ' — trying SPA-friendly "New message" pencil');

        const findNewMessageButton = () => {
          // Try a few selectors used across IG layouts for the pencil icon at
          // the top of the inbox sidebar.
          const direct = document.querySelector(
            'svg[aria-label="New message" i], svg[aria-label*="new message" i],'
            + ' [aria-label="New message" i], [aria-label*="new message" i]'
          );
          if (direct) {
            return direct.closest('[role="button"]') || direct.closest('button') || direct;
          }
          return null;
        };

        const pencilBtn = findNewMessageButton();
        if (pencilBtn) {
          try {
            pencilBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(humanDelay(300));
            await humanClick(pencilBtn);
          } catch {}
          await sleep(humanDelay(1500));

          // The new-message dialog (or /direct/new/ via SPA nav) should appear.
          // Type the username in the recipient search and pick the match.
          const searchInput = document.querySelector(
            '[role="dialog"] input[placeholder*="Search" i], [role="dialog"] input[name="queryBox"],'
            + ' input[placeholder*="Search" i], input[name="queryBox"]'
          );
          if (searchInput) {
            console.log('[Human Behavior Bot] New-message dialog open — typing "' + targetName + '"');
            try { searchInput.focus(); } catch {}
            await sleep(300);
            const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            try {
              valueSetter?.call(searchInput, '');
              searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            } catch {}
            await sleep(200);
            for (const char of targetName) {
              try {
                valueSetter
                  ? valueSetter.call(searchInput, (searchInput.value || '') + char)
                  : (searchInput.value = (searchInput.value || '') + char);
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
              } catch {}
              await sleep(randomInt(50, 120));
            }
            await sleep(humanDelay(1500));

            // Pick the result that exactly matches the target username
            const dialogScope = document.querySelector('[role="dialog"]') || document;
            const allResults = [...dialogScope.querySelectorAll('div[role="button"], button, div[role="option"], label')];
            let chosen = null;
            for (const el of allResults) {
              const t = (el.textContent || '').toLowerCase();
              if (t.includes('@' + targetName) || new RegExp('(^|\\s|@)' + targetName + '(\\s|$)').test(t)) {
                chosen = el;
                break;
              }
            }
            if (!chosen) {
              for (const el of allResults) {
                const t = (el.textContent || '').toLowerCase();
                if (t.includes(targetName)) { chosen = el; break; }
              }
            }
            if (chosen) {
              console.log('[Human Behavior Bot] New-message dialog: clicking matching result...');
              try { await humanClick(chosen); } catch { try { chosen.click(); } catch {} }
              await sleep(humanDelay(900));

              const chatBtns = [...(document.querySelectorAll('[role="dialog"] button, [role="dialog"] div[role="button"], button, div[role="button"]'))].filter((btn) => {
                const t = (btn.textContent?.trim() || '').toLowerCase();
                return t === 'next' || t === 'chat' || t === 'siguiente' || t === 'weiter';
              });
              if (chatBtns.length > 0) {
                try { await humanClick(chatBtns[0]); } catch { try { chatBtns[0].click(); } catch {} }
                await sleep(humanDelay(2000));
              }
            } else {
              console.log('[Human Behavior Bot] New-message dialog: no matching search result for @' + targetName);
            }
          } else {
            console.log('[Human Behavior Bot] Pencil clicked but no recipient search appeared — skipping');
          }
        } else {
          console.log('[Human Behavior Bot] No "New message" pencil button found — bot will fall through to composer detection');
        }
      }

      if (!openedThread && !isOnInstagramDirectThread()) {
        console.log('[Human Behavior Bot] ⚠️ Could not navigate into a thread — waiting for any composer to render...');
        await sleep(humanDelay(2000));
      }
    }
  }

  const isDirectPage = window.location.pathname.includes('/direct/');

  // ── Step 5: Wait for the composer (message textbox) to be ready ──────────────
  console.log('[Human Behavior Bot] Waiting for message composer to appear...');
  const isDirectInbox = window.location.pathname === '/direct/inbox/' || window.location.pathname === '/direct/inbox';

  // If we're on /direct/inbox without a thread ID, we may not have a specific thread open yet
  if (isDirectInbox) {
    console.log('[Human Behavior Bot] ⚠️ Still on /direct/inbox (no thread ID) — waiting for thread to load...');
    await sleep(2000);
  }

  let activeTextbox = await waitForDMComposer(
    username || normalizedHint,
    isDirectPage ? 20 : 15  // Longer timeout for /direct/ pages (inbox or threads)
  );

  // If composer still not found, try a final aggressive search with even longer timeout
  if (!activeTextbox) {
    console.log('[Human Behavior Bot] Composer not found on first attempt — trying aggressive search (max 25s)...');
    activeTextbox = await waitForDMComposer(
      username || normalizedHint,
      25
    );
  }

  if (!activeTextbox) {
    console.log('[Human Behavior Bot] ❌ DM textbox never appeared after extended wait — cannot send message');
    return false;
  }

  // ── Step 6: Check if already messaged (post-open refresh) ───────────────────
  await refreshDMHistoryCache();
  const threadKey = extractCurrentThreadUsername();
  const threadId  = extractCurrentThreadId();
  const knownIdentifiers = [username, normalizedHint, threadKey, threadId]
    .map(normalizeDMHistoryEntry)
    .filter(Boolean);

  if (knownIdentifiers.some(id => isInDMHistory(id))) {
    for (const id of knownIdentifiers) await addToDMHistory(id);
    console.log(`[Human Behavior Bot] Already DM'd @${username || 'unknown'} (history hit) — skipping`);
    return false;
  }

  // ── EXISTING-CHATS GATE (restored to v2.4.93 thresholds in v2.4.145) ──
  // Skip if we already have outgoing messages in this thread
  // …unless the user enabled "Message Existing Chats" in targeting filters.
  // HARDENED: wait for a definitive 'existing' or 'empty' verdict, never assume
  // an unrendered thread is fresh. Fails closed (skip) on 'unknown'.
  const allowExistingChatsHere = !!allowExistingChats;
  const freshness = await confirmThreadFreshness(activeTextbox, { maxWaitMs: 8000, stableChecks: 3 });
  if (freshness === 'existing') {
    if (allowExistingChatsHere) {
      console.log(`[Human Behavior Bot] Thread has existing messages — sending anyway (Message Existing Chats ON)`);
    } else {
      for (const id of knownIdentifiers) await addToDMHistory(id);
      console.log(`[Human Behavior Bot] Thread already has existing messages — skipping (performProfileDM)`);
      return false;
    }
  } else if (freshness === 'unknown' && !allowExistingChatsHere) {
    console.log(`[Human Behavior Bot] Thread freshness unknown after 8s — skipping this iteration (will retry next session) (performProfileDM)`);
    return false;
  }

  // Final pre-send guard: re-check immediately before typing/sending (restored v2.4.93)
  if (!allowExistingChatsHere && threadHasExistingMessages(activeTextbox)) {
    for (const id of knownIdentifiers) await addToDMHistory(id);
    console.log(`[Human Behavior Bot] Pre-send guard caught existing messages — skipping (performProfileDM)`);
    return false;
  }


  // ── Step 7: Personalise message + apply readability spacing ─────────────────
  console.log(`[Human Behavior Bot] Raw DM script: ${String(customMessage).slice(0, 200)}`);
  const finalMessage = personalizeAndFormatDM(customMessage, username || normalizedHint);
  if (!finalMessage) {
    console.log('[Human Behavior Bot] ERROR: DM script personalization failed or unresolved variables remain — aborting send');
    return false;
  }
  console.log(`[Human Behavior Bot] Final DM script: ${finalMessage.slice(0, 200)}`);

  // ── Step 8: Type and send the script (single attempt, no triple-send) ──────
  console.log(`[Human Behavior Bot] ════════════════════════════════════════════════`);
  console.log(`[Human Behavior Bot] STEP 8: Typing and sending DM to @${username || normalizedHint || 'unknown'}`);
  console.log(`[Human Behavior Bot] Message length: ${finalMessage.length} chars`);
  console.log(`[Human Behavior Bot] DM interface: ${isDirectPage ? '/direct/ page' : 'floating widget/dialog'}`);
  console.log(`[Human Behavior Bot] ════════════════════════════════════════════════`);

  const sent = await executeValidatedDMFlow(finalMessage, {
    label: `performProfileDM @${username || normalizedHint || 'unknown'}`,
    targetUsernameHint: username || normalizedHint || '',
    initialComposer: activeTextbox,
    maxFlowAttempts: 2,
  });

  if (!sent) {
    console.log(`[Human Behavior Bot] ❌ DM send not confirmed for @${username || normalizedHint || 'unknown'} after single-dispatch protection`);
  }

  // ── Step 9: Record result and navigate back ──────────────────────────────────
  if (sent) {
    for (const id of knownIdentifiers) await addToDMHistory(id);
    if (username)        await addToDMHistory(username);
    if (normalizedHint)  await addToDMHistory(normalizedHint);
    console.log(`[Human Behavior Bot] ✅ DM sent to @${username || normalizedHint || 'unknown'}`);

    await sleep(humanDelay(1200));

    // Close the floating chat widget if one is still open (Instagram's bottom-right
    // messenger panel).  Find the × / close button at the top of the panel.
    // IMPORTANT: scope the search to INSIDE the floating panel — NOT document.querySelector()
    // which would match any "Close" element on the page (e.g. security overlays, notifications),
    // potentially closing an Instagram verification prompt and triggering a forced logout.
    //
    // ── HARD TIMEOUT (v2.4.113) ──────────────────────────────────────────
    // User reported "after sending one DM it gets stuck on the profile
    // instead of moving to the next profile". Logs showed the last entry
    // was "Closing floating chat panel..." with no further progress —
    // performProfileDM hangs here, the IIFE never reaches sendResponse, and
    // background's sendActionToTab await blocks forever, freezing the loop.
    // Wrap the whole close path in Promise.race with a 3s ceiling so even
    // a hung humanClick can never block the loop's next iteration.
    if (!window.location.pathname.includes('/direct/')) {
      const closeFloatingPanel = async () => {
        // Walk up from the active textbox to find the position:fixed panel container
        let floatingPanel = null;
        let el = activeTextbox;
        for (let d = 0; d < 25 && el && el !== document.body; d++) {
          el = el.parentElement;
          if (!el) break;
          try { if (window.getComputedStyle(el).position === 'fixed') { floatingPanel = el; break; } } catch (_) {}
        }
        const searchScope = floatingPanel || null;
        if (!searchScope) return;
        const floatingCloseSelectors = [
          'svg[aria-label="Close chat"]',
          'svg[aria-label="Close"]',
          'button[aria-label="Close chat"]',
          'button[aria-label="Minimize chat"]',
          'svg[aria-label="Minimize"]',
        ];
        for (const sel of floatingCloseSelectors) {
          const closeEl = searchScope.querySelector(sel);
          if (!closeEl) continue;
          const btn = closeEl.tagName === 'BUTTON' ? closeEl : closeEl.closest('button') || closeEl.closest('[role="button"]');
          if (btn && isElementVisibleAndEnabled(btn)) {
            console.log('[Human Behavior Bot] Closing floating chat panel...');
            await humanClick(btn);
            await sleep(humanDelay(400));
            return;
          }
        }
      };
      try {
        await Promise.race([
          closeFloatingPanel(),
          new Promise((resolve) => setTimeout(() => {
            console.warn('[Human Behavior Bot] Floating chat panel close timed out after 3s — moving on');
            resolve();
          }, 3000)),
        ]);
      } catch (_) {}
    }

    if (window.location.pathname.includes('/direct/')) {
      // ⚠️ Do NOT click a[href="/direct/inbox/"] — that navigates TO the inbox,
      // adding a new history entry (/direct/inbox/) and making returnToLocationGrid
      // need extra steps to unwind back through it.  Use history.back() directly
      // to step back through the SPA history without pushing new entries.
      window.history.back();
      await sleep(humanDelay(1500));
      if (window.location.pathname.includes('/direct/')) {
        window.history.back();
        await sleep(humanDelay(1500));
      }
      if (window.location.pathname.includes('/direct/')) {
        window.history.back();
        await sleep(humanDelay(1500));
      }
    } else {
      // ── POST-DM NAV BACK TO POST (v2.4.120) ──────────────────────────
      // User reported the bot "fails to return to the likers page after
      // sending DM". After the DM lands via the floating chat widget,
      // the page is still on the LIKER'S PROFILE (e.g. /itsbookgains/).
      // The next iteration's navigatePost would then trigger
      // window.location.href = postUrl — a HARD reload that kills the
      // content script mid-call and breaks the message channel. The
      // bot LOOKS frozen even though everything earlier worked.
      //
      // Use window.history.back() instead. The liker's profile was
      // reached via SPA navigation (modal-click → IG router) so back()
      // returns us to the post URL with the modal possibly still open,
      // no reload, no content-script reset. The next iteration's
      // navigatePost will see onPostUrlAlready=true and reuse the
      // modal — fast and reliable.
      try {
        const beforePath = window.location.pathname;
        window.history.back();
        await sleep(humanDelay(1200));
        if (window.location.pathname === beforePath) {
          // back() didn't change the path (e.g. SPA router lost the entry).
          // Try again once after a short wait.
          await sleep(humanDelay(600));
          if (window.location.pathname === beforePath) {
            console.log('[Human Behavior Bot] history.back() did not change URL — leaving navigation to next iteration');
          }
        } else {
          console.log(`[Human Behavior Bot] ↩️ Navigated back via history.back(): ${beforePath} → ${window.location.pathname}`);
        }
      } catch (e) {
        console.warn('[Human Behavior Bot] history.back() failed:', e?.message || e);
      }
    }
  } else {
    console.log(`[Human Behavior Bot] ⚠️ Could not send DM to @${username || normalizedHint || 'unknown'}`);
  }

  await sleep(humanDelay(1000));
  return sent;
}

// Track visited accounts in this session to avoid revisiting
const traversalState = loadTraversalState();
const visitedAccountsThisSession = new Set(
  (Array.isArray(traversalState.visitedAccounts) ? traversalState.visitedAccounts : [])
    .filter((u) => typeof u === 'string' && u.trim().length > 0)
    .map((u) => u.toLowerCase())
);
// Track how far we've scrolled in the modal so we keep going deeper
let modalScrollOffset = Number.isFinite(traversalState.modalScrollOffset)
  ? Math.max(0, traversalState.modalScrollOffset)
  : 0;
// Track which post index we're on for hashtag sequential browsing
let hashtagPostIndex = 0;
// Track visited post hrefs to avoid clicking the same post twice (persisted to chrome.storage.local)
let visitedPostsThisSession = new Set();
const VISITED_POSTS_KEY = 'futnor_visited_posts';

// Load visited posts from persistent storage
(async () => {
  try {
    const data = await new Promise(resolve => chrome.storage.local.get({ [VISITED_POSTS_KEY]: [] }, resolve));
    const saved = data[VISITED_POSTS_KEY];
    if (Array.isArray(saved)) {
      visitedPostsThisSession = new Set(saved);
      console.log(`[Human Behavior Bot] Restored ${visitedPostsThisSession.size} visited posts from storage`);
    }
  } catch (e) {
    console.warn('[Futnor Instagram] Failed to restore visited posts from storage:', e?.message || e);
  }
})();

function persistVisitedPosts() {
  try {
    chrome.storage.local.set({ [VISITED_POSTS_KEY]: Array.from(visitedPostsThisSession) });
  } catch {}
}

// Prime persistent history caches so already-handled accounts are excluded from targeting
Promise.all([
  refreshDMHistoryCache(),
  refreshProcessedAccountsCache(),
]).catch(() => {});

// ─── ENGAGE NEXT HASHTAG POST (SEQUENTIAL, TOP-TO-BOTTOM) ──
// Clicks the next unvisited post on a hashtag page, opens it,
// finds the poster's username, stores it in chrome.storage for background.js
// (mirrors the location flow — does NOT navigate to the profile).
async function engageNextHashtagPost() {
  // NOTE: background.js clears futnor_hashtag_target_username before calling us.
  // We only SET it (never clear it) so retries don't wipe a valid username.

  await Promise.all([refreshDMHistoryCache(), refreshProcessedAccountsCache()]).catch(() => {});

  // Verify we're on a hashtag page
  if (!isInstagramHashtagRoute()) {
    console.log('[Human Behavior Bot] Cannot engage hashtag posts — not on hashtag page');
    return false;
  }

  await waitForHashtagGrid(8000).catch(() => false);

  // Get unvisited posts
  let allPostLinks = getHashtagResultPostLinks();
  if (allPostLinks.length === 0) {
    console.log('[Human Behavior Bot] No hashtag result posts found, trying scroll...');
    for (let s = 0; s < 4; s++) {
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
      await sleep(humanDelay(1800));
    }
    allPostLinks = getHashtagResultPostLinks();
    if (allPostLinks.length === 0) return false;
  }

  let unvisitedPosts = allPostLinks.filter(a => {
    const href = a.getAttribute('href');
    return href && !visitedPostsThisSession.has(href);
  });

  // If all visible posts visited, scroll for more
  if (unvisitedPosts.length === 0) {
    console.log('[Human Behavior Bot] All visible hashtag posts visited, scrolling to load more...');
    for (let s = 0; s < 10; s++) {
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
      await sleep(humanDelay(1500));
    }
    unvisitedPosts = getHashtagResultPostLinks().filter(a => {
      const h = a.getAttribute('href');
      return h && !visitedPostsThisSession.has(h);
    });
    if (unvisitedPosts.length === 0) {
      console.log('[Human Behavior Bot] No new hashtag posts after extensive scrolling');
      return false;
    }
    console.log(`[Human Behavior Bot] Found ${unvisitedPosts.length} new posts after scrolling`);
  }

  // ── Helper: find poster username from the current post view ────────────────
  function findPosterUsername() {
    const dialog = document.querySelector('[role="dialog"]');
    const searchArea = dialog || document;
    const isModal = !!dialog;

    const candidates = [
      ...searchArea.querySelectorAll('a[href^="/"][role="link"]'),
      ...(dialog ? dialog.querySelectorAll('header a[href^="/"]') : []),
      ...searchArea.querySelectorAll('article header a[href^="/"]'),
      ...searchArea.querySelectorAll('article a[href^="/"]'),
      ...(dialog ? dialog.querySelectorAll('a[href^="/"]') : []),
    ];
    const seenHrefs = new Set();
    for (const link of candidates) {
      const linkHref = (link.getAttribute('href') || '').split('?')[0].split('#')[0];
      if (seenHrefs.has(linkHref)) continue;
      seenHrefs.add(linkHref);
      const match = linkHref.match(/^\/([a-zA-Z0-9_.]{2,30})\/?$/);
      if (!match) continue;
      if (/\/(explore|direct|p|reel|reels|stories|tags|accounts|tv|locations|web)\b/.test(linkHref)) continue;
      const uname = match[1].toLowerCase();
      if (RESERVED_PROFILE_SEGMENTS.has(uname)) continue;
      console.log(`[Human Behavior Bot] Hashtag post username from link: @${uname}`);
      return uname;
    }

    const tm = document.title.match(/^([a-zA-Z0-9_.]{2,30})\s*(?:•|\bon\b)/i);
    if (tm) {
      const uname = tm[1].toLowerCase();
      if (!RESERVED_PROFILE_SEGMENTS.has(uname)) {
        console.log(`[Human Behavior Bot] Hashtag post username from title: @${uname}`);
        return uname;
      }
    }

    const imgs = searchArea.querySelectorAll('img[alt]');
    for (const img of imgs) {
      const alt = img.getAttribute('alt') || '';
      const m = alt.match(/^(?:Photo|Video|Image|Clip|Reel)\s+by\s+([a-zA-Z0-9_.]{2,30})\b/i);
      if (m) {
        const uname = m[1].toLowerCase();
        if (!RESERVED_PROFILE_SEGMENTS.has(uname)) {
          console.log(`[Human Behavior Bot] Hashtag post username from alt: @${uname}`);
          return uname;
        }
      }
    }

    console.log(`[Human Behavior Bot] ⚠️ Could not extract username from hashtag post (modal=${isModal})`);
    return null;
  }

  // ── Try each unvisited post ────────────────────────────────────────────────
  for (const postLink of unvisitedPosts.slice(0, 8)) {
    const href = postLink.getAttribute('href');
    if (!href) continue;

    // Mark post as visited
    visitedPostsThisSession.add(href);
    persistVisitedPosts();

    // Fast path: extract username directly from the thumbnail before opening the post
    const thumbUsername = extractUsernameFromThumbnail(postLink);
    if (thumbUsername && !hasVisitedAccount(thumbUsername)) {
      markTraversalVisitedAccount(thumbUsername);
      await chrome.storage.local.set({ futnor_hashtag_target_username: thumbUsername });
      console.log(`[Human Behavior Bot] ✅ Found hashtag poster @${thumbUsername} via thumbnail — stored for background.js`);
      return true;
    }

    // Scroll into view and click the post
    postLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(800));

    console.log('[Human Behavior Bot] Opening hashtag post:', href);
    postLink.click();
    await sleep(humanDelay(2000));

    // If Instagram redirected into Reels, try to extract username before backing out
    if (isInstagramReelsPath()) {
      console.log('[Human Behavior Bot] Instagram redirected post into Reels — trying to extract username');
      await sleep(humanDelay(1500));

      let reelUsername = findPosterUsername();

      if (!reelUsername) {
        const metaTitle = document.querySelector('meta[property="og:title"]');
        if (metaTitle) {
          const mTitle = (metaTitle.getAttribute('content') || '').match(/^([a-zA-Z0-9_.]{2,30})\b/);
          if (mTitle && !RESERVED_PROFILE_SEGMENTS.has(mTitle[1].toLowerCase())) {
            reelUsername = mTitle[1].toLowerCase();
            console.log(`[Human Behavior Bot] Reel username from og:title: @${reelUsername}`);
          }
        }
      }

      if (!reelUsername) {
        const reelLinks = document.querySelectorAll('a[href^="/"][role="link"], span[dir="auto"] a[href^="/"]');
        for (const link of reelLinks) {
          const lHref = (link.getAttribute('href') || '').split('?')[0].split('#')[0];
          const m = lHref.match(/^\/([a-zA-Z0-9_.]{2,30})\/?$/);
          if (m && !RESERVED_PROFILE_SEGMENTS.has(m[1].toLowerCase()) &&
              !/\/(explore|direct|p|reel|reels|stories|tags|accounts|tv|locations|web)\b/.test(lHref)) {
            reelUsername = m[1].toLowerCase();
            console.log(`[Human Behavior Bot] Reel username from link: @${reelUsername}`);
            break;
          }
        }
      }

      if (reelUsername && !hasVisitedAccount(reelUsername)) {
        markTraversalVisitedAccount(reelUsername);
        await chrome.storage.local.set({ futnor_hashtag_target_username: reelUsername });
        console.log(`[Human Behavior Bot] ✅ Found reel poster @${reelUsername} — stored for background.js`);
        window.history.back();
        await sleep(humanDelay(1800));
        return true;
      }

      if (reelUsername) console.log(`[Human Behavior Bot] @${reelUsername} already visited — skipping reel`);
      window.history.back();
      await sleep(humanDelay(1800));
      continue;
    }

    let postReady = false;
    for (let w = 0; w < 25; w++) {
      await sleep(200);
      if (document.querySelector('[role="dialog"]') ||
          document.querySelector('article') ||
          normalizeInstagramPath(window.location.pathname).includes('/p/') ||
          normalizeInstagramPath(window.location.pathname).includes('/reel/')) {
        postReady = true;
        break;
      }
    }
    if (!postReady) {
      console.log('[Human Behavior Bot] Hashtag post did not load — skipping');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(500);
      if (!isInstagramHashtagRoute()) {
        window.history.back();
        await sleep(humanDelay(1500));
      }
      continue;
    }

    let posterUsername = null;
    for (let poll = 0; poll < 25; poll++) {
      posterUsername = findPosterUsername();
      if (posterUsername) break;
      await sleep(200);
    }

    if (!posterUsername) {
      console.log('[Human Behavior Bot] Could not find poster username in hashtag post — trying next');
      await closePostModal();
      await sleep(300);
      if (!isInstagramHashtagRoute()) {
        window.history.back();
        await sleep(humanDelay(1500));
      }
      continue;
    }

    if (hasVisitedAccount(posterUsername)) {
      console.log(`[Human Behavior Bot] @${posterUsername} already visited — skipping`);
      await closePostModal();
      await sleep(300);
      if (!isInstagramHashtagRoute()) {
        window.history.back();
        await sleep(humanDelay(1000));
      }
      continue;
    }
    // ── Found a valid username — mark only traversal state; background.js owns processed history ───
    markTraversalVisitedAccount(posterUsername);
    await chrome.storage.local.set({ futnor_hashtag_target_username: posterUsername });
    console.log(`[Human Behavior Bot] ✅ Found poster @${posterUsername} — stored for background.js`);

    // Close the post modal — don't navigate to profile here.
    // Let background.js handle profile navigation (avoids killing content script).
    await closePostModal();
    await sleep(humanDelay(800));

    console.log(`[Human Behavior Bot] ✅ Post modal closed — ready for background.js to navigate to profile`);
    return true;
  }

  console.log('[Human Behavior Bot] No valid hashtag posts found after trying up to 8');
  return false;
}

// Helper: click a post, find the poster, navigate to their profile
async function clickPostAndVisitProfile(postLink) {
  const href = postLink.getAttribute('href');
  if (!href) return false;
  // Mark as visited regardless (prevents infinite reel loops)
  visitedPostsThisSession.add(href);
  if (href.includes('/reel/') || href.includes('/reels/')) {
    console.log('[Human Behavior Bot] Skipping reel from results (marked visited to avoid re-check)');
    return false;
  }
  persistVisitedPosts();

  // Scroll post into view like a human
  postLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(800));

  console.log('[Human Behavior Bot] Opening location post directly:', href);
  const postUrl = href.startsWith('http') ? href : `https://www.instagram.com${normalizeInstagramPath(href)}/`;
  try {
    const tempLink = document.createElement('a');
    tempLink.href = postUrl;
    tempLink.style.display = 'none';
    document.body.appendChild(tempLink);
    tempLink.click();
    tempLink.remove();
  } catch {
    window.location.href = postUrl;
  }
  await sleep(humanDelay(2500));

  if (isInstagramReelsPath()) {
    console.log('[Human Behavior Bot] 🚫 Instagram redirected location post into Reels — backing out');
    window.history.back();
    await sleep(humanDelay(1800));
    return false;
  }

  // Find the poster's username from the post modal/page
  // Instagram post modals have a header with the poster's profile link
  let posterUsername = null;
  let posterLink = null;

  // Method 1: Look for profile link in post header (most reliable)
  const dialog = document.querySelector('[role="dialog"]');
  const searchArea = dialog || document;
  
  // Look for links that match /<username>/ pattern in the post header area
  const headerLinks = searchArea.querySelectorAll('a[href^="/"][role="link"]');
  for (const link of headerLinks) {
    const linkHref = link.getAttribute('href') || '';
    const match = linkHref.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
    if (match && !linkHref.includes('/explore') && !linkHref.includes('/direct') 
        && !linkHref.includes('/p/') && !linkHref.includes('/reel/')) {
      const uname = match[1].toLowerCase();
      if (!hasVisitedAccount(uname)) {
        posterUsername = uname;
        posterLink = link;
        break;
      } else {
        console.log(`[Human Behavior Bot] Post creator @${uname} already visited, skipping post`);
        // Close modal and return false so we try next post
        await closePostModal();
        return false;
      }
    }
  }

  if (!posterUsername || !posterLink) {
    console.log('[Human Behavior Bot] Could not find poster username in post');
    await closePostModal();
    return false;
  }

  // Mark as visited
  markVisitedAccount(posterUsername);
  console.log(`[Human Behavior Bot] Found poster @${posterUsername}, navigating to profile...`);

  // Navigate straight to the poster's profile to avoid Instagram routing into reels
  const profileUrl = `https://www.instagram.com/${posterUsername}/`;
  try {
    const tempLink = document.createElement('a');
    tempLink.href = profileUrl;
    tempLink.style.display = 'none';
    document.body.appendChild(tempLink);
    tempLink.click();
    tempLink.remove();
  } catch {
    window.location.href = profileUrl;
  }
  await sleep(humanDelay(2500)); // Wait for profile page to load

  // Verify we're on a profile page — escape /reels/ or /reel/ if we ended up there
  if (isInstagramReelsPath()) {
    console.log('[Human Behavior Bot] ⚠️ Landed on reels page, navigating to profile instead');
  }

  if (!isInstagramProfilePath(posterUsername)) {
    if (window.location.pathname.includes('/p/') || window.location.pathname.includes('/explore/locations/') || document.querySelector('[role="dialog"]')) {
      // Still in the post modal/page, try closing modal first
      await closePostModal();
      await sleep(humanDelay(1000));
    }

    const profileUrl = `https://www.instagram.com/${posterUsername}/`;
    try {
      const tempLink = document.createElement('a');
      tempLink.href = profileUrl;
      tempLink.style.display = 'none';
      document.body.appendChild(tempLink);
      tempLink.click();
      tempLink.remove();
      await sleep(humanDelay(3000));
    } catch {
      window.location.href = profileUrl;
      await sleep(humanDelay(3500));
    }
  }

  if (!isInstagramProfilePath(posterUsername)) {
    console.log(`[Human Behavior Bot] ❌ Failed to reach @${posterUsername}'s profile from location post`);
    return false;
  }

  if (window.location.pathname.includes('/p/')) {
    await closePostModal();
    await sleep(humanDelay(1000));
  }

  console.log(`[Human Behavior Bot] ✅ On @${posterUsername}'s profile`);
  return true;
}

async function closePostModal() {
  const modal = document.querySelector('[role="dialog"]');
  if (modal) {
    const closeBtn = modal.querySelector('svg[aria-label="Close"]')?.closest('button')
      || modal.querySelector('button[aria-label="Close"]');
    if (closeBtn) {
      await humanClick(closeBtn);
      await sleep(humanDelay(600));
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(humanDelay(600));
    }
  }
}

// Pick a similar/suggested account from the current page and visit their profile.
//
// CRITICAL FIX (v2.4.97): when called from a post page (/p/* or /reel/*), this
// function used to pick ANY profile link on the page — which on a post page is
// dominated by the post-owner link in the article header. The user reported
// the bot was DMing the post owner instead of likers. We now:
//   1. If we're on a post page, FIRST try to click the "X likes" link to open
//      the likers dialog and engage from there. This is what should have
//      happened upstream in navigatePost(...,'likers'); we re-do it here as
//      a safety net so the legacy targeting flow can recover when the
//      upstream click failed.
//   2. Always filter out the post owner via collectPostOwnerCandidates() so
//      they can never be picked as a candidate, regardless of how we got here.
async function performEngageSimilarAccount() {
  // Refresh persistent caches so we skip already-processed accounts
  await Promise.all([refreshDMHistoryCache(), refreshProcessedAccountsCache()]).catch(() => {});

  // First check if we're in a followers/following/likers modal — engage from
  // there if so.
  const modal = document.querySelector('[role="dialog"]');
  if (modal) {
    const fromModal = await engageFromModal();
    if (fromModal) return true;
    // engageFromModal returned false — either the modal was empty / not a
    // profile-list, OR the only candidates were the post owner / already-
    // visited. Don't fall through to picking random page links because
    // that's exactly how we ended up DMing post owners. Return false and
    // let the caller scroll / retry.
    console.log('[Human Behavior Bot] performEngageSimilarAccount: modal present but no usable candidates — returning false');
    return false;
  }

  // No modal — figure out what kind of page we're on. The fix is most
  // critical for /p/ and /reel/ pages where the dominant profile link is
  // the post owner.
  const path = window.location.pathname || '';
  const isOnPostPage = /\/(p|reel)\//.test(path);

  // ── On a POST page: prefer to open the likers dialog first ──
  // This is the "we landed here from likers targeting" recovery path. If
  // navigatePost(...,'likers') succeeded the modal would already be open
  // and we'd have returned via the engageFromModal branch above. We didn't,
  // so let's try ONE more time to open the likers dialog ourselves.
  if (isOnPostPage) {
    const likesLink = findLikersOpener();
    if (likesLink) {
      const clickable = likesLink.closest('a') || likesLink.closest('button') || likesLink.closest('[role="button"]') || likesLink;
      console.log('[Human Behavior Bot] performEngageSimilarAccount: opening likers dialog from post page');
      await humanClick(clickable);
      await sleep(humanDelay(2200));
      // Retry engageFromModal now that the dialog should be open.
      return engageFromModal();
    }
    console.warn('[Human Behavior Bot] performEngageSimilarAccount: on post page but no likes-link found — refusing to fall through to page-link picker (would DM post owner)');
    return false;
  }

  // Off-post (explore / hashtag / feed / suggestions / follower modal landing
  // page etc.) — pick from page links, but ALWAYS filter post-owner candidates
  // so even if we somehow drift onto a post page we don't DM the owner.
  const ownerSet = collectPostOwnerCandidates();
  const profileLinks = Array.from(document.querySelectorAll('a[href]'));
  const candidates = profileLinks
    .map((link) => {
      const username = parseInstagramUsernameFromHref(link.getAttribute('href') || '');
      return username ? { link, username } : null;
    })
    .filter((item) => item)
    .filter((item) => !ownerSet.has(item.username))     // never DM the post owner
    .filter((item) => !hasVisitedAccount(item.username));

  if (candidates.length === 0) {
    console.log('[Human Behavior Bot] No unvisited non-owner profile links found on page');
    return false;
  }

  // v2.4.155: take the next account in page order rather than a random one of
  // the top 6 on screen. The viewport filter made "top 6" mean "6 arbitrary
  // rows at the current scroll position", so this flow skipped accounts and
  // revisited the same region of the list. `candidates` is already in DOM
  // order with handled accounts removed.
  const chosen = candidates[0];

  markVisitedAccount(chosen.username);
  console.log(`[Human Behavior Bot] Clicking on @${chosen.username} from page (owners filtered: ${ownerSet.size})`);

  chosen.link.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(500));
  await humanClick(chosen.link);
  await sleep(humanDelay(2200));
  return true;
}

// ─── RECENCY HELPERS ───────────────────────────────────────
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

function parseRelativeTime(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const now = Date.now();

  // "Xd" / "Xh" / "Xm" / "Xs" / "Xw" format
  const shortMatch = t.match(/^(\d+)\s*([smhdw])/);
  if (shortMatch) {
    const num = parseInt(shortMatch[1]);
    const unit = shortMatch[2];
    const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit] || 0;
    return now - num * ms;
  }

  // "X minutes/hours/days/weeks ago"
  const longMatch = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
  if (longMatch) {
    const num = parseInt(longMatch[1]);
    const unit = longMatch[2];
    const ms = {
      second: 1000, minute: 60000, hour: 3600000, day: 86400000,
      week: 604800000, month: 2592000000, year: 31536000000,
    }[unit] || 0;
    return now - num * ms;
  }

  // Try parsing as absolute date
  const parsed = Date.parse(text);
  if (!isNaN(parsed)) return parsed;

  return null;
}

function isWithinThreeMonths(timestamp) {
  if (!timestamp) return false;
  return (Date.now() - timestamp) < THREE_MONTHS_MS;
}

// Browse hashtag page, open a recent post, and visit that creator's profile
async function engageRecentAccount() {
  // Refresh persistent caches so AI targeting also skips handled accounts
  await Promise.all([refreshDMHistoryCache(), refreshProcessedAccountsCache()]).catch(() => {});

  // Find post links on the current page (hashtag/explore page)
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  const visible = Array.from(postLinks).filter(a => {
    const rect = a.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight;
  });

  if (visible.length === 0) return false;

  // Try multiple posts to find a recent one
  const shuffled = visible.sort(() => Math.random() - 0.5);

  for (const postLink of shuffled.slice(0, 5)) {
    await humanClick(postLink);
    await sleep(humanDelay(2500));

    // Check post date — look for <time> element with datetime attribute
    const timeEl = document.querySelector('time[datetime]');
    if (timeEl) {
      const datetime = timeEl.getAttribute('datetime');
      const postDate = Date.parse(datetime);
      if (postDate && !isWithinThreeMonths(postDate)) {
        console.log(`[AI Targeting] Post too old (${datetime}), skipping`);
        // Close modal and try next
        const closeBtn = document.querySelector('svg[aria-label="Close"]');
        if (closeBtn) {
          await humanClick(closeBtn.closest('button') || closeBtn);
          await sleep(humanDelay(800));
        } else {
          window.history.back();
          await sleep(humanDelay(1500));
        }
        continue;
      }
    }

    // Also check time text like "2d", "3w", etc.
    const timeTexts = document.querySelectorAll('time');
    let isRecent = true;
    for (const tEl of timeTexts) {
      const text = tEl.textContent?.trim() || tEl.getAttribute('title') || '';
      const parsed = parseRelativeTime(text);
      if (parsed && !isWithinThreeMonths(parsed)) {
        isRecent = false;
        break;
      }
    }

    if (!isRecent) {
      console.log('[AI Targeting] Post time text indicates too old, skipping');
      const closeBtn = document.querySelector('svg[aria-label="Close"]');
      if (closeBtn) {
        await humanClick(closeBtn.closest('button') || closeBtn);
        await sleep(humanDelay(800));
      } else {
        window.history.back();
        await sleep(humanDelay(1500));
      }
      continue;
    }

    // Post is recent! Navigate to the poster's profile
    const profileLink = document.querySelector('header a[href^="/"][role="link"]')
      || document.querySelector('a[href^="/"][role="link"] span')?.closest('a');

    if (profileLink) {
      const href = profileLink.getAttribute('href') || '';
      const username = parseInstagramUsernameFromHref(href);
      if (username && hasVisitedAccount(username)) {
        console.log(`[AI Targeting] @${username} already handled, skipping`);
        const closeBtn = document.querySelector('svg[aria-label="Close"]');
        if (closeBtn) {
          await humanClick(closeBtn.closest('button') || closeBtn);
          await sleep(humanDelay(800));
        } else {
          window.history.back();
          await sleep(humanDelay(1500));
        }
        continue;
      }

      if (username) markVisitedAccount(username);
      await humanClick(profileLink);
      await sleep(humanDelay(2500));
      return true;
    }

    // Fallback: close and try next
    const closeBtn = document.querySelector('svg[aria-label="Close"]');
    if (closeBtn) {
      await humanClick(closeBtn.closest('button') || closeBtn);
      await sleep(humanDelay(800));
    }
  }

  return false;
}

// Check if the currently viewed profile has posted within 3 months
async function checkProfileRecency() {
  // Look at the post grid — check the first post's date
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  if (postLinks.length === 0) return false;

  // Click the first (most recent) post
  const firstPost = postLinks[0];
  await humanClick(firstPost);
  await sleep(humanDelay(2500));

  let isRecent = true;

  // Check <time datetime="..."> in the opened post
  const timeEl = document.querySelector('time[datetime]');
  if (timeEl) {
    const datetime = timeEl.getAttribute('datetime');
    const postDate = Date.parse(datetime);
    if (postDate && !isWithinThreeMonths(postDate)) {
      isRecent = false;
    }
  }

  // Also check time text
  if (isRecent) {
    const timeTexts = document.querySelectorAll('time');
    for (const tEl of timeTexts) {
      const text = tEl.textContent?.trim() || tEl.getAttribute('title') || '';
      const parsed = parseRelativeTime(text);
      if (parsed && !isWithinThreeMonths(parsed)) {
        isRecent = false;
        break;
      }
    }
  }

  // Close the post modal
  const closeBtn = document.querySelector('svg[aria-label="Close"]');
  if (closeBtn) {
    await humanClick(closeBtn.closest('button') || closeBtn);
    await sleep(humanDelay(800));
  } else {
    window.history.back();
    await sleep(humanDelay(1500));
  }

  return isRecent;
}

// ─── DEMOGRAPHICS ESTIMATION ───────────────────────────────
// Scrapes profile name, bio, and pronouns to estimate gender and age from real info

// Common name lists for gender estimation
const MALE_NAMES = new Set(['james','john','robert','michael','david','william','richard','joseph','thomas','charles','christopher','daniel','matthew','anthony','mark','donald','steven','paul','andrew','joshua','kenneth','kevin','brian','george','timothy','ronald','edward','jason','jeffrey','ryan','jacob','gary','nicholas','eric','jonathan','stephen','larry','justin','scott','brandon','benjamin','samuel','raymond','gregory','frank','alexander','patrick','jack','dennis','jerry','tyler','aaron','jose','adam','nathan','henry','peter','douglas','zachary','kyle','noah','ethan','jeremy','walter','christian','keith','roger','terry','austin','sean','gerald','carl','harold','dylan','arthur','lawrence','jordan','jesse','bryan','billy','bruce','gabriel','joe','logan','albert','willie','alan','eugene','russell','vincent','philip','bobby','johnny','bradley','marcus','omar','liam','mason','elijah','aiden','oliver','lucas']);
const FEMALE_NAMES = new Set(['mary','patricia','jennifer','linda','barbara','elizabeth','susan','jessica','sarah','karen','lisa','nancy','betty','margaret','sandra','ashley','dorothy','kimberly','emily','donna','michelle','carol','amanda','melissa','deborah','stephanie','rebecca','sharon','laura','cynthia','kathleen','amy','angela','shirley','anna','brenda','pamela','emma','nicole','helen','samantha','katherine','christine','debra','rachel','carolyn','janet','catherine','maria','heather','diane','ruth','julie','olivia','joyce','virginia','victoria','kelly','lauren','christina','joan','evelyn','judith','megan','andrea','cheryl','hannah','jacqueline','martha','gloria','teresa','sophia','ann','sara','madison','frances','kathryn','janice','jean','abigail','alice','judy','grace','amber','denise','natalie','irene','ava','isabella','charlotte','mia','chloe','lily','ella','zoe','riley','aria','luna','stella']);

function estimateGender(displayName, bio) {
  const text = ((displayName || '') + ' ' + (bio || '')).toLowerCase();
  
  // Check explicit pronouns first (most reliable)
  if (/\b(she\/her|she\/they|her\/hers)\b/.test(text)) return 'female';
  if (/\b(he\/him|he\/they|him\/his)\b/.test(text)) return 'male';
  
  // Check bio keywords
  if (/\b(mom|mother|wife|girl|woman|queen|goddess|lady|sister|daughter|mama|wifey|girly|she|her)\b/.test(text)) return 'female';
  if (/\b(dad|father|husband|boy|man|king|guy|brother|son|papa|dude|bro|he|him)\b/.test(text)) return 'male';
  
  // Check emojis
  if (/👩|👧|👱‍♀️|🙋‍♀️|💃|👸|🤰|💅|💄/.test(text)) return 'female';
  if (/👨|👦|👱‍♂️|🙋‍♂️|🕺|🤴|🧔/.test(text)) return 'male';
  
  // Check first name from display name
  const firstName = (displayName || '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
  if (firstName) {
    if (FEMALE_NAMES.has(firstName)) return 'female';
    if (MALE_NAMES.has(firstName)) return 'male';
  }
  
  return 'unknown';
}

function estimateAge(displayName, bio) {
  const text = ((displayName || '') + ' ' + (bio || '')).toLowerCase();
  const currentYear = new Date().getFullYear();
  
  // Check explicit age mentions: "25 y/o", "age 25", "25 years old"
  const ageMatch = text.match(/\b(\d{1,2})\s*(?:y\.?o\.?|years?\s*old|yr?s?\s*old)\b/);
  if (ageMatch) {
    const age = parseInt(ageMatch[1]);
    if (age >= 13 && age <= 99) return age;
  }
  
  // Check "age: 25" or "age 25"
  const ageLabel = text.match(/\bage[:\s]+(\d{1,2})\b/);
  if (ageLabel) {
    const age = parseInt(ageLabel[1]);
    if (age >= 13 && age <= 99) return age;
  }
  
  // Check birth year: "born in 1995", "'95", "1995"
  const bornMatch = text.match(/\bborn\s*(?:in\s*)?(\d{4})\b/);
  if (bornMatch) {
    const age = currentYear - parseInt(bornMatch[1]);
    if (age >= 13 && age <= 99) return age;
  }
  
  // Check standalone birth year pattern in bio (e.g., "'98", "est. 1998")
  const yearMatch = text.match(/\b(?:est\.?\s*|since\s*|c\/o\s*|class\s*(?:of\s*)?)?['']?(\d{2,4})\b/);
  if (yearMatch) {
    let year = parseInt(yearMatch[1]);
    if (year < 100) year += (year > (currentYear % 100) ? 1900 : 2000);
    const age = currentYear - year;
    if (age >= 13 && age <= 99) return age;
  }
  
  // Check graduation year: "Class of 2020", "c/o 2020"  
  const gradMatch = text.match(/\b(?:class\s*of|c\/o|grad(?:uated)?\s*)\s*['']?(\d{2,4})\b/);
  if (gradMatch) {
    let year = parseInt(gradMatch[1]);
    if (year < 100) year += (year > (currentYear % 100) ? 1900 : 2000);
    // Assume graduated at ~22
    const age = currentYear - year + 22;
    if (age >= 13 && age <= 99) return age;
  }
  
  // Check emoji-based age hints
  if (/🎓/.test(text)) return 22; // Recent grad estimate
  
  // Check decade references: "90s kid", "millennial"
  if (/\b90s?\s*kid\b/.test(text)) return currentYear - 1993;
  if (/\b80s?\s*kid\b/.test(text)) return currentYear - 1985;
  if (/\bmillennial\b/.test(text)) return currentYear - 1990;
  if (/\bgen\s*z\b/.test(text)) return currentYear - 2000;
  if (/\bboomer\b/.test(text)) return currentYear - 1955;
  
  return null; // Cannot estimate
}

// ─── Helper: scrape profile stats from header (followers + posts) ───
// Instagram keeps changing the header markup, but the stat row itself is still
// visible. We therefore prioritize the visible stat row and only use meta tags
// as a fallback.
function scrapeProfileStatsFromHeader() {
  let followers = null;
  let posts = null;

  const tryParse = (raw) => (raw ? parseStatNumber(String(raw)) : null);

  const extractNumberFromElement = (el) => {
    if (!el) return null;

    const exactTitle = el.querySelector('span[title]')?.getAttribute('title') || el.getAttribute('title');
    const exactTitleNumber = tryParse(exactTitle);
    if (exactTitleNumber !== null) return exactTitleNumber;

    const ariaCandidates = [
      el.getAttribute('aria-label'),
      ...Array.from(el.querySelectorAll('[aria-label]')).map((node) => node.getAttribute('aria-label')),
    ].filter(Boolean);
    for (const candidate of ariaCandidates) {
      const parsed = tryParse(candidate);
      if (parsed !== null) return parsed;
    }

    const numericSpans = el.querySelectorAll('span');
    for (const span of numericSpans) {
      const raw = (span.getAttribute('title') || span.textContent || '').trim();
      if (/^\d[\d,.\s]*[kKmMbB]?$/.test(raw)) {
        const parsed = tryParse(raw);
        if (parsed !== null) return parsed;
      }
    }

    const textMatch = (el.textContent || '').match(/([\d][\d,.\s]*[kKmMbB]?)/);
    return textMatch ? tryParse(textMatch[1]) : null;
  };

  const headerEl =
    document.querySelector('main header') ||
    document.querySelector('header section') ||
    document.querySelector('header') ||
    document.body;

  if (!headerEl) return { followers, posts };

  // Strategy 1: read the visible stat row by item position.
  // On Instagram profiles the order is consistently: posts, followers, following.
  const statLists = Array.from(headerEl.querySelectorAll('ul')).filter((ul) => {
    const text = (ul.textContent || '').toLowerCase();
    return /post/.test(text) && /follower/.test(text);
  });

  for (const ul of statLists) {
    const items = Array.from(ul.children).filter((child) => /\d/.test(child.textContent || ''));
    if (items.length < 2) continue;

    for (const item of items) {
      const text = (item.textContent || '').toLowerCase();
      if (posts === null && text.includes('post')) {
        const parsed = extractNumberFromElement(item);
        if (parsed !== null) posts = parsed;
      }
      if (followers === null && text.includes('follower') && !text.includes('following')) {
        const parsed = extractNumberFromElement(item);
        if (parsed !== null) followers = parsed;
      }
    }

    // If labels are split across nested nodes and the text checks above fail,
    // fall back to the canonical position in the stat row.
    if (posts === null && items[0]) {
      const parsed = extractNumberFromElement(items[0]);
      if (parsed !== null) posts = parsed;
    }
    if (followers === null && items[1]) {
      const parsed = extractNumberFromElement(items[1]);
      if (parsed !== null) followers = parsed;
    }

    if (followers !== null && posts !== null) break;
  }

  // Strategy 2: direct followers anchor/button lookup.
  // Some layouts wrap the count in a clickable element without useful merged text.
  if (followers === null) {
    const followerControls = headerEl.querySelectorAll(
      'a[href*="/followers"], a[href*="/followers/"], button[aria-label*="followers" i], [role="link"][aria-label*="followers" i]'
    );
    for (const el of followerControls) {
      const parsed = extractNumberFromElement(el);
      if (parsed !== null) {
        followers = parsed;
        break;
      }
    }
  }

  // Strategy 3: labeled elements anywhere in the header.
  //
  // CRITICAL: only accept an element if it carries EXACTLY ONE of the stat
  // labels ("post" / "follower" / "following"). Previously this scan accepted
  // any element with "post" or "follower" in its text — which routinely
  // matched a PARENT element (header, stat row, or even <main>) that
  // contained the entire stat row text. extractNumberFromElement then returned
  // the same first numeric span for BOTH posts and followers, producing
  // matching values like "Followers: 149, Posts: 149" and bypassing the
  // post-count filter on accounts with 0 posts (because some other number
  // higher up the DOM was picked up).
  //
  // Restricting candidates to <li>, <a>, and <button> (the actual stat-item
  // shapes) avoids these wide parents. We also reject any candidate whose
  // text mentions more than one of the three labels.
  if (followers === null || posts === null) {
    const candidates = headerEl.querySelectorAll('li, a[href*="follower" i], a[href*="following" i], button[aria-label*="follower" i], button[aria-label*="post" i]');
    for (const el of candidates) {
      const text = (el.textContent || '').toLowerCase();
      if (!text || !/\d/.test(text)) continue;

      // Reject elements whose text spans more than one stat label —
      // they're a parent / wrapper, not a single stat item.
      const mentionsPost = /\bposts?\b/.test(text);
      const mentionsFollower = /\bfollowers\b/.test(text);
      const mentionsFollowing = /\bfollowing\b/.test(text);
      const labelHits = (mentionsPost ? 1 : 0) + (mentionsFollower ? 1 : 0) + (mentionsFollowing ? 1 : 0);
      if (labelHits !== 1) continue;

      if (followers === null && mentionsFollower) {
        const parsed = extractNumberFromElement(el);
        if (parsed !== null) followers = parsed;
      }
      if (posts === null && mentionsPost) {
        const parsed = extractNumberFromElement(el);
        if (parsed !== null) posts = parsed;
      }

      if (followers !== null && posts !== null) break;
    }
  }

  // Strategy 4: meta fallbacks if the SPA header has not painted yet.
  if (followers === null || posts === null) {
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    if (followers === null) {
      const fMatch = metaDesc.match(/([\d,.]+[kKmMbB]?)\s*Followers/i);
      if (fMatch) followers = tryParse(fMatch[1]);
    }
    if (posts === null) {
      const pMatch = metaDesc.match(/([\d,.]+[kKmMbB]?)\s*Posts/i);
      if (pMatch) posts = tryParse(pMatch[1]);
    }
  }

  if (followers === null || posts === null) {
    const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
    if (followers === null) {
      const fMatch = ogDesc.match(/([\d,.]+[kKmMbB]?)\s*Followers/i);
      if (fMatch) followers = tryParse(fMatch[1]);
    }
    if (posts === null) {
      const pMatch = ogDesc.match(/([\d,.]+[kKmMbB]?)\s*Posts/i);
      if (pMatch) posts = tryParse(pMatch[1]);
    }
  }

  return { followers, posts };
}

async function checkProfileDemographics() {
  // Wait for the profile header to actually render before reading stats.
  // Instagram is an SPA: the header can take 1–6s to populate on slow
  // connections or for high-follower accounts where IG's batch-stat
  // request takes longer. v2.4.137: extended from 8 × 500ms = 4s to
  // 16 × 500ms = 8s so we don't falsely report "unknown" and lose a
  // qualifying target to the upstream filter.
  let followers = null;
  let posts = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    await sleep(attempt === 0 ? 400 : 500);
    const stats = scrapeProfileStatsFromHeader();
    followers = stats.followers;
    posts = stats.posts;
    // We're satisfied as soon as BOTH followers and posts have a value
    // (or after the loop ends — partial data is still better than nothing).
    if (followers !== null && posts !== null) break;
  }

  // ── Display name + bio (used for gender/age estimation) ──
  let displayName = '';
  let bio = '';

  const headerSection = document.querySelector('header section') || document.querySelector('header');
  if (headerSection) {
    const spans = headerSection.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim() || '';
      if (text.length > 1 && text.length < 50 && !/^\d+$/.test(text) && !['Follow', 'Following', 'Message', 'Edit profile', 'Share profile'].includes(text)) {
        const parent = span.parentElement;
        if (parent && !parent.querySelector('h2') && !parent.closest('h2')) {
          displayName = text;
          break;
        }
      }
    }
  }

  const bioEl = document.querySelector('div[class*="biography"]')
    || document.querySelector('header section > div > span[dir="auto"]')
    || document.querySelector('header + div span[dir="auto"]');

  if (!bioEl) {
    const allSpans = document.querySelectorAll('header span[dir="auto"], main span[dir="auto"]');
    for (const span of allSpans) {
      const text = span.textContent?.trim() || '';
      if (text.length > 10 && text.length < 500 && !/^\d[\d,.kKmM]*$/.test(text)) {
        bio = text;
        break;
      }
    }
  } else {
    bio = bioEl.textContent?.trim() || '';
  }

  const pronounEl = document.querySelector('span[class*="pronoun"]')
    || Array.from(document.querySelectorAll('header span')).find(s => /^(he|she|they)\/(him|her|them|they)$/i.test(s.textContent?.trim() || ''));
  if (pronounEl) {
    bio = (bio + ' ' + pronounEl.textContent).trim();
  }

  const gender = estimateGender(displayName, bio);
  const age = estimateAge(displayName, bio);

  console.log(`[Demographics] Name: "${displayName}", Bio: "${bio?.substring(0, 60)}...", Gender: ${gender}, Age: ${age ?? 'unknown'}, Followers: ${followers ?? 'unknown'}, Posts: ${posts ?? 'unknown'}`);

  return { gender, age, displayName, bio: bio?.substring(0, 100), followers, posts };
}

// Helper to parse Instagram stat numbers like "1,234", "12.5K", "1.2M", "1234"
function parseStatNumber(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  if (!str) return null;
  // Match a number (optionally with thousands separators or a decimal) and an optional K/M/B suffix
  const match = str.match(/([\d][\d,.\s]*)\s*([kKmMbB])?/);
  if (!match) return null;

  // Strip commas AND whitespace (some locales render "1 234")
  const cleaned = match[1].replace(/[,\s]/g, '');
  let num = parseFloat(cleaned);
  if (isNaN(num)) return null;

  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') num *= 1000;
  else if (suffix === 'm') num *= 1000000;
  else if (suffix === 'b') num *= 1000000000;

  return Math.round(num);
}

// ─── EXTRACT COMMENTERS FROM CURRENT PAGE ───────────────────────────
// Scrolls through the COMMENT SECTION of the currently loaded post and returns commenter usernames
// Does NOT navigate — caller must ensure we're already on the post page
// IMPORTANT: Only scrolls within the comments panel, NOT the whole page (to avoid "More posts" section)
// Per-post background cache for commenters: same pattern as likers — surface
// first ~100 quickly, then keep paginating in the background so the next call
// can drain additional usernames without rescrolling from scratch.
if (typeof window.__futnorCommentersBatchCache === 'undefined') {
  window.__futnorCommentersBatchCache = new Map(); // postKey -> { seen:Set, queue:string[], done:boolean, running:boolean }
}
const COMMENTERS_FIRST_BATCH_TARGET = 100;

async function extractCommentersFromCurrentPage() {
  await refreshDMHistoryCache();
  const postOwnerCandidates = collectPostOwnerCandidates();

  // Wait for post content to settle
  await sleep(humanDelay(2000));
  
  // Check if comments are restricted or unavailable
  const pageText = document.body.innerText || '';
  if (/comments on this post have been limited/i.test(pageText) ||
      /comments are turned off/i.test(pageText) ||
      /no comments yet/i.test(pageText) ||
      /comments on this post are limited/i.test(pageText)) {
    console.log('[Human Behavior Bot] Comments restricted or unavailable on this post');
    return [];
  }

  // ── Drain background-paginated commenter cache from previous call (if any) ──
  const __commentersPostKey = (location.pathname || '').replace(/\/+$/, '');
  const __commentersCached = window.__futnorCommentersBatchCache.get(__commentersPostKey);
  const __preDrained = [];
  if (__commentersCached && __commentersCached.queue.length > 0) {
    console.log(`[Human Behavior Bot] extractCommenters: draining ${__commentersCached.queue.length} cached commenters from background batch`);
    for (const u of __commentersCached.queue.splice(0)) {
      const norm = normalizeUsername(u);
      const sessionVisited = norm ? visitedAccountsThisSession.has(norm) : false;
      const alreadyDmd = norm ? isInDMHistory(norm) : false;
      if (u && !postOwnerCandidates.has(u) && !sessionVisited && !alreadyDmd) {
        __preDrained.push(u);
      }
    }
    if (__commentersCached.done && __preDrained.length >= COMMENTERS_FIRST_BATCH_TARGET) {
      console.log(`[Human Behavior Bot] extractCommenters: returning ${__preDrained.length} from cache (background fully drained)`);
      return __preDrained;
    }
  }
  
  // ── Reel-specific pre-step: open the comments panel if we're on a /reel/ ──
  // Reels render the comment list in a side panel that's hidden until the
  // comment icon is clicked. Without this, all three container-detection
  // strategies below find nothing and we extract 0 commenters.
  const isReelPage = (window.location.pathname || '').startsWith('/reel/');
  if (isReelPage) {
    try {
      // Heuristic: panel isn't open if there are <3 profile links visible on page
      const visibleProfileLinks = document.querySelectorAll('main a[href^="/"], section a[href^="/"]').length;
      const commentBtnSelectors = [
        'svg[aria-label="Comment"]',
        'svg[aria-label="comments"]',
        'svg[aria-label*="comment" i]',
      ];
      let commentBtn = null;
      for (const sel of commentBtnSelectors) {
        const svg = document.querySelector(sel);
        if (svg) {
          commentBtn = svg.closest('button, a, div[role="button"], [tabindex="0"]') || svg.parentElement;
          if (commentBtn) break;
        }
      }
      if (commentBtn && visibleProfileLinks < 5) {
        console.log('[Human Behavior Bot] Reel detected — opening comments panel');
        try { await humanClick(commentBtn); } catch {}
        await sleep(humanDelay(2000));
      }
    } catch (e) {
      console.warn('[Human Behavior Bot] Reel comments panel open failed:', e);
    }
  }

  // Find the comments scrollable container — Instagram uses a specific scrollable div
  // On a post page (not modal), comments are in the right-side panel with overflow-y scroll/auto
  // On a modal, they're inside [role="dialog"]
  let commentsContainer = null;

  // Strategy 1: Find the article element that contains comments
  const article = document.querySelector('article[role="presentation"]') || document.querySelector('article');
  
  if (article) {
    // The comments section is typically a ul inside the article
    // Look for scrollable ancestors of comment lists within the article
    const uls = article.querySelectorAll('ul');
    for (const ul of uls) {
      // Walk up to find the scrollable parent (the comments panel)
      let el = ul.parentElement;
      while (el && el !== article) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
          commentsContainer = el;
          break;
        }
        el = el.parentElement;
      }
      if (commentsContainer) break;
    }
  }
  
  // Strategy 2: Dialog-based post view
  if (!commentsContainer) {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const divs = dialog.querySelectorAll('div');
      for (const div of divs) {
        const style = window.getComputedStyle(div);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && div.scrollHeight > div.clientHeight + 50) {
          // Make sure this div contains comment-like content (profile links)
          const hasProfileLinks = div.querySelectorAll('a[href^="/"]').length > 3;
          if (hasProfileLinks) {
            commentsContainer = div;
            break;
          }
        }
      }
    }
  }
  
  // Strategy 3: Look for any scrollable div containing a ul with profile links (post page layout)
  if (!commentsContainer) {
    const allDivs = document.querySelectorAll('main div, article div');
    for (const div of allDivs) {
      const style = window.getComputedStyle(div);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && div.scrollHeight > div.clientHeight + 50) {
        const profileLinks = div.querySelectorAll('a[href^="/"]');
        const hasCommentStructure = profileLinks.length >= 2;
        // Exclude very large containers (likely the whole page)
        if (hasCommentStructure && div.clientHeight < window.innerHeight * 0.9) {
          commentsContainer = div;
          break;
        }
      }
    }
  }

  // Strategy 4: Document-wide scrollable scan — catches reel comment panels and
  // any layout where comments aren't inside <article> or [role="dialog"].
  // Score candidates by profile-link density and pick the densest one.
  if (!commentsContainer) {
    const candidates = [];
    const allScrollable = document.querySelectorAll('div, section, aside');
    for (const el of allScrollable) {
      try {
        const style = window.getComputedStyle(el);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        if (el.scrollHeight <= el.clientHeight + 50) continue;
        if (el.clientHeight >= window.innerHeight * 0.95) continue; // skip page-sized scrollers
        const links = el.querySelectorAll('a[href^="/"]');
        let profileLinks = 0;
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          if (href.includes('/p/') || href.includes('/reel/') || href.includes('/explore') ||
              href.includes('/direct') || href.includes('/stories') || href.includes('/tags/') ||
              href.includes('/locations/')) continue;
          // Crude profile-link shape: /<handle>/ — at least one slug segment
          if (/^\/[A-Za-z0-9._]{1,30}\/?$/.test(href)) profileLinks++;
        }
        if (profileLinks >= 2) {
          candidates.push({ el, profileLinks });
        }
      } catch (_) {}
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.profileLinks - a.profileLinks);
      commentsContainer = candidates[0].el;
      console.log(`[Human Behavior Bot] Strategy 4: matched comments container with ${candidates[0].profileLinks} profile links`);
    }
  }

  console.log('[Human Behavior Bot] Comments container found:', !!commentsContainer,
    commentsContainer ? `(${commentsContainer.scrollHeight}px tall, ${commentsContainer.clientHeight}px visible)` : '');
  
  // Click "View all comments" links first (these appear before the full comment list)
  for (let round = 0; round < 5; round++) {
    const searchArea = commentsContainer || article || document;
    const viewAllBtns = Array.from(searchArea.querySelectorAll('a, button, span')).filter(el => {
      const text = (el.textContent || '').trim().toLowerCase();
      return (text.includes('view all') && text.includes('comment')) ||
             text.match(/^view all \d+ comments?$/);
    });

    if (viewAllBtns.length > 0) {
      // Click EVERY "View all comments" CTA we can see — heavy posts can have
      // multiple (one per nested thread), and clicking just the first one
      // capped extraction at the visible top-level comments only.
      console.log(`[Human Behavior Bot] Clicking ${viewAllBtns.length} "View all comments" CTA(s)...`);
      for (const candidate of viewAllBtns) {
        const btn = candidate.closest('a') || candidate.closest('button') || candidate;
        try { await humanClick(btn); } catch {}
        await sleep(humanDelay(900));
      }
      await sleep(humanDelay(1500));
      // After clicking, re-detect the container as DOM may have changed
      commentsContainer = null;
      const newArticle = document.querySelector('article[role="presentation"]') || document.querySelector('article');
      if (newArticle) {
        const uls2 = newArticle.querySelectorAll('ul');
        for (const ul of uls2) {
          let el = ul.parentElement;
          while (el && el !== newArticle) {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
              commentsContainer = el;
              break;
            }
            el = el.parentElement;
          }
          if (commentsContainer) break;
        }
      }
    } else {
      break;
    }
  }
  
  // Now scroll ONLY within the comments container to load more comments
  // Scroll aggressively: keep going until no new unique commenters are found for several rounds
  if (commentsContainer) {
    console.log('[Human Behavior Bot] Scrolling through comments panel aggressively...');
    // v2.4.148: bumped MAX_SCROLL_ROUNDS 60 → 120 and STALE_LIMIT 5 → 10
    // for high-volume posts. User reported the bot stopping early on a
    // 400+ commenter post. Each stale round waits 3-7s, so 10 stale
    // rounds = up to 70s of "no new commenters seen" before giving up,
    // which gives IG's lazy-loader enough headroom even on slow links.
    const MAX_SCROLL_ROUNDS = 120; // Upper safety cap
    let lastScrollTop = -1;
    let staleRounds = 0; // Rounds with no new unique commenters
    const STALE_LIMIT = 10; // Stop after this many consecutive rounds with no new usernames
    let knownUsernames = new Set();
    
    // Snapshot currently visible usernames
    const snapshotUsernames = () => {
      const links = commentsContainer.querySelectorAll('a[href^="/"]');
      let newCount = 0;
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes('/p/') || href.includes('/reel/') || href.includes('/explore') || 
            href.includes('/direct') || href.includes('/stories') || href.includes('/tags/') ||
            href.includes('/locations/')) continue;
        const username = parseInstagramUsernameFromHref(href);
        if (username && !knownUsernames.has(username)) {
          knownUsernames.add(username);
          newCount++;
        }
      }
      return newCount;
    };
    
    // Initial snapshot
    snapshotUsernames();
    
    let earlyExitedForBatch = false;
    for (let i = 0; i < MAX_SCROLL_ROUNDS; i++) {
      // ── EARLY-EXIT once we've surfaced the first batch ──
      if (knownUsernames.size >= COMMENTERS_FIRST_BATCH_TARGET) {
        earlyExitedForBatch = true;
        console.log(`[Human Behavior Bot] First batch reached (${knownUsernames.size} commenters) — returning now, background loop will continue paginating`);
        break;
      }

      // Scroll the comments container with larger jumps to go deeper faster
      const scrollAmount = randomInt(400, 800);
      commentsContainer.scrollTop += scrollAmount;
      await sleep(humanDelay(600));
      
      // Click "View more comments" / "Load more" buttons inside the container
      const moreBtns = Array.from(commentsContainer.querySelectorAll('button, span, li')).filter(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text.match(/view\s+\d+\s+more\s+(comments?|replies?)/) ||
               text.match(/load\s+more\s+comments?/) ||
               (text.includes('view') && text.includes('more') && text.includes('comment'));
      });
      for (const btn of moreBtns) {
        const clickTarget = btn.closest('button') || btn.closest('li') || btn;
        console.log('[Human Behavior Bot] Clicking load more comments:', clickTarget.textContent?.trim());
        await humanClick(clickTarget);
        await sleep(humanDelay(1500));
      }
      
      // Also look for "View replies" to expand reply threads
      const replyBtns = Array.from(commentsContainer.querySelectorAll('button, span')).filter(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text.match(/view\s+\d*\s*replies?/) || text.match(/view replies/);
      });
      if (replyBtns.length > 0 && Math.random() < 0.4) {
        const replyBtn = replyBtns[randomInt(0, replyBtns.length - 1)];
        await humanClick(replyBtn.closest('button') || replyBtn);
        await sleep(humanDelay(1200));
      }
      
      // Check if we found new unique usernames this round
      const newFound = snapshotUsernames();
      if (newFound === 0) {
        staleRounds++;
        // Wait longer between stale rounds to let Instagram load more comments
        const staleWait = 3000 + Math.random() * 4000; // 3-7 seconds
        console.log(`[Human Behavior Bot] No new commenters (stale round ${staleRounds}/${STALE_LIMIT}), waiting ${Math.round(staleWait/1000)}s for more to load...`);
        await sleep(staleWait);
        
        // Try scrolling more aggressively after waiting
        commentsContainer.scrollTop += randomInt(600, 1200);
        await sleep(humanDelay(1000));
        
        // Click any newly appeared "load more" buttons
        const lateBtns = Array.from(commentsContainer.querySelectorAll('button, span, li')).filter(el => {
          const text = (el.textContent || '').trim().toLowerCase();
          return text.match(/view\s+\d+\s+more\s+(comments?|replies?)/) ||
                 text.match(/load\s+more\s+comments?/) ||
                 (text.includes('view') && text.includes('more') && text.includes('comment'));
        });
        for (const btn of lateBtns) {
          await humanClick(btn.closest('button') || btn.closest('li') || btn);
          await sleep(humanDelay(2000));
        }
        
        // Re-check after waiting
        const afterWaitNew = snapshotUsernames();
        if (afterWaitNew > 0) {
          staleRounds = 0; // Found new ones after waiting!
          console.log(`[Human Behavior Bot] Found ${afterWaitNew} new commenters after waiting`);
        } else if (staleRounds >= STALE_LIMIT) {
          console.log(`[Human Behavior Bot] No new commenters for ${STALE_LIMIT} rounds — done scrolling (found ${knownUsernames.size} total)`);
          break;
        }
      } else {
        staleRounds = 0; // Reset stale counter when new usernames appear
      }
      
      // Check if we've reached the absolute bottom (scrollTop stopped increasing)
      if (commentsContainer.scrollTop === lastScrollTop && moreBtns.length === 0) {
        // Wait a bit before giving up — comments might still be loading
        await sleep(3000 + Math.random() * 2000);
        commentsContainer.scrollTop += randomInt(300, 600);
        await sleep(humanDelay(1500));
        if (commentsContainer.scrollTop === lastScrollTop) {
          console.log(`[Human Behavior Bot] Reached bottom of comments section (found ${knownUsernames.size} total)`);
          break;
        }
      }
      lastScrollTop = commentsContainer.scrollTop;
    }

    // ── Phase 2: BACKGROUND continuation if we early-exited ──
    if (earlyExitedForBatch) {
      const cacheEntry = window.__futnorCommentersBatchCache.get(__commentersPostKey) || { seen: new Set(), queue: [], done: false, running: false };
      for (const u of knownUsernames) cacheEntry.seen.add(u);
      window.__futnorCommentersBatchCache.set(__commentersPostKey, cacheEntry);

      if (!cacheEntry.running) {
        cacheEntry.running = true;
        // Fire-and-forget background pagination
        (async () => {
          try {
            let bgStale = 0;
            let bgLastScrollTop = lastScrollTop;
            // v2.4.148: bumped BG_MAX 50 → 200. Background pagination is
            // what surfaces deep commenters AFTER the foreground returned
            // its first batch. On a 400+ commenter post the prior 50-cycle
            // cap was leaving most commenters undiscovered.
            const BG_MAX = 200;
            for (let bg = 0; bg < BG_MAX && bgStale < STALE_LIMIT; bg++) {
              if (!document.body.contains(commentsContainer)) break;
              commentsContainer.scrollTop += randomInt(400, 800);
              await sleep(humanDelay(700));
              const moreBtnsBg = Array.from(commentsContainer.querySelectorAll('button, span, li')).filter(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                return t.match(/view\s+\d+\s+more\s+(comments?|replies?)/) ||
                       t.match(/load\s+more\s+comments?/) ||
                       (t.includes('view') && t.includes('more') && t.includes('comment'));
              });
              for (const btn of moreBtnsBg) {
                try { await humanClick(btn.closest('button') || btn.closest('li') || btn); } catch {}
                await sleep(humanDelay(1200));
              }

              let added = 0;
              for (const link of commentsContainer.querySelectorAll('a[href^="/"]')) {
                const href = link.getAttribute('href') || '';
                if (href.includes('/p/') || href.includes('/reel/') || href.includes('/explore') ||
                    href.includes('/direct') || href.includes('/stories') || href.includes('/tags/') ||
                    href.includes('/locations/')) continue;
                const username = parseInstagramUsernameFromHref(href);
                if (username && !cacheEntry.seen.has(username)) {
                  cacheEntry.seen.add(username);
                  cacheEntry.queue.push(username);
                  added++;
                }
              }

              if (added === 0 && commentsContainer.scrollTop === bgLastScrollTop) {
                bgStale++;
                await sleep(2000 + Math.random() * 2000);
              } else if (added === 0) {
                bgStale++;
                await sleep(humanDelay(1000));
              } else {
                bgStale = 0;
              }
              bgLastScrollTop = commentsContainer.scrollTop;
            }
            cacheEntry.done = true;
            console.log(`[Human Behavior Bot] extractCommenters (bg): paginated to ${cacheEntry.seen.size} total (${cacheEntry.queue.length} queued for next call)`);
          } catch (e) {
            console.warn('[Human Behavior Bot] extractCommenters background pagination error:', e);
          } finally {
            cacheEntry.running = false;
          }
        })();
      }
    }

    console.log(`[Human Behavior Bot] Finished scrolling — ${knownUsernames.size} unique usernames discovered (early-exit batch: ${earlyExitedForBatch})`);
  } else {
    console.log('[Human Behavior Bot] No scrollable comments container found, extracting visible comments only');
  }
  
  // Extract commenter usernames ONLY from the comments area (not "More posts" section)
  const commenters = new Set();
  const extractionArea = commentsContainer || article || document.querySelector('[role="dialog"]');
  
  if (extractionArea) {
    // Get all profile links within the comments area
    const links = extractionArea.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const commentContext = getCommentContextNode(link, extractionArea);
      if (!commentContext) continue;
      if (nodeContainsOwner(commentContext, postOwnerCandidates)) continue;

      const href = link.getAttribute('href') || '';
      // Skip non-profile links
      if (href.includes('/p/') || href.includes('/reel/') || href.includes('/explore') || 
          href.includes('/direct') || href.includes('/stories') || href.includes('/tags/') ||
          href.includes('/locations/')) {
        continue;
      }
      const username = parseInstagramUsernameFromHref(href);
      // For commenter extraction, only filter out accounts we've actually DM'd
      // (dm_history) or visited in the current session — NOT accounts that were
      // merely "processed" in a previous session, since timing/web-worker bugs
      // could have marked them processed without ever sending the DM. The
      // background script will still skip true DM-history matches at process time.
      const normalized = normalizeUsername(username);
      const sessionVisited = normalized ? visitedAccountsThisSession.has(normalized) : false;
      const alreadyDmd = normalized ? isInDMHistory(normalized) : false;
      if (username && !postOwnerCandidates.has(username) && !sessionVisited && !alreadyDmd) {
        commenters.add(username);
      }
    }
  }

  // Remove the post author from the list
  for (const authorUsername of postOwnerCandidates) {
    commenters.delete(authorUsername);
    console.log(`[Human Behavior Bot] Excluded post author @${authorUsername}`);
  }
  
  // Also exclude common Instagram system accounts
  commenters.delete('instagram');
  commenters.delete('explore');
  
  // Merge any usernames previously drained from the background cache
  for (const u of __preDrained) commenters.add(u);

  const result = Array.from(commenters);
  console.log(`[Human Behavior Bot] Extracted ${result.length} commenters (incl. ${__preDrained.length} from background cache)`);
  return result;
}

// Legacy wrapper for backward compatibility
async function extractCommentersFromPost(postUrl) {
  // If we're already on the post, just extract
  if (postUrl) {
    let normalizedPath = postUrl.replace('https://www.instagram.com', '');
    if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
    const currentPath = window.location.pathname.replace(/\/$/, '');
    const targetPath = normalizedPath.replace(/\/$/, '');
    if (!currentPath.includes(targetPath.split('/p/')[1]?.split('/')[0] || '__none__')) {
      // Not on the right post — return empty, let background handle navigation
      console.log('[Human Behavior Bot] Not on target post, returning empty (background should navigate first)');
      return [];
    }
  }
  return extractCommentersFromCurrentPage();
}

// ─────────────────────────────────────────────────────────────────────────
// POST-DM COMMENTING (v2.4.50+)
// After every successful DM, the bot leaves a personalized AI comment on the
// target's most recent post. Two helpers: getRecentPostContext() scrapes the
// post for AI input; postCommentOnCurrentPost() posts the AI-generated text.
// Both fail soft — never throw and never block the DM session if anything goes
// wrong (we'd rather lose a comment than abort an entire targeting run).
// ─────────────────────────────────────────────────────────────────────────

// Navigate to the most recent post on the currently-open profile and scrape
// the caption, primary image URL, and reel/post detection. Returns null if
// the profile has no posts, is private, or navigation failed.
async function getRecentPostContext() {
  try {
    // Must be on a profile page first.
    const isProfile = !!document.querySelector('header section')
      && !window.location.pathname.startsWith('/direct')
      && !window.location.pathname.startsWith('/p/')
      && !window.location.pathname.startsWith('/reel/');

    let postUrl = null;

    if (isProfile) {
      const link = await getRecentPostLink();
      if (!link) return null;
      postUrl = link;
      // Navigate to the post (in-page if possible). Use href set so IG SPA
      // handles routing without a full reload.
      window.location.href = postUrl;
      // Wait for the post page DOM (article + caption area) to render.
      for (let i = 0; i < 16; i++) {
        await sleep(400);
        if (document.querySelector('article')
          && (window.location.pathname.includes('/p/') || window.location.pathname.includes('/reel/'))) {
          break;
        }
      }
      await sleep(humanDelay(800));
    } else if (window.location.pathname.includes('/p/') || window.location.pathname.includes('/reel/')) {
      postUrl = window.location.href;
    } else {
      return null;
    }

    const isReel = window.location.pathname.includes('/reel/');

    // Caption: try the article's first long aria-labelled span / dir=auto block.
    let caption = '';
    try {
      const article = document.querySelector('article') || document;
      // Prefer the first <h1> (modern IG sometimes uses h1 for caption header)
      // then dir=auto spans inside the article (skip very short ones — those
      // are usually usernames, timestamps, or "Reply" buttons).
      const h1 = article.querySelector('h1');
      if (h1 && (h1.textContent || '').trim().length > 5) {
        caption = (h1.textContent || '').trim();
      }
      if (!caption) {
        const spans = article.querySelectorAll('span[dir="auto"], div[dir="auto"]');
        for (const sp of spans) {
          const txt = (sp.textContent || '').trim();
          if (txt.length >= 12 && txt.length <= 1500
            && !/^\d+\s*(likes?|views?|comments?)/i.test(txt)
            && !/^(reply|view replies|see translation|liked by)/i.test(txt)) {
            caption = txt;
            break;
          }
        }
      }
    } catch {}

    // Image URL: find the largest visible <img> inside the article that's NOT
    // the avatar (which lives in the header). Reels are <video> + poster — for
    // those we use the poster attribute when available.
    let imageUrl = '';
    try {
      const article = document.querySelector('article') || document;
      if (isReel) {
        const video = article.querySelector('video');
        const poster = video?.getAttribute('poster') || '';
        if (poster) imageUrl = poster;
      }
      if (!imageUrl) {
        const imgs = Array.from(article.querySelectorAll('img'))
          .filter((img) => {
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            const src = img.getAttribute('src') || '';
            // Skip avatars, emoji, and tiny thumbs.
            return src && !src.includes('s150x150') && !src.includes('profile_pic')
              && (w >= 200 || h >= 200);
          })
          .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
        if (imgs.length > 0) imageUrl = imgs[0].getAttribute('src') || '';
      }
    } catch {}

    return { postUrl, caption: caption.slice(0, 1200), imageUrl, isReel };
  } catch (e) {
    console.warn('[Human Behavior Bot] getRecentPostContext failed:', e?.message || e);
    return null;
  }
}

// Post a comment on the currently-open Instagram post/reel page. Tries
// textarea first (legacy posts), then contenteditable role=textbox (modern).
// Verifies the comment appears in the comment list before returning true.
async function postCommentOnCurrentPost(commentText) {
  const text = (commentText || '').toString().trim();
  if (!text) return false;
  if (!window.location.pathname.includes('/p/') && !window.location.pathname.includes('/reel/')) {
    console.warn('[Human Behavior Bot] postCommentOnCurrentPost: not on a post page');
    return false;
  }

  // ── Pre-comment HUMAN RITUAL ───────────────────────────────────────────────
  // Single biggest IG bot signal: arriving on a post and instantly typing.
  // Real people scroll down to see the image, dwell while reading the caption,
  // sometimes peek at existing comments, then start typing. We mimic that:
  //   1. Slow scroll down to the media (jittered, multiple small ticks).
  //   2. Dwell 3-9 seconds "looking" at the image / caption.
  //   3. ~50% chance: scroll a bit further to peek at top comments, dwell again.
  //   4. ~30% chance: scroll back up before opening the composer.
  // Wrapped in try/catch — any failure here MUST NOT block the comment.
  try {
    const ticks = randomInt(3, 7);
    for (let i = 0; i < ticks; i++) {
      window.scrollBy({ top: randomInt(120, 320), behavior: 'smooth' });
      await sleep(randomInt(220, 540));
    }
    // Dwell while "reading" the caption / looking at the media.
    await sleep(randomInt(3000, 9000));

    // Sometimes peek at existing comments before adding our own.
    if (Math.random() < 0.5) {
      const moreTicks = randomInt(2, 4);
      for (let i = 0; i < moreTicks; i++) {
        window.scrollBy({ top: randomInt(140, 280), behavior: 'smooth' });
        await sleep(randomInt(260, 620));
      }
      await sleep(randomInt(1800, 4500));
    }

    // Sometimes scroll back up (humans re-check the image before commenting).
    if (Math.random() < 0.3) {
      window.scrollBy({ top: -randomInt(200, 500), behavior: 'smooth' });
      await sleep(randomInt(800, 2000));
    }
  } catch {}

  // ── Helper: locate composer (Lexical contenteditable OR textarea) ──────────
  const findComposer = () => {
    return document.querySelector('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]')
      || document.querySelector('form textarea')
      || document.querySelector('[contenteditable="true"][aria-label*="comment" i]')
      || document.querySelector('[role="textbox"][aria-label*="comment" i]')
      || document.querySelector('form [contenteditable="true"][data-lexical-editor="true"]')
      || document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  };

  // ── Step 1: Wake up the comment input ──────────────────────────────────────
  // Some IG variants render only a placeholder div until a real interaction
  // expands the form, so we click the hint first and then re-query.
  let composer = null;
  for (let i = 0; i < 16 && !composer; i++) {
    composer = findComposer();
    if (!composer) {
      // If the placeholder is the trigger, click it
      const hint = document.querySelector('[aria-label*="Add a comment" i], span[aria-label*="comment" i]')
        || Array.from(document.querySelectorAll('div, span')).find((el) => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t === 'add a comment…' || t === 'add a comment...' || t === 'add a comment';
        });
      if (hint) { try { await humanClick(hint); } catch {} }
      await sleep(400);
    }
  }
  if (!composer) {
    console.warn('[Human Behavior Bot] postCommentOnCurrentPost: composer not found');
    return false;
  }

  composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(300));

  // ── Step 2: Activate the composer with a full pointer/mouse/click sequence
  // so Lexical sees an interaction it considers "real". Calling .focus() alone
  // is not enough — Lexical wires its handlers to pointerdown/mousedown.
  try {
    const rect = composer.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    composer.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    composer.dispatchEvent(new MouseEvent('mousedown', opts));
    composer.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    composer.dispatchEvent(new MouseEvent('mouseup', opts));
    composer.dispatchEvent(new MouseEvent('click', opts));
  } catch {}
  try { await humanClick(composer); } catch {}
  composer.focus({ preventScroll: true });
  await sleep(humanDelay(400));

  // Re-query in case clicking expanded the form into a different node
  composer = findComposer() || composer;

  const isTextarea = composer.tagName === 'TEXTAREA';
  const getComposerText = () => isTextarea ? (composer.value || '') : (composer.textContent || '').replace(/​/g, '');
  const composerHasText = () => getComposerText().trim().length > 0;

  // ── Step 3: Insert text — multiple methods until something sticks ──────────
  // Lexical's React state must reflect the new text or the Post button stays
  // disabled. We escalate: native value setter (textarea), execCommand,
  // direct DOM mutation + input event, paste/beforeinput, then char-by-char.

  const placeCaretAtEnd = () => {
    if (isTextarea) return;
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      let target = composer;
      while (target.lastChild) {
        target = target.lastChild;
        if (target.nodeType === Node.TEXT_NODE) break;
        if (target.nodeName === 'BR') {
          range.setStartBefore(target);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
      if (target.nodeType === Node.TEXT_NODE) {
        range.setStart(target, target.length);
        range.collapse(true);
      } else {
        range.selectNodeContents(composer);
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  };

  let inserted = false;

  // Method A: textarea (older IG layout) — uses the React-aware value setter.
  if (isTextarea) {
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, '');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      inserted = composerHasText();
    } catch (e) {
      console.warn('[Human Behavior Bot] comment Method A error:', e?.message || e);
    }
  }

  // Method B: execCommand('insertText') with explicit selection. Triggers a
  // browser-generated beforeinput which Lexical accepts on most builds.
  if (!inserted && !isTextarea) {
    try {
      composer.focus({ preventScroll: true });
      placeCaretAtEnd();
      try { document.execCommand('selectAll', false, null); } catch {}
      try { document.execCommand('delete', false, null); } catch {}
      const ok = document.execCommand('insertText', false, text);
      await sleep(400);
      inserted = composerHasText();
      if (!ok && !inserted) {
        console.log('[Human Behavior Bot] comment Method B: execCommand returned false');
      } else if (inserted) {
        console.log('[Human Behavior Bot] comment Method B: execCommand worked');
      }
    } catch (e) {
      console.warn('[Human Behavior Bot] comment Method B error:', e?.message || e);
    }
  }

  // Method C: direct DOM mutation + input event. Lexical's MutationObserver
  // syncs from DOM → EditorState; firing input afterwards triggers the
  // reconciler. Skips the isTrusted gate that beforeinput enforces.
  if (!inserted && !isTextarea) {
    try {
      composer.focus({ preventScroll: true });
      const para = composer.querySelector('p') || composer;
      const lines = text.split('\n');
      // Wipe any existing children then build one <p> per line
      while (composer.firstChild) composer.removeChild(composer.firstChild);
      for (let i = 0; i < lines.length; i++) {
        const p = document.createElement('p');
        p.textContent = lines[i] || '';
        composer.appendChild(p);
      }
      placeCaretAtEnd();
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false,
        inputType: 'insertText',
        data: text,
      }));
      composer.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true, cancelable: false, data: text,
      }));
      await sleep(500);
      inserted = composerHasText();
      if (inserted) console.log('[Human Behavior Bot] comment Method C: DOM mutation worked');
    } catch (e) {
      console.warn('[Human Behavior Bot] comment Method C error:', e?.message || e);
    }
  }

  // Method D: insertFromPaste beforeinput + ClipboardEvent. Lexical's paste
  // pipeline doesn't always require isTrusted on inputType=insertFromPaste.
  if (!inserted && !isTextarea) {
    try {
      composer.focus({ preventScroll: true });
      placeCaretAtEnd();
      const buildDT = () => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        dt.setData('text/html', text
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .split('\n').map((l) => `<p>${l || '<br>'}</p>`).join(''));
        return dt;
      };
      composer.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true,
        inputType: 'insertFromPaste',
        dataTransfer: buildDT(),
      }));
      await sleep(400);
      inserted = composerHasText();
      if (!inserted) {
        composer.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true,
          clipboardData: buildDT(),
        }));
        await sleep(500);
        inserted = composerHasText();
      }
      if (inserted) console.log('[Human Behavior Bot] comment Method D: paste worked');
    } catch (e) {
      console.warn('[Human Behavior Bot] comment Method D error:', e?.message || e);
    }
  }

  // Method E: char-by-char execCommand — slowest but most reliable on Lexical
  // because each character generates its own beforeinput event. We deliberately
  // type SLOWLY with realistic jitter, occasional "thinking" pauses, and a
  // rare typo+correction so the input cadence does not match a bot signature.
  // Real human typing speed is ~40-65 WPM (~180-280ms per keystroke); long
  // pauses between words are the strongest "this is a person" signal IG sees.
  if (!inserted && !isTextarea) {
    try {
      composer.focus({ preventScroll: true });
      try { document.execCommand('selectAll', false, null); } catch {}
      try { document.execCommand('delete', false, null); } catch {}

      // ~8% chance per character of a "thinking" pause (300-1400ms).
      // ~3% chance of a typo+backspace correction.
      const pickKey = (correct) => {
        // Pick a wrong key adjacent to the correct one (rough US-QWERTY).
        const map = {
          a: 'sq', s: 'awd', d: 'sef', e: 'wr', r: 'et', t: 'ry',
          o: 'ip', i: 'uo', n: 'bm', m: 'n', l: 'k', h: 'gj',
        };
        const c = (correct || '').toLowerCase();
        const opts = map[c];
        if (!opts) return correct;
        const ch = opts[Math.floor(Math.random() * opts.length)];
        return correct === c ? ch : ch.toUpperCase();
      };

      let lastWasSpace = false;
      for (let idx = 0; idx < text.length; idx++) {
        const ch = text[idx];
        if (document.activeElement !== composer && !composer.contains(document.activeElement)) {
          composer.focus({ preventScroll: true });
          await sleep(60);
        }

        // Rare typo + backspace correction (only on alpha chars, never first char).
        if (idx > 0 && /[a-z]/i.test(ch) && Math.random() < 0.03) {
          const wrong = pickKey(ch);
          document.execCommand('insertText', false, wrong);
          await sleep(180 + Math.floor(Math.random() * 220));
          // Realize mistake — pause then backspace.
          await sleep(220 + Math.floor(Math.random() * 380));
          document.execCommand('delete', false, null);
          await sleep(120 + Math.floor(Math.random() * 200));
        }

        if (ch === '\n') {
          document.execCommand('insertLineBreak', false, null)
            || document.execCommand('insertHTML', false, '<br>');
        } else {
          document.execCommand('insertText', false, ch);
        }

        // Base per-keystroke delay: 80-220ms with jitter.
        let delay = 80 + Math.floor(Math.random() * 140);
        // Spaces sometimes get a slightly longer rest (end of word).
        if (ch === ' ') delay += Math.floor(Math.random() * 120);
        // After punctuation, brief pause.
        if (/[.,!?]/.test(ch)) delay += 200 + Math.floor(Math.random() * 300);

        // ~8% chance of a "thinking" pause mid-message (300-1400ms).
        if (!lastWasSpace && Math.random() < 0.08) {
          delay += 300 + Math.floor(Math.random() * 1100);
        }

        lastWasSpace = (ch === ' ');
        await sleep(delay);
      }
      await sleep(400);
      inserted = composerHasText();
      if (inserted) console.log('[Human Behavior Bot] comment Method E: char-by-char (human cadence) worked');
    } catch (e) {
      console.warn('[Human Behavior Bot] comment Method E error:', e?.message || e);
    }
  }

  if (!inserted) {
    console.warn('[Human Behavior Bot] postCommentOnCurrentPost: every text-insertion method failed');
    return false;
  }
  console.log('[Human Behavior Bot] ✅ Comment text inserted — looking for Post button');

  // ── Step 4: Find the Post button — wait for it to enable ───────────────────
  // Lexical may take a beat to update React state from our insertion, so we
  // poll for an ENABLED Post button. We ALSO accept a button that is currently
  // disabled if its label clearly says "Post" — clicking it is harmless and
  // sometimes the disabled flag lags the actual click handler.
  const POST_LABELS = ['post', 'publicar', 'publier', 'posten', 'pubblica', 'publicar', 'опубликовать'];
  const isPostLabel = (txt) => {
    const t = (txt || '').toString().trim().toLowerCase();
    return POST_LABELS.includes(t);
  };

  const composerForm = composer.closest('form');
  const findPostBtn = ({ requireEnabled = true } = {}) => {
    const containers = composerForm ? [composerForm, document] : [document];
    for (const container of containers) {
      const buttons = container.querySelectorAll('button, div[role="button"], span[role="button"]');
      // Prefer enabled in earlier passes, accept disabled in later ones
      for (const btn of buttons) {
        if (!isPostLabel(btn.textContent)) continue;
        if (requireEnabled) {
          const aria = (btn.getAttribute('aria-disabled') || '').toLowerCase();
          if (aria === 'true' || btn.disabled) continue;
        }
        const rect = btn.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return btn;
      }
    }
    return null;
  };

  let postBtn = null;
  for (let i = 0; i < 16 && !postBtn; i++) {
    postBtn = findPostBtn({ requireEnabled: true });
    if (!postBtn) await sleep(300);
  }
  // Fall back to a disabled-but-labelled button if the enabled one never appeared
  if (!postBtn) postBtn = findPostBtn({ requireEnabled: false });

  if (!postBtn) {
    // Last-ditch attempt: requestSubmit() on the form (works on textarea variants)
    if (composerForm) {
      console.log('[Human Behavior Bot] No Post button found — trying form.requestSubmit()');
      try { composerForm.requestSubmit?.(); } catch {}
      await sleep(humanDelay(1200));
    } else {
      console.warn('[Human Behavior Bot] postCommentOnCurrentPost: Post button never appeared');
      return false;
    }
  } else {
    // ── Human "review before sending" pause ────────────────────────────────
    // People re-read what they typed before clicking Post. 1.5-4.2s is the
    // sweet spot: long enough to look natural, short enough not to time out.
    await sleep(1500 + Math.floor(Math.random() * 2700));
    console.log('[Human Behavior Bot] Clicking Post button...');
    try { postBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
    await sleep(150 + Math.floor(Math.random() * 250));
    try { await humanClick(postBtn); } catch {
      try { postBtn.click(); } catch {}
    }
    await sleep(humanDelay(1200));

    // If the button is still there and the composer still has text, click again
    // (some IG builds need the second click after the disabled flag clears).
    if (composerHasText()) {
      const stillBtn = findPostBtn({ requireEnabled: true }) || findPostBtn({ requireEnabled: false });
      if (stillBtn) {
        try { await humanClick(stillBtn); } catch { try { stillBtn.click(); } catch {} }
        await sleep(humanDelay(1200));
      }
    }
  }

  // Watch for action-blocked / comment-limit signals BEFORE counting it as
  // posted. If Instagram refuses the comment because the account hit the
  // comment rate limit, this returns failed=true and the bot stops.
  const verdict = await verifyCommentDeliveryAndSignal('postComment');
  if (verdict.failed) {
    console.warn(`[Human Behavior Bot] postCommentOnCurrentPost: blocked by Instagram (${verdict.reason}) — not counting`);
    return false;
  }

  // Verify the comment appears in the comments list.
  const lower = text.toLowerCase();
  const snippet = lower.length > 18 ? lower.slice(0, 18) : lower;
  for (let i = 0; i < 8; i++) {
    const allText = (document.body.innerText || '').toLowerCase();
    if (allText.includes(snippet)) {
      console.log('[Human Behavior Bot] ✅ Comment posted and verified');
      return true;
    }
    await sleep(400);
  }
  // Composer cleared after submit is also a valid success signal
  if (!composerHasText()) {
    console.log('[Human Behavior Bot] ✅ Comment posted (composer cleared)');
    return true;
  }
  console.warn('[Human Behavior Bot] postCommentOnCurrentPost: could not verify post');
  return false;
}

// Pure scrape (NO navigation) of the currently-loaded /p/ or /reel/ page.
// Returns { postUrl, caption, imageUrl, isReel } or null. Used by the
// post-DM commenting flow where the BACKGROUND drives navigation via
// chrome.tabs.update + navigateTabAndWait (so the content script context
// is fresh and message channels survive). NEVER navigates here — calling
// window.location.href = ... would tear down this content script and the
// in-flight sendResponse, which is the exact bug we are fixing.
async function extractPostContext() {
  try {
    const path = window.location.pathname;
    if (!path.includes('/p/') && !path.includes('/reel/')) {
      console.warn('[Human Behavior Bot] extractPostContext: not on a post page:', path);
      return null;
    }

    // IG does not always mount post/reel content inside <article>. Some layouts
    // use role=main / main / section wrappers first, especially on reels.
    const getPostRoot = () => {
      const candidates = [
        document.querySelector('article'),
        document.querySelector('main[role="main"]'),
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('section'),
        document.body,
      ].filter(Boolean);

      return candidates.find((root) => {
        if (!(root instanceof HTMLElement)) return false;
        const hasMedia = !!root.querySelector('video, img');
        const hasCommentUi = !!root.querySelector(
          'textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], [role="textbox"][aria-label*="comment" i], [contenteditable="true"][aria-label*="comment" i], form textarea'
        );
        return hasMedia || hasCommentUi || root.tagName === 'ARTICLE';
      }) || null;
    };

    let root = getPostRoot();
    for (let i = 0; i < 16 && !root; i++) {
      await sleep(400);
      root = getPostRoot();
    }
    if (!root) {
      console.warn('[Human Behavior Bot] extractPostContext: post root never appeared');
      return null;
    }
    await sleep(humanDelay(500));

    const isReel = path.includes('/reel/');
    const postUrl = window.location.href;

    // Caption — prefer h1, then long dir=auto text blocks inside the detected root.
    let caption = '';
    try {
      const h1 = root.querySelector('h1');
      if (h1 && (h1.textContent || '').trim().length > 5) {
        caption = (h1.textContent || '').trim();
      }
      if (!caption) {
        const spans = root.querySelectorAll('span[dir="auto"], div[dir="auto"], h2, h3');
        for (const sp of spans) {
          const txt = (sp.textContent || '').trim();
          if (txt.length >= 12 && txt.length <= 1500
            && !/^\d+\s*(likes?|views?|comments?)/i.test(txt)
            && !/^(reply|view replies|see translation|liked by|follow|following|message)/i.test(txt)) {
            caption = txt;
            break;
          }
        }
      }
    } catch {}

    // Image/video poster — choose the largest likely content media, not avatars.
    let imageUrl = '';
    try {
      if (isReel) {
        const video = root.querySelector('video') || document.querySelector('video');
        const poster = video?.getAttribute('poster') || '';
        if (poster) imageUrl = poster;
      }
      if (!imageUrl) {
        const imgs = Array.from(root.querySelectorAll('img'))
          .filter((img) => {
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            const src = img.getAttribute('src') || '';
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            return src
              && !src.includes('s150x150')
              && !src.includes('profile_pic')
              && !alt.includes('profile picture')
              && !alt.includes('avatar')
              && (w >= 200 || h >= 200);
          })
          .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
        if (imgs.length > 0) imageUrl = imgs[0].getAttribute('src') || '';
      }
    } catch {}

    return { postUrl, caption: caption.slice(0, 1200), imageUrl, isReel };
  } catch (e) {
    console.warn('[Human Behavior Bot] extractPostContext failed:', e?.message || e);
    return null;
  }
}

// Get the URL of the first/recent post from the currently viewed profile
async function getRecentPostLink() {
  const isProfile = document.querySelector('header section') && !window.location.pathname.startsWith('/direct');
  if (!isProfile) return null;
  
  // Check if profile is private
  const privateIndicators = Array.from(document.querySelectorAll('h2, span, div')).filter(el => {
    const text = (el.textContent || '').toLowerCase();
    return text.includes('this account is private') || text.includes('private account');
  });
  if (privateIndicators.length > 0) {
    console.log('[Human Behavior Bot] Private account — no posts accessible');
    return null;
  }
  
  // Find the first post link
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  if (postLinks.length === 0) {
    console.log('[Human Behavior Bot] No posts found on profile');
    return null;
  }
  
  const firstPost = postLinks[0];
  const href = firstPost.getAttribute('href');
  if (href) {
    const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
    console.log(`[Human Behavior Bot] Found recent post: ${fullUrl}`);
    return fullUrl;
  }
  
  return null;
}

// Check if current profile is accessible (not private, not restricted)
async function isProfileAccessible() {
  // Wait for profile DOM to settle (was 500ms — too short, header sometimes not rendered)
  await sleep(humanDelay(1200));

  // Make sure we're actually on a profile page
  const isProfilePage = !!document.querySelector('header section') && !window.location.pathname.startsWith('/direct');
  if (!isProfilePage) {
    // Give it one more chance to load
    await sleep(humanDelay(800));
  }

  const allText = (document.body.innerText || '').toLowerCase();

  // Multi-language private account detection
  const privatePhrases = [
    'this account is private',
    'this profile is private',
    'private account',
    'esta cuenta es privada',           // Spanish
    'cuenta privada',
    'ce compte est privé',              // French
    'compte privé',
    'questo account è privato',         // Italian
    'dieses konto ist privat',          // German
    'esta conta é privada',             // Portuguese
    'conta privada',
    'هذا الحساب خاص',                    // Arabic
    'このアカウントは非公開です',          // Japanese
    '비공개 계정입니다',                    // Korean
    '此账户为私密账户',                    // Chinese (simplified)
    '此帳號不公開',                        // Chinese (traditional)
    'аккаунт закрыт',                   // Russian
    'закрытый аккаунт',
    'bu hesap gizli',                   // Turkish
  ];
  for (const phrase of privatePhrases) {
    if (allText.includes(phrase)) {
      return { accessible: false, reason: 'private' };
    }
  }

  // Structural detection: Instagram private profiles show a "Follow" button + a lock icon
  // and DO NOT render any post links in the grid. If we see a profile header, no posts,
  // AND a Follow button (meaning we're not following), strongly suspect private.
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  const lockIcon = document.querySelector('svg[aria-label*="rivate" i], svg[aria-label*="ock" i]');
  if (lockIcon && postLinks.length === 0) {
    return { accessible: false, reason: 'private' };
  }

  // Check for restricted/suspended/not found (multi-language)
  const notFoundPhrases = [
    "user not found",
    "sorry, this page isn't available",
    "sorry, this page isn",
    "page not found",
    "lo sentimos, esta página no está disponible",
    "désolé, cette page n'est pas disponible",
    "diese seite ist leider nicht verfügbar",
    "questa pagina non è disponibile",
    "esta página não está disponível",
  ];
  for (const phrase of notFoundPhrases) {
    if (allText.includes(phrase)) {
      return { accessible: false, reason: 'not_found' };
    }
  }

  // Check for no posts (profile exists but has no public posts to engage with)
  if (postLinks.length === 0) {
    return { accessible: true, reason: 'no_posts' };
  }

  return { accessible: true, reason: 'ok' };
}

// ─── WARMUP-SPECIFIC ACTIONS ───────────────────────────────

// Set to track engaged post URLs during this warmup session
const warmupEngagedPosts = new Set();

// Helper: navigate via SPA link click, fallback to location change + wait
async function warmupNavigateTo(path, linkSelector, ariaLabel) {
  if (window.location.pathname.startsWith(path)) return true;

  const link = linkSelector ? document.querySelector(linkSelector) : null;
  const ariaLink = !link && ariaLabel
    ? document.querySelector(`svg[aria-label="${ariaLabel}"]`)?.closest('a')
    : null;
  const target = link || ariaLink;

  if (target) {
    await humanClick(target);
    await sleep(humanDelay(2500));
    return true;
  }

  return { needsTabNavigation: true, url: `https://www.instagram.com${path}` };
}

// Helper: ensure we're on the home feed for feed-dependent actions
async function ensureHomeFeed() {
  if (window.location.pathname === '/') return true;
  const homeLink = document.querySelector('a[href="/"]')
    || document.querySelector('svg[aria-label="Home"]')?.closest('a');
  if (homeLink) {
    await humanClick(homeLink);
    await sleep(humanDelay(2000));
    return true;
  }
  return { needsTabNavigation: true, url: 'https://www.instagram.com/' };
}

// ─── WARMUP FEED: Human-like feed browsing with post engagement ───
async function warmupFeed() {
  const nav = await ensureHomeFeed();
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
  await sleep(humanDelay(1000));

  let scrollPasses = randomInt(3, 6);
  let liked = 0;
  let commentsRead = 0;
  let postsOpened = 0;

  for (let pass = 0; pass < scrollPasses; pass++) {
    // Scroll a bit
    await performScroll();
    await sleep(randomInt(800, 2000));

    // Find visible posts
    const posts = Array.from(document.querySelectorAll('article')).filter(p => {
      const rect = p.getBoundingClientRect();
      return rect.top >= -50 && rect.top < window.innerHeight;
    });

    for (const post of posts) {
      // Get post URL to check if already engaged
      const postLink = post.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      const postUrl = postLink?.getAttribute('href');
      if (postUrl && warmupEngagedPosts.has(postUrl)) continue;

      // ~35% chance to engage with a visible post
      if (Math.random() > 0.35) continue;

      if (postUrl) warmupEngagedPosts.add(postUrl);
      postsOpened++;

      // Scroll post into center view like a human stopping to look
      post.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(randomInt(1200, 3000)); // dwell time — reading caption

      // ~50% chance to read comments
      if (Math.random() < 0.5) {
        const commentIcon = post.querySelector('svg[aria-label="Comment"]');
        if (commentIcon) {
          const btn = commentIcon.closest('button') || commentIcon.parentElement;
          await humanClick(btn);
          await sleep(humanDelay(1500));

          const commentArea = document.querySelector('[role="dialog"] ul')
            || document.querySelector('ul[class*="comment"], div[class*="comment"]');

          if (commentArea) {
            const passes = randomInt(2, 5);
            for (let s = 0; s < passes; s++) {
              commentArea.scrollTop += randomInt(80, 200);
              await sleep(randomInt(700, 1800)); // reading each comment
            }
            commentsRead++;
          }

          await sleep(randomInt(800, 2000));

          // Close comment modal
          const closeBtn = document.querySelector('[role="dialog"] svg[aria-label="Close"]');
          if (closeBtn) {
            await humanClick(closeBtn.closest('button') || closeBtn);
            await sleep(humanDelay(500));
          } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(humanDelay(500));
          }
        }
      }

      // ~30% chance to like the post
      if (Math.random() < 0.3) {
        const likeBtn = post.querySelector('svg[aria-label="Like"]');
        if (likeBtn) {
          const clickable = likeBtn.closest('button') || likeBtn.parentElement;
          await humanClick(clickable);
          liked++;
          await sleep(humanDelay(600));
        }
      }

      // Small pause before continuing scroll
      await sleep(randomInt(500, 1500));
      // Only engage 1-2 posts per scroll pass
      if (postsOpened >= randomInt(1, 2)) break;
    }

    // Occasional scroll back up (re-reading behavior)
    if (Math.random() < 0.12) {
      window.scrollBy({ top: -randomInt(100, 300), behavior: 'smooth' });
      await sleep(randomInt(1000, 2500));
    }
  }

  const parts = [`${scrollPasses} scrolls`];
  if (postsOpened > 0) parts.push(`${postsOpened} posts viewed`);
  if (liked > 0) parts.push(`${liked} liked`);
  if (commentsRead > 0) parts.push(`${commentsRead} comments read`);
  return { success: true, label: `📜 Feed: ${parts.join(', ')}` };
}

async function warmupExplore() {
  const nav = await warmupNavigateTo('/explore', 'a[href="/explore/"]', 'Explore');
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;

  await sleep(humanDelay(1500));

  // Scroll to load content
  const initialScrolls = randomInt(1, 3);
  for (let i = 0; i < initialScrolls; i++) {
    await performScroll();
    await sleep(randomInt(800, 1800));
  }

  // Find clickable post thumbnails in the explore grid (skip already engaged)
  const allPostLinks = Array.from(
    document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')
  ).filter(a => {
    const rect = a.getBoundingClientRect();
    const href = a.getAttribute('href');
    return rect.top >= 0 && rect.bottom <= window.innerHeight + 200 && rect.width > 50
      && (!href || !warmupEngagedPosts.has(href));
  });

  const postsToOpen = Math.min(randomInt(3, 5), allPostLinks.length);
  let liked = 0;
  let commentsRead = 0;
  let opened = 0;

  for (let i = 0; i < postsToOpen; i++) {
    const link = allPostLinks[randomInt(0, allPostLinks.length - 1)];
    if (!link) continue;
    const href = link.getAttribute('href');
    if (href) warmupEngagedPosts.add(href);

    // Scroll thumbnail into view
    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(600));

    // Click to open the post modal
    await humanClick(link);
    await sleep(humanDelay(1500));
    opened++;

    // Wait for modal/dialog to appear
    const modal = document.querySelector('[role="dialog"]');

    if (modal) {
      // Dwell — look at the post like a human
      await sleep(randomInt(1500, 4000));

      // ~50% chance to read comments in the modal
      if (Math.random() < 0.5) {
        const commentSection = modal.querySelector('ul') || modal.querySelector('[class*="comment"]');
        if (commentSection) {
          const scrollSteps = randomInt(2, 4);
          for (let s = 0; s < scrollSteps; s++) {
            commentSection.scrollTop += randomInt(80, 200);
            await sleep(randomInt(600, 1400));
          }
          commentsRead++;
        }
      }

      // ~40% chance to like the post
      if (Math.random() < 0.4) {
        const likeBtn = modal.querySelector('svg[aria-label="Like"]');
        if (likeBtn) {
          const clickable = likeBtn.closest('button') || likeBtn.parentElement;
          if (clickable) {
            await humanClick(clickable);
            liked++;
            await sleep(humanDelay(600));
          }
        }
      }

      // Close modal — press Escape or click close button
      const closeBtn = modal.querySelector('svg[aria-label="Close"]')?.closest('button');
      if (closeBtn) {
        await humanClick(closeBtn);
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      await sleep(humanDelay(800));
    }

    // Small scroll between posts
    if (i < postsToOpen - 1) {
      await performScroll();
      await sleep(randomInt(600, 1500));
    }
  }

  // Final scroll
  if (Math.random() < 0.6) {
    await performScroll();
    await sleep(randomInt(500, 1200));
  }

  const parts = [`${opened} posts viewed`];
  if (liked > 0) parts.push(`${liked} liked`);
  if (commentsRead > 0) parts.push(`${commentsRead} comments read`);
  return { success: true, label: `🔍 Explored: ${parts.join(', ')}` };
}

function getVisibleViewportArea(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return 0;
  const rect = el.getBoundingClientRect();
  const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
  return visibleWidth * visibleHeight;
}

function isScrollableCandidate(el) {
  return !!el && typeof el.scrollHeight === 'number' && typeof el.clientHeight === 'number' && el.scrollHeight > el.clientHeight + 120;
}

function getVisibleReelVideos(limit = 4) {
  const root = document.querySelector('main') || document.body;
  const videos = root.querySelectorAll('article video, section video, video');
  const matches = [];

  for (let i = 0; i < videos.length && matches.length < limit; i++) {
    const video = videos[i];
    if (video.readyState >= 1 && getVisibleViewportArea(video) > 0) {
      matches.push(video);
    }
  }

  return matches;
}

function getActiveReelRoot() {
  const probePoints = [0.4, 0.5, 0.6];

  for (const factor of probePoints) {
    const probe = document.elementFromPoint(window.innerWidth * 0.5, window.innerHeight * factor);
    const candidate = probe?.closest('article, section, [role="dialog"], main');
    if (candidate && getVisibleViewportArea(candidate) > window.innerWidth * window.innerHeight * 0.05) {
      return candidate;
    }
  }

  const root = document.querySelector('main') || document.body;
  const containers = root.querySelectorAll('article, section');
  for (let i = 0; i < containers.length && i < 8; i++) {
    const candidate = containers[i];
    if (candidate.querySelector('video') && getVisibleViewportArea(candidate) > 0) {
      return candidate;
    }
  }

  const fallbackVideo = getVisibleReelVideos(1)[0];
  return fallbackVideo?.closest('article, section, main') || document.querySelector('main');
}

function getReelFocusNode() {
  return getVisibleReelVideos(1)[0]
    || getActiveReelRoot()
    || document.querySelector('main');
}

function getActiveReelVideo(reelRoot = getActiveReelRoot()) {
  return reelRoot?.querySelector('video')
    || getVisibleReelVideos(1)[0]
    || document.querySelector('main video')
    || document.querySelector('video');
}

function getReelScrollOffset(scroller) {
  return typeof scroller?.scrollTop === 'number' ? scroller.scrollTop : window.scrollY;
}

function getActiveReelSignature() {
  const reelRoot = getActiveReelRoot();
  const reelLink = reelRoot?.querySelector('a[href*="/reel/"]');
  const reelVideo = getActiveReelVideo(reelRoot);
  const poster = reelVideo?.getAttribute('poster');
  const videoSrc = reelVideo?.currentSrc || reelVideo?.src;
  const ariaLabel = reelRoot?.getAttribute('aria-label');
  const scrollOffset = Math.round(getReelScrollOffset(getPrimaryReelScroller(true)) / 60);

  return reelLink?.href || poster || videoSrc || ariaLabel || `${window.location.pathname}:${scrollOffset}`;
}

function getPrimaryReelScroller(skipRootLookup = false) {
  let current = skipRootLookup
    ? (getActiveReelVideo()?.closest('article, section, main') || document.querySelector('main'))
    : getActiveReelRoot();

  while (current && current !== document.body) {
    if (isScrollableCandidate(current) && getVisibleViewportArea(current) > 0) {
      return current;
    }
    current = current.parentElement;
  }

  const main = document.querySelector('main');
  if (isScrollableCandidate(main)) return main;

  return document.scrollingElement || document.documentElement || document.body;
}

function scrollReelContainer(scroller, deltaY) {
  try {
    if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
      window.scrollBy({ top: deltaY, behavior: 'auto' });
      return;
    }

    if (typeof scroller?.scrollBy === 'function') {
      scroller.scrollBy({ top: deltaY, behavior: 'auto' });
      return;
    }

    if (typeof scroller?.scrollTop === 'number') {
      scroller.scrollTop += deltaY;
    }
  } catch {}
}

function dispatchReelKeyScroll(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
}

async function nudgeReelContainerHumanly(scroller, totalDeltaY) {
  const steps = randomInt(2, 4);
  let moved = 0;

  for (let i = 0; i < steps; i++) {
    const remaining = totalDeltaY - moved;
    const stepDelta = i === steps - 1
      ? remaining
      : Math.round(totalDeltaY / steps + (Math.random() - 0.5) * 60);

    moved += stepDelta;
    scrollReelContainer(scroller, stepDelta);
    await sleep(randomInt(90, 170));
  }
}

function hasReelMoved(previousSignature, previousOffset, scroller) {
  const currentSignature = getActiveReelSignature();
  if (currentSignature && previousSignature && currentSignature !== previousSignature) {
    return true;
  }

  return Math.abs(getReelScrollOffset(scroller) - previousOffset) > Math.max(120, Math.round(window.innerHeight * 0.18));
}

async function waitForReelAdvance(previousSignature, previousOffset, scroller, timeoutMs = 1200) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(300);
    if (hasReelMoved(previousSignature, previousOffset, scroller)) {
      return true;
    }
  }

  return hasReelMoved(previousSignature, previousOffset, scroller);
}

async function advanceReelHumanly() {
  const scroller = getPrimaryReelScroller();
  const before = getActiveReelSignature();
  const beforeOffset = getReelScrollOffset(scroller);

  const deltas = [
    Math.round(window.innerHeight * (0.86 + Math.random() * 0.1)),
    Math.round(window.innerHeight * (0.58 + Math.random() * 0.08)),
  ];

  for (const deltaY of deltas) {
    await nudgeReelContainerHumanly(scroller, deltaY);
    if (await waitForReelAdvance(before, beforeOffset, scroller, 1100)) {
      return true;
    }
    await sleep(randomInt(200, 380));
  }

  dispatchReelKeyScroll('ArrowDown');
  return waitForReelAdvance(before, beforeOffset, scroller, 1200);
}

async function sleepInChunks(totalMs) {
  let remaining = totalMs;
  while (remaining > 0) {
    const chunk = Math.min(remaining, randomInt(450, 900));
    await sleep(chunk);
    remaining -= chunk;
  }
}

async function likeActiveReel() {
  const reelRoot = getActiveReelRoot();
  const scopes = [reelRoot, document].filter(Boolean);
  const selectors = [
    'button[aria-label="Like"]',
    'div[role="button"][aria-label="Like"]',
    'svg[aria-label="Like"]',
  ];

  for (const scope of scopes) {
    for (const selector of selectors) {
      const rawTarget = scope.querySelector(selector);
      const target = selector.startsWith('svg')
        ? rawTarget?.closest('button, div[role="button"]')
        : rawTarget;

      if (target && getVisibleViewportArea(target) > 0) {
        await humanClick(target);
        await sleep(humanDelay(350));
        return true;
      }
    }
  }

  return false;
}

async function warmupReels() {
  const nav = await warmupNavigateTo('/reels', 'a[href="/reels/"]', 'Reels');
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;

  await sleep(humanDelay(1200));

  let watchedCount = 0;
  let likesGiven = 0;
  let failedAdvances = 0;
  const reelsToWatch = randomInt(5, 10);
  const batchStartedAt = Date.now();

  for (let i = 0; i < reelsToWatch; i++) {
    if (!getActiveReelRoot() && !getActiveReelVideo()) {
      return { success: false, stalled: true, label: '🎬 Reels did not load cleanly' };
    }

    if (Date.now() - batchStartedAt > 75000) {
      return watchedCount > 0
        ? { success: true, label: `🎬 Watched ${watchedCount} reels${likesGiven > 0 ? ` (liked ${likesGiven})` : ''}` }
        : { success: false, stalled: true, label: '🎬 Reels stayed too heavy to warm up safely' };
    }

    const roll = Math.random();
    let watchTime = 0;
    let likeProbability = 0;

    if (roll < 0.34) {
      watchTime = randomInt(900, 1900);
      likeProbability = 0.02;
    } else if (roll < 0.74) {
      watchTime = randomInt(2400, 4200);
      likeProbability = 0.06;
    } else if (roll < 0.93) {
      watchTime = randomInt(4800, 7200);
      likeProbability = 0.13;
    } else {
      watchTime = randomInt(7800, 9800);
      likeProbability = 0.2;
    }

    const splitPoint = Math.max(700, Math.floor(watchTime * (0.42 + Math.random() * 0.12)));
    await sleepInChunks(splitPoint);

    if (roll > 0.56 && Math.random() < likeProbability) {
      const liked = await likeActiveReel();
      if (liked) likesGiven++;
    }

    await sleepInChunks(Math.max(350, watchTime - splitPoint));
    watchedCount++;

    if (i === reelsToWatch - 1) {
      break;
    }

    if (roll < 0.2) {
      await sleep(randomInt(100, 260));
    } else if (Math.random() < 0.1) {
      await sleep(randomInt(500, 1000));
    }

    const advanced = await advanceReelHumanly();
    if (!advanced) {
      failedAdvances++;
      if (failedAdvances >= 2) {
        return {
          success: false,
          stalled: true,
          label: watchedCount > 0
            ? `🎬 Reels stalled after ${watchedCount} reels${likesGiven > 0 ? ` (liked ${likesGiven})` : ''}`
            : '🎬 Reels stalled before advancing',
        };
      }
      await sleep(randomInt(300, 600));
      continue;
    }

    failedAdvances = 0;
    await sleep(randomInt(160, 360));
  }

  if (watchedCount > 0) {
    return { success: true, label: `🎬 Watched ${watchedCount} reels${likesGiven > 0 ? ` (liked ${likesGiven})` : ''}` };
  }

  return { success: false, label: '🎬 Reels failed to advance' };
}

// ─── Passive warmup: check notifications page (just view, no actions) ───
async function warmupCheckNotifications() {
  const nav = await warmupNavigateTo(
    '/notifications',
    'a[href="/notifications/"]',
    'Notifications'
  );
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
  await sleep(humanDelay(1800));
  const scrollSteps = randomInt(2, 5);
  for (let i = 0; i < scrollSteps; i++) {
    window.scrollBy({ top: randomInt(180, 380), behavior: 'smooth' });
    await sleep(humanDelay(900 + Math.random() * 1500));
  }
  return { success: true, label: '🔔 Checked notifications' };
}

// ─── Passive warmup: open DM inbox and browse (no DMs sent) ───
async function warmupCheckInbox() {
  const nav = await warmupNavigateTo(
    '/direct/inbox',
    'a[href="/direct/inbox/"]',
    'Messenger'
  );
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
  await sleep(humanDelay(2200));
  const previews = document.querySelectorAll(
    'a[href*="/direct/t/"], a[href*="/direct/partnerships/t/"], a[href*="/direct/requests/t/"]'
  );
  const visited = Math.min(previews.length, randomInt(0, 3));
  for (let i = 0; i < visited; i++) {
    try {
      previews[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(humanDelay(900 + Math.random() * 1800));
      previews[i].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    } catch {}
  }
  for (let i = 0; i < randomInt(1, 3); i++) {
    window.scrollBy({ top: randomInt(100, 280), behavior: 'smooth' });
    await sleep(humanDelay(800 + Math.random() * 1400));
  }
  return { success: true, label: '📥 Checked DM inbox' };
}

// ─── Passive warmup: browse search using niche keywords if available ───
async function warmupBrowseSearch(nicheKeywords) {
  const nav = await warmupNavigateTo(
    '/explore',
    'a[href="/explore/"]',
    'Search'
  );
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
  await sleep(humanDelay(1500));

  const term = (Array.isArray(nicheKeywords) && nicheKeywords.length > 0)
    ? nicheKeywords[randomInt(0, nicheKeywords.length - 1)]
    : null;

  if (term) {
    const searchInput = document.querySelector(
      'input[placeholder*="Search" i], input[aria-label*="Search" i], input[type="text"]'
    );
    if (searchInput) {
      searchInput.focus();
      for (const ch of String(term).slice(0, 32)) {
        searchInput.value += ch;
        searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
        await sleep(randomInt(60, 180));
      }
      await sleep(humanDelay(1500));
      // Don't actually submit — humans often type and just look at suggestions.
      if (Math.random() < 0.5) searchInput.blur();
      await sleep(humanDelay(1200 + Math.random() * 2000));
      return { success: true, label: `🔍 Searched "${term}"` };
    }
  }

  for (let i = 0; i < randomInt(2, 4); i++) {
    window.scrollBy({ top: randomInt(220, 460), behavior: 'smooth' });
    await sleep(humanDelay(1100 + Math.random() * 1800));
  }
  return { success: true, label: '🔍 Browsed explore' };
}

async function warmupStory() {
  // Must be on homepage to see story tray
  const nav = await ensureHomeFeed();
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
  await sleep(humanDelay(1000));

  // Click a story circle at the top
  const storyButtons = document.querySelectorAll('canvas, div[role="button"] img[alt*="profile"], button[aria-label*="Story"]');
  const stories = Array.from(storyButtons).filter(el => {
    const rect = el.getBoundingClientRect();
    return rect.top < 200 && rect.width > 30 && rect.width < 100;
  });
  if (stories.length > 0) {
    const target = stories[randomInt(0, Math.min(stories.length - 1, 4))];
    const clickable = target.closest('button') || target.closest('div[role="button"]') || target;
    await humanClick(clickable);
    await sleep(randomInt(1500, 3000)); // Wait for story to load

    // Watch multiple stories like a real person: tap through 2-8 stories
    const storiesToWatch = randomInt(2, 8);
    let storiesWatched = 0;
    for (let i = 0; i < storiesToWatch; i++) {
      // Watch current story slide — variable attention
      const isEngaging = Math.random() < 0.2;
      const viewTime = isEngaging ? randomInt(5000, 12000) : randomInt(2000, 5500);
      await sleep(viewTime);
      storiesWatched++;

      // Check if story viewer is still open
      const closeBtn = document.querySelector('svg[aria-label="Close"]');
      if (!closeBtn) break; // Story viewer closed on its own

      // Tap right side of screen to go to next story (like a real tap-through)
      const storyArea = document.querySelector('div[role="presentation"]') ||
                        document.querySelector('section[role="presentation"]') ||
                        document.querySelector('div[style*="translateX"]')?.parentElement;
      if (storyArea) {
        const rect = storyArea.getBoundingClientRect();
        const tapX = rect.left + rect.width * (0.65 + Math.random() * 0.25);
        const tapY = rect.top + rect.height * (0.3 + Math.random() * 0.4);
        storyArea.dispatchEvent(new PointerEvent('pointerdown', { clientX: tapX, clientY: tapY, bubbles: true }));
        await sleep(randomInt(50, 150));
        storyArea.dispatchEvent(new PointerEvent('pointerup', { clientX: tapX, clientY: tapY, bubbles: true }));
        storyArea.dispatchEvent(new MouseEvent('click', { clientX: tapX, clientY: tapY, bubbles: true }));
        await sleep(randomInt(300, 800));
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await sleep(randomInt(300, 800));
      }

      if (Math.random() < 0.15) {
        await sleep(randomInt(2000, 5000));
      }
    }

    // Close the story viewer
    await sleep(randomInt(500, 1500));
    const closeBtnFinal = document.querySelector('svg[aria-label="Close"]');
    if (closeBtnFinal) {
      await humanClick(closeBtnFinal.closest('button') || closeBtnFinal);
      await sleep(humanDelay(500));
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(humanDelay(500));
    }
    return { success: true, label: `👁️ Viewed ${storiesWatched} stories` };
  }
  // No stories found — scroll feed instead
  await performScroll();
  return { success: true, label: '📜 No stories found — scrolled feed instead' };
}

async function warmupReadComments() {
  // Must be on a page with posts (home feed)
  const nav = await ensureHomeFeed();
  if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
  await sleep(humanDelay(800));

  // Find a visible post
  const posts = document.querySelectorAll('article');
  const visible = Array.from(posts).filter(p => {
    const rect = p.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight;
  });

  if (visible.length === 0) {
    // Scroll to find posts first
    await performScroll();
    await sleep(1500);
    const posts2 = document.querySelectorAll('article');
    const visible2 = Array.from(posts2).filter(p => {
      const rect = p.getBoundingClientRect();
      return rect.top >= 0 && rect.top < window.innerHeight;
    });
    if (visible2.length === 0) return { success: true, label: '📜 No posts found — scrolled feed instead' };
    visible.push(...visible2);
  }

  const post = visible[randomInt(0, visible.length - 1)];

  // Click the comment icon to open comment section
  const commentIcon = post.querySelector('svg[aria-label="Comment"]');
  if (commentIcon) {
    const btn = commentIcon.closest('button') || commentIcon.parentElement;
    post.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(600));
    await humanClick(btn);
    await sleep(humanDelay(1500));

    // Scroll through comments in the opened modal/section
    const commentArea = document.querySelector('[role="dialog"] ul')
      || document.querySelector('ul[class*="comment"], div[class*="comment"]');

    let commentsScrolled = 0;
    if (commentArea) {
      const passes = randomInt(3, 6);
      for (let i = 0; i < passes; i++) {
        commentArea.scrollTop += randomInt(80, 200);
        commentsScrolled++;
        await sleep(randomInt(800, 2000));
      }
      if (Math.random() < 0.3) {
        commentArea.scrollTop -= randomInt(40, 120);
        await sleep(humanDelay(600));
      }
    }

    await sleep(randomInt(1000, 3000));

    // Close comment modal if opened
    const closeBtn = document.querySelector('[role="dialog"] svg[aria-label="Close"]');
    if (closeBtn) {
      await humanClick(closeBtn.closest('button') || closeBtn);
      await sleep(humanDelay(500));
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(humanDelay(500));
    }

    return { success: true, label: `💬 Read comments on a post (${commentsScrolled} scrolls)` };
  }

  // No comment icon — use inline scrollThroughComments
  await scrollThroughComments(post);
  return { success: true, label: '💬 Browsed comments inline' };
}

async function warmupLike() {
  // Must be on home feed or explore to find like buttons
  const onFeedOrExplore = window.location.pathname === '/' || window.location.pathname.startsWith('/explore');
  if (!onFeedOrExplore) {
    const nav = await ensureHomeFeed();
    if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
    await sleep(humanDelay(1000));
  }

  // Make sure there are posts visible
  const likeButtons = document.querySelectorAll('svg[aria-label="Like"]');
  const visibleButtons = Array.from(likeButtons).filter(btn => {
    const rect = btn.getBoundingClientRect();
    return rect.top >= 50 && rect.top <= window.innerHeight - 50;
  });

  if (visibleButtons.length === 0) {
    await performScroll();
    await sleep(1500);
    const retry = document.querySelectorAll('svg[aria-label="Like"]');
    const retryVisible = Array.from(retry).filter(btn => {
      const rect = btn.getBoundingClientRect();
      return rect.top >= 50 && rect.top <= window.innerHeight - 50;
    });
    if (retryVisible.length === 0) return { success: true, label: '📜 No posts to like — scrolled feed instead' };
    visibleButtons.push(...retryVisible);
  }

  const target = visibleButtons[randomInt(0, visibleButtons.length - 1)];
  const clickable = target.closest('button') || target.parentElement;

  const postArticle = clickable?.closest('article');
  if (postArticle) {
    postArticle.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(800));
  }

  const clicked = await humanClick(clickable);
  await sleep(humanDelay(500));
  const page = window.location.pathname.startsWith('/explore') ? 'explore' : 'feed';
  if (clicked) {
    return { success: true, label: `❤️ Liked a post on ${page}` };
  }
  return { success: false, label: '❤️ Like click failed' };
}

async function warmupComment() {
  const onFeedOrExplore = window.location.pathname === '/' || window.location.pathname.startsWith('/explore');
  if (!onFeedOrExplore) {
    const nav = await ensureHomeFeed();
    if (nav && typeof nav === 'object' && nav.needsTabNavigation) return nav;
    await sleep(humanDelay(1000));
  }

  const posts = document.querySelectorAll('article');
  const visible = Array.from(posts).filter(p => {
    const rect = p.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight;
  });
  if (visible.length === 0) return { success: false, label: '✍️ No posts found for commenting' };

  const post = visible[randomInt(0, visible.length - 1)];
  const commentBtn = post.querySelector('svg[aria-label="Comment"]');
  if (!commentBtn) return { success: false, label: '✍️ No comment button found' };

  const clickable = commentBtn.closest('button') || commentBtn.parentElement;
  await humanClick(clickable);
  await sleep(humanDelay(1200));

  const comments = ['🔥', '👏', '💯', '❤️', '😍', 'Nice!', '🙌', 'Love this!', '✨', 'Amazing!'];
  const comment = comments[randomInt(0, comments.length - 1)];

  const textarea = document.querySelector('textarea[placeholder*="comment"], textarea[aria-label*="comment"], textarea');
  if (!textarea) return { success: false, label: '✍️ Comment box not found' };

  await humanClick(textarea);
  await sleep(humanDelay(400));

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(textarea, comment);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(humanDelay(600));

  const postBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(
    b => b.textContent?.trim() === 'Post'
  );
  if (postBtn) {
    await humanClick(postBtn);
    await sleep(humanDelay(800));
    return { success: true, label: `✍️ Commented "${comment}" on a post` };
  }
  return { success: false, label: '✍️ Post button not found' };
}

// ─── MESSAGE LISTENER ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Futnor Instagram] Message received:', msg.type, msg.action);
  
  // Handle ping to check if content script is ready
  if (msg.type === 'PING') {
    console.log('[Futnor Instagram] Ping received, responding ready');
    sendResponse({ ready: true });
    return true;
  }

  // ── Action-block / challenge probe (used by the engagement monitor and
  //    other long-running flows so they can short-circuit when Instagram
  //    starts showing block dialogs). Returns { blocked, reason, signal }. ──
  if (msg.type === 'CHECK_INSTAGRAM_BLOCK') {
    try {
      const state = detectInstagramBlockState();
      sendResponse(state);
    } catch (e) {
      sendResponse({ blocked: false, error: e?.message || String(e) });
    }
    return true;
  }
  
  // ── Session stop / pause — abort any in-progress operation immediately ──────
  if (msg.type === 'SESSION_STOP' || msg.type === 'SESSION_PAUSE') {
    botAborted = true;
    console.log(`[Futnor Instagram] ${msg.type} received — aborting current operation`);
    sendResponse({ success: true });
    return true;
  }

  // Handle session lifecycle sync from the background worker
  if (msg.type === 'SESSION_START' || msg.type === 'SESSION_RESUME') {
    // Clear abort flag so the new/resumed session can run
    botAborted = false;
    const isFreshStart = msg.type === 'SESSION_START';
    console.log(
      `[Futnor Instagram] ${isFreshStart ? 'Session started' : 'Session resumed'}, ` +
      `${isFreshStart ? 'resetting' : 'preserving'} traversal state and refreshing account history caches`
    );

    if (isFreshStart) {
      resetTraversalState();
      visitedPostsThisSession.clear();
      hashtagPostIndex = 0;
    }

    Promise.all([
      refreshDMHistoryCache(),
      refreshProcessedAccountsCache(),
    ]).catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  
  // Handle banner commands synchronously
  if (msg.type === 'SHOW_BOT_BANNER') {
    showBotBanner(msg.mode || 'bot');
    sendResponse({ success: true });
    return;
  }
  if (msg.type === 'HIDE_BOT_BANNER') {
    hideBotBanner();
    sendResponse({ success: true });
    return;
  }
  if (msg.type === 'UPDATE_BANNER') {
    // Auto-create the banner if it's missing — IG SPA navigations or DOM
    // re-renders can occasionally drop the overlay. Self-heal so warm-up and
    // bot live activity always remain visible without waiting for the next
    // SHOW_BOT_BANNER ping.
    if (!futnorBanner) {
      try { showBotBanner(msg.mode || bannerMode || 'bot'); } catch {}
    } else if (msg.mode && msg.mode !== bannerMode) {
      bannerMode = msg.mode;
      updateBannerMode();
    }
    if (msg.stats) bannerStats = msg.stats;
    if (msg.latestLog) {
      bannerLogs.unshift(msg.latestLog);
      if (bannerLogs.length > 5) bannerLogs.length = 5;
    }
    updateBannerContent();
    sendResponse({ success: true });
    return;
  }
  
  // Return the logged-in Instagram username. Delegates to the shared
  // detection routine so the message handler, the proactive observer, and the
  // background's scripting fallback all agree on what a "valid" username
  // looks like and what signals are worth trusting.
  if (msg.type === 'GET_LOGGED_IN_USERNAME') {
    try {
      const username = detectLoggedInUsernameFromDOM();
      if (username) {
        // Persist so storage reflects the newest detection even if the caller
        // discards the reply (e.g. background stopped waiting).
        persistDetectedUsername(username);
        sendResponse({ success: true, username });
      } else {
        sendResponse({ success: false, username: null });
      }
    } catch (e) {
      console.error('[Futnor Instagram] GET_LOGGED_IN_USERNAME error:', e);
      sendResponse({ success: false, username: null });
    }
    return true;
  }

  // Handle action commands asynchronously
  if (msg.type !== 'PERFORM_ACTION') return;

  // ── Duplicate-action guard ────────────────────────────────────
  // If two content scripts are alive in the same tab (manifest +
  // programmatic injection), both receive every message.  Use a
  // page-level lock so only the FIRST handler actually executes
  // the action; the second one silently drops it.
  const actionLockKey = `__futnorActionLock_${msg.action}_${Date.now()}`;
  if (!window.__futnorActionLocks) window.__futnorActionLocks = {};
  // Use a shared nonce: first script to set it wins
  const nonce = Math.random().toString(36);
  if (!window.__futnorActionLocks[msg.action]) {
    window.__futnorActionLocks[msg.action] = nonce;
  }
  // Allow the lock to expire after a short window so the same action can be re-sent later
  setTimeout(() => { if (window.__futnorActionLocks[msg.action] === nonce) delete window.__futnorActionLocks[msg.action]; }, 500);
  if (window.__futnorActionLocks[msg.action] !== nonce) {
    // Another content script instance already claimed this action
    return;
  }

  (async () => {
    let success = false;
    console.log('[Futnor Instagram] Executing action:', msg.action);

    // ── SAFETY GATE: refuse to act if Instagram is showing a block / challenge ──
    // Continuing to act in those states escalates a temporary block to a permanent ban.
    const blockState = detectInstagramBlockState();
    if (blockState.blocked) {
      console.warn('[Futnor Instagram] 🛑 Refusing action — Instagram block active:', blockState.reason);
      await reportBlockedAndStop(blockState);
      sendResponse?.({ success: false, blocked: true, reason: blockState.reason });
      return;
    }

    // Add random micro-delay before any action (humans don't act instantly)
    await sleep(randomInt(200, 800));

    try {
      switch (msg.action) {
        case 'scroll':
          success = await performScroll();
          break;
        case 'like':
          success = await performLike();
          break;
        case 'follow':
          success = await performFollow();
          break;
        case 'dm': {
          const dmResult = await performDM(msg.customMessage, !!msg.allowExistingChats);
          // If performDM needs a tab-level navigation (hard nav required),
          // pass the signal directly so the background can navigate and re-dispatch.
          if (dmResult && typeof dmResult === 'object' && dmResult.needsTabNavigation) {
            sendResponse(dmResult);
            return;
          }
          if (dmResult && typeof dmResult === 'object' && dmResult.ok) {
            sendResponse({ success: true, wasFirstContact: !!dmResult.wasFirstContact });
            return;
          }
          success = !!dmResult;
          break;
        }
        // Warmup-specific actions (all may return needsTabNavigation object)
        case 'warmupFeed':
        case 'warmupExplore':
        case 'warmupReels':
        case 'warmupStory':
        case 'warmupReadComments':
        case 'warmupLike':
        case 'warmupComment':
        case 'warmupCheckNotifications':
        case 'warmupCheckInbox':
        case 'warmupBrowseSearch': {
          const handler = {
            warmupFeed, warmupExplore, warmupReels, warmupStory,
            warmupReadComments, warmupLike, warmupComment,
            warmupCheckNotifications, warmupCheckInbox, warmupBrowseSearch,
          }[msg.action];
          const niche = (msg && Array.isArray(msg.nicheKeywords)) ? msg.nicheKeywords : [];
          const result = await handler(niche);
          if (result && typeof result === 'object' && result.needsTabNavigation) {
            sendResponse(result);
            return;
          }
          // Result is now { success, label, stalled } or boolean for backwards compat
          if (result && typeof result === 'object' && 'success' in result) {
            sendResponse({ success: result.success, label: result.label, stalled: !!result.stalled });
            return;
          }
          success = result === true;
          break;
        }
        // Targeting navigation actions
        case 'navigateHashtag': {
          const result = await navigateHashtag(msg.keywords?.[0]);
          // If content script signals it needs a tab-level navigation, pass that object back directly
          if (result && typeof result === 'object' && result.needsTabNavigation) {
            sendResponse(result);
            return;
          }
          success = !!result;
          break;
        }
        case 'returnToHashtagResults': {
          const result = await returnToHashtagResults(msg.keywords?.[0]);
          if (result && typeof result === 'object' && result.needsTabNavigation) {
            sendResponse(result);
            return;
          }
          success = !!result;
          break;
        }
        case 'navigateLocation':
          success = await navigateLocation(msg.keywords?.[0]);
          break;
        case 'engageNextLocationPost':
          success = await engageNextLocationPost();
          break;
        case 'scrollLocationResults':
          success = await scrollLocationResults();
          break;
        case 'returnToLocationGrid':
          success = await returnToLocationGrid();
          break;
        case 'returnToLocationResults':
          success = await returnToLocationResults(msg.keywords?.[0]);
          break;
        case 'extractLocationUsernames':
          try {
            const targetCount = msg.keywords?.[0] ? parseInt(msg.keywords[0], 10) : 60;
            const locationUsers = await extractLocationUsernames(targetCount);
            sendResponse({ success: true, usernames: locationUsers });
            return;
          } catch (e) {
            console.error('[Human Behavior Bot] extractLocationUsernames failed:', e);
            sendResponse({ success: false, usernames: [] });
            return;
          }
        case 'navigatePost':
          success = await navigatePost(msg.keywords?.[0], msg.keywords?.[1]);
          break;
        case 'navigateUserFollowers':
          success = await navigateUserFollowers(msg.keywords?.[0], msg.keywords?.[1]);
          break;
        case 'navigateProfile':
          success = await navigateProfile(msg.keywords?.[0]);
          break;
        case 'dmUsername': {
          const result = await dmUsername(msg.keywords?.[0], msg.customMessage, !!msg.allowExistingChats);
          if (result && typeof result === 'object' && result.ok) {
            sendResponse({ success: true, wasFirstContact: !!result.wasFirstContact });
            return;
          }
          success = !!result;
          break;
        }
        case 'engageFromModal':
          {
            const result = await engageFromModal();
            if (result && typeof result === 'object') {
              sendResponse(result);
              return;
            }
            success = !!result;
            break;
          }
        case 'engageFollowerModalCandidate':
          {
            // followers/following flow: strictly next-in-list. Traversal
            // position is held by markTraversalVisitedAccount.
            const result = await engageFromModal({ persistProcessed: false });
            if (result && typeof result === 'object') {
              sendResponse(result);
              return;
            }
            success = !!result;
            break;
          }
        // AI Targeting actions
        case 'exploreSearch':
          success = await performExploreSearch(msg.keywords);
          break;
        case 'engageSimilar':
          // ── LIKERS PICK (v2.4.121) ──────────────────────────────────────
          // persistProcessed: false → only mark this liker visited in-session.
          // The PERMANENT processedAccounts list was accumulating EVERY
          // clicked liker (even ones we never sent a DM to — e.g. ones
          // skipped by the existing-chat check, ones whose Message button
          // failed, ones where IG threw any error mid-flow). After a few
          // sessions, hasVisitedAccount returned true for almost every
          // liker in the modal, leaving 1–2 "fresh" candidates buried mid-
          // list. The bot then picked the topmost-remaining liker, which
          // looked like random scrolling to the user ("not selecting
          // likers properly, still randomly scrolling picking them up").
          //
          // Now: in-session only. The DM history mechanism (DM-only,
          // added only after a successful send via addToBgDMHistory)
          // remains the permanent record. Likers clicked-but-not-DM'd
          // become fresh again next session, so the bot picks strictly
          // top-to-bottom from the very first uncommitted liker.
          success = await engageFromModal({ persistProcessed: false }) || await performEngageSimilarAccount();
          break;
        case 'engageRecentAccount':
          success = await engageRecentAccount();
          break;
        case 'engageNextHashtagPost':
          success = await engageNextHashtagPost();
          break;
        case 'checkProfileRecency':
          success = await checkProfileRecency();
          break;
        case 'checkProfileDemographics': {
          const demo = await checkProfileDemographics();
          sendResponse({ success: true, demographics: demo });
          return;
        }
        case 'profileLike':
          success = await performProfileLike();
          break;
        case 'browseProfile':
          success = await browseProfileHumanly();
          break;
        case 'profileMultiLike': {
          const likeCount = await performProfileMultiLike();
          sendResponse({ success: likeCount > 0, likesCount: likeCount });
          return;
        }
        case 'profileFollow':
          success = await performProfileFollow();
          break;
        case 'profileDM': {
          const dmTargetHint = normalizeUsername((msg.keywords && msg.keywords[0]) || '');
          const result = await performProfileDM(msg.customMessage, dmTargetHint, !!msg.allowExistingChats);
          if (result && typeof result === 'object') {
            sendResponse({ success: true, wasFirstContact: !!result.wasFirstContact });
            return;
          }
          success = !!result;
          break;
        }
        case 'sendDirectDM': {
          // ManyChat-style: send DM directly via /direct/new/ compose flow
          // No profile visit needed — just search username, select, type, send
          try {
            const targetUser = normalizeUsername((msg.keywords && msg.keywords[0]) || '');
            const dmMsg = msg.customMessage;
            if (!targetUser || !dmMsg) {
              console.log('[Human Behavior Bot] sendDirectDM: missing username or message');
              sendResponse({ success: false });
              return;
            }

            console.log(`[Human Behavior Bot] sendDirectDM: Starting direct DM flow for @${targetUser}`);

            await refreshDMHistoryCache();
            if (isInDMHistory(targetUser)) {
              console.log(`[Human Behavior Bot] sendDirectDM: Already DM'd @${targetUser} — skipping`);
              sendResponse({ success: false });
              return;
            }

            // We should be on /direct/new/ — check
            if (!window.location.pathname.includes('/direct/new')) {
              console.log(`[Human Behavior Bot] sendDirectDM: Not on /direct/new/ (at ${window.location.pathname}) — requesting navigation`);
              sendResponse({ success: false, needsTabNavigation: true, url: 'https://www.instagram.com/direct/new/' });
              return;
            }

            // Wait for the compose UI to load
            await sleep(humanDelay(1500));

            // Step 1: Find the search/recipient input
            let searchInput = null;
            for (let attempt = 0; attempt < 10; attempt++) {
              searchInput = document.querySelector('input[placeholder*="Search"], input[placeholder*="search"], input[name="queryBox"], input[type="text"]');
              if (searchInput) break;
              await sleep(800);
            }

            if (!searchInput) {
              console.log('[Human Behavior Bot] sendDirectDM: No search input found on /direct/new/');
              sendResponse({ success: false });
              return;
            }

            // Step 2: Type the username character by character
            console.log(`[Human Behavior Bot] sendDirectDM: Typing username "${targetUser}" in search...`);
            searchInput.focus();
            await sleep(300);
            // Clear any existing text
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(200);

            for (const char of targetUser) {
              searchInput.value += char;
              searchInput.dispatchEvent(new Event('input', { bubbles: true }));
              await sleep(randomInt(40, 100));
            }
            // Also dispatch via InputEvent for React/Lexical
            searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: targetUser, inputType: 'insertText' }));
            await sleep(humanDelay(2000));

            // Step 3: Find and click the matching user result
            let userSelected = false;
            for (let attempt = 0; attempt < 8; attempt++) {
              // Look for result items containing the username
              const resultItems = Array.from(document.querySelectorAll(
                'div[role="listbox"] div[role="option"], ' +
                'div[role="dialog"] button, div[role="dialog"] div[role="button"], ' +
                'div[class] button, div[class] div[role="button"], ' +
                'label, input[type="checkbox"]'
              ));

              // Also try clicking any element that contains the username text
              const allClickables = Array.from(document.querySelectorAll('div, span, button, label'));
              const matchCandidates = allClickables.filter(el => {
                const text = (el.textContent || '').toLowerCase().trim();
                // Must contain the username and be reasonably sized (not the whole page)
                if (!text.includes(targetUser.toLowerCase())) return false;
                if (text.length > 200) return false;
                // Must be in the results area (below the search input)
                const rect = el.getBoundingClientRect();
                const inputRect = searchInput.getBoundingClientRect();
                if (rect.top < inputRect.bottom) return false;
                return true;
              });

              // Sort by specificity (shortest text = most specific match)
              matchCandidates.sort((a, b) => (a.textContent?.length || 0) - (b.textContent?.length || 0));

              if (matchCandidates.length > 0) {
                const target = matchCandidates[0];
                console.log(`[Human Behavior Bot] sendDirectDM: Found user result — clicking "${target.textContent?.trim().substring(0, 50)}"`);
                
                // Try clicking checkbox/label first, then the element itself
                const checkbox = target.querySelector('input[type="checkbox"]') || target.closest('label');
                if (checkbox) {
                  await humanClick(checkbox);
                } else {
                  await humanClick(target);
                }
                await sleep(humanDelay(1000));
                userSelected = true;
                break;
              }

              if (attempt < 7) {
                console.log(`[Human Behavior Bot] sendDirectDM: No results yet (attempt ${attempt + 1}/8), waiting...`);
                await sleep(1000);
              }
            }

            if (!userSelected) {
              console.log(`[Human Behavior Bot] sendDirectDM: Could not find @${targetUser} in search results`);
              sendResponse({ success: false });
              return;
            }

            // Step 4: Click "Chat" / "Next" button to open the thread
            await sleep(humanDelay(500));
            let chatBtnClicked = false;
            for (let attempt = 0; attempt < 5; attempt++) {
              const chatBtns = Array.from(document.querySelectorAll('button, div[role="button"]')).filter(btn => {
                const t = (btn.textContent?.trim() || '').toLowerCase();
                return t === 'next' || t === 'chat' || t === 'siguiente' || t === 'weiter' || t === 'sohbet';
              });
              if (chatBtns.length > 0) {
                console.log(`[Human Behavior Bot] sendDirectDM: Clicking "${chatBtns[0].textContent?.trim()}" button`);
                await humanClick(chatBtns[0]);
                chatBtnClicked = true;
                await sleep(humanDelay(2000));
                break;
              }
              await sleep(800);
            }

            if (!chatBtnClicked) {
              console.log('[Human Behavior Bot] sendDirectDM: No Chat/Next button found');
              sendResponse({ success: false });
              return;
            }

            // Step 5: Wait for the DM composer to appear in the thread
            let composer = await waitForDMComposer(targetUser, 20);
            if (!composer) {
              console.log('[Human Behavior Bot] sendDirectDM: DM composer never appeared');
              sendResponse({ success: false });
              return;
            }

            console.log('[Human Behavior Bot] sendDirectDM: Stabilizing composer before text entry...');
            composer = await stabilizeDMComposerForTyping(composer, 'sendDirectDM') || composer;

            // Step 6: Check for existing messages (don't double-DM)
            // HARDENED: respect allowExistingChats and fail closed on 'unknown'.
            const allowExistingChatsDirect = !!msg.allowExistingChats;
            const directFreshness = await confirmThreadFreshness(composer, { maxWaitMs: 8000, stableChecks: 3 });
            if (directFreshness === 'existing' && !allowExistingChatsDirect) {
              await addToDMHistory(targetUser);
              console.log(`[Human Behavior Bot] sendDirectDM: Existing conversation with @${targetUser} — skipping`);
              sendResponse({ success: false });
              return;
            }
            if (directFreshness === 'unknown' && !allowExistingChatsDirect) {
              console.log(`[Human Behavior Bot] sendDirectDM: Thread freshness unknown after 8s — skipping iteration (will retry next session) @${targetUser}`);
              sendResponse({ success: false });
              return;
            }
            if (!allowExistingChatsDirect && threadHasAnyMessages(composer)) {
              await addToDMHistory(targetUser);
              console.log(`[Human Behavior Bot] sendDirectDM: Pre-send guard caught existing messages — skipping @${targetUser}`);
              sendResponse({ success: false });
              return;
            }


            // Step 7: Personalize, type, and send the message
            const personalizedMsg = personalizeAndFormatDM(dmMsg, targetUser);
            const dmSent = await executeValidatedDMFlow(personalizedMsg, {
              label: `sendDirectDM @${targetUser}`,
              targetUsernameHint: targetUser,
              initialComposer: composer,
              maxFlowAttempts: 2,
            });

            if (dmSent) {
              await addToDMHistory(targetUser);
              const threadUser = extractCurrentThreadUsername();
              const threadId = extractCurrentThreadId();
              if (threadUser) await addToDMHistory(threadUser);
              if (threadId) await addToDMHistory(threadId);
              markVisitedAccount(targetUser);
              console.log(`[Human Behavior Bot] sendDirectDM: ✅ DM sent to @${targetUser}`);
            } else {
              console.log(`[Human Behavior Bot] sendDirectDM: ❌ Failed to send DM to @${targetUser}`);
            }

            sendResponse({
              success: !!dmSent,
              wasFirstContact: dmSent && typeof dmSent === 'object' ? !!dmSent.wasFirstContact : undefined,
            });
            return;
          } catch (e) {
            console.error('[Human Behavior Bot] sendDirectDM error:', e);
            sendResponse({ success: false });
            return;
          }
        }
        case 'extractCommenters':
          try {
            // Extract from current page — background.js handles navigation
            const commenters = await extractCommentersFromCurrentPage();
            sendResponse({ success: true, commenters, owners: Array.from(collectPostOwnerCandidates()) });
            return;
          } catch (e) {
            console.error('[Human Behavior Bot] extractCommenters failed:', e);
            sendResponse({ success: false, commenters: [], owners: [] });
            return;
          }
        case 'getRecentPostLink':
          try {
            const postLink = await getRecentPostLink();
            sendResponse({ success: !!postLink, postLink });
            return;
          } catch (e) {
            sendResponse({ success: false, postLink: null });
            return;
          }
        case 'getRecentPostContext':
          try {
            const ctx = await getRecentPostContext();
            sendResponse({ success: !!ctx, context: ctx });
            return;
          } catch (e) {
            console.warn('[Human Behavior Bot] getRecentPostContext error:', e?.message || e);
            sendResponse({ success: false, context: null });
            return;
          }
        case 'extractPostContext':
          try {
            const ctx = await extractPostContext();
            sendResponse({ success: !!ctx, context: ctx });
            return;
          } catch (e) {
            console.warn('[Human Behavior Bot] extractPostContext error:', e?.message || e);
            sendResponse({ success: false, context: null });
            return;
          }
        case 'postCommentOnCurrentPost':
          try {
            const ok = await postCommentOnCurrentPost(msg.customMessage || msg.keywords?.[0] || '');
            sendResponse({ success: !!ok });
            return;
          } catch (e) {
            console.warn('[Human Behavior Bot] postCommentOnCurrentPost error:', e?.message || e);
            sendResponse({ success: false });
            return;
          }
        case 'isProfileAccessible':
          try {
            const accessResult = await isProfileAccessible();
            sendResponse({ success: true, ...accessResult });
            return;
          } catch (e) {
            sendResponse({ success: true, accessible: true, reason: 'unknown' });
            return;
          }
        case 'monitorPostComments': {
          try {
            const keywords = msg.keywords || [];
            const commenters = await monitorPostComments(keywords);
            sendResponse({ success: true, commenters, owners: Array.from(collectPostOwnerCandidates()) });
            return;
          } catch (e) {
            console.error('[Futnor Instagram] monitorPostComments action failed:', e);
            sendResponse({ success: false, commenters: [], owners: [] });
            return;
          }
        }
        case 'monitorPostLikers': {
          try {
            const likers = await monitorPostLikers();
            sendResponse({ success: true, likers, owners: Array.from(collectPostOwnerCandidates()) });
            return;
          } catch (e) {
            console.error('[Futnor Instagram] monitorPostLikers action failed:', e);
            sendResponse({ success: false, likers: [], owners: [] });
            return;
          }
        }
        case 'monitorNewFollowers': {
          try {
            const followers = await monitorNewFollowers();
            sendResponse({ success: true, followers });
            return;
          } catch (e) {
            console.error('[Futnor Instagram] monitorNewFollowers action failed:', e);
            sendResponse({ success: false, followers: [] });
            return;
          }
        }
        case 'openTopDMThread':
          // Open DM thread from inbox.
          // If a recovery target is provided, ONLY open that exact target thread.
          try {
            console.log('[Human Behavior Bot] openTopDMThread — looking for conversations...');
            await sleep(1500);

            const recoveryTarget = normalizeUsername((msg.keywords && msg.keywords[0]) || '');
            await refreshDMHistoryCache();

            const threadLinks = Array.from(document.querySelectorAll('a[href*="/direct/t/"]'));
            if (threadLinks.length === 0) {
              console.log('[Human Behavior Bot] No conversation links found in inbox');
              sendResponse({ success: false });
              return;
            }

            let targetThread = null;

            if (recoveryTarget) {
              for (const thread of threadLinks) {
                const identifiers = getThreadIdentifiers(thread);
                if (!identifiers.includes(recoveryTarget)) continue;

                const alreadyHandled = identifiers.some((identifier) => isInDMHistory(identifier));
                if (alreadyHandled) {
                  console.log(`[Human Behavior Bot] Recovery target @${recoveryTarget} already in DM history, skipping`);
                  sendResponse({ success: false });
                  return;
                }

                targetThread = thread;
                break;
              }

              if (!targetThread) {
                console.log(`[Human Behavior Bot] Recovery target @${recoveryTarget} not visible in inbox — refusing random fallback`);
                sendResponse({ success: false });
                return;
              }
            } else {
              for (const thread of threadLinks) {
                const alreadyHandled = threadIsInDMHistory(thread);
                if (!alreadyHandled) {
                  targetThread = thread;
                  break;
                }
              }

              if (!targetThread) {
                console.log('[Human Behavior Bot] All visible inbox threads already handled, skipping openTopDMThread');
                sendResponse({ success: false });
                return;
              }
            }

            await humanClick(targetThread);
            await sleep(2000);
            sendResponse({ success: true });
            return;
          } catch (e) {
            console.error('[Human Behavior Bot] openTopDMThread failed:', e);
            sendResponse({ success: false });
            return;
          }
        case 'sendDMMessage':
          // Called by background when page navigated to /direct/t/... after clicking Message
          // Just type and send the message on the current DM thread page
          try {
            console.log('[Human Behavior Bot] sendDMMessage action — typing message on DM page...');
            const dmMsg = msg.customMessage;
            if (!normalizeOutgoingMessage(dmMsg)) {
              console.log('[Human Behavior Bot] ERROR: DM script is empty or not loaded (sendDMMessage)');
              sendResponse({ success: false });
              return;
            }

            await refreshDMHistoryCache();
            const recoveryTarget = normalizeUsername((msg.keywords && msg.keywords[0]) || '');

            if (
              recoveryTarget
              && window.location.pathname.includes('/direct/inbox')
              && !isOnInstagramDirectThread()
            ) {
              console.log(`[Human Behavior Bot] sendDMMessage: On inbox without active thread — opening @${recoveryTarget} before typing...`);
              await openMatchingInboxThread(recoveryTarget);
              await sleep(humanDelay(1600));
            }
            
            // Wait for inbox/thread to fully load and ensure the composer is usable
            let dmTextbox = await waitForDMComposer(recoveryTarget || '', 20);
            if (!dmTextbox) {
              console.log('[Human Behavior Bot] ❌ No textbox found on DM page');
              sendResponse({ success: false });
              return;
            }

            dmTextbox = await stabilizeDMComposerForTyping(dmTextbox, 'sendDMMessage') || dmTextbox;
            
            // Skip if this account/thread is already handled
            let threadUser = extractCurrentThreadUsername();
            let threadId = extractCurrentThreadId();

            // Guard against wrong-thread recovery from inbox: never DM a mismatched thread.
            if (
              recoveryTarget
              && threadUser
              && !threadUser.startsWith('thread_')
              && recoveryTarget !== threadUser
            ) {
              console.log(`[Human Behavior Bot] Recovery mismatch: expected @${recoveryTarget}, found @${threadUser}. Re-opening exact thread once...`);
              if (window.location.pathname.includes('/direct/inbox')) {
                await openMatchingInboxThread(recoveryTarget);
                await sleep(humanDelay(1600));
                dmTextbox = await waitForDMComposer(recoveryTarget, 12) || dmTextbox;
                dmTextbox = await stabilizeDMComposerForTyping(dmTextbox, 'sendDMMessage retry') || dmTextbox;
                threadUser = extractCurrentThreadUsername();
                threadId = extractCurrentThreadId();
              }

              if (
                recoveryTarget
                && threadUser
                && !threadUser.startsWith('thread_')
                && recoveryTarget !== threadUser
              ) {
                console.log(`[Human Behavior Bot] Recovery mismatch persists: expected @${recoveryTarget}, found @${threadUser}. Aborting send.`);
                sendResponse({ success: false });
                return;
              }
            }

            if ((recoveryTarget && isInDMHistory(recoveryTarget))
              || (threadUser && isInDMHistory(threadUser))
              || (threadId && isInDMHistory(threadId))) {
              console.log(`[Human Behavior Bot] Already handled @${recoveryTarget || threadUser || threadId}, skipping`);
              sendResponse({ success: false });
              return;
            }

            // ── DUPLICATE-SEND GUARD ────────────────────────────────────────
            // When profileDM successfully sent the message but its response to
            // the background was disrupted by a tab navigation to /direct/t/,
            // background falls back to attemptDMRecovery → sendDMMessage.
            // Without this guard, sendDMMessage types and sends the same
            // script AGAIN — delivering it twice to the user.
            //
            // We use TWO checks, polled for up to 6 seconds (Instagram can be
            // slow to render after a fresh /direct/t/ navigation):
            //   1. threadContainsExpectedMessage — did OUR script already land?
            //   2. threadHasAnyMessages — is this an existing conversation?
            const normalizedPersonalizedPreview = personalizeAndFormatDM(dmMsg, recoveryTarget || threadUser || '');
            let alreadySentOurScript = false;
            let existingConversation = false;
            for (let checkRound = 0; checkRound < 12; checkRound++) {
              if (normalizedPersonalizedPreview && threadContainsExpectedMessage(normalizedPersonalizedPreview, dmTextbox)) {
                alreadySentOurScript = true;
                break;
              }
              if (threadHasAnyMessages(dmTextbox)) {
                existingConversation = true;
                // Keep polling briefly in case our script renders — but don't
                // wait forever if it's clearly an old conversation.
                if (checkRound >= 4) break;
              }
              await sleep(humanDelay(500));
            }

            if (alreadySentOurScript) {
              if (recoveryTarget) await addToDMHistory(recoveryTarget);
              if (threadUser) await addToDMHistory(threadUser);
              if (threadId) await addToDMHistory(threadId);
              console.log(`[Human Behavior Bot] ✅ Script already delivered to @${recoveryTarget || threadUser || threadId || 'unknown'} via earlier profileDM — recovery aborted to prevent double-send`);
              sendResponse({ success: true, skippedDuplicate: true });
              return;
            }

            // ── EXISTING-CONVERSATION GATE (v2.4.117) ──────────────────────
            // Honours the targeting panel's "Allow Existing Chats" toggle:
            //   • allowExistingChats=true (default) → send anyway
            //   • allowExistingChats=false         → skip, return false so
            //                                        loop moves to next target
            //
            // The alreadySentOurScript duplicate-send guard above always
            // fires regardless (protects against double-sends of OUR
            // exact message). This block handles the broader "thread has
            // prior messages" case.
            //
            // We do NOT call addToDMHistory on the skip path — that was
            // the recovery-poisoning bug in earlier versions. The
            // background loop's outer flow handles "move to next target".
            const allowExistingChatsForSend = !!msg.allowExistingChats;
            if (existingConversation) {
              if (allowExistingChatsForSend) {
                console.log(`[Human Behavior Bot] Existing conversation with @${recoveryTarget || threadUser || threadId || 'unknown'} — sending anyway (Allow Existing Chats ON)`);
              } else {
                console.log(`[Human Behavior Bot] Existing conversation with @${recoveryTarget || threadUser || threadId || 'unknown'} — SKIPPING (Allow Existing Chats OFF) — moving to next target`);
                sendResponse({ success: false });
                return;
              }
            }

            // Personalise {name} and apply readability spacing via shared helper
            const personalizedMsg = personalizeAndFormatDM(dmMsg, recoveryTarget || threadUser || '');

            const dmSent = await executeValidatedDMFlow(personalizedMsg, {
              label: `sendDMMessage @${recoveryTarget || threadUser || threadId || 'unknown'}`,
              targetUsernameHint: recoveryTarget || threadUser || '',
              initialComposer: dmTextbox,
              maxFlowAttempts: 2,
            });
            if (dmSent) {
              if (recoveryTarget) await addToDMHistory(recoveryTarget);
              if (threadUser) await addToDMHistory(threadUser);
              if (threadId) await addToDMHistory(threadId);
              console.log(`[Human Behavior Bot] ✅ DM sent to @${recoveryTarget || threadUser || threadId} on full DM page`);
            }
            sendResponse({
              success: !!dmSent,
              wasFirstContact: dmSent && typeof dmSent === 'object' ? !!dmSent.wasFirstContact : undefined,
            });
            return;
          } catch (e) {
            console.error('[Human Behavior Bot] sendDMMessage failed:', e);
            sendResponse({ success: false });
            return;
          }
        case 'markVisited':
          // Mark a username as visited so it won't be re-extracted
          try {
            const uname = (msg.keywords && msg.keywords[0]) || '';
            if (uname) {
              markVisitedAccount(uname);
              console.log(`[Human Behavior Bot] Marked @${uname} as visited`);
            }
            sendResponse({ success: true });
            return;
          } catch (e) {
            sendResponse({ success: true });
            return;
          }
        default:
          console.warn('[Futnor Instagram] Unknown action:', msg.action);
      }
    } catch (error) {
      console.error('[Futnor Instagram] Action failed:', msg.action, error);
      success = false;
    }

    console.log('[Futnor Instagram] Action result:', msg.action, success);
    sendResponse({ success });
  })();

  // CRITICAL: Return true to keep the message channel open for async response
  return true;
});

// ─── "DO NOT CLOSE" OVERLAY BANNER ─────────────────────────
let futnorBanner = null;
let bannerStats = { scrolls: 0, likesSent: 0, followsSent: 0, dmsSent: 0 };
let bannerLogs = [];

function updateBannerContent() {
  if (!futnorBanner) return;
  const statsEl = futnorBanner.querySelector('#futnor-banner-stats');
  const logEl = futnorBanner.querySelector('#futnor-banner-log');
  if (statsEl) {
    if (bannerMode === 'warmup') {
      statsEl.innerHTML = `
        <span style="color:#60a5fa">📜 ${bannerStats.feedScrolls || 0}</span>
        <span style="color:#f472b6">❤ ${bannerStats.postsLiked || 0}</span>
        <span style="color:#a78bfa">👁 ${bannerStats.storiesViewed || 0}</span>
        <span style="color:#22d3ee">🎬 ${bannerStats.reelsWatched || 0}</span>
        <span style="color:#94a3b8">⏱ ${bannerStats.elapsedTime ? Math.floor(bannerStats.elapsedTime / 60) + 'm' : '0m'}</span>
      `;
    } else {
      statsEl.innerHTML = `
        <span style="color:#60a5fa">👁 ${bannerStats.scrolls || 0}</span>
        <span style="color:#f472b6">❤ ${bannerStats.likesSent || 0}</span>
        <span style="color:#a78bfa">👤 ${bannerStats.followsSent || 0}</span>
        <span style="color:#22d3ee">✉ ${bannerStats.dmsSent || 0}</span>
      `;
    }
  }
  if (logEl && bannerLogs.length > 0) {
    logEl.textContent = bannerLogs[0];
  }
}

let bannerMode = 'bot'; // 'bot' or 'warmup'

function showBotBanner(mode) {
  bannerMode = mode || 'bot';
  if (futnorBanner) {
    // Update existing banner mode
    updateBannerMode();
    return;
  }
  futnorBanner = document.createElement('div');
  futnorBanner.id = 'futnor-bot-banner';
  futnorBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;pointer-events:none;';
  futnorBanner.innerHTML = `
    <div style="
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-bottom: 2px solid #00ff88; padding: 6px 16px;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 20px rgba(0,255,136,0.15);
      pointer-events: auto; user-select: none;
    ">
      <div style="display:flex;align-items:center;gap:12px;width:100%;justify-content:center;">
        <span id="futnor-banner-badge" style="
          display:inline-flex;align-items:center;gap:6px;
          background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.3);
          border-radius:20px;padding:3px 10px;font-size:11px;
          font-weight:700;color:#00ff88;text-transform:uppercase;letter-spacing:0.5px;
        ">
          <span style="width:6px;height:6px;border-radius:50%;background:#00ff88;animation:futnorPulse 1.5s infinite"></span>
          <span id="futnor-banner-title">Client Engine Active</span>
        </span>
        <span id="futnor-banner-stats" style="display:flex;gap:10px;font-size:12px;font-weight:600;">
          <span style="color:#60a5fa">👁 0</span>
          <span style="color:#f472b6">❤ 0</span>
          <span style="color:#a78bfa">👤 0</span>
          <span style="color:#22d3ee">✉ 0</span>
        </span>
        <span style="color:#fbbf24;font-size:11px;font-weight:600;">
          ⚠️ Do NOT close this tab
        </span>
      </div>
      <div id="futnor-banner-log" style="
        font-size:11px;color:#94a3b8;max-width:600px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;text-align:center;
      ">Waiting for actions…</div>
    </div>
    <style>
      @keyframes futnorPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    </style>
  `;
  document.body.appendChild(futnorBanner);
  updateBannerMode();
  console.log('[Futnor Instagram] Banner shown (mode:', bannerMode, ')');
}

function updateBannerMode() {
  if (!futnorBanner) return;
  const titleEl = futnorBanner.querySelector('#futnor-banner-title');
  const badgeEl = futnorBanner.querySelector('#futnor-banner-badge');
  if (bannerMode === 'warmup') {
    if (titleEl) titleEl.textContent = '🔥 Warm-Up Active';
    if (badgeEl) {
      badgeEl.style.background = 'rgba(251,191,36,0.15)';
      badgeEl.style.borderColor = 'rgba(251,191,36,0.3)';
      badgeEl.style.color = '#fbbf24';
    }
  } else {
    if (titleEl) titleEl.textContent = 'Client Engine Active';
    if (badgeEl) {
      badgeEl.style.background = 'rgba(0,255,136,0.15)';
      badgeEl.style.borderColor = 'rgba(0,255,136,0.3)';
      badgeEl.style.color = '#00ff88';
    }
  }
}

function hideBotBanner() {
  if (futnorBanner) {
    futnorBanner.remove();
    futnorBanner = null;
    bannerStats = { scrolls: 0, likesSent: 0, followsSent: 0, dmsSent: 0 };
    bannerLogs = [];
    console.log('[Futnor Instagram] Banner hidden');
  }
}

// ─── Engagement Monitor ─────────────────────────────────────────────────
// Monitors a post for new commenters/likers and reports them to background
// for DM dispatch. This does NOT modify the targeting/DM flow.

async function monitorPostComments(triggerKeywords) {
  // Returns an array of { username, trigger } for new commenters
  const comments = [];
  try {
    await refreshDMHistoryCache();

    const normalizedKeywords = (triggerKeywords || [])
      .map((kw) => kw?.toString?.().normalize('NFKC').trim().toLowerCase())
      .filter(Boolean);

    // Build a set of protected words — trigger keywords must NOT be stripped
    const protectedWords = new Set(normalizedKeywords);

    const RESERVED = new Set(['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'stories', 'tags', 'locations', 'about', 'tv', 'ar', 'developer']);

    function usernameFromHref(href) {
      if (!href) return null;
      const m = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?(?:\?.*)?$/);
      if (!m) return null;
      const u = m[1].toLowerCase();
      return RESERVED.has(u) ? null : u;
    }

    function cleanCommentText(rawText, username) {
      if (!rawText) return '';
      const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Build noise words list but EXCLUDE any that match trigger keywords
      const noiseWords = ['reply', 'replies', 'view replies', 'view more comments', 'load more comments', 'more comments', 'liked', 'likes', 'like', 'follow', 'following', 'edited', 'verified', 'hide', 'see translation'];
      const safeNoiseWords = noiseWords.filter(w => !protectedWords.has(w.toLowerCase()));
      const noisePattern = safeNoiseWords.length > 0
        ? new RegExp(`\\b(${safeNoiseWords.join('|')})\\b`, 'gi')
        : null;

      let text = rawText
        .normalize('NFKC')
        .replace(new RegExp(`@?${escapedUsername}\\b`, 'gi'), ' ');
      
      if (noisePattern) {
        text = text.replace(noisePattern, ' ');
      }

      return text
        .replace(/\b\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/gi, ' ')
        .replace(/[·•]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Match keyword against BOTH cleaned text AND raw text for resilience
    function getKeywordMatch(commentText, rawText) {
      if (normalizedKeywords.length === 0) return 'comment';
      const normalizedText = commentText.toLowerCase();
      const normalizedRaw = rawText ? rawText.normalize('NFKC').toLowerCase() : '';
      return normalizedKeywords.find((kw) => normalizedText.includes(kw) || normalizedRaw.includes(kw)) || null;
    }

    function extractBestCommentText(link, username) {
      let bestText = '';
      let bestRaw = '';
      let bestScore = -1;
      let node = link.parentElement;

      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        if (node.matches?.('header, nav, footer')) break;

        const rawText = (node.innerText || node.textContent || '').trim();
        const cleaned = cleanCommentText(rawText, username);
        if (!cleaned || cleaned.length > 220) continue;

        const keywordMatch = getKeywordMatch(cleaned, rawText);
        const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
        if (!keywordMatch && wordCount <= 1) continue;

        const score = (keywordMatch ? 1000 : 0) + Math.max(0, 220 - cleaned.length) + Math.min(wordCount, 12) * 12;
        if (score > bestScore) {
          bestScore = score;
          bestText = cleaned;
          bestRaw = rawText;
        }

        if (keywordMatch && cleaned.length <= 120) break;
      }

      return { cleaned: bestText, raw: bestRaw };
    }

    const openNewestComments = async (maxAttempts = 2) => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const expandBtns = Array.from(document.querySelectorAll('button, span')).filter(el => {
          const t = (el.textContent || '').toLowerCase().trim();
          return (
            (t.includes('view all') && t.includes('comment')) ||
            t.includes('view more comments') ||
            t.includes('load more comments') ||
            t.includes('more comments') ||
            (t.startsWith('view') && t.includes('comment')) ||
            t.includes('load more') ||
            /^view\s+\d+/.test(t)
          );
        });

        if (expandBtns.length === 0) break;

        await humanClick(expandBtns[0]);
        await sleep(randomInt(350, 700));
      }
    };

    // Broader comment section detection — handles reels, posts, dialogs
    const commentSection =
      document.querySelector('div[role="dialog"] ul')?.parentElement ||
      document.querySelector('div[role="dialog"] div[style*="flex"]') ||
      document.querySelector('ul[class*="comment"], div[class*="comment"]') ||
      document.querySelector('section > div > ul')?.parentElement ||
      document.querySelector('article ul')?.parentElement ||
      document.querySelector('article');

    await openNewestComments(2);

    if (commentSection) {
      // More aggressive scrolling to load all comments
      for (let s = 0; s < 4; s++) {
        commentSection.scrollTop = commentSection.scrollHeight;
        commentSection.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(randomInt(400, 700));
        await openNewestComments(1);
      }
    }

    const rootCandidates = [commentSection, document.querySelector('div[role="dialog"]'), document.querySelector('article'), document.querySelector('main')].filter(Boolean);
    const seenUsernames = new Set();
    let debugScanned = 0;
    let debugWithUsername = 0;

    // Robustly detect post owner — try multiple sources
    const postOwnerCandidates = collectPostOwnerCandidates();
    const articleHeader = document.querySelector('article header a[href^="/"]');
    if (articleHeader) {
      const u = usernameFromHref(articleHeader.getAttribute('href'));
      if (u) postOwnerCandidates.add(u);
    }
    const urlMatch = window.location.pathname.match(/^\/([\w.]+)\/(p|reel)\//);
    if (urlMatch) postOwnerCandidates.add(urlMatch[1].toLowerCase());

    const postOwnerUsername = postOwnerCandidates.values().next().value || '';
    console.log(`[Futnor Instagram] monitorPostComments: detected post owner(s): [${[...postOwnerCandidates].join(', ')}], primary="${postOwnerUsername}"`);

    function maybeRecordComment(username, cleaned, rawText) {
      if (!username || postOwnerCandidates.has(username) || seenUsernames.has(username) || isInDMHistory(username)) return;

      debugScanned++;
      const matchedKeyword = getKeywordMatch(cleaned, rawText || cleaned);

      if (debugScanned <= 15) {
        console.log(`[Futnor Instagram] Comment #${debugScanned}: @${username} → cleaned="${cleaned.substring(0, 100)}" raw="${(rawText || '').substring(0, 60)}"`);
      }

      if (!matchedKeyword) return;

      seenUsernames.add(username);
      comments.push({ username, trigger: matchedKeyword });
      console.log(`[Futnor Instagram] monitorPostComments: ✅ MATCH @${username} — keyword "${matchedKeyword}" in "${cleaned.substring(0, 80)}"`);
    }

    function collectFromCommentRows(root) {
      if (!root) return;

      // Scan both <li> and <div> based comment rows
      const rows = Array.from(root.querySelectorAll('li, div[role="button"], div[class]')).filter((row) => {
        // Must contain at least one profile link to be a comment row
        const hasLink = row.querySelector('a[href^="/"]');
        if (!hasLink) return false;
        const text = (row.innerText || row.textContent || '').trim();
        return text.length > 0 && text.length < 400;
      });

      for (const row of rows) {
        if (!isLikelyCommentNode(row)) continue;

        const usernamesInRow = Array.from(new Set(
          Array.from(row.querySelectorAll('a[href]'))
            .map((link) => usernameFromHref(link.getAttribute('href')))
            .filter(Boolean)
        ));

        if (usernamesInRow.length === 0) continue;
        if (usernamesInRow.some((uname) => postOwnerCandidates.has(uname))) continue;

        const username = usernamesInRow[0];
        if (!username || seenUsernames.has(username) || isInDMHistory(username)) continue;
        debugWithUsername++;

        const rawText = (row.innerText || row.textContent || '').trim();
        const cleaned = cleanCommentText(rawText, username);
        if (!cleaned) continue;

        maybeRecordComment(username, cleaned, rawText);
      }
    }

    function collectMatches(root) {
      if (!root) return;

      const allProfileLinks = root.querySelectorAll('a[href]');

      for (const link of allProfileLinks) {
        if (link.closest('header, nav, footer')) continue;

        const username = usernameFromHref(link.getAttribute('href'));
        if (username && postOwnerCandidates.has(username)) continue;
        if (!username || seenUsernames.has(username) || isInDMHistory(username)) continue;

        const commentContext = getCommentContextNode(link, root);
        if (!commentContext) continue;
        if (nodeContainsOwner(commentContext, postOwnerCandidates)) continue;

        debugWithUsername++;

        const result = extractBestCommentText(link, username);
        if (!result.cleaned) continue;
        maybeRecordComment(username, result.cleaned, result.raw);
      }
    }

    // Try row-based collection first (most reliable)
    for (const root of rootCandidates) {
      collectFromCommentRows(root);
    }

    // If no matches, try link-based walk-up approach
    if (comments.length === 0) {
      for (const root of rootCandidates) {
        collectMatches(root);
      }
    }

    // Last resort: scroll to middle and retry
    if (comments.length === 0 && commentSection) {
      commentSection.scrollTop = Math.max(0, commentSection.scrollHeight - commentSection.clientHeight * 2);
      commentSection.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(400);
      await openNewestComments(1);

      for (const root of rootCandidates) {
        collectFromCommentRows(root);
      }
      if (comments.length === 0) {
        for (const root of rootCandidates) {
          collectMatches(root);
        }
      }
    }

    console.log(`[Futnor Instagram] monitorPostComments: ${debugWithUsername} profile links, ${debugScanned} comments scanned, ${comments.length} matched`);
  } catch (e) {
    console.error('[Futnor Instagram] monitorPostComments error:', e);
  }
  const ownerCandidates = collectPostOwnerCandidates();
  for (let i = comments.length - 1; i >= 0; i--) {
    const username = normalizeUsername(comments[i]?.username);
    if (username && ownerCandidates.has(username)) {
      console.log(`[Futnor Instagram] monitorPostComments: removed post owner @${username} from final matches`);
      comments.splice(i, 1);
    }
  }
  return comments;
}

// Per-post background cache so a "load 100, then keep paginating" pattern can
// surface additional accounts on subsequent calls without re-opening the modal.
if (typeof window.__futnorLikersBatchCache === 'undefined') {
  window.__futnorLikersBatchCache = new Map(); // postUrl -> { seen:Set<string>, queue:string[], done:boolean, running:boolean }
}
const FIRST_BATCH_TARGET = 100; // surface this many ASAP, then continue in background
const MAX_PAGINATION_ROUNDS = 80; // hard upper cap so background loop terminates

async function monitorPostLikers() {
  // Click the likes count to open likers dialog, extract usernames
  const likers = [];
  try {
    await refreshDMHistoryCache();
    // Capture the post owner BEFORE the likers dialog opens — once the dialog
    // is up the article header is hidden behind it and a couple of the
    // owner-detection selectors stop matching, which is exactly the bug that
    // had the bot DMing the post owner first.
    const postOwnerCandidates = collectPostOwnerCandidates();
    if (postOwnerCandidates.size > 0) {
      console.log('[Futnor Instagram] monitorPostLikers: post owner(s) detected:', Array.from(postOwnerCandidates).join(', '));
    } else {
      console.warn('[Futnor Instagram] monitorPostLikers: post owner could NOT be detected from page — owner-skip safeguard will engage');
    }

    // ── Drain background-paginated cache from previous call (if any) ──
    // Even though the background loop now filters owners at queue-time, we
    // re-apply the filter here as belt-and-braces in case the previous call
    // ran with a stale/empty postOwnerCandidates set. Cheap to re-check.
    const currentPostKey = (location.pathname || '').replace(/\/+$/, '');
    const cached = window.__futnorLikersBatchCache.get(currentPostKey);
    if (cached && cached.queue.length > 0) {
      console.log(`[Futnor Instagram] monitorPostLikers: draining ${cached.queue.length} cached usernames from background batch`);
      for (const u of cached.queue.splice(0)) {
        if (postOwnerCandidates.has(u)) continue;
        if (isInDMHistory(u)) continue;
        if (!likers.includes(u)) likers.push(u);
      }
      // If background loop already finished and we have plenty, return immediately
      if (cached.done && likers.length >= FIRST_BATCH_TARGET) {
        console.log(`[Futnor Instagram] monitorPostLikers: returning ${likers.length} from background cache (post-owner filtered)`);
        return likers;
      }
    }

    // Strategy 1: Direct liked_by link (most reliable)
    let likesBtn = document.querySelector('a[href*="/liked_by/"]');

    // Strategy 2: Section containing "liked by" or "X likes" near the post
    if (!likesBtn) {
      const candidates = Array.from(document.querySelectorAll('section span, section a, section button, div[role="button"]'));
      likesBtn = candidates.find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        // "Liked by username and X others"
        if (text.includes('liked by') && (text.includes('other') || /\d/.test(text))) return true;
        // "X likes" pattern
        if (/^\d[\d,.]*\s*likes?$/i.test(text)) return true;
        // "and X others" standalone
        if (/and\s+\d[\d,.]*\s+others?/i.test(text)) return true;
        return false;
      });
    }

    // Strategy 3: Find the heart-count area by looking for spans near SVG hearts
    if (!likesBtn) {
      const heartSvgs = document.querySelectorAll('svg[aria-label*="like" i], svg[aria-label*="Like" i]');
      for (const svg of heartSvgs) {
        const parent = svg.closest('section') || svg.parentElement?.parentElement;
        if (!parent) continue;
        const spans = parent.querySelectorAll('span, a, button');
        for (const span of spans) {
          const t = (span.textContent || '').trim().toLowerCase();
          if (/\d/.test(t) && (t.includes('like') || t.includes('other'))) {
            likesBtn = span;
            break;
          }
        }
        if (likesBtn) break;
      }
    }

    if (!likesBtn) {
      console.log('[Futnor Instagram] No likes button found');
      return likers;
    }

    // Click the closest clickable ancestor
    const clickTarget = likesBtn.closest('a') || likesBtn.closest('button') || likesBtn.closest('[role="button"]') || likesBtn;
    console.log('[Futnor Instagram] Clicking likes element:', clickTarget.tagName, clickTarget.textContent?.trim()?.substring(0, 60));
    await humanClick(clickTarget);
    await sleep(randomInt(2000, 3000));

    // Wait for likers dialog. The dialog contains profile avatars (img[srcset]),
    // so we identify it by structure: a dialog with multiple profile-link anchors
    // ('/{username}/' style) that is NOT a post modal (post modals have <article>
    // and large media elements).
    let dialog = null;
    for (let w = 0; w < 16; w++) {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      // Pick the topmost dialog (last in DOM order) that looks like a likers list
      for (let i = dialogs.length - 1; i >= 0; i--) {
        const d = dialogs[i];
        if (d.querySelector('article')) continue; // post modal
        if (d.querySelector('video')) continue;   // media modal
        const profileLinks = d.querySelectorAll('a[href^="/"][role], a[role="link"][href^="/"], a[href^="/"]');
        // Likers dialog has many profile links; post modals usually have ≤2
        if (profileLinks.length >= 2) {
          dialog = d;
          break;
        }
      }
      if (dialog) break;
      await sleep(500);
    }
    if (!dialog) {
      console.log('[Futnor Instagram] Likers dialog did not open');
      return likers;
    }

    // Find the scrollable container inside the dialog. The likers list uses a
    // virtualized scroller, so we need to find the element that ACTUALLY scrolls.
    let scrollContainer = null;
    const divs = dialog.querySelectorAll('div');
    for (const div of divs) {
      const style = window.getComputedStyle(div);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && div.clientHeight > 100) {
        // Prefer the deepest scrollable that has > clientHeight content
        if (div.scrollHeight > div.clientHeight + 20) {
          scrollContainer = div;
          // don't break — keep looking for a deeper one
        } else if (!scrollContainer) {
          scrollContainer = div;
        }
      }
    }
    scrollContainer = scrollContainer || dialog;
    console.log(`[Futnor Instagram] Likers scroll container: clientH=${scrollContainer.clientHeight}, scrollH=${scrollContainer.scrollHeight}`);

    // Stale-tolerant pagination with EARLY-RETURN at FIRST_BATCH_TARGET so the
    // bot can start processing the first 100 immediately. The remaining
    // pagination continues in the background and feeds __futnorLikersBatchCache
    // for the next call on this post.
    const seenUsernames = new Set();

    // Safety net: if `collectPostOwnerCandidates()` returned nothing (owner
    // detection failed for some reason — Instagram DOM change, dialog
    // overlay hiding the article header, etc.), fall back to skipping the
    // FIRST harvested username on every scroll round. The dialog's own
    // "Liked by" row puts the post owner at the very top of its anchor
    // list, so dropping the first link is a reliable last-resort filter.
    // Once we have at least one owner candidate from `collectPostOwnerCandidates`
    // we trust that and don't apply this safeguard.
    const useFirstLinkSafeguard = postOwnerCandidates.size === 0;
    let firstLinkSeen = false;

    const harvest = () => {
      let added = 0;
      for (const link of dialog.querySelectorAll('a[href^="/"]')) {
        const username = parseInstagramUsernameFromHref(link.getAttribute('href') || '');
        if (!username) continue;

        // Filter at harvest time so the owner never enters seenUsernames in
        // the first place. Previously the filter only ran AFTER the harvest
        // when copying into `likers[]` — but if the owner ended up first in
        // seenUsernames and the filter didn't match (e.g. bug in owner
        // detection), the bot DMed them.
        if (postOwnerCandidates.has(username)) continue;

        // First-link safeguard: when owner detection failed, drop the very
        // first profile link we ever see in this dialog. It's almost always
        // the post owner (rendered in the dialog's "Liked by [owner]" header).
        if (useFirstLinkSafeguard && !firstLinkSeen) {
          firstLinkSeen = true;
          console.log(`[Futnor Instagram] monitorPostLikers: skipping first link @${username} as likely post owner (safeguard engaged because owner detection returned 0 candidates)`);
          continue;
        }

        if (!seenUsernames.has(username)) {
          seenUsernames.add(username);
          added++;
        }
      }
      return added;
    };

    harvest();
    console.log(`[Futnor Instagram] Initial likers harvested: ${seenUsernames.size}`);

    let earlyReturned = false;
    const STALE_LIMIT = 12; // virtualized lists need more patience before giving up
    let staleRounds = 0;
    let roundsCompleted = 0;
    let lastSeenSize = seenUsernames.size;

    // ── Phase 1: foreground — paginate until we hit FIRST_BATCH_TARGET ──
    while (
      roundsCompleted < MAX_PAGINATION_ROUNDS &&
      staleRounds < STALE_LIMIT &&
      seenUsernames.size < FIRST_BATCH_TARGET
    ) {
      // Big jump to bottom: forces the virtualized list to render the next page.
      // Smaller incremental scrolls don't trigger Instagram's loader reliably.
      const before = scrollContainer.scrollTop;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(randomInt(900, 1400));

      // Secondary nudge to keep the loader fetching the next page
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(randomInt(600, 1000));

      // Some virtualized lists need a tiny scroll-up then back-down to re-trigger
      if (roundsCompleted % 4 === 3) {
        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollHeight - 800);
        await sleep(200);
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(randomInt(800, 1200));
      }

      harvest();
      const grew = seenUsernames.size > lastSeenSize;
      const scrolled = scrollContainer.scrollTop !== before;

      if (!grew && !scrolled) {
        // Nothing happened at all — the list is exhausted
        staleRounds += 2;
      } else if (!grew) {
        staleRounds++;
      } else {
        staleRounds = 0;
      }
      lastSeenSize = seenUsernames.size;
      roundsCompleted++;

      if (roundsCompleted % 5 === 0) {
        console.log(`[Futnor Instagram] Likers pagination round ${roundsCompleted}: ${seenUsernames.size} unique so far (stale=${staleRounds})`);
      }
    }

    // Snapshot what we have so far into the foreground result list.
    // Owner filtering already happened inside harvest() (so `seenUsernames`
    // never contained an owner), so here we only need to drop already-DMed
    // accounts. Iteration order preserves the order Instagram returns them,
    // so the first liker in the dialog is the first DM target.
    for (const username of seenUsernames) {
      if (isInDMHistory(username)) continue;
      if (!likers.includes(username)) likers.push(username);
    }
    console.log(`[Futnor Instagram] monitorPostLikers: first batch ready (${likers.length} usernames after ${roundsCompleted} rounds, ${seenUsernames.size} seen)`);

    // ── Phase 2: BACKGROUND continuation ──
    // If we still have rounds left and didn't fully exhaust the modal, keep
    // paginating asynchronously so the next call on this post returns more.
    const exhausted = staleRounds >= STALE_LIMIT;
    const cacheEntry = window.__futnorLikersBatchCache.get(currentPostKey) || { seen: new Set(), queue: [], done: false, running: false };
    // Merge what we've seen into the cache's seen-set so background loop dedupes correctly
    for (const u of seenUsernames) cacheEntry.seen.add(u);
    cacheEntry.done = exhausted || cacheEntry.done;
    window.__futnorLikersBatchCache.set(currentPostKey, cacheEntry);

    if (!exhausted && roundsCompleted < MAX_PAGINATION_ROUNDS && !cacheEntry.running) {
      cacheEntry.running = true;
      earlyReturned = true;
      // Fire-and-forget: continue scrolling, push new usernames into queue,
      // close dialog when done. We intentionally DO NOT await this.
      (async () => {
        try {
          let bgStale = 0;
          let bgRound = roundsCompleted;
          let bgLastSize = cacheEntry.seen.size;
          while (bgRound < MAX_PAGINATION_ROUNDS && bgStale < STALE_LIMIT) {
            // Bail out if the dialog was closed (user navigated, etc.)
            if (!document.body.contains(dialog)) break;

            const before = scrollContainer.scrollTop;
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            await sleep(randomInt(900, 1400));

            scrollContainer.scrollTop = scrollContainer.scrollHeight;
            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            await sleep(randomInt(600, 1000));

            if (bgRound % 4 === 3) {
              scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollHeight - 800);
              await sleep(200);
              scrollContainer.scrollTop = scrollContainer.scrollHeight;
              scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
              await sleep(randomInt(800, 1200));
            }

            let newAdded = 0;
            for (const link of dialog.querySelectorAll('a[href^="/"]')) {
              const username = parseInstagramUsernameFromHref(link.getAttribute('href') || '');
              if (!username) continue;
              // Same owner filter as the foreground harvest — never queue
              // the post owner up for the next call's drain.
              if (postOwnerCandidates.has(username)) continue;
              if (!cacheEntry.seen.has(username)) {
                cacheEntry.seen.add(username);
                cacheEntry.queue.push(username);
                newAdded++;
              }
            }

            const grew = cacheEntry.seen.size > bgLastSize;
            const scrolled = scrollContainer.scrollTop !== before;
            if (!grew && !scrolled) {
              bgStale += 2;
            } else if (!grew) {
              bgStale++;
            } else {
              bgStale = 0;
            }
            bgLastSize = cacheEntry.seen.size;
            bgRound++;
          }
          cacheEntry.done = true;
          console.log(`[Futnor Instagram] monitorPostLikers (bg): paginated to ${cacheEntry.seen.size} total unique usernames (${cacheEntry.queue.length} queued for next call)`);
        } catch (bgErr) {
          console.warn('[Futnor Instagram] monitorPostLikers background pagination error:', bgErr);
        } finally {
          cacheEntry.running = false;
          // Close the dialog now that background work is finished
          try {
            const closeBtn = dialog.querySelector('svg[aria-label="Close"], button[aria-label="Close"]');
            if (closeBtn) {
              const btn = closeBtn.closest('button') || closeBtn;
              await humanClick(btn);
            } else {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
          } catch {}
        }
      })();
    }

    console.log(`[Futnor Instagram] monitorPostLikers: returning ${likers.length} likers (background continuation: ${earlyReturned ? 'active' : 'no'})`);

    // Close dialog ONLY if no background loop is keeping it alive
    if (!earlyReturned) {
      const closeBtn = dialog.querySelector('svg[aria-label="Close"], button[aria-label="Close"]');
      if (closeBtn) {
        const btn = closeBtn.closest('button') || closeBtn;
        await humanClick(btn);
        await sleep(500);
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(500);
      }
    }
  } catch (e) {
    console.error('[Futnor Instagram] monitorPostLikers error:', e);
  }
  return likers;
}

async function monitorNewFollowers() {
  // Navigate to the user's followers list and extract recent followers
  const followers = [];
  try {
    await refreshDMHistoryCache();

    // We need to know the logged-in user's username
    // Try to get it from the navigation or profile link
    let myUsername = null;

    // Check the nav bar for profile link
    const navProfileLink = document.querySelector('a[href$="/"][role="link"] img[alt*="profile" i]')
      ?.closest('a');
    if (navProfileLink) {
      myUsername = parseInstagramUsernameFromHref(navProfileLink.getAttribute('href') || '');
    }

    // Fallback: look for profile pic in bottom nav
    if (!myUsername) {
      const navLinks = document.querySelectorAll('nav a[href^="/"]');
      for (const link of navLinks) {
        const href = link.getAttribute('href') || '';
        const username = parseInstagramUsernameFromHref(href);
        if (username && link.querySelector('img[alt]')) {
          myUsername = username;
          break;
        }
      }
    }

    // Fallback: from meta tags
    if (!myUsername) {
      try {
        const data = await new Promise(resolve => chrome.storage.local.get({ futnor_active_account: '' }, resolve));
        myUsername = (data.futnor_active_account || '').toLowerCase().trim();
      } catch {}
    }

    if (!myUsername) {
      console.log('[Futnor Instagram] monitorNewFollowers: could not determine logged-in username');
      return followers;
    }

    console.log(`[Futnor Instagram] monitorNewFollowers: checking followers for @${myUsername}`);

    // Navigate to followers page
    const followersUrl = `https://www.instagram.com/${myUsername}/followers/`;
    window.location.href = followersUrl;
    await sleep(3000);

    // Wait for the followers dialog/page to load
    let dialog = null;
    for (let w = 0; w < 15; w++) {
      dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        const links = dialog.querySelectorAll('a[href^="/"]');
        if (links.length >= 1) break;
        dialog = null;
      }
      await sleep(500);
    }

    if (!dialog) {
      console.log('[Futnor Instagram] monitorNewFollowers: followers dialog did not open');
      return followers;
    }

    // Scroll a little to load recent followers (just the top — most recent)
    let scrollContainer = null;
    const divs = dialog.querySelectorAll('div');
    for (const div of divs) {
      const style = window.getComputedStyle(div);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && div.scrollHeight > div.clientHeight + 20) {
        scrollContainer = div;
        break;
      }
    }
    scrollContainer = scrollContainer || dialog;

    for (let s = 0; s < 3; s++) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(800);
    }

    // Extract follower usernames
    const links = dialog.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const username = parseInstagramUsernameFromHref(link.getAttribute('href') || '');
      if (!username) continue;
      if (username === myUsername) continue;
      if (isInDMHistory(username)) continue;
      if (!followers.includes(username)) {
        followers.push(username);
      }
    }

    console.log(`[Futnor Instagram] monitorNewFollowers: found ${followers.length} followers`);

    // Close dialog
    const closeBtn = dialog.querySelector('svg[aria-label="Close"], button[aria-label="Close"]');
    if (closeBtn) {
      const btn = closeBtn.closest('button') || closeBtn;
      await humanClick(btn);
      await sleep(500);
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }

    // Navigate back to the post
    window.history.back();
    await sleep(1500);

  } catch (e) {
    console.error('[Futnor Instagram] monitorNewFollowers error:', e);
  }
  return followers;
}

// ─── Inbox Scanner for Sales Agent ───────────────────────────────────────────

/**
 * Scans the Instagram /direct/inbox/ page for unread DM threads.
 * Returns an array of { username, lastMessage } for threads with unread indicators.
 */
// Pull real @handles out of an inbox row.
//
// v2.4.151: the inbox list shows a person's DISPLAY NAME ("Sbr Health &
// Wellness"), not their handle ("sbr_health_and_wellness"). This function used
// to return that display-name text as `username`, and the backend marks a DM as
// answered with
//     .eq('recipient_username', normalized)
// against handles written by the DM sender. A display name never equals a
// handle, so almost every reply failed to match and the response rate read far
// lower than reality — 0% for any account that has a display name set.
//
// Handles are recoverable from the row itself: the avatar's alt text is
// "<handle>'s profile picture", and getThreadIdentifiers() already mines hrefs
// and @-mentions. We return every candidate and let the backend match whichever
// one corresponds to a real sent DM. Candidates that match nothing update
// nothing, so extra guesses are free.
function extractInboxHandleCandidates(container, link) {
  const candidates = new Set();
  const add = (raw) => {
    const u = normalizeUsername(String(raw || ''));
    // Instagram handles: letters, digits, dot, underscore. This also filters
    // out display names, which almost always contain spaces or punctuation.
    if (u && /^[a-z0-9._]{2,30}$/.test(u)) candidates.add(u);
  };

  // 1. Avatar alt text — the most reliable source, and localized variants all
  //    still contain the bare handle somewhere in the string.
  for (const img of container.querySelectorAll('img[alt]')) {
    const alt = img.getAttribute('alt') || '';
    if (!/profile (picture|photo)|foto del perfil|photo de profil/i.test(alt)) continue;
    const apos = alt.match(/^\s*(.+?)['’]s\s+profile/i);
    if (apos?.[1]) add(apos[1]);
    const trailing = alt.match(/(?:de|of)\s+([A-Za-z0-9._]{2,30})\s*$/i);
    if (trailing?.[1]) add(trailing[1]);
    for (const tok of alt.split(/[\s,]+/)) add(tok);
  }

  // 2. Existing helper — mines the href, nested links and @mentions.
  try { for (const id of getThreadIdentifiers(link)) if (!id.startsWith('thread_')) add(id); } catch {}
  try { for (const id of getThreadIdentifiers(container)) if (!id.startsWith('thread_')) add(id); } catch {}

  // 3. Any literal @handle in the row text.
  for (const m of (container.textContent || '').matchAll(/@([a-z0-9._]{2,30})/gi)) add(m[1]);

  return Array.from(candidates);
}

async function scanInboxForNewDMs() {
  const results = [];
  const seenThreads = new Set();
  try {
    const inboxLinks = document.querySelectorAll('a[href*="/direct/t/"]');

    for (const link of inboxLinks) {
      const container = link.closest('div[role="listitem"], div[class]') || link.parentElement;
      if (!container) continue;

      const href = link.getAttribute('href') || '';
      // One row per thread — Instagram nests several anchors per conversation.
      const threadId = (href.match(/\/direct\/t\/(\d+)/) || [])[1] || href;
      if (seenThreads.has(threadId)) continue;

      // ── Is this a reply from them, or just our own outgoing DM? ────────────
      const hasUnread = !!(
        container.querySelector('[aria-label*="unread" i]')
        || container.querySelector('span[style*="font-weight: 600"]')
      );

      let isBold = false;
      for (const span of container.querySelectorAll('span')) {
        const weight = window.getComputedStyle(span).fontWeight;
        if (parseInt(weight, 10) >= 600 || weight === 'bold') { isBold = true; break; }
      }

      const spans = container.querySelectorAll('span[dir="auto"]');
      const displayName = spans[0]?.textContent?.trim() || '';
      const lastMessage = spans.length > 1
        ? (spans[spans.length - 1]?.textContent?.trim() || '')
        : '';

      // v2.4.151: previously only unread rows counted, so a reply the user had
      // already read on their phone was never recorded. A row where the last
      // message is NOT ours is a reply regardless of read state. Instagram
      // prefixes our own last message with "You:" / "You sent…", so anything
      // without that prefix came from them.
      const lastMessageIsOurs = /^\s*(you:|you sent|you replied|tu:|vous)/i.test(lastMessage);
      const theySpokeLast = lastMessage.length > 0 && !lastMessageIsOurs;

      if (!hasUnread && !isBold && !theySpokeLast) continue;

      const usernameCandidates = extractInboxHandleCandidates(container, link);
      // Prefer a real handle for `username`; fall back to the display name so
      // the sales agent (which keys threads off this field) keeps working.
      const username = usernameCandidates[0] || displayName;
      if (!username) continue;

      seenThreads.add(threadId);
      results.push({ username, usernameCandidates, displayName, lastMessage, href });
    }

    console.log(`[Futnor Instagram] scanInboxForNewDMs: ${results.length} thread(s) with an incoming reply`);
  } catch (e) {
    console.error('[Futnor Instagram] scanInboxForNewDMs error:', e);
  }
  return results;
}

/**
 * Opens a thread and reads the last N messages from the currently active DM thread.
 */
async function readThreadMessages(maxMessages = 10) {
  const messages = [];
  try {
    // Find message containers in the active thread
    const messageEls = document.querySelectorAll('div[role="row"], div[class*="x78zum5"][class*="xdt5ytf"] > div');
    
    const candidates = [];
    for (const el of messageEls) {
      const text = el.textContent?.trim();
      if (!text || text.length < 2) continue;
      
      // Determine if sent or received based on alignment
      const style = window.getComputedStyle(el);
      const isSent = style.alignSelf === 'flex-end' || style.justifyContent === 'flex-end' ||
                     el.closest('[style*="flex-end"]') !== null;
      
      candidates.push({
        text: text.substring(0, 500),
        direction: isSent ? 'sent' : 'received',
      });
    }
    
    // Return last N messages
    return candidates.slice(-maxMessages);
  } catch (e) {
    console.error('[Futnor Instagram] readThreadMessages error:', e);
  }
  return messages;
}

// Register the inbox scanner actions in the message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SALES_AGENT_ACTION') {
    (async () => {
      try {
        switch (msg.action) {
          case 'scanInboxForNewDMs': {
            const threads = await scanInboxForNewDMs();
            sendResponse({ ok: true, threads });
            break;
          }
          case 'readThreadMessages': {
            const messages = await readThreadMessages(msg.maxMessages || 10);
            sendResponse({ ok: true, messages });
            break;
          }
          case 'sendReply': {
            // Sales agent reply — sends message to the currently open thread
            // WITHOUT deduplication checks (we WANT to reply to existing convos)
            const replyMessage = msg.message;
            if (!replyMessage) {
              sendResponse({ ok: false, error: 'No message provided' });
              break;
            }
            
            // Wait for composer to be ready
            let composer = null;
            for (let i = 0; i < 15; i++) {
              composer = getDMComposer();
              if (composer) break;
              await sleep(500);
            }
            
            if (!composer) {
              sendResponse({ ok: false, error: 'No composer found in thread' });
              break;
            }
            
            // Wait for Lexical to initialize
            for (let i = 0; i < 8; i++) {
              if (composer.querySelector('p') || composer.hasAttribute('data-lexical-editor') || composer.tagName === 'TEXTAREA') break;
              await sleep(500);
            }
            
            const threadUser = extractCurrentThreadUsername();
            const formattedMsg = personalizeAndFormatDM(replyMessage, threadUser || '');
            
            let sent = false;
            // Single attempt only — retrying causes duplicate text in the composer
            console.log(`[Futnor Instagram] Sales agent sendReply attempt...`);
            sent = await sendCustomMessage(formattedMsg);
            if (!sent) {
              const cNow = getDMComposer();
              sent = await confirmSendAfterFailure(formattedMsg, cNow || composer, 'sales agent reply');
            }
            
            console.log(`[Futnor Instagram] Sales agent sendReply result: ${sent ? 'sent' : 'failed'}`);
            sendResponse({ ok: sent, status: sent ? 'dm_sent' : 'send_failed' });
            break;
          }
          default:
            sendResponse({ ok: false, error: `Unknown sales agent action: ${msg.action}` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
});

// Check on load if bot or warmup is already running
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (state?.isRunning) showBotBanner('bot');
  else if (state?.warmup?.isRunning) showBotBanner('warmup');
  console.log('[Futnor Instagram] Content script ready. Bot running:', state?.isRunning, 'Warmup running:', state?.warmup?.isRunning);
});

// v2.4.158: read the real version from the manifest. This string was hardcoded
// and last updated at v2.4.149, so every console log since then reported the
// wrong build — which sent debugging down the wrong path more than once.
console.log(
  `[Futnor Instagram] Content script v${(() => {
    try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; }
  })()} loaded and message listener registered ✓`,
);
