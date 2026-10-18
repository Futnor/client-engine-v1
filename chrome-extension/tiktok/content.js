// TikTok Content Script — runs on tiktok.com, performs DOM interactions
// Mimics human behavior patterns for comment and DM engagement

// ─── CRITICAL: Register PING handler IMMEDIATELY so background can detect us ───
if (!window.__futnorTiktokPingRegistered) {
  window.__futnorTiktokPingRegistered = true;
  chrome.runtime.onMessage.addListener(function __futnorEarlyPing(msg, sender, sendResponse) {
    if (msg.type === 'PING') {
      sendResponse({ ready: true });
      return true;
    }
  });
  console.log('[Futnor TikTok] Early PING handler registered ✓');
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', platform: 'tiktok' });
  } catch {}
}

if (window.__futnorTiktokContentLoaded) {
  console.log('[Futnor TikTok] Content script already loaded, skipping re-init');
} else {
  window.__futnorTiktokContentLoaded = true;
}

// ─── Unthrottled timing via background service worker ────────────────────
// Primary path: route delays through chrome.runtime.sendMessage to the SW.
// SW setTimeout is NOT subject to tab-visibility throttling (1s minimum on
// hidden tabs in document context), so the bot keeps full human-simulation
// speed in background tabs. The SW also bypasses the host page's CSP, which
// previously broke our Worker-based unthrottling on TikTok.
function __futnorTtBgDelay(ms) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => { if (!resolved) { resolved = true; resolve(); } };
    const safety = setTimeout(finish, Math.max(0, ms) + 3000);
    try {
      chrome.runtime.sendMessage({ type: 'TIMER_REQUEST', ms }, () => {
        void chrome.runtime.lastError;
        clearTimeout(safety);
        finish();
      });
    } catch {
      clearTimeout(safety);
      setTimeout(finish, ms);
    }
  });
}

// ─── Legacy worker fallback (kept for resilience) ─────────────────────────
// Not currently used — sleep() goes straight to bg. Retained as a tested
// fallback in case the bg-routed path ever needs to be backed out.
let __futnorTtTimerWorker = null;
let __futnorTtTimerWorkerProbe = null;
let __futnorTtTimerSeq = 0;
const __futnorTtTimerCallbacks = new Map();
function __futnorTtProbeWorker() {
  if (__futnorTtTimerWorkerProbe) return __futnorTtTimerWorkerProbe;
  __futnorTtTimerWorkerProbe = new Promise((resolve) => {
    let worker = null;
    try {
      const code = `const timers=new Map();self.onmessage=function(e){const{id,ms,cancel,ping}=e.data||{};if(ping){self.postMessage({ping:true});return;}if(cancel){const t=timers.get(id);if(t){clearTimeout(t);timers.delete(id);}return;}const t=setTimeout(()=>{timers.delete(id);self.postMessage({id});},ms);timers.set(id,t);};`;
      worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    } catch (err) {
      console.warn('[Futnor TikTok] Worker constructor threw, using setTimeout:', err);
      __futnorTtTimerWorker = null;
      resolve();
      return;
    }
    let settled = false;
    const finalize = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) {
        __futnorTtTimerWorker = worker;
        worker.onmessage = (e) => {
          if (!e.data || e.data.ping) return;
          const cb = __futnorTtTimerCallbacks.get(e.data.id);
          if (cb) { __futnorTtTimerCallbacks.delete(e.data.id); cb(); }
        };
        worker.onerror = null;
        console.log('[Futnor TikTok] Timer worker ready');
      } else {
        __futnorTtTimerWorker = null;
        try { worker.terminate(); } catch {}
        console.warn('[Futnor TikTok] Timer worker unavailable (likely CSP-blocked), using setTimeout');
      }
      resolve();
    };
    worker.onmessage = (e) => { if (e.data && e.data.ping) finalize(true); };
    worker.onerror = () => finalize(false);
    try { worker.postMessage({ ping: true }); }
    catch { finalize(false); return; }
    setTimeout(() => finalize(false), 1000);
  });
  return __futnorTtTimerWorkerProbe;
}
function sleep(ms) {
  return __futnorTtBgDelay(ms);
}

