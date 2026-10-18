// WhatsApp Web Content Script — Inbox scanner for AI Sales Agent
// Runs on web.whatsapp.com to detect and read incoming DMs

if (!window.__futnorWhatsAppPingRegistered) {
  window.__futnorWhatsAppPingRegistered = true;
  chrome.runtime.onMessage.addListener(function __futnorEarlyPing(msg, sender, sendResponse) {
    if (msg.type === 'PING') {
      sendResponse({ ready: true });
      return true;
    }
  });
  console.log('[Futnor WhatsApp] Early PING handler registered ✓');
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', platform: 'whatsapp' });
  } catch {}
}

if (window.__futnorWhatsAppContentLoaded) {
  console.log('[Futnor WhatsApp] Already loaded, skipping duplicate');
} else {
  window.__futnorWhatsAppContentLoaded = true;

  // ─── Unthrottled timing via background service worker ──────────────────
  // Primary path: route delays through chrome.runtime.sendMessage to the SW.
  // SW setTimeout is NOT subject to tab-visibility throttling (1s minimum on
  // hidden tabs in document context), so the bot keeps full human-simulation
  // speed in background tabs. The SW also bypasses the host page's CSP,
  // which previously broke our Worker-based unthrottling on web.whatsapp.com.
  function __futnorWaBgDelay(ms) {
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

  // ─── Legacy worker fallback (kept for resilience) ──────────────────────
  // Not currently used — sleep() goes straight to bg. Retained as a tested
  // fallback in case the bg-routed path ever needs to be backed out.
  let __futnorWaTimerWorker = null;
  let __futnorWaTimerWorkerProbe = null;
  let __futnorWaTimerSeq = 0;
  const __futnorWaTimerCallbacks = new Map();
  function __futnorWaProbeWorker() {
    if (__futnorWaTimerWorkerProbe) return __futnorWaTimerWorkerProbe;
    __futnorWaTimerWorkerProbe = new Promise((resolve) => {
      let worker = null;
      try {
        const code = `const timers=new Map();self.onmessage=function(e){const{id,ms,cancel,ping}=e.data||{};if(ping){self.postMessage({ping:true});return;}if(cancel){const t=timers.get(id);if(t){clearTimeout(t);timers.delete(id);}return;}const t=setTimeout(()=>{timers.delete(id);self.postMessage({id});},ms);timers.set(id,t);};`;
        worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      } catch (err) {
        console.warn('[Futnor WhatsApp] Worker constructor threw, using setTimeout:', err);
        __futnorWaTimerWorker = null;
        resolve();
        return;
      }
      let settled = false;
      const finalize = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) {
          __futnorWaTimerWorker = worker;
          worker.onmessage = (e) => {
            if (!e.data || e.data.ping) return;
            const cb = __futnorWaTimerCallbacks.get(e.data.id);
            if (cb) { __futnorWaTimerCallbacks.delete(e.data.id); cb(); }
          };
          worker.onerror = null;
          console.log('[Futnor WhatsApp] Timer worker ready');
        } else {
          __futnorWaTimerWorker = null;
          try { worker.terminate(); } catch {}
          console.warn('[Futnor WhatsApp] Timer worker unavailable (likely CSP-blocked), using setTimeout');
        }
        resolve();
      };
      worker.onmessage = (e) => { if (e.data && e.data.ping) finalize(true); };
      worker.onerror = () => finalize(false);
      try { worker.postMessage({ ping: true }); }
      catch { finalize(false); return; }
      setTimeout(() => finalize(false), 1000);
    });
    return __futnorWaTimerWorkerProbe;
  }
  function sleep(ms) {
    return __futnorWaBgDelay(ms);
  }

  const BOT_BANNER_ID = 'futnor-whatsapp-bot-banner';

  function ensureBotBannerStyles() {
    if (document.getElementById(`${BOT_BANNER_ID}-styles`)) return;

    const style = document.createElement('style');
    style.id = `${BOT_BANNER_ID}-styles`;
    style.textContent = `
      #${BOT_BANNER_ID} {
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.92);
        color: #f8fafc;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.28);
        border: 1px solid rgba(34, 197, 94, 0.35);
        font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        backdrop-filter: blur(10px);
        pointer-events: none;
      }

      #${BOT_BANNER_ID}::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #22c55e;
        box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.16);
      }
    `;

    document.documentElement.appendChild(style);
  }

  function showBotBanner(mode = 'sales-agent') {
    ensureBotBannerStyles();

    let banner = document.getElementById(BOT_BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BOT_BANNER_ID;
      document.documentElement.appendChild(banner);
    }

    banner.textContent = mode === 'warmup' ? 'Warm-Up Active' : 'AI Auto-Reply Active';
  }

  function hideBotBanner() {
    document.getElementById(BOT_BANNER_ID)?.remove();
  }

  function normalizeMatchText(value) {
    return (value || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function normalizePhoneToken(value) {
    return (value || '').toString().replace(/[^\d+]/g, '');
  }

  function namesLooselyMatch(a, b) {
    const left = normalizeMatchText(a);
    const right = normalizeMatchText(b);
    if (!left || !right) return false;
    if (left === right || left.includes(right) || right.includes(left)) return true;

    const squashedLeft = left.replace(/\s+/g, '');
    const squashedRight = right.replace(/\s+/g, '');
    if (squashedLeft === squashedRight) return true;

    const leftPhone = normalizePhoneToken(a);
    const rightPhone = normalizePhoneToken(b);
    if (leftPhone && rightPhone) {
      return leftPhone === rightPhone || leftPhone.endsWith(rightPhone) || rightPhone.endsWith(leftPhone);
    }

    return false;
  }

  function matchesNodeOrDescendant(node, selector) {
    if (!node || !selector) return false;
    try {
      return Boolean(node.matches?.(selector) || node.querySelector?.(selector));
    } catch {
      return false;
    }
  }

  function requestBackgroundAction(type, payload = {}, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ success: false, error: 'timeout' }), timeoutMs);
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        clearTimeout(timeout);
        resolve(response || { success: false, error: 'no_response' });
      });
    });
  }

  function isLikelySidebarChatRow(row) {
    if (!row || !document.getElementById('pane-side')?.contains(row)) return false;
    const rect = row.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 40) return false;

    const text = normalizeMatchText(row.textContent);
    if (!text) return false;

    const hasAvatar = !!row.querySelector('img, canvas, [data-testid*="avatar"]');
    const hasRowSemantics = !!row.querySelector('[data-testid="cell-frame-title"], [data-testid="cell-frame-secondary"], span[title], [aria-label]');
    return hasAvatar || hasRowSemantics || text.length > 4;
  }

  function getSidebarChatRows() {
    const paneEl = document.getElementById('pane-side');
    if (!paneEl) return [];

    const selectorStrategies = [
      '[data-testid="cell-frame-container"]',
      '[data-testid^="list-item-"]',
      'div[role="listitem"]',
      'div[role="row"]',
      '[tabindex="-1"]',
    ];

    const rowSelector = selectorStrategies.join(', ');
    const rows = [];
    const seen = new Set();

    const addRow = (candidate) => {
      const row = candidate?.closest?.(rowSelector) || candidate;
      if (!row || seen.has(row) || !isLikelySidebarChatRow(row)) return;
      seen.add(row);
      rows.push(row);
    };

    for (const sel of selectorStrategies) {
      try {
        const found = paneEl.querySelectorAll(sel);
        if (found.length > 0) {
          console.log(`[Futnor WhatsApp] Selector "${sel}" matched ${found.length} elements`);
          found.forEach(addRow);
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }

    if (rows.length === 0) {
      const scrollContainer = paneEl.querySelector('[role="grid"], [role="list"], [data-testid="chat-list"]') || paneEl;
      const deepDivs = scrollContainer.querySelectorAll('div[style*="transform"], div[style*="height"]');
      console.log(`[Futnor WhatsApp] Fallback deep divs: ${deepDivs.length}`);
      deepDivs.forEach(addRow);
    }

    return rows;
  }

  function findBestSidebarRow(contactName, messageHint = '') {
    const rows = getSidebarChatRows();
    const normalizedHint = normalizeMatchText(messageHint);
    let best = null;
    let bestScore = -1;

    for (const row of rows) {
      const rowName = extractContactName(row);
      const rowMessage = extractLastMessage(row);
      if (!rowName && !rowMessage) continue;

      let score = 0;
      if (namesLooselyMatch(rowName, contactName)) score += 100;

      const normalizedRowMessage = normalizeMatchText(rowMessage);
      if (normalizedHint && normalizedRowMessage) {
        if (normalizedRowMessage === normalizedHint) score += 40;
        else if (normalizedRowMessage.includes(normalizedHint) || normalizedHint.includes(normalizedRowMessage)) score += 25;
      }

      if (detectUnread(row)) score += 10;

      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }

    return bestScore >= 60 ? best : null;
  }


  function getActiveChatName() {
    const selectors = [
      '#main header span[title]',
      '#main header [data-testid="conversation-info-header-chat-title"]',
      '#main header h1 span',
      '#main header div[role="button"] span[dir="auto"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const name = el?.getAttribute?.('title')?.trim?.() || el?.textContent?.trim?.() || '';
      if (name && name.length < 120) return name;
    }

    return '';
  }

  function getChatMessageNodes() {
    const selectors = [
      '#main div[data-testid="msg-container"]',
      '#main div[data-testid="message-container"]',
      '#main div[role="row"]',
    ];

    let nodes = [];
    for (const sel of selectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > nodes.length) nodes = found;
    }

    return nodes;
  }

  function extractMessageTextFromNode(node) {
    if (!node) return '';

    const textSelectors = [
      '[data-testid="msg-text"]',
      '[data-testid="conversation-text-message"]',
      'span.selectable-text',
      'div[dir="auto"] span',
    ];

    for (const sel of textSelectors) {
      const el = node.querySelector(sel);
      const msg = el?.textContent?.trim() || '';
      if (msg) return msg;
    }

    return '';
  }

  function getLatestIncomingMessage() {
    const nodes = getChatMessageNodes();

    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const outgoing = matchesNodeOrDescendant(node, '[data-testid="msg-out"], [data-testid="outgoing-message"]');
      if (outgoing) continue;

      const msg = extractMessageTextFromNode(node);
      if (msg) {
        const fingerprint = node.getAttribute('data-id') || node.getAttribute('data-testid') || msg;
        return { text: msg, fingerprint };
      }
    }

    return null;
  }

  function getLatestOutgoingMessage() {
    const nodes = getChatMessageNodes();

    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const outgoing = matchesNodeOrDescendant(node, '[data-testid="msg-out"], [data-testid="outgoing-message"]');
      if (!outgoing) continue;

      const msg = extractMessageTextFromNode(node);
      if (msg) {
        const fingerprint = node.getAttribute('data-id') || node.getAttribute('data-testid') || msg;
        return { text: msg, fingerprint };
      }
    }

    return null;
  }

  function getComposer() {
    const composerSelectors = [
      'div[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '#main footer div[contenteditable="true"]',
      '#main div[contenteditable="true"]',
    ];

    for (const sel of composerSelectors) {
      const composer = document.querySelector(sel);
      if (!composer) continue;

      const rect = composer.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 18) continue;

      const aria = (composer.getAttribute('aria-label') || composer.getAttribute('title') || '').toLowerCase();
      const placeholder = (composer.getAttribute('data-placeholder') || composer.getAttribute('placeholder') || '').toLowerCase();
      if (aria.includes('search') || placeholder.includes('search') || aria.includes('buscar') || placeholder.includes('buscar') || aria.includes('rechercher') || placeholder.includes('rechercher')) continue;

      return composer;
    }

    return null;
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
      const searchBox = document.querySelector(sel);
      if (!searchBox) continue;
      const rect = searchBox.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 18) continue;
      if (searchBox.closest('#main footer, #main [data-testid="conversation-compose-box-input"], #main div[role="textbox"]')) continue;

      const meta = [
        searchBox.getAttribute('aria-label') || '',
        searchBox.getAttribute('title') || '',
        searchBox.getAttribute('data-placeholder') || '',
        searchBox.getAttribute('placeholder') || '',
        searchBox.closest('[data-testid]')?.getAttribute('data-testid') || '',
      ].join(' ').toLowerCase();

      const looksLikeSearch =
        sel.includes('chat-list-search') ||
        meta.includes('search') ||
        meta.includes('buscar') ||
        meta.includes('rechercher') ||
        meta.includes('chat-list-search');

      if (!looksLikeSearch && !searchBox.closest('#side')) continue;
      return searchBox;
    }

    return null;
  }

  function activateElement(node) {
    const target = node?.closest?.('button, [role="button"], [tabindex]') || node;
    if (!target) return false;

    try { target.focus?.({ preventScroll: true }); } catch {}

    const pointerOpts = { bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1 };
    const mouseOpts = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };

    try { target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts)); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch {}
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...pointerOpts, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, view: window })); } catch {}
    try { target.click?.(); } catch {}
    return true;
  }

  function dismissSearchUi() {
    const escapeOpts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    document.dispatchEvent(new KeyboardEvent('keydown', escapeOpts));
    document.dispatchEvent(new KeyboardEvent('keyup', { ...escapeOpts, cancelable: false }));
  }

  function composerContainsMessage(composer, message) {
    const current = normalizeMatchText(composer?.textContent || '');
    const target = normalizeMatchText(message);
    if (!current || !target) return false;
    return current === target || current.includes(target) || target.includes(current);
  }

  function focusComposerEnd(composer) {
    composer.focus();
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clearComposer(composer) {
    focusComposerEnd(composer);

    try {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } catch {}

    composer.textContent = '';
    composer.innerHTML = '';
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  }

  function setComposerText(composer, message) {
    clearComposer(composer);
    focusComposerEnd(composer);

    try {
      document.execCommand('insertText', false, message);
    } catch {}

    if (composerContainsMessage(composer, message)) return true;

    composer.innerHTML = '';
    const lines = message.split(/\n/);
    lines.forEach((line, index) => {
      if (index > 0) composer.appendChild(document.createElement('br'));
      composer.appendChild(document.createTextNode(line));
    });

    focusComposerEnd(composer);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    return composerContainsMessage(composer, message);
  }

  function clickSendButton() {
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

    for (const sel of sendSelectors) {
      const sendBtn = document.querySelector(sel);
      if (!sendBtn) continue;

      return activateElement(sendBtn);
    }

    return false;
  }

  function pressComposerEnter(composer) {
    focusComposerEnd(composer);
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      composer.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    });
  }

  async function waitForChatOpen(contactName, messageHint = '', timeoutMs = 7000) {
    const start = Date.now();
    const normalizedHint = normalizeMatchText(messageHint);

    while (Date.now() - start < timeoutMs) {
      const activeName = getActiveChatName();
      if (namesLooselyMatch(activeName, contactName)) return true;

      const composer = getComposer();
      const latestIncoming = getLatestIncomingMessage();
      if (composer && normalizedHint) {
        const activeMessage = normalizeMatchText(latestIncoming?.text || '');
        if (activeMessage && (activeMessage === normalizedHint || activeMessage.includes(normalizedHint) || normalizedHint.includes(activeMessage))) {
          return true;
        }
      }

      if (composer && !normalizedHint && activeName) {
        return true;
      }

      await sleep(200);
    }

    return false;
  }

  async function waitForMessageSend(message, previousFingerprint, timeoutMs = 5000) {
    const expected = normalizeMatchText(message);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const latestOutgoing = getLatestOutgoingMessage();
      const outgoingText = normalizeMatchText(latestOutgoing?.text || '');
      const composer = getComposer();
      const composerText = normalizeMatchText(composer?.textContent || '');
      const fingerprintChanged = !!latestOutgoing?.fingerprint && latestOutgoing.fingerprint !== previousFingerprint;
      const textMatched = !!expected && !!outgoingText && (outgoingText === expected || outgoingText.includes(expected) || expected.includes(outgoingText));

      if (fingerprintChanged || textMatched) return true;
      if (!composerText && fingerprintChanged) return true;

      await sleep(250);
    }

    return false;
  }

  function getOpenChatUnreadThread() {
    const username = getActiveChatName();
    const latestIncoming = getLatestIncomingMessage();
    const latestOutgoing = getLatestOutgoingMessage();
    if (!username || !latestIncoming?.text) return null;

    // Only respond if the last message is incoming (we haven't replied yet)
    const lastIsIncoming = !latestOutgoing ||
      latestIncoming.fingerprint !== latestOutgoing.fingerprint;
    if (!lastIsIncoming) return null;

    return {
      username,
      lastMessage: latestIncoming.text,
      unreadCount: 1,
      messageFingerprint: latestIncoming.fingerprint,
      source: 'open-chat',
    };
  }

  /**
   * Scans WhatsApp Web sidebar for unread conversations.
   * Returns array of { username, lastMessage, unreadCount }
   */
  async function scanWhatsAppInboxForNewDMs() {
    const results = [];
    try {
      console.log('[Futnor WhatsApp] === Starting inbox scan ===');

      // Wait a moment for DOM to be ready
      await sleep(500);

      // Check if WhatsApp Web is loaded
      const app = document.getElementById('app');
      const paneEl = document.getElementById('pane-side');
      console.log(`[Futnor WhatsApp] DOM check: #app=${!!app}, #pane-side=${!!paneEl}`);

      if (!paneEl) {
        // Maybe still loading - check for QR code or loading screen
        const startup = document.querySelector('[data-testid="intro-md-beta-logo-dark"], [data-testid="qrcode"], .landing-wrapper, ._1jJ70');
        console.log('[Futnor WhatsApp] pane-side not found. Loading/QR screen:', !!startup);
        console.log('[Futnor WhatsApp] Body children:', document.body?.children?.length);
        return results;
      }

      const chatRows = getSidebarChatRows();

      console.log(`[Futnor WhatsApp] Total filtered chat row candidates: ${chatRows.length}`);

      // Debug: log all data-testid values in pane-side
      if (chatRows.length === 0) {
        const testIds = new Set();
        paneEl.querySelectorAll('[data-testid]').forEach(el => testIds.add(el.getAttribute('data-testid')));
        console.log('[Futnor WhatsApp] data-testid values in pane-side:', JSON.stringify([...testIds].slice(0, 20)));
        
        const roles = new Set();
        paneEl.querySelectorAll('[role]').forEach(el => roles.add(el.getAttribute('role')));
        console.log('[Futnor WhatsApp] role values in pane-side:', JSON.stringify([...roles]));
      }

      // For each chat row, check for unread indicators
      for (const row of chatRows) {
        const unreadInfo = detectUnread(row);
        if (!unreadInfo) continue;

        const username = extractContactName(row);
        if (!username) continue;

        const lastMessage = extractLastMessage(row);

        results.push({
          username,
          lastMessage: lastMessage || '',
          unreadCount: unreadInfo.count,
          messageFingerprint: `${username}::${lastMessage || ''}::${unreadInfo.count}`,
          source: 'sidebar',
        });
        console.log(`[Futnor WhatsApp] ✅ Unread: "${username}" (${unreadInfo.count}) — "${(lastMessage || '').substring(0, 40)}"`);
      }

      const openChatThread = getOpenChatUnreadThread();
      if (openChatThread) {
        const exists = results.some((thread) => thread.username === openChatThread.username && thread.lastMessage === openChatThread.lastMessage);
        if (!exists) {
          results.push(openChatThread);
          console.log(`[Futnor WhatsApp] ✅ Active chat incoming: "${openChatThread.username}" — "${openChatThread.lastMessage.substring(0, 40)}"`);
        }
      }

      console.log(`[Futnor WhatsApp] === Scan complete: ${results.length} unread out of ${chatRows.length} rows ===`);
    } catch (e) {
      console.error('[Futnor WhatsApp] scanInbox error:', e);
    }
    return results;
  }

  /**
   * Detects unread badge in a chat row element.
   * Returns { count: number } or null if not unread.
   */
  function detectUnread(row) {
    // Strategy 1: data-testid based
    const testIdBadges = [
      'span[data-testid="icon-unread-count"]',
      'span[data-icon="unread-count"]',
      '[data-testid="unread-count"]',
    ];
    for (const sel of testIdBadges) {
      const el = row.querySelector(sel);
      if (el) {
        const count = parseInt(el.textContent?.trim()) || 1;
        return { count };
      }
    }

    // Strategy 2: aria-label based
    const ariaUnread = row.querySelector('[aria-label*="unread" i], [aria-label*="non lu" i], [aria-label*="no leído" i]');
    if (ariaUnread) {
      const match = ariaUnread.getAttribute('aria-label')?.match(/(\d+)/);
      return { count: match ? parseInt(match[1]) : 1 };
    }

    // Strategy 3: Find small circular badge with a number (most reliable visual check)
    const allSpans = row.querySelectorAll('span');
    for (const span of allSpans) {
      const text = span.textContent?.trim();
      if (!text || !/^\d+$/.test(text)) continue;

      // Check if it looks like a badge (small, colored background)
      const rect = span.getBoundingClientRect();
      if (rect.width > 40 || rect.height > 40 || rect.width < 5) continue;

      const style = window.getComputedStyle(span);
      const parent = span.parentElement;
      const parentStyle = parent ? window.getComputedStyle(parent) : null;

      // Check for colored background (green badge) on span or parent
      const bgColor = style.backgroundColor || '';
      const parentBg = parentStyle?.backgroundColor || '';
      const borderRadius = style.borderRadius || parentStyle?.borderRadius || '';

      // Green-ish or any non-transparent colored background with rounded shape
      const hasColoredBg = (bg) => bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)';
      const isRounded = borderRadius.includes('50%') || parseInt(borderRadius) > 8;

      if ((hasColoredBg(bgColor) || hasColoredBg(parentBg)) && isRounded) {
        return { count: parseInt(text) };
      }

      // Also check if the element or parent has specific class patterns
      const classes = (span.className + ' ' + (parent?.className || '')).toLowerCase();
      if (classes.includes('unread') || classes.includes('badge') || classes.includes('_ahlk')) {
        return { count: parseInt(text) };
      }
    }

    // Strategy 4: Check for the green dot (no number, just indicator)
    const circles = row.querySelectorAll('span, div');
    for (const el of circles) {
      if (el.children.length > 0) continue; // only leaf nodes
      if (el.textContent?.trim()) continue; // skip if has text content (not a dot)
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.width > 20 || rect.height < 5 || rect.height > 20) continue;
      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor;
      // Green-ish indicator
      if (bg && (bg.includes('25, 209') || bg.includes('0, 128') || bg.includes('37, 211') || bg.includes('0, 200'))) {
        return { count: 1 };
      }
    }

    // Strategy 5: WhatsApp Web current class-based badge (2025+)
    const modernBadge = row.querySelector('span._ahzt, span._aiq7, [class*="unread-count"], span[data-testid="unread-count"]');
    if (modernBadge) {
      const count = parseInt(modernBadge.textContent?.trim()) || 1;
      return { count };
    }

    // Strategy 6: any small rounded span with a number inside the row's right section
    const rightSection = row.querySelector('div:last-child');
    if (rightSection) {
      const spans = rightSection.querySelectorAll('span');
      for (const s of spans) {
        const t = s.textContent?.trim();
        if (t && /^\d+$/.test(t) && parseInt(t) > 0) {
          return { count: parseInt(t) };
        }
      }
    }

    return null;
  }

  /**
   * Extracts contact/group name from a chat row.
   */
  function extractContactName(row) {
    const nameSelectors = [
      'span[data-testid="cell-frame-title"] span',
      '[data-testid="cell-frame-title"] span[dir]',
      'span[title][dir="auto"]',
      'div[data-testid="cell-frame-title"] span',
    ];

    for (const sel of nameSelectors) {
      const el = row.querySelector(sel);
      if (el) {
        const name = el.textContent?.trim() || el.getAttribute('title')?.trim();
        if (name && name.length > 0 && name.length < 100) return name;
      }
    }

    // Fallback: any span with a title attribute
    const titledSpans = row.querySelectorAll('span[title]');
    for (const s of titledSpans) {
      const t = s.getAttribute('title')?.trim();
      if (t && t.length > 0 && t.length < 100) return t;
    }

    const lastMessage = normalizeMatchText(extractLastMessage(row));
    const candidates = Array.from(row.querySelectorAll('span, div'))
      .map((el) => (el.getAttribute?.('title')?.trim() || el.textContent?.trim() || ''))
      .filter(Boolean);

    for (const candidate of candidates) {
      const normalized = normalizeMatchText(candidate);
      if (!normalized || normalized === lastMessage) continue;
      if (/^(all|unread|favourites|groups|labels|yesterday|today)$/i.test(candidate)) continue;
      if (/^\d+$/.test(candidate)) continue;
      if (/^\d{1,2}:\d{2}$/.test(candidate)) continue;
      if (candidate.length > 100) continue;
      return candidate;
    }

    return '';
  }

  /**
   * Extracts last message preview from a chat row.
   */
  function extractLastMessage(row) {
    const msgSelectors = [
      'span[data-testid="last-msg-status"] span',
      'div[data-testid="cell-frame-secondary"] span[dir="ltr"]',
      'div[data-testid="cell-frame-secondary"] span[dir]',
      'div[data-testid="cell-frame-secondary"] span',
      'span[title][class*="matched-text"]',
    ];

    for (const sel of msgSelectors) {
      const el = row.querySelector(sel);
      if (el) {
        const msg = el.textContent?.trim();
        if (msg) return msg;
      }
    }
    return '';
  }

  /**
   * Types and sends a message in the currently active WhatsApp chat.
   */
  async function sendWhatsAppMessage(message) {
    try {
      let composer = getComposer();

      if (!composer) {
        console.error('[Futnor WhatsApp] Composer not found');
        return { ok: false, error: 'Composer not found' };
      }

      const previousOutgoing = getLatestOutgoingMessage();

      const injected = await requestBackgroundAction('INJECT_EXECCOMMAND', { text: message }, 7000);

      composer = getComposer() || composer;
      if (!composer || !composerContainsMessage(composer, message)) {
        if (!composer || !setComposerText(composer, message)) {
          console.error('[Futnor WhatsApp] Failed to insert message into composer');
          return { ok: false, error: injected?.error || 'Composer text injection failed' };
        }
      }

      await sleep(250);

      const previousFingerprint = previousOutgoing?.fingerprint || '';
      const sendAttempts = [
        async () => requestBackgroundAction('INJECT_WHATSAPP_SEND', { message }, 5000),
        async () => ({ success: clickSendButton(), error: 'send_button_not_found' }),
        async () => requestBackgroundAction('INJECT_ENTER_KEY', {}, 5000),
        async () => {
          composer = getComposer() || composer;
          if (!composer) return { success: false, error: 'composer_missing_before_enter' };
          console.log('[Futnor WhatsApp] Triggering local Enter fallback');
          pressComposerEnter(composer);
          return { success: true, via: 'local-enter' };
        },
        async () => requestBackgroundAction('INJECT_WHATSAPP_SEND', { message }, 5000),
      ];

      for (const attempt of sendAttempts) {
        const sendTriggered = await attempt();
        if (!sendTriggered?.success) continue;

        const sent = await waitForMessageSend(message, previousFingerprint, 4500);
        if (sent) {
          console.log('[Futnor WhatsApp] Message send verified');
          return { ok: true };
        }

        await sleep(250);
      }

      console.error('[Futnor WhatsApp] Send triggered but delivery could not be verified');
      return { ok: false, error: 'Message send could not be verified' };
    } catch (e) {
      console.error('[Futnor WhatsApp] sendMessage error:', e);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Opens a specific chat by clicking on it in the sidebar.
   */
  async function openWhatsAppChat(contactName, messageHint = '') {
    try {
      console.log(`[Futnor WhatsApp] Opening chat: "${contactName}"`);

      if (namesLooselyMatch(getActiveChatName(), contactName)) {
        console.log(`[Futnor WhatsApp] Chat already active for: "${contactName}"`);
        return { ok: true };
      }

      const visibleMatch = findBestSidebarRow(contactName, messageHint);
      if (visibleMatch) {
        activateElement(visibleMatch);
        const opened = await waitForChatOpen(contactName, messageHint);
        if (opened) {
          console.log(`[Futnor WhatsApp] Opened visible chat match for: "${contactName}"`);
          return { ok: true };
        }
      }
      
      // Try using search
      let searchBox = getSearchBox();

      if (searchBox) {
        const searchInjected = await requestBackgroundAction('INJECT_WHATSAPP_SEARCH', { text: contactName }, 5000);
        if (!searchInjected?.success) {
          searchBox.focus();
          await sleep(300);
          document.execCommand('selectAll');
          document.execCommand('delete');
          await sleep(200);
          document.execCommand('insertText', false, contactName);
        }
        await sleep(2000);

        const matchedRow = findBestSidebarRow(contactName, messageHint);
        if (matchedRow) {
          activateElement(matchedRow);
          const opened = await waitForChatOpen(contactName, messageHint);
          dismissSearchUi();
          if (opened) {
            console.log(`[Futnor WhatsApp] Opened chat via search for: "${contactName}"`);
            return { ok: true };
          }
        }

        dismissSearchUi();
      }

      // Fallback: scan sidebar directly
      const sidebarMatch = findBestSidebarRow(contactName, messageHint);
      if (sidebarMatch) {
        activateElement(sidebarMatch);
        const opened = await waitForChatOpen(contactName, messageHint);
        if (opened) {
          console.log(`[Futnor WhatsApp] Opened chat (sidebar fallback): "${contactName}"`);
          return { ok: true };
        }
      }
      
      console.log(`[Futnor WhatsApp] Chat not found: "${contactName}"`);
      return { ok: false, error: 'Chat not found' };
    } catch (e) {
      console.error('[Futnor WhatsApp] openChat error:', e);
      return { ok: false, error: e.message };
    }
  }

  // Message listener for sales agent actions
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ready: true });
      return true;
    }

    if (msg.type === 'SHOW_BOT_BANNER') {
      showBotBanner(msg.mode || 'sales-agent');
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'HIDE_BOT_BANNER') {
      hideBotBanner();
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'SALES_AGENT_ACTION') {
      console.log(`[Futnor WhatsApp] Received action: ${msg.action}`);
      (async () => {
        try {
          switch (msg.action) {
            case 'scanInboxForNewDMs': {
              const threads = await scanWhatsAppInboxForNewDMs();
              sendResponse({ ok: true, threads });
              break;
            }
            case 'openChat': {
              const result = await openWhatsAppChat(msg.contactName, msg.messageHint);
              sendResponse(result);
              break;
            }
            case 'sendMessage': {
              const result = await sendWhatsAppMessage(msg.message);
              sendResponse(result);
              break;
            }
            default:
              sendResponse({ ok: false, error: `Unknown action: ${msg.action}` });
          }
        } catch (e) {
          console.error('[Futnor WhatsApp] Action error:', e);
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    if (msg.type === 'PERFORM_ACTION' && msg.action === 'dm') {
      (async () => {
        const result = await sendWhatsAppMessage(msg.customMessage || '');
        sendResponse({ status: result.ok ? 'dm_sent' : 'dm_failed' });
      })();
      return true;
    }
  });

  try {
    chrome.storage.local.get('futnor_sales_agent_config', ({ futnor_sales_agent_config }) => {
      if (futnor_sales_agent_config?.active) {
        showBotBanner('sales-agent');
      }
    });
  } catch {}

  console.log('[Futnor WhatsApp] Content script loaded ✓');
}
