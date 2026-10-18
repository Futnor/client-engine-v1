// Popup — lightweight control panel, syncs with background worker

const $ = (id) => document.getElementById(id);
const DASHBOARD_URL = 'https://futnor-dm-bot.lovable.app';

let currentPlatform = 'instagram';

// ─── Subscription / Tier Display ───
// Normalize whatever the dashboard pushed into a tier key this popup knows about.
// The dashboard may send tier strings like "Scale", "scale_trial", "trialing",
// "trial-growth", "scale trial", etc. Without normalization the popup falls
// through to the FREE fallback and a user who started a Scale plan trial sees
// "Free Plan" — which also makes our internal `tier === 'free'` checks look
// wrong to anyone reading logs. Keep this in sync with normalizeTier() in
// background.js so both surfaces agree.
function normalizeTier(raw) {
  if (!raw) return 'free';
  let t = String(raw).toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (!t) return 'free';
  const KNOWN = new Set(['free','trial','starter','scale','growth','pro','business','admin']);
  if (KNOWN.has(t)) return t;

  // "{plan}_trial" / "trial_{plan}" / "{plan}_trialing" — user is on a paid
  // plan's free trial. All features are unlocked; treat as trial of that plan.
  const trialMatch = t.match(/^(?:trial_|trialing_)?(scale|growth|starter|pro|business)(?:_trial(?:ing)?)?$/);
  if (trialMatch) return `${trialMatch[1]}_trial`;

  // Generic trial states from billing providers (e.g. Stripe's "trialing").
  if (t === 'trialing' || t === 'on_trial' || t === 'in_trial') return 'trial';

  // Anything the dashboard deliberately sent that isn't literally 'free' means
  // the user is authenticated and on some paid state — don't fall back to FREE.
  // Show it as a generic "Subscribed" rather than a misleading "Free Plan".
  if (t !== 'free') return 'subscribed';
  return 'free';
}