// Background-safe scrolling: force instant scroll when tab is hidden so
// rAF-driven smooth scrolls don't hang while the user is on another tab.
(function installBackgroundSafeScroll() {
  if (window.__futnorScrollPatched) return;
  window.__futnorScrollPatched = true;
  const isHidden = () => document.visibilityState === 'hidden' || document.hidden;
  const sanitize = (opts) => (opts && typeof opts === 'object' && isHidden() && opts.behavior === 'smooth') ? { ...opts, behavior: 'auto' } : opts;
  const wTo = window.scrollTo.bind(window), wBy = window.scrollBy.bind(window);
  window.scrollTo = function (...a) { return a.length === 1 ? wTo(sanitize(a[0])) : wTo(...a); };
  window.scrollBy = function (...a) { return a.length === 1 ? wBy(sanitize(a[0])) : wBy(...a); };
  const oSIV = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (o) { return oSIV.call(this, sanitize(o) ?? o); };
  const oeTo = Element.prototype.scrollTo, oeBy = Element.prototype.scrollBy;
  if (oeTo) Element.prototype.scrollTo = function (...a) { return a.length === 1 ? oeTo.call(this, sanitize(a[0])) : oeTo.apply(this, a); };
  if (oeBy) Element.prototype.scrollBy = function (...a) { return a.length === 1 ? oeBy.call(this, sanitize(a[0])) : oeBy.apply(this, a); };
})();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(baseMs) {
  const jitter = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.round(baseMs * (0.5 + jitter));
}

function simulateMousePath(targetEl) {
  const rect = targetEl.getBoundingClientRect();
  const endX = rect.left + rect.width / 2 + randomInt(-5, 5);
  const endY = rect.top + rect.height / 2 + randomInt(-5, 5);
  const startX = endX + randomInt(-200, 200);
  const startY = endY + randomInt(-100, 100);
  const steps = randomInt(4, 8);

  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
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

async function humanClick(element) {
  if (!element) return false;
  simulateMousePath(element);
  await sleep(humanDelay(150));
  element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  await sleep(humanDelay(80));
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(humanDelay(120));
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await sleep(randomInt(50, 150));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  element.click();
  return true;
}

// ─── SCROLL (Feed browsing) ───────────────────────────────
async function performScroll() {
  const totalScroll = randomInt(300, 800);
  const steps = randomInt(3, 8);
  const stepAmount = totalScroll / steps;

  for (let i = 0; i < steps; i++) {
    const variation = stepAmount * (0.6 + Math.random() * 0.8);
    window.scrollBy({ top: variation, behavior: 'smooth' });
    await sleep(humanDelay(400));
  }

  // Pause to "watch" a video
  if (Math.random() < 0.5) {
    await sleep(randomInt(2000, 6000));
  }

  // Occasionally scroll back slightly
  if (Math.random() < 0.15) {
    window.scrollBy({ top: -randomInt(50, 200), behavior: 'smooth' });
    await sleep(humanDelay(800));
  }

  return true;
}

// ─── LIKE ──────────────────────────────────────────────────
async function performLike() {
  // TikTok like button selectors
  const likeButtons = document.querySelectorAll(
    '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], span[data-e2e="like-icon"]'
  );

  const visibleButtons = Array.from(likeButtons).filter(btn => {
    const rect = btn.getBoundingClientRect();
    return rect.top >= 50 && rect.top <= window.innerHeight - 50;
  });

  if (visibleButtons.length === 0) {
    // Fallback: try finding heart SVGs
    const hearts = document.querySelectorAll('svg path[d*="heart"], button[aria-label*="like" i]');
    if (hearts.length === 0) return false;
    const target = hearts[randomInt(0, Math.min(hearts.length - 1, 3))];
    const clickable = target.closest('button') || target.closest('[role="button"]') || target;
    clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(600));
    return await humanClick(clickable);
  }

  const target = visibleButtons[randomInt(0, visibleButtons.length - 1)];
  const clickable = target.closest('button') || target.closest('[role="button"]') || target;

  clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(600));

  // Sometimes browse comments before liking
  if (Math.random() < 0.25) {
    await scrollThroughComments();
  }

  return await humanClick(clickable);
}

// ─── FOLLOW ────────────────────────────────────────────────
async function performFollow() {
  const buttons = document.querySelectorAll(
    '[data-e2e="follow-button"], button[class*="follow" i]'
  );

  const followButtons = Array.from(buttons).filter(btn => {
    const text = btn.textContent?.trim().toLowerCase();
    return (text === 'follow' || text === 'follow back') && !btn.disabled;
  });

  if (followButtons.length === 0) {
    // Broader fallback
    const allBtns = Array.from(document.querySelectorAll('button')).filter(
      btn => btn.textContent?.trim() === 'Follow'
    );
    if (allBtns.length === 0) return false;
    const target = allBtns[randomInt(0, Math.min(allBtns.length - 1, 3))];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(500));
    return await humanClick(target);
  }

  const target = followButtons[randomInt(0, followButtons.length - 1)];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(500));
  return await humanClick(target);
}

