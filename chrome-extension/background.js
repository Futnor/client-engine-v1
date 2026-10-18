// Background service worker — manages session state for Instagram & TikTok
// Persists state to chrome.storage.local for resume capability

const DEFAULT_STATE = {
  isRunning: false,
  isPaused: false,
  reconnecting: false,
  platform: 'instagram',
  tier: 'free',
  config: {
    // ── ULTRA-CONSERVATIVE DEFAULTS (tightened v2.4.93+ in response to a
    //    user reporting account suspensions after only 3 DMs while the
    //    comment-after-DM feature was enabled) ───────────────────────────
    // Cold DM outreach via automation violates Instagram's Terms of Use
    // regardless of pacing. These caps + the comment-after-DM kill switch
    // are harm reduction only — not a guarantee against suspension.
    sessionMin: 6,
    sessionMax: 12,
    scrollWeight: 80,              // even more passive activity vs DMs
    likeWeight: 17,
    dmWeight: 3,                   // DMs <3% of total session activity
    minActionDelay: 90,            // 90s minimum between actions (was 45s)
    maxActionDelay: 240,           // up to 4 min — slow human reading pace
    dailyMaxDMs: 6,                // halved from 12 — much safer for cold accounts
    dailyMaxLikes: 30,
    dailyMaxFollows: 5,
    hourlyMaxDMs: 3,               // halved from 6 — kills bursty patterns
    minSessionGapMinutes: 30,      // 30-min cooldown — long enough to discourage
                                   // back-to-back hammering but short enough to
                                   // let real users (and account-recovery tests)
                                   // iterate. The 4h default was a knee-jerk
                                   // reaction to the suspension incident and made
                                   // the bot effectively unusable: every other
                                   // click on Start returned "failed to start
                                   // session" with no obvious reason in the UI.
    requireLikeBeforeDM: true,     // never DM without warming the recipient first
    stopOnActionBlock: true,       // hard-stop on Instagram block/challenge dialogs
    // ── DM pacing ──
    dmCooldownSec: 180,            // 3 min minimum between DMs (was 60s)
    dmBurstSize: 3,                // pause after every 3 DMs (was 5)
    dmBurstPauseSec: 1200,         // 20 min pause between bursts (was 10 min)
    followEnabled: false,
    // ── Post-DM comment behaviour ──
    // OFF BY DEFAULT after this feature was tied to a wave of suspensions.
    // Same-account-DMs-then-comments-on-target's-post is one of the highest
    // signal spam patterns Instagram catches — even when each action is
    // individually safe-paced. Re-enable per-session at your own risk.
    postCommentAfterDmEnabled: false,
  },
  targeting: {
    targetTypes: [],
    hashtags: '',
    location: '',
    targetUsername: '',
    targetPostLink: '',
    customUsernames: [],
  },
  aiTargeting: {
    enabled: false,
    keywords: [],
    contentTags: [],
    targetAudience: '',
    searchTerms: [],
  },
  dmTemplates: [],
  stats: {
    dmsSent: 0,
    likesSent: 0,
    followsSent: 0,
    scrolls: 0,
    elapsedTime: 0,
    sessionTime: 0,
  },
  logs: [],
};

let sessionState = { ...DEFAULT_STATE };
let activeAccountUsername = null; // Scopes DM/processed history per Instagram account

// Normalize whatever tier string the dashboard / billing provider pushed into
// `subscriptionTier` (or a START_SESSION message) to a canonical key. Keep in
// sync with normalizeTier() in popup.js so the session block, the popup badge,
// and any future stats surface all agree on whether a user is paid.
// Rationale: Scale- and Growth-plan users on free trials were being reported
// as `scale_trial` / `growth_trial` / `trialing` — the extension never knew
// those names and the popup labelled them "Free Plan", while the block check
// `tier === 'free'` worked by accident (string inequality) but left reviewers
// reading logs confused about which tier was actually active.
function normalizeTier(raw) {
  if (!raw) return 'free';
  let t = String(raw).toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (!t) return 'free';
  const KNOWN = new Set(['free','trial','starter','scale','growth','pro','business','admin']);
  if (KNOWN.has(t)) return t;
  const trialMatch = t.match(/^(?:trial_|trialing_)?(scale|growth|starter|pro|business)(?:_trial(?:ing)?)?$/);
  if (trialMatch) return `${trialMatch[1]}_trial`;
  if (t === 'trialing' || t === 'on_trial' || t === 'in_trial') return 'trial';
  if (t !== 'free') return 'subscribed';
  return 'free';
}

// True if the (normalized) tier grants session access. Accepts any paid tier
// plus any trial variant — all trials unlock full features until they expire.
function isPaidTier(tier) {
  const n = normalizeTier(tier);
  if (!n || n === 'free') return false;
  return true; // trial / *_trial / starter / scale / growth / pro / business / admin / subscribed
}
let sessionLoopActive = false;
let sessionLoopPromise = null; // Track the running session promise
let pendingSessionStart = null;
let pendingSessionStartFingerprint = null;

// ─── MV3 Service Worker Keepalive ──────────────────────────────────────────
// MV3 service workers terminate after ~30 seconds of inactivity.
// Without a keepalive the dashboard sees the extension as "disconnected"
// whenever there is no active session.  We solve this two ways:
//   1. A persistent alarm (fires every 20s) — survives service worker restarts
//      because chrome.alarms persist in Chrome even after the worker dies.
//   2. A long-lived onConnect port (from content.js on the Instagram tab) —
//      the most reliable mechanism; an open port prevents termination entirely.
const IDLE_KEEPALIVE_ALARM = 'futnor-idle-keepalive';

// Create the alarm on every startup if it doesn't already exist.
// Periodic alarms persist across service worker restarts, so this only
// actually creates it once; subsequent startups are a no-op.
//
// IMPORTANT: chrome.alarms.get() only returns a Promise in Chrome 117+.
// Calling .then() on undefined (older Chrome) throws a synchronous TypeError
// that bypasses .catch() — the alarm is never created and the worker sleeps.
// We use the universal callback form instead, which works on all Chrome versions.
chrome.alarms.get(IDLE_KEEPALIVE_ALARM, (existing) => {
  if (!existing) {
    chrome.alarms.create(IDLE_KEEPALIVE_ALARM, { periodInMinutes: 20 / 60 }); // every 20s
    console.log('[Futnor Background] Idle keepalive alarm created');
  }
});

// Ensure the alarm is also (re)created on install, update, and browser startup.
// Chrome clears alarms when an extension is updated; onInstalled covers that case.
// onStartup covers a fresh browser launch where no SW startup code has run yet.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(IDLE_KEEPALIVE_ALARM, { periodInMinutes: 20 / 60 });
  console.log('[Futnor Background] Keepalive alarm (re)created on install/update');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(IDLE_KEEPALIVE_ALARM, { periodInMinutes: 20 / 60 });
  console.log('[Futnor Background] Keepalive alarm (re)created on browser startup');
});

// Long-lived port from content scripts — keeps the worker alive while a
// platform tab is open with the content script running.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'futnor-keepalive') {
    console.log('[Futnor Background] Keepalive port connected from', port.sender?.tab?.id);
    port.onDisconnect.addListener(() => {
      console.log('[Futnor Background] Keepalive port disconnected');
    });
    // Acknowledge — content script uses this to confirm the worker is alive
    port.onMessage.addListener((msg) => {
      if (msg.type === 'KEEPALIVE_PING') {
        port.postMessage({ type: 'KEEPALIVE_PONG' });
      }
    });
  }
});

// ─── Background-routed timers ─────────────────────────────────────────────
// Chrome throttles setTimeout to 1000ms minimum on hidden/minimized tabs in
// document context, which destroys human-simulation delays for bots running
// in background tabs. Service worker setTimeout is NOT subject to that
// throttling, so content scripts route all delays through here. The host
// page's CSP can also block worker-src blob: (e.g. on Instagram), making
// the older Worker-based unthrottling silently fail; the bg-routed path
// works regardless because it doesn't touch page CSP at all.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'TIMER_REQUEST' && typeof msg.ms === 'number') {
    setTimeout(() => {
      try { sendResponse({ done: true }); } catch {}
    }, Math.max(0, msg.ms));
    return true; // keep the response channel open for the async reply
  }

  // ─── Instagram DM delivery failure (rate limit / action block) ───────────
  // Sent by content.js when the just-sent DM is flagged as undelivered or
  // an "action blocked" / "try again later" modal appears. We treat both as
  // hard rate-limit signals: stop the session immediately, override any
  // active session goal, and surface a clear log/banner message.
  if (msg && msg.type === 'IG_DM_DELIVERY_FAILED') {
    handleDMDeliveryFailure(msg.reason || 'unknown', msg.phrase || '');
    try { sendResponse({ ok: true }); } catch {}
    return false;
  }

  // ─── Instagram COMMENT delivery failure (comment rate limit / block) ─────
  // Sent by content.js when posting a comment surfaces an action-blocked
  // modal or an inline comment-limit phrase. Same hard-stop semantics as the
  // DM failure handler — we do not want to keep firing comments that all
  // fail and accelerate an account-wide block.
  if (msg && msg.type === 'IG_COMMENT_DELIVERY_FAILED') {
    handleCommentDeliveryFailure(msg.reason || 'unknown', msg.phrase || '');
    try { sendResponse({ ok: true }); } catch {}
    return false;
  }
});

// ─── DM delivery failure handler ────────────────────────────────────────────
// Called when Instagram refuses to deliver a DM (red ✕ on the bubble) or
// shows a rate-limit / action-blocked modal. The bot must:
//   1. NOT count the failed DM (handled in content.js — executeValidatedDMFlow
//      returns false, so callers never increment dmsSent)
//   2. Stop the session immediately, even if a sessionDmGoal is active
//   3. Make the reason visible in logs and the live banner
let _futnorLastDeliveryFailureAt = 0;
function handleDMDeliveryFailure(reason, phrase) {
  const now = Date.now();

  // ghost_send: composer cleared but no outgoing bubble rendered. NOT a
  // rate limit — the message just didn't reach IG's server. We must NOT
  // count it (already handled by executeValidatedDMFlow returning false)
  // but we should also NOT hard-stop the whole session over a single
  // network blip. Just log and continue.
  if (reason === 'ghost_send') {
    console.warn('[Futnor Background] Ghost-send detected — DM not counted, continuing session.');
    try {
      if (typeof addLog === 'function') {
        addLog('dm_skipped', `⚠️ DM did not render in chat — not counted (continuing).`);
      }
    } catch {}
    // v2.4.154: one ghost send is a blip; a run of them is Instagram quietly
    // throttling the account before it ever shows a block dialog. The breaker
    // stops the session on the third rather than letting the bot push into a
    // suspension.
    try { noteGhostSendForCircuitBreaker(); } catch (e) {
      console.warn('[Futnor Background] Ghost-send breaker error:', e?.message || e);
    }
    return;
  }

  // Debounce: a single block can fire from both bubble + modal almost
  // simultaneously. Only act on the first signal in any 5-second window.
  if (now - _futnorLastDeliveryFailureAt < 5000) {
    console.log('[Futnor Background] Duplicate delivery-failure signal ignored:', reason);
    return;
  }
  _futnorLastDeliveryFailureAt = now;

  const isModal = reason === 'action_blocked_modal';
  const headline = isModal
    ? '🛑 Instagram action-blocked this account'
    : '🛑 Instagram refused to deliver the DM (rate limit hit)';
  const detail = phrase ? ` — "${phrase}"` : '';

  console.warn('[Futnor Background]', headline, detail);

  try {
    if (typeof addLog === 'function') {
      addLog('session_end', `${headline}${detail} — stopping session immediately to protect the account.`);
    }
  } catch {}

  // Hard-stop the bot loop — every dispatch site checks shouldStop() /
  // sessionState.isRunning between actions, so this kills the session
  // regardless of any active sessionDmGoal.
  try {
    if (sessionState) {
      sessionState.isRunning = false;
      sessionState.isPaused = false;
    }
  } catch {}

  // v2.4.150: record the block so Account Health can see it.
  // Only INSTAGRAM_BLOCK_DETECTED and the engagement monitor wrote
  // `futnor_last_block` — a rate-limit modal or an undelivered DM caught on
  // this path stopped the session but left the health score reading "Healthy",
  // which is the exact blind spot that made the score untrustworthy after a
  // real restriction. Also force the inter-session cooldown: the account has
  // just been told to slow down, so the next Start must not be immediate.
  try {
    chrome.storage.local.set({
      futnor_last_block: {
        reason: isModal ? 'action_blocked_modal' : (reason || 'dm_delivery_failed'),
        signal: phrase || '',
        at: Date.now(),
        platform: sessionState?.platform || 'instagram',
      },
    });
  } catch {}
  try { recordSessionEnd({ force: true }); } catch {}

  try {
    if (typeof updateBannerLive === 'function') {
      updateBannerLive(`${headline}${detail}`);
    }
  } catch {}
}

// Comment-side equivalent of handleDMDeliveryFailure. Same hard-stop, but
// distinct headline so logs / banner make the cause obvious. Shares the
// 5-second debounce window so duplicate signals from inline + modal don't
// double-log.
function handleCommentDeliveryFailure(reason, phrase) {
  const now = Date.now();
  if (now - _futnorLastDeliveryFailureAt < 5000) {
    console.log('[Futnor Background] Duplicate comment-failure signal ignored:', reason);
    return;
  }
  _futnorLastDeliveryFailureAt = now;

  const isModal = reason === 'action_blocked_modal';
  const headline = isModal
    ? '🛑 Instagram action-blocked this account on a comment'
    : '🛑 Instagram refused the comment (comment rate limit hit)';
  const detail = phrase ? ` — "${phrase}"` : '';

  console.warn('[Futnor Background]', headline, detail);
  try {
    if (typeof addLog === 'function') {
      addLog('session_end', `${headline}${detail} — stopping session immediately to protect the account.`);
    }
  } catch {}
  try {
    if (sessionState) {
      sessionState.isRunning = false;
      sessionState.isPaused = false;
    }
  } catch {}
  try {
    if (typeof updateBannerLive === 'function') {
      updateBannerLive(`${headline}${detail}`);
    }
  } catch {}
  // v2.4.150: surface it to Account Health too — see handleDMDeliveryFailure.
  try {
    chrome.storage.local.set({
      futnor_last_block: {
        reason: isModal ? 'comment_action_blocked_modal' : (reason || 'comment_delivery_failed'),
        signal: phrase || '',
        at: Date.now(),
        platform: sessionState?.platform || 'instagram',
      },
    });
  } catch {}
  try { recordSessionEnd({ force: true }); } catch {}
  // Persist a 24h commenting freeze on the active IG account so the next
  // session won't immediately attempt to comment again and re-trigger IG.
  try { noteCommentBlockedNow(); } catch {}
}

// ─── POST-DM AI COMMENTING (v2.4.89+ — anti-detection hardened) ─────────────
// After a SUBSET of successful DMs, leave a personalized AI-generated comment
// on the target's most recent post. The whole flow is wrapped in defense-in-
// depth safety layers because Instagram aggressively flags the perfect
// "1 DM → 1 comment" cadence as bot behavior:
//
//   1. Probabilistic skip — only ~35-55% of DMs ever attempt a comment, with
//      the per-session ratio randomized so two sessions never look identical.
//   2. Daily cap — hard ceiling of comments per IG account per UTC day
//      (12-22, randomized per account so accounts don't share a fingerprint).
//   3. Per-author cooldown — never comment on the same @handle within 14 days.
//   4. Inter-comment cooldown — minimum 8-18 minutes between any two comments
//      on the same account, jittered.
//   5. Action-block circuit breaker — if Instagram surfaced ANY comment
//      block in the last 24h, commenting is paused for the rest of the UTC day.
//   6. Pre-comment dwell ritual — handled inside content.js (scroll, read
//      caption, sometimes read existing comments) before composer opens.
//   7. Slower jittery typing + post-typing review delay — also in content.js.
//
// All persistent state is namespaced per active IG account so multi-account
// users don't share counters / cooldowns.

const COMMENT_DAILY_CAP_MIN = 12;
const COMMENT_DAILY_CAP_MAX = 22;
const COMMENT_INTER_COOLDOWN_MIN_MS = 8 * 60 * 1000;   // 8 min
const COMMENT_INTER_COOLDOWN_MAX_MS = 18 * 60 * 1000;  // 18 min
const COMMENT_PER_AUTHOR_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const COMMENT_BLOCK_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24 h after a block
const COMMENT_SESSION_RATIO_MIN = 0.30;
const COMMENT_SESSION_RATIO_MAX = 0.55;

// In-memory session state — reset on session start.
let _commentSessionRatio = null;       // 0..1 — chance of attempting comment per DM, picked once per session
let _commentLastBlockAt = 0;           // epoch ms of last comment block surfaced

function _commentRand(min, max) { return min + Math.random() * (max - min); }
function _commentRandInt(min, max) { return Math.floor(_commentRand(min, max + 1)); }
function _commentTodayKey() { return new Date().toISOString().slice(0, 10); }

function _activeIgAccountKey() {
  // Falls back to '_default' so we never crash if account detection hasn't run.
  try {
    const u = (sessionState && sessionState.activeAccountUsername) || '';
    const norm = String(u || '').replace(/^@/, '').trim().toLowerCase();
    return norm || '_default';
  } catch { return '_default'; }
}

async function _commentLoadState() {
  try {
    const acct = _activeIgAccountKey();
    const key = `futnor_comment_state_${acct}`;
    const stored = await chrome.storage.local.get([key]);
    const s = stored[key] || {};
    return {
      key,
      acct,
      dayKey: s.dayKey || _commentTodayKey(),
      dayCount: typeof s.dayCount === 'number' ? s.dayCount : 0,
      dayCap: typeof s.dayCap === 'number' ? s.dayCap : _commentRandInt(COMMENT_DAILY_CAP_MIN, COMMENT_DAILY_CAP_MAX),
      lastCommentAt: typeof s.lastCommentAt === 'number' ? s.lastCommentAt : 0,
      authorCooldowns: (s.authorCooldowns && typeof s.authorCooldowns === 'object') ? s.authorCooldowns : {},
      blockedUntil: typeof s.blockedUntil === 'number' ? s.blockedUntil : 0,
    };
  } catch (e) {
    console.warn('[Futnor Background] _commentLoadState failed:', e?.message || e);
    return null;
  }
}

async function _commentSaveState(state) {
  try { await chrome.storage.local.set({ [state.key]: { ...state } }); } catch {}
}

async function _commentRollDayIfNeeded(state) {
  const today = _commentTodayKey();
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.dayCount = 0;
    state.dayCap = _commentRandInt(COMMENT_DAILY_CAP_MIN, COMMENT_DAILY_CAP_MAX);
    // Prune author cooldowns older than the per-author window.
    const cutoff = Date.now() - COMMENT_PER_AUTHOR_COOLDOWN_MS;
    for (const k of Object.keys(state.authorCooldowns)) {
      if (state.authorCooldowns[k] < cutoff) delete state.authorCooldowns[k];
    }
  }
}

// Public hook — called from handleCommentDeliveryFailure so a single block
// disables commenting for the rest of the UTC day on this account.
async function noteCommentBlockedNow() {
  try {
    const s = await _commentLoadState();
    if (!s) return;
    s.blockedUntil = Date.now() + COMMENT_BLOCK_COOLDOWN_MS;
    await _commentSaveState(s);
  } catch {}
  _commentLastBlockAt = Date.now();
}

// Called once per session start (via beginSession etc.) — picks the per-
// session "comment-after-DM" probability so two sessions never share a ratio.
function resetCommentSessionState() {
  _commentSessionRatio = _commentRand(COMMENT_SESSION_RATIO_MIN, COMMENT_SESSION_RATIO_MAX);
  _commentLastBlockAt = 0;
  console.log(`[Futnor Background] comment session ratio: ${(_commentSessionRatio * 100).toFixed(0)}%`);
}

async function postCommentAfterDM(targetUsername) {
  // ─── PERMANENTLY DISABLED (v2.4.112) ─────────────────────────────────
  // The AI commenting feature was implicated in account suspensions and
  // the user explicitly asked for it to be removed. Earlier versions
  // (v2.4.94+) disabled it via a config flag + kill switch, but the call
  // sites and helper code still existed. This function is now a no-op
  // regardless of any flag — leaving the call sites in place so we don't
  // touch the loop-iteration code paths that worked correctly before,
  // but the function returns false immediately. None of the comment-rate
  // tracking, AI generation, or comment-typing code below runs.
  return false;

  // eslint-disable-next-line no-unreachable
  if (!targetUsername) return false;
  const username = String(targetUsername).replace(/^@/, '').trim().toLowerCase();
  if (!username) return false;

  const logSkip = (reason) => {
    try { addLog('dm_skipped', `💬 Comment-after-DM skipped for @${username} — ${reason}`); } catch {}
    console.log(`[Futnor Background] post-DM comment: ${reason} for @${username}`);
  };

  try {
    if (!sessionState.isRunning || (typeof shouldStop === 'function' && shouldStop())) return false;

    // ─── KILL SWITCH (v2.4.93+, hardened in v2.4.97) ─────────────────────
    // Same-account-DMs-then-comments-on-target's-post is one of the highest-
    // signal spam patterns Instagram looks for. After multiple user account
    // suspensions tied to this feature, it is OFF by default and gated by:
    //
    //   1. A GLOBAL chrome.storage.local kill switch
    //      (futnor_disable_post_dm_comment). When this flag is `true`, the
    //      function exits immediately regardless of session config. This
    //      lets an admin force-disable post-DM commenting from the dashboard
    //      / DevTools without needing to push a new extension version.
    //
    //   2. A per-session opt-in (config.postCommentAfterDmEnabled === true)
    //      that must be EXPLICITLY set to `true` to enable. Default false.
    //
    // The dashboard never sets postCommentAfterDmEnabled, so unless a user
    // hand-flips the storage, comments stay off forever.
    try {
      // Race the storage read against a 500 ms timeout so a stuck
      // chrome.storage.local subsystem can never deadlock the post-DM flow.
      // (Highly unlikely but cheap insurance — observed elsewhere in MV3
      //  service workers under heavy load.)
      const overrideStore = await Promise.race([
        chrome.storage.local.get(['futnor_disable_post_dm_comment']),
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (overrideStore?.futnor_disable_post_dm_comment === true) {
        // Hard block — global kill flag set.
        return false;
      }
    } catch {}

    const enabled = sessionState?.config?.postCommentAfterDmEnabled === true;
    if (!enabled) {
      // Silent skip — this is the default, no log spam.
      return false;
    }

    // ─── SAFETY GATE 1: per-session probability ──────────────────────────
    if (_commentSessionRatio == null) resetCommentSessionState();
    if (Math.random() > _commentSessionRatio) {
      // Silent skip — no log spam, this is the dominant case by design.
      return false;
    }

    // ─── SAFETY GATE 2: load persistent state and roll the day ───────────
    const state = await _commentLoadState();
    if (!state) { logSkip('state load failed'); return false; }
    await _commentRollDayIfNeeded(state);

    // ─── SAFETY GATE 3: action-block circuit breaker ─────────────────────
    if (state.blockedUntil && Date.now() < state.blockedUntil) {
      const minsLeft = Math.ceil((state.blockedUntil - Date.now()) / 60000);
      logSkip(`paused after recent comment block (${minsLeft}m remaining)`);
      return false;
    }

    // ─── SAFETY GATE 4: daily cap ────────────────────────────────────────
    if (state.dayCount >= state.dayCap) {
      logSkip(`daily comment cap reached (${state.dayCount}/${state.dayCap})`);
      return false;
    }

    // ─── SAFETY GATE 5: per-author cooldown ──────────────────────────────
    const lastAuthorAt = state.authorCooldowns[username] || 0;
    if (lastAuthorAt && (Date.now() - lastAuthorAt) < COMMENT_PER_AUTHOR_COOLDOWN_MS) {
      const daysLeft = Math.ceil((COMMENT_PER_AUTHOR_COOLDOWN_MS - (Date.now() - lastAuthorAt)) / 86400000);
      logSkip(`already commented on @${username} in last 14d (${daysLeft}d left)`);
      return false;
    }

    // ─── SAFETY GATE 6: inter-comment cooldown ───────────────────────────
    const sinceLast = Date.now() - (state.lastCommentAt || 0);
    const minGap = _commentRandInt(COMMENT_INTER_COOLDOWN_MIN_MS, COMMENT_INTER_COOLDOWN_MAX_MS);
    if (state.lastCommentAt && sinceLast < minGap) {
      const minsLeft = Math.ceil((minGap - sinceLast) / 60000);
      logSkip(`waiting on inter-comment cooldown (${minsLeft}m left)`);
      return false;
    }

    // Step 1: navigate back to the target's profile (DM flow leaves us on /direct/).
    try { addLog('dm', `💬 Looking for a recent post on @${username} to comment on…`); } catch {}
    const navOk = await sendActionToTab('navigateProfile', null, [username]);
    if (!navOk) {
      logSkip('could not navigate to profile');
      return false;
    }
    // Human-like dwell on the profile — varied so requests don't pattern-match.
    await new Promise((r) => setTimeout(r, _commentRandInt(1400, 3200)));

    // Step 2: ask content script for ONLY the recent post URL (no navigation).
    const linkRes = await sendActionToTab('getRecentPostLink');
    const postLink = linkRes && linkRes.postLink;
    if (!postLink) {
      logSkip('no recent post visible on profile');
      return false;
    }

    // Step 3: BACKGROUND drives the navigation to the post page using
    // chrome.tabs.update + navigateTabAndWait. Critical: doing this from
    // the content script via window.location.href would tear down the
    // content script context and lose the in-flight sendResponse.
    const platformTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
    if (!platformTab) {
      logSkip('no Instagram tab available');
      return false;
    }
    const fullPostUrl = postLink.startsWith('http') ? postLink : `https://www.instagram.com${postLink.startsWith('/') ? '' : '/'}${postLink}`;
    const navigated = await navigateTabAndWait(platformTab.id, fullPostUrl);
    if (!navigated) {
      logSkip('post page failed to load');
      return false;
    }
    // Settle delay for IG SPA hydration — varied.
    await new Promise((r) => setTimeout(r, _commentRandInt(1700, 3400)));

    if (!sessionState.isRunning || (typeof shouldStop === 'function' && shouldStop())) return false;

    // Step 4: scrape the post for AI input (caption + image + reel flag).
    const ctxRes = await sendActionToTab('extractPostContext');
    const ctx = ctxRes && ctxRes.context;
    if (!ctx) {
      logSkip('could not read post content');
      return false;
    }

    // Step 5: call the AI edge function for ONE comment.
    const stored = await chrome.storage.local.get([
      'futnor_supabase_token', 'futnor_supabase_url', 'futnor_supabase_anon_key',
    ]);
    const { futnor_supabase_token: token, futnor_supabase_url: baseUrl, futnor_supabase_anon_key: anonKey } = stored;
    if (!token || !baseUrl) {
      logSkip('missing dashboard auth (open the dashboard tab to refresh)');
      return false;
    }
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

    let comment = '';
    try {
      const aiResp = await fetch(`${normalizedBaseUrl}/functions/v1/generate-post-comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': anonKey || token,
        },
        body: JSON.stringify({
          caption: ctx.caption || '',
          imageUrl: ctx.imageUrl || '',
          username,
          isReel: !!ctx.isReel,
        }),
      });
      if (!aiResp.ok) {
        let detail = '';
        try { detail = (await aiResp.text()).slice(0, 120); } catch {}
        logSkip(`AI returned ${aiResp.status}${detail ? ` — ${detail}` : ''}`);
        return false;
      }
      const data = await aiResp.json().catch(() => ({}));
      comment = (data && data.comment) ? String(data.comment).trim() : '';
    } catch (e) {
      logSkip(`AI call failed — ${e?.message || e}`);
      return false;
    }
    if (!comment) {
      logSkip('AI returned an empty comment');
      return false;
    }

    if (!sessionState.isRunning || (typeof shouldStop === 'function' && shouldStop())) return false;

    // Step 6: post the comment with a human "browse the post first" ritual
    // executed inside content.js (scroll the post, dwell on the image, peek at
    // existing comments) BEFORE the composer is touched. This is the single
    // biggest signal IG uses to separate humans from bots — humans never
    // navigate to a post and instantly start typing.
    await new Promise((r) => setTimeout(r, _commentRandInt(900, 2200)));
    const postRes = await sendActionToTab('postCommentOnCurrentPost', comment);
    const posted = postRes === true || postRes?.success === true;
    if (posted) {
      try { addLog('dm', `💬 Commented on @${username}'s recent post: "${comment}"`); } catch {}
      // Persist updated state.
      try {
        state.dayCount += 1;
        state.lastCommentAt = Date.now();
        state.authorCooldowns[username] = Date.now();
        await _commentSaveState(state);
      } catch {}
      return true;
    }
    logSkip('post composer did not accept the comment (Instagram may have hidden it)');
    return false;
  } catch (e) {
    try { addLog('dm_skipped', `💬 Comment-after-DM error for @${username} — ${e?.message || e}`); } catch {}
    console.warn('[Futnor Background] postCommentAfterDM unexpected error:', e?.message || e);
    return false;
  }
}


// ─── Auto-resume warmup after service worker restart ───
(async () => {
  try {
    const data = await chrome.storage.session.get('_warmupPersist');
    const wp = data && data._warmupPersist;
    if (wp && wp.isRunning && wp.startTime && wp.sessionMinutes) {
      const elapsedMs = Date.now() - wp.startTime;
      const totalMs = wp.sessionMinutes * 60 * 1000;
      const remainingMs = totalMs - elapsedMs;
      if (remainingMs > 30000) {
        const remainingMin = Math.ceil(remainingMs / 60000);
        console.log(`[Futnor] Auto-resuming warmup: ${remainingMin} min remaining`);
        runWarmup(wp.sessionMinutes, wp.platform || 'instagram', wp.enableComments || false, wp.startTime);
      } else {
        await chrome.storage.session.remove('_warmupPersist');
      }
    }
  } catch (e) {
    console.log('[Futnor] No warmup to resume:', e.message);
  }
})();

function getSessionStartFingerprint(msg = {}) {
  const platform = msg.platform || sessionState.platform || 'instagram';
  const timestamp = Number(msg.timestamp) || 0;
  return `${msg.type || 'START_SESSION'}:${platform}:${timestamp}`;
}

// ─── Persistent account history (background-side mirrors) ───
// Keys are scoped by active Instagram account to prevent cross-account contamination
const DM_HISTORY_KEY_BASE = 'dm_history';
const PROCESSED_ACCOUNTS_KEY_BASE = 'processed_accounts_history';
// v2.4.147: per-username DM timestamp ledger for the 30-day cooldown.
// Stored as { [normalizedUsername]: epochMs } so the commenter loop can
// short-circuit re-DM attempts on accounts contacted in the last N days
// even when the binary dm_history check would allow them through.
const DM_HISTORY_DATES_KEY_BASE = 'dm_history_dates';
const DM_COOLDOWN_DAYS = 30;
const DM_COOLDOWN_MS = DM_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
let bgDMHistoryCache = new Set();
let bgDMHistoryDatesCache = {};  // { [username]: timestampMs }
let bgProcessedAccountsCache = new Set();
let bgTrackedDMAnalyticsCache = new Set();

function getDMHistoryKey() {
  return activeAccountUsername ? `${DM_HISTORY_KEY_BASE}_${activeAccountUsername}` : DM_HISTORY_KEY_BASE;
}

function getDMHistoryDatesKey() {
  return activeAccountUsername
    ? `${DM_HISTORY_DATES_KEY_BASE}_${activeAccountUsername}`
    : DM_HISTORY_DATES_KEY_BASE;
}

function getProcessedAccountsKey() {
  return activeAccountUsername ? `${PROCESSED_ACCOUNTS_KEY_BASE}_${activeAccountUsername}` : PROCESSED_ACCOUNTS_KEY_BASE;
}

function normalizeHistoryEntry(value) {
  const raw = (value || '').toString().toLowerCase().trim();
  if (!raw) return null;
  if (raw.startsWith('thread_')) return raw;
  return raw.replace(/^@/, '');
}

function normalizeAccountUsername(value) {
  const normalized = normalizeHistoryEntry(value);
  if (!normalized || normalized.startsWith('thread_')) return null;
  return normalized;
}

async function refreshBgDMHistory() {
  try {
    const key = getDMHistoryKey();
    const datesKey = getDMHistoryDatesKey();
    const data = await new Promise(resolve => {
      chrome.storage.local.get({ [key]: [], [datesKey]: {} }, resolve);
    });
    const raw = data[key];
    bgDMHistoryCache = new Set(
      Array.isArray(raw)
        ? raw.map(normalizeHistoryEntry).filter(Boolean)
        : []
    );
    const rawDates = data[datesKey];
    if (rawDates && typeof rawDates === 'object' && !Array.isArray(rawDates)) {
      bgDMHistoryDatesCache = {};
      for (const [k, v] of Object.entries(rawDates)) {
        const nk = normalizeHistoryEntry(k);
        const ts = Number(v);
        if (nk && ts > 0) bgDMHistoryDatesCache[nk] = ts;
      }
    } else {
      bgDMHistoryDatesCache = {};
    }
    console.log(`[Futnor Background] DM history loaded (${key}): ${bgDMHistoryCache.size} entries, ${Object.keys(bgDMHistoryDatesCache).length} dated`);
  } catch {
    bgDMHistoryCache = new Set();
    bgDMHistoryDatesCache = {};
  }
}

// v2.4.147: 30-day cooldown layer. Returns true if `username` was DM'd
// within the last DM_COOLDOWN_DAYS days, regardless of whether it's in the
// binary dm_history Set. Layered protection against re-DMing the same
// account in case the binary history check has stale data.
function wasDMdRecently(username, cooldownMs = DM_COOLDOWN_MS) {
  const normalized = normalizeAccountUsername(username);
  if (!normalized) return false;
  const ts = bgDMHistoryDatesCache[normalized];
  if (!ts || typeof ts !== 'number') return false;
  return (Date.now() - ts) < cooldownMs;
}

function daysSinceDMd(username) {
  const normalized = normalizeAccountUsername(username);
  if (!normalized) return null;
  const ts = bgDMHistoryDatesCache[normalized];
  if (!ts || typeof ts !== 'number') return null;
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

async function refreshBgProcessedAccounts() {
  try {
    const key = getProcessedAccountsKey();
    const data = await new Promise(resolve => {
      chrome.storage.local.get({ [key]: [] }, resolve);
    });
    const raw = data[key];
    bgProcessedAccountsCache = new Set(
      Array.isArray(raw)
        ? raw.map(normalizeAccountUsername).filter(Boolean)
        : []
    );
    console.log(`[Futnor Background] Processed accounts loaded (${key}): ${bgProcessedAccountsCache.size} entries`);
  } catch {
    bgProcessedAccountsCache = new Set();
  }
}

function isInBgDMHistory(username) {
  const normalized = normalizeAccountUsername(username);
  return !!normalized && bgDMHistoryCache.has(normalized);
}

function isInBgProcessedAccounts(username) {
  const normalized = normalizeAccountUsername(username);
  return !!normalized && bgProcessedAccountsCache.has(normalized);
}

// DM-action results from sendActionToTab are either `false` (failure) or the
// full content-script response object `{ success: true, wasFirstContact?: bool }`.
// This helper extracts the first-contact flag for downstream tracking — null
// means the content script didn't capture the snapshot (e.g. legacy paths,
// reconnect recoveries) and the row will remain NULL in dm_tracking.
function extractFirstContactFlag(dmResult) {
  if (dmResult && typeof dmResult === 'object' && typeof dmResult.wasFirstContact === 'boolean') {
    return dmResult.wasFirstContact;
  }
  return null;
}

async function addToBgDMHistory(username, options = {}) {
  const normalized = normalizeAccountUsername(username);
  if (!normalized) return;

  if (!bgDMHistoryCache.has(normalized)) {
    bgDMHistoryCache.add(normalized);
    try {
      const key = getDMHistoryKey();
      await chrome.storage.local.set({ [key]: Array.from(bgDMHistoryCache) });
    } catch (error) {
      console.warn('[Futnor Background] Failed to persist DM history entry:', error?.message || error);
    }
  }

  // v2.4.147: write per-username timestamp for the 30-day cooldown layer.
  // We update on EVERY call (not only first time) so re-attempts refresh
  // the cooldown — the bot should never DM an account contacted within
  // the last 30 days, regardless of why the prior contact happened.
  bgDMHistoryDatesCache[normalized] = Date.now();
  try {
    const datesKey = getDMHistoryDatesKey();
    await chrome.storage.local.set({ [datesKey]: bgDMHistoryDatesCache });
  } catch (error) {
    console.warn('[Futnor Background] Failed to persist DM history timestamp:', error?.message || error);
  }

  // Record timestamp for hourly cap enforcement
  recordDMTimestamp();

  const analyticsKey = `${activeAccountUsername || 'unknown'}:${sessionState.platform || 'instagram'}:${normalized}`;
  if (!bgTrackedDMAnalyticsCache.has(analyticsKey)) {
    bgTrackedDMAnalyticsCache.add(analyticsKey);
    trackDMSentToSupabase(normalized, options);
  }
}

// ─── DM TIMESTAMP LEDGER (HOURLY CAP + DAILY GOAL + SESSION-GAP GUARDS) ─────
// Persisted across service-worker restarts. Holds ~26h of history so:
//   • the rolling 1h cap (isHourlyDMCapHit) sees the last hour
//   • the daily-session goal (getDailyDmsSentCount) sees every DM sent
//     since the user's local midnight — even on the longest legal day
//     (DST fall-back: 25h between local midnights), 26h of retention is
//     enough to never lose today's history.
let dmSentTimestamps = [];
const DM_TIMESTAMPS_KEY = 'futnor_dm_timestamps';
const LAST_SESSION_END_KEY = 'futnor_last_session_end';
const TIMESTAMP_RETENTION_MS = 26 * 60 * 60 * 1000;

(async () => {
  try {
    const stored = await chrome.storage.local.get([DM_TIMESTAMPS_KEY]);
    const arr = stored[DM_TIMESTAMPS_KEY];
    if (Array.isArray(arr)) {
      const cutoff = Date.now() - TIMESTAMP_RETENTION_MS;
      dmSentTimestamps = arr.filter((t) => typeof t === 'number' && t > cutoff);
    }
  } catch {}
})();

function recordDMTimestamp() {
  const now = Date.now();
  const cutoff = now - TIMESTAMP_RETENTION_MS;
  dmSentTimestamps = dmSentTimestamps.filter((t) => t > cutoff);
  dmSentTimestamps.push(now);
  try { chrome.storage.local.set({ [DM_TIMESTAMPS_KEY]: dmSentTimestamps }); } catch {}
}

// ─── DAILY DM CAP HELPERS (v2.4.150) ───────────────────────────────────────
// `dailyMaxDMs === 0` means "no cap" everywhere config is documented, but the
// raw comparisons scattered through runSession read `dmsSent < dailyMaxDMs`,
// which is false at 0 — so an uncapped session silently refused to send any DM
// at all, while one branch read `dailyMaxDMs === 0` as "cap already reached"
// and ended the session immediately. One meaning, one pair of helpers.
function dmCapReached(config) {
  const cap = Number(config?.dailyMaxDMs);
  if (!Number.isFinite(cap) || cap <= 0) return false; // 0 / unset = uncapped
  return (sessionState.stats.dmsSent || 0) >= cap;
}
function dmCapAllowsAnother(config) {
  return !dmCapReached(config);
}

// Returns true if sending another DM right now would breach the hourly cap.
function isHourlyDMCapHit(config) {
  const cap = Number(config?.hourlyMaxDMs);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent = dmSentTimestamps.filter((t) => t > oneHourAgo);
  return recent.length >= cap;
}

// Count DMs sent so far TODAY in the user's LOCAL timezone (i.e. since
// local midnight). Used by the daily-session-goal feature: the goal
// accumulates across every session run today instead of resetting when
// the user starts a new session, so a user with goal=20 who sent 12 in
// session A and 8 in session B will hit the goal at the end of session B
// (not have to send 20 in B alone). The whole counter wipes at the user's
// local midnight — fresh day, fresh count.
//
// `new Date(y, m, d)` constructs a Date at 00:00 local time; calling
// .getTime() gives the epoch ms of that local-midnight boundary. The SW
// runs in the user's machine timezone, so this matches whatever clock the
// user sees on their device.
function getDailyDmsSentCount() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return dmSentTimestamps.filter((t) => t >= todayStart).length;
}

// Milliseconds remaining until the user's next local midnight — used to
// tell the user how long until the goal counter resets when we reject a
// new session for `daily_goal_met`.
function getMsUntilLocalMidnight() {
  const now = new Date();
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return Math.max(0, tomorrowStart - Date.now());
}

// Returns ms remaining in the inter-session cooldown gap, or 0 if none.
//
// CAP (v2.4.109): we clamp the configured gap to MAX_SESSION_GAP_MIN regardless
// of what storage holds. The pre-2.4.109 default of 240min (4h) was a
// kneejerk response to an earlier suspension, persists in existing installs'
// stored config, and produced the "Extension is connected but failed to start
// session" complaint when users naturally tried to restart within the same
// session window. The cooldown still exists — just bounded to something
// usable.
const MAX_SESSION_GAP_MIN = 60;
async function getSessionGapRemainingMs(config) {
  const rawGap = Number(config?.minSessionGapMinutes);
  if (!Number.isFinite(rawGap) || rawGap <= 0) return 0;
  const minGapMin = Math.min(rawGap, MAX_SESSION_GAP_MIN);
  try {
    const stored = await chrome.storage.local.get([LAST_SESSION_END_KEY]);
    const lastEnd = stored[LAST_SESSION_END_KEY];
    if (typeof lastEnd !== 'number') return 0;
    const gapMs = minGapMin * 60 * 1000;
    const remaining = (lastEnd + gapMs) - Date.now();
    return remaining > 0 ? remaining : 0;
  } catch {
    return 0;
  }
}

// Record the session end so the inter-session cooldown gate enforces
// minSessionGapMinutes for the NEXT START_SESSION attempt.
//
// IMPORTANT (v2.4.115): the cooldown only fires when the session actually
// did account-affecting work. If the user clicked Start, saw something
// wrong, and immediately clicked Stop with zero DMs sent, applying a 30-min
// cooldown is pure friction — there was no "automation pattern" to space
// out from. Default behaviour now: skip recording unless at least one DM
// was sent during the session. Callers that need to force the cooldown
// regardless (e.g. INSTAGRAM_BLOCK_DETECTED — where the bot's been flagged
// and we want a forced rest period) can pass `{ force: true }`.
async function recordSessionEnd(options = {}) {
  const force = !!(options && options.force);
  const dmsSent = Number(sessionState?.stats?.dmsSent) || 0;
  if (!force && dmsSent <= 0) {
    console.log('[Futnor Background] Session ended with 0 DMs — skipping cooldown record (no real activity to space out from)');
    return;
  }
  try { await chrome.storage.local.set({ [LAST_SESSION_END_KEY]: Date.now() }); } catch {}
}

// ─── DM PACING (between-DM cooldown + burst pause) ─────────────────────────
// Enforced before every DM send call. Honors:
//   config.dmCooldownSec  — min gap between any two DMs
//   config.dmBurstSize    — after N DMs in this session, take a longer break
//   config.dmBurstPauseSec — how long the burst-pause is
// Tracked per-session in `dmsSinceLastBurst` (in-memory). The cooldown is
// driven by the rolling DM-timestamp ledger so it survives worker restarts.
let dmsSinceLastBurst = 0;

// ─── DELIBERATE-COOLDOWN ACCOUNTING (v2.4.150) ─────────────────────────────
// Time the bot spends *deliberately doing nothing* (per-DM cooldown, burst
// pause, hourly-cap rest) is not session activity — it is the opposite of it.
// runSession subtracts this from wall-clock time when deciding whether the
// session's activity budget is spent, so a long safety pause can no longer
// eat the session and leave the user's DM goal half-finished.
let _sessionCooldownMs = 0;
function resetDmPacingCounters() {
  dmsSinceLastBurst = 0;
  _sessionCooldownMs = 0;
  // Fresh session starts with a clean throttle record.
  try { resetGhostSendStreak(); } catch {}
  _lastOrganicFiller = null;
}
function noteSessionCooldown(ms) { _sessionCooldownMs += Math.max(0, ms); }
function getSessionCooldownMs() { return _sessionCooldownMs; }

// Abortable sleep that books the time as deliberate cooldown.
// Returns false if the session was stopped mid-wait.
async function cooldownSleep(totalMs, chunkMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (!sessionState.isRunning || shouldStop()) {
      noteSessionCooldown(Date.now() - start);
      return false;
    }
    if (sessionState.isPaused) {
      const stillRunning = await waitWhilePaused();
      if (!stillRunning) { noteSessionCooldown(Date.now() - start); return false; }
    }
    await waitMs(Math.min(chunkMs, totalMs - (Date.now() - start)));
  }
  noteSessionCooldown(Date.now() - start);
  return true;
}

// ─── HOURLY DM CAP: REST, DON'T END THE RUN ────────────────────────────────
// Every branch that hit the hourly cap used to do
//     sessionState.isRunning = false; break;
// while logging "pausing to protect account". It did not pause — it killed the
// session. With the shipped defaults (hourlyMaxDMs 3, dailyMaxDMs 6) that made
// the configured DM goal unreachable by construction: the bot always stopped
// at half of what the user asked for and looked like it had crashed.
//
// The cap itself is a real safety rail and stays fully enforced. The fix is to
// wait until the rolling 1-hour window has room again and then carry on —
// which is also exactly what a human doing outreach in sittings looks like.

// ms until the rolling window frees a slot (0 if there is room right now).
function msUntilHourlyCapClears(config) {
  const cap = Number(config?.hourlyMaxDMs);
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const oneHourMs = 60 * 60 * 1000;
  const cutoff = Date.now() - oneHourMs;
  const recent = dmSentTimestamps.filter((t) => t > cutoff).sort((a, b) => a - b);
  if (recent.length < cap) return 0;
  // The send that has to age out for a slot to open is the cap-th most recent.
  const freeingSend = recent[recent.length - cap];
  return Math.max(0, (freeingSend + oneHourMs) - Date.now()) + 1000;
}

// Waits out the hourly cap. Returns true when there is room to send again,
// false if the session was stopped (or the wait would be absurdly long).
async function waitOutHourlyDmCap(addLogFn) {
  const waitFor = msUntilHourlyCapClears(sessionState.config);
  if (waitFor <= 0) return true;
  // Sanity ceiling — the window is one hour, so anything past that is a clock
  // anomaly, not a real cooldown. Bail rather than hang the session forever.
  if (waitFor > 61 * 60 * 1000) return false;

  const mins = Math.max(1, Math.round(waitFor / 60000));
  try {
    addLogFn?.('scroll', `⏳ Hourly DM cap (${sessionState.config.hourlyMaxDMs}/h) reached — resting ~${mins} min, then continuing`);
  } catch {}

  const ok = await cooldownSleep(waitFor, 5000);
  if (!ok) return false;

  try { addLogFn?.('scroll', '✅ Hourly window cleared — resuming outreach'); } catch {}
  return true;
}

async function enforceDmPacingBeforeSend(addLogFn) {
  const cfg = sessionState?.config || {};

  // 0. Hourly cap — rest until the rolling window frees a slot.
  if (isHourlyDMCapHit(cfg)) {
    if (!(await waitOutHourlyDmCap(addLogFn))) return false;
  }
  // 1. Per-DM cooldown
  const cooldownSec = Number(cfg.dmCooldownSec) || 0;
  if (cooldownSec > 0 && Array.isArray(dmSentTimestamps) && dmSentTimestamps.length > 0) {
    const lastDmAt = dmSentTimestamps[dmSentTimestamps.length - 1];
    const elapsedMs = Date.now() - lastDmAt;
    const requiredMs = cooldownSec * 1000;
    if (elapsedMs < requiredMs) {
      const waitMsRemaining = requiredMs - elapsedMs;
      const waitSec = Math.ceil(waitMsRemaining / 1000);
      try {
        addLogFn?.('scroll', `⏳ DM cooldown — waiting ${waitSec}s before next send...`);
      } catch {}
      // Sleep in 1s chunks so the user can stop the session mid-wait.
      if (!(await cooldownSleep(waitMsRemaining, 1000))) return false;
    }
  }

  // 2. Burst pause: after every dmBurstSize DMs, take a longer break.
  const burstSize = Number(cfg.dmBurstSize) || 0;
  const burstPauseSec = Number(cfg.dmBurstPauseSec) || 0;
  if (burstSize > 0 && burstPauseSec > 0 && dmsSinceLastBurst >= burstSize) {
    const pauseMs = burstPauseSec * 1000;
    const minLeft = Math.round(pauseMs / 60000);
    try {
      addLogFn?.('scroll', `⏸️ Burst pause — sent ${burstSize} DMs, taking ~${minLeft}min break...`);
    } catch {}
    if (!(await cooldownSleep(pauseMs, 2000))) return false;
    dmsSinceLastBurst = 0;
  }
  return true;
}

// Called immediately after a DM is confirmed sent.
function recordDmSentForPacing() {
  dmsSinceLastBurst++;
  // A confirmed send clears the silent-throttle streak — see
  // noteGhostSendForCircuitBreaker().
  _ghostSendStreak = 0;
}

// ─── ORGANIC FILLER ACTIONS (v2.4.154) ─────────────────────────────────────
// Ordinary Instagram behaviour dropped between outreach messages so a session
// isn't a pure stream of stranger-directed actions. Reuses the warm-up
// handlers, which the content script already exposes through PERFORM_ACTION.
//
// Note this deliberately does NOT go through sendWarmupActionToTab(): that
// helper early-returns unless warmupState.isRunning, which is exactly why none
// of these behaviours were reachable from a DM session before.
const ORGANIC_FILLER_ACTIONS = [
  { action: 'warmupFeed',                weight: 34, label: '📜 Scrolling the feed for a bit' },
  { action: 'warmupReels',               weight: 26, label: '🎬 Watching a couple of reels' },
  { action: 'warmupExplore',             weight: 18, label: '🔍 Browsing explore' },
  { action: 'warmupCheckNotifications',  weight: 12, label: '🔔 Checking notifications' },
  { action: 'warmupReadComments',        weight: 10, label: '💬 Reading comments on a post' },
];

let _lastOrganicFiller = null;

async function performOrganicFillerAction(addLogFn) {
  if (!sessionState.isRunning || shouldStop()) return false;

  const pool = ORGANIC_FILLER_ACTIONS.filter((a) => a.action !== _lastOrganicFiller);
  const total = pool.reduce((s, a) => s + a.weight, 0);
  let roll = Math.random() * total;
  let picked = pool[pool.length - 1];
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) { picked = item; break; }
  }
  _lastOrganicFiller = picked.action;

  try {
    addLogFn?.('scroll', picked.label);
  } catch {}

  try {
    // Best-effort: a filler action failing must never affect the outreach run.
    await sendActionToTab(picked.action);
  } catch (e) {
    console.warn('[Futnor Background] Organic filler failed (non-fatal):', e?.message || e);
  }

  // Settle before the next target so we don't snap straight back to work.
  if (sessionState.isRunning && !shouldStop()) {
    await waitMs(getRandom(2000, 6000));
  }
  return true;
}

// ─── SILENT-THROTTLE CIRCUIT BREAKER (v2.4.154) ────────────────────────────
// Instagram does not always announce a limit. Before it shows an "Action
// Blocked" dialog it often just... stops delivering. Sends appear to go
// through, the composer clears, and no bubble ever renders — the ghost send
// that v2.4.153 started detecting.
//
// One ghost send is a network blip. Three in a row is Instagram throttling the
// account, and continuing to push is what turns a soft throttle into a
// suspension. This stops the session on the third, records the event for
// Account Health, and forces the inter-session cooldown.
const MAX_CONSECUTIVE_GHOST_SENDS = 3;
let _ghostSendStreak = 0;

function resetGhostSendStreak() { _ghostSendStreak = 0; }

function noteGhostSendForCircuitBreaker() {
  _ghostSendStreak++;
  console.warn(`[Futnor Background] 👻 Ghost-send streak: ${_ghostSendStreak}/${MAX_CONSECUTIVE_GHOST_SENDS}`);
  if (_ghostSendStreak < MAX_CONSECUTIVE_GHOST_SENDS) return false;

  try {
    addLog('session_end',
      `🛑 ${_ghostSendStreak} DMs in a row did not deliver — Instagram is silently throttling this account. `
      + `Stopping now to avoid a suspension.`);
  } catch {}

  try {
    sessionState.isRunning = false;
    sessionState.isPaused = false;
  } catch {}

  // Treat it as a real risk event: Account Health should see it, and the next
  // session must wait out the cooldown rather than starting immediately.
  try {
    chrome.storage.local.set({
      futnor_last_block: {
        reason: 'silent_throttle',
        signal: `${_ghostSendStreak} consecutive undelivered DMs`,
        at: Date.now(),
        platform: sessionState?.platform || 'instagram',
      },
    });
  } catch {}
  try { recordSessionEnd({ force: true }); } catch {}
  try { signalContentScriptStop('SESSION_STOP'); } catch {}

  _ghostSendStreak = 0;
  return true;
}

// Fetch the authoritative subscription tier for the currently-authenticated
// user directly from Supabase, bypassing the dashboard localStorage bridge.
// Motivation: users who start a Scale / Growth / Pro plan free trial and
// then open the extension without ever revisiting the dashboard tab used to
// see "Free Plan" in the popup, because syncTier() only fires when the
// dashboard content script runs.  Querying the `subscribers` table directly
// with the user's access token (Lovable template schema) closes that gap.
// Returns the raw tier string (pre-normalization) or null on any failure —
// the caller decides what to do when we don't know.
async function fetchSubscriberTierFromSupabase() {
  try {
    const stored = await chrome.storage.local.get([
      'futnor_supabase_token',
      'futnor_supabase_url',
      'futnor_supabase_anon_key',
      'futnor_user_id',
    ]);
    const {
      futnor_supabase_token: token,
      futnor_supabase_url: baseUrl,
      futnor_supabase_anon_key: anonKey,
      futnor_user_id: userId,
    } = stored;
    if (!token || !baseUrl || !userId) return null;

    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const headers = {
      'Authorization': `Bearer ${token}`,
      'apikey': anonKey || token,
      'Accept': 'application/json',
    };

    // Primary path: the Lovable-standard `subscribers` table (one row per
    // user_id, carries `subscribed`, `subscription_tier`, `subscription_end`).
    // RLS is expected to let the user read their own row via the access token.
    try {
      const url = `${normalizedBaseUrl}/rest/v1/subscribers`
        + `?user_id=eq.${encodeURIComponent(userId)}`
        + `&select=subscription_tier,subscribed,subscription_end,trial_end,is_trial`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row) {
          const nowMs = Date.now();
          const trialEndMs = row.trial_end ? Date.parse(row.trial_end) : NaN;
          const onTrial = row.is_trial === true
            || (Number.isFinite(trialEndMs) && trialEndMs > nowMs);
          const rawTier = (row.subscription_tier || '').toString().trim();
          if (rawTier) {
            // Trials: annotate the tier so the popup can show "Scale — Free
            // Trial" instead of just "Scale", matching the trial badge path.
            return onTrial ? `${rawTier}_trial` : rawTier;
          }
          if (row.subscribed === true) return 'subscribed';
          if (row.subscribed === false) return 'free';
        }
      }
    } catch (e) {
      console.warn('[Futnor Background] subscribers table query failed:', e?.message || e);
    }

    // Fallback: Lovable's `check-subscription` edge function (if deployed).
    // It reads Stripe and updates the subscribers table, returning the same
    // fields.  Non-fatal if the function is missing (404) — just means this
    // project didn't ship the template function.
    try {
      const res = await fetch(`${normalizedBaseUrl}/functions/v1/check-subscription`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const rawTier = (data?.subscription_tier || '').toString().trim();
        const onTrial = data?.is_trial === true;
        if (rawTier) return onTrial ? `${rawTier}_trial` : rawTier;
        if (data?.subscribed === true) return 'subscribed';
      }
    } catch (e) {
      console.warn('[Futnor Background] check-subscription edge function failed:', e?.message || e);
    }

    return null;
  } catch (e) {
    console.warn('[Futnor Background] fetchSubscriberTierFromSupabase error:', e?.message || e);
    return null;
  }
}

// Refresh `subscriptionTier` in storage from Supabase.  Safe to call whenever
// — it never writes `free` over an existing paid tier unless Supabase is the
// source of truth saying the user lapsed.  Returns the normalized tier or
// null on failure.
async function refreshSubscriptionFromSupabase({ force = false } = {}) {
  const raw = await fetchSubscriberTierFromSupabase();
  if (!raw) return null;
  const normalized = normalizeTier(raw);
  try {
    const stored = await chrome.storage.local.get(['subscriptionTier']);
    const current = normalizeTier(stored.subscriptionTier);
    // Never downgrade a paid tier to free unless we're explicitly forced,
    // to avoid a transient Supabase blip knocking a subscribed user out.
    if (!force && normalized === 'free' && current !== 'free' && current !== 'subscribed') {
      return current;
    }
    if (normalized !== current) {
      await chrome.storage.local.set({ subscriptionTier: normalized });
      sessionState.tier = normalized;
      console.log(`[Futnor Background] Tier refreshed from Supabase: ${current} → ${normalized}`);
    }
  } catch (e) {
    console.warn('[Futnor Background] refreshSubscriptionFromSupabase set failed:', e?.message || e);
  }
  return normalized;
}

async function trackDMSentToSupabase(recipientUsername, options = {}) {
  try {
    const stored = await chrome.storage.local.get(['futnor_supabase_token', 'futnor_supabase_url', 'futnor_supabase_anon_key', 'futnor_user_id', 'futnor_active_account']);
    const { futnor_supabase_token: token, futnor_supabase_url: baseUrl, futnor_supabase_anon_key: anonKey, futnor_user_id: userId } = stored;
    if (!token || !baseUrl || !userId) return;

    const platform = sessionState.platform || 'instagram';
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const instagramAccount = normalizeAccountUsername(activeAccountUsername || stored.futnor_active_account || '') || null;

    // wasFirstContact distinguishes a brand-new outreach DM from a follow-up
    // sent into a thread that already had messages. Only forward when it was
    // explicitly captured by the content script — null/undefined means the
    // caller didn't observe the thread state, so the backend stays NULL and
    // the row is excluded from first-contact-only analytics.
    const wasFirstContact = (options && typeof options === 'object' && typeof options.wasFirstContact === 'boolean')
      ? options.wasFirstContact
      : null;

    const res = await fetch(`${normalizedBaseUrl}/functions/v1/dm-response-tracking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': anonKey || token,
      },
      body: JSON.stringify({
        action: 'record-dm',
        recipients: [recipientUsername],
        platform,
        instagramAccount,
        wasFirstContact,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DM tracking backend failed (${res.status}) ${text}`.trim());
    }
    console.log(`[Futnor Background] DM tracked to Supabase: @${recipientUsername} (firstContact=${wasFirstContact})`);
  } catch (err) {
    console.warn('[Futnor Background] DM tracking failed (non-fatal):', err?.message || err);
  }
}

async function trackDMResponsesToSupabase(recipientUsernames, platform) {
  try {
    const stored = await chrome.storage.local.get(['futnor_supabase_token', 'futnor_supabase_url', 'futnor_supabase_anon_key']);
    const { futnor_supabase_token: token, futnor_supabase_url: baseUrl, futnor_supabase_anon_key: anonKey } = stored;
    if (!token || !baseUrl || recipientUsernames.length === 0) return 0;

    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${normalizedBaseUrl}/functions/v1/dm-response-tracking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': anonKey || token,
      },
      body: JSON.stringify({
        action: 'check-responses',
        recipients: recipientUsernames.map((u) => u.toLowerCase()),
        platform: platform || 'instagram',
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Response tracking backend failed (${resp.status}) ${text}`.trim());
    }
    let updated = 0;
    try {
      const body = await resp.json();
      updated = Number(body?.updated) || 0;
    } catch {}
    console.log(`[Futnor Background] Response tracking: checked ${recipientUsernames.length}, marked ${updated} as responded`);
    return updated;
  } catch (err) {
    console.warn('[Futnor Background] Response tracking failed (non-fatal):', err?.message || err);
    return 0;
  }
}

// ─── Load DM scripts straight from Supabase (popup-initiated path) ───────
// Background can fetch the user's active script bulk directly when the
// dashboard isn't open. Without this, the popup's Start button was useless
// in any fresh-SW state: dmTemplates was empty, START_SESSION rejected with
// missing_dm_script, and the only fix was to open the dashboard and click
// Start there first. Now the popup can start a session on its own — the SW
// reads the same outreach_profiles rows the dashboard would and seeds
// sessionState.dmTemplates before the missing-scripts gate.
//
// Returns the script array (possibly empty). Mirrors the query order the
// dashboard's startSession uses (useBotSession.ts):
//   1) script-bulk + account:<handle>   (per-account bulk)
//   2) dm-scripts is_active=true        (legacy global, only if no account)
async function fetchScriptsFromSupabase(platform, activeAccount) {
  try {
    const stored = await chrome.storage.local.get([
      'futnor_supabase_token',
      'futnor_supabase_url',
      'futnor_supabase_anon_key',
    ]);
    const token = stored.futnor_supabase_token;
    const baseUrl = stored.futnor_supabase_url;
    const anonKey = stored.futnor_supabase_anon_key;
    if (!token || !baseUrl) {
      console.log('[Futnor Background] fetchScriptsFromSupabase: no auth (dashboard never opened?)');
      return [];
    }
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const platformParam = encodeURIComponent(platform || 'instagram');
    const account = (activeAccount || '').toLowerCase().replace(/^@/, '').trim();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'apikey': anonKey || token,
      'Accept': 'application/json',
    };

    const parseRow = (raw) => {
      if (!raw || typeof raw !== 'string') return [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((s) => typeof s === 'string')
            .map((s) => s.replace(/\r\n?/g, '\n'))
            .filter((s) => s.trim().length > 0);
        }
        if (typeof parsed === 'string' && parsed.trim()) return [parsed.replace(/\r\n?/g, '\n')];
      } catch {
        if (raw.trim()) return [raw.replace(/\r\n?/g, '\n')];
      }
      return [];
    };

    // 1) Per-account script-bulk
    if (account) {
      const tagsArray = encodeURIComponent(`{script-bulk,"account:${account}"}`);
      const url = `${normalizedBaseUrl}/rest/v1/outreach_profiles?select=custom_message,content_tags&platform=eq.${platformParam}&content_tags=cs.${tagsArray}&order=created_at.desc`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const scripts = parseRow(row.custom_message);
            if (scripts.length > 0) {
              console.log(`[Futnor Background] fetchScriptsFromSupabase: loaded ${scripts.length} from per-account bulk @${account}`);
              return scripts;
            }
          }
        }
      } else {
        console.warn(`[Futnor Background] fetchScriptsFromSupabase: per-account bulk query failed ${res.status}`);
      }
    }

    // 2) Legacy fallback — only when no active account is set (single-account legacy users)
    if (!account) {
      const tag = platform === 'tiktok' ? 'comment-scripts' : 'dm-scripts';
      const tagsArray = encodeURIComponent(`{${tag}}`);
      const url = `${normalizedBaseUrl}/rest/v1/outreach_profiles?select=custom_message&platform=eq.${platformParam}&is_active=eq.true&content_tags=cs.${tagsArray}&order=created_at.desc&limit=1`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const scripts = parseRow(row.custom_message);
            if (scripts.length > 0) {
              console.log(`[Futnor Background] fetchScriptsFromSupabase: loaded ${scripts.length} from legacy fallback`);
              return scripts;
            }
          }
        }
      }
    }
    return [];
  } catch (err) {
    console.warn('[Futnor Background] fetchScriptsFromSupabase error:', err?.message || err);
    return [];
  }
}

// ─── Independent response-rate inbox scan ─────────────────────────────────
// Scans the IG inbox for unread threads and marks any matching dm_tracking
// rows as responded. Previously this only ran inside the Sales Agent loop,
// so users who never enabled Sales Agent saw 0% response rate even when
// they had real replies. Now it runs:
//   • automatically at session end (after every bot session)
//   • on demand when the dashboard fires SCAN_INBOX_RESPONSES
//   • on a 30-minute periodic alarm while the IG tab is open
let _futnorInboxScanInFlight = false;
async function scanInboxForResponses({ navigate = true } = {}) {
  if (_futnorInboxScanInFlight) {
    console.log('[Futnor Background] Inbox scan already in progress, skipping');
    return { ok: false, reason: 'in_flight', updated: 0 };
  }
  _futnorInboxScanInFlight = true;
  try {
    const platform = sessionState.platform || 'instagram';
    if (platform !== 'instagram') {
      return { ok: false, reason: 'unsupported_platform', updated: 0 };
    }

    const tab = await getOrCreatePlatformTab('instagram', { createIfMissing: false });
    if (!tab?.id) {
      console.log('[Futnor Background] Inbox scan skipped — no IG tab');
      return { ok: false, reason: 'no_tab', updated: 0 };
    }

    // Only navigate to /direct/inbox/ if the user isn't already on a DM page.
    // Otherwise we'd yank them off whatever profile / post they're viewing.
    const onDirect = (tab.url || '').includes('/direct/');
    if (navigate && !onDirect) {
      try {
        await new Promise((resolve) => {
          chrome.tabs.update(tab.id, { url: 'https://www.instagram.com/direct/inbox/' }, () => {
            if (chrome.runtime.lastError) console.warn('[Futnor Background] Inbox nav error:', chrome.runtime.lastError.message);
            resolve();
          });
        });
        await waitMs(2500);
      } catch (e) {
        console.warn('[Futnor Background] Inbox navigation failed:', e?.message || e);
      }
    } else if (!navigate && !onDirect) {
      console.log('[Futnor Background] Inbox scan skipped — not on /direct/ and navigate=false');
      return { ok: false, reason: 'not_on_inbox', updated: 0 };
    }

    let unreadThreads = [];
    try {
      const response = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 15000);
        chrome.tabs.sendMessage(tab.id, { type: 'SALES_AGENT_ACTION', action: 'scanInboxForNewDMs' }, (res) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            console.log('[Futnor Background] Inbox scan message error:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(res);
          }
        });
      });
      if (response?.ok && Array.isArray(response.threads)) {
        unreadThreads = response.threads;
      }
    } catch (e) {
      console.warn('[Futnor Background] Inbox scan failed:', e?.message || e);
    }

    // v2.4.151: forward every handle candidate the inbox row yielded, not just
    // the single best guess. The backend marks a DM answered only where a
    // candidate equals a `recipient_username` already on file for this user, so
    // extra candidates cannot create a false positive — but a missing one loses
    // a real reply, which is what kept the response rate reading near zero.
    const usernames = Array.from(new Set(
      unreadThreads
        .flatMap((t) => {
          const list = Array.isArray(t?.usernameCandidates) ? t.usernameCandidates : [];
          return [...list, t?.username];
        })
        .filter(Boolean)
        .map((u) => String(u).toLowerCase().replace(/^@/, '').trim())
        .filter(Boolean)
    ));
    if (usernames.length === 0) {
      return { ok: true, updated: 0, scanned: 0 };
    }

    const updated = await trackDMResponsesToSupabase(usernames, 'instagram');
    if (updated > 0) {
      try { addLog('dm', `📬 ${updated} new response${updated === 1 ? '' : 's'} detected`); } catch {}
    }
    return { ok: true, updated, scanned: usernames.length };
  } finally {
    _futnorInboxScanInFlight = false;
  }
}

async function addToBgProcessedAccounts(username) {
  const normalized = normalizeAccountUsername(username);
  if (!normalized || bgProcessedAccountsCache.has(normalized)) return;

  bgProcessedAccountsCache.add(normalized);
  try {
    const key = getProcessedAccountsKey();
    await chrome.storage.local.set({ [key]: Array.from(bgProcessedAccountsCache) });
  } catch (error) {
    console.warn('[Futnor Background] Failed to persist processed account entry:', error?.message || error);
  }
}

// ─── Persistence helpers ───
const SESSION_STATE_KEY_BASE = 'futnor_session';

function getSessionStateKey(accountOverride = activeAccountUsername) {
  const normalized = normalizeAccountUsername(accountOverride);
  return normalized ? `${SESSION_STATE_KEY_BASE}_${normalized}` : SESSION_STATE_KEY_BASE;
}

function resetSessionState(tierOverride = sessionState.tier || DEFAULT_STATE.tier) {
  sessionState = {
    ...DEFAULT_STATE,
    tier: tierOverride,
    config: { ...DEFAULT_STATE.config },
    targeting: { ...DEFAULT_STATE.targeting },
    aiTargeting: { ...DEFAULT_STATE.aiTargeting },
    dmTemplates: [],
    stats: { ...DEFAULT_STATE.stats },
    logs: [],
  };
}

function sanitizeDMTemplates(rawTemplates) {
  const templates = Array.isArray(rawTemplates)
    ? rawTemplates
    : (typeof rawTemplates === 'string' ? [rawTemplates] : []);

  return templates
    .map((template) => (typeof template === 'string' ? template.replace(/\r\n?/g, '\n') : ''))
    .filter((template) => template.trim().length > 0);
}

function saveState(accountOverride = activeAccountUsername) {
  const key = getSessionStateKey(accountOverride);
  chrome.storage.local.set({
    [key]: {
      accountUsername: normalizeAccountUsername(accountOverride),
      platform: sessionState.platform,
      tier: sessionState.tier,
      config: sessionState.config,
      targeting: sessionState.targeting,
      aiTargeting: sessionState.aiTargeting,
      dmTemplates: sessionState.dmTemplates || [],
      stats: sessionState.stats,
      logs: sessionState.logs.slice(0, 50),
      isRunning: sessionState.isRunning,
      isPaused: sessionState.isPaused,
      reconnecting: sessionState.reconnecting,
      savedAt: Date.now(),
    }
  });
}

async function loadState(accountOverride = activeAccountUsername) {
  const key = getSessionStateKey(accountOverride);
  // RACE GUARD (v2.4.104): if a START_SESSION is mid-flight, the handler has
  // already loaded fresh dmTemplates from the dashboard payload into memory.
  // Persisting hasn't happened yet, so the row at `key` is the pre-session
  // state with empty (or stale) templates. Preserve the freshly-loaded
  // in-memory templates across the storage read so runSession sees them.
  const preservedDmTemplates = pendingSessionStart && Array.isArray(sessionState?.dmTemplates) && sessionState.dmTemplates.length > 0
    ? [...sessionState.dmTemplates]
    : null;
  return new Promise((resolve) => {
    chrome.storage.local.get({ [key]: null, subscriptionTier: null }, (result) => {
      const storedState = result[key];
      const resolvedTier = result.subscriptionTier || storedState?.tier || sessionState.tier || DEFAULT_STATE.tier;

      resetSessionState(resolvedTier);

      if (storedState) {
        sessionState.platform = storedState.platform || 'instagram';
        sessionState.config = sanitizeSessionConfig(storedState.config);
        sessionState.targeting = { ...DEFAULT_STATE.targeting, ...storedState.targeting };
        sessionState.aiTargeting = { ...DEFAULT_STATE.aiTargeting, ...storedState.aiTargeting };
        sessionState.dmTemplates = Array.isArray(storedState.dmTemplates) ? storedState.dmTemplates : [];
        sessionState.stats = { ...DEFAULT_STATE.stats, ...storedState.stats };
        sessionState.logs = Array.isArray(storedState.logs) ? storedState.logs : [];
        const restorePausedSession = Boolean(storedState.isRunning && storedState.isPaused);
        sessionState.isRunning = restorePausedSession;
        sessionState.isPaused = restorePausedSession;
        sessionState.reconnecting = false;
        sessionState.tier = storedState.tier || resolvedTier;
      }

      if (result.subscriptionTier) {
        sessionState.tier = result.subscriptionTier;
      }

      // Restore in-memory templates that a concurrent START_SESSION handler
      // had already loaded — see the preserve block at the top of loadState.
      if (preservedDmTemplates && preservedDmTemplates.length > 0) {
        console.log(`[Futnor Background] loadState preserved ${preservedDmTemplates.length} dmTemplate(s) from in-flight START_SESSION`);
        sessionState.dmTemplates = preservedDmTemplates;
      }

      resolve();
    });
  });
}

// Listen for CONTENT_SCRIPT_READY signals from content scripts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CONTENT_SCRIPT_READY' && msg.platform) {
    console.log(`[Futnor Background] Content script ready signal from ${msg.platform} tab`);
    // If a session is running but reconnecting, attempt recovery
    if (sessionState.isRunning && sessionState.reconnecting) {
      console.log('[Futnor Background] Session reconnecting — attempting auto-recovery via CONTENT_SCRIPT_READY');
      handleExtensionReconnect('content_script_ready_signal');
    }
  }
});

// Load saved state and warm caches on startup
(async () => {
  const data = await new Promise((resolve) => {
    chrome.storage.local.get({ futnor_active_account: null }, resolve);
  });

  activeAccountUsername = normalizeAccountUsername(data?.futnor_active_account) || null;
  if (activeAccountUsername) {
    console.log('[Futnor Background] Active account restored:', activeAccountUsername);
  }

  await loadState(activeAccountUsername);
  await refreshBgDMHistory();
  await refreshBgProcessedAccounts();

  // Proactive first-detection for any IG tab already open when the SW wakes.
  // Scripting-fallback in the helper handles the case where the extension was just installed
  // after the IG tab had already loaded (content script not injected yet).
  detectAndSyncActiveAccount('instagram').catch(() => {});
  // Keep retrying for ~2 min so a slow IG hydrate eventually resolves.
  startActiveAccountDetectionPoll();

  // Refresh subscription tier from Supabase whenever the SW wakes — covers the
  // case where the user started a Scale/Growth trial on the dashboard but
  // hasn't reopened that tab, so the dashboard bridge never fired syncTier().
  // Without this, the popup keeps showing "Free Plan" indefinitely.
  refreshSubscriptionFromSupabase().catch(() => {});
})();

// ─── Sync from dashboard website ───
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.subscriptionTier) {
    // Normalize on ingress so the session block, popup badge, and stored
    // state never disagree about a scale/growth trial vs. literal 'free'.
    sessionState.tier = normalizeTier(changes.subscriptionTier.newValue);
    saveState();
  }

  // When the auth token or user_id first arrives (right after the user signs
  // in on the dashboard), refresh the tier from Supabase.  This is what
  // catches a trial user who subscribed on the dashboard, closed that tab,
  // and opened the extension — without this, the popup has nothing to show.
  if (changes.futnor_supabase_token?.newValue || changes.futnor_user_id?.newValue) {
    refreshSubscriptionFromSupabase().catch(() => {});
  }

  // Update active account if changed and reload caches + session state.
  //
  // NOTE (v2.4.48): a revert guard added in v2.4.47 (refuse any non-null →
  // different-non-null transition) was removed. It permanently trapped users
  // whose storage held a stale/bad value — the background would keep
  // reverting every subsequent correct detection. Legitimate account
  // switches (user logs into a different IG account in Chrome) were blocked
  // the same way. The content-script guards (URL-match + unsafe-surface)
  // plus the `once-set, never overwrite via auto-detect` rule inside
  // `detectAndSyncActiveAccount` are enough to stop bad writes without
  // losing the ability to recover.
  if (changes.futnor_active_account) {
    const newAccount = normalizeAccountUsername(changes.futnor_active_account.newValue) || null;
    if (newAccount !== activeAccountUsername) {
      console.log(`[Futnor Background] Active account changed via storage: ${activeAccountUsername} → ${newAccount}`);
      activeAccountUsername = newAccount;
      // RACE GUARD (v2.4.104): if a START_SESSION is in flight, the handler has
      // already loaded `sessionState.dmTemplates` from the dashboard payload but
      // hasn't yet persisted it via saveState(). Calling loadState() here would
      // call resetSessionState() (which wipes dmTemplates), then read the stale
      // pre-START_SESSION row from storage — clobbering the templates and
      // making runSession start with an empty script list ("No DM scripts
      // found"). Instead, just refresh the per-account history caches; the
      // pending START_SESSION will saveState() with the correct templates.
      (async () => {
        if (pendingSessionStart) {
          console.log('[Futnor Background] Skipping loadState during pending START_SESSION — preserving in-memory dmTemplates');
          await Promise.all([
            refreshBgDMHistory(),
            refreshBgProcessedAccounts(),
          ]);
          return;
        }
        await Promise.all([
          loadState(newAccount),
          refreshBgDMHistory(),
          refreshBgProcessedAccounts(),
        ]);
        saveState(newAccount);
      })();
    }
  }

  // Listen for changes to the current account's history keys
  const dmKey = getDMHistoryKey();
  const paKey = getProcessedAccountsKey();

  if (changes[dmKey]) {
    const incoming = changes[dmKey].newValue;
    bgDMHistoryCache = new Set(
      Array.isArray(incoming)
        ? incoming.map(normalizeHistoryEntry).filter(Boolean)
        : []
    );
  }

  if (changes[paKey]) {
    const incoming = changes[paKey].newValue;
    bgProcessedAccountsCache = new Set(
      Array.isArray(incoming)
        ? incoming.map(normalizeAccountUsername).filter(Boolean)
        : []
    );
  }

  // Sync config from website when not running
  if (changes.futnor_sync && !sessionState.isRunning) {
    const data = changes.futnor_sync.newValue;
    if (data?.config) {
      const wc = data.config;
      sessionState.config = sanitizeSessionConfig({
        ...sessionState.config,
        sessionMin: wc.sessionMin ?? sessionState.config.sessionMin,
        sessionMax: wc.sessionMax ?? sessionState.config.sessionMax,
        scrollWeight: wc.scrollWeight ?? sessionState.config.scrollWeight,
        likeWeight: wc.likeWeight ?? sessionState.config.likeWeight,
        dmWeight: wc.dmWeight ?? sessionState.config.dmWeight,
        minActionDelay: wc.minActionDelay ?? sessionState.config.minActionDelay,
        maxActionDelay: wc.maxActionDelay ?? sessionState.config.maxActionDelay,
        dailyMaxDMs: wc.dailyMaxDMs ?? sessionState.config.dailyMaxDMs,
        dailyMaxLikes: wc.dailyMaxLikes ?? sessionState.config.dailyMaxLikes,
        dailyMaxFollows: wc.dailyMaxFollows ?? sessionState.config.dailyMaxFollows,
        followEnabled: wc.followEnabled !== undefined ? !!wc.followEnabled : sessionState.config.followEnabled,
        dmMode: wc.dmMode ?? sessionState.config.dmMode ?? 'human',
      });
      sessionState.platform = wc.platform || sessionState.platform;
      const syncedTemplates = sanitizeDMTemplates(wc.dmTemplates);
      if (syncedTemplates.length > 0) {
        sessionState.dmTemplates = syncedTemplates;
        console.log('[Futnor Background] Synced DM templates from dashboard:', syncedTemplates.length);
      }
      if (wc.aiTargeting) {
        sessionState.aiTargeting = { ...DEFAULT_STATE.aiTargeting, ...wc.aiTargeting };
      }
      if (wc.targeting) {
        sessionState.targeting = { ...DEFAULT_STATE.targeting, ...wc.targeting };
      }
    }
    if (data?.stats) {
      sessionState.stats = { ...sessionState.stats, ...data.stats };
    }
    saveState();
  }
});

// ─── Engine ───
const PLATFORM_URLS = {
  instagram: 'https://www.instagram.com/*',
  tiktok: 'https://www.tiktok.com/*',
  whatsapp: 'https://web.whatsapp.com/*',
};

const PLATFORM_HOME_URLS = {
  instagram: 'https://www.instagram.com',
  tiktok: 'https://www.tiktok.com',
  whatsapp: 'https://web.whatsapp.com/',
};

const PLATFORM_DOMAIN_MATCHERS = {
  instagram: 'instagram.com',
  tiktok: 'tiktok.com',
  whatsapp: 'web.whatsapp.com',
};

const RESERVED_IG_PATH_SEGMENTS = new Set([
  'accounts', 'about', 'explore', 'direct', 'reels', 'stories', 'p', 'reel', 'tv', 'tags', 'locations'
]);

let preferredInstagramTabId = null;

// ─── Active-account detection ───
// Store the detected logged-in username for a platform tab. Runs proactively on tab load
// and at extension startup so the dashboard sees the active account before any session starts.

// Inline detection probe — executed in the IG page context via
// chrome.scripting.executeScript when the content script isn't loaded yet
// (extension just installed, old discarded tab, etc). Mirrors the shared
// detection in instagram/content.js so both paths accept the same signals.
function detectIgUsernameInPage() {
  try {
    const RESERVED = new Set([
      'explore','reels','direct','accounts','p','stories','tv','about','shop',
      'developer','legal','privacy','emails','tags','locations','web','s','oauth',
      'api','graphql','channel','challenge','nometa','ads','business','creators',
      'press','jobs','help','invites','nametag','accounts_center',
    ]);
    const ok = (u) => !!u && !u.includes('/') && !RESERVED.has(u) && /^[a-z0-9._]{2,30}$/.test(u);
    const h2u = (el) => {
      const href = el?.getAttribute('href') || '';
      const cleaned = href.replace(/^\/+|\/+$/g, '').toLowerCase();
      if (!cleaned || cleaned.includes('/')) return null;
      return cleaned;
    };

    // Same-origin reject rule: a detected username that equals the first URL
    // path segment is almost certainly the profile we're *viewing* — which
    // happens constantly during commenters targeting, when the bot navigates
    // to each commenter's profile to DM them. Only accept such a match on
    // the logged-in user's own profile (verified by the "Edit profile"
    // affordance).  See content.js:detectedMatchesViewedProfile for detail.
    // HARDENED (v2.4.47): require (a) a strict /<handle>/ URL, and (b) an
    // anchor pointing at /accounts/edit/ OR an element inside <main> whose
    // *exact* trimmed textContent matches a locale "Edit profile" label.
    // The old regex-on-textContent was false-positive on commenter profiles
    // whose bios/highlights contained matching words and let Method 4
    // return the visited handle as the logged-in username.
    const OWN_PROFILE_LABELS = new Set([
      'edit profile','editar perfil','profil bearbeiten','profil anpassen',
      'modifier le profil','modifica profilo','profiel bewerken',
      'editar o perfil','perfil editar',
    ]);
    const isOwnProfile = () => {
      try {
        const path = (location && location.pathname) || '';
        if (!/^\/[a-z0-9._]{1,30}\/?$/i.test(path)) return false;
        const handle = path.split('/').filter(Boolean)[0]?.toLowerCase() || '';
        if (!handle || RESERVED.has(handle)) return false;
        if (document.querySelector('a[href="/accounts/edit/"]')) return true;
        if (document.querySelector('a[href^="/accounts/edit/"]')) return true;
        const main = document.querySelector('main, [role="main"]');
        if (!main) return false;
        const els = main.querySelectorAll('a, button, div[role="button"]');
        for (const el of els) {
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (txt && OWN_PROFILE_LABELS.has(txt)) return true;
        }
      } catch {}
      return false;
    };
    const isUnsafeSurface = () => {
      try {
        const path = (location && location.pathname) || '';
        if (/^\/(p|reel|reels|tv|explore|stories|direct)\b/.test(path)) return true;
        const parts = path.split('/').filter(Boolean);
        if (parts.length >= 1 && !RESERVED.has(parts[0]) && !isOwnProfile()) return true;
        const ownProfileLink = document.querySelector('nav a[href^="/"], [role="navigation"] a[href^="/"]');
        if (!ownProfileLink && !isOwnProfile()) return true;
        return false;
      } catch {
        return false;
      }
    };
    // NOTE (v2.4.48): removed early `if (isUnsafeSurface()) return null;`.
    // Nav-scoped methods below (aria-Profile link, avatar-in-nav, nav/[role=navigation] links)
    // always surface the logged-in user even while `main` is showing a
    // commenter's profile or a post. The `accept()` wrapper + `isOwnProfile()`
    // gate on Method 4 are enough to stop viewed-profile leaks. Short-
    // circuiting on `isUnsafeSurface()` was blocking correct detections and,
    // on non-English IG locales where `isOwnProfile()` can't prove own-profile,
    // even killed detection on the user's own profile page.
    const urlSeg = (() => {
      try {
        const parts = location.pathname.split('/').filter(Boolean);
        return (parts[0] || '').toLowerCase();
      } catch { return ''; }
    })();
    const notViewedProfile = (u) => {
      if (!u) return false;
      if (urlSeg && urlSeg === u && !RESERVED.has(urlSeg) && !isOwnProfile()) return false;
      return true;
    };
    const accept = (u) => (ok(u) && notViewedProfile(u)) ? u : null;

    // aria-labeled sidebar Profile entry (many locales).
    const aria = document.querySelector(
      'a[aria-label^="Profile" i][href^="/"], a[aria-label^="Profil" i][href^="/"], ' +
      'a[aria-label^="Perfil" i][href^="/"], a[aria-label^="Profiel" i][href^="/"], ' +
      'a[aria-label^="Profilo" i][href^="/"]'
    );
    if (aria) { const u = accept(h2u(aria)); if (u) return u; }

    // Avatar image inside the nav → enclosing anchor is always the logged-in user.
    const avatarImgs = document.querySelectorAll(
      'img[alt*="profile picture" i], img[alt*="profile photo" i], ' +
      'img[alt*="perfil" i], img[alt*="Profilbild" i], img[alt*="profile" i]'
    );
    for (const img of avatarImgs) {
      const a = img.closest('a[href^="/"]');
      if (!a) continue;
      if (!a.closest('nav, [role="navigation"]')) continue;
      const u = accept(h2u(a));
      if (u) return u;
    }

    // Nav-scoped links in general — IG only puts the logged-in user's profile
    // link inside nav / navigation landmarks.
    // Do NOT include `header a[...]`: /p/ and /reel/ pages put the post
    // AUTHOR's profile link inside <article><header>, which would clobber the
    // real logged-in user with the commenter-target account.
    const navLinks = document.querySelectorAll(
      'nav a[href^="/"], [role="navigation"] a[href^="/"]'
    );
    for (const l of navLinks) { const u = accept(h2u(l)); if (u && l.querySelector('img')) return u; }
    for (const l of navLinks) { const u = accept(h2u(l)); if (u) return u; }

    // On own profile — URL segment IS the logged-in user.
    if (isOwnProfile()) {
      const seg = location.pathname.split('/').filter(Boolean);
      if (seg.length === 1 && ok(seg[0].toLowerCase())) return seg[0].toLowerCase();
    }

    // Avatar alt "username's profile picture" fallback — DISABLED.
    // This used to iterate every profile-picture <img> on the page and return
    // the first matching alt. On a /p/ or /reel/ page (e.g. the post URL a
    // user pastes for commenters targeting) that regex matched the POST
    // AUTHOR's avatar before IG's left nav hydrated, and we'd persist the
    // post owner as `futnor_active_account` — making health stats and DM
    // scripts key off the wrong account. The nav-scoped signals above are
    // reliable on every IG surface; we no longer need this fallback.

    // Legacy meta tag fallback.
    const meta = document.querySelector('meta[property="al:ios:url"]');
    if (meta) {
      const m = (meta.getAttribute('content') || '').match(/user\?username=([a-z0-9._]+)/i);
      if (m) { const u = accept(m[1].toLowerCase()); if (u) return u; }
    }

    return null;
  } catch { return null; }
}

async function attemptDetectionOnce(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'GET_LOGGED_IN_USERNAME' });
    if (resp?.success && resp.username) return resp.username;
  } catch {
    // Content script not injected — fall through to scripting injection.
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: detectIgUsernameInPage,
    });
    const result = results?.[0]?.result;
    if (result) return result;
  } catch {}
  return null;
}

// Returns true if the given tab URL is a known-safe Instagram surface for
// account detection. We only persist `futnor_active_account` from these
// pages so the bot — which navigates to commenter and target profiles
// during a session — can never stamp a visited profile as the connected
// account. Mirrors `isSafeDetectionSurface()` in the IG content script.
//
// Safe surfaces: IG home (`/` or `/?...`), Direct inbox (`/direct/...`),
// Account settings (`/accounts/...`). The user's own profile is NOT
// safelisted here because we cannot prove "own profile" from the URL
// alone — that detection must run inside the page (content script).
function isSafeDetectionSurfaceUrl(url) {
  try {
    if (!url) return false;
    const u = new URL(url);
    if (u.hostname !== 'www.instagram.com' && u.hostname !== 'instagram.com') return false;
    const path = u.pathname || '/';
    if (path === '/' || path === '') return true;
    if (/^\/accounts\b/.test(path)) return true;
    if (/^\/direct\b/.test(path)) return true;
    // v2.4.93: logged-in-only fixed routes (no `/<handle>/` segment that
    // could be confused for a viewed user). Safe to allow first-detection
    // here so the active account locks in even when the bot lands on these.
    if (/^\/notifications\b/.test(path)) return true;
    if (/^\/inbox\b/.test(path)) return true;
    if (/^\/your_activity\b/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

async function detectAndSyncActiveAccount(platform = 'instagram') {
  // Only Instagram currently exposes a "logged-in username" handler in its content script.
  if (platform !== 'instagram') return null;

  const urlPattern = PLATFORM_URLS[platform];
  const tabs = await chrome.tabs.query({ url: urlPattern });
  if (tabs.length === 0) return null;

  // Try every IG tab the user has open (handles "logged in on a different IG tab"),
  // and retry each tab a few times with backoff so a slow nav hydrate doesn't lose us.
  // Prefer ready tabs first so we don't waste retries on tabs still loading.
  const candidates = [
    ...tabs.filter(t => t.status === 'complete'),
    ...tabs.filter(t => t.status !== 'complete'),
  ].filter(t => t.id);

  const backoffsMs = [0, 1500, 4000];
  let detected = null;
  let detectedFromTab = null;

  for (const tab of candidates) {
    for (const delay of backoffsMs) {
      if (delay > 0) await waitMs(delay);
      detected = await attemptDetectionOnce(tab.id);
      if (detected) { detectedFromTab = tab; break; }
    }
    if (detected) break;
  }

  if (!detected) return null;

  const detectedUsername = detected.toLowerCase().trim();
  if (detectedUsername !== activeAccountUsername) {
    // Hard guard: once a connected account is set, NEVER let auto-detect
    // replace it. The extension navigates IG tabs to post/reel URLs and
    // commenter profiles during commenters targeting; on those pages a
    // racy detection (or a DOM that hasn't fully repainted after a SPA
    // navigation away) can yield the visited profile's username instead
    // of the actual logged-in user. Allowing that overwrite — even
    // between sessions — makes the dashboard show the wrong account in
    // Account Health and stops/restarts sessions on the wrong handle.
    //
    // To force a re-detection (e.g. user switched IG accounts in Chrome),
    // the dashboard must explicitly send RESET_ACTIVE_ACCOUNT, which
    // clears `activeAccountUsername` first.
    if (activeAccountUsername) {
      console.log(
        `[Futnor Background] Ignoring auto-detected account change: ` +
        `keep=${activeAccountUsername}, detected=${detectedUsername}`
      );
      return activeAccountUsername;
    }

    // HARD UNIVERSAL GATE (v2.4.51) — never relax this.
    // Even for a fresh first-detection (no prior account set), only
    // accept the result if the source tab is on a known-safe surface
    // (IG home, /direct, /accounts/...). The content script applies
    // the same gate from inside the page; this is the SW-side mirror
    // for the scripting-injection fallback path. Without this, a brand-
    // new install whose first IG tab happens to be on a target profile
    // (e.g. user pasted a profile URL right after install) would latch
    // the visited handle as their connected account.
    if (!isSafeDetectionSurfaceUrl(detectedFromTab?.url)) {
      console.log(
        `[Futnor Background] Rejecting first-detection — source tab is not a safe surface: ` +
        `url=${detectedFromTab?.url || '(unknown)'}, detected=${detectedUsername}`
      );
      return null;
    }

    console.log(`[Futnor Background] Active account detected: (none) → ${detectedUsername}`);
    activeAccountUsername = detectedUsername;
    await chrome.storage.local.set({ futnor_active_account: detectedUsername });
  }
  return detectedUsername;
}


// Safety-net poll: if no account is detected yet, keep trying every 10s for the first
// ~2 minutes after the SW wakes. Covers the edge case where IG's nav hydrates AFTER
// our onUpdated 'complete' fires (common on slow networks / cold logins).
let _detectionPollAttempts = 0;
function startActiveAccountDetectionPoll() {
  const interval = setInterval(async () => {
    _detectionPollAttempts++;
    if (activeAccountUsername || _detectionPollAttempts > 12) {
      clearInterval(interval);
      return;
    }
    try { await detectAndSyncActiveAccount('instagram'); } catch {}
  }, 10000);
}

// Run detection when any Instagram tab finishes loading so the dashboard learns about the
// logged-in user the moment the user opens or navigates IG — no session start required.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab?.url || '';
  if (!/^https:\/\/www\.instagram\.com\//.test(url)) return;
  // Give the content script a moment to hydrate the DOM, then detect.
  setTimeout(() => {
    detectAndSyncActiveAccount('instagram').catch(() => {});
  }, 1500);
});

// ─── Centralized tab management ───
// Returns the single platform tab to use. Reuses existing, cleans duplicates, creates if needed.
async function getOrCreatePlatformTab(platform, options = {}) {
  const { createIfMissing = true, focus = false } = options;
  const urlPattern = PLATFORM_URLS[platform];
  const platformUrl = PLATFORM_HOME_URLS[platform] || PLATFORM_HOME_URLS.instagram;

  let tabs = await chrome.tabs.query({ url: urlPattern });

  // Validate preferred tab still exists
  if (preferredInstagramTabId && platform === 'instagram') {
    const preferred = tabs.find(t => t.id === preferredInstagramTabId);
    if (!preferred) {
      console.log('[Futnor Tab] Preferred tab no longer exists, clearing');
      preferredInstagramTabId = null;
    }
  }

  let targetTab = null;

  if (tabs.length === 0) {
    if (!createIfMissing) return null;
    console.log('[Futnor Tab] No platform tab found, creating one...');
    try {
      targetTab = await chrome.tabs.create({ url: platformUrl, active: true });
      await waitMs(3000);
      // Re-query to get updated tab info
      const refreshed = await chrome.tabs.query({ url: urlPattern });
      targetTab = refreshed.find(t => t.id === targetTab.id) || refreshed[0] || targetTab;
    } catch (e) {
      console.error('[Futnor Tab] Could not create tab:', e.message);
      return null;
    }
  } else if (tabs.length === 1) {
    targetTab = tabs[0];
  } else {
    // Multiple tabs — pick the best one, ignore the rest
    // Priority: preferred > active > most recently accessed
    if (platform === 'instagram' && preferredInstagramTabId) {
      targetTab = tabs.find(t => t.id === preferredInstagramTabId);
    }
    if (!targetTab) {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activePlatform = activeTabs.find(t => (t.url || '').includes(PLATFORM_DOMAIN_MATCHERS[platform] || PLATFORM_DOMAIN_MATCHERS.instagram));
      if (activePlatform) {
        targetTab = tabs.find(t => t.id === activePlatform.id);
      }
    }
    if (!targetTab) {
      // Pick most recently accessed
      targetTab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    }
    console.log(`[Futnor Tab] Multiple tabs found (${tabs.length}), using tab ${targetTab.id}. Ignoring others.`);
  }

  // Store preferred tab
  if (platform === 'instagram' && targetTab?.id) {
    preferredInstagramTabId = targetTab.id;
  }

  // Keep the platform tab alive even when the user switches tabs. Without
  // autoDiscardable=false, Chrome reclaims the IG tab under memory pressure
  // and the bot's content script gets torn down mid-session — which is one
  // of the reasons logged DM counts diverged from actual sent counts.
  if (targetTab?.id) {
    try {
      await chrome.tabs.update(targetTab.id, { autoDiscardable: false });
    } catch {}
  }

  // Focus if requested
  if (focus && targetTab?.id) {
    try {
      await chrome.tabs.update(targetTab.id, { active: true });
      await chrome.windows.update(targetTab.windowId, { focused: true });
    } catch {}
  }

  return targetTab || null;
}

// Ensure content script is loaded on a specific tab
async function hasResponsiveContentScript(tabId, attempts = 3, delayMs = 600) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (ping?.ready) return true;
    } catch {}

    if (attempt < attempts - 1) await waitMs(delayMs);
  }

  return false;
}

async function hasInjectedContentScriptMarker(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__futnorPingRegistered || window.__futnorContentLoaded),
    });

    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId, platform) {
  // Retry PING first — Instagram auto-injects at document_idle, so forcing a
  // second executeScript too early can redeclare top-level bindings and kill
  // follow-up actions like postCommentOnCurrentPost.
  if (await hasResponsiveContentScript(tabId, platform === 'instagram' ? 8 : 3, 700)) {
    return true;
  }

  if (await hasInjectedContentScriptMarker(tabId)) {
    return await hasResponsiveContentScript(tabId, 5, 700);
  }

  // Not ready — inject the script manually
  try {
    const scriptFile = platform === 'tiktok'
      ? 'tiktok/content.js'
      : platform === 'whatsapp'
        ? 'whatsapp/content.js'
        : 'instagram/content.js';
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
    await waitMs(2000); // Extra time to let the script fully initialize
    return await hasResponsiveContentScript(tabId, 5, 700);
  } catch (e) {
    console.error('[Futnor Tab] ensureContentScript failed:', e.message);
    return false;
  }
}

// Re-validate the preferred tab; if gone, re-scan
async function revalidatePlatformTab(platform) {
  if (preferredInstagramTabId && platform === 'instagram') {
    try {
      await chrome.tabs.get(preferredInstagramTabId);
      return; // Still valid
    } catch {
      console.log('[Futnor Tab] Preferred tab invalid, re-scanning...');
      preferredInstagramTabId = null;
    }
  }
  // Re-scan to find a valid tab
  const tab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
  if (tab) {
    console.log('[Futnor Tab] Reassigned to tab', tab.id);
  }
}

function normalizeInstagramUsername(username) {
  const normalized = (username || '').toString().toLowerCase().replace(/^@/, '').trim();
  return normalized || null;
}

function parseInstagramProfileUsernameFromUrl(rawUrl) {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!path || path.includes('/')) return null;
    if (RESERVED_IG_PATH_SEGMENTS.has(path)) return null;
    if (!/^[a-z0-9._]{2,30}$/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

async function getCurrentInstagramProfileUsername() {
  if (sessionState.platform !== 'instagram') return null;

  try {
    const tab = await getOrCreatePlatformTab('instagram', { createIfMissing: false });
    if (!tab) return null;
    return parseInstagramProfileUsernameFromUrl(tab.url || '');
  } catch {
    return null;
  }
}

async function waitForInstagramProfileUsername(options = {}) {
  const {
    exclude = [],
    attempts = 8,
    delayMs = 450,
  } = options;

  const excluded = new Set(
    (Array.isArray(exclude) ? exclude : [exclude])
      .map(normalizeInstagramUsername)
      .filter(Boolean),
  );

  for (let attempt = 0; attempt < attempts; attempt++) {
    const username = normalizeInstagramUsername(await getCurrentInstagramProfileUsername());
    if (username && !excluded.has(username)) {
      return username;
    }

    if (attempt < attempts - 1) {
      await waitMs(delayMs);
    }
  }

  return null;
}

async function sendInstagramDirectComposeDM(customMessage, targetUsername) {
  const normalizedTarget = normalizeInstagramUsername(targetUsername);
  if (sessionState.platform !== 'instagram') {
    return false;
  }

  if (!normalizedTarget || !customMessage) {
    console.log('[Futnor Background] Instagram profile DM aborted — missing target username or message');
    return false;
  }

  const tab = await getOrCreatePlatformTab('instagram', { createIfMissing: false });
  if (!tab?.id) {
    console.log('[Futnor Background] Instagram profile DM aborted — no Instagram tab available');
    return false;
  }

  const tabUrl = tab.url || '';
  const alreadyOnDirectThread = tabUrl.includes('/direct/');

  if (!alreadyOnDirectThread) {
    const onProfile = await sendActionToTab('navigateProfile', null, [normalizedTarget]);
    if (!onProfile) {
      console.log(`[Futnor Background] Failed to navigate to @${normalizedTarget} before DM attempt`);
      const navigated = await navigateTabAndWait(tab.id, `https://www.instagram.com/${normalizedTarget}/`);
      if (!navigated) return false;
      await waitMs(randomInt(1800, 2600));
    } else {
      await waitMs(randomInt(900, 1500));
    }
  }

  let dmSent = alreadyOnDirectThread
    ? await sendActionToTab('sendDMMessage', customMessage, [normalizedTarget])
    : await sendActionToTab('profileDM', customMessage, [normalizedTarget]);

  if (!dmSent) {
    console.log(`[Futnor Background] Profile DM flow failed for @${normalizedTarget} — checking DM recovery...`);
    dmSent = await attemptDMRecovery(customMessage, normalizedTarget);
  }

  if (dmSent) {
    await addToBgDMHistory(normalizedTarget, { wasFirstContact: extractFirstContactFlag(dmSent) });
  }

  return dmSent;
}

// Helper: send profileMultiLike to the platform tab using centralized tab management
async function sendProfileMultiLike() {
  const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
  if (!tab) return { success: false, likesCount: 0 };
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PERFORM_ACTION', action: 'profileMultiLike' });
    return resp || { success: false, likesCount: 0 };
  } catch {
    return { success: false, likesCount: 0 };
  }
}

function getRandom(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function coerceNumber(value, fallback, options = {}) {
  const { min = -Infinity, max = Infinity, integer = false } = options;
  const numeric = typeof value === 'number' ? value : Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : fallback;
  const normalized = integer ? Math.round(safeValue) : safeValue;
  return Math.min(max, Math.max(min, normalized));
}

function sanitizeSessionConfig(rawConfig = {}) {
  const merged = { ...DEFAULT_STATE.config, ...(rawConfig || {}) };
  const sessionMin = coerceNumber(merged.sessionMin, DEFAULT_STATE.config.sessionMin, { min: 1, integer: true });
  const sessionMax = coerceNumber(
    merged.sessionMax,
    Math.max(sessionMin, DEFAULT_STATE.config.sessionMax),
    { min: sessionMin, integer: true }
  );
  const minActionDelay = coerceNumber(merged.minActionDelay, DEFAULT_STATE.config.minActionDelay, { min: 1, integer: true });
  const maxActionDelay = coerceNumber(
    merged.maxActionDelay,
    Math.max(minActionDelay, DEFAULT_STATE.config.maxActionDelay),
    { min: minActionDelay, integer: true }
  );

  return {
    ...merged,
    sessionMin,
    sessionMax,
    scrollWeight: coerceNumber(merged.scrollWeight, DEFAULT_STATE.config.scrollWeight, { min: 0, integer: true }),
    likeWeight: coerceNumber(merged.likeWeight, DEFAULT_STATE.config.likeWeight, { min: 0, integer: true }),
    dmWeight: coerceNumber(merged.dmWeight, DEFAULT_STATE.config.dmWeight, { min: 0, integer: true }),
    minActionDelay,
    maxActionDelay,
    dailyMaxDMs: coerceNumber(merged.dailyMaxDMs, DEFAULT_STATE.config.dailyMaxDMs, { min: 0, integer: true }),
    dailyMaxLikes: coerceNumber(merged.dailyMaxLikes, DEFAULT_STATE.config.dailyMaxLikes, { min: 0, integer: true }),
    dailyMaxFollows: coerceNumber(merged.dailyMaxFollows, DEFAULT_STATE.config.dailyMaxFollows, { min: 0, integer: true }),
    followEnabled: merged.followEnabled === true,
    sessionDmGoal: coerceNumber(merged.sessionDmGoal, 0, { min: 0, integer: true }),
    // ── DM pacing controls (v2.4.92) ──
    // dmCooldownSec: minimum gap (seconds) between two DMs being sent.
    // dmBurstSize: pause every N DMs.
    // dmBurstPauseSec: how long that pause lasts.
    //
    // v2.4.150: these three fell back to 0 (= pacing OFF) instead of to the
    // DEFAULT_STATE values. The dashboard sends a config object that carries
    // these keys explicitly, and any key present with an `undefined` value wins
    // the `{ ...DEFAULT, ...raw }` spread — so a dashboard build that hadn't
    // populated them silently disabled the between-DM cooldown and the burst
    // pause, the two controls that do the most to keep sends from looking
    // bursty. Falling back to the DEFAULT_STATE values makes the safe pacing
    // the floor: a user can still lower it deliberately, but it can no longer
    // vanish by accident.
    dmCooldownSec: coerceNumber(merged.dmCooldownSec, DEFAULT_STATE.config.dmCooldownSec, { min: 0, max: 3600, integer: true }),
    dmBurstSize: coerceNumber(merged.dmBurstSize, DEFAULT_STATE.config.dmBurstSize, { min: 0, max: 100, integer: true }),
    dmBurstPauseSec: coerceNumber(merged.dmBurstPauseSec, DEFAULT_STATE.config.dmBurstPauseSec, { min: 0, max: 7200, integer: true }),
    // v2.4.150: hourlyMaxDMs and minSessionGapMinutes were passing through the
    // spread uncoerced, so a string ("6") or a NaN from the dashboard silently
    // disabled the hourly cap (Number("") === 0 → cap treated as "off").
    hourlyMaxDMs: coerceNumber(merged.hourlyMaxDMs, DEFAULT_STATE.config.hourlyMaxDMs, { min: 0, max: 200, integer: true }),
    minSessionGapMinutes: coerceNumber(merged.minSessionGapMinutes, DEFAULT_STATE.config.minSessionGapMinutes, { min: 0, max: 1440, integer: true }),
    requireLikeBeforeDM: merged.requireLikeBeforeDM !== false,
    stopOnActionBlock: merged.stopOnActionBlock !== false,
    // Post-DM commenting kill-switch — only true if explicitly opted in.
    postCommentAfterDmEnabled: merged.postCommentAfterDmEnabled === true,
  };
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') return true;
    } catch {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return false;
}

async function primePlatformTabForSession(platform, options = {}) {
  const {
    createIfMissing = true,
    focus = false,
    sessionSignal = 'SESSION_START',
  } = options;

  const targetTab = await getOrCreatePlatformTab(platform, { createIfMissing, focus });
  if (!targetTab?.id) {
    return { ok: false, reason: 'tab_unavailable' };
  }

  if (platform === 'instagram') {
    preferredInstagramTabId = targetTab.id;
  }

  await waitForTabComplete(targetTab.id);

  let contentReady = await ensureContentScript(targetTab.id, platform);
  if (!contentReady) {
    contentReady = await waitForContentScript(platform, 20);
  }

  if (!contentReady) {
    console.warn('[Futnor Tab] Content script not ready after all attempts — tab:', targetTab.id, targetTab.url);
    return { ok: false, reason: 'content_script_not_ready', tab: targetTab };
  }

  try {
    await chrome.tabs.sendMessage(targetTab.id, { type: sessionSignal });
  } catch {}

  try {
    await chrome.tabs.sendMessage(targetTab.id, { type: 'SHOW_BOT_BANNER' });
  } catch {}

  return { ok: true, tab: targetTab };
}

function pickNextAction(config, platform) {
  const total = config.scrollWeight + config.likeWeight + config.dmWeight;
  const rand = Math.random() * total;
  if (rand < config.scrollWeight) return 'scroll';
  if (rand < config.scrollWeight + config.likeWeight) return 'likeFollow';
  return platform === 'tiktok' ? 'comment' : 'dm';
}

function getRandomDelay(config) {
  return getRandom(config.minActionDelay, config.maxActionDelay) * 1000;
}

// Quick check — returns true if session was stopped externally
function shouldStop() {
  return !sessionState.isRunning;
}

// Interruptible delay: resolves early the moment the session is stopped or paused.
// Use this instead of bare setTimeout in the main session loop.
function waitMs(ms) {
  if (shouldStop() || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const end = Date.now() + ms;
    function tick() {
      if (shouldStop() || Date.now() >= end) return resolve();
      setTimeout(tick, Math.min(80, end - Date.now()));
    }
    setTimeout(tick, Math.min(80, ms));
  });
}

// Async pause-aware stop check: waits if paused, returns true if should stop
async function checkPauseOrStop() {
  if (sessionState.isPaused) {
    const shouldContinue = await waitWhilePaused();
    if (!shouldContinue) return true;
  }
  return !sessionState.isRunning;
}

// Wait while session is paused; resolves immediately if not paused.
// Returns false if session was stopped during the pause (caller should break).
async function waitWhilePaused() {
  while (sessionState.isPaused && sessionState.isRunning) {
    await waitMs(300);
  }
  return sessionState.isRunning; // false = stopped while paused
}

// Send an immediate stop/pause signal to the content script so in-flight
// operations (sleep loops, navigation waits, etc.) abort right away.
async function signalContentScriptStop(type = 'SESSION_STOP') {
  try {
    const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type }, () => { chrome.runtime.lastError; });
    }
  } catch {}
}

function addLog(action, message) {
  sessionState.logs.unshift({
    id: Math.random().toString(36).substring(2, 9),
    timestamp: new Date().toISOString(),
    action,
    message,
  });
  if (sessionState.logs.length > 100) sessionState.logs.length = 100;
  saveState();
  // Push live update to banner on platform tab
  updateBannerLive(message);
}

async function updateBannerLive(latestLog) {
  if (!sessionState.isRunning) return;
  try {
    const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'UPDATE_BANNER',
        mode: 'bot',
        stats: sessionState.stats,
        latestLog,
      }).catch(() => {});
    }
  } catch {}
}

// Wait for content script to be ready by pinging it — uses centralized tab management
async function waitForContentScript(platform, maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Futnor Background] Checking content script readiness (attempt ${attempt}/${maxAttempts})...`);
    
    // NEVER create a new tab here — only reuse the one already created by primePlatformTabForSession
    const tab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
    if (!tab) {
      console.log('[Futnor Background] No tab available, waiting...');
      await waitMs(1000);
      continue;
    }
    
    // Wait for tab to finish loading
    try {
      const freshTab = await chrome.tabs.get(tab.id);
      if (freshTab.status !== 'complete') {
        console.log('[Futnor Background] Tab still loading, waiting...');
        await waitMs(1500);
        continue;
      }
    } catch {
      // Tab gone — clear preferred and retry
      if (platform === 'instagram') preferredInstagramTabId = null;
      continue;
    }
    
    // Try injecting the content script proactively on early attempts
    if (attempt === 2 || attempt === 5 || attempt === 10) {
      await ensureContentScript(tab.id, platform);
    }
    
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      if (response?.ready) {
        console.log('[Futnor Background] Content script ready on tab', tab.id);
        return true;
      }
    } catch (e) {
      console.log('[Futnor Background] Content script not ready yet:', e.message);
    }
    
    await waitMs(800);
  }
  
  console.error('[Futnor Background] Content script failed to load after', maxAttempts, 'attempts');
  return false;
}

async function handleExtensionReconnect(reason = 'connection_lost') {
  if (!sessionState.isRunning) return false;

  if (!sessionState.reconnecting) {
    console.warn('[Futnor Background] Entering reconnect mode:', reason);
    sessionState.reconnecting = true;
    sessionState.isPaused = true;
    addLog('session_start', 'Reconnecting to extension...');
    saveState();
  }

  while (sessionState.isRunning && sessionState.reconnecting) {
    try {
      await revalidatePlatformTab(sessionState.platform);
      const result = await primePlatformTabForSession(sessionState.platform, {
        createIfMissing: true,
        focus: false,
        sessionSignal: 'SESSION_RESUME',
      });

      if (result.ok) {
        sessionState.reconnecting = false;
        sessionState.isPaused = false;
        addLog('session_start', '✅ Extension reconnected — resuming session');
        saveState();
        return true;
      }
    } catch (error) {
      console.warn('[Futnor Background] Reconnect attempt failed:', error?.message || error);
    }

    await waitMs(2000);
  }

  return false;
}

// `extras` is merged into the PERFORM_ACTION payload sent to the content
// script. Used for action-specific flags like `fromInboxFlow` on sendDMMessage
// so the receiver can distinguish a legitimate inbox-driven send from a
// profileDM-recovery send and not falsely abort the latter on prior history.
async function sendActionToTab(action, customMessage, keywords, allowReconnectRecovery = true, handledTabNavigation = false, extras = null) {
  if (sessionState.isPaused && sessionState.isRunning) {
    const shouldContinue = await waitWhilePaused();
    if (!shouldContinue) {
      return ['checkProfileDemographics', 'extractCommenters', 'getRecentPostLink', 'extractPostContext', 'isProfileAccessible'].includes(action) ? null : false;
    }
  }

  if (shouldStop()) {
    return ['checkProfileDemographics', 'extractCommenters', 'getRecentPostLink', 'extractPostContext', 'isProfileAccessible'].includes(action) ? null : false;
  }

  const platform = sessionState.platform;
  const MAX_RETRIES = 4;
  const RETRY_DELAY_MS = 1500;
  const isInfoAction = ['checkProfileDemographics', 'extractCommenters', 'getRecentPostLink', 'extractPostContext', 'isProfileAccessible'].includes(action);
  // DM-send actions return extra metadata (wasFirstContact) the caller needs
  // to attribute the send correctly. Returning the full response object lets
  // the session loop pull `.wasFirstContact` while existing truthiness checks
  // still work (a non-empty object is truthy, false is falsy).
  const isDMSendAction = ['dm', 'profileDM', 'sendDirectDM', 'sendDMMessage', 'dmUsername'].includes(action);
  const payload = {
    type: 'PERFORM_ACTION',
    action,
    customMessage,
    keywords,
    allowExistingChats: !!sessionState.targeting?.allowExistingChats,
    ...(extras && typeof extras === 'object' ? extras : {}),
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await revalidatePlatformTab(platform);
    const targetTab = await getOrCreatePlatformTab(platform, { createIfMissing: false });

    if (!targetTab) {
      if (allowReconnectRecovery) {
        const recovered = await handleExtensionReconnect('platform_tab_missing');
        if (recovered) {
          return sendActionToTab(action, customMessage, keywords, false, handledTabNavigation);
        }
      }

      console.error('[Futnor Background] No platform tab found');
      return isInfoAction ? null : false;
    }

    try {
      console.log(`[Futnor Background] Sending action (attempt ${attempt}/${MAX_RETRIES}):`, targetTab.id, action);
      const response = await chrome.tabs.sendMessage(targetTab.id, payload);
      console.log('[Futnor Background] Response:', response);

      if (response && typeof response === 'object' && response.needsTabNavigation) {
        console.log('[Futnor Background] Content script requests tab navigation to:', response.url);
        const navigated = await navigateTabAndWait(targetTab.id, response.url);
        if (!navigated) return isInfoAction ? null : false;

        if (action === 'dm' || action === 'sendDirectDM') {
          if (handledTabNavigation) {
            console.warn(`[Futnor Background] ${action} requested tab navigation twice — aborting to avoid false success`);
            return false;
          }

          console.log(`[Futnor Background] ${action} tab navigation complete — re-dispatching action`);
          return sendActionToTab(action, customMessage, keywords, allowReconnectRecovery, true);
        }

        return true;
      }

      if (isInfoAction) return response;
      if (isDMSendAction) return response?.success ? response : false;
      return response?.success ?? false;
    } catch (e) {
      console.error(`[Futnor Background] Attempt ${attempt} failed:`, e.message);

      if (attempt <= 2) {
        const injected = await ensureContentScript(targetTab.id, platform);
        if (injected) {
          try { await chrome.tabs.sendMessage(targetTab.id, { type: 'SHOW_BOT_BANNER' }); } catch {}
          continue;
        }
      }

      if (attempt === MAX_RETRIES) {
        // ── DM-navigation guard ──────────────────────────────────────
        // profileDM clicks the "Message" button which can hard-navigate
        // to /direct/t/…, killing the content script mid-execution.
        // Triggering a full reconnect here would re-send profileDM on
        // the /direct/ page, which SPA-navigates back to the profile,
        // clicks Message again → infinite reconnect loop.
        // Instead, bail immediately so attemptDMRecovery (called by the
        // session loop) can handle the send on the /direct/ page cleanly.
        if (action === 'profileDM' || action === 'sendDMMessage') {
          const dmTab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
          if (dmTab?.url?.includes('/direct/')) {
            console.log('[Futnor Background] profileDM failed — tab is on /direct/, skipping reconnect for DM recovery');
            return false;
          }
        }

        if (allowReconnectRecovery) {
          const recovered = await handleExtensionReconnect('message_channel_lost');
          if (recovered) {
            return sendActionToTab(action, customMessage, keywords, false, handledTabNavigation);
          }
        }

        console.error('[Futnor Background] Max retries reached, skipping action');
        return isInfoAction ? null : false;
      }

      await waitMs(RETRY_DELAY_MS);
    }
  }

  return isInfoAction ? null : false;
}

// Navigate a tab to a URL at the browser level and wait for content script readiness
async function navigateTabAndWait(tabId, url) {
  try {
    await chrome.tabs.update(tabId, { url });
    console.log('[Futnor Background] Tab navigation initiated to:', url);

    const platform = sessionState.platform;
    let tabComplete = false;
    let injectionAttempts = 0;

    // Phase 1: wait for tab to reach 'complete' status (up to ~24 seconds)
    for (let i = 0; i < 30; i++) {
      await waitMs(800);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') { tabComplete = true; break; }
      } catch {
        console.warn('[Futnor Background] navigateTabAndWait: tab gone during load');
        return false; // Tab destroyed — abort
      }
    }

    if (!tabComplete) {
      console.warn('[Futnor Background] navigateTabAndWait: tab never reached complete status');
      // Proceed anyway — might have stalled but content could still be loaded
    }

    // Phase 2: wait for content script to be responsive (up to ~15 seconds)
    for (let i = 0; i < 15; i++) {
      if (i === 0) {
        await waitMs(1200); // Initial settle time after tab complete
      } else {
        await waitMs(700);
      }

      try {
        const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        if (ping?.ready) {
          console.log('[Futnor Background] Content script ready after tab navigation');
          try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_BOT_BANNER' }); } catch {}
          return true;
        }
      } catch {}

      const alreadyInjected = await hasInjectedContentScriptMarker(tabId);

      // Only inject after we've already failed to reach the existing script.
      // This avoids duplicate Instagram injection on freshly navigated post pages.
      if (!alreadyInjected && (i === 2 || i === 7) && injectionAttempts < 2) {
        try {
          const scriptFile = platform === 'tiktok' ? 'tiktok/content.js' : 'instagram/content.js';
          await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
          injectionAttempts++;
          console.log(`[Futnor Background] navigateTabAndWait: injected content script (attempt ${injectionAttempts})`);
          await waitMs(800);
        } catch (injectErr) {
          console.warn('[Futnor Background] navigateTabAndWait: injection failed:', injectErr?.message);
        }
      }

    }

    console.warn('[Futnor Background] navigateTabAndWait: content script not confirmed ready — proceeding (next action will handle)');
    return true; // Still return true — the action layer has its own retry/timeout
  } catch (e) {
    console.error('[Futnor Background] navigateTabAndWait failed:', e.message);
    return false;
  }
}

function normalizeMonitorUrlPath(rawUrl) {
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl, 'https://www.instagram.com');
    return url.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return rawUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '') || '/';
  }
}

async function loadEngagementMonitorPost(tabId, url, platform) {
  const targetPath = normalizeMonitorUrlPath(url);
  let isSamePost = false;

  try {
    const tab = await chrome.tabs.get(tabId);
    isSamePost = normalizeMonitorUrlPath(tab?.url || '') === targetPath;
  } catch {}

  if (isSamePost) {
    await chrome.tabs.reload(tabId, { bypassCache: true });
    await waitForTabComplete(tabId, 15000);
    console.log('[Futnor Background] Engagement monitor hard-refreshed current post');
  } else {
    const navigated = await navigateTabAndWait(tabId, url);
    if (!navigated) return false;
  }

  await waitMs(900);
  const ready = await ensureContentScript(tabId, platform);
  if (!ready) {
    console.warn('[Futnor Background] Engagement monitor: content script not fully ready after load');
  }
  await waitMs(600);

  try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_BOT_BANNER' }); } catch {}
  return true;
}

// ─── DM Recovery: handle when clicking Message navigates to /direct/ ───
// After profileDM fails, check if tab navigated to /direct/t/... and send message there
async function attemptDMRecovery(customMessage, targetUsername = null) {
  const platform = sessionState.platform;
  
  // Wait a moment for any navigation to settle
  await waitMs(2000);
  
  const tab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
  if (!tab) return false;

  const tabUrl = tab.url || '';

  // Check if the tab navigated to a DM page
  if (!tabUrl.includes('/direct/')) {
    console.log('[Futnor Background] DM recovery aborted — tab never reached a /direct/ thread after profile flow');
    return false;
  }

  console.log('[Futnor Background] Tab navigated to DM page:', tabUrl);

  // Re-fetch tab to get the most current URL (navigation may have settled further)
  let freshTab;
  try { freshTab = await chrome.tabs.get(tab.id); } catch { freshTab = tab; }
  const freshUrl = freshTab?.url || tabUrl;

  // If on inbox (not a specific thread), click the top conversation to open it
  if (freshUrl.includes('/direct/inbox') && !freshUrl.includes('/direct/t/')) {
    console.log('[Futnor Background] On inbox page — attempting to open top conversation...');

    // Wait for inbox to load
    await waitMs(2500);

    // Ask content script to open the target conversation thread
    const openedThread = await sendActionToTab('openTopDMThread', null, targetUsername ? [targetUsername] : undefined);
    if (!openedThread) {
      // openTopDMThread failed — but the conversation may already be open in the right pane
      // (Instagram sometimes pre-selects the new thread without navigating to /direct/t/).
      // Fall through and let sendDMMessage try to find the composer directly.
      console.log('[Futnor Background] openTopDMThread failed — will still try sendDMMessage in case composer is already visible');
    } else {
      // Wait for thread navigation to settle
      await waitMs(3000);
    }
  }
  
  // Wait for tab to finish loading
  if (tab.status !== 'complete') {
    await new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 8000);
    });
  }
  
  // Ensure content script is injected and ready on the /direct/ page.
  // The manifest auto-injects at document_idle, but after a hard navigation
  // the tab may still be loading.  Explicitly inject if PING fails.
  await waitMs(1500);

  let contentReady = await ensureContentScript(tab.id, platform);
  if (!contentReady) {
    // Second chance — wait longer for the page to settle after navigation
    await waitMs(3000);
    contentReady = await ensureContentScript(tab.id, platform);
  }

  if (!contentReady) {
    console.log('[Futnor Background] Content script not ready on DM page after injection attempts');
    return false;
  }
  
  // Send the message using the sendDMMessage action
  console.log('[Futnor Background] Attempting DM recovery on full DM page...');
  const result = await sendActionToTab('sendDMMessage', customMessage, targetUsername ? [targetUsername] : undefined);
  return result;
}

// Skip when the profile is unreachable (not_found / restricted), but honor the
// "Include Private Accounts" targeting toggle so private profiles get DM'd when
// the user opted in. Private DMs land in the recipient's message-request folder.
function shouldSkipForAccess(accessCheck) {
  if (!accessCheck || accessCheck.accessible) return false;
  if (accessCheck.reason === 'private') {
    const t = sessionState.targeting || {};
    // Hard skip: "Public Accounts Only" wins over any other toggle.
    if (t.publicAccountsOnly === true) return true;
    // Otherwise honor explicit opt-in to include private accounts.
    if (t.includePrivateAccounts === true) return false;
    // Default: skip private accounts.
    return true;
  }
  return true;
}

// Friendly, user-readable reason for an access skip, including the username.
function describeAccessSkip(accessCheck, username) {
  const handle = username ? `@${username}` : 'account';
  if (!accessCheck) return `${handle} — could not verify account, skipping`;
  switch (accessCheck.reason) {
    case 'private': {
      const t = sessionState.targeting || {};
      if (t.publicAccountsOnly === true) {
        return `${handle} — skipped because it's a private account (Public Accounts Only is on)`;
      }
      return `${handle} — skipped because it's a private account (enable "Include Private Accounts" to DM these)`;
    }
    case 'not_found':
      return `${handle} — account not found, skipping`;
    case 'restricted':
      return `${handle} — account restricted, skipping`;
    case 'no_posts':
      return `${handle} — has no posts, skipping`;
    default:
      return `${handle} — not accessible (${accessCheck.reason || 'unknown reason'}), skipping`;
  }
}

// ─── Demographics & profile stats filter check ───
// Returns true if profile passes all filters (demographics + follower/post count), false if should be skipped.
// Behaviour:
//   • Filter toggle OFF → field is ignored.
//   • Filter toggle ON, extraction succeeded, value out of range → skip.
//   • Filter toggle ON, extraction FAILED (number not visible) → FAIL-OPEN
//     (v2.4.137). User reported the bot skipping qualifying accounts
//     (15k+ followers, well inside their 50–50,000 filter) because IG's
//     profile-stats DOM didn't render fast enough or used selectors the
//     scraper didn't match. Previously these got conservatively skipped
//     ("we'd rather miss a target than DM the wrong person"). Reversed:
//     the user would rather attempt the DM and possibly hit something
//     outside their filter than systematically miss real targets that
//     pass the filter but happen to render slow.
async function checkDemographicsFilter(username) {
  const targeting = sessionState.targeting || {};
  const genderEnabled = targeting.filterGenderEnabled;
  const ageEnabled = targeting.filterAgeEnabled;
  const followersEnabled = targeting.filterFollowersEnabled;
  const postsEnabled = targeting.filterPostsEnabled;
  const handle = username ? `@${username}` : 'account';

  // If no filters are enabled, always pass
  if (!genderEnabled && !ageEnabled && !followersEnabled && !postsEnabled) return true;

  const result = await sendActionToTab('checkProfileDemographics');
  if (!result || !result.demographics) {
    // Even when the demographics call fails entirely, fail-open with a
    // warning. The user explicitly asked: don't skip qualifying targets
    // because the scraper hit a slow profile.
    addLog('scroll', `⚠️ ${handle} — could not read profile data, attempting DM anyway`);
    return true;
  }

  const { gender, age, followers, posts } = result.demographics;

  // Follower count check
  if (followersEnabled) {
    const min = targeting.filterFollowersMin ?? 0;
    const max = targeting.filterFollowersMax ?? 999999999;
    if (followers === null || followers === undefined) {
      // Unknown count → fail-open. Log so the user can see what's
      // happening, but don't skip.
      addLog('scroll', `⚠️ ${handle} — follower count not visible, attempting DM anyway (filter ${min.toLocaleString()}–${max.toLocaleString()})`);
    } else if (followers < min || followers > max) {
      addLog('dm_skipped', `⏭️ ${handle} — ${followers.toLocaleString()} followers outside range ${min.toLocaleString()}–${max.toLocaleString()}`);
      return false;
    }
  }

  // Post count check
  if (postsEnabled) {
    const min = targeting.filterPostsMin ?? 0;
    const max = targeting.filterPostsMax ?? 999999999;
    if (posts === null || posts === undefined) {
      addLog('scroll', `⚠️ ${handle} — post count not visible, attempting DM anyway (filter ${min.toLocaleString()}–${max.toLocaleString()})`);
    } else if (posts < min || posts > max) {
      addLog('dm_skipped', `⏭️ ${handle} — ${posts.toLocaleString()} posts outside range ${min.toLocaleString()}–${max.toLocaleString()}`);
      return false;
    }
  }

  // Gender check (v2.4.137: same fail-open policy as follower/post)
  if (genderEnabled && targeting.filterGender && targeting.filterGender !== 'any') {
    if (gender === 'unknown' || gender === null || gender === undefined) {
      addLog('scroll', `⚠️ ${handle} — gender unknown, attempting DM anyway (filter: ${targeting.filterGender})`);
    } else if (gender !== targeting.filterGender) {
      addLog('dm_skipped', `⏭️ ${handle} — gender ${gender} doesn't match filter (${targeting.filterGender})`);
      return false;
    }
  }

  // Age check (v2.4.137: same fail-open policy)
  if (ageEnabled && targeting.filterAgeMin != null && targeting.filterAgeMax != null) {
    if (age === null || age === undefined) {
      addLog('scroll', `⚠️ ${handle} — age unknown, attempting DM anyway (filter ${targeting.filterAgeMin}–${targeting.filterAgeMax})`);
    } else if (age < targeting.filterAgeMin || age > targeting.filterAgeMax) {
      addLog('dm_skipped', `⏭️ ${handle} — age ${age} outside range ${targeting.filterAgeMin}–${targeting.filterAgeMax}`);
      return false;
    }
  }

  // Log what passed
  const parts = [];
  if (gender && gender !== 'unknown') parts.push(gender);
  if (age !== null && age !== undefined) parts.push(`age ${age}`);
  if (followers !== null && followers !== undefined) parts.push(`${followers.toLocaleString()} followers`);
  if (posts !== null && posts !== undefined) parts.push(`${posts.toLocaleString()} posts`);
  if (parts.length > 0) {
    addLog('scroll', `✅ ${handle} matches filters: ${parts.join(', ')}`);
  }
  return true;
}

async function runSession(options = {}) {
  // Guard against concurrent session loops
  if (sessionLoopActive && sessionLoopPromise) {
    console.log('[Futnor Background] Session loop already active, waiting for it to finish...');
    try { await sessionLoopPromise; } catch (e) {
      console.error('[Futnor Background] Previous session loop threw before new session:', e?.message || e);
    }
  }

  // Detect the logged-in Instagram account to scope history per account
  try {
    await detectAndSyncActiveAccount(sessionState.platform);
  } catch (err) {
    console.warn('[Futnor Background] Could not detect logged-in username:', err?.message || err);
  }

  console.log(`[Futnor Background] History scoped to account: ${activeAccountUsername || '(global)'}`);

  // Load persistent histories BEFORE anything else so we never revisit handled targets
  await Promise.all([
    refreshBgDMHistory(),
    refreshBgProcessedAccounts(),
  ]);

  const { resume = false } = options;
  sessionLoopActive = true;

  // Reset per-session DM-pacing counters so the burst pause is computed
  // against THIS session, not the previous one.
  resetDmPacingCounters();

  sessionState.config = sanitizeSessionConfig(sessionState.config);

  // ─── WARM-UP RAMP (v2.4.150) ──────────────────────────────────────────────
  // Warm-up used to be advisory: the dashboard nagged about it and the health
  // score docked points, but the engine happily ran a full-volume day on an
  // account that had never warmed up once. Recent warm-up history is now a hard
  // ceiling on the session's volume. It only ever clamps DOWN — a user who
  // configured smaller numbers keeps their own.
  try {
    const ramp = await getWarmupRampCaps();
    const beforeDaily = sessionState.config.dailyMaxDMs;
    const beforeHourly = sessionState.config.hourlyMaxDMs;
    const clampedDaily = beforeDaily > 0 ? Math.min(beforeDaily, ramp.dailyMaxDMs) : ramp.dailyMaxDMs;
    const clampedHourly = beforeHourly > 0 ? Math.min(beforeHourly, ramp.hourlyMaxDMs) : ramp.hourlyMaxDMs;
    if (clampedDaily !== beforeDaily || clampedHourly !== beforeHourly) {
      sessionState.config = {
        ...sessionState.config,
        dailyMaxDMs: clampedDaily,
        hourlyMaxDMs: clampedHourly,
      };
      addLog('session_start',
        `🛡️ Warm-up ramp (${ramp.label}) — capping this session at ${clampedDaily} DMs, ${clampedHourly}/hour`);
    }
  } catch (e) {
    console.warn('[Futnor Background] Warm-up ramp check failed:', e?.message || e);
  }

  const { platform, aiTargeting } = sessionState;
  let config = { ...sessionState.config }; // Local copy — safe to modify (e.g. zeroing dmWeight when no templates)
  const isAITargeting = aiTargeting?.enabled && aiTargeting.searchTerms?.length > 0;
  const savedSessionTime = sessionState.stats.sessionTime || 0;
  const savedElapsedTime = sessionState.stats.elapsedTime || 0;
  const nextSessionTime = resume && savedSessionTime > savedElapsedTime
    ? savedSessionTime
    : getRandom(config.sessionMin * 60, config.sessionMax * 60);
  const sessionTime = Number.isFinite(nextSessionTime) && nextSessionTime > 0
    ? nextSessionTime
    : getRandom(DEFAULT_STATE.config.sessionMin * 60, DEFAULT_STATE.config.sessionMax * 60);

  sessionState.stats.sessionTime = sessionTime;
  sessionState.stats.elapsedTime = resume ? Math.min(savedElapsedTime, sessionTime) : 0;
  sessionState.isRunning = true;
  sessionState.isPaused = false;
  sessionState.reconnecting = false;
  // Pick a fresh per-session comment ratio so two sessions never share a
  // commenting cadence fingerprint (anti-detection — see postCommentAfterDM).
  if (!resume) { try { resetCommentSessionState(); } catch {} }
  saveState();

  // Use dmTemplates from session state only — no cache or fallback sources.
  let customMessage = sanitizeDMTemplates(sessionState.dmTemplates);

  const platformLabel = platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const modeLabel = isAITargeting ? ' [AI Targeting]' : '';
  addLog('session_start', resume
    ? `[${platformLabel}]${modeLabel} Session resumed at ${Math.round(sessionState.stats.elapsedTime / 60)} min elapsed`
    : `[${platformLabel}]${modeLabel} Session started, target: ${Math.round(sessionTime / 60)} min`);

  if (customMessage.length === 0) {
    addLog('dm_skipped', 'ERROR: DM script is empty or not loaded');
    addLog('session_start', '⚠️ No DM scripts found — DMs will be skipped. Configure scripts in the DM Mode section.');
    customMessage = null; // Ensure it's null so DMs are skipped gracefully
    // Zero out dmWeight so the action picker never wastes a cycle picking DM
    if (config.dmWeight > 0) {
      config = { ...config, dmWeight: 0 };
      console.log('[Futnor Background] dmWeight zeroed — no DM templates loaded');
    }
  } else {
    addLog('session_start', `✅ Loaded ${customMessage.length} DM script variation(s)`);
  }

  if (isAITargeting) {
    addLog('scroll', `AI Targeting active — searching for: ${aiTargeting.searchTerms.slice(0, 3).join(', ')}...`);
  } else {
    const t = sessionState.targeting || {};
    const type = t.targetTypes?.[0];
    if (type === 'hashtags') addLog('scroll', `🎯 Targeting hashtags: ${t.hashtags}`);
    else if (type === 'followers') addLog('scroll', `🎯 Targeting followers of @${t.targetUsername}`);
    else if (type === 'following') addLog('scroll', `🎯 Targeting following of @${t.targetUsername}`);
    else if (type === 'custom') addLog('scroll', `🎯 Targeting ${t.customUsernames?.length || 0} custom usernames`);
    else if (type === 'likers') addLog('scroll', `🎯 Targeting likers of post`);
    else if (type === 'commenters') addLog('scroll', `🎯 Targeting commenters of post`);
  }

  addLog('session_start', '✅ Content script ready, starting automation...');

  // Show "Do not close" banner on platform tab
  await showBannerOnPlatformTab(platform);
  // Re-send banner after a short delay in case content script wasn't ready
  setTimeout(() => { if (sessionState.isRunning) showBannerOnPlatformTab(platform); }, 3000);

  const tickAlarm = 'session-tick';
  chrome.alarms.create(tickAlarm, { periodInMinutes: 1 / 60 });

  // ─── SESSION CLOCK (v2.4.150) ────────────────────────────────────────────
  // `elapsed` used to be a hand-rolled accumulator that only ever added the
  // inter-iteration delay. Everything the bot actually *did* — navigating,
  // browsing a profile, multi-liking, sending the DM, recovering from a failed
  // send — was free. A "12 minute" session routinely ran for well over an hour
  // of real time, which is precisely the >45min-continuous pattern the health
  // model warns about, and the number written to session_history was fiction.
  //
  // Now: wall clock, minus the time spent in deliberate cooldowns (per-DM
  // cooldown, burst pause, hourly-cap rest). Sitting still on purpose is the
  // opposite of session activity, so it must not burn the activity budget —
  // otherwise a 20-minute burst pause silently ends the run before the user's
  // DM goal is met, which is the "stops before it finishes" complaint.
  const sessionStartedAt = Date.now();
  const resumeOffsetSec = resume ? Math.min(savedElapsedTime, sessionTime) : 0;
  const activeElapsedSec = () =>
    resumeOffsetSec + Math.max(0, (Date.now() - sessionStartedAt - getSessionCooldownMs()) / 1000);

  // Hard ceiling on continuous active time regardless of goals. 45 min is the
  // threshold the account-health model flags as an IG risk pattern, so the bot
  // must never cross it on its own.
  const MAX_ACTIVE_SESSION_SEC = 45 * 60;

  // The session's soft time budget is `sessionTime`. When the user has set an
  // explicit DM target that has not been met yet, we keep going past the soft
  // budget up to the hard ceiling instead of abandoning the run mid-way.
  const dmTargetOutstanding = () => {
    const goal = Number(sessionState.config.sessionDmGoal) || 0;
    if (goal > 0 && getDailyDmsSentCount() < goal) return true;
    const cap = Number(config.dailyMaxDMs) || 0;
    if (cap > 0 && (sessionState.stats.dmsSent || 0) < cap) return true;
    return false;
  };

  const sessionBudgetSpent = () => {
    const active = activeElapsedSec();
    if (active >= MAX_ACTIVE_SESSION_SEC) return true;
    if (active < sessionTime) return false;
    return !dmTargetOutstanding();
  };

  let elapsed = resumeOffsetSec;
  let _overrunNoted = false;
  // Consecutive iterations that produced no DM — see the barren-run guard at
  // the top of the loop.
  let barrenIterations = 0;
  let _dmsAtLastBarrenCheck = 0;
  const MAX_BARREN_ITERATIONS = 25;
  let aiPhase = 'search';
  let accountsEngaged = 0;
  const searchTermIndex = { current: 0 };
  let customTargetCursor = 0;

  function pickMessage() {
    const availableTemplates = sanitizeDMTemplates(customMessage);
    if (availableTemplates.length === 0) {
      console.log('[Futnor Background] ERROR: DM script is empty or not loaded');
      return null;
    }
    const msg = availableTemplates[Math.floor(Math.random() * availableTemplates.length)];
    console.log('[Futnor Background] Selected DM script:', msg.slice(0, 160));
    return msg;
  }

  // ── STALLED-TARGET GUARD (v2.4.158) ──────────────────────────────────────
  // Accounts we tried this session and could not DM. Session-scoped only:
  // nothing is written to storage, so the lead is retried on a later run.
  //
  // Without this the bot got stuck. v2.4.155 made target selection strictly
  // top-of-list (correct — it stopped the bot skipping people), and it also
  // stopped marking transient failures as permanently processed (also correct
  // — a slow page shouldn't retire a lead). Together they deadlock: a profile
  // that always fails at the DM step is never recorded anywhere, so it is
  // still the top unhandled candidate on the very next iteration, and the bot
  // returns to it forever.
  //
  // Reported as: skips a broken username, DMs someone successfully, then goes
  // back to the broken username and stays there.
  const failedTargetsThisSession = new Set();

  const noteTargetFailed = (username, reason) => {
    const normalized = normalizeInstagramUsername(username);
    if (!normalized) return;
    if (failedTargetsThisSession.has(normalized)) return;
    failedTargetsThisSession.add(normalized);
    addLog('dm_skipped', `⏭️ @${normalized} — ${reason}. Moving on; will retry in a future session.`);
  };

  const isAccountAlreadyHandled = (username) => {
    const normalized = normalizeInstagramUsername(username);
    if (!normalized) return false;
    return isInBgDMHistory(normalized)
      || isInBgProcessedAccounts(normalized)
      || failedTargetsThisSession.has(normalized);
  };

  const rememberProcessedAccount = async (username) => {
    const normalized = normalizeInstagramUsername(username);
    if (!normalized) return;
    await addToBgProcessedAccounts(normalized);
  };

  while (!sessionBudgetSpent() && sessionState.isRunning) {
    elapsed = activeElapsedSec();
    sessionState.stats.elapsedTime = Math.round(elapsed);
    if (!_overrunNoted && elapsed >= sessionTime) {
      _overrunNoted = true;
      addLog('scroll', '⏱️ Session window reached — finishing the outstanding DM target before stopping');
    }

    // ── Barren-run guard (v2.4.150) ──────────────────────────────────────────
    // The loop now keeps going until the DM target is met, so it also needs a
    // reason to give up. Without this, a run whose target pool is exhausted
    // (everyone already DM'd, every profile private, the hashtag grid empty)
    // would churn through navigation for the full 45-minute ceiling and then
    // stop with no explanation — the "just shut down without saying anything"
    // report, stretched over 45 minutes.
    //
    // Measured from the DM counter at the top of each iteration rather than a
    // per-iteration flag, because most skip paths `continue` and would jump
    // straight past a check placed at the bottom of the loop.
    if (sessionState.stats.dmsSent > _dmsAtLastBarrenCheck) {
      _dmsAtLastBarrenCheck = sessionState.stats.dmsSent;
      barrenIterations = 0;
    } else if (++barrenIterations >= MAX_BARREN_ITERATIONS) {
      addLog('session_end',
        `🔍 No new targets in ${MAX_BARREN_ITERATIONS} attempts — ending session. `
        + `Sent ${sessionState.stats.dmsSent} DM(s). Try another hashtag or list, or widen your filters.`);
      break;
    }
    // ── Pause gate: freeze the loop while paused ──
    if (sessionState.isPaused) {
      const shouldContinue = await waitWhilePaused();
      if (!shouldContinue) break; // stopped while paused
    }
    // Reset per-iteration "did we send a DM?" flag. Set to true by the
    // targeted DM block when a real send lands. Used at end-of-iteration
    // to pick the inter-iteration delay: full action-delay after a real
    // send (humanlike pacing), short ~3–6s after a skip so the bot
    // quickly moves to the next target instead of appearing frozen for
    // 45–180s on a profile it just skipped.
    let _iterationDidSendDM = false;

    // DM count at the start of this iteration. Compared at the bottom of the
    // loop to decide whether to slot in an organic filler action. Read from the
    // counter rather than a flag because the hashtag/commenter/location
    // branches deliberately leave _iterationDidSendDM false (they run their own
    // wait) yet still send.
    const _dmsAtIterationStart = sessionState.stats.dmsSent;

    // ── requireLikeBeforeDM (v2.4.150) ───────────────────────────────────────
    // `config.requireLikeBeforeDM` shipped with the comment "never DM without
    // warming the recipient first" and defaulted to true — but nothing in the
    // codebase ever read it. Cold DMs went out to targets whose like step had
    // silently failed, which is the exact pattern the setting exists to avoid.
    // `_iterationDidLike` is set by every per-target like block; the gate below
    // consults it before each send.
    let _iterationDidLike = false;

    // Returns true when it is OK to DM the current target. When the setting is
    // on and no like landed, it makes ONE more attempt (the multi-like step is
    // the flakiest part of the profile flow) before skipping the target.
    const warmedUpForDM = async () => {
      if (!config.requireLikeBeforeDM) return true;
      if (_iterationDidLike) return true;
      if (config.dailyMaxLikes > 0 && sessionState.stats.likesSent >= config.dailyMaxLikes) {
        // Like budget is spent for the day — the warm-up requirement can't be
        // met any more, so stop DMing rather than sending un-warmed.
        addLog('dm_skipped', '⏭️ Daily like budget spent — skipping DM (Like-before-DM is on)');
        return false;
      }
      const liked = await sendActionToTab('profileLike');
      if (liked) {
        sessionState.stats.likesSent++;
        _iterationDidLike = true;
        addLog('like', '❤️ Liked a post (warm-up before DM)');
        await waitMs(getRandom(1500, 4000));
        return true;
      }
      addLog('dm_skipped', '⏭️ Could not like this profile — skipping DM (Like-before-DM is on)');
      return false;
    };

    const { stats: s, config: c } = sessionState;
    
    // Only consider a limit "hit" if the max is > 0 AND we've reached it
    const likesHit = c.dailyMaxLikes > 0 && s.likesSent >= c.dailyMaxLikes;
    const followsHit = c.followEnabled && c.dailyMaxFollows > 0 && s.followsSent >= c.dailyMaxFollows;
    const dmsHit = c.dailyMaxDMs > 0 && s.dmsSent >= c.dailyMaxDMs;
    
    // All enabled limits must be hit (limits set to 0 = disabled, not "reached")
    const allEnabled = [
      c.dailyMaxLikes > 0 ? likesHit : null,
      (c.followEnabled && c.dailyMaxFollows > 0) ? followsHit : null,
      c.dailyMaxDMs > 0 ? dmsHit : null,
    ].filter(v => v !== null);
    
    const hitAllLimits = allEnabled.length > 0 && allEnabled.every(v => v === true);
    
    if (hitAllLimits) {
      addLog('session_end', '✅ All daily limits reached — session complete');
      sessionState.warmupOffer = true;
      break;
    }

    // Hard DM-cap stop — when DMs are the primary configured action, hitting
    // the cap should end the session even if likes/follows are still under
    // their (much higher) caps. Without this, a user who set "20 DMs" would
    // see the loop keep scrolling looking for more DM targets after 20 was
    // already hit, because likesHit / followsHit weren't both true yet.
    if (c.dailyMaxDMs > 0 && s.dmsSent >= c.dailyMaxDMs) {
      addLog('session_end', `🎯 ${platform === 'tiktok' ? 'Comment' : 'DM'} goal reached (${c.dailyMaxDMs}) — session complete`);
      sessionState.warmupOffer = true;
      break;
    }

    // Daily session goal check — counts DMs from THIS session AND every
    // earlier session today (local-midnight rollover, scoped to the user's
    // own timezone). Lets the user split a 20-DM target across multiple
    // smaller sessions; the counter wipes at the user's local midnight.
    const dmGoal = sessionState.config.sessionDmGoal || 0;
    if (dmGoal > 0) {
      const dailySent = getDailyDmsSentCount();
      if (dailySent >= dmGoal) {
        const verb = platform === 'tiktok' ? 'comment' : 'DM';
        addLog('session_end', `🎯 Daily ${verb} goal reached (${dailySent}/${dmGoal} today) — session complete`);
        sessionState.warmupOffer = true;
        break;
      }
    }

    let performed = false;

    if (isAITargeting) {
      switch (aiPhase) {
        case 'search': {
          // Convert search terms to hashtags for better discovery
          const terms = aiTargeting.searchTerms;
          const currentTerm = terms[searchTermIndex.current % terms.length];
          searchTermIndex.current++;
          // Convert term to hashtag format (remove spaces, join words)
          const hashtag = currentTerm.replace(/\s+/g, '').toLowerCase();
          
          if (platform === 'tiktok') {
            performed = await sendActionToTab('discoverSearch', null, [currentTerm]);
          } else {
            // Use hashtag navigation instead of text search for better results
            performed = await sendActionToTab('navigateHashtag', null, [hashtag]);
          }
          if (performed) {
            sessionState.stats.scrolls++;
            addLog('scroll', `#️⃣ AI: Browsing #${hashtag} on ${platformLabel}`);
            aiPhase = 'browse';
          }
          break;
        }
        case 'browse': {
          // Scroll through recent posts on the hashtag page
          performed = await sendActionToTab('scroll');
          if (performed) {
            sessionState.stats.scrolls++;
            addLog('scroll', '👁 AI: Browsing recent posts');
          }
          aiPhase = 'visitProfile';
          break;
        }
        case 'visitProfile': {
          // Visit a profile from the hashtag page, check recency
          performed = await sendActionToTab('engageRecentAccount');
          if (performed) {
            addLog('scroll', '🎯 AI: Visiting recent poster\'s profile');
            aiPhase = 'engage';
          } else {
            // No recent accounts found, try another hashtag
            addLog('scroll', '⏭️ AI: No recent accounts, switching hashtag');
            aiPhase = 'search';
          }
          break;
        }
        case 'engage': {
          const engageActions = [];
          if (sessionState.stats.likesSent < config.dailyMaxLikes) engageActions.push('like');
          if (config.followEnabled && sessionState.stats.followsSent < config.dailyMaxFollows && config.dailyMaxFollows > 0) engageActions.push('follow');
          if (dmCapAllowsAnother(config)) engageActions.push('dm');

          if (engageActions.length === 0) {
            addLog('session_end', 'All daily limits reached');
            sessionState.isRunning = false;
            break;
          }

          // Skip AI targets already handled in persistent history
          const aiTargetUsername = normalizeInstagramUsername(await getCurrentInstagramProfileUsername());
          if (aiTargetUsername && isAccountAlreadyHandled(aiTargetUsername)) {
            addLog('scroll', `⏭️ AI: @${aiTargetUsername} already processed — skipping`);
            aiPhase = 'browse';
            break;
          }
          if (aiTargetUsername) {
            await rememberProcessedAccount(aiTargetUsername);
          }

          // Check if profile has recent activity (within 3 months)
          const isRecent = await sendActionToTab('checkProfileRecency');
          if (!isRecent) {
            addLog('scroll', '⏭️ AI: Profile inactive (no posts in 3 months), skipping');
            aiPhase = 'browse';
            break;
          }

          // Demographics filter check for AI targeting
          const demoPassAI = await checkDemographicsFilter();
          if (!demoPassAI) {
            addLog('scroll', '⏭️ AI: Demographics mismatch, skipping');
            aiPhase = 'browse';
            break;
          }

          if (engageActions.includes('like')) {
            const likeAction = platform === 'tiktok' ? 'creatorLike' : 'profileLike';
            performed = await sendActionToTab(likeAction);
            if (performed) {
              sessionState.stats.likesSent++;
              _iterationDidLike = true;
              addLog('like', '❤️ AI: Liked post on similar account');
            }
            await waitMs(getRandomDelay(config));
          }

          // Follow (30% chance)
          if (engageActions.includes('follow') && Math.random() < 0.3) {
            const followAction = platform === 'tiktok' ? 'creatorFollow' : 'profileFollow';
            performed = await sendActionToTab(followAction);
            if (performed) {
              sessionState.stats.followsSent++;
              addLog('follow', '➕ AI: Followed similar account');
            }
            await waitMs(getRandomDelay(config));
          }

           // Always attempt DM when action is picked
          if (engageActions.includes('dm')) {
            const msg = pickMessage();
            if (msg) {
              // v2.4.150: `aiDmTarget` MUST live in this scope, not inside the
              // else-branch. It was block-scoped to the `else { }` below, so the
              // `if (performed)` block threw
              //   ReferenceError: aiDmTarget is not defined
              // on EVERY successful Instagram DM in AI-targeting mode — the
              // session died right after the first DM landed.
              let aiDmTarget = null;
              if (platform === 'tiktok') {
                performed = await sendActionToTab('creatorComment', msg);
              } else {
                aiDmTarget = await waitForInstagramProfileUsername({ attempts: 6, delayMs: 350 });
                if (aiDmTarget) {
                  // v2.4.150: honor the between-DM cooldown / burst pause here
                  // too. Only the hashtag, commenter and location branches used
                  // to call this, so AI targeting sent at full speed.
                  // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
                  // whose warm-up like never landed.
                  if (!(await warmedUpForDM())) break;
                  const okToSend = await enforceDmPacingBeforeSend(addLog);
                  if (!okToSend) break;
                  performed = await sendInstagramDirectComposeDM(msg, aiDmTarget);
                } else {
                  performed = false;
                }
              }
              if (performed) {
                sessionState.stats.dmsSent++;
                recordDmSentForPacing();
                _iterationDidSendDM = true;
                addLog('dm', platform === 'tiktok' ? '💬 AI: Comment sent' : `📨 AI: DM sent to recent account`);
                if (platform !== 'tiktok' && aiDmTarget) {
                  try { await postCommentAfterDM(aiDmTarget); } catch {}
                }
              } else {
                addLog('dm_skipped', '⏭️ DM skipped — moving to next account');
              }
            } else {
              addLog('dm_skipped', '⚠️ No DM script configured');
            }
          }

          accountsEngaged++;
          if (accountsEngaged % 3 === 0) {
            aiPhase = 'search';
          } else {
            aiPhase = 'browse';
          }
          break;
        }
      }
    } else {
      // ── Manual Targeting Session Flow ──
      // CLEAR workflow per account: open modal → pick account → go to profile → like → DM via 3-dots → go back → repeat
      const targeting = sessionState.targeting || {};
      const targetType = targeting.targetTypes?.[0] || '';
      const hasTargeting = ['hashtags', 'followers', 'following', 'location', 'likers', 'commenters', 'custom'].includes(targetType);
      
      // Faster delay helper — still varied but tighter
      const humanDelay = (base) => Math.max(300, Math.round(base * 0.5) + getRandom(-200, 200));
      
      if (hasTargeting && (targetType === 'followers' || targetType === 'following') && targeting.targetUsername?.trim()) {
        // ═══ FOLLOWERS/FOLLOWING FLOW ═══
        // Step 1: Navigate to target profile and open followers/following modal
        const onTargetPage = await sendActionToTab('navigateUserFollowers', null, [targeting.targetUsername, targetType]);
        if (!onTargetPage) {
          addLog('dm_skipped', `⚠️ Could not open ${targetType} list for @${targeting.targetUsername}`);
          sessionState.stats.scrolls++;
          await waitMs(humanDelay(1500));
          continue;
        }
        addLog('scroll', `👥 Opened ${targetType} of @${targeting.targetUsername}`);
        sessionState.stats.scrolls++;
        await waitMs(humanDelay(1000));
        
        // Step 2: Pick an account from the modal (retry with deeper scrolling if needed)
        let visited = false;
        let selectedFollowerUsername = null;
        const maxModalAttempts = 5;
        for (let attempt = 0; attempt < maxModalAttempts; attempt++) {
          const engageResult = await sendActionToTab('engageFollowerModalCandidate');
          visited = Boolean(engageResult?.success || engageResult === true);
          selectedFollowerUsername = normalizeInstagramUsername(engageResult?.username);
          if (visited) break;
          addLog('scroll', `🔄 No fresh accounts yet, scrolling follower popup deeper (${attempt + 2}/${maxModalAttempts})...`);
          await sendActionToTab('navigateUserFollowers', null, [targeting.targetUsername, targetType]);
          await waitMs(humanDelay(550));
        }
        if (!visited) {
          addLog('dm_skipped', '⚠️ Could not load new followers/following accounts from popup');
          await waitMs(humanDelay(700));
          continue;
        }
        
        // Now we're on the target user's profile page
        addLog('scroll', '🎯 Opened account profile from list');
        await waitMs(humanDelay(1200));

        // Pre-check: skip if already handled in persistent history (DM sent or already processed)
        const sourceTargetUsername = normalizeInstagramUsername(targeting.targetUsername);
        const followerProfileUsername = selectedFollowerUsername || await waitForInstagramProfileUsername({
          exclude: sourceTargetUsername ? [sourceTargetUsername] : [],
          attempts: 10,
          delayMs: 400,
        });

        if (followerProfileUsername && isAccountAlreadyHandled(followerProfileUsername)) {
          addLog('scroll', `⏭️ @${followerProfileUsername} already processed — skipping`);
          const clean = targeting.targetUsername.replace(/^@/, '');
          await sendActionToTab('navigateProfile', null, [clean]);
          await waitMs(humanDelay(300));
          continue;
        }
        
        // Check if profile is accessible (not found, private, restricted)
        const accessCheck = await sendActionToTab('isProfileAccessible');
        if (shouldSkipForAccess(accessCheck)) {
          addLog('dm_skipped', `⏭️ ${describeAccessSkip(accessCheck, followerProfileUsername)}`);
          if (followerProfileUsername) await rememberProcessedAccount(followerProfileUsername);
          const clean = targeting.targetUsername.replace(/^@/, '');
          await sendActionToTab('navigateProfile', null, [clean]);
          await waitMs(humanDelay(300));
          continue;
        }
        
        // Demographics filter check
        const demoPass1 = await checkDemographicsFilter(followerProfileUsername);
        if (!demoPass1) {
          if (followerProfileUsername) await rememberProcessedAccount(followerProfileUsername);
          const clean = targeting.targetUsername.replace(/^@/, '');
          await sendActionToTab('navigateProfile', null, [clean]);
          await waitMs(humanDelay(300));
          continue;
        }

        // Mark as processed AFTER all checks pass — so wrongly-rejected accounts can be retried
        if (followerProfileUsername) {
          await rememberProcessedAccount(followerProfileUsername);
        }
        
        // Step 3: Browse profile humanly (scroll, view stories) — especially in human mode
        const isHumanMode = config.dmMode === 'human';
        if (!shouldStop() && (isHumanMode || Math.random() < 0.6)) {
          addLog('scroll', '👀 Browsing profile...');
          await sendActionToTab('browseProfile');
          await waitMs(humanDelay(isHumanMode ? 1500 : 800));
        }
        
        // Step 4: Like 1-3 posts
        if (!shouldStop() && sessionState.stats.likesSent < config.dailyMaxLikes) {
          try {
            const result = await sendProfileMultiLike();
            if (result.success && result.likesCount > 0) {
              sessionState.stats.likesSent += result.likesCount;
              _iterationDidLike = true;
              addLog('like', `❤️ Liked ${result.likesCount} post(s)`);
            }
          } catch (e) {
            const liked = await sendActionToTab('profileLike');
            if (liked) {
              sessionState.stats.likesSent++;
              _iterationDidLike = true;
              addLog('like', '❤️ Liked a post');
            }
          }
          await waitMs(humanDelay(1000));
        }
        
        // Step 4: Follow (~15% chance)
        if (!shouldStop() && config.followEnabled && sessionState.stats.followsSent < config.dailyMaxFollows && config.dailyMaxFollows > 0 && Math.random() < 0.15) {
          const followed = await sendActionToTab('profileFollow');
          if (followed) {
            sessionState.stats.followsSent++;
            addLog('follow', '➕ Followed account');
          }
          await waitMs(humanDelay(800));
        }
        
        // Step 5: SEND DM — ensure we're on the profile page first
        if (!shouldStop() && dmCapAllowsAnother(config)) {
          const msg = pickMessage();
          if (msg) {
            addLog('dm', '💬 Attempting DM...');
            const dmTargetUsername = normalizeInstagramUsername(followerProfileUsername)
              || normalizeInstagramUsername(await getCurrentInstagramProfileUsername());
            // Navigate back to profile in case multiLike left us on /p/ page
            if (dmTargetUsername) {
              await sendActionToTab('navigateProfile', null, [dmTargetUsername]);
              await waitMs(humanDelay(800));
            }
            // v2.4.150: the followers/following branch never honored the
            // between-DM cooldown, the burst pause or the hourly cap — only
            // hashtags, commenters and location did. Targeting a big account's
            // follower list therefore fired DMs back-to-back at whatever speed
            // the DOM allowed, which is the single most flaggable pattern the
            // bot can produce.
            // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
            // whose warm-up like never landed.
            if (!(await warmedUpForDM())) {
              // Move on without marking the account processed. A failed warm-up
              // like is transient (slow load, no visible posts, a hiccup), not a
              // reason to burn the lead forever — the same rule the access and
              // filter skips follow. Re-picking within this session is already
              // prevented: hashtag/location posts go into visitedPostsThisSession
              // when opened, the followers modal marks traversal-visited, and the
              // commenter loop tracks processedCommenters.
              continue;
            }
            const okToSend = await enforceDmPacingBeforeSend(addLog);
            if (!okToSend) break;
            const dmSent = dmTargetUsername
              ? await sendInstagramDirectComposeDM(msg, dmTargetUsername)
              : false;
            if (dmSent) {
              sessionState.stats.dmsSent++;
              recordDmSentForPacing();
              _iterationDidSendDM = true;
              if (dmTargetUsername) await addToBgDMHistory(dmTargetUsername);
              addLog('dm', '📨 DM sent successfully!');
              if (dmTargetUsername) { try { await postCommentAfterDM(dmTargetUsername); } catch {} }
            } else {
              addLog('dm_skipped', '⏭️ DM could not be sent — moving to next account');
              noteTargetFailed(dmTargetUsername, 'DM could not be sent');
            }
            await waitMs(humanDelay(1200));
          } else {
            addLog('dm_skipped', '⚠️ No DM script configured');
          }
        }
        
        if (shouldStop()) continue;
        
        // Step 6: Navigate back
        const clean = targeting.targetUsername.replace(/^@/, '');
        addLog('scroll', `↩️ Navigating back to @${clean}...`);
        await sendActionToTab('navigateProfile', null, [clean]);
        await waitMs(humanDelay(800));
        
        // Pause between accounts (1.5-3.5 seconds)
        await waitMs(getRandom(1500, 3500));
        performed = true;
        
      } else if (hasTargeting && targetType === 'hashtags' && targeting.hashtags?.trim()) {
        // ═══ HASHTAG FLOW (ONE-AT-A-TIME): navigate → pick post → profile → engage → DM → back ═══
        // Mirrors the location flow: content script finds username, stores in chrome.storage,
        // background.js polls for it, then navigates to profile and engages.
        const tags = targeting.hashtags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
        const tag = tags[Math.floor(Math.random() * tags.length)];
        
        // Step 1: Navigate to hashtag page (if not already there)
        const onHashtagPage = await sendActionToTab('navigateHashtag', null, [tag]);
        if (!onHashtagPage) {
          sessionState.stats.scrolls++;
          addLog('scroll', `⚠️ Could not load #${tag} page, retrying...`);
          await waitMs(humanDelay(2000));
          await sendActionToTab('scroll');
          continue;
        }
        addLog('scroll', `#️⃣ On #${tag} page — engaging posts one by one`);
        sessionState.stats.scrolls++;
        await waitMs(humanDelay(2000));

        // Drift guard
        {
          const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          if (tab?.url?.includes('/reels/') || tab?.url?.includes('/direct/')) {
            addLog('scroll', '⚠️ Drifted off hashtag results — restoring');
            await sendActionToTab('navigateHashtag', null, [tag]);
            await waitMs(humanDelay(1800));
            continue;
          }
        }

        // Step 2: Ask the content script to click the next unvisited post,
        // extract the poster username, store it in chrome.storage, and close the modal.
        // Use the location-style direct message flow here to avoid reconnect loops.
        await chrome.storage.local.set({ futnor_hashtag_target_username: '' });

        let hashUsername = null;
        {
          const fireTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          if (fireTab) {
            await ensureContentScript(fireTab.id, sessionState.platform);
            chrome.tabs.sendMessage(fireTab.id, {
              type: 'PERFORM_ACTION',
              action: 'engageNextHashtagPost',
            }).catch(() => {/* expected if the page hiccups mid-action */});
          }
        }

        for (let poll = 0; poll < 40; poll++) {
          await waitMs(500);
          if (shouldStop()) break;
          try {
            const stored = await chrome.storage.local.get('futnor_hashtag_target_username');
            const candidate = (stored?.futnor_hashtag_target_username || '').toLowerCase().replace(/^@/, '').trim();
            if (candidate) {
              hashUsername = candidate;
              break;
            }
          } catch {}
        }
        if (shouldStop()) break;

        if (hashUsername) await waitMs(humanDelay(1200));

        if (!hashUsername) {
          addLog('dm_skipped', `⚠️ No new account found on #${tag} — moving to the next post...`);
          await sendActionToTab('returnToHashtagResults', null, [tag]);
          await waitMs(humanDelay(1200));
          continue;
        }

        // Navigate to the profile from background.js
        {
          const navOk = await sendActionToTab('navigateProfile', null, [hashUsername]);
          if (!navOk) {
            const fallbackTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
            if (fallbackTab) {
              await navigateTabAndWait(fallbackTab.id, `https://www.instagram.com/${hashUsername}/`);
            }
          }
          await waitMs(humanDelay(2000));
        }

        // Verify we landed on the profile page
        {
          const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          const tabUrl = tab?.url || '';
          if (!tabUrl.includes(`/${hashUsername}`)) {
            addLog('scroll', `⚠️ Not on @${hashUsername}'s profile — navigating directly`);
            const fallbackTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
            if (fallbackTab) {
              await navigateTabAndWait(fallbackTab.id, `https://www.instagram.com/${hashUsername}/`);
            }
            await waitMs(humanDelay(2000));
          }
        }

        addLog('scroll', `🎯 On @${hashUsername}'s profile — engaging...`);

        // Check DM limits
        if (dmCapReached(config)) {
          addLog('session_end', '✅ DM limit reached');
          sessionState.isRunning = false;
          break;
        }
        // v2.4.150: rest out the rolling hour instead of ending the run. This
        // used to set isRunning = false while logging "pausing", which made the
        // configured DM goal unreachable whenever it exceeded hourlyMaxDMs.
        // waitOutHourlyDmCap() returns false only when the user stopped the
        // session, so the break below still exits cleanly in that case.
        if (isHourlyDMCapHit(config)) {
          if (!(await waitOutHourlyDmCap(addLog))) break;
        }

        // Skip already handled
        if (isAccountAlreadyHandled(hashUsername)) {
          addLog('scroll', `⏭️ @${hashUsername} already processed — returning to #${tag}`);
          await sendActionToTab('returnToHashtagResults', null, [tag]);
          await waitMs(humanDelay(800));
          continue;
        }

        try {
          sessionState.stats.scrolls++;

          // Check profile accessibility — definitive rejections only.
          const accessCheck = await sendActionToTab('isProfileAccessible');
          if (shouldSkipForAccess(accessCheck)) {
            addLog('dm_skipped', `⏭️ ${describeAccessSkip(accessCheck, hashUsername)}`);
            await rememberProcessedAccount(hashUsername);
            await sendActionToTab('returnToHashtagResults', null, [tag]);
            await waitMs(humanDelay(800));
            continue;
          }

          // Demographics filter — definitive rejection.
          const demoPass = await checkDemographicsFilter(hashUsername);
          if (!demoPass) {
            await rememberProcessedAccount(hashUsername);
            await sendActionToTab('returnToHashtagResults', null, [tag]);
            await waitMs(humanDelay(800));
            continue;
          }

          // Browse profile humanly
          const isHumanMode = config.dmMode === 'human';
          if (!shouldStop() && (isHumanMode || Math.random() < 0.6)) {
            addLog('scroll', '👀 Browsing profile...');
            await sendActionToTab('browseProfile');
            await waitMs(humanDelay(isHumanMode ? 1500 : 800));
          }

          if (shouldStop()) break;

          // Like 1-3 posts
          if (!shouldStop() && sessionState.stats.likesSent < config.dailyMaxLikes) {
            try {
              const result = await sendProfileMultiLike();
              if (result.success && result.likesCount > 0) {
                sessionState.stats.likesSent += result.likesCount;
                _iterationDidLike = true;
                addLog('like', `❤️ Liked ${result.likesCount} post(s)`);
              }
            } catch (e) {
              const liked = await sendActionToTab('profileLike');
              if (liked) { sessionState.stats.likesSent++; _iterationDidLike = true; addLog('like', '❤️ Liked a post'); }
            }
            await waitMs(humanDelay(1000));
          }

          // Follow (~15% chance)
          if (!shouldStop() && config.followEnabled && sessionState.stats.followsSent < config.dailyMaxFollows && config.dailyMaxFollows > 0 && Math.random() < 0.15) {
            const followed = await sendActionToTab('profileFollow');
            if (followed) {
              sessionState.stats.followsSent++;
              addLog('follow', '➕ Followed account');
            }
            await waitMs(humanDelay(800));
          }

          // Guard: escape /reels/ if needed
          {
            const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
            if (tab?.url?.includes('/reels/')) {
              addLog('scroll', '⚠️ Escaped /reels/ — recovering profile before DM');
              await sendActionToTab('navigateProfile', null, [hashUsername]);
              await waitMs(humanDelay(1800));
            }
          }

          // Send DM
          if (!shouldStop() && dmCapAllowsAnother(config)) {
            const msg = pickMessage();
            if (msg) {
              addLog('dm', `💬 Attempting DM to @${hashUsername}...`);
              // Navigate back to profile in case multiLike left us on /p/ page
              const navBackOk = await sendActionToTab('navigateProfile', null, [hashUsername]);
              if (!navBackOk) {
                const fallbackTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
                if (fallbackTab) {
                  await navigateTabAndWait(fallbackTab.id, `https://www.instagram.com/${hashUsername}/`);
                }
              }
              await waitMs(humanDelay(1500));
              // Honor between-DM cooldown + burst-pause settings before sending.
              // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
              // whose warm-up like never landed.
              if (!(await warmedUpForDM())) {
                // Move on without marking the account processed. A failed warm-up
                // like is transient (slow load, no visible posts, a hiccup), not a
                // reason to burn the lead forever — the same rule the access and
                // filter skips follow. Re-picking within this session is already
                // prevented: hashtag/location posts go into visitedPostsThisSession
                // when opened, the followers modal marks traversal-visited, and the
                // commenter loop tracks processedCommenters.
                continue;
              }
              const okToSend = await enforceDmPacingBeforeSend(addLog);
              if (!okToSend) break;
              const dmSent = await sendInstagramDirectComposeDM(msg, hashUsername);

              if (dmSent) {
                sessionState.stats.dmsSent++;
                recordDmSentForPacing();
                await addToBgDMHistory(hashUsername);
                await rememberProcessedAccount(hashUsername);
                addLog('dm', `📨 DM sent to @${hashUsername}!`);
                try { await postCommentAfterDM(hashUsername); } catch {}
              } else {
                addLog('dm_skipped', `⏭️ DM could not be sent to @${hashUsername} — will retry next session`);
                noteTargetFailed(hashUsername, 'DM could not be sent');
              }
              await waitMs(humanDelay(1200));
            } else {
              addLog('dm_skipped', '⚠️ No DM script configured');
            }
          }

          // Mark visited in content script
          await sendActionToTab('markVisited', null, [hashUsername]);

          // Return to hashtag results while preserving current position when possible
          addLog('scroll', `↩️ Returning to #${tag} results...`);
          await sendActionToTab('returnToHashtagResults', null, [tag]);
          await waitMs(humanDelay(1500));

          // Pause between accounts — honor user's Action Delay slider.
          const delay2 = getRandomDelay(config);
          await waitMs(delay2);
          elapsed = activeElapsedSec();
          sessionState.stats.elapsedTime = Math.round(elapsed);
          saveState();
        } catch (e) {
          console.error(`[Futnor Background] Error processing hashtag user @${hashUsername}:`, e);
          addLog('dm_skipped', `⚠️ Error while processing @${hashUsername} — moving on`);
          try { await sendActionToTab('markVisited', null, [hashUsername]); } catch {}
          try { await sendActionToTab('returnToHashtagResults', null, [tag]); } catch {}
          await waitMs(humanDelay(800));
        }

        performed = true;
        
      } else if (hasTargeting && targetType === 'commenters' && targeting.targetPostLink?.trim()) {
        // ═══ COMMENTER NETWORK FLOW ═══
        // Recursive: extract commenters from target post → DM each → then visit each commenter's
        // recent post → extract THEIR commenters → DM those → continue expanding the network
        
        const commenterNetworkQueue = []; // Array of { postUrl, depth, sourceCommenter }
        commenterNetworkQueue.push({ postUrl: targeting.targetPostLink.trim(), depth: 0, sourceCommenter: 'original' });
        
        // Track commenters we've already queued to avoid infinite loops
        const queuedCommenters = new Set();
        // Track commenters processed in this session loop (prevents duplicate profile visits)
        const processedCommenters = new Set();
        // Track original post commenters for network expansion
        const originalPostCommenters = [];
        let originalCommenterIndex = 0;

        // v2.4.140: per-source outcome accounting. The user said the bot
        // "just shut down without saying anything" — even though one
        // completion line was emitted ("Commenters from target post
        // processed"), it didn't reveal WHY most commenters didn't get
        // DM'd. The accumulators below get totalled and dumped as a
        // clear summary every time the bot finishes a post's commenter
        // list, so the user can see "31 found, 1 DM'd, 28 already-DM'd,
        // 2 inaccessible" instead of a single mysterious line.
        const commenterStats = {
          totalFound: 0,
          dmSent: 0,
          skippedAlreadyDMd: 0,
          skippedInaccessible: 0,
          skippedFiltered: 0,
          skippedDmFailed: 0,
          skippedError: 0,
        };

        addLog('scroll', `🕸️ Starting commenter network from target post`);
        
        while (commenterNetworkQueue.length > 0 && sessionState.isRunning && !sessionBudgetSpent()) {
          // Check limits
          // v2.4.150: this read `dmsSent >= dailyMaxDMs || dailyMaxDMs === 0`,
          // which treated an unlimited cap as an already-reached one — a user
          // who set the DM cap to 0 (= off, the meaning everywhere else in this
          // file) got "DM limit reached — session complete" before a single
          // commenter was processed.
          const hitLimits = dmCapReached(config);
          if (hitLimits) {
            addLog('session_end', '✅ DM limit reached — session complete');
            sessionState.isRunning = false;
            break;
          }
          // v2.4.150: rest out the rolling hour instead of ending the run. This
          // used to set isRunning = false while logging "pausing", which made the
          // configured DM goal unreachable whenever it exceeded hourlyMaxDMs.
          // waitOutHourlyDmCap() returns false only when the user stopped the
          // session, so the break below still exits cleanly in that case.
          if (isHourlyDMCapHit(config)) {
            if (!(await waitOutHourlyDmCap(addLog))) break;
          }
          
          const current = commenterNetworkQueue.shift();
          const depthLabel = current.depth === 0 ? '📌 Original post' : `🔗 Depth ${current.depth} (from @${current.sourceCommenter})`;
          addLog('scroll', `${depthLabel} — navigating to post...`);
          
          // Step 1a: Navigate to the post directly from background (avoids content script reload issues)
          let postUrl = current.postUrl;
          if (!postUrl.startsWith('http')) {
            postUrl = `https://www.instagram.com/p/${postUrl}/`;
          }
          if (!postUrl.includes('instagram.com')) {
            postUrl = `https://www.instagram.com${postUrl.startsWith('/') ? '' : '/p/'}${postUrl}`;
          }
          
          // Navigate the tab directly and wait for it to load
          const postTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          if (!postTab) {
            addLog('dm_skipped', `⏭️ No Instagram tab found`);
            continue;
          }
          
          const tabId = postTab.id;
          await new Promise((resolve) => {
            chrome.tabs.update(tabId, { url: postUrl }, () => {
              // Wait for the tab to finish loading
              const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              // Timeout fallback
              setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }, 8000);
            });
          });
          
          // Wait for content script to re-initialize after page load
          await waitMs(humanDelay(3000));
          
          // Ping content script to make sure it's ready
          let contentReady = false;
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const pingResult = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, { type: 'PING' }, (resp) => {
                  if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                  else resolve(resp);
                });
              });
              if (pingResult && pingResult.ready) {
                contentReady = true;
                break;
              }
            } catch (e) {
              await waitMs(1000);
            }
          }
          
          if (!contentReady) {
            addLog('dm_skipped', `⏭️ Content script not ready on post page`);
            continue;
          }
          
          // Step 1b: Now extract commenters from the loaded page (no navigation)
          addLog('scroll', `${depthLabel} — scrolling comments & extracting usernames...`);
          const extractResult = await sendActionToTab('extractCommenters');
          let commenters = [];
          if (extractResult && extractResult.commenters) {
            commenters = extractResult.commenters;
          } else if (extractResult && Array.isArray(extractResult)) {
            commenters = extractResult;
          }
          
          if (commenters.length === 0) {
            addLog('dm_skipped', `⏭️ No commenters found on post — ${current.depth === 0 ? 'check post link' : 'skipping'}`);
            await waitMs(humanDelay(1000));
            
            // If this was from the network expansion, continue to next queued item
            continue;
          }
          
          commenterStats.totalFound += commenters.length;
          addLog('scroll', `👥 Found ${commenters.length} commenters to process`);
          
          // Store commenters for network expansion later
          // Include ALL commenters (even already-handled ones) because they can
          // still serve as expansion sources — we visit their posts to find NEW
          // commenters, we don't re-DM them.
          for (const c of commenters) {
            const normalizedCommenter = normalizeInstagramUsername(c);
            if (!normalizedCommenter) continue;
            if (!queuedCommenters.has(normalizedCommenter)) {
              originalPostCommenters.push(normalizedCommenter);
              queuedCommenters.add(normalizedCommenter);
            }
          }
          
          // Step 2: Process each commenter — navigate to profile, filter, browse, DM
          for (let ci = 0; ci < commenters.length && sessionState.isRunning && !sessionBudgetSpent(); ci++) {
            const commenterUsername = (commenters[ci] || '').toLowerCase().replace(/^@/, '').trim();

            if (!commenterUsername) continue;

            // Check DM limits
            if (dmCapReached(config)) {
              addLog('session_end', '✅ DM limit reached');
              sessionState.isRunning = false;
              break;
            }
            // v2.4.150: rest out the rolling hour instead of ending the run. This
            // used to set isRunning = false while logging "pausing", which made the
            // configured DM goal unreachable whenever it exceeded hourlyMaxDMs.
            // waitOutHourlyDmCap() returns false only when the user stopped the
            // session, so the break below still exits cleanly in that case.
            if (isHourlyDMCapHit(config)) {
              if (!(await waitOutHourlyDmCap(addLog))) break;
            }
            // v2.4.144: Daily Session Goal check inside the commenter flow.
            // Previously only the top-of-loop in the main session checked
            // this — the commenter network has its own inner loop, so once
            // the bot was inside it, the per-session goal was never
            // evaluated until processing returned to the top. User said
            // "should mention when daily DM goal is reached which is what
            // it's not doing".
            const dailyGoal = sessionState.config.sessionDmGoal || 0;
            if (dailyGoal > 0) {
              const dailySoFar = getDailyDmsSentCount();
              if (dailySoFar >= dailyGoal) {
                addLog('session_end', `🎯 Daily DM goal reached (${dailySoFar}/${dailyGoal} today) — session complete`);
                sessionState.isRunning = false;
                break;
              }
            }

            // Skip duplicates in the current processing loop
            if (processedCommenters.has(commenterUsername)) {
              continue;
            }
            processedCommenters.add(commenterUsername);

            // Skip ONLY accounts that have actually been DM'd (dm_history).
            // Do NOT skip accounts that are merely in processed_accounts_history
            // but not in dm_history — those may have been wrongly marked due to
            // past timing/web-worker bugs and deserve another attempt.
            const _normCommenter = normalizeInstagramUsername(commenterUsername);
            if (_normCommenter && isInBgDMHistory(_normCommenter)) {
              addLog('scroll', `⏭️ @${commenterUsername} already DM'd — skipping`);
              commenterStats.skippedAlreadyDMd++;
              continue;
            }
            // v2.4.147: 30-day cooldown — even if the binary history check
            // missed (storage cleared, mis-labelled failure that never
            // wrote to history, etc.) the timestamp ledger is a separate
            // layer of protection. If we DM'd this account in the last
            // 30 days, skip — never re-DM within the cooldown window.
            if (_normCommenter && wasDMdRecently(_normCommenter)) {
              const days = daysSinceDMd(_normCommenter);
              addLog('scroll', `⏭️ @${commenterUsername} DM'd ${days}d ago — within 30-day cooldown, skipping`);
              commenterStats.skippedAlreadyDMd++;
              continue;
            }

            // NOTE: Do NOT mark as processed yet — only mark after a definitive outcome
            // (private/inaccessible, filter mismatch, OR DM sent). This way, if the DM step
            // fails due to a transient issue (timing, popup, etc.), the account stays
            // available to be retried in a future session.

            try {
              addLog('scroll', `🎯 [${ci + 1}/${commenters.length}] Visiting @${commenterUsername}...`);

              // Navigate to commenter's profile
              const navOk = await sendActionToTab('navigateProfile', null, [commenterUsername]);
              if (!navOk) {
                addLog('dm_skipped', `⏭️ Could not navigate to @${commenterUsername} — will retry next session`);
                await waitMs(humanDelay(800));
                continue;
              }
              await waitMs(humanDelay(1500));
              sessionState.stats.scrolls++;

              // Check profile accessibility (private, restricted, etc.)
              // These are definitive rejections — mark as processed so we don't waste time revisiting.
              const accessCheck = await sendActionToTab('isProfileAccessible');
              if (shouldSkipForAccess(accessCheck)) {
                addLog('dm_skipped', `⏭️ ${describeAccessSkip(accessCheck, commenterUsername)}`);
                await rememberProcessedAccount(commenterUsername);
                commenterStats.skippedInaccessible++;
                await waitMs(humanDelay(800));
                continue;
              }

              // Demographics / follower / post count filter — definitive rejection
              const demoPass = await checkDemographicsFilter(commenterUsername);
              if (!demoPass) {
                await rememberProcessedAccount(commenterUsername);
                commenterStats.skippedFiltered++;
                await waitMs(humanDelay(800));
                continue;
              }

              // Browse profile humanly (human mode or 60% chance)
              const isHumanMode = config.dmMode === 'human';
              if (!shouldStop() && (isHumanMode || Math.random() < 0.6)) {
                addLog('scroll', '👀 Browsing profile...');
                await sendActionToTab('browseProfile');
                await waitMs(humanDelay(isHumanMode ? 1500 : 800));
              }

              if (shouldStop()) break;

              // Like 1-3 posts
              if (!shouldStop() && sessionState.stats.likesSent < config.dailyMaxLikes) {
                try {
                  const result = await sendProfileMultiLike();
                  if (result.success && result.likesCount > 0) {
                    sessionState.stats.likesSent += result.likesCount;
                    _iterationDidLike = true;
                    addLog('like', `❤️ Liked ${result.likesCount} post(s)`);
                  }
                } catch (e) {
                  const liked = await sendActionToTab('profileLike');
                  if (liked) { sessionState.stats.likesSent++; _iterationDidLike = true; addLog('like', '❤️ Liked a post'); }
                }
                await waitMs(humanDelay(1000));
              }

              // Follow (~15% chance)
              if (!shouldStop() && config.followEnabled && sessionState.stats.followsSent < config.dailyMaxFollows && config.dailyMaxFollows > 0 && Math.random() < 0.15) {
                const followed = await sendActionToTab('profileFollow');
                if (followed) {
                  sessionState.stats.followsSent++;
                  addLog('follow', '➕ Followed account');
                }
                await waitMs(humanDelay(800));
              }

              // Send DM
              let dmOutcome = 'no_attempt'; // 'sent' | 'failed' | 'no_script' | 'no_attempt'
              if (!shouldStop() && dmCapAllowsAnother(config)) {
                const msg = pickMessage();
                if (msg) {
                  addLog('dm', `💬 Attempting DM to @${commenterUsername}...`);
                  // Navigate back to profile in case multiLike left us on /p/ page
                  const navBackOk = await sendActionToTab('navigateProfile', null, [commenterUsername]);
                  if (!navBackOk) {
                    // Fallback: direct URL navigation via tab
                    addLog('dm', `🔄 Profile nav failed, trying direct URL for @${commenterUsername}...`);
                    const fallbackTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
                    if (fallbackTab) {
                      await navigateTabAndWait(fallbackTab.id, `https://www.instagram.com/${commenterUsername}/`);
                    }
                  }
                  await waitMs(humanDelay(1500));
                  // Honor between-DM cooldown + burst-pause settings before sending.
                  // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
                  // whose warm-up like never landed.
                  if (!(await warmedUpForDM())) {
                    // Move on without marking the account processed. A failed warm-up
                    // like is transient (slow load, no visible posts, a hiccup), not a
                    // reason to burn the lead forever — the same rule the access and
                    // filter skips follow. Re-picking within this session is already
                    // prevented: hashtag/location posts go into visitedPostsThisSession
                    // when opened, the followers modal marks traversal-visited, and the
                    // commenter loop tracks processedCommenters.
                    continue;
                  }
                  const okToSend = await enforceDmPacingBeforeSend(addLog);
                  if (!okToSend) break;
                  const dmSent = await sendInstagramDirectComposeDM(msg, commenterUsername);

                  if (dmSent) {
                    dmOutcome = 'sent';
                    sessionState.stats.dmsSent++;
                    commenterStats.dmSent++;
                    recordDmSentForPacing();
                    await addToBgDMHistory(commenterUsername);
                    addLog('dm', `📨 DM sent to @${commenterUsername}!`);
                    try { await postCommentAfterDM(commenterUsername); } catch {}
                  } else {
                    dmOutcome = 'failed';
                    commenterStats.skippedDmFailed++;
                    addLog('dm_skipped', `⏭️ DM could not be sent to @${commenterUsername} — will retry next session`);
                    noteTargetFailed(commenterUsername, 'DM could not be sent');
                  }
                  await waitMs(humanDelay(1200));
                } else {
                  dmOutcome = 'no_script';
                  addLog('dm_skipped', '⚠️ No DM script configured');
                }
              }

              // Only mark as processed/visited when the DM actually went through.
              // Failed DMs (timing issues, popups, transient errors) stay eligible
              // for retry in a future session — we already liked/browsed, so the next
              // attempt picks up where this one left off.
              if (dmOutcome === 'sent') {
                await rememberProcessedAccount(commenterUsername);
                await sendActionToTab('markVisited', null, [commenterUsername]);
              }

              // Navigate back to the post page before processing next commenter
              // (we may be on /direct/ after DM or on a profile page)
              const navTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
              if (navTab) {
                const currentUrl = navTab.url || '';
                if (currentUrl.includes('/direct/') || !currentUrl.includes('/p/')) {
                  // We'll navigate to the next commenter directly in the next iteration
                }
              }

              // Pause between accounts — honor the user's Action Delay
              // slider (minActionDelay / maxActionDelay). Previously this
              // hardcoded getRandom(2000, 4000) regardless of the slider
              // and the real getRandomDelay() value was only accounted
              // for in elapsed time, never actually waited.
              const delay2 = getRandomDelay(config);
              await waitMs(delay2);
              elapsed = activeElapsedSec();
              sessionState.stats.elapsedTime = Math.round(elapsed);
              saveState();
            } catch (e) {
              console.error(`[Futnor Background] Error processing commenter @${commenterUsername}:`, e);
              addLog('dm_skipped', `⚠️ Error while processing @${commenterUsername} — will retry next session`);
              commenterStats.skippedError++;
              // Do NOT mark as visited/processed on transient errors — let the next session retry.
              await waitMs(humanDelay(800));
            }
          }
          
          // Step 3: After processing all commenters from current post,
          // expand the network — only if commenterNetworkLoop is enabled
          const networkLoopEnabled = targeting.commenterNetworkLoop !== false; // default true for backward compat
          
          if (networkLoopEnabled && sessionState.isRunning && !sessionBudgetSpent() && dmCapAllowsAnother(config)) {
            // Find the next commenter who hasn't been fully handled yet for network expansion.
            // We must loop here instead of using `continue` (which would jump to the outer while
            // and exit immediately when the queue is empty).
            let expanded = false;
            while (originalCommenterIndex < originalPostCommenters.length) {
              const nextCommenter = originalPostCommenters[originalCommenterIndex];
              originalCommenterIndex++;

              if (!nextCommenter) continue;

              // For network expansion we only need their post — it's fine if we already DM'd them.
              // We skip only if we already tried expanding via this commenter before.
              
              addLog('scroll', `🕸️ Expanding network via @${nextCommenter}...`);
              
              // Navigate to commenter's profile
              const navOk = await sendActionToTab('navigateProfile', null, [nextCommenter]);
              if (!navOk) {
                addLog('dm_skipped', `⏭️ Could not navigate to @${nextCommenter} for network expansion`);
                await waitMs(humanDelay(500));
                continue; // try next commenter in originalPostCommenters
              }
              await waitMs(humanDelay(1500));
              
              // Check if profile is accessible
              const accessCheck = await sendActionToTab('isProfileAccessible');
              if (accessCheck && (!accessCheck.accessible || accessCheck.reason === 'no_posts')) {
                addLog('dm_skipped', `⏭️ @${nextCommenter} — ${accessCheck.accessible ? 'no posts' : 'not accessible'}, skipping expansion`);
                await waitMs(humanDelay(500));
                continue; // try next commenter in originalPostCommenters
              }
              
              // Get their recent post
              const postResult = await sendActionToTab('getRecentPostLink');
              if (postResult && postResult.postLink) {
                addLog('scroll', `🔗 Found @${nextCommenter}'s recent post — queuing commenters`);
                commenterNetworkQueue.push({
                  postUrl: postResult.postLink,
                  depth: current.depth + 1,
                  sourceCommenter: nextCommenter,
                });
                expanded = true;
                await waitMs(humanDelay(1500));
                break; // successfully queued — go back to outer while to process this new post
              } else {
                addLog('dm_skipped', `⏭️ @${nextCommenter} has no accessible posts`);
                await waitMs(humanDelay(500));
                continue; // try next commenter
              }
            }
            
            if (!expanded) {
              addLog('scroll', '🕸️ All commenter networks exhausted');
              break;
            }
          } else if (!networkLoopEnabled) {
            // Network loop disabled — just process the original post commenters and stop
            addLog('scroll', '✅ Commenters from target post processed (network loop disabled)');
            break;
          }
        }

        // v2.4.140: end-of-commenters summary so the user sees exactly
        // what happened. Without this the bot was just "shutting down
        // without saying anything" after processing the list.
        {
          const cs = commenterStats;
          const skippedTotal =
            cs.skippedAlreadyDMd
            + cs.skippedInaccessible
            + cs.skippedFiltered
            + cs.skippedDmFailed
            + cs.skippedError;
          const parts = [];
          if (cs.skippedAlreadyDMd > 0)    parts.push(`${cs.skippedAlreadyDMd} already-DM'd`);
          if (cs.skippedInaccessible > 0)  parts.push(`${cs.skippedInaccessible} inaccessible`);
          if (cs.skippedFiltered > 0)      parts.push(`${cs.skippedFiltered} filtered out`);
          if (cs.skippedDmFailed > 0)      parts.push(`${cs.skippedDmFailed} DM send failed`);
          if (cs.skippedError > 0)         parts.push(`${cs.skippedError} errors`);
          const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
          addLog(
            'session_end',
            `📊 Commenter flow complete — ${cs.totalFound} found, ${cs.dmSent} DM'd, ${skippedTotal} skipped${breakdown}`,
          );
        }

        performed = true;
        // Skip the generic engagement below — commenters flow handles everything
        
      } else if (hasTargeting && targetType === 'location' && targeting.location?.trim()) {
        // ═══ LOCATION FLOW (ONE-AT-A-TIME): navigate → pick post → profile → engage → DM → back ═══
        // No batch collection — opens one post at a time, extracts username, engages, DMs,
        // then uses history.back() to return to the location grid (preserving posts & scroll).
        const locationUrl = targeting.location.trim();

        // Step 1: Navigate to location page (only if not already there)
        const onLocationPage = await sendActionToTab('navigateLocation', null, [locationUrl]);
        if (!onLocationPage) {
          sessionState.stats.scrolls++;
          addLog('scroll', `⚠️ Could not load location page, retrying...`);
          await waitMs(humanDelay(2000));
          await sendActionToTab('scroll');
          continue;
        }
        addLog('scroll', `📍 On location page — engaging posts one by one`);
        sessionState.stats.scrolls++;
        await waitMs(humanDelay(2000));

        // Drift guard
        {
          const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          if (tab?.url?.includes('/reels/') || tab?.url?.includes('/direct/')) {
            addLog('scroll', '⚠️ Drifted off location results — restoring');
            await sendActionToTab('navigateLocation', null, [locationUrl]);
            await waitMs(humanDelay(1800));
            continue;
          }
        }

        // Step 2: Open next post → find poster → navigate to their profile.
        // The content script stores the username in chrome.storage BEFORE
        // navigating away (navigation kills sendResponse, so we can't use it).
        // We clear storage first, then fire a TRUE fire-and-forget message
        // (no retries, no reconnect) and poll storage until we see the username.
        await chrome.storage.local.set({ futnor_location_target_username: '' });

        // TRUE fire-and-forget: send directly via chrome.tabs.sendMessage with NO
        // await on the response — we intentionally ignore the error when navigation
        // kills the message channel. Using sendActionToTab would trigger reconnect
        // logic which disrupts the session while the content script is mid-execution.
        {
          const fireTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          if (fireTab) {
            chrome.tabs.sendMessage(fireTab.id, {
              type: 'PERFORM_ACTION',
              action: 'engageNextLocationPost',
            }).catch(() => {/* expected — navigation kills channel */});
          }
        }

        // Poll chrome.storage every 500ms for up to 20s waiting for the username.
        // The content script awaits the storage write BEFORE it navigates, so
        // as soon as we see a non-empty value the profile navigation has begun.
        let locUsername = null;
        for (let poll = 0; poll < 40; poll++) {
          await waitMs(500);
          if (shouldStop()) break;
          try {
            const stored = await chrome.storage.local.get('futnor_location_target_username');
            const candidate = (stored?.futnor_location_target_username || '').toLowerCase().replace(/^@/, '').trim();
            if (candidate) {
              locUsername = candidate;
              break;
            }
          } catch {}
        }
        if (shouldStop()) break;

        // Give extra time for the tab to finish navigating to the profile
        if (locUsername) await waitMs(humanDelay(2000));

        if (!locUsername) {
          addLog('dm_skipped', '⚠️ No new account found at location — scrolling and retrying...');
          // We might be on the location page or somewhere else — try returning
          try { await sendActionToTab('returnToLocationGrid'); } catch {}
          await sendActionToTab('scrollLocationResults');
          await waitMs(humanDelay(2000));
          continue;
        }

        // Verify we actually landed on the profile page
        {
          const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
          const tabUrl = tab?.url || '';
          if (!tabUrl.includes(`/${locUsername}`) && !tabUrl.includes('/direct/')) {
            // Not on the expected profile — try navigating directly
            addLog('scroll', `⚠️ Not on @${locUsername}'s profile — navigating directly`);
            const navOk = await sendActionToTab('navigateProfile', null, [locUsername]);
            if (!navOk) {
              const fallbackTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
              if (fallbackTab) {
                await navigateTabAndWait(fallbackTab.id, `https://www.instagram.com/${locUsername}/`);
              }
            }
            await waitMs(humanDelay(2000));
          }
        }

        addLog('scroll', `🎯 On @${locUsername}'s profile — engaging...`);

        // Check DM limits
        if (dmCapReached(config)) {
          addLog('session_end', '✅ DM limit reached');
          sessionState.isRunning = false;
          break;
        }
        // v2.4.150: rest out the rolling hour instead of ending the run. This
        // used to set isRunning = false while logging "pausing", which made the
        // configured DM goal unreachable whenever it exceeded hourlyMaxDMs.
        // waitOutHourlyDmCap() returns false only when the user stopped the
        // session, so the break below still exits cleanly in that case.
        if (isHourlyDMCapHit(config)) {
          if (!(await waitOutHourlyDmCap(addLog))) break;
        }

        // Skip already handled in persistent history
        if (isAccountAlreadyHandled(locUsername)) {
          addLog('scroll', `⏭️ @${locUsername} already processed — returning to location grid`);
          await sendActionToTab('returnToLocationGrid');
          await waitMs(humanDelay(800));
          continue;
        }

        try {
          sessionState.stats.scrolls++;

          // Check profile accessibility — definitive rejections only.
          const accessCheck = await sendActionToTab('isProfileAccessible');
          if (shouldSkipForAccess(accessCheck)) {
            addLog('dm_skipped', `⏭️ ${describeAccessSkip(accessCheck, locUsername)}`);
            await rememberProcessedAccount(locUsername);
            await sendActionToTab('returnToLocationGrid');
            await waitMs(humanDelay(800));
            continue;
          }

          // Demographics filter — definitive rejection.
          const demoPassLoc = await checkDemographicsFilter(locUsername);
          if (!demoPassLoc) {
            await rememberProcessedAccount(locUsername);
            await sendActionToTab('returnToLocationGrid');
            await waitMs(humanDelay(800));
            continue;
          }

          // Browse profile humanly
          const isHumanModeLoc = config.dmMode === 'human';
          if (!shouldStop() && (isHumanModeLoc || Math.random() < 0.6)) {
            addLog('scroll', '👀 Browsing profile...');
            await sendActionToTab('browseProfile');
            await waitMs(humanDelay(isHumanModeLoc ? 1500 : 800));
          }

          if (shouldStop()) break;

          // Like 1-3 posts
          if (!shouldStop() && sessionState.stats.likesSent < config.dailyMaxLikes) {
            try {
              const result = await sendProfileMultiLike();
              if (result.success && result.likesCount > 0) {
                sessionState.stats.likesSent += result.likesCount;
                _iterationDidLike = true;
                addLog('like', `❤️ Liked ${result.likesCount} post(s)`);
              }
            } catch (e) {
              const liked = await sendActionToTab('profileLike');
              if (liked) { sessionState.stats.likesSent++; _iterationDidLike = true; addLog('like', '❤️ Liked a post'); }
            }
            await waitMs(humanDelay(1000));
          }

          // Follow (~15% chance)
          if (!shouldStop() && config.followEnabled && sessionState.stats.followsSent < config.dailyMaxFollows && config.dailyMaxFollows > 0 && Math.random() < 0.15) {
            const followed = await sendActionToTab('profileFollow');
            if (followed) {
              sessionState.stats.followsSent++;
              addLog('follow', '➕ Followed account');
            }
            await waitMs(humanDelay(800));
          }

          // Guard: escape /reels/ if needed
          {
            const tab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
            if (tab?.url?.includes('/reels/')) {
              addLog('scroll', '⚠️ Escaped /reels/ — recovering profile before DM');
              await sendActionToTab('navigateProfile', null, [locUsername]);
              await waitMs(humanDelay(1800));
            }
          }

          // Send DM
          if (!shouldStop() && dmCapAllowsAnother(config)) {
            const msg = pickMessage();
            if (msg) {
              addLog('dm', `💬 Attempting DM to @${locUsername}...`);
              // Navigate back to profile in case multiLike left us on /p/ page
              const navBackOk = await sendActionToTab('navigateProfile', null, [locUsername]);
              if (!navBackOk) {
                const fallbackTab = await getOrCreatePlatformTab(sessionState.platform, { createIfMissing: false });
                if (fallbackTab) {
                  await navigateTabAndWait(fallbackTab.id, `https://www.instagram.com/${locUsername}/`);
                }
              }
              await waitMs(humanDelay(1500));
              // Honor between-DM cooldown + burst-pause settings before sending.
              // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
              // whose warm-up like never landed.
              if (!(await warmedUpForDM())) {
                // Move on without marking the account processed. A failed warm-up
                // like is transient (slow load, no visible posts, a hiccup), not a
                // reason to burn the lead forever — the same rule the access and
                // filter skips follow. Re-picking within this session is already
                // prevented: hashtag/location posts go into visitedPostsThisSession
                // when opened, the followers modal marks traversal-visited, and the
                // commenter loop tracks processedCommenters.
                continue;
              }
              const okToSend = await enforceDmPacingBeforeSend(addLog);
              if (!okToSend) break;
              const dmSent = await sendInstagramDirectComposeDM(msg, locUsername);

              if (dmSent) {
                sessionState.stats.dmsSent++;
                recordDmSentForPacing();
                await addToBgDMHistory(locUsername);
                await rememberProcessedAccount(locUsername);
                addLog('dm', `📨 DM sent to @${locUsername}!`);
                try { await postCommentAfterDM(locUsername); } catch {}
              } else {
                addLog('dm_skipped', `⏭️ DM could not be sent to @${locUsername} — will retry next session`);
                noteTargetFailed(locUsername, 'DM could not be sent');
              }
              await waitMs(humanDelay(1200));
            } else {
              addLog('dm_skipped', '⚠️ No DM script configured');
            }
          }

          // Mark visited in content script
          await sendActionToTab('markVisited', null, [locUsername]);

          // Step 3: Navigate directly to location page.
          // We do NOT use returnToLocationGrid (history.back()) here because
          // performProfileMultiLike clicks post thumbnails which pushes each
          // /p/xxx/ URL into browser history. history.back() would traverse
          // back through every one of those post pages one-by-one, making the
          // bot appear to re-engage with the just-DMed account's posts.
          // Direct navigation skips all that and lands cleanly on the location grid.
          addLog('scroll', `↩️ Returning to location grid...`);
          await sendActionToTab('navigateLocation', null, [locationUrl]);
          await waitMs(humanDelay(1500));

          // Pause between accounts — honor user's Action Delay slider.
          const delay2 = getRandomDelay(config);
          await waitMs(delay2);
          elapsed = activeElapsedSec();
          sessionState.stats.elapsedTime = Math.round(elapsed);
          saveState();
        } catch (e) {
          console.error(`[Futnor Background] Error processing location user @${locUsername}:`, e);
          addLog('dm_skipped', `⚠️ Error while processing @${locUsername} — moving on`);
          try { await sendActionToTab('markVisited', null, [locUsername]); } catch {}
          // Navigate directly to location grid on error (avoid history.back() traversal)
          try { await sendActionToTab('navigateLocation', null, [locationUrl]); } catch {}
          await waitMs(humanDelay(800));
        }

        performed = true;

      } else if (hasTargeting) {
        // ═══ OTHER TARGETING TYPES (custom, likers) ═══
        let onTargetPage = false;
        
        if (targetType === 'likers' && targeting.targetPostLink?.trim()) {
          onTargetPage = await sendActionToTab('navigatePost', null, [targeting.targetPostLink, 'likers']);
          if (onTargetPage) addLog('scroll', `👀 Browsing likers of post`);
        } else if (targetType === 'custom' && targeting.customUsernames?.length > 0) {
          const normalizedCustomUsers = targeting.customUsernames
            .map((entry) => normalizeInstagramUsername(entry))
            .filter(Boolean);

          let selectedCustomUser = null;
          for (let offset = 0; offset < normalizedCustomUsers.length; offset++) {
            const idx = (customTargetCursor + offset) % normalizedCustomUsers.length;
            const candidate = normalizedCustomUsers[idx];
            if (isAccountAlreadyHandled(candidate)) continue;
            selectedCustomUser = candidate;
            customTargetCursor = idx + 1;
            break;
          }

          if (!selectedCustomUser) {
            addLog('session_end', '✅ All custom usernames already processed — session complete');
            sessionState.isRunning = false;
            break;
          }

          onTargetPage = await sendActionToTab('navigateProfile', null, [selectedCustomUser]);
          if (onTargetPage) {
            await waitMs(humanDelay(1000));
            // Check if the profile actually exists / is accessible
            const accessCheck = await sendActionToTab('isProfileAccessible');
            if (shouldSkipForAccess(accessCheck)) {
              addLog('dm_skipped', `⏭️ ${describeAccessSkip(accessCheck, selectedCustomUser)}`);
              await rememberProcessedAccount(selectedCustomUser);
              await waitMs(humanDelay(500));
              continue;
            }
            addLog('scroll', `🎯 Visiting @${selectedCustomUser}'s profile`);
          }
        }
        
        if (!onTargetPage) {
          sessionState.stats.scrolls++;
          await sendActionToTab('scroll');
          continue;
        }
        
        await waitMs(humanDelay(1000));
        sessionState.stats.scrolls++;
        
        // For non-custom: pick account from list
        if (targetType !== 'custom') {
          await sendActionToTab('scroll');
          await waitMs(humanDelay(800));
          
          const visited = await sendActionToTab('engageSimilar');
          if (!visited) {
            addLog('dm_skipped', '⚠️ No accounts found, scrolling more...');
            await sendActionToTab('scroll');
            continue;
          }
          addLog('scroll', '🎯 Visiting targeted account profile');
          await waitMs(humanDelay(1200));
        }
        
        const currentTargetUsername = normalizeInstagramUsername(await getCurrentInstagramProfileUsername());
        if (currentTargetUsername && isAccountAlreadyHandled(currentTargetUsername)) {
          addLog('scroll', `⏭️ @${currentTargetUsername} already processed — skipping`);
          await waitMs(humanDelay(800));
          continue;
        }

        if (currentTargetUsername) {
          await rememberProcessedAccount(currentTargetUsername);
        }

        // Account-access check — honors "Public Accounts Only" / "Include
        // Private Accounts" toggles. Without this the engageSimilar branch
        // (likers/engagement) was DM'ing private accounts even when the
        // user toggled Public Accounts Only ON.
        {
          const accessCheck = await sendActionToTab('isProfileAccessible');
          if (shouldSkipForAccess(accessCheck)) {
            addLog('dm_skipped', `⏭️ ${describeAccessSkip(accessCheck, currentTargetUsername)}`);
            await waitMs(humanDelay(500));
            continue;
          }
        }

        // Demographics filter check
        const demoPass3 = await checkDemographicsFilter(currentTargetUsername);
        if (!demoPass3) {
          await waitMs(humanDelay(800));
          continue;
        }

        // Browse the profile humanly before engaging — read bio, scroll the
        // grid, maybe peek at a story. Critical for spam-detection avoidance:
        // Instagram profiles spam-flag accounts that fire DM/like the moment
        // they land on a profile. Always do at least a short browse, and a
        // longer one in human mode.
        const isHumanModeTgt = config.dmMode === 'human';
        if (!shouldStop()) {
          addLog('scroll', '👀 Browsing profile...');
          try { await sendActionToTab('browseProfile'); } catch {}
          await waitMs(humanDelay(isHumanModeTgt ? 1500 : 800));
        }

        // Like 1-3 posts
        if (!shouldStop() && sessionState.stats.likesSent < config.dailyMaxLikes) {
          try {
            const result = await sendProfileMultiLike();
            if (result.success && result.likesCount > 0) {
              sessionState.stats.likesSent += result.likesCount;
              _iterationDidLike = true;
              addLog('like', `❤️ Liked ${result.likesCount} post(s)`);
            }
          } catch (e) {
            const liked = await sendActionToTab('profileLike');
            if (liked) { sessionState.stats.likesSent++; _iterationDidLike = true; addLog('like', '❤️ Liked a post'); }
          }
          await waitMs(humanDelay(1000));
        }

        // Follow
        if (!shouldStop() && config.followEnabled && sessionState.stats.followsSent < config.dailyMaxFollows && config.dailyMaxFollows > 0 && Math.random() < 0.15) {
          const followed = await sendActionToTab('profileFollow');
          if (followed) {
            sessionState.stats.followsSent++;
            addLog('follow', '➕ Followed account');
          }
          await waitMs(humanDelay(800));
        }
        
        // DM
        // Track whether the DM actually sent. We use this to decide the
        // post-iteration delay: a successful send needs the FULL action
        // delay (45–180s default) so back-to-back DMs don't look robotic,
        // but a skip / failure should advance to the next target almost
        // immediately — otherwise the bot looks frozen while the user
        // waits 1–3 minutes for nothing to happen.
        if (!shouldStop() && dmCapAllowsAnother(config)) {
          const msg = pickMessage();
          if (msg) {
            const dmTargetUsername = currentTargetUsername || normalizeInstagramUsername(await getCurrentInstagramProfileUsername());
            // Navigate back to profile in case multiLike left us on /p/ page
            if (dmTargetUsername) {
              await sendActionToTab('navigateProfile', null, [dmTargetUsername]);
              await waitMs(humanDelay(800));
            }
            // v2.4.150: likers / custom-username targeting also bypassed the
            // pacing gate entirely — see the note in the followers branch.
            // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
            // whose warm-up like never landed.
            if (!(await warmedUpForDM())) {
              // Move on without marking the account processed. A failed warm-up
              // like is transient (slow load, no visible posts, a hiccup), not a
              // reason to burn the lead forever — the same rule the access and
              // filter skips follow. Re-picking within this session is already
              // prevented: hashtag/location posts go into visitedPostsThisSession
              // when opened, the followers modal marks traversal-visited, and the
              // commenter loop tracks processedCommenters.
              continue;
            }
            const okToSend = await enforceDmPacingBeforeSend(addLog);
            if (!okToSend) break;
            const dmSent = dmTargetUsername
              ? await sendInstagramDirectComposeDM(msg, dmTargetUsername)
              : false;
            if (dmSent) {
              sessionState.stats.dmsSent++;
              recordDmSentForPacing();
              _iterationDidSendDM = true;
              if (dmTargetUsername) { try { await postCommentAfterDM(dmTargetUsername); } catch {} }
              addLog('dm', `📨 DM sent to @${dmTargetUsername}`);
            } else {
              addLog('dm_skipped', `⏭️ DM could not be sent to @${dmTargetUsername} — moving on`);
              noteTargetFailed(dmTargetUsername, 'DM could not be sent');
            }
            await waitMs(humanDelay(1200));
          }
        }

        // Just log progression. The outer loop's natural navigatePost call
        // at the start of the NEXT iteration handles returning to the post —
        // calling it explicitly here was wedging the background flow because
        // navigatePost triggers window.location.href = postUrl which, when
        // the bot is coming off /direct/t/<id>/ (just-sent DM), causes a HARD
        // page reload. The content script dies mid-function, the in-flight
        // chrome.tabs.sendMessage response never arrives, and the
        // `await sendActionToTab(...)` hangs forever ("Waiting for action…"
        // appears in the banner).
        if (targetType === 'likers' && targeting.targetPostLink?.trim()) {
          addLog('scroll', '↩️ Returning to likers list for next account...');
        }

        await waitMs(getRandom(1500, 3500));
        performed = true;

      } else {
        // Non-targeted session: use original random action flow
        const action = pickNextAction(config, platform);
        
        switch (action) {
          case 'scroll': {
            performed = await sendActionToTab('scroll');
            if (performed) {
              sessionState.stats.scrolls++;
              addLog('scroll', 'Scrolled / viewed content');
            }
            break;
          }
          case 'likeFollow': {
            const followAllowed = config.followEnabled && config.dailyMaxFollows > 0;
            if (sessionState.stats.likesSent >= config.dailyMaxLikes &&
                (!followAllowed || sessionState.stats.followsSent >= config.dailyMaxFollows)) break;

            if (Math.random() < 0.5 && sessionState.stats.likesSent < config.dailyMaxLikes) {
              performed = await sendActionToTab('like');
              if (performed) {
                sessionState.stats.likesSent++;
                addLog('like', 'Liked a post');
              }
            } else if (followAllowed && sessionState.stats.followsSent < config.dailyMaxFollows) {
              performed = await sendActionToTab('follow');
              if (performed) {
                sessionState.stats.followsSent++;
                addLog('follow', 'Followed a user');
              }
            }
            break;
          }
          case 'comment':
            if (dmCapReached(config)) break;
            
            // Retry comment action to handle multi-step flows
            let commentSuccess = false;
            for (let attempt = 1; attempt <= 3 && !commentSuccess; attempt++) {
              performed = await sendActionToTab('comment', pickMessage());
              if (performed) {
                commentSuccess = true;
                sessionState.stats.dmsSent++;
                addLog('dm', '💬 Comment posted on TikTok');
              } else if (attempt < 3) {
                await waitMs(2000);
              }
            }
            
            if (!commentSuccess) {
              addLog('dm_skipped', '⚠️ Comment failed after 3 attempts');
            }
            break;
          case 'dm': {
            if (dmCapReached(config)) break;
            const msg = pickMessage();
            if (!msg) {
              addLog('dm_skipped', '⚠️ No DM script configured');
              break;
            }
            
            // v2.4.150: the untargeted "random action" flow sent with no
            // pacing gate at all. Same rail as every other branch now.
            // v2.4.150: honor config.requireLikeBeforeDM — never cold-DM a target
            // whose warm-up like never landed.
            if (!(await warmedUpForDM())) break;
            if (!(await enforceDmPacingBeforeSend(addLog))) break;

            if (platform === 'instagram') {
              const dmTargetUsername = await waitForInstagramProfileUsername({ attempts: 6, delayMs: 350 });
              performed = dmTargetUsername
                ? await sendInstagramDirectComposeDM(msg, dmTargetUsername)
                : false;
            } else {
              performed = await sendActionToTab('dm', msg);
            }
            if (performed) {
              sessionState.stats.dmsSent++;
              recordDmSentForPacing();
              _iterationDidSendDM = true;
              addLog('dm', '📨 DM sent');
            } else {
              addLog('dm_skipped', '⚠️ DM skipped or failed');
            }
            break;
          }
        }
      }
    }

    // ── ORGANIC FILLER BETWEEN DMs (v2.4.154) ────────────────────────────────
    // Until now a targeting session was 100% outreach: profile, like, DM, next
    // profile, like, DM — for the whole run, with nothing in between but a
    // timer. Every action pointed at a stranger. That is the shape Instagram
    // looks for, and the account-health model already penalises it ("DM ratio
    // critical — this account exists primarily to message strangers").
    //
    // The pacing settings only ever changed the GAP between those actions; they
    // never changed the MIX. A real person sending a few outreach messages also
    // scrolls their feed, watches a reel, and glances at notifications.
    //
    // The warm-up engine already had all of those behaviours built and proven —
    // they were simply never reachable outside a warm-up. This runs one of them
    // after roughly half of successful DMs. It is genuine session activity, so
    // it is NOT booked as cooldown, and it happens between iterations where
    // every branch re-navigates to its grid anyway, so it cannot lose our place.
    const dmsSentThisIteration = sessionState.stats.dmsSent > _dmsAtIterationStart;
    if (dmsSentThisIteration && Math.random() < 0.5) {
      await performOrganicFillerAction(addLog);
    }

    // Pick the inter-iteration delay based on whether a DM actually landed.
    //   • DM sent  → full configured action delay (humanlike pacing,
    //                avoids back-to-back-DM spam patterns)
    //   • DM skip  → 3–6s only so the bot moves to the next target
    //                immediately instead of appearing frozen on a profile
    //                it just skipped (e.g. when the user has Allow
    //                Existing Chats OFF and several targets in a row had
    //                prior conversations).
    const delay = _iterationDidSendDM ? getRandomDelay(config) : getRandom(3000, 6000);
    await waitMs(delay);
    elapsed = activeElapsedSec();
    sessionState.stats.elapsedTime = Math.round(elapsed);
    saveState();

  }

  chrome.alarms.clear(tickAlarm);
  sessionState.isRunning = false;
  sessionState.reconnecting = false;
  sessionLoopActive = false;
  sessionLoopPromise = null;
  addLog('session_end', `[${platformLabel}]${modeLabel} Session complete. DMs=${sessionState.stats.dmsSent}, Likes=${sessionState.stats.likesSent}, Follows=${sessionState.stats.followsSent}${isAITargeting ? ', Accounts=' + accountsEngaged : ''}`);
  saveState();
  // Record end time so the inter-session cooldown gate enforces minSessionGapMinutes.
  recordSessionEnd();

  // Hide banner when session ends
  await hideBannerOnPlatformTab(platform);

  // Scan inbox for replies received during this session and mark them as
  // responded in dm_tracking. This is the only path that updates the
  // response-rate dashboard for users who don't run the Sales Agent.
  // Fire-and-forget so a slow scan doesn't delay the session-complete log.
  if (platform === 'instagram') {
    scanInboxForResponses({ navigate: true }).catch((e) => {
      console.warn('[Futnor Background] Post-session inbox scan failed:', e?.message || e);
    });
  }
}

// ─── Banner helpers ───
async function showBannerOnPlatformTab(platform, mode) {
  try {
    const tab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'SHOW_BOT_BANNER', mode: mode || 'bot' }).catch(() => {});
    }
  } catch (e) {
    console.warn('[Futnor Background] showBannerOnPlatformTab failed:', e?.message || e);
  }
}

async function hideBannerOnPlatformTab(platform) {
  try {
    const tab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'HIDE_BOT_BANNER' }).catch(() => {});
    }
  } catch (e) {
    console.warn('[Futnor Background] hideBannerOnPlatformTab failed:', e?.message || e);
  }
}

// ─── Warm-up action sender (bypasses bot session checks) ───
function getWarmupActionTimeoutMs(action) {
  // Timeouts sized ~2x the realistic max execution time of each handler.
  switch (action) {
    case 'warmupFeed':
      return 120000;
    case 'warmupExplore':
      return 120000;
    case 'warmupReels':
      return 180000;
    case 'warmupStory':
      return 150000;
    case 'warmupReadComments':
      return 60000;
    case 'warmupLike':
      return 30000;
    case 'warmupComment':
      return 45000;
    case 'warmupCheckNotifications':
      return 60000;
    case 'warmupCheckInbox':
      return 60000;
    case 'warmupBrowseSearch':
      return 90000;
    default:
      return 90000;
  }
}

async function sendWarmupActionToTab(action, platform, nicheKeywords = []) {
  if (!warmupState.isRunning) return { success: false, aborted: true };

  const payload = { type: 'PERFORM_ACTION', action, nicheKeywords };
  const timeoutMs = getWarmupActionTimeoutMs(action);

  for (let attempt = 1; attempt <= 2; attempt++) {
    // v2.4.156: recover a closed/navigated-away tab instead of failing.
    // This used to pass createIfMissing:false, so if the Instagram tab was
    // closed — or was never found because its content script had been unloaded
    // by an extension reload — every warm-up action returned missingTab and the
    // run died silently. The user saw "warm-up isn't working" with nothing in
    // the log to say why, because missingTab produced no user-facing message at
    // all until five consecutive failures had stacked up.
    const targetTab = await getOrCreatePlatformTab(platform, { createIfMissing: attempt === 1 });
    if (!targetTab) {
      console.error('[Futnor Warmup] No platform tab found for warmup action:', action);
      return { success: false, missingTab: true };
    }

    // Make sure the content script is actually alive before the first attempt.
    // Reloading the extension unloads content scripts from already-open tabs;
    // until that tab is reloaded nothing responds, which is by far the most
    // common reason a warm-up "does nothing" right after an update.
    if (attempt === 1) {
      try { await ensureContentScript(targetTab.id, platform); } catch {}
    }

    let timeoutId = null;

    try {
      console.log(`[Futnor Warmup] Sending action (attempt ${attempt}/2):`, action);
      const response = await new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Warm-up action timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        chrome.tabs.sendMessage(targetTab.id, payload)
          .then(resolve)
          .catch(reject);
      });

      console.log('[Futnor Warmup] Response:', response);

      if (response && typeof response === 'object' && response.needsTabNavigation) {
        console.log('[Futnor Warmup] Tab navigation requested:', response.url);
        await navigateTabAndWait(targetTab.id, response.url);
        return { success: true };
      }

      if (response && typeof response === 'object') {
        return {
          success: !!response.success,
          label: response.label,
          stalled: !!response.stalled,
        };
      }

      return { success: !!response };
    } catch (e) {
      const errorMessage = e?.message || String(e);
      const timedOut = /timed out/i.test(errorMessage);
      console.error(`[Futnor Warmup] Attempt ${attempt} failed:`, errorMessage);

      if (timedOut) {
        return { success: false, timedOut: true, error: errorMessage };
      }

      if (attempt < 2) {
        await ensureContentScript(targetTab.id, platform);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  return { success: false };
}

// ─── Warm-up engine ───
let warmupState = { isRunning: false, stats: {}, logs: [] };

// Timestamped ledger of completed warm-up sessions (v2.4.150). Replaces the
// dashboard's never-expiring `futnor_warmup_count_7d_<account>` counter as the
// source of truth for "is this account warmed up?".
const WARMUP_SESSIONS_KEY = 'futnor_warmup_sessions';
const WARMUP_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Completed warm-up sessions for the active account within the last 7 days.
async function countRecentWarmups(days = 7) {
  try {
    const stored = await chrome.storage.local.get([WARMUP_SESSIONS_KEY]);
    const ledger = stored[WARMUP_SESSIONS_KEY];
    if (!Array.isArray(ledger)) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const account = normalizeAccountUsername(activeAccountUsername);
    return ledger.filter((entry) =>
      entry
      && typeof entry.at === 'number'
      && entry.at >= cutoff
      // Entries recorded before an account was detected carry 'unknown' and
      // count for whoever is logged in — losing them would under-report.
      && (!account || !entry.account || entry.account === 'unknown' || entry.account === account)
    ).length;
  } catch {
    return 0;
  }
}

// Volume ceiling for THIS session, derived from how much the account has
// actually been warmed up recently. Deliberately conservative at the bottom:
// a cold account sending 30 cold DMs on day one is the single most reliable
// way to get restricted, and that is exactly what the engine used to allow.
async function getWarmupRampCaps() {
  const warmups = await countRecentWarmups(7);
  if (warmups >= 6) return { label: `${warmups} warm-ups/7d`, dailyMaxDMs: 30, hourlyMaxDMs: 5 };
  if (warmups >= 3) return { label: `${warmups} warm-ups/7d`, dailyMaxDMs: 20, hourlyMaxDMs: 4 };
  if (warmups >= 1) return { label: `${warmups} warm-up${warmups > 1 ? 's' : ''}/7d`, dailyMaxDMs: 10, hourlyMaxDMs: 3 };
  return { label: 'no warm-up in 7 days', dailyMaxDMs: 5, hourlyMaxDMs: 2 };
}

// Helper: chunked sleep that keeps service worker alive and checks for stop
async function warmupChunkedSleep(ms) {
  const chunkMs = 400;
  let remaining = ms;
  while (remaining > 0 && warmupState.isRunning) {
    await waitMs(Math.min(chunkMs, remaining));
    remaining -= chunkMs;
  }
}

// Persist warmup state to chrome.storage.session for service worker restart recovery
async function persistWarmupSession(data) {
  try { await chrome.storage.session.set({ _warmupPersist: data }); } catch (e) {}
}
async function clearWarmupPersistence() {
  try { await chrome.storage.session.remove('_warmupPersist'); } catch (e) {}
}

// ─── Warm-up action mix ────────────────────────────────────────────────────
// Phase-aware ramp-up so the account looks like a human waking up to scroll,
// then engaging more, not a bot at full intensity from action #1.
//   PASSIVE (0–25%): only view-only — scroll, reels, read comments, notifs.
//   ENGAGED (25–70%): adds likes, story views, inbox check, niche search.
//   ACTIVE  (70–100%): full mix; comments unlock when enableComments is on.
// Reels weight is highest — they're Instagram's dominant format and absent
// reels-watching is itself a "this account isn't a real user" signal.
const WARMUP_ACTIONS = [
  // ── view-only / passive (always available) ──
  { action: 'warmup_scroll_feed',     weight: 22, label: '📜 Scrolling feed',          phases: ['passive', 'engaged', 'active'] },
  { action: 'warmup_reels',            weight: 26, label: '🎬 Watching reels',          phases: ['passive', 'engaged', 'active'] },
  { action: 'warmup_scroll_explore',   weight: 16, label: '🔍 Browsing explore',        phases: ['passive', 'engaged', 'active'] },
  { action: 'warmup_read_comments',    weight: 8,  label: '💬 Reading comments',        phases: ['passive', 'engaged', 'active'] },
  { action: 'warmup_check_notifs',     weight: 6,  label: '🔔 Checking notifications',  phases: ['passive', 'engaged', 'active'] },
  { action: 'warmup_pause',            weight: 6,  label: '⏸️ Taking a break...',       phases: ['passive', 'engaged', 'active'] },
  // ── light engagement (engaged + active phases) ──
  { action: 'warmup_view_story',       weight: 9,  label: '👁️ Viewing stories',        phases: ['engaged', 'active'] },
  { action: 'warmup_like_post',        weight: 9,  label: '❤️ Liked a post',            phases: ['engaged', 'active'] },
  { action: 'warmup_check_inbox',      weight: 6,  label: '📥 Checking DM inbox',       phases: ['engaged', 'active'] },
  { action: 'warmup_browse_search',    weight: 7,  label: '🔍 Searching niche topic',   phases: ['engaged', 'active'] },
  // ── highest-engagement (active phase only, comments dynamic) ──
  { action: 'warmup_comment',          weight: 0,  label: '✍️ Posted a comment',        phases: ['active'] }, // dynamic
];

let warmupLastAction = null;

function getWarmupPhase(elapsedMs, totalMs) {
  if (totalMs <= 0) return 'engaged';
  const ratio = elapsedMs / totalMs;
  if (ratio < 0.25) return 'passive';
  if (ratio < 0.70) return 'engaged';
  return 'active';
}

function pickWarmupAction(enableComments, phase) {
  const pool = WARMUP_ACTIONS
    .map(a => ({
      ...a,
      weight: a.action === 'warmup_comment'
        ? (enableComments && phase === 'active' ? 8 : 0)
        : a.weight,
    }))
    .filter(a => a.weight > 0
      && a.phases.includes(phase)
      && a.action !== warmupLastAction);

  if (pool.length === 0) {
    // v2.4.150: remember the fallback too. Both early-return paths used to
    // leave `warmupLastAction` stale, so the "don't repeat the last action"
    // filter compared against an action from two or three picks ago and let
    // the same action fire back-to-back — the opposite of the varied rhythm
    // this table exists to produce.
    warmupLastAction = WARMUP_ACTIONS[0].action;
    return WARMUP_ACTIONS[0];
  }

  const total = pool.reduce((s, a) => s + a.weight, 0);
  let rand = Math.random() * total;
  for (const item of pool) {
    rand -= item.weight;
    if (rand <= 0) {
      warmupLastAction = item.action;
      return item;
    }
  }
  warmupLastAction = pool[0].action;
  return pool[0];
}

// Realistic delay distribution:
//   ~70% short (2–10s) — scrolling rhythm
//   ~20% medium (10–30s) — reading / considering
//   ~8% long (30–90s) — distraction / multitasking
//   ~2% very long (90–180s) — phone put down, then picked up
function getWarmupDelay() {
  const r = Math.random();
  if (r < 0.70) return Math.max(1800, 2000 + Math.random() * 8000);
  if (r < 0.90) return 10000 + Math.random() * 20000;
  if (r < 0.98) return 30000 + Math.random() * 60000;
  return 90000 + Math.random() * 90000;
}

async function runWarmup(sessionMinutes, platform, enableComments, overrideStartTime) {
  const isResume = !!overrideStartTime;
  warmupState.isRunning = true;
  warmupState.stats = {
    storiesViewed: 0, postsLiked: 0,
    feedScrolls: 0, exploreScrolls: 0, commentsRead: 0,
    commentsPosted: 0, totalActions: 0, elapsedTime: 0,
    sessionTime: sessionMinutes * 60,
  };
  warmupState.logs = [];
  warmupLastAction = null;

  const addWarmupLog = (msg) => {
    warmupState.logs.unshift({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      message: msg,
    });
    if (warmupState.logs.length > 80) warmupState.logs.length = 80;
  };

  if (isResume) {
    const elapsedMin = Math.round((Date.now() - overrideStartTime) / 60000);
    addWarmupLog(`Warm-up resumed — ${sessionMinutes - elapsedMin} min remaining`);
  } else {
    addWarmupLog(`Warm-up started — ${sessionMinutes} min session`);
  }

  // Ensure we're on the home feed to start.
  // v2.4.156: this used to swallow every problem into a console line the user
  // never sees, so a warm-up that could not reach Instagram simply sat there
  // doing nothing. Each failure now names itself in the warm-up log.
  const platformName = platform === 'tiktok' ? 'TikTok' : 'Instagram';
  try {
    const tab = await getOrCreatePlatformTab(platform, { createIfMissing: true });
    if (!tab) {
      addWarmupLog(`❌ Could not open ${platformName} — allow the extension to open a tab, then start again`);
      warmupState.isRunning = false;
      await clearWarmupPersistence();
      return;
    }

    const homeUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 'https://www.tiktok.com/';
    if (!tab.url || !tab.url.endsWith('.com/')) {
      await navigateTabAndWait(tab.id, homeUrl);
    }

    const ready = await ensureContentScript(tab.id, platform);
    if (!ready) {
      // Almost always: the extension was just reloaded, which unloads the
      // content script from tabs that were already open.
      addWarmupLog(`⚠️ ${platformName} tab is not responding — refreshing it...`);
      try {
        await navigateTabAndWait(tab.id, homeUrl);
        await warmupChunkedSleep(2000);
      } catch {}
      const readyAfterReload = await ensureContentScript(tab.id, platform);
      if (!readyAfterReload) {
        addWarmupLog(`❌ Can't reach ${platformName}. Refresh the ${platformName} tab (F5), make sure you're logged in, then start warm-up again.`);
        warmupState.isRunning = false;
        await clearWarmupPersistence();
        await hideBannerOnPlatformTab(platform);
        return;
      }
      addWarmupLog(`✅ ${platformName} tab recovered`);
    }
  } catch (e) {
    console.log('[Futnor Warmup] Could not navigate to home:', e.message);
    addWarmupLog(`❌ Warm-up could not start: ${e?.message || 'unknown error'}`);
    warmupState.isRunning = false;
    await clearWarmupPersistence();
    return;
  }

  // Use wall-clock time for accurate elapsed tracking (survives service worker restart)
  const startTime = overrideStartTime || Date.now();
  const totalMs = sessionMinutes * 60 * 1000;

  // Keep-alive alarm — 12s interval to aggressively prevent MV3 service worker suspension
  chrome.alarms.create('warmup-keepalive', { periodInMinutes: 0.2 });

  // Persist warmup state so we can auto-resume if the service worker restarts
  await persistWarmupSession({ isRunning: true, startTime, sessionMinutes, platform, enableComments });

  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  // Let Instagram finish booting before overlay injection or any DOM-heavy warm-up actions
  await warmupChunkedSleep(2500);
  await showBannerOnPlatformTab(platform, 'warmup');
  setTimeout(() => { if (warmupState.isRunning) showBannerOnPlatformTab(platform, 'warmup'); }, 2000);
  // Seed initial stats so the overlay populates immediately instead of
  // showing zeros / "Waiting for actions…" until the first action completes.
  try {
    const seedTab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
    if (seedTab) {
      chrome.tabs.sendMessage(seedTab.id, {
        type: 'UPDATE_BANNER',
        mode: 'warmup',
        stats: warmupState.stats,
        latestLog: isResume ? '🔥 Warm-up resumed' : '🔥 Warm-up started — preparing first action…',
      }).catch(() => {});
    }
  } catch {}
  await warmupChunkedSleep(1500);

  // Niche keywords drive search/explore — building algorithmic profile
  // that matches the upcoming outreach niche.
  const nicheKeywords = (() => {
    try {
      const tags = sessionState?.targeting?.hashtags;
      if (!tags) return [];
      return String(tags)
        .split(/[\s,#]+/)
        .map(s => s.replace(/[^a-z0-9_]/gi, '').trim())
        .filter(s => s.length > 1)
        .slice(0, 8);
    } catch { return []; }
  })();
  if (nicheKeywords.length > 0) {
    addWarmupLog(`🎯 Niche keywords loaded: ${nicheKeywords.join(', ')}`);
  }

  while (warmupState.isRunning) {
    // Wall-clock elapsed check
    const elapsed = Date.now() - startTime;
    warmupState.stats.elapsedTime = Math.round(elapsed / 1000);
    if (elapsed >= totalMs) break;

    const phase = getWarmupPhase(elapsed, totalMs);
    let picked = pickWarmupAction(enableComments, phase);
    // First action should always be feed scroll (gentle entry)
    if (warmupState.stats.totalActions === 0 && picked.action !== 'warmup_scroll_feed') {
      picked = WARMUP_ACTIONS.find(item => item.action === 'warmup_scroll_feed') || picked;
      // Keep the no-repeat filter honest after the override.
      warmupLastAction = picked.action;
    }

    // Map warmup actions to content script actions
    let extensionAction = 'scroll';
    switch (picked.action) {
      case 'warmup_scroll_feed':    extensionAction = 'warmupFeed'; break;
      case 'warmup_scroll_explore': extensionAction = 'warmupExplore'; break;
      case 'warmup_reels':          extensionAction = 'warmupReels'; break;
      case 'warmup_view_story':     extensionAction = 'warmupStory'; break;
      case 'warmup_like_post':      extensionAction = 'warmupLike'; break;
      case 'warmup_read_comments':  extensionAction = 'warmupReadComments'; break;
      case 'warmup_comment':        extensionAction = 'warmupComment'; break;
      case 'warmup_check_notifs':   extensionAction = 'warmupCheckNotifications'; break;
      case 'warmup_check_inbox':    extensionAction = 'warmupCheckInbox'; break;
      case 'warmup_browse_search':  extensionAction = 'warmupBrowseSearch'; break;
      case 'warmup_pause':          extensionAction = null; break;
    }

    let actionSuccess = false;
    let actionTimedOut = false;
    let actionStalled = false;
    let actionLabel = picked.label;

    if (extensionAction) {
      const result = await sendWarmupActionToTab(extensionAction, platform, nicheKeywords);
      console.log(`[Futnor Warmup] Action "${extensionAction}" result:`, result);
      if (result && typeof result === 'object') {
        actionSuccess = !!result.success;
        actionTimedOut = !!result.timedOut;
        actionStalled = !!result.stalled;
        if (result.label) actionLabel = result.label;

        // v2.4.156: say what went wrong the FIRST time, not after five silent
        // retries. A warm-up that cannot find its tab used to look identical to
        // one that was simply thinking.
        if (!actionSuccess && result.missingTab) {
          addWarmupLog(`❌ No ${platform === 'tiktok' ? 'TikTok' : 'Instagram'} tab open — open one and keep it open while warming up`);
        } else if (!actionSuccess && result.timedOut) {
          addWarmupLog(`⚠️ ${picked.label} took too long — retrying`);
        }
      } else {
        actionSuccess = !!result;
      }
    } else {
      // Pause — just wait
      const pauseMs = getRandom(2000, 5000);
      await warmupChunkedSleep(pauseMs);
      actionSuccess = true;
      actionLabel = `⏸️ Paused for ${Math.round(pauseMs / 1000)}s`;
    }

    // Track consecutive failures for recovery — increment by 1 always, never jump to max
    if (!actionSuccess && extensionAction) {
      consecutiveFailures++;
      console.log(`[Futnor Warmup] Consecutive failures: ${consecutiveFailures}`);

      if (actionTimedOut || actionStalled) {
        addWarmupLog(`⚠️ ${actionLabel} — recovering tab...`);
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (!actionTimedOut && !actionStalled) addWarmupLog('⚠️ Tab unresponsive — recovering...');
        // Recovery: reload the tab and re-inject content script
        try {
          const tab = await getOrCreatePlatformTab(platform, { createIfMissing: true });
          if (tab) {
            const homeUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 'https://www.tiktok.com/';
            await navigateTabAndWait(tab.id, homeUrl);
            await ensureContentScript(tab.id, platform);
            await warmupChunkedSleep(5000); // Longer cooldown after recovery
            await showBannerOnPlatformTab(platform, 'warmup');
            consecutiveFailures = 0;
            addWarmupLog('✅ Tab recovered — resuming warm-up');
          }
        } catch (e) {
          console.error('[Futnor Warmup] Recovery failed:', e.message);
          addWarmupLog('❌ Recovery failed — retrying in 10s...');
          await warmupChunkedSleep(10000);
        }
        continue; // Retry the loop without counting this as an action
      }
    } else {
      consecutiveFailures = 0;
    }

    // Only update stats and log on SUCCESS
    if (actionSuccess) {
      warmupState.stats.totalActions++;
      switch (picked.action) {
        case 'warmup_view_story':     warmupState.stats.storiesViewed++; break;
        case 'warmup_like_post':      warmupState.stats.postsLiked++; break;
        case 'warmup_scroll_feed':    warmupState.stats.feedScrolls++; break;
        case 'warmup_scroll_explore': warmupState.stats.exploreScrolls++; break;
        case 'warmup_reels':          warmupState.stats.reelsWatched = (warmupState.stats.reelsWatched || 0) + 1; break;
        case 'warmup_read_comments':  warmupState.stats.commentsRead++; break;
        case 'warmup_comment':        warmupState.stats.commentsPosted++; break;
        case 'warmup_check_notifs':   warmupState.stats.notifsChecked = (warmupState.stats.notifsChecked || 0) + 1; break;
        case 'warmup_check_inbox':    warmupState.stats.inboxChecks = (warmupState.stats.inboxChecks || 0) + 1; break;
        case 'warmup_browse_search':  warmupState.stats.searches = (warmupState.stats.searches || 0) + 1; break;
      }
      addWarmupLog(actionLabel);
    }

    // Push live warmup stats to the banner on the Instagram tab
    try {
      const tab = await getOrCreatePlatformTab(platform, { createIfMissing: false });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'UPDATE_BANNER',
          mode: 'warmup',
          stats: warmupState.stats,
          latestLog: actionSuccess ? actionLabel : '⏳ Waiting...',
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('[Futnor Background] Warmup: banner update failed:', e?.message || e);
    }

    const delay = getWarmupDelay();
    await warmupChunkedSleep(delay);
  }

  chrome.alarms.clear('warmup-keepalive');
  warmupState.isRunning = false;
  await clearWarmupPersistence();

  // v2.4.150: record the completed warm-up in a timestamped ledger owned by the
  // extension. The dashboard previously kept the only record, in a localStorage
  // counter named `futnor_warmup_count_7d_<account>` that (a) was incremented by
  // two different code paths for the same session and (b) never expired, so
  // "warm-up sessions in the last 7 days" only ever went up. An account warmed
  // up once, months ago, kept scoring as warmed forever — and the health model
  // uses that flag to pick which daily-DM thresholds to apply (50/day when
  // warmed vs 25/day when cold), so the score was structurally too generous.
  try {
    const elapsedSec = Math.max(0, Math.round((Date.now() - startTime) / 1000));
    const account = normalizeAccountUsername(activeAccountUsername) || 'unknown';
    const stored = await chrome.storage.local.get([WARMUP_SESSIONS_KEY]);
    const prior = Array.isArray(stored[WARMUP_SESSIONS_KEY]) ? stored[WARMUP_SESSIONS_KEY] : [];
    const cutoff = Date.now() - WARMUP_LEDGER_RETENTION_MS;
    const next = prior
      .filter((entry) => entry && typeof entry.at === 'number' && entry.at > cutoff)
      .concat([{
        at: Date.now(),
        account,
        platform,
        durationSec: elapsedSec,
        actions: warmupState.stats.totalActions || 0,
      }])
      .slice(-200);
    await chrome.storage.local.set({ [WARMUP_SESSIONS_KEY]: next });
  } catch (e) {
    console.warn('[Futnor Warmup] Could not record warm-up session:', e?.message || e);
  }

  addWarmupLog('Warm-up session complete ✓');
  await hideBannerOnPlatformTab(platform);
}

// ─── Engagement Monitor ─────────────────────────────────────────────────
// Watches a post for new commenters/likers and auto-DMs them.
// This is a SEPARATE session type that does NOT affect the main targeting/DM flow.

let engagementMonitorActive = false;

// ── Persistent DM history for engagement monitor ─────────────────────────
// Keeps track of every recipient we've already DMed across sessions / worker
// restarts so a fresh start doesn't accidentally re-DM the same commenter.
const ENGAGE_HISTORY_KEY = 'futnor_engage_dm_history';
const ENGAGE_HISTORY_MAX = 5000;  // Cap so the set doesn't grow forever.

async function loadEngageHistory() {
  try {
    const stored = await chrome.storage.local.get([ENGAGE_HISTORY_KEY]);
    const arr = stored?.[ENGAGE_HISTORY_KEY];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

async function saveEngageHistory(set) {
  try {
    let arr = Array.from(set);
    if (arr.length > ENGAGE_HISTORY_MAX) arr = arr.slice(-ENGAGE_HISTORY_MAX);
    await chrome.storage.local.set({ [ENGAGE_HISTORY_KEY]: arr });
  } catch {}
}

async function runEngagementMonitor(config) {
  const {
    postUrls: rawPostUrls,
    postUrl: legacyPostUrl,
    triggerKeywords,
    commentToDm,
    likeToDm,
    followToDm,
    dmScript,
    fastMode,           // NEW: tighter scan cadence for ads / time-sensitive launches
    scanAllPosts,       // NEW: when true, scan EVERY post each cycle (default true)
  } = config;

  // Support both legacy single postUrl and new postUrls array.
  const postUrls = (rawPostUrls && rawPostUrls.length > 0) ? rawPostUrls : (legacyPostUrl ? [legacyPostUrl] : []);
  if (postUrls.length === 0 || !dmScript) {
    addLog('session_end', '❌ Engagement monitor: missing post URLs or DM script');
    return;
  }

  engagementMonitorActive = true;
  sessionState.isRunning = true;
  sessionState.isPaused = false;
  sessionState.stats = { dmsSent: 0, likesSent: 0, followsSent: 0, scrolls: 0, elapsedTime: 0, sessionTime: 0 };
  sessionState.logs = [];
  saveState();

  const modeLabel = fastMode ? ' (fast-mode for ads)' : '';
  addLog(
    'session_start',
    `👁️ Monitoring ${postUrls.length} post${postUrls.length > 1 ? 's' : ''} for engagement → DM${modeLabel}`,
  );

  const platform = 'instagram';
  const primeResult = await primePlatformTabForSession(platform, {
    createIfMissing: true, focus: true, sessionSignal: 'SESSION_START',
  });

  if (!primeResult.ok) {
    addLog('session_end', '❌ Could not open Instagram tab');
    sessionState.isRunning = false;
    engagementMonitorActive = false;
    saveState();
    return;
  }

  const tabId = primeResult.tab?.id;

  // PERSISTENT history — survives service-worker restarts.
  const dmHistory = await loadEngageHistory();
  if (dmHistory.size > 0) {
    addLog('scroll', `📚 Loaded ${dmHistory.size} previously-DMed recipients (persistent dedup)`);
  }

  let scanCount = 0;
  const MAX_SCANS = 5000;  // Higher ceiling — long-running ad campaigns need this.

  // Cycle index used when scanAllPosts is FALSE (one-post-per-cycle mode).
  let postIndex = 0;

  // Whether to scan every post per cycle or round-robin (default: scan all).
  const doScanAllPosts = scanAllPosts !== false;

  const normalizeOwnerList = (owners) => new Set(
    (Array.isArray(owners) ? owners : [])
      .map((owner) => normalizeInstagramUsername(owner))
      .filter(Boolean)
  );

  chrome.alarms.create('session-tick', { periodInMinutes: 1 / 60 });

  // Inner: scan a single post for comment / like / follow targets.
  // Returns the array of new targets discovered on this post.
  async function scanOnePost(postUrl, postLabel) {
    const newTargets = [];
    const ownerBlacklist = new Set();
    const seenTargetsThisScan = new Set();
    const activeOwner = normalizeInstagramUsername(activeAccountUsername);
    if (activeOwner) ownerBlacklist.add(activeOwner);

    try {
      const loaded = await loadEngagementMonitorPost(tabId, postUrl, platform);
      if (!loaded) throw new Error('post_load_failed');
    } catch {
      addLog('scroll', `🔄 ${postLabel} — could not load post, skipping this cycle`);
      return [];
    }

    // ── Action-block detection (DM-flow already does this; engagement monitor
    //    didn't until v2.4.94). If Instagram is showing a block / challenge
    //    dialog, hard-stop the monitor. ──
    try {
      const blockState = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_INSTAGRAM_BLOCK' });
      if (blockState?.blocked) {
        addLog('session_end', `🛑 Instagram block detected (${blockState.reason}) — stopping monitor`);
        engagementMonitorActive = false;
        sessionState.isRunning = false;
        try {
          chrome.storage.local.set({
            futnor_last_block: { reason: blockState.reason, signal: blockState.signal, at: Date.now(), platform: 'instagram' },
          });
        } catch {}
        return [];
      }
    } catch {}

    // Comments
    if (commentToDm) {
      try {
        const commentResult = await chrome.tabs.sendMessage(tabId, {
          type: 'PERFORM_ACTION', action: 'monitorPostComments', keywords: triggerKeywords || [],
        });
        for (const owner of normalizeOwnerList(commentResult?.owners)) ownerBlacklist.add(owner);
        if (commentResult?.commenters) {
          for (const c of commentResult.commenters) {
            const username = normalizeInstagramUsername(c.username);
            if (!username) continue;
            if (ownerBlacklist.has(username)) continue;
            if (dmHistory.has(username)) continue;
            if (seenTargetsThisScan.has(username)) continue;
            seenTargetsThisScan.add(username);
            newTargets.push({ username, reason: `commented "${c.trigger}"` });
          }
        }
      } catch (e) {
        console.error('[Futnor Background] Comment scan error:', e);
      }
    }

    // Likes
    if (likeToDm) {
      try {
        const likerResult = await chrome.tabs.sendMessage(tabId, {
          type: 'PERFORM_ACTION', action: 'monitorPostLikers',
        });
        for (const owner of normalizeOwnerList(likerResult?.owners)) ownerBlacklist.add(owner);
        if (likerResult?.likers) {
          for (const u of likerResult.likers) {
            const username = normalizeInstagramUsername(u);
            if (!username) continue;
            if (ownerBlacklist.has(username)) continue;
            if (dmHistory.has(username)) continue;
            if (seenTargetsThisScan.has(username)) continue;
            seenTargetsThisScan.add(username);
            newTargets.push({ username, reason: 'liked post' });
          }
        }
      } catch (e) {
        console.error('[Futnor Background] Liker scan error:', e);
      }
    }

    // New followers (independent of post — only scan once per cycle, not per post)
    return { newTargets, ownerBlacklist };
  }

  // Inner: deliver a list of DMs sequentially. Tracks history persistently.
  async function dispatchDMs(targets, ownerBlacklist, postLabel) {
    if (!targets.length) return;
    for (const target of targets) {
      if (!engagementMonitorActive || !sessionState.isRunning || shouldStop()) break;
      if (dmHistory.has(target.username)) continue;
      if (ownerBlacklist.has(target.username)) {
        addLog('dm_skipped', `⏭️ Skipping post owner @${target.username}${postLabel}`);
        continue;
      }

      addLog('dm', `📨 DMing @${target.username} (${target.reason})${postLabel}`);
      const dmResult = await sendInstagramDirectComposeDM(dmScript, target.username);

      if (dmResult) {
        dmHistory.add(target.username);
        await saveEngageHistory(dmHistory);   // Persist after every successful DM
        sessionState.stats.dmsSent++;
        addLog('dm', `✅ DM sent to @${target.username}`);
        updateBannerLive(`✅ DM sent to @${target.username}`);
        // CRITICAL: do NOT call postCommentAfterDM here. The recipient already
        // came to us via comment — adding our own comment back is the exact
        // same-account-correlates-DM-and-comment spam pattern that was
        // disabled in postCommentAfterDM itself in v2.4.94.
      } else {
        addLog('dm_skipped', `❌ DM failed for @${target.username}`);
      }
      saveState();
    }
  }

  while (engagementMonitorActive && sessionState.isRunning && !shouldStop() && scanCount < MAX_SCANS) {
    if (sessionState.isPaused) {
      await waitWhilePaused();
      if (!sessionState.isRunning) break;
    }

    scanCount++;
    let allTargets = [];
    let combinedOwnerBlacklist = new Set();

    if (doScanAllPosts) {
      // Scan ALL posts each cycle so a comment on post #5 doesn't have to wait
      // for the round-robin to come around.
      for (let i = 0; i < postUrls.length; i++) {
        if (!engagementMonitorActive || !sessionState.isRunning || shouldStop()) break;
        const url = postUrls[i];
        const postLabel = postUrls.length > 1 ? ` [${i + 1}/${postUrls.length}]` : '';
        const result = await scanOnePost(url, postLabel);
        if (!engagementMonitorActive) break;
        if (result?.newTargets?.length) {
          allTargets = allTargets.concat(result.newTargets.map(t => ({ ...t, postUrl: url, postLabel })));
        }
        if (result?.ownerBlacklist) {
          for (const o of result.ownerBlacklist) combinedOwnerBlacklist.add(o);
        }
        // Tiny gap between post scans so we don't hammer Instagram.
        await waitMs(randomInt(800, 1800));
      }
    } else {
      // Round-robin one post per cycle (legacy behaviour).
      const url = postUrls[postIndex % postUrls.length];
      const postLabel = postUrls.length > 1 ? ` [${postIndex % postUrls.length + 1}/${postUrls.length}]` : '';
      const result = await scanOnePost(url, postLabel);
      if (result?.newTargets?.length) {
        allTargets = result.newTargets.map(t => ({ ...t, postUrl: url, postLabel }));
      }
      if (result?.ownerBlacklist) combinedOwnerBlacklist = result.ownerBlacklist;
      postIndex++;
    }

    // Followers scan — once per cycle (separate from per-post comment/like scans).
    if (followToDm) {
      try {
        const followResult = await chrome.tabs.sendMessage(tabId, {
          type: 'PERFORM_ACTION', action: 'monitorNewFollowers',
        });
        if (followResult?.followers) {
          const seen = new Set(allTargets.map(t => t.username));
          for (const u of followResult.followers) {
            const username = normalizeInstagramUsername(u);
            if (!username) continue;
            if (combinedOwnerBlacklist.has(username)) continue;
            if (dmHistory.has(username)) continue;
            if (seen.has(username)) continue;
            seen.add(username);
            allTargets.push({
              username,
              reason: 'new follower',
              postUrl: postUrls[0],
              postLabel: '',
            });
          }
        }
      } catch (e) {
        console.error('[Futnor Background] Follower scan error:', e);
      }
    }

    // Dispatch all DMs collected this cycle.
    if (allTargets.length > 0) {
      // Group by post so we open each post once for its targets.
      const byPost = new Map();
      for (const t of allTargets) {
        const k = t.postUrl;
        if (!byPost.has(k)) byPost.set(k, []);
        byPost.get(k).push(t);
      }
      for (const [postUrl, targets] of byPost.entries()) {
        if (!engagementMonitorActive) break;
        await dispatchDMs(targets, combinedOwnerBlacklist, targets[0]?.postLabel || '');
        // After dispatching for a given post, navigate back to it for next time.
        try {
          await navigateTabAndWait(tabId, postUrl);
          await waitMs(randomInt(800, 1500));
        } catch {}
      }
    }

    if (allTargets.length === 0) {
      addLog('scroll', `🔍 Scan #${scanCount} — no new engagements`);
    } else {
      addLog('scroll', `🔍 Scan #${scanCount} — found ${allTargets.length} new targets across ${postUrls.length} post${postUrls.length > 1 ? 's' : ''}`);
    }

    updateBannerLive(`Monitoring... Scan #${scanCount} | ${sessionState.stats.dmsSent} DMs sent`);
    saveState();

    // ── Cycle wait ──
    // fastMode: 3–6s between cycles (for ads & launches where seconds matter).
    // normal:   15–25s between cycles (for organic posts; lower detection signal).
    const [waitMin, waitMax] = fastMode ? [3000, 6000] : [15000, 25000];
    await waitMs(randomInt(waitMin, waitMax));
  }

  addLog(
    'session_end',
    `👁️ Engagement monitor stopped — ${sessionState.stats.dmsSent} DMs sent across ${postUrls.length} post${postUrls.length > 1 ? 's' : ''}`,
  );
  sessionState.isRunning = false;
  engagementMonitorActive = false;
  chrome.alarms.clear('session-tick');
  // Final history persistence.
  await saveEngageHistory(dmHistory);
  saveState();
  await hideBannerOnPlatformTab(platform);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Message handler ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // ── Main-world execCommand injection ─────────────────────────────────────
    // Content scripts run in an isolated world; calling execCommand from there
    // can fail to fire isTrusted events into Instagram's Lexical editor.
    // By injecting into world:'MAIN' via chrome.scripting, the call happens
    // in the same JS context as the page code — Lexical treats it as trusted.
    case 'INJECT_EXECCOMMAND': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ success: false, error: 'no tabId' }); return; }
          const text = msg.text || '';
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (insertText) => {
              function normalizeOutgoingMessage(message) {
                if (!message) return '';
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
                // Lexical's innerText returns \n or \n\n for paragraph boundaries
                // depending on the page's CSS (full-page vs widget have different margins).
                // Collapsing all newline runs to \n confirms text was entered without
                // accepting partial scripts — every non-whitespace character must match.
                const actualNL = actual.replace(/\n+/g, '\n');
                const expectedNL = expected.replace(/\n+/g, '\n');
                return actualNL === expectedNL;
              }
              // Helper: reject search inputs, nav bars on /direct/inbox/
              function isDMCandidate(el) {
                if (!el) return false;
                if (el.tagName === 'INPUT') return false;
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                if (aria.includes('search') || ph.includes('search')) return false;
                if (el.closest('nav') || el.closest('[role="search"]')) return false;
                return true;
              }
              function getComposerText(el) {
                if (!el) return '';
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
                const raw = (typeof el.innerText === 'string' && el.innerText.length > 0)
                  ? el.innerText
                  : (el.textContent || '');
                return raw.replace(/\u200B/g, '');
              }
              async function waitForStableComposerMatch(el, expectedText, options = {}) {
                const {
                  maxChecks = 6,
                  requiredConsecutive = 2,
                  delayMs = 100,
                } = options;
                let stablePasses = 0;

                for (let check = 0; check < maxChecks; check++) {
                  const textNow = getComposerText(el);
                  if (composerTextMatchesExpected(textNow, expectedText)) {
                    stablePasses += 1;
                    if (stablePasses >= requiredConsecutive) return true;
                  } else {
                    stablePasses = 0;
                  }
                  await new Promise(r => setTimeout(r, delayMs));
                }

                return false;
              }
              function selectionInsideComposer(el) {
                try {
                  const selection = window.getSelection();
                  if (!selection || selection.rangeCount === 0) return false;
                  return el.contains(selection.getRangeAt(0).commonAncestorContainer);
                } catch (_) {
                  return false;
                }
              }
              function placeCaretAtEnd(el) {
                if (!el || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
                try {
                  const selection = window.getSelection();
                  const range = document.createRange();
                  let target = el;
                  while (target && target.lastChild) {
                    target = target.lastChild;
                    if (target.nodeType === Node.TEXT_NODE) break;
                    if (target.nodeName === 'BR') {
                      range.setStartBefore(target);
                      range.collapse(true);
                      selection.removeAllRanges();
                      selection.addRange(range);
                      return true;
                    }
                  }
                  if (target && target.nodeType === Node.TEXT_NODE) {
                    range.setStart(target, target.textContent?.length || 0);
                    range.collapse(true);
                  } else if (el.lastElementChild) {
                    range.selectNodeContents(el.lastElementChild);
                    range.collapse(false);
                  } else {
                    range.selectNodeContents(el);
                    range.collapse(false);
                  }
                  selection.removeAllRanges();
                  selection.addRange(range);
                  return true;
                } catch (_) {
                  return false;
                }
              }
              async function primeComposer(el) {
                if (!el) return false;
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
                  return true;
                }
                for (let i = 0; i < 6; i++) {
                  try { el.click(); } catch (_) {}
                  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
                  await new Promise(r => setTimeout(r, 90));
                  if (!selectionInsideComposer(el)) {
                    placeCaretAtEnd(el);
                    await new Promise(r => setTimeout(r, 70));
                  }
                  if (selectionInsideComposer(el)) return true;
                }
                return false;
              }
              // Walk up from an element to find the nearest contenteditable/Lexical parent
              function findComposerAncestor(startEl) {
                let node = startEl;
                while (node && node !== document.body) {
                  if (node.getAttribute && (
                    node.getAttribute('contenteditable') === 'true' ||
                    node.hasAttribute('data-lexical-editor') ||
                    node.tagName === 'TEXTAREA'
                  )) {
                    return node;
                  }
                  node = node.parentElement;
                }
                return null;
              }
              function scoreComposerCandidate(candidate) {
                if (!candidate) return -1;
                const rect = candidate.getBoundingClientRect();
                const label = (candidate.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (candidate.getAttribute('placeholder') || '').toLowerCase();
                let score = 0;
                score += rect.left;
                score += rect.top * 0.45;
                if (label.includes('message') || placeholder.includes('message')) score += 500;
                if (candidate.closest('form')) score += 220;
                if (rect.top > window.innerHeight * 0.45) score += 180;
                if (rect.width > 120) score += 40;
                return score;
              }
              const SELECTORS = [
                'div[role="textbox"][contenteditable="true"]',
                'div[data-lexical-editor="true"]',
                'div[contenteditable="true"][aria-label*="essage"]',
                'div[contenteditable="true"]',
                'textarea',
              ];

              // ── ELEMENT SELECTION ─────────────────────────────────────────────
              // The content script already focused the correct Lexical editor.
              // activeElement might be a CHILD node inside the editor (e.g. <p>, <span>).
              // Walk up to find the actual contenteditable root so we don't re-search
              // and accidentally re-focus a different element (which resets Lexical).
              let el = null;
              let alreadyFocused = false;
              const active = document.activeElement;
              if (active) {
                // Direct match
                if (isDMCandidate(active) &&
                    (active.getAttribute('contenteditable') === 'true' ||
                     active.hasAttribute('data-lexical-editor') ||
                     active.tagName === 'TEXTAREA')) {
                  el = active;
                  alreadyFocused = true;
                }
                // Walk up from active element (handles <p>, <span> inside editor)
                if (!el) {
                  const ancestor = findComposerAncestor(active);
                  if (ancestor && isDMCandidate(ancestor)) {
                    el = ancestor;
                    alreadyFocused = true; // cursor is inside this element's subtree
                  }
                }
              }
              // Fallback: dialog composer, then full-page search
              if (!el) {
                const dialog = document.querySelector('[role="dialog"]');
                if (dialog) {
                  for (const sel of SELECTORS) {
                    const candidate = dialog.querySelector(sel);
                    if (candidate && isDMCandidate(candidate)) { el = candidate; break; }
                  }
                }
              }
              if (!el) {
                let bestScore = -1;
                for (const sel of SELECTORS) {
                  const candidates = document.querySelectorAll(sel);
                  for (const c of candidates) {
                    if (isDMCandidate(c)) {
                      const rect = c.getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) {
                        const score = scoreComposerCandidate(c);
                        if (score > bestScore) {
                          bestScore = score;
                          el = c;
                        }
                      }
                    }
                  }
                  // If found with a specific selector (textbox/lexical), use it
                  if (el && (sel.includes('textbox') || sel.includes('lexical') || sel.includes('essage'))) break;
                }
              }
              if (!el) return { ok: false, reason: 'no composer' };
              if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                // Textarea path: use native value setter so React re-renders
                const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, insertText); else el.value = insertText;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                const stable = await waitForStableComposerMatch(el, insertText, { maxChecks: 5, requiredConsecutive: 2, delayMs: 80 });
                return { ok: stable, via: 'textarea-setter' };
              }
              // Contenteditable / Lexical path
              // Only re-focus if we didn't reuse the content script's active element.
              if (!alreadyFocused || !selectionInsideComposer(el)) {
                await primeComposer(el);
              }
              if (!selectionInsideComposer(el)) placeCaretAtEnd(el);

              // ── ADAPTIVE LEXICAL READINESS WAIT ──────────────────────────────
              // Full pointer event activation to properly trigger Lexical's listeners
              const elRect = el.getBoundingClientRect();
              const elCx = elRect.left + elRect.width / 2;
              const elCy = elRect.top + elRect.height / 2;
              const pOpts = { bubbles: true, cancelable: true, clientX: elCx, clientY: elCy, button: 0 };
              el.dispatchEvent(new PointerEvent('pointerdown', { ...pOpts, pointerId: 1, pointerType: 'mouse' }));
              await new Promise(r => setTimeout(r, 30));
              el.dispatchEvent(new MouseEvent('mousedown', pOpts));
              await new Promise(r => setTimeout(r, 30));
              el.dispatchEvent(new PointerEvent('pointerup', { ...pOpts, pointerId: 1, pointerType: 'mouse' }));
              el.dispatchEvent(new MouseEvent('mouseup', pOpts));
              await new Promise(r => setTimeout(r, 20));
              el.dispatchEvent(new MouseEvent('click', pOpts));
              await new Promise(r => setTimeout(r, 150));
              el.focus({ preventScroll: true });
              el.dispatchEvent(new FocusEvent('focus', { bubbles: false }));

              for (let _i = 0; _i < 20; _i++) {
                await new Promise(r => setTimeout(r, 80));
                try {
                  const _sel = window.getSelection();
                  if (_sel && _sel.rangeCount > 0) {
                    const _r = _sel.getRangeAt(0);
                    if (el.contains(_r.commonAncestorContainer)) break;
                  }
                } catch (_) {}
                // Re-activate every 4th attempt
                if (_i > 0 && _i % 4 === 0) {
                  el.dispatchEvent(new PointerEvent('pointerdown', { ...pOpts, pointerId: 1, pointerType: 'mouse' }));
                  await new Promise(r => setTimeout(r, 20));
                  el.dispatchEvent(new MouseEvent('mousedown', pOpts));
                  await new Promise(r => setTimeout(r, 20));
                  el.dispatchEvent(new PointerEvent('pointerup', { ...pOpts, pointerId: 1, pointerType: 'mouse' }));
                  el.dispatchEvent(new MouseEvent('mouseup', pOpts));
                  el.dispatchEvent(new MouseEvent('click', pOpts));
                  await new Promise(r => setTimeout(r, 80));
                  el.focus({ preventScroll: true });
                }
              }

              const replaceComposerContents = (targetEl, value) => {
                if (!targetEl) return false;
                const normalizedValue = normalizeOutgoingMessage(value);

                if (targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'INPUT') {
                  const proto = targetEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  if (setter) setter.call(targetEl, normalizedValue); else targetEl.value = normalizedValue;
                  targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                  targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                  return composerTextMatchesExpected(targetEl.value || '', normalizedValue);
                }

                const lines = normalizedValue.split('\n');
                const paragraphNodes = lines.map((line) => {
                  const p = document.createElement('p');
                  if (line.length > 0) {
                    p.textContent = line;
                  } else {
                    p.appendChild(document.createElement('br'));
                  }
                  return p;
                });

                try {
                  if (typeof targetEl.replaceChildren === 'function') {
                    targetEl.replaceChildren(...paragraphNodes);
                  } else {
                    targetEl.innerHTML = '';
                    paragraphNodes.forEach((node) => targetEl.appendChild(node));
                  }
                } catch (_) {
                  return false;
                }

                try {
                  const selection = window.getSelection();
                  const range = document.createRange();
                  const lastParagraph = paragraphNodes[paragraphNodes.length - 1] || targetEl;
                  const lastNode = lastParagraph.lastChild || lastParagraph;

                  if (lastNode.nodeType === Node.TEXT_NODE) {
                    range.setStart(lastNode, lastNode.textContent?.length || 0);
                    range.collapse(true);
                  } else {
                    range.selectNodeContents(lastParagraph);
                    range.collapse(false);
                  }

                  selection?.removeAllRanges();
                  selection?.addRange(range);
                } catch (_) {}

                try {
                  targetEl.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: false,
                    inputType: 'insertFromPaste',
                    data: normalizedValue,
                  }));
                } catch (_) {
                  targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                }

                try {
                  targetEl.dispatchEvent(new CompositionEvent('compositionend', {
                    bubbles: true,
                    cancelable: false,
                    data: normalizedValue,
                  }));
                } catch (_) {}

                targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                return composerTextMatchesExpected(getComposerText(targetEl), normalizedValue);
              };

              // ── TEXT INSERTION (with retry) ───────────────────────────────────
              // Instagram configures Lexical in "Enter = send" mode on BOTH the
              // /direct/ full-page layout AND the floating chat widget.
              // execCommand('insertLineBreak') is intercepted by Lexical as a send
              // trigger instead of creating a new paragraph — which caused multi-line
              // scripts to send a TRUNCATED first paragraph to the user and leave
              // only the last paragraph in the composer. The paste-based insertion
              // (replaceComposerContents) bypasses insertLineBreak entirely by
              // shipping the whole text via insertFromPaste, so Lexical treats it
              // as a single paste operation — no spurious sends.
              //
              // CRITICAL: do NOT gate this on isDirectPage. The widget chat has the
              // same Enter=send behaviour. Always use paste for multi-line.
              const isMultiLine = insertText.includes('\n');
              const MAX_INSERT_ATTEMPTS = 3;
              let insertOk = false;
              let textAfter = '';

              // For ANY multi-line script, use paste-based insertion first.
              // This avoids insertLineBreak entirely and handles newlines in one shot.
              if (isMultiLine) {
                const pasteOk = replaceComposerContents(el, insertText);
                if (pasteOk) {
                  await new Promise(r => setTimeout(r, 400));
                  insertOk = await waitForStableComposerMatch(el, insertText, { maxChecks: 8, requiredConsecutive: 3, delayMs: 140 });
                  textAfter = getComposerText(el);
                }
                if (!insertOk) {
                  // Retry once with a re-prime before falling through to execCommand loop
                  await primeComposer(el);
                  await new Promise(r => setTimeout(r, 300));
                  const pasteOk2 = replaceComposerContents(el, insertText);
                  if (pasteOk2) {
                    await new Promise(r => setTimeout(r, 400));
                    insertOk = await waitForStableComposerMatch(el, insertText, { maxChecks: 8, requiredConsecutive: 3, delayMs: 140 });
                    textAfter = getComposerText(el);
                  }
                }
                if (insertOk) {
                  console.log('[Futnor MAIN] multi-line paste insertion succeeded (widget or /direct/)');
                }
              }

              for (let insertAttempt = 0; insertAttempt < MAX_INSERT_ATTEMPTS && !insertOk; insertAttempt++) {
                if (insertAttempt > 0) {
                  // Re-prime composer before retry
                  await primeComposer(el);
                  await new Promise(r => setTimeout(r, 300));
                }
                // Check if composer is empty first; only clear if it has existing text.
                const existingText = getComposerText(el).trim();
                if (normalizeComposerSnapshot(existingText).length > 0) {
                  if (!selectionInsideComposer(el)) placeCaretAtEnd(el);
                  document.execCommand('selectAll', false, null);
                  document.execCommand('delete', false, null);
                  el.textContent = '';
                  el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: false,
                    inputType: 'deleteContentBackward',
                    data: null,
                  }));
                  await new Promise(r => setTimeout(r, 100));

                  if (normalizeComposerSnapshot(getComposerText(el)).length > 0) {
                    replaceComposerContents(el, '');
                    await new Promise(r => setTimeout(r, 120));
                  }
                }

                const lines = insertText.split('\n');
                let lineBreakFailed = false;
                for (let li = 0; li < lines.length; li++) {
                  if (!selectionInsideComposer(el)) placeCaretAtEnd(el);
                  if (lines[li].length > 0) {
                    document.execCommand('insertText', false, lines[li]);
                  }
                  if (li < lines.length - 1) {
                    const insertedBreak = document.execCommand('insertLineBreak', false, null)
                      || document.execCommand('insertHTML', false, '<br>');
                    if (!insertedBreak) {
                      // insertLineBreak not supported — bail out of this method and
                      // let replaceComposerContents handle the full text below.
                      lineBreakFailed = true;
                      break;
                    }
                    await new Promise(r => setTimeout(r, 30));
                  }
                }

                // If insertLineBreak failed mid-loop, clear and use paste fallback immediately
                if (lineBreakFailed) {
                  document.execCommand('selectAll', false, null);
                  document.execCommand('delete', false, null);
                  await new Promise(r => setTimeout(r, 100));
                  replaceComposerContents(el, insertText);
                  await new Promise(r => setTimeout(r, 400));
                }

                await new Promise(r => setTimeout(r, 200));
                insertOk = await waitForStableComposerMatch(el, insertText, { maxChecks: 8, requiredConsecutive: 3, delayMs: 140 });
                textAfter = getComposerText(el);
                if (insertOk) break;
                // If not ok, wait before retry
                await new Promise(r => setTimeout(r, 500));
              }

              // If execCommand failed after all attempts, try DOM mutation as final fallback
              if (!insertOk) {
                console.log('[Futnor MAIN] execCommand failed — trying replaceComposerContents fallback...');
                const replaceOk = replaceComposerContents(el, insertText);
                if (replaceOk) {
                  await new Promise(r => setTimeout(r, 300));
                  insertOk = await waitForStableComposerMatch(el, insertText, { maxChecks: 6, requiredConsecutive: 2, delayMs: 120 });
                  textAfter = getComposerText(el);
                  if (insertOk) {
                    return { ok: true, via: 'replaceComposerContents-fallback', text: textAfter.slice(0, 80), alreadyFocused };
                  }
                }
              }

              const ok = insertOk || composerTextMatchesExpected(textAfter, insertText);
              return { ok, via: 'execCommand-main-world', text: textAfter.slice(0, 80), alreadyFocused, attempts: MAX_INSERT_ATTEMPTS };
            },
            args: [text],
          });
          const result = results?.[0]?.result;
          console.log('[Futnor Background] INJECT_EXECCOMMAND result:', JSON.stringify(result));
          const success = result?.ok === true;
          sendResponse({ success, result });
        } catch (e) {
          console.error('[Futnor Background] INJECT_EXECCOMMAND error:', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async response
    }
    // Inject a trusted-like Send button click into the main world — this is more
    // reliable than synthetic Enter on full-page /direct/t/ chats where Instagram
    // wires sending to the compose-row button instead of keyboard shortcuts.
    case 'INJECT_DM_SEND_CLICK': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ success: false, error: 'no tabId' }); return; }
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              function isDMCandidate(el) {
                if (!el) return false;
                if (el.tagName === 'INPUT') return false;
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                if (aria.includes('search') || ph.includes('search')) return false;
                if (el.closest('nav') || el.closest('[role="search"]')) return false;
                return true;
              }
              function findComposerAncestor(startEl) {
                let node = startEl;
                while (node && node !== document.body) {
                  if (node.getAttribute && (
                    node.getAttribute('contenteditable') === 'true' ||
                    node.hasAttribute('data-lexical-editor') ||
                    node.tagName === 'TEXTAREA'
                  )) {
                    return node;
                  }
                  node = node.parentElement;
                }
                return null;
              }
              function resolveComposer() {
                const SELECTORS = [
                  'div[role="textbox"][contenteditable="true"]',
                  'div[data-lexical-editor="true"]',
                  'div[contenteditable="true"][aria-label*="essage"]',
                  'div[contenteditable="true"]',
                  'textarea',
                ];
                const active = document.activeElement;
                if (active) {
                  if (isDMCandidate(active) && (
                    active.getAttribute('contenteditable') === 'true' ||
                    active.hasAttribute('data-lexical-editor') ||
                    active.tagName === 'TEXTAREA'
                  )) {
                    return active;
                  }
                  const ancestor = findComposerAncestor(active);
                  if (ancestor && isDMCandidate(ancestor)) return ancestor;
                }
                const dialog = document.querySelector('[role="dialog"]');
                if (dialog) {
                  for (const sel of SELECTORS) {
                    const candidate = dialog.querySelector(sel);
                    if (candidate && isDMCandidate(candidate)) return candidate;
                  }
                }
                let best = null;
                let bestX = -1;
                for (const sel of SELECTORS) {
                  for (const candidate of document.querySelectorAll(sel)) {
                    if (!isDMCandidate(candidate)) continue;
                    const rect = candidate.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && rect.left > bestX) {
                      best = candidate;
                      bestX = rect.left;
                    }
                  }
                }
                return best;
              }
              function getLabel(btn) {
                return [
                  btn.getAttribute('aria-label') || '',
                  btn.textContent || '',
                  btn.querySelector('svg')?.getAttribute('aria-label') || '',
                  btn.getAttribute('type') || '',
                ].join(' ').toLowerCase();
              }
              function scoreSendButton(btn, composerRect, composer) {
                if (!btn || !btn.isConnected) return -1;
                const rect = btn.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return -1;

                const label = getLabel(btn);
                const rejectKeywords = [
                  'detail', 'info', 'option', 'more', 'back', 'close', 'minimize',
                  'call', 'audio', 'video', 'phone', 'conversation', 'thread',
                  'action', 'flag', 'report', 'block', 'mute', 'setting',
                  'preference', 'delete', 'remove', 'leave'
                ];
                if (rejectKeywords.some((kw) => label.includes(kw))) return -1;
                if (rect.bottom < composerRect.top - 80) return -1;

                let score = 0;
                if (label.includes('send')) score += 100;
                if (label.includes('submit')) score += 60;
                if ((btn.getAttribute('type') || '').toLowerCase() === 'submit') score += 80;
                if (rect.left >= composerRect.right - 40) score += 30;
                if (rect.left > composerRect.left) score += 10;
                if (Math.abs(rect.top - composerRect.top) < 80) score += 25;
                if (Math.abs(rect.bottom - composerRect.bottom) < 80) score += 15;
                if (composer.closest('form') && btn.closest('form') === composer.closest('form')) score += 30;
                return score;
              }
              function findSendButton(composer) {
                const composerRect = composer.getBoundingClientRect();
                const containers = [
                  composer.closest('form'),
                  composer.parentElement,
                  composer.closest('section'),
                  composer.closest('[role="presentation"]'),
                  composer.closest('[role="main"]'),
                  document,
                ].filter((node, idx, arr) => node && arr.indexOf(node) === idx);

                let bestBtn = null;
                let bestScore = -1;
                for (const container of containers) {
                  const buttons = container.querySelectorAll ? container.querySelectorAll('button, [role="button"]') : [];
                  for (const btn of buttons) {
                    const score = scoreSendButton(btn, composerRect, composer);
                    if (score > bestScore) {
                      bestScore = score;
                      bestBtn = btn;
                    }
                  }
                  if (bestScore >= 100) break;
                }
                return bestScore >= 70 ? { button: bestBtn, score: bestScore } : null;
              }

              const composer = resolveComposer();
              if (!composer) return { ok: false, reason: 'no composer' };

              const found = findSendButton(composer);
              if (!found?.button) return { ok: false, reason: 'no send button' };

              const btn = found.button;
              btn.focus?.();
              const pointerOpts = { bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1 };
              const mouseOpts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
              // Fire the full pointer/mouse down→up sequence so React's
              // synthetic event system sees a realistic interaction.
              try { btn.dispatchEvent(new PointerEvent('pointerdown', pointerOpts)); } catch {}
              try { btn.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch {}
              try { btn.dispatchEvent(new PointerEvent('pointerup', { ...pointerOpts, buttons: 0 })); } catch {}
              try { btn.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, buttons: 0 })); } catch {}
              // CRITICAL: fire the click EXACTLY ONCE. Previously this code
              // called BOTH dispatchEvent(new MouseEvent('click')) AND
              // btn.click() — Instagram's React onClick fired for each
              // event and the DM was sent TWICE. btn.click() is the
              // native path that properly triggers React's delegated
              // click handler, so we use only that one.
              try { btn.click?.(); } catch {}

              const btnRect = btn.getBoundingClientRect();
              const composerRectForLog = composer.getBoundingClientRect();
              return {
                ok: true,
                via: 'main-world-send-click',
                score: found.score,
                label: getLabel(btn).slice(0, 60),
                btnRect: { x: Math.round(btnRect.left), y: Math.round(btnRect.top), w: Math.round(btnRect.width), h: Math.round(btnRect.height) },
                composerRect: { x: Math.round(composerRectForLog.left), y: Math.round(composerRectForLog.top), w: Math.round(composerRectForLog.width), h: Math.round(composerRectForLog.height) },
                disabled: btn.disabled === true || btn.getAttribute('aria-disabled') === 'true',
                tag: btn.tagName,
              };
            },
          });
          const result = results?.[0]?.result;
          console.log('[Futnor Background] INJECT_DM_SEND_CLICK result:', JSON.stringify(result));
          sendResponse({ success: result?.ok === true, result });
        } catch (e) {
          console.error('[Futnor Background] INJECT_DM_SEND_CLICK error:', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    // Inject a trusted Enter keypress into the main world — Instagram's Lexical
    // editor only honours isTrusted=true keyboard events for the send shortcut.
    case 'INJECT_ENTER_KEY': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ success: false, error: 'no tabId' }); return; }
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              // Helper: reject search inputs, nav bars on /direct/inbox/
              function isDMCandidate(el) {
                if (!el) return false;
                if (el.tagName === 'INPUT') return false;
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                if (aria.includes('search') || ph.includes('search')) return false;
                if (el.closest('nav') || el.closest('[role="search"]')) return false;
                return true;
              }
              // Walk up from an element to find the nearest contenteditable/Lexical parent
              function findComposerAncestor(startEl) {
                let node = startEl;
                while (node && node !== document.body) {
                  if (node.getAttribute && (
                    node.getAttribute('contenteditable') === 'true' ||
                    node.hasAttribute('data-lexical-editor') ||
                    node.tagName === 'TEXTAREA'
                  )) {
                    return node;
                  }
                  node = node.parentElement;
                }
                return null;
              }
              // Prefer the already-focused composer (content script set it up)
              const SELECTORS = [
                'div[role="textbox"][contenteditable="true"]',
                'div[data-lexical-editor="true"]',
                'div[contenteditable="true"][aria-label*="essage"]',
                'div[contenteditable="true"]',
                'textarea',
              ];
              let el = null;
              const active = document.activeElement;
              if (active) {
                if (isDMCandidate(active) &&
                    (active.getAttribute('contenteditable') === 'true' ||
                     active.hasAttribute('data-lexical-editor') ||
                     active.tagName === 'TEXTAREA')) {
                  el = active;
                }
                if (!el) {
                  const ancestor = findComposerAncestor(active);
                  if (ancestor && isDMCandidate(ancestor)) {
                    el = ancestor;
                  }
                }
              }
              if (!el) {
                const dialog = document.querySelector('[role="dialog"]');
                if (dialog) {
                  for (const sel of SELECTORS) {
                    const candidate = dialog.querySelector(sel);
                    if (candidate && isDMCandidate(candidate)) { el = candidate; break; }
                  }
                }
              }
              if (!el) {
                let bestX = -1;
                for (const sel of SELECTORS) {
                  const candidates = document.querySelectorAll(sel);
                  for (const c of candidates) {
                    if (isDMCandidate(c)) {
                      const rect = c.getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0 && rect.left > bestX) {
                        bestX = rect.left;
                        el = c;
                      }
                    }
                  }
                  if (el && (sel.includes('textbox') || sel.includes('lexical') || sel.includes('essage'))) break;
                }
              }
              if (!el) return { ok: false, reason: 'no composer' };
              el.focus();
              // Dispatch a full trusted-like Enter key sequence
              const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
              el.dispatchEvent(new KeyboardEvent('keydown', opts));
              el.dispatchEvent(new KeyboardEvent('keypress', opts));
              el.dispatchEvent(new KeyboardEvent('keyup', { ...opts, cancelable: false }));
              return { ok: true, via: 'main-world-enter' };
            },
          });
          const result = results?.[0]?.result;
          console.log('[Futnor Background] INJECT_ENTER_KEY result:', JSON.stringify(result));
          sendResponse({ success: result?.ok === true, result });
        } catch (e) {
          console.error('[Futnor Background] INJECT_ENTER_KEY error:', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    case 'INJECT_WHATSAPP_TEXT': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ success: false, error: 'no tabId' }); return; }
          const response = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { type: 'INJECT_EXECCOMMAND', text: msg.text || '' }, (res) => {
              if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
              else resolve(res || { success: false, error: 'no_response' });
            });
          });
          console.log('[Futnor Background] INJECT_WHATSAPP_TEXT delegated result:', JSON.stringify(response));
          sendResponse(response);
        } catch (e) {
          console.error('[Futnor Background] INJECT_WHATSAPP_TEXT error:', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    case 'INJECT_WHATSAPP_SEARCH': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ success: false, error: 'no tabId' }); return; }
          const text = msg.text || '';
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (searchText) => {
              function normalize(value) {
                return (value || '').toString().replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
              }
              function getSearchBox() {
                const selectors = [
                  'div[data-testid="chat-list-search"] div[contenteditable="true"]',
                  'div[role="textbox"][title*="earch"]',
                  'div[role="textbox"][title*="Buscar"]',
                  'div[role="textbox"][title*="Rechercher"]',
                  '#side div[contenteditable="true"]',
                  'div[contenteditable="true"][data-tab="3"]',
                  'p.selectable-text[data-tab="3"]',
                ];

                for (const sel of selectors) {
                  const candidate = document.querySelector(sel);
                  if (!candidate) continue;
                  const rect = candidate.getBoundingClientRect();
                  if (rect.width < 40 || rect.height < 18) continue;
                  if (candidate.closest('#main footer, #main [data-testid="conversation-compose-box-input"], #main div[role="textbox"]')) continue;
                  const aria = (candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '').toLowerCase();
                  const placeholder = (candidate.getAttribute('data-placeholder') || candidate.getAttribute('placeholder') || '').toLowerCase();
                  const meta = `${aria} ${placeholder} ${candidate.closest('[data-testid]')?.getAttribute('data-testid') || ''}`;
                  if (
                    sel.includes('chat-list-search') ||
                    meta.includes('search') ||
                    meta.includes('buscar') ||
                    meta.includes('rechercher')
                  ) {
                    return candidate;
                  }
                  if (candidate.closest('#side')) return candidate;
                }

                return null;
              }
              function focusEnd(el) {
                el.focus?.({ preventScroll: true });
                const selection = window.getSelection();
                if (!selection) return;
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
              }

              const searchBox = getSearchBox();
              if (!searchBox) return { ok: false, reason: 'no search box' };

              focusEnd(searchBox);
              await new Promise((resolve) => setTimeout(resolve, 50));
              try { document.execCommand('selectAll', false); } catch {}
              try { document.execCommand('delete', false); } catch {}
              searchBox.textContent = '';
              searchBox.innerHTML = '';
              try {
                searchBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
              } catch {
                searchBox.dispatchEvent(new Event('input', { bubbles: true }));
              }

              focusEnd(searchBox);
              await new Promise((resolve) => setTimeout(resolve, 50));
              try { document.execCommand('insertText', false, searchText); } catch {}
              try {
                searchBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: searchText }));
              } catch {
                searchBox.dispatchEvent(new Event('input', { bubbles: true }));
              }

              await new Promise((resolve) => setTimeout(resolve, 120));
              const finalText = (searchBox.innerText || searchBox.textContent || '').replace(/\u200B/g, '');
              return {
                ok: normalize(finalText).includes(normalize(searchText)) || normalize(finalText) === normalize(searchText),
                text: finalText.slice(0, 80),
                via: 'whatsapp-search-main-world',
              };
            },
            args: [text],
          });

          const result = results?.[0]?.result;
          console.log('[Futnor Background] INJECT_WHATSAPP_SEARCH result:', JSON.stringify(result));
          sendResponse({ success: result?.ok === true, result });
        } catch (e) {
          console.error('[Futnor Background] INJECT_WHATSAPP_SEARCH error:', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    case 'INJECT_WHATSAPP_SEND': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ success: false, error: 'no tabId' }); return; }
          const message = msg.message || '';
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (expectedText) => {
              function normalize(value) {
                return (value || '').toString().replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
              }
              function composerText(el) {
                if (!el) return '';
                return ((typeof el.innerText === 'string' && el.innerText.length > 0) ? el.innerText : (el.textContent || '')).replace(/\u200B/g, '');
              }
              function activate(node) {
                const target = node?.closest?.('button, [role="button"], [tabindex]') || node;
                if (!target) return false;
                try { target.focus?.({ preventScroll: true }); } catch {}
                const pointerOpts = { bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1 };
                const mouseOpts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
                try { target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts)); } catch {}
                try { target.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch {}
                try { target.dispatchEvent(new PointerEvent('pointerup', { ...pointerOpts, buttons: 0 })); } catch {}
                try { target.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, buttons: 0 })); } catch {}
                try { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); } catch {}
                try { target.click?.(); } catch {}
                return true;
              }
              function getComposer() {
                const composerSelectors = [
                  'div[data-testid="conversation-compose-box-input"]',
                  'div[contenteditable="true"][data-tab="10"]',
                  '#main footer div[contenteditable="true"]',
                  'footer div[contenteditable="true"]',
                  '#main div[role="textbox"][contenteditable="true"]',
                  '#main div[contenteditable="true"]',
                ];

                for (const sel of composerSelectors) {
                  const candidate = document.querySelector(sel);
                  if (!candidate) continue;
                  const rect = candidate.getBoundingClientRect();
                  if (rect.width < 40 || rect.height < 18) continue;
                  const aria = (candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '').toLowerCase();
                  const placeholder = (candidate.getAttribute('data-placeholder') || candidate.getAttribute('placeholder') || '').toLowerCase();
                  if (
                    aria.includes('search') ||
                    placeholder.includes('search') ||
                    aria.includes('buscar') ||
                    placeholder.includes('buscar') ||
                    aria.includes('rechercher') ||
                    placeholder.includes('rechercher')
                  ) continue;
                  return candidate;
                }
                return null;
              }
              const sendSelectors = [
                '#main footer button[data-testid="compose-btn-send"]',
                '#main footer [data-testid="compose-btn-send"]',
                '#main footer button span[data-testid="send"]',
                '#main footer span[data-testid="send"]',
                '#main footer span[data-icon="send"]',
                '#main footer span[data-icon="send-filled"]',
                '#main footer button[aria-label*="Send"]',
                '#main footer button[aria-label*="Envoyer"]',
                '#main footer button[aria-label*="Enviar"]',
                '#main footer [role="button"][aria-label*="Send"]',
              ];

              const composer = getComposer();
              const currentText = normalize(composerText(composer));
              const expected = normalize(expectedText);
              const hasText = currentText.length > 0;
              const textMatches = !expected || currentText === expected || currentText.includes(expected.slice(0, 24)) || expected.includes(currentText);

              if (!composer || !hasText || !textMatches) {
                return {
                  ok: false,
                  reason: !composer ? 'no composer or send button' : (!hasText ? 'composer_empty' : 'composer_text_mismatch'),
                  composerText: composerText(composer).slice(0, 80),
                };
              }

              for (const sel of sendSelectors) {
                const node = document.querySelector(sel);
                if (!node) continue;
                const rect = node.getBoundingClientRect();
                if (rect.width < 12 || rect.height < 12) continue;
                activate(node);
                return { ok: true, via: 'whatsapp-send-button', selector: sel };
              }
              if (!composer) return { ok: false, reason: 'no composer or send button' };

              try { composer.focus?.({ preventScroll: true }); } catch {}
              const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
              composer.dispatchEvent(new KeyboardEvent('keydown', opts));
              composer.dispatchEvent(new KeyboardEvent('keypress', opts));
              composer.dispatchEvent(new KeyboardEvent('keyup', { ...opts, cancelable: false }));
              return { ok: true, via: 'whatsapp-enter-fallback' };
            },
            args: [message],
          });

          const result = results?.[0]?.result;
          console.log('[Futnor Background] INJECT_WHATSAPP_SEND result:', JSON.stringify(result));
          sendResponse({ success: result?.ok === true, result });
        } catch (e) {
          console.error('[Futnor Background] INJECT_WHATSAPP_SEND error:', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    case 'PING':
      sendResponse({ status: 'connected', ready: true });
      break;
    case 'PING_EXTENSION':
      sendResponse({ status: 'connected', ready: true });
      break;
    case 'REQUEST_ACTIVE_ACCOUNT_DETECTION':
      // Dashboard bridge calls this when its localStorage mirror is empty,
      // so users on every plan get an immediate detection attempt instead of
      // waiting for the SW startup poll cycle.
      (async () => {
        const username = await detectAndSyncActiveAccount('instagram').catch(() => null);
        sendResponse({ success: !!username, username: username || null });
      })();
      return true; // async sendResponse
    case 'RESET_ACTIVE_ACCOUNT':
      // Explicit reset path. Used when the user switches the logged-in IG
      // account in Chrome and wants the extension to re-detect from scratch.
      // Without this, the hard guard in detectAndSyncActiveAccount would
      // refuse to ever change the stored account.
      (async () => {
        console.log(`[Futnor Background] RESET_ACTIVE_ACCOUNT (was: ${activeAccountUsername || '(none)'})`);
        activeAccountUsername = null;
        try { await chrome.storage.local.remove('futnor_active_account'); } catch {}
        const username = await detectAndSyncActiveAccount('instagram').catch(() => null);
        sendResponse({ success: true, username: username || null });
      })();
      return true; // async sendResponse
    case 'GET_ACTIVE_ACCOUNT':
      sendResponse({ username: activeAccountUsername || null });
      break;
    case 'GET_STATE':
      sendResponse({ ...sessionState, warmup: warmupState });
      break;
    case 'START_SESSION':
      (async () => {
        const startFingerprint = getSessionStartFingerprint(msg);
        console.log('[Futnor Background] START_SESSION received:', msg, 'fingerprint:', startFingerprint);

        if (pendingSessionStart) {
          console.log('[Futnor Background] START_SESSION already in progress, joining existing request:', pendingSessionStartFingerprint);
          try {
            const result = await pendingSessionStart;
            sendResponse(result);
          } catch (error) {
            sendResponse({ ok: false, status: 'start_failed', reason: 'start_in_progress_failed', message: error?.message || 'Concurrent start failed' });
          }
          return;
        }

        pendingSessionStartFingerprint = startFingerprint;
        pendingSessionStart = (async () => {
          if (sessionState.isRunning && !sessionState.isPaused && !sessionState.reconnecting) {
            return { ok: true, status: 'session_started', alreadyRunning: true, tabId: preferredInstagramTabId || null };
          }

          // ── SAFETY: enforce inter-session cooldown ──
          try {
            const cfg = sessionState.config || DEFAULT_STATE.config;
            const remaining = await getSessionGapRemainingMs(cfg);
            if (remaining > 0) {
              const remainingMin = Math.ceil(remaining / 60000);
              console.warn(`[Futnor Background] 🛑 Session-gap guard: ${remainingMin}min remaining`);
              return {
                ok: false,
                status: 'start_rejected',
                reason: 'session_cooldown',
                message: `Cooldown active — next session can start in ~${remainingMin} min. This protects your account from automation detection.`,
              };
            }
          } catch {}

          // ── DAILY SESSION GOAL: refuse to start if today's goal met ──
          // The goal counts DMs sent since the user's LOCAL midnight. The
          // whole counter wipes at the next local midnight — fresh day,
          // fresh count.
          try {
            const goal = Number(sessionState.config?.sessionDmGoal) || 0;
            if (goal > 0) {
              const dailySent = getDailyDmsSentCount();
              if (dailySent >= goal) {
                const resumesInMs = getMsUntilLocalMidnight();
                const resumesInMin = Math.max(1, Math.ceil(resumesInMs / 60000));
                const resumesInHr = Math.floor(resumesInMin / 60);
                const resumesInRem = resumesInMin % 60;
                const friendly = resumesInHr > 0 ? `${resumesInHr}h ${resumesInRem}m` : `${resumesInRem}m`;
                console.warn(`[Futnor Background] 🎯 Daily session goal already met: ${dailySent}/${goal}, resets at local midnight (${friendly})`);
                return {
                  ok: false,
                  status: 'start_rejected',
                  reason: 'daily_goal_met',
                  message: `Daily session goal already reached (${dailySent}/${goal} today). Raise the goal or wait ${friendly} until midnight resets the count.`,
                };
              }
            }
          } catch {}

          // ── SAFETY: refuse to start if Instagram block was detected in last 24h ──
          try {
            const blockData = await chrome.storage.local.get(['futnor_last_block']);
            const blk = blockData.futnor_last_block;
            if (blk && typeof blk.at === 'number' && (Date.now() - blk.at) < 24 * 60 * 60 * 1000) {
              const hoursAgo = Math.ceil((Date.now() - blk.at) / 3600000);
              console.warn(`[Futnor Background] 🛑 Refusing start — Instagram block ${hoursAgo}h ago (${blk.reason})`);
              return {
                ok: false,
                status: 'start_rejected',
                reason: 'recent_block',
                message: `Instagram flagged your account ${hoursAgo}h ago (${blk.reason}). Wait at least 24h and resolve any in-app verification before resuming.`,
              };
            }
          } catch {}

          const stored = await chrome.storage.local.get(['subscriptionTier', 'futnor_user_id']);
          // Accept tier from the message itself (dashboard passes it directly)
          const msgTier = msg.tier || msg.subscriptionTier;

          // Build tier from all sources, but NEVER silently default to 'free' —
          // if the user has a futnor_user_id they've authenticated and their tier
          // may simply not have been passed in this message.  Treat that as a
          // recoverable "unknown" state instead of an instant block.
          const rawResolvedTier = msgTier || stored.subscriptionTier || sessionState.tier;
          const hasUserId = !!(stored.futnor_user_id || msg.userId);
          const rawTier = rawResolvedTier || (hasUserId ? 'pending' : 'free');
          const tier = rawTier === 'pending' ? 'pending' : normalizeTier(rawTier);

          console.log('[Futnor Background] Tier check - msg:', msgTier,
            'stored:', stored.subscriptionTier,
            'sessionState:', sessionState.tier,
            'hasUserId:', hasUserId,
            'raw:', rawTier,
            'normalized:', tier);

          // Persist the tier from the message so future sessions work without needing it resent.
          // Store the normalized form so downstream reads (popup, dashboard sync) stay consistent
          // regardless of what casing / variant the dashboard sent this time.
          if (msgTier && normalizeTier(msgTier) !== 'free') {
            const normalizedMsgTier = normalizeTier(msgTier);
            chrome.storage.local.set({ subscriptionTier: normalizedMsgTier }).catch(() => {});
            sessionState.tier = normalizedMsgTier;
          }

          if (tier === 'free') {
            // Last-chance refresh from Supabase — the user may have just
            // started a trial on the dashboard and the bridge hasn't fired
            // syncTier() yet.  If Supabase confirms a paid / trial tier,
            // flip the block and continue; otherwise stay blocked.
            const refreshed = hasUserId
              ? await refreshSubscriptionFromSupabase().catch(() => null)
              : null;
            if (refreshed && refreshed !== 'free') {
              console.log('[Futnor Background] Tier refreshed just-in-time:', refreshed);
              sessionState.tier = refreshed;
            } else {
              console.log('[Futnor Background] Free tier - session blocked');
              addLog('session_blocked', 'Session blocked — subscription or trial required');
              return { ok: false, status: 'start_rejected', reason: 'no_subscription', tabId: null };
            }
          }

          if (tier === 'pending') {
            // User is authenticated but tier wasn't passed — likely a dashboard sync issue.
            // Log it clearly so it's debuggable, but don't block the session.
            console.warn('[Futnor Background] Tier could not be determined for authenticated user — allowing session but flagging for dashboard re-sync');
            addLog('tier_warning', 'Tier unknown — session allowed, but please refresh your dashboard to sync your subscription');
          }

          console.log('[Futnor Background] Tier approved:', tier);

          if (msg.config) {
            const incomingConfig = { ...msg.config };
            if (Object.prototype.hasOwnProperty.call(incomingConfig, 'dmTemplates')) {
              sessionState.dmTemplates = sanitizeDMTemplates(incomingConfig.dmTemplates);
              console.log('[Futnor Background] DM templates loaded:', sessionState.dmTemplates.length);
              delete incomingConfig.dmTemplates;
            }
            sessionState.config = sanitizeSessionConfig({ ...sessionState.config, ...incomingConfig });
          } else {
            sessionState.config = sanitizeSessionConfig(sessionState.config);
          }
          if (msg.platform) sessionState.platform = msg.platform;
          if (msg.targeting) sessionState.targeting = { ...DEFAULT_STATE.targeting, ...msg.targeting };
          if (msg.aiTargeting) sessionState.aiTargeting = msg.aiTargeting;

          console.log('[Futnor Background] Session config applied:', {
            platform: sessionState.platform,
            targeting: sessionState.targeting?.targetTypes,
            aiEnabled: sessionState.aiTargeting?.enabled
          });

          // If templates aren't already in memory (popup-initiated start, fresh
          // SW, or a session that hasn't been started from the dashboard yet),
          // fetch directly from Supabase using the dashboard-mirrored auth.
          // This is what makes the extension popup's Start button actually
          // work without forcing the user to click Start on the website first.
          if (sessionState.dmTemplates.length === 0) {
            console.log('[Futnor Background] dmTemplates empty — attempting Supabase fetch...');
            const fetched = await fetchScriptsFromSupabase(
              sessionState.platform,
              activeAccountUsername,
            );
            if (fetched.length > 0) {
              sessionState.dmTemplates = fetched;
              console.log(`[Futnor Background] Loaded ${fetched.length} DM script(s) from Supabase`);
            }
          }

          if (sessionState.dmTemplates.length === 0) {
            addLog('dm_skipped', 'ERROR: DM script is empty or not loaded');
            return {
              ok: false,
              status: 'start_rejected',
              reason: activeAccountUsername ? 'missing_dm_script_for_account' : 'missing_dm_script',
              account: activeAccountUsername || undefined,
              message: activeAccountUsername
                ? `No active script bulk for @${activeAccountUsername}. Open the dashboard's Scripts panel and toggle a bulk on for this account.`
                : 'No DM scripts found. Open the dashboard and create at least one DM script before starting a session.',
              tabId: null,
            };
          }

          const ai = sessionState.aiTargeting;
          const isAI = ai?.enabled && (ai.searchTerms?.length > 0 || ai.keywords?.length > 0);
          const t = sessionState.targeting;
          const hasManualTarget = t?.targetTypes?.length > 0 && (
            (t.targetTypes.includes('hashtags') && t.hashtags?.trim()) ||
            (t.targetTypes.includes('location') && t.location?.trim()) ||
            ((t.targetTypes.includes('followers') || t.targetTypes.includes('following')) && t.targetUsername?.trim()) ||
            ((t.targetTypes.includes('likers') || t.targetTypes.includes('commenters')) && t.targetPostLink?.trim()) ||
            (t.targetTypes.includes('custom') && t.customUsernames?.length > 0)
          );

          console.log('[Futnor Background] Targeting validation - AI:', isAI, 'Manual:', hasManualTarget);

          if (!isAI && !hasManualTarget) {
            console.log('[Futnor Background] No targeting configured - session blocked');
            addLog('session_blocked', 'Set up targeting on the dashboard before starting');
            return { ok: false, status: 'start_rejected', reason: 'no_targeting', tabId: null };
          }

          const platform = sessionState.platform;
          const shouldResumeExistingSession = sessionState.isPaused
            && (sessionState.stats.sessionTime || 0) > (sessionState.stats.elapsedTime || 0);

          if (!shouldResumeExistingSession) {
            sessionState.stats = { dmsSent: 0, likesSent: 0, followsSent: 0, scrolls: 0, elapsedTime: 0, sessionTime: 0 };
            sessionState.logs = [];
          }

          const primeResult = await primePlatformTabForSession(platform, {
            createIfMissing: true,
            focus: true,
            sessionSignal: shouldResumeExistingSession ? 'SESSION_RESUME' : 'SESSION_START',
          });

          if (!primeResult.ok) {
            console.log('[Futnor Background] Session preflight failed:', primeResult.reason);
            return { ok: false, status: 'start_failed', reason: primeResult.reason || 'start_preflight_failed', tabId: null };
          }

          // Pre-session force-detect: with the tab open and the content script
          // ready, sync the logged-in user one last time BEFORE isRunning flips.
          // After isRunning is true, the detectAndSync guard refuses to replace
          // the active account — so any wrong value (e.g. detected earlier on a
          // /p/ page where the post author's header link leaked through) would
          // stay stuck. Doing one clean detect here, while the guard is still
          // open, is the last chance to correct it for commenters targeting.
          if (platform === 'instagram' && !shouldResumeExistingSession) {
            try {
              await detectAndSyncActiveAccount('instagram');
            } catch {}
          }

          sessionState.tier = tier;
          sessionState.isRunning = true;
          sessionState.isPaused = false;
          sessionState.reconnecting = false;
          saveState();

          // Include tabId in all success responses — the dashboard expects it
          const sessionTabId = primeResult.tab?.id || null;

          if (shouldResumeExistingSession && sessionLoopActive) {
            addLog('session_start', '▶️ Session resumed (loop still active)');
            saveState();
            return { ok: true, status: 'session_started', resumed: true, tabId: sessionTabId };
          }

          sessionLoopPromise = runSession({ resume: shouldResumeExistingSession }).catch((error) => {
            console.error(
              shouldResumeExistingSession
                ? '[Futnor Background] Session failed after resume:'
                : '[Futnor Background] Session failed after start:',
              error?.message || error
            );
            sessionLoopActive = false;
            sessionLoopPromise = null;
            sessionState.isRunning = false;
            sessionState.isPaused = false;
            sessionState.reconnecting = false;
            saveState();
          });

          return { ok: true, status: 'session_started', resumed: shouldResumeExistingSession, tabId: sessionTabId };
        })();

        try {
          const result = await pendingSessionStart;
          sendResponse(result || { ok: false, status: 'start_failed', reason: 'no_response', tabId: null });
        } catch (e) {
          console.error('[Futnor Background] pendingSessionStart threw:', e?.message || e);
          sendResponse({ ok: false, status: 'start_failed', reason: 'internal_error', message: e?.message, tabId: null });
        } finally {
          pendingSessionStart = null;
          pendingSessionStartFingerprint = null;
        }
      })();
      return true; // Keep message channel open for async response
      break;
    case 'START_WARMUP':
      if (!warmupState.isRunning) {
        const platform = msg.platform || sessionState.platform;
        sessionState.platform = platform;
        runWarmup(msg.sessionMinutes || 20, platform, msg.enableComments || false);
      }
      sendResponse({ ok: true });
      break;
    case 'STOP_WARMUP':
      warmupState.isRunning = false;
      clearWarmupPersistence();
      sendResponse({ ok: true });
      break;
    case 'GET_WARMUP_STATE':
      sendResponse(warmupState);
      break;
    case 'PAUSE_SESSION':
      if (sessionState.isRunning && !sessionState.isPaused) {
        sessionState.isPaused = true;
        addLog('session_start', '⏸️ Session paused');
        saveState();
        // Immediately abort any in-progress content script operation
        signalContentScriptStop('SESSION_PAUSE');
      }
      sendResponse({ ok: true });
      break;
    case 'RESUME_SESSION':
      (async () => {
        if (sessionState.isRunning && sessionState.isPaused) {
          try {
            const primeResult = await primePlatformTabForSession(sessionState.platform, {
              createIfMissing: true,
              focus: true,
              sessionSignal: 'SESSION_RESUME',
            });

            if (!primeResult.ok) {
              sessionState.isPaused = true;
              sessionState.reconnecting = true;
              saveState();
              addLog('session_start', 'Reconnecting to extension...');
              sendResponse({ ok: true });
              return;
            }

            sessionState.isPaused = false;
            sessionState.reconnecting = false;
            addLog('session_start', '▶️ Session resumed');
            saveState();

            if (!sessionLoopActive) {
              sessionLoopPromise = runSession({ resume: true }).catch((error) => {
                console.error('[Futnor Background] Session failed after resume:', error?.message || error);
                sessionLoopActive = false;
                sessionLoopPromise = null;
                sessionState.isRunning = false;
                sessionState.isPaused = false;
                sessionState.reconnecting = false;
                saveState();
              });
            }
          } catch (error) {
            sessionState.isPaused = true;
            sessionState.reconnecting = true;
            saveState();
            console.error('[Futnor Background] Resume handshake failed:', error?.message || error);
          }
        }
        sendResponse({ ok: true });
      })();
      return true;
      break;
    case 'STOP_SESSION':
      sessionState.isRunning = false;
      sessionState.isPaused = false;
      sessionState.reconnecting = false;
      sessionLoopActive = false;
      sessionLoopPromise = null;
      engagementMonitorActive = false;
      addLog('session_end', 'Stopped by user');
      saveState();
      hideBannerOnPlatformTab(sessionState.platform);
      recordSessionEnd();
      // Immediately abort any in-progress content script operation
      signalContentScriptStop('SESSION_STOP');
      sendResponse({ ok: true });
      break;
    case 'INSTAGRAM_BLOCK_DETECTED':
      // Content script saw an Instagram block / challenge / suspicious-activity dialog.
      // Hard-stop the session immediately — continuing to act in this state escalates
      // a temporary block to a permanent suspension.
      try {
        const reason = msg.reason || 'unknown';
        const signal = msg.signal || '';
        console.warn(`[Futnor Background] 🛑 Instagram block reported by content script: ${reason} (${signal})`);
        sessionState.isRunning = false;
        sessionState.isPaused = false;
        sessionState.reconnecting = false;
        sessionLoopActive = false;
        sessionLoopPromise = null;
        engagementMonitorActive = false;
        try {
          chrome.storage.local.set({
            futnor_last_block: { reason, signal, at: Date.now(), platform: sessionState.platform || 'instagram' },
          });
        } catch {}
        addLog('session_end', `🛑 Instagram block detected (${reason}) — session stopped to protect account`);
        saveState();
        hideBannerOnPlatformTab(sessionState.platform);
        // Force the cooldown — block detected means we DO want a rest period
        // regardless of how many DMs landed before the block fired.
        recordSessionEnd({ force: true });
        signalContentScriptStop('IG_BLOCK_DETECTED');
      } catch (e) {
        console.error('[Futnor Background] INSTAGRAM_BLOCK_DETECTED handler error:', e);
      }
      sendResponse({ ok: true });
      break;
    case 'START_ENGAGEMENT_MONITOR':
      (async () => {
        if (sessionState.isRunning) {
          sendResponse({ ok: false, reason: 'session_already_running' });
          return;
        }
        const monitorConfig = msg.engagementMonitor;
        const hasUrls = (monitorConfig?.postUrls?.length > 0) || monitorConfig?.postUrl;
        if (!hasUrls || !monitorConfig?.dmScript) {
          sendResponse({ ok: false, reason: 'missing_config' });
          return;
        }
        sendResponse({ ok: true, status: 'monitor_started' });
        runEngagementMonitor(monitorConfig).catch(e => {
          console.error('[Futnor Background] Engagement monitor crashed:', e);
          engagementMonitorActive = false;
          sessionState.isRunning = false;
          saveState();
        });
      })();
      return true;
    case 'STOP_ENGAGEMENT_MONITOR':
      engagementMonitorActive = false;
      sessionState.isRunning = false;
      addLog('session_end', 'Engagement monitor stopped by user');
      saveState();
      hideBannerOnPlatformTab('instagram');
      signalContentScriptStop('MONITOR_STOP');
      sendResponse({ ok: true });
      break;
    case 'RESET_STATS':
      sessionState.stats = { dmsSent: 0, likesSent: 0, followsSent: 0, scrolls: 0, elapsedTime: 0, sessionTime: 0 };
      sessionState.logs = [];
      sessionState.reconnecting = false;
      // Clear visited posts so fresh sessions start clean
      chrome.storage.local.remove('futnor_visited_posts');
      saveState();
      sendResponse({ ok: true });
      break;
    case 'UPDATE_CONFIG':
      sessionState.config = msg.config;
      saveState();
      sendResponse({ ok: true });
      break;
    case 'CLEAR_WARMUP_OFFER':
      sessionState.warmupOffer = false;
      sendResponse({ ok: true });
      break;
    case 'SET_PLATFORM':
      if (!sessionState.isRunning) {
        sessionState.platform = msg.platform;
        saveState();
      }
      sendResponse({ ok: true, platform: sessionState.platform });
      break;
    case 'SET_SUBSCRIPTION_TIER': {
      // Called by the dashboard to persist the user's subscription tier in the extension.
      // Store normalized so a `scale_trial` / `Growth` / `trialing` payload from the
      // billing provider doesn't mysteriously render as "Free Plan" in the popup.
      const incomingTier = msg.tier || msg.subscriptionTier;
      if (incomingTier && typeof incomingTier === 'string') {
        const normalized = normalizeTier(incomingTier);
        sessionState.tier = normalized;
        chrome.storage.local.set({ subscriptionTier: normalized }).catch(() => {});
        console.log('[Futnor Background] Subscription tier set to:', incomingTier, '→', normalized);
        sendResponse({ ok: true, tier: normalized });
      } else {
        sendResponse({ ok: false, error: 'Invalid tier value' });
      }
      break;
    }
    case 'REFRESH_TIER': {
      // On-demand tier refresh from Supabase — the popup fires this on open
      // when it has no stored tier but the user is authenticated, so a
      // user who started a Scale / Growth trial on the dashboard and never
      // reopened that tab gets the right badge the first time they open
      // the popup (instead of seeing "Free Plan" until the dashboard syncs).
      (async () => {
        try {
          const tier = await refreshSubscriptionFromSupabase({ force: !!msg.force });
          sendResponse({ ok: true, tier: tier || null });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || 'refresh_failed' });
        }
      })();
      return true; // async
    }
    case 'FOCUS_BOT_TAB': {
      const platform = msg.platform || sessionState.platform;
      (async () => {
        const tab = await getOrCreatePlatformTab(platform, { createIfMissing: true, focus: true });
        sendResponse({ ok: !!tab });
      })();
      return true; // async
    }

    case 'SCAN_INBOX_RESPONSES': {
      // Triggered by the dashboard's response-rate panel refresh button.
      // Navigates the IG tab to /direct/inbox/, scans for unread threads
      // matching tracked recipients, and marks them as responded.
      (async () => {
        try {
          const result = await scanInboxForResponses({ navigate: msg.navigate !== false });
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || 'scan_failed', updated: 0 });
        }
      })();
      return true; // async
    }

    // ── Sales Agent Commands ──
    case 'START_SALES_AGENT': {
      (async () => {
        try {
          salesAgentRepliedSet.clear();
          salesAgentConfig = {
            active: true,
            platform: msg.platform || 'instagram',
            interval: msg.interval || 45000,
          };
          const storagePayload = { futnor_sales_agent_config: salesAgentConfig };
          if (msg.authToken) {
            storagePayload.futnor_supabase_token = msg.authToken;
          }
          await chrome.storage.local.set(storagePayload);
          if (!salesAgentLoopActive) {
            runSalesAgentLoop();
          }
          await showBannerOnPlatformTab(salesAgentConfig.platform, 'sales-agent');
          updateSalesAgentStatus({ active: true });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }
    case 'STOP_SALES_AGENT': {
      salesAgentConfig.active = false;
      salesAgentLoopActive = false;
      salesAgentRepliedSet.clear();
      chrome.storage.local.set({ futnor_sales_agent_config: salesAgentConfig });
      hideBannerOnPlatformTab(salesAgentConfig.platform);
      updateSalesAgentStatus({ active: false });
      sendResponse({ ok: true });
      break;
    }
  }
  return true;
});

// ─── Sales Agent Auto-Reply Loop ────────────────────────────────────────────

let salesAgentConfig = { active: false, platform: 'instagram', interval: 45000 };
let salesAgentLoopActive = false;
let salesAgentRepliedSet = new Set(); // Track handled thread states this session

function getSalesAgentThreadKey(platform, thread) {
  return [
    platform || 'instagram',
    (thread?.username || '').toString().trim().toLowerCase(),
    (thread?.messageFingerprint || thread?.lastMessage || '').toString().trim().toLowerCase(),
    Number(thread?.unreadCount || 0),
  ].join('::');
}

// Load persisted config on startup
(async () => {
  try {
    const stored = await chrome.storage.local.get('futnor_sales_agent_config');
    if (stored.futnor_sales_agent_config) {
      salesAgentConfig = stored.futnor_sales_agent_config;
      if (salesAgentConfig.active && !salesAgentLoopActive) {
        runSalesAgentLoop();
      }
    }
  } catch {}
})();

function updateSalesAgentStatus(overrides = {}) {
  const status = {
    active: salesAgentConfig.active,
    platform: salesAgentConfig.platform || 'instagram',
    lastScan: Date.now(),
    ...overrides,
  };
  chrome.storage.local.set({ futnor_sales_agent_status: status });
}

function normalizeSalesAgentBaseUrl(baseUrl) {
  const value = (baseUrl || '').toString().trim().replace(/\/$/, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

async function getBestWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: PLATFORM_URLS.whatsapp });
  if (!tabs.length) return null;

  return [...tabs].sort((left, right) => {
    const activeDelta = Number(Boolean(right.active)) - Number(Boolean(left.active));
    if (activeDelta !== 0) return activeDelta;
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  })[0];
}

async function runSalesAgentLoop() {
  if (salesAgentLoopActive) return;
  salesAgentLoopActive = true;
  console.log('[Futnor] Sales agent loop started');

  while (salesAgentConfig.active && salesAgentLoopActive) {
    try {
      await performSalesAgentScan();
      updateSalesAgentStatus({ active: true });
    } catch (e) {
      console.error('[Futnor] Sales agent scan error:', e);
    }

    // Wait before next scan (30-60s randomized)
    const delay = salesAgentConfig.interval + Math.floor(Math.random() * 15000);
    await new Promise(r => setTimeout(r, delay));
  }

  salesAgentLoopActive = false;
  console.log('[Futnor] Sales agent loop stopped');
}

async function performSalesAgentScan() {
  const platform = salesAgentConfig.platform || 'instagram';
  console.log(`[Futnor] Sales agent scanning ${platform} inbox...`);

  // Platform-specific inbox URLs and base domains
  const platformConfig = {
    instagram: {
      inboxUrl: 'https://www.instagram.com/direct/inbox/',
      baseDomain: 'https://www.instagram.com',
      contentScript: 'instagram/content.js',
    },
    tiktok: {
      inboxUrl: 'https://www.tiktok.com/messages',
      baseDomain: 'https://www.tiktok.com',
      contentScript: 'tiktok/content.js',
    },
    whatsapp: {
      inboxUrl: 'https://web.whatsapp.com/',
      baseDomain: 'https://web.whatsapp.com',
      contentScript: 'whatsapp/content.js',
    },
  };

  const config = platformConfig[platform] || platformConfig.instagram;

  // For WhatsApp, find existing tab or create one (don't navigate away from an active chat)
  let tab;
  if (platform === 'whatsapp') {
    const existingTab = await getBestWhatsAppTab();
    if (existingTab) {
      tab = existingTab;
      console.log(`[Futnor] Sales agent: found existing WhatsApp tab ${tab.id}`);
    } else {
      console.log('[Futnor] Sales agent: opening new WhatsApp Web tab...');
      tab = await chrome.tabs.create({ url: config.inboxUrl, active: false });
      await waitMs(10000); // WhatsApp Web takes longer to load
    }
  } else {
    tab = await getOrCreatePlatformTab(platform, { createIfMissing: true, focus: false });
    if (!tab?.id) {
      console.log('[Futnor] Sales agent: no platform tab available');
      return;
    }
    // Navigate to inbox
    await new Promise((resolve, reject) => {
      chrome.tabs.update(tab.id, { url: config.inboxUrl }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
    await waitMs(4000);
  }

  if (!tab?.id) {
    console.log('[Futnor] Sales agent: no tab available after setup');
    return;
  }

  // Ensure content script is ready
  let contentScriptReady = false;
  try {
    const pingResult = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
    contentScriptReady = !!pingResult?.ready;
    console.log(`[Futnor] Sales agent: content script PING result:`, contentScriptReady);
  } catch {}

  if (!contentScriptReady) {
    console.log(`[Futnor] Sales agent: injecting ${platform} content script...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [config.contentScript],
      });
      await waitMs(2000);
      // Verify injection
      const verifyPing = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });
      console.log(`[Futnor] Sales agent: post-injection PING:`, !!verifyPing?.ready);
      if (!verifyPing?.ready) {
        console.log('[Futnor] Sales agent: content script not responding after injection, aborting scan');
        return;
      }
    } catch (e) {
      console.error(`[Futnor] Sales agent: script injection failed:`, e.message);
      return;
    }
  } else {
    await waitMs(1000);
  }

  if (platform === 'whatsapp') {
    await showBannerOnPlatformTab(platform, 'sales-agent');
  }

  // Scan for unread DMs
  let unreadThreads = [];
  try {
    const response = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 10000); // 10s timeout
      chrome.tabs.sendMessage(tab.id, {
        type: 'SALES_AGENT_ACTION',
        action: 'scanInboxForNewDMs',
      }, (res) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.log('[Futnor] Sales agent: scanInbox message error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(res);
        }
      });
    });

    console.log('[Futnor] Sales agent: scanInbox response:', JSON.stringify(response)?.substring(0, 200));

    if (response?.ok && response.threads?.length > 0) {
      unreadThreads = response.threads;
    }
  } catch (e) {
    console.error('[Futnor] Sales agent scan inbox failed:', e);
    return;
  }

  console.log(`[Futnor] Sales agent: found ${unreadThreads.length} unread threads on ${platform}`);

  // Track responses — any unread thread from a user we previously DMed counts as a response
  if (unreadThreads.length > 0) {
    trackDMResponsesToSupabase(unreadThreads.map(t => t.username).filter(Boolean), platform);
  }

  // Process each unread thread
  for (const thread of unreadThreads) {
    if (!salesAgentConfig.active) break;
    const threadKey = getSalesAgentThreadKey(platform, thread);
    if (salesAgentRepliedSet.has(threadKey)) continue;

    try {
      // Get the Supabase auth token from storage
      const stored = await chrome.storage.local.get(['futnor_supabase_token', 'futnor_supabase_url', 'futnor_supabase_anon_key']);
      const token = stored.futnor_supabase_token;
      const baseUrl = normalizeSalesAgentBaseUrl(stored.futnor_supabase_url);
      const anonKey = stored.futnor_supabase_anon_key;

      if (!token || !baseUrl) {
        console.log('[Futnor] Sales agent: no auth token or URL, skipping. hasToken:', !!token, 'hasUrl:', !!baseUrl, 'hasAnonKey:', !!anonKey);
        updateSalesAgentStatus({
          active: salesAgentConfig.active,
          error: !token ? 'missing_auth_token' : 'missing_backend_url',
        });
        break;
      }

      console.log(`[Futnor] Sales agent: calling chat for @${thread.username} on ${platform}`);
      const response = await fetch(`${baseUrl}/functions/v1/sales-agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': anonKey || token,
        },
        body: JSON.stringify({
          action: 'chat',
          customerIdentifier: thread.username,
          customerMessage: thread.lastMessage || 'Hey',
          platform: platform,
          conversationHistory: Array.isArray(thread.conversationHistory) ? thread.conversationHistory : [],
        }),
      });

      const data = await response.json();
      console.log(`[Futnor] Sales agent response for @${thread.username}:`, response.status, data?.reply ? 'has reply' : 'no reply', data?.error || '');

      if (!response.ok) {
        updateSalesAgentStatus({
          active: salesAgentConfig.active,
          error: data?.error || `backend_${response.status}`,
        });
        continue;
      }

      if (data?.reply) {
        console.log(`[Futnor] Sales agent reply to @${thread.username}: ${data.reply.substring(0, 50)}...`);
        let replySent = false;

        // Platform-specific reply sending
        if (platform === 'whatsapp') {
          // Open the chat by name and send
          const openChatResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'SALES_AGENT_ACTION',
              action: 'openChat',
              contactName: thread.username,
              messageHint: thread.lastMessage || '',
            }, (res) => resolve(res));
          });
          if (!openChatResult?.ok) {
            console.log(`[Futnor] Sales agent: failed to open WhatsApp chat for @${thread.username}:`, openChatResult?.error || 'unknown_error');
            updateSalesAgentStatus({
              active: salesAgentConfig.active,
              error: openChatResult?.error || 'whatsapp_open_chat_failed',
            });
            continue;
          }
          await waitMs(2000);

          const sendMessageResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'SALES_AGENT_ACTION',
              action: 'sendMessage',
              message: data.reply,
            }, (res) => resolve(res));
          });
          if (!sendMessageResult?.ok) {
            console.log(`[Futnor] Sales agent: failed to send WhatsApp reply to @${thread.username}:`, sendMessageResult?.error || 'unknown_error');
            updateSalesAgentStatus({
              active: salesAgentConfig.active,
              error: sendMessageResult?.error || 'whatsapp_send_failed',
            });
            continue;
          }
          replySent = true;
        } else if (thread.href) {
          // Instagram / TikTok: navigate to thread URL and use sales agent reply
          const threadUrl = thread.href.startsWith('http')
            ? thread.href
            : `${config.baseDomain}${thread.href}`;

          await new Promise((resolve, reject) => {
            chrome.tabs.update(tab.id, { url: threadUrl }, () => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve();
            });
          });
          await waitMs(3000);
          await ensureContentScript(tab.id, platform);
          await waitMs(1500);

          try {
            // Use SALES_AGENT_ACTION sendReply — bypasses deduplication
            // so the agent can reply to ongoing conversations
            const sendResult = await new Promise((resolve) => {
              chrome.tabs.sendMessage(tab.id, {
                type: 'SALES_AGENT_ACTION',
                action: 'sendReply',
                message: data.reply,
              }, (res) => {
                if (chrome.runtime.lastError) {
                  console.log('[Futnor] Sales agent sendReply error:', chrome.runtime.lastError.message);
                  resolve(null);
                } else {
                  resolve(res);
                }
              });
            });
            console.log(`[Futnor] Sales agent DM result for @${thread.username}:`, sendResult?.status || sendResult?.error);
            replySent = sendResult?.ok && sendResult?.status === 'dm_sent';
          } catch (e) {
            console.error(`[Futnor] Sales agent DM send failed for @${thread.username}:`, e);
          }
        }

        if (!replySent) {
          continue;
        }

        salesAgentRepliedSet.add(threadKey);
        updateSalesAgentStatus({ active: true, lastReplyAt: Date.now(), error: null });

        // Also add to DM history to prevent outreach bot from messaging them.
        // v2.4.150: this called addToDMHistory() — a content-script function
        // that does not exist in the service worker. Every sales-agent reply
        // threw "ReferenceError: addToDMHistory is not defined", which the
        // surrounding try/catch swallowed, so replied-to leads never made it
        // into DM history and the outreach bot could cold-DM them again.
        if (platform !== 'whatsapp') {
          try {
            await addToBgDMHistory(thread.username);
          } catch (e) {
            console.warn(`[Futnor] Sales agent: could not record DM history for @${thread.username}:`, e?.message || e);
          }
        }

        // Human-like delay between threads
        await waitMs(getRandom(8000, 15000));
        continue;
      }

      updateSalesAgentStatus({
        active: salesAgentConfig.active,
        error: data?.error || 'empty_reply',
      });
    } catch (e) {
      console.error(`[Futnor] Sales agent error processing @${thread.username}:`, e);
      updateSalesAgentStatus({
        active: salesAgentConfig.active,
        error: e?.message || 'thread_processing_failed',
      });
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'session-tick' && sessionState.isRunning && !sessionState.isPaused) {
    sessionState.stats.elapsedTime++;
  }
  // Warmup keepalive — just waking the service worker is enough
  if (alarm.name === 'warmup-keepalive') {
    console.log('[Futnor] Warmup keepalive ping');
  }
  // Idle keepalive — fires at all times to prevent MV3 service worker termination.
  // The dashboard pings the extension (PING_EXTENSION) continuously; if the service
  // worker is asleep those pings time out and the UI shows "disconnected".
  if (alarm.name === IDLE_KEEPALIVE_ALARM) {
    // Just being woken up by the alarm is enough — worker stays alive for another 30s
    console.log('[Futnor Background] Idle keepalive — worker active');
  }
});