function updateTierDisplay(rawTier) {
  const badge = $('tierBadge');
  const banner = $('subBanner');
  const icon = $('subIcon');
  const tierText = $('subTierText');
  const detail = $('subDetail');
  const actionBtn = $('subActionBtn');

  badge.className = 'tier-badge';
  banner.className = 'sub-banner';

  const tier = normalizeTier(rawTier);

  const tiers = {
    trial:          { badge: '🎁 TRIAL',          cls: 'trial',    bannerCls: 'trial',   icon: '⏳', name: 'Free Trial Active',        desc: 'All features unlocked while your trial runs', btn: 'Upgrade', link: '/pricing' },
    starter:        { badge: '⭐ STARTER',        cls: 'starter',  bannerCls: 'premium', icon: '⭐', name: 'Starter Plan',             desc: '$9/mo — Core automation',                    btn: 'Manage',  link: '' },
    starter_trial:  { badge: '⭐ STARTER TRIAL',  cls: 'starter',  bannerCls: 'trial',   icon: '⏳', name: 'Starter Plan — Free Trial', desc: 'Trial active — all Starter features unlocked', btn: 'Manage',  link: '' },
    growth:         { badge: '🌱 GROWTH',         cls: 'growth',   bannerCls: 'premium', icon: '🌱', name: 'Growth Plan',              desc: 'Growth automation + targeting',               btn: 'Manage',  link: '' },
    growth_trial:   { badge: '🌱 GROWTH TRIAL',   cls: 'growth',   bannerCls: 'trial',   icon: '⏳', name: 'Growth Plan — Free Trial',  desc: 'Trial active — all Growth features unlocked',  btn: 'Manage',  link: '' },
    scale:          { badge: '🚀 SCALE',          cls: 'scale',    bannerCls: 'premium', icon: '🚀', name: 'Scale Plan',               desc: 'Scale automation + priority limits',         btn: 'Manage',  link: '' },
    scale_trial:    { badge: '🚀 SCALE TRIAL',    cls: 'scale',    bannerCls: 'trial',   icon: '⏳', name: 'Scale Plan — Free Trial',   desc: 'Trial active — all Scale features unlocked',   btn: 'Manage',  link: '' },
    pro:            { badge: '💎 PRO',            cls: 'pro',      bannerCls: 'premium', icon: '💎', name: 'Pro Plan',                 desc: '$29/mo — AI + advanced targeting',           btn: 'Manage',  link: '' },
    pro_trial:      { badge: '💎 PRO TRIAL',      cls: 'pro',      bannerCls: 'trial',   icon: '⏳', name: 'Pro Plan — Free Trial',    desc: 'Trial active — all Pro features unlocked',     btn: 'Manage',  link: '' },
    business:       { badge: '👑 BUSINESS',       cls: 'business', bannerCls: 'premium', icon: '👑', name: 'Business Plan',            desc: '$79/mo — Unlimited everything',              btn: 'Manage',  link: '' },
    business_trial: { badge: '👑 BUSINESS TRIAL', cls: 'business', bannerCls: 'trial',   icon: '⏳', name: 'Business Plan — Free Trial', desc: 'Trial active — all Business features unlocked', btn: 'Manage', link: '' },
    admin:          { badge: '👑 ADMIN',          cls: 'admin',    bannerCls: 'premium', icon: '🛡️', name: 'Admin',                    desc: 'Full access',                                btn: 'Dashboard', link: '' },
    // Fallback used when a non-free tier is reported but we don't recognize
    // the exact name — still clearly communicates the user has a paid state.
    subscribed:     { badge: '✅ SUBSCRIBED',     cls: 'subscribed', bannerCls: 'premium', icon: '✅', name: 'Subscribed',             desc: 'Subscription active',                        btn: 'Manage',  link: '' },
  };

  const t = tiers[tier] || { badge: 'FREE', cls: 'free', bannerCls: '', icon: '🔒', name: 'Free Plan', desc: 'Upgrade to unlock all features', btn: 'Upgrade', link: '/pricing' };

  badge.textContent = t.badge;
  badge.classList.add(t.cls);
  if (t.bannerCls) banner.classList.add(t.bannerCls);
  icon.textContent = t.icon;
  tierText.textContent = t.name;
  detail.textContent = t.desc;
  actionBtn.textContent = t.btn;
  actionBtn.className = 'sub-action-btn' + (t.btn === 'Manage' || t.btn === 'Dashboard' ? ' manage' : '');
  actionBtn.onclick = () => chrome.tabs.create({ url: DASHBOARD_URL + t.link });
}

// ─── Platform ───
function setPlatform(platform) {
  currentPlatform = platform;
  $('platformIG').classList.toggle('active', platform === 'instagram');
  $('platformTT').classList.toggle('active', platform === 'tiktok');
  $('dmLabel').textContent = platform === 'tiktok' ? 'Comments' : 'DMs';
  chrome.runtime.sendMessage({ type: 'SET_PLATFORM', platform });
}
$('platformIG').addEventListener('click', () => setPlatform('instagram'));
$('platformTT').addEventListener('click', () => setPlatform('tiktok'));

// ─── Auto-open platform tab ───
function openPlatformTab(platform) {
  const url = platform === 'tiktok' ? 'https://www.tiktok.com' : 'https://www.instagram.com';
  const pattern = platform === 'tiktok' ? 'https://www.tiktok.com/*' : 'https://www.instagram.com/*';
  chrome.tabs.query({ url: pattern }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url, active: true });
    }
  });
}