// ─── COMMENT BROWSING ──────────────────────────────────────
async function scrollThroughComments() {
  // Open comments panel if not open
  const commentBtn = document.querySelector(
    '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]'
  );
  if (commentBtn) {
    const clickable = commentBtn.closest('button') || commentBtn.closest('[role="button"]') || commentBtn;
    await humanClick(clickable);
    await sleep(humanDelay(1200));
  }

  // Scroll through comment area
  const commentArea = document.querySelector(
    '[data-e2e="comment-list"], div[class*="CommentList"], div[class*="comment-list"]'
  ) || document.querySelector('[class*="DivCommentListContainer"]');

  if (commentArea) {
    const scrollPasses = randomInt(2, 5);
    for (let i = 0; i < scrollPasses; i++) {
      commentArea.scrollTop += randomInt(80, 200);
      await sleep(humanDelay(900));
    }

    if (Math.random() < 0.3) {
      commentArea.scrollTop -= randomInt(40, 100);
      await sleep(humanDelay(500));
    }
  }

  await sleep(randomInt(1000, 3000));
}

// ─── TYPE TEXT INTO INPUT ──────────────────────────────────
async function typeText(element, text) {
  await humanClick(element);
  await sleep(humanDelay(400));

  for (const char of text) {
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement?.prototype || window.HTMLInputElement?.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(element, element.value + char);
    } else {
      document.execCommand('insertText', false, char);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(randomInt(30, 150));
  }

  await sleep(humanDelay(500));
}

// ─── COMMENT ON VIDEO ──────────────────────────────────────
async function performComment(customMessage) {
  // Open comments if needed
  const commentBtn = document.querySelector(
    '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]'
  );
  if (commentBtn) {
    const clickable = commentBtn.closest('button') || commentBtn.closest('[role="button"]') || commentBtn;
    await humanClick(clickable);
    await sleep(humanDelay(1500));
  }

  // Find comment input
  const commentInput = document.querySelector(
    '[data-e2e="comment-input"] div[contenteditable="true"]'
  ) || document.querySelector(
    'div[class*="DivInputEditorContainer"] div[contenteditable="true"]'
  ) || document.querySelector('div[contenteditable="true"][data-placeholder*="comment" i]');

  if (!commentInput) return false;

  const message = customMessage || 'Great content! 🔥';
  await typeText(commentInput, message);

  // Click post button
  const postBtn = document.querySelector(
    '[data-e2e="comment-post"], button[class*="PostButton"]'
  ) || Array.from(document.querySelectorAll('button')).find(
    b => b.textContent?.trim().toLowerCase() === 'post'
  );

  if (postBtn) {
    await humanClick(postBtn);
    await sleep(humanDelay(500));
    return true;
  }

  // Fallback: press Enter
  commentInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await sleep(humanDelay(300));
  return true;
}

