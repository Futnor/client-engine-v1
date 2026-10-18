export type WarmupAction =
  | 'scroll_feed'
  | 'scroll_explore'
  | 'view_story'
  | 'like_post'
  | 'pause'
  | 'read_comments'
  | 'scroll_back';

export interface WarmupConfig {
  sessionMinutes: number;
  platform: 'instagram' | 'tiktok';
}

export const DEFAULT_WARMUP_SESSION = 20; // minutes — realistic human session

// Chaotic weighted pool — reels removed, feed & explore boosted
const ACTION_POOL: { action: WarmupAction; weight: number }[] = [
  { action: 'scroll_feed', weight: 30 },
  { action: 'scroll_explore', weight: 25 },
  { action: 'view_story', weight: 12 },
  { action: 'like_post', weight: 12 },
  { action: 'pause', weight: 8 },
  { action: 'read_comments', weight: 8 },
  { action: 'scroll_back', weight: 5 },
];

// Prevents repeating the same action consecutively
let lastAction: WarmupAction | null = null;
let recentActions: WarmupAction[] = [];

export function pickChaosAction(): WarmupAction {
  // Filter out last action to avoid patterns
  const available = ACTION_POOL.filter(a => a.action !== lastAction);

  // Further reduce weight of recently repeated actions
  const weighted = available.map(a => {
    const recentCount = recentActions.filter(r => r === a.action).length;
    const dampening = Math.max(0.2, 1 - recentCount * 0.3);
    return { ...a, weight: a.weight * dampening };
  });

  const total = weighted.reduce((s, a) => s + a.weight, 0);
  let rand = Math.random() * total;

  for (const item of weighted) {
    rand -= item.weight;
    if (rand <= 0) {
      lastAction = item.action;
      recentActions.push(item.action);
      if (recentActions.length > 6) recentActions.shift();
      return item.action;
    }
  }

  return 'scroll_feed';
}

// Chaotic delay — varies widely to mimic real humans
export function getChaosDelay(): number {
  const base = 2000 + Math.random() * 8000; // 2-10s base
  const jitter = (Math.random() - 0.5) * 4000; // ±2s jitter
  const longPause = Math.random() < 0.12 ? 5000 + Math.random() * 10000 : 0; // 12% chance of long pause
  return Math.max(1500, base + jitter + longPause);
}

export function resetChaosState() {
  lastAction = null;
  recentActions = [];
}

export function getActionLabel(action: WarmupAction): string {
  const labels: Record<WarmupAction, string> = {
    scroll_feed: '📜 Scrolling feed',
    scroll_explore: '🔍 Browsing explore page',
    view_story: '👁️ Viewing stories',
    like_post: '❤️ Liked a post',
    pause: '⏸️ Taking a break...',
    read_comments: '💬 Reading comments',
    scroll_back: '↩️ Scrolling back up',
  };
  return labels[action];
}

export function getActionIcon(action: WarmupAction): string {
  const icons: Record<WarmupAction, string> = {
    scroll_feed: 'scroll',
    scroll_explore: 'search',
    view_story: 'eye',
    like_post: 'heart',
    pause: 'coffee',
    read_comments: 'message-circle',
    scroll_back: 'arrow-up',
  };
  return icons[action];
}