// ─── Controls ───
$('startBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    const tier = normalizeTier(state?.tier);
    if (tier === 'free') {
      const banner = $('subBanner');
      banner.classList.add('shake');
      setTimeout(() => banner.classList.remove('shake'), 600);
      $('subDetail').textContent = '⚠️ Subscribe or start a trial to use the bot';
      chrome.tabs.create({ url: DASHBOARD_URL + '/pricing' });
      return;
    }

    const ai = state?.aiTargeting;
    const hasAI = ai?.enabled && ((ai.searchTerms?.length || 0) > 0 || (ai.keywords?.length || 0) > 0);
    const t = state?.targeting;
    const hasManual = t?.targetTypes?.length > 0 && (
      (t.targetTypes.includes('hashtags') && t.hashtags?.trim()) ||
      (t.targetTypes.includes('location') && t.location?.trim()) ||
      ((t.targetTypes.includes('followers') || t.targetTypes.includes('following')) && t.targetUsername?.trim()) ||
      ((t.targetTypes.includes('likers') || t.targetTypes.includes('commenters')) && t.targetPostLink?.trim()) ||
      (t.targetTypes.includes('custom') && t.customUsernames?.length > 0)
    );
    if (!hasAI && !hasManual) {
      $('idleHint').innerHTML = '<p style="color:#f59e0b;font-weight:600">⚠️ Set up targeting on the dashboard first</p><p>Configure who to reach before starting a session.</p>';
      chrome.tabs.create({ url: DASHBOARD_URL + '/#section-targeting' });
      return;
    }

    chrome.runtime.sendMessage({ type: 'START_SESSION', platform: currentPlatform }, (resp) => {
      if (resp?.status === 'session_started') {
        updateUI(true);
        return;
      }

      // Show the actual rejection reason in the popup. We do NOT auto-open
      // tabs anymore — the previous behaviour ("popup just redirects to the
      // website") felt broken; the user should be able to read what happened
      // and click Start again themselves.
      if (resp?.reason === 'no_targeting') {
        $('idleHint').innerHTML = '<p style="color:#f59e0b;font-weight:600">⚠️ Set up targeting on the dashboard first</p>';
        return;
      }

      if (resp?.reason === 'missing_dm_script' || resp?.reason === 'missing_dm_script_for_account') {
        // The SW tried Supabase before reaching this point (v2.4.112+), so
        // hitting this rejection means the user really has no active script
        // bulk — either because they haven't created one, haven't toggled
        // one active for the connected account, or aren't authenticated.
        const msg = resp.message
          || (resp.account
            ? `No active script bulk for @${resp.account}. Open the dashboard and toggle one on for this account.`
            : 'No DM scripts found. Open the dashboard and create at least one DM script.');
        $('idleHint').innerHTML = `<p style="color:#f59e0b;font-weight:600">⚠️ ${msg}</p>`;
        return;
      }

      if (resp?.reason === 'session_cooldown' || resp?.reason === 'daily_goal_met' || resp?.reason === 'recent_block') {
        $('idleHint').innerHTML =
          `<p style="color:#f59e0b;font-weight:600">⏳ ${resp.message || 'Session blocked — see dashboard for details'}</p>`;
        return;
      }

      if (resp?.reason === 'no_subscription') {
        $('idleHint').innerHTML = '<p style="color:#f59e0b;font-weight:600">⚠️ Subscription required</p>';
        return;
      }

      const msg = resp?.message || 'Make sure Instagram is open and the extension content script is ready.';
      $('idleHint').innerHTML =
        `<p style="color:#ef4444;font-weight:600">⚠️ Extension connected but failed to start session</p><p>${msg}</p>`;
    });
  });
});

$('stopBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' });
  updateUI(false);
});

$('resetBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_STATS' });
  updateStats({ dmsSent: 0, likesSent: 0, followsSent: 0, scrolls: 0 });
  $('logContainer').innerHTML = '<div class="log-empty">Waiting for actions…</div>';
});

$('dashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

// ─── Bot Name (editable, persisted) ───
const botNameEl = $('statusText');
chrome.storage.local.get(['botName'], (r) => {
  if (r.botName) botNameEl.textContent = r.botName;
});
botNameEl.addEventListener('blur', () => {
  const name = botNameEl.textContent.trim() || 'My Bot';
  botNameEl.textContent = name;
  chrome.storage.local.set({ botName: name });
});
botNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); botNameEl.blur(); }
});

// ─── UI Updates ───
function updateUI(running) {
  $('startBtn').style.display = running ? 'none' : 'block';
  $('stopBtn').style.display = running ? 'block' : 'none';
  $('resetBtn').disabled = running;
  $('statusDot').className = `status-dot ${running ? 'running' : 'stopped'}`;
  // Don't overwrite the custom bot name
  $('livePanel').style.display = running ? 'block' : 'none';
  $('idleHint').style.display = running ? 'none' : 'block';
  $('platformIG').disabled = running;
  $('platformTT').disabled = running;
}

