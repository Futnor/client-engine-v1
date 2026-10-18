export type Platform = 'instagram' | 'tiktok';
export type DmMode = 'human' | 'manual';

export type TargetType = 'followers' | 'following' | 'likers' | 'commenters' | 'hashtags' | 'location' | 'custom';

export interface TargetingConfig {
  targetTypes: TargetType[];
  hashtags: string;
  location: string;
  targetUsername: string;
  targetPostLink: string;
  customUsernames: string[];
  publicAccountsOnly: boolean;
  includePrivateAccounts: boolean;
  includeBusinessAccounts: boolean;
  includeNewAccounts: boolean;
  includeVerifiedAccounts: boolean;
  filterFollowersEnabled: boolean;
  filterFollowersMin: number;
  filterFollowersMax: number;
  filterPostsEnabled: boolean;
  filterPostsMin: number;
  filterPostsMax: number;
  filterGenderEnabled: boolean;
  filterGender: 'any' | 'male' | 'female';
  filterAgeEnabled: boolean;
  filterAgeMin: number;
  filterAgeMax: number;
  commenterNetworkLoop: boolean;
  allowExistingChats: boolean;
}

export const defaultTargeting: TargetingConfig = {
  targetTypes: ['followers'],
  hashtags: '',
  location: '',
  targetUsername: '',
  targetPostLink: '',
  customUsernames: [],
  publicAccountsOnly: true,
  includePrivateAccounts: false,
  includeBusinessAccounts: false,
  includeNewAccounts: false,
  includeVerifiedAccounts: false,
  filterFollowersEnabled: false,
  filterFollowersMin: 100,
  filterFollowersMax: 50000,
  filterPostsEnabled: false,
  filterPostsMin: 5,
  filterPostsMax: 5000,
  filterGenderEnabled: false,
  filterGender: 'any',
  filterAgeEnabled: false,
  filterAgeMin: 18,
  filterAgeMax: 65,
  // v2.4.139: default to TRUE. User reported "bot aborts session after
  // it sends DM" — after processing the original post's commenters,
  // the bot was hitting "Commenters from target post processed (network
  // loop disabled)" and ending. With loop ON, after exhausting the
  // initial commenter list the bot expands to commenters of DM'd users'
  // posts, giving sustained throughput per session.
  commenterNetworkLoop: true,
  // v2.4.116: default to TRUE. User reported the bot was skipping every
  // target whose thread had any prior message — confirmThreadFreshness
  // returns 'existing' even for stale message-requests and short threads
  // the user has long since abandoned. Skipping all of them was
  // crippling the inbox/likers flow on the /direct/inbox full-page UI.
  // Users who specifically want to PROTECT existing conversations can
  // still turn this off in the targeting panel.
  allowExistingChats: true,
};

export interface AITargetingData {
  enabled: boolean;
  keywords: string[];
  contentTags: string[];
  targetAudience: string;
  searchTerms: string[];
}

export const defaultAITargeting: AITargetingData = {
  enabled: false,
  keywords: [],
  contentTags: [],
  targetAudience: '',
  searchTerms: [],
};

export interface EngagementMonitorConfig {
  enabled: boolean;
  postUrl: string;
  postUrls: string[];
  triggerKeywords: string[];
  commentToDm: boolean;
  likeToDm: boolean;
  followToDm: boolean;
  dmScript: string;
  /**
   * Fast-mode for ads / time-sensitive launches. When true, the monitor scans
   * every 3–6 seconds (instead of the default 15–25 s) so a comment on a
   * Click-to-DM ad is responded to in seconds. Use only for paid ads or
   * launches; sustained use on organic posts may attract detection.
   */
  fastMode?: boolean;
  /**
   * When true (default), the monitor scans EVERY post URL every cycle so
   * comments on any post are caught quickly. When false, falls back to the
   * legacy round-robin (one post per cycle).
   */
  scanAllPosts?: boolean;
}

export const defaultEngagementMonitor: EngagementMonitorConfig = {
  enabled: false,
  postUrl: '',
  postUrls: [],
  triggerKeywords: [],
  commentToDm: true,
  likeToDm: false,
  followToDm: false,
  dmScript: '',
  fastMode: false,
  scanAllPosts: true,
};

