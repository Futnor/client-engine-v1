// Admin email(s) that get free unlimited access
export const ADMIN_EMAILS = ['admin@futnor.com', 'owner@example.com'];

// Reviewer email(s) granted Scale-tier access for free — e.g., Chrome Web Store
// review team, App store testers. Same feature ceiling as a paying Scale user,
// but no admin dashboard access.
export const SCALE_REVIEWER_EMAILS: string[] = ['reviewer@example.com'];

export const FREE_TRIAL_DAYS = 7;

export type SubscriptionTier = 'free' | 'launch' | 'growth' | 'scale' | 'admin';

export const TIERS = {
  launch: {
    name: 'Launch',
    monthlyPriceId: 'price_1TJtklJUNIkx2ukihu4IJHWa',
    yearlyPriceId: 'price_1TJtklJUNIkx2ukihu4IJHWa', // same for now
    productIds: ['prod_UIUkFeugr2w1W5'],
    monthlyPrice: 15,
    yearlyPrice: 144,
    features: [
      '15 DMs per day',
      '1 platform (Instagram or TikTok)',
      'Up to 3 DM scripts',
      '5 search results per query',
      '1 AI search per day',
      'Basic targeting only',
      'Engage→DM (1 post, basic)',
    ],
    limits: {
      dailyMaxLikes: 100,
      dailyMaxFollows: 0,
      dailyMaxDMs: 15,
      platforms: 1,
      warmUp: false,
      aiOutreach: false,
      searchResultsLimit: 5,
      dailySearchLimit: 1,
      maxScripts: 3,
      canExport: false,
      advancedTargeting: false,
      engageDm: 'limited' as const,
      aiResponseBooster: 0 as number, // 0 = locked
    },
  },
  growth: {
    name: 'Growth',
    monthlyPriceId: 'price_1TJtkyJUNIkx2ukikbhldH6d',
    yearlyPriceId: 'price_1TJtkyJUNIkx2ukikbhldH6d',
    productIds: ['prod_UIUkrkXSkFVkOS'],
    monthlyPrice: 29,
    yearlyPrice: 278,
    renewalPriceId: 'price_1TKxUsJUNIkx2ukihePaJHOJ',
    renewalProductId: 'prod_UJag61rV7yysI0',
    renewalPrice: 49,
    features: [
      '100–150 DMs per day',
      'Instagram + TikTok access',
      'Unlimited DM scripts',
      '10 search results per query',
      '2 AI searches per day',
      'Basic CSV export',
      'Standard targeting',
      'Account warm-up',
      'Full Engage→DM (unlimited posts + keywords)',
      'AI Response Booster — 25 post comments/day',
    ],
    limits: {
      dailyMaxLikes: 150,
      dailyMaxFollows: 20,
      dailyMaxDMs: 150,
      platforms: 2,
      warmUp: true,
      aiOutreach: true,
      searchResultsLimit: 10,
      dailySearchLimit: 2,
      maxScripts: 999,
      canExport: true,
      advancedTargeting: false,
      engageDm: 'full' as const,
      aiResponseBooster: 25 as number, // 25 AI post comments per day, per user (not per account)
    },
  },
  scale: {
    name: 'Scale',
    monthlyPriceId: 'price_1TJtlFJUNIkx2ukiGH7cQXD3',
    yearlyPriceId: 'price_1TJtlFJUNIkx2ukiGH7cQXD3',
    productIds: ['prod_UIUkRqudp8lQqo'],
    monthlyPrice: 129,
    yearlyPrice: 1238,
    renewalPriceId: 'price_1TKxVFJUNIkx2uki29R1qRUc',
    renewalProductId: 'prod_UJagf1BmWz66EV',
    renewalPrice: 250,
    features: [
      'High/unlimited DM volume',
      'Instagram + TikTok access',
      'Unlimited DM scripts',
      '100 search results per query',
      'Unlimited AI searches',
      'Full export (CSV/Excel)',
      'Full advanced targeting',
      'Custom usernames + followers/following',
      'Priority processing',
      'DM Response Rate Tracking',
      'AI Response Booster — unlimited post comments',
    ],
    limits: {
      dailyMaxLikes: 999,
      dailyMaxFollows: 999,
      dailyMaxDMs: 999,
      platforms: 2,
      warmUp: true,
      aiOutreach: true,
      searchResultsLimit: 100,
      dailySearchLimit: 999,
      maxScripts: 999,
      canExport: true,
      advancedTargeting: true,
      engageDm: false as const,
      aiResponseBooster: -1 as number, // -1 = unlimited
    },
  },
} as const;

export function getTierFromProductId(productId: string | null): SubscriptionTier {
  if (!productId) return 'free';
  for (const [key, tier] of Object.entries(TIERS)) {
    if ((tier.productIds as readonly string[]).includes(productId)) return key as SubscriptionTier;
    if ('renewalProductId' in tier && (tier as any).renewalProductId === productId) return key as SubscriptionTier;
  }
  return 'free';
}

export function getTierLimits(tier: SubscriptionTier) {
  if (tier === 'admin') {
    return {
      dailyMaxLikes: 999,
      dailyMaxFollows: 999,
      dailyMaxDMs: 999,
      platforms: 2,
      warmUp: true,
      aiOutreach: true,
      searchResultsLimit: 100,
      dailySearchLimit: 999,
      maxScripts: 999,
      canExport: true,
      advancedTargeting: true,
      engageDm: 'full' as const,
      aiResponseBooster: -1 as number,
    };
  }
  if (tier === 'free') {
    return {
      dailyMaxLikes: 0,
      dailyMaxFollows: 0,
      dailyMaxDMs: 0,
      platforms: 0,
      warmUp: false,
      aiOutreach: false,
      searchResultsLimit: 0,
      dailySearchLimit: 0,
      maxScripts: 0,
      canExport: false,
      advancedTargeting: false,
      engageDm: false as const,
      aiResponseBooster: 0 as number,
    };
  }
  return TIERS[tier].limits;
}