function updateStats(s) {
  $('scrolls').textContent = s.scrolls || 0;
  $('likes').textContent = s.likesSent || 0;
  $('follows').textContent = s.followsSent || 0;
  $('dms').textContent = s.dmsSent || 0;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgress(stats) {
  if (stats.sessionTime > 0) {
    const pct = Math.min(100, (stats.elapsedTime / stats.sessionTime) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = `${formatTime(stats.elapsedTime)} / ${formatTime(stats.sessionTime)}`;
  }
}

function getActionClass(action) {
  if (!action) return '';
  if (action.includes('scroll')) return 'action-scroll';
  if (action.includes('like')) return 'action-like';
  if (action.includes('follow')) return 'action-follow';
  if (action.includes('dm') || action.includes('comment')) return 'action-dm';
  if (action.includes('session')) return 'action-session';
  return '';
}

function updateLogs(logs) {
  if (!logs || logs.length === 0) return;
  $('logContainer').innerHTML = logs.slice(0, 15).map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = getActionClass(log.action || '');
    return `<div class="log-entry"><span class="time">${time}</span><span class="${cls}">${log.message}</span></div>`;
  }).join('');
}

// ─── Poll state from background ───
function refreshState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (!state) return;
    updateUI(state.isRunning);
    updateStats(state.stats || {});
    updateProgress(state.stats || {});
    updateLogs(state.logs);
    if (state.tier) updateTierDisplay(state.tier);
    if (state.platform && state.platform !== currentPlatform) setPlatform(state.platform);
  });
}

// ─── Init ───
// Render whatever we already have in storage first (so the popup doesn't
// flash "Free Plan" on open), then ask the background to refresh the tier
// from Supabase if the user is authenticated — that's what catches a Scale
// or Growth trial user who never reopened the dashboard tab.
chrome.storage.local.get(['subscriptionTier', 'futnor_user_id'], (result) => {
  const storedTier = result.subscriptionTier;
  const isAuthed = !!result.futnor_user_id;
  const normalized = normalizeTier(storedTier);

  updateTierDisplay(storedTier || (isAuthed ? 'subscribed' : 'free'));

  // Ask the background to refresh from Supabase whenever the stored tier is
  // missing or free for an authenticated user — the dashboard bridge may not
  // have run yet (user never reopened the dashboard after starting a trial).
  if (isAuthed && (!storedTier || normalized === 'free')) {
    try {
      chrome.runtime.sendMessage({ type: 'REFRESH_TIER' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp?.tier) updateTierDisplay(resp.tier);
      });
    } catch {}
  }
});

// Listen for tier changes from the web app
chrome.storage.onChanged.addListener((changes) => {
  if (changes.subscriptionTier) {
    updateTierDisplay(changes.subscriptionTier.newValue || 'free');
  }
});

refreshState();
setInterval(refreshState, 1000);

// ─── Privacy Consent Gate ───
// Chrome Web Store policy (Purple Nickel) requires prominent disclosure and
// explicit user consent before the extension processes message/conversation
// data. We block all UI behind this overlay until the user accepts. Consent
// is stored locally; declining closes the popup.
(function initConsentGate() {
  const overlay = $('consentOverlay');
  const accept = $('consentAccept');
  const decline = $('consentDecline');
  if (!overlay || !accept || !decline) return;

  chrome.storage.local.get(['privacy_consent_v1'], (res) => {
    if (res?.privacy_consent_v1?.accepted) return;
    overlay.style.display = 'flex';
  });

  accept.addEventListener('click', () => {
    chrome.storage.local.set({
      privacy_consent_v1: {
        accepted: true,
        acceptedAt: new Date().toISOString(),
        version: 1,
      },
    }, () => {
      overlay.style.display = 'none';
    });
  });

  decline.addEventListener('click', () => {
    window.close();
  });
})();