// ─── DM (TikTok Messages) ─────────────────────────────────
async function performDM(customMessage) {
  // Step 1: Navigate to messages if not there
  if (!window.location.pathname.startsWith('/messages')) {
    const msgLink = document.querySelector('a[href="/messages"]')
      || document.querySelector('a[href*="/messages"]')
      || document.querySelector('[data-e2e="message-icon"]');

    if (msgLink) {
      const clickable = msgLink.closest('a') || msgLink;
      await humanClick(clickable);
      await sleep(humanDelay(2000));
    } else {
      window.location.href = 'https://www.tiktok.com/messages';
      await sleep(3000);
    }
    return true;
  }

  // Step 2: Open a conversation
  const threads = document.querySelectorAll(
    '[data-e2e="message-list"] div[class*="ConversationItem"], div[class*="conversation-item"]'
  );

  if (threads.length > 0 && !document.querySelector('[data-e2e="message-input"]')) {
    const maxIdx = Math.min(threads.length - 1, 4);
    const target = threads[randomInt(0, maxIdx)];

    // Browse threads briefly
    const threadList = target.closest('[class*="list"]') || target.parentElement;
    if (threadList) {
      for (let i = 0; i < randomInt(1, 3); i++) {
        threadList.scrollTop += randomInt(50, 150);
        await sleep(humanDelay(500));
      }
    }

    await humanClick(target);
    await sleep(humanDelay(1500));
    return true;
  }

  // Step 3: Send message in conversation
  const messageInput = document.querySelector(
    '[data-e2e="message-input"] div[contenteditable="true"]'
  ) || document.querySelector('div[contenteditable="true"][data-placeholder*="message" i]')
    || document.querySelector('div[class*="DivEditorContainer"] div[contenteditable="true"]');

  if (messageInput && customMessage) {
    // Scroll through existing messages first
    const messageArea = document.querySelector('[data-e2e="message-detail"]')
      || document.querySelector('div[class*="MessageList"]');

    if (messageArea) {
      for (let i = 0; i < randomInt(2, 4); i++) {
        messageArea.scrollTop += randomInt(80, 200);
        await sleep(humanDelay(700));
      }
    }

    // 50% chance to actually send
    if (Math.random() < 0.5) {
      await typeText(messageInput, customMessage);

      const sendBtn = document.querySelector('[data-e2e="message-send"]')
        || Array.from(document.querySelectorAll('button')).find(
          b => b.textContent?.trim().toLowerCase() === 'send'
        );

      if (sendBtn) {
        await humanClick(sendBtn);
      } else {
        messageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
      await sleep(humanDelay(300));
      return true;
    }

    return true; // just browsed
  }

  return false;
}

// ─── SEARCH / DISCOVER SIMILAR CREATORS ───────────────────
async function performDiscoverSearch(keywords) {
  if (!keywords || keywords.length === 0) return false;

  const keyword = keywords[randomInt(0, keywords.length - 1)];
  console.log(`[AI Targeting] Searching TikTok for: ${keyword}`);

  // Navigate to search/discover
  const searchBtn = document.querySelector('[data-e2e="search-box"]')
    || document.querySelector('input[type="search"]')
    || document.querySelector('a[href*="/search"]');

  if (searchBtn?.tagName === 'INPUT') {
    await humanClick(searchBtn);
  } else if (searchBtn) {
    await humanClick(searchBtn);
    await sleep(humanDelay(1500));
  } else {
    window.location.href = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
    await sleep(3000);
    return true;
  }

  // Find the search input
  const searchInput = document.querySelector('input[type="search"]')
    || document.querySelector('input[data-e2e="search-user-input"]')
    || document.querySelector('input[placeholder*="Search"]');

  if (!searchInput) return false;

  await humanClick(searchInput);
  await sleep(humanDelay(400));

  // Clear and type
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(humanDelay(300));

  for (const char of keyword) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(searchInput, searchInput.value + char);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(randomInt(50, 180));
  }

  // Submit search
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await sleep(humanDelay(2000));

  // Click "Users" tab if available
  const usersTab = Array.from(document.querySelectorAll('a, button, div[role="tab"]')).find(
    el => el.textContent?.trim().toLowerCase() === 'users'
  );
  if (usersTab) {
    await humanClick(usersTab);
    await sleep(humanDelay(1200));
  }

  return true;
}

// Navigate to a creator from search results
async function performEngageSimilarCreator() {
  const userLinks = document.querySelectorAll('a[href^="/@"]');
  if (userLinks.length === 0) return false;

  const maxIdx = Math.min(userLinks.length - 1, 5);
  const target = userLinks[randomInt(0, maxIdx)];

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(humanDelay(600));

  await humanClick(target);
  await sleep(humanDelay(2500));
  return true;
}

// Like a video on a creator's profile
async function performCreatorLike() {
  // Scroll to see videos
  window.scrollBy({ top: randomInt(200, 400), behavior: 'smooth' });
  await sleep(humanDelay(1000));

  // Click on a video
  const videos = document.querySelectorAll('[data-e2e="user-post-item"] a, div[class*="DivVideoFeed"] a');
  if (videos.length === 0) return false;

  const maxIdx = Math.min(videos.length - 1, 8);
  const target = videos[randomInt(0, maxIdx)];
  await humanClick(target);
  await sleep(humanDelay(2000));

  // Like
  return await performLike();
}

// Follow from creator profile
async function performCreatorFollow() {
  return await performFollow();
}

// Comment on a creator's video
async function performCreatorComment(customMessage) {
  return await performComment(customMessage);
}