export interface BotConfig {
  platform: Platform;
  dmMode: DmMode;
  isWarmedUp: boolean;
  sessionMin: number;
  sessionMax: number;
  scrollWeight: number;
  likeWeight: number;
  dmWeight: number;
  minActionDelay: number;
  maxActionDelay: number;
  dailyMaxDMs: number;
  dailyMaxLikes: number;
  dailyMaxFollows: number;
  followEnabled: boolean;
  sessionDmGoal: number;
  // ── DM pacing controls (added v2.4.92) ──
  // Minimum gap between two DMs being sent. Stored in seconds; UI exposes minutes.
  // 0 = no per-DM cooldown beyond the regular action delay.
  dmCooldownSec?: number;
  // Burst pause: after every `dmBurstSize` DMs, pause for `dmBurstPauseSec`
  // seconds. 0 / 0 disables. Useful for "send 5 DMs, take a 10-min break".
  dmBurstSize?: number;
  dmBurstPauseSec?: number;
  targeting: TargetingConfig;
  aiTargeting: AITargetingData;
  engagementMonitor: EngagementMonitorConfig;
}

export interface BotStats {
  dmsSent: number;
  likesSent: number;
  followsSent: number;
  scrolls: number;
  elapsedTime: number;
  sessionTime: number;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  action: 'scroll' | 'like' | 'follow' | 'dm' | 'dm_skipped' | 'session_start' | 'session_end';
  message: string;
}

export const defaultConfig: BotConfig = {
  platform: 'instagram',
  dmMode: 'human',
  isWarmedUp: false,
  sessionMin: 10,
  sessionMax: 25,
  scrollWeight: 70,
  likeWeight: 20,
  dmWeight: 10,
  minActionDelay: 2,
  maxActionDelay: 10,
  dailyMaxDMs: 20,
  dailyMaxLikes: 50,
  dailyMaxFollows: 0,
  followEnabled: false,
  sessionDmGoal: 0,
  // Default: 60s minimum gap between DMs. Real human outreach is rarely
  // faster than once per minute; tightening this is the user's call.
  dmCooldownSec: 60,
  // Default: every 5 DMs, take a 10-min break — mimics a human who DMs in
  // batches, then puts the phone down.
  dmBurstSize: 5,
  dmBurstPauseSec: 600,
  targeting: { ...defaultTargeting },
  aiTargeting: { ...defaultAITargeting },
  engagementMonitor: { ...defaultEngagementMonitor },
};

// TikTok comment limits based on warmup
export const TIKTOK_COMMENTS_COLD = 100;
export const TIKTOK_COMMENTS_WARMED = 200;

// Human-mode presets only set the safety-related fields. Per-DM cooldown
// and burst pause are intentionally left out so the user's choices for
// those persist across Human/Manual switches.
export const HUMAN_MODE_WARMED = {
  dailyMaxDMs: 50,
  dailyMaxLikes: 50,
  dailyMaxFollows: 0,
  scrollWeight: 70,
  likeWeight: 20,
  dmWeight: 10,
  sessionMin: 10,
  sessionMax: 25,
  minActionDelay: 2,
  maxActionDelay: 10,
};

export const HUMAN_MODE_COLD = {
  dailyMaxDMs: 20,
  dailyMaxLikes: 50,
  dailyMaxFollows: 0,
  scrollWeight: 75,
  likeWeight: 18,
  dmWeight: 7,
  sessionMin: 10,
  sessionMax: 25,
  minActionDelay: 3,
  maxActionDelay: 12,
};

export function getRandom(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pickNextAction(config: BotConfig): 'scroll' | 'likeFollow' | 'dm' {
  const total = config.scrollWeight + config.likeWeight + config.dmWeight;
  const rand = Math.random() * total;
  if (rand < config.scrollWeight) return 'scroll';
  else if (rand < config.scrollWeight + config.likeWeight) return 'likeFollow';
  else return 'dm';
}

export function getRandomDelay(config: BotConfig): number {
  return getRandom(config.minActionDelay, config.maxActionDelay) * 1000;
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}
