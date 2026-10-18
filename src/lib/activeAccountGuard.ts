// ─── Active-Account Guard ────────────────────────────────────────────────────
//
// Background:
//   The extension's dashboard bridge writes the *currently visible Instagram
//   page's URL slug* into `localStorage.futnor_active_account` so the dashboard
//   knows which IG account the user is logged in as. That works fine on a
//   profile page (`instagram.com/futnor03/`) but breaks on non-profile pages —
//   when the bot navigates to `/notifications`, `/explore`, `/reels`, etc.
//   during a warm-up or browse loop, the bridge writes those words as if they
//   were usernames. AccountHealthScore then displays "@notifications" and
//   queries Supabase for that bogus account, returning empty data.
//
//   This was reported after v2.4.92's warm-up overhaul added passive
//   `warmupCheckNotifications` / `warmupCheckInbox` / `warmupBrowseSearch`
//   actions, which navigate to those reserved paths.
//
// Strategy (dashboard-only, does NOT require shipping a new extension):
//   1. Maintain a separate `futnor_active_account_trusted` key that ONLY ever
//      holds a non-reserved username.
//   2. Poll `futnor_active_account` every 250ms. If the current value is
//      reserved (or empty), restore it from the trusted cache. If it's a
//      legitimate username, mirror it to the trusted cache.
//   3. Also listen for storage events to catch cross-tab updates immediately.
//
//   With this guard installed, every existing consumer that reads
//   `futnor_active_account` automatically sees the corrected value — no
//   changes needed in AccountHealthScore, useBotSession, ScriptBulkManager,
//   etc.
//
// This file is the only place the IG reserved-path list needs to live.

// Instagram's top-level URL slugs that are NOT user profiles. The bot
// navigates to many of these during warm-up and engagement actions.
const IG_RESERVED_PATHS = new Set([
  // Bot-driven warm-up / engagement destinations (the immediate cause)
  'notifications',
  'explore',
  'reels',
  'direct',
  'inbox',
  'stories',
  'saved',
  // Generic IG routes (any of these could appear if the bot drifts)
  'accounts',
  'p',
  'tv',
  'live',
  'about',
  'developer',
  'search',
  'help',
  'legal',
  'press',
  'api',
  'jobs',
  'privacy',
  'terms',
  'locations',
  'hashtag',
  'web',
  'login',
  'signup',
  'oauth',
  'session',
  'challenge',
  'auth_platform',
  'create',
  'edit',
  'emails',
  'partnerships',
  'requests',
  'invites',
  'shopping',
  'ads',
  'business',
  'creator',
  'tags',
  // Common Instagram-internal slugs that look username-shaped
  'igtv',
  'home',
  'feed',
  'activity',
  'settings',
]);

const ACTIVE_KEY = 'futnor_active_account';
const TRUSTED_KEY = 'futnor_active_account_trusted';

function normalize(value: string | null | undefined): string {
  return (value || '').toString().toLowerCase().replace(/^@/, '').trim();
}

function isReserved(value: string): boolean {
  if (!value) return true;
  // Strip any trailing slug segments — "notifications/foo" should still match.
  const head = value.split('/')[0];
  if (IG_RESERVED_PATHS.has(head)) return true;
  // Anything with non-username characters (slashes, query strings, dots that
  // aren't part of a real handle) is suspicious.
  if (!/^[a-z0-9._]{1,30}$/.test(head)) return true;
  return false;
}

function readRaw(): string {
  try {
    return normalize(localStorage.getItem(ACTIVE_KEY));
  } catch {
    return '';
  }
}

function readTrusted(): string {
  try {
    return normalize(localStorage.getItem(TRUSTED_KEY));
  } catch {
    return '';
  }
}

function writeActive(value: string) {
  try {
    if (value) localStorage.setItem(ACTIVE_KEY, value);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

function writeTrusted(value: string) {
  try {
    if (value) localStorage.setItem(TRUSTED_KEY, value);
  } catch {}
}

let installed = false;

/** Install the guard. Idempotent — calling twice is a no-op. */
export function installActiveAccountGuard(): () => void {
  if (installed) return () => {};
  installed = true;

  const tick = () => {
    const raw = readRaw();
    const trusted = readTrusted();

    if (!raw) {
      // Active was cleared by something. Restore from trusted if we have one.
      if (trusted) writeActive(trusted);
      return;
    }

    if (isReserved(raw)) {
      // The bridge wrote a reserved-path value (e.g. "notifications" while the
      // bot is on /notifications/ during warm-up). DON'T let downstream React
      // components see it — restore the previously trusted username.
      if (trusted && trusted !== raw) {
        writeActive(trusted);
        // Optional: log once per minute so the user can see it's working.
        // Keep it terse so the console doesn't fill up the way it did
        // pre-fix.
        if (Math.random() < 0.02) {
          console.log(
            `[Futnor Guard] Ignored bogus active_account "${raw}" — restored "${trusted}"`,
          );
        }
      } else {
        // No trusted value yet — best we can do is clear the bogus one so
        // downstream code falls into its "no account" state instead of
        // querying Supabase for "@notifications".
        writeActive('');
      }
      return;
    }

    // raw is a real-looking username. Sync it to trusted.
    if (raw !== trusted) writeTrusted(raw);
  };

  // Run once immediately so first paint is correct.
  tick();

  // Poll every 250ms. The extension bridge writes only happen on URL changes,
  // so this is plenty fast and very cheap.
  const interval = window.setInterval(tick, 250);

  // Also react to cross-tab storage events for instant updates.
  const onStorage = (e: StorageEvent) => {
    if (e.key === ACTIVE_KEY || e.key === TRUSTED_KEY) tick();
  };
  window.addEventListener('storage', onStorage);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener('storage', onStorage);
    installed = false;
  };
}