// ─── NAVIGATE TO HASHTAG ──────────────────────────────────
async function navigateHashtag(hashtag) {
  if (!hashtag) return false;
  const tag = hashtag.replace(/^#/, '');
  const targetUrl = `https://www.tiktok.com/tag/${tag}`;
  
  if (!window.location.pathname.includes(`/tag/${tag}`)) {
    window.location.href = targetUrl;
    await sleep(3000);
  }
  
  await performScroll();
  return true;
}

// ─── NAVIGATE TO USER PROFILE ─────────────────────────────
async function navigateProfile(username) {
  if (!username) return false;
  const clean = username.replace(/^@/, '');
  
  if (!window.location.pathname.includes(`/@${clean}`)) {
    window.location.href = `https://www.tiktok.com/@${clean}`;
    await sleep(3000);
  }
  
  await performScroll();
  return true;
}

// ─── DM SPECIFIC USERNAME ─────────────────────────────────
async function dmUsername(username, customMessage) {
  if (!username || !customMessage) return false;
  // Navigate to their profile and try to message
  await navigateProfile(username);
  
  // Look for message button
  const messageBtn = Array.from(document.querySelectorAll('button, a')).find(
    el => el.textContent?.trim().toLowerCase().includes('message')
  );
  
  if (messageBtn) {
    await humanClick(messageBtn);
    await sleep(humanDelay(2000));
    
    const messageInput = document.querySelector('div[contenteditable="true"]');
    if (messageInput) {
      await typeText(messageInput, customMessage);
      const sendBtn = Array.from(document.querySelectorAll('button')).find(
        b => b.textContent?.trim().toLowerCase() === 'send'
      );
      if (sendBtn) await humanClick(sendBtn);
      else messageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleep(humanDelay(300));
      return true;
    }
  }
  return false;
}

// ─── MESSAGE LISTENER ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Futnor TikTok] Message received:', msg.type, msg.action);
  
  // Handle ping to check if content script is ready
  if (msg.type === 'PING') {
    console.log('[Futnor TikTok] Ping received, responding ready');
    sendResponse({ ready: true });
    return true;
  }
  
  if (msg.type === 'SESSION_START' || msg.type === 'SESSION_RESUME') {
    sendResponse({ success: true });
    return true;
  }

  // Handle banner commands synchronously
  if (msg.type === 'SHOW_BOT_BANNER') {
    showBotBanner();
    sendResponse({ success: true });
    return;
  }
  if (msg.type === 'HIDE_BOT_BANNER') {
    hideBotBanner();
    sendResponse({ success: true });
    return;
  }
  if (msg.type === 'UPDATE_BANNER') {
    if (typeof futnorBanner !== 'undefined' && !futnorBanner) {
      try { showBotBanner(msg.mode || 'bot'); } catch {}
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
  
  // Handle action commands asynchronously
  if (msg.type !== 'PERFORM_ACTION') return;

  (async () => {
    let success = false;
    console.log('[Futnor TikTok] Executing action:', msg.action);
    
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
        case 'comment':
          success = await performComment(msg.customMessage);
          break;
        case 'dm':
          success = await performDM(msg.customMessage);
          break;
        // Targeting
        case 'navigateHashtag':
          success = await navigateHashtag(msg.keywords?.[0]);
          break;
        case 'navigateProfile':
          success = await navigateProfile(msg.keywords?.[0]);
          break;
        case 'dmUsername':
          success = await dmUsername(msg.keywords?.[0], msg.customMessage);
          break;
        // AI Targeting
        case 'discoverSearch':
          success = await performDiscoverSearch(msg.keywords);
          break;
        case 'engageSimilar':
          success = await performEngageSimilarCreator();
          break;
        case 'creatorLike':
        case 'profileLike':
          success = await performCreatorLike();
          break;
        case 'creatorFollow':
        case 'profileFollow':
          success = await performCreatorFollow();
          break;
        case 'creatorComment':
          success = await performCreatorComment(msg.customMessage);
          break;
        case 'profileDM':
          success = await performDM(msg.customMessage);
          break;
        default:
          console.warn('[Futnor TikTok] Unknown action:', msg.action);
      }
    } catch (error) {
      console.error('[Futnor TikTok] Action failed:', msg.action, error);
      success = false;
    }

    console.log('[Futnor TikTok] Action result:', msg.action, success);
    sendResponse({ success });
  })();

  return true;
});

// ─── "DO NOT CLOSE" BANNER ─────────────────────────────────
let futnorBanner = null;
let bannerStats = { scrolls: 0, likesSent: 0, followsSent: 0, dmsSent: 0 };
let bannerLogs = [];

