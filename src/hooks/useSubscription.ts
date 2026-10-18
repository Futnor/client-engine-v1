import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuthReady } from '@/hooks/useAuthReady';
import { SubscriptionTier, getTierFromProductId, ADMIN_EMAILS, SCALE_REVIEWER_EMAILS } from '@/lib/subscriptionTiers';

interface SubscriptionState {
  tier: SubscriptionTier;
  subscribed: boolean;
  /** True if the user has ANY Stripe customer record — even with no active sub.
   *  Drives the "Manage subscription" button so users with canceled / past_due
   *  / unpaid subs can still reach the billing portal to clean up. */
  hasStripeCustomer: boolean;
  subscriptionEnd: string | null;
  trialDaysLeft: number | null;
  loading: boolean;
}

const INITIAL_STATE: SubscriptionState = {
  tier: 'free',
  subscribed: false,
  hasStripeCustomer: false,
  subscriptionEnd: null,
  trialDaysLeft: null,
  loading: true,
};

export function useSubscription() {
  const [state, setState] = useState<SubscriptionState>(INITIAL_STATE);
  const { isReady, user } = useAuthReady();

  const checkSubscription = useCallback(async () => {
    if (!isReady) return;

    if (!user) {
      setState({ tier: 'free', subscribed: false, hasStripeCustomer: false, subscriptionEnd: null, trialDaysLeft: null, loading: false });
      return;
    }

    try {
      const email = user.email?.toLowerCase();
      if (email && ADMIN_EMAILS.map((entry) => entry.toLowerCase()).includes(email)) {
        setState({ tier: 'admin', subscribed: true, hasStripeCustomer: false, subscriptionEnd: null, trialDaysLeft: null, loading: false });
        return;
      }
      if (email && SCALE_REVIEWER_EMAILS.map((entry) => entry.toLowerCase()).includes(email)) {
        setState({ tier: 'scale', subscribed: true, hasStripeCustomer: false, subscriptionEnd: null, trialDaysLeft: null, loading: false });
        return;
      }

      const { data, error } = await supabase.functions.invoke('check-subscription');
      if (error) throw error;

      const tier = getTierFromProductId(data?.product_id);
      const trialDaysLeft = data?.trial_days_left ?? null;

      setState({
        tier: data?.subscribed ? tier : 'free',
        subscribed: data?.subscribed ?? false,
        hasStripeCustomer: data?.has_stripe_customer ?? false,
        subscriptionEnd: data?.subscription_end ?? null,
        trialDaysLeft,
        loading: false,
      });
    } catch (err) {
      console.error('Subscription check failed:', err);
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [isReady, user]);

  useEffect(() => {
    if (!state.loading && state.tier) {
      try {
        localStorage.setItem('futnor_subscription_tier', state.tier);
      } catch {}
    }
  }, [state.tier, state.loading]);

  useEffect(() => {
    if (!isReady) return;

    void checkSubscription();
    const interval = setInterval(() => {
      void checkSubscription();
    }, 60000);

    return () => clearInterval(interval);
  }, [isReady, checkSubscription]);

  return useMemo(() => ({
    tier: state.tier,
    subscribed: state.subscribed,
    hasStripeCustomer: state.hasStripeCustomer,
    subscriptionEnd: state.subscriptionEnd,
    trialDaysLeft: state.trialDaysLeft,
    loading: !isReady || state.loading,
    refresh: checkSubscription,
  }), [isReady, state, checkSubscription]);
}