function updateBannerContent() {
  if (!futnorBanner) return;
  const statsEl = futnorBanner.querySelector('#futnor-banner-stats');
  const logEl = futnorBanner.querySelector('#futnor-banner-log');
  if (statsEl) {
    statsEl.innerHTML = `
      <span style="color:#60a5fa">👁 ${bannerStats.scrolls}</span>
      <span style="color:#f472b6">❤ ${bannerStats.likesSent}</span>
      <span style="color:#a78bfa">👤 ${bannerStats.followsSent}</span>
      <span style="color:#22d3ee">✉ ${bannerStats.dmsSent}</span>
    `;
  }
  if (logEl && bannerLogs.length > 0) {
    logEl.textContent = bannerLogs[0];
  }
}

function showBotBanner() {
  if (futnorBanner) return;
  futnorBanner = document.createElement('div');
  futnorBanner.id = 'futnor-bot-banner';
  futnorBanner.innerHTML = `
    <div style="
      position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-bottom: 2px solid #00ff88; padding: 6px 16px;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 20px rgba(0,255,136,0.15);
      pointer-events: auto; cursor: not-allowed; user-select: none;
    ">
      <div style="display:flex;align-items:center;gap:12px;width:100%;justify-content:center;">
        <span style="
          display:inline-flex;align-items:center;gap:6px;
          background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.3);
          border-radius:20px;padding:3px 10px;font-size:11px;
          font-weight:700;color:#00ff88;text-transform:uppercase;letter-spacing:0.5px;
        ">
          <span style="width:6px;height:6px;border-radius:50%;background:#00ff88;animation:futnorPulse 1.5s infinite"></span>
          Client Engine Active
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
      body { padding-top: 58px !important; }
    </style>
  `;
  document.body.appendChild(futnorBanner);
}

function hideBotBanner() {
  if (futnorBanner) {
    futnorBanner.remove();
    futnorBanner = null;
    document.body.style.paddingTop = '';
    bannerStats = { scrolls: 0, likesSent: 0, followsSent: 0, dmsSent: 0 };
    bannerLogs = [];
  }
}

// ─── Inbox Scanner for Sales Agent ───────────────────────────────────────────

async function scanTikTokInboxForNewDMs() {
  const results = [];
  try {
    // TikTok inbox: look for conversation list items with unread indicators
    const chatItems = document.querySelectorAll('[data-e2e="chat-list-item"], div[class*="ChatListItem"], a[href*="/messages/"]');
    
    for (const item of chatItems) {
      // Check for unread badge (red dot or bold text)
      const unreadBadge = item.querySelector('[class*="badge"], [class*="unread"], [class*="dot"]');
      const boldSpans = item.querySelectorAll('span, p');
      let isBold = false;
      for (const span of boldSpans) {
        const weight = window.getComputedStyle(span).fontWeight;
        if (parseInt(weight) >= 600 || weight === 'bold') {
          isBold = true;
          break;
        }
      }
      
      if (!unreadBadge && !isBold) continue;
      
      // Extract username
      const usernameEl = item.querySelector('[data-e2e="chat-username"], span[class*="UserName"], a[href*="/@"]');
      let username = usernameEl?.textContent?.trim() || '';
      if (!username) {
        const link = item.querySelector('a[href*="/@"]');
        if (link) {
          const match = link.getAttribute('href')?.match(/@([^/?]+)/);
          username = match?.[1] || '';
        }
      }
      if (!username) continue;
      
      // Extract last message preview
      const msgEls = item.querySelectorAll('span, p');
      let lastMessage = '';
      for (const el of msgEls) {
        const text = el.textContent?.trim();
        if (text && text !== username && text.length > 2) {
          lastMessage = text;
        }
      }
      
      const href = item.closest('a')?.getAttribute('href') || item.querySelector('a')?.getAttribute('href') || '';
      results.push({ username, lastMessage, href });
    }
    
    console.log(`[Futnor TikTok] scanInboxForNewDMs: found ${results.length} unread threads`);
  } catch (e) {
    console.error('[Futnor TikTok] scanInboxForNewDMs error:', e);
  }
  return results;
}

// Register sales agent actions
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SALES_AGENT_ACTION') {
    (async () => {
      try {
        switch (msg.action) {
          case 'scanInboxForNewDMs': {
            const threads = await scanTikTokInboxForNewDMs();
            sendResponse({ ok: true, threads });
            break;
          }
          default:
            sendResponse({ ok: false, error: `Unknown sales agent action: ${msg.action}` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// Check if bot is running on load
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (state?.isRunning) showBotBanner();
  console.log('[Futnor TikTok] Content script ready. Bot running:', state?.isRunning);
});

console.log('[Futnor TikTok] Content script loaded and message listener registered ✓');
