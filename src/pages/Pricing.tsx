import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invokeFunction';
import { Button } from '@/components/ui/button';
import { TIERS, SubscriptionTier } from '@/lib/subscriptionTiers';
import { useSubscription } from '@/hooks/useSubscription';
import { toast } from 'sonner';
import { Check, X, Zap, Bot, Crown, ArrowLeft, Loader2, Gift, AlertTriangle, Settings, ExternalLink } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

const tierIcons = { launch: Zap, growth: Bot, scale: Crown };
const tierColors = {
  launch: 'from-blue-500 to-cyan-400',
  growth: 'from-primary to-accent',
  scale: 'from-amber-500 to-orange-500',
};

const comparisonFeatures = [
  { name: 'Daily DMs', launch: '15', growth: '100–150', scale: 'Unlimited' },
  { name: 'Daily Likes', launch: '100', growth: '150', scale: 'Unlimited' },
  { name: 'Daily Follows', launch: '—', growth: '20', scale: 'Unlimited' },
  { name: 'Platforms', launch: '1', growth: '2', scale: '2' },
  { name: 'AI Search Results', launch: '5', growth: '10', scale: '100' },
  { name: 'Searches / Day', launch: '1', growth: '2', scale: 'Unlimited' },
  { name: 'DM Scripts', launch: '3', growth: 'Unlimited', scale: 'Unlimited' },
  { name: 'Export (CSV/Excel)', launch: false, growth: true, scale: true },
  { name: 'Scroll + Like', launch: true, growth: true, scale: true },
  { name: 'Follow Automation', launch: false, growth: true, scale: true },
  { name: 'Account Warm-Up', launch: false, growth: true, scale: true },
  { name: 'AI Outreach & Scripts', launch: false, growth: true, scale: true },
  { name: 'Advanced Targeting', launch: false, growth: false, scale: true },
  { name: 'Custom Usernames', launch: false, growth: false, scale: true },
  { name: 'Followers/Following Targeting', launch: false, growth: false, scale: true },
  { name: 'Session History', launch: true, growth: true, scale: true },
  { name: 'Priority Processing', launch: false, growth: false, scale: true },
  { name: 'DM Response Tracking', launch: false, growth: false, scale: true },
];

export default function Pricing() {
  const [annual, setAnnual] = useState(false);
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const { tier: currentTier, subscribed, hasStripeCustomer, trialDaysLeft, refresh: refreshSubscription } = useSubscription();
  const navigate = useNavigate();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const handleDirectCancel = async () => {
    setCancelling(true);
    try {
      const { data, error } = await invokeFunction<{
        cancelled: boolean;
        mode: 'immediate' | 'at_period_end';
        message?: string;
      }>('cancel-subscription');
      if (error) throw new Error(error);
      if (!data?.cancelled) throw new Error('Cancellation did not complete — please try again.');
      toast.success(data.message || 'Your subscription has been cancelled.');
      setCancelOpen(false);
      // Refresh subscription state so the UI updates without a hard reload
      void refreshSubscription?.();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to cancel — please try Stripe portal as a fallback.');
    } finally {
      setCancelling(false);
    }
  };

  const handleCheckout = async (tierKey: string, withTrial = false) => {
    const tier = TIERS[tierKey as keyof typeof TIERS];
    const priceId = annual ? tier.yearlyPriceId : tier.monthlyPriceId;
    setLoadingTier(withTrial ? `${tierKey}-trial` : tierKey);

    try {
      // Use the helper so users see the ACTUAL error from the edge function
      // ("You have already used your free trial", "Stripe key missing", etc.)
      // instead of the opaque "Edge Function returned a non-2xx status code".
      const { data, error } = await invokeFunction<{ url?: string }>('create-checkout', {
        priceId,
        withTrial,
      });
      if (error) throw new Error(error);
      if (data?.url) {
        window.open(data.url, '_blank');
      } else {
        throw new Error('Checkout did not return a URL — please try again.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create checkout session');
    } finally {
      setLoadingTier(null);
    }
  };

  const handleManageSubscription = async () => {
    try {
      const { data, error } = await invokeFunction<{ url?: string }>('customer-portal');
      if (error) throw new Error(error);
      if (data?.url) {
        // Navigate same-tab. Mobile browsers (especially iOS Safari) block
        // window.open after an async fetch because the user-gesture chain
        // is broken. Same-tab navigation always works, and the Stripe
        // billing portal has a "return to site" button at the top so the
        // user can come back cleanly.
        window.location.assign(data.url);
      } else {
        throw new Error('Subscription portal did not return a URL.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to open subscription portal');
    }
  };

  return (
    <div className="min-h-screen p-6 md:p-8 lg:p-10">
      <div className="max-w-5xl mx-auto space-y-10">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app')}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold gradient-text">Choose Your Plan</h1>
            <p className="text-muted-foreground mt-1">Unlock powerful automation features</p>
          </div>
        </div>

        {/* Slim trial status pill — informational only, no cancel UI here.
            Cancel/manage actions live behind the "Manage Plan" dialog so
            the Plans page stays clean and focused on plan selection. */}
        {trialDaysLeft !== null && trialDaysLeft > 0 && (
          <div className="text-center">
            <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/30 text-xs font-medium">
              🎁 Free trial active —
              <span className="text-primary font-bold">{trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'} remaining</span>
            </span>
          </div>
        )}

        <div className="flex items-center justify-center gap-4">
          <span className={`text-sm font-medium ${!annual ? 'text-foreground' : 'text-muted-foreground'}`}>Monthly</span>
          <button
            onClick={() => setAnnual(!annual)}
            className={`relative w-14 h-7 rounded-full transition-colors ${annual ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-card shadow-md transition-transform ${annual ? 'translate-x-7' : 'translate-x-0'}`} />
          </button>
          <span className={`text-sm font-medium ${annual ? 'text-foreground' : 'text-muted-foreground'}`}>
            Annual <span className="text-xs text-success font-bold">Save 20%</span>
          </span>
        </div>

        {currentTier === 'admin' && (
          <div className="text-center">
            <span className="inline-block px-4 py-2 rounded-full bg-gradient-to-r from-warning/20 to-warning/10 border border-warning/30 text-sm font-semibold text-warning">
              👑 Admin — Unlimited Free Access
            </span>
          </div>
        )}

        {/* Single "Manage Plan" entry point. All cancel/portal actions live
            inside the dialog so the Plans page stays focused on plan
            selection. Shows for trialing users + active subscribers +
            users with stale Stripe customer records (canceled trials,
            past_due, etc) — anyone who might need to manage anything. */}
        {(subscribed || hasStripeCustomer) && currentTier !== 'admin' && (
          <div className="text-center space-y-2">
            {subscribed && currentTier !== 'free' && TIERS[currentTier as keyof typeof TIERS] && (
              <span className="inline-block px-4 py-2 rounded-full bg-primary/20 border border-primary/30 text-sm font-semibold text-primary">
                Current Plan: {TIERS[currentTier as keyof typeof TIERS]?.name}
              </span>
            )}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setManageOpen(true)}
                className="gap-2"
              >
                <Settings className="w-4 h-4" />
                Manage Plan
              </Button>
            </div>
          </div>
        )}

        {/* Manage Plan dialog — the only place where Cancel + Stripe portal
            actions live. Trial users access it via the slim status pill's
            "Manage Plan" button; paid users via the same button under
            their plan badge. */}
        <Dialog open={manageOpen} onOpenChange={setManageOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-primary" />
                Manage your plan
              </DialogTitle>
              <DialogDescription>
                {trialDaysLeft !== null && trialDaysLeft > 0 ? (
                  <>
                    You're on a 7-day free trial with{' '}
                    <span className="text-primary font-bold">{trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'}</span>{' '}
                    remaining. You won't be charged until your trial ends.
                  </>
                ) : subscribed ? (
                  <>
                    You're on the{' '}
                    <span className="text-primary font-bold">
                      {TIERS[currentTier as keyof typeof TIERS]?.name || 'paid'}
                    </span>{' '}
                    plan. Cancel anytime — you'll keep access through the end of your current billing period.
                  </>
                ) : (
                  <>
                    Your previous Stripe subscription is no longer active. You can still review invoices and clean up your payment methods.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 py-2">
              {/* Primary action: direct cancel via our edge function */}
              {subscribed && (
                <Button
                  variant="destructive"
                  className="w-full gap-2"
                  onClick={() => { setManageOpen(false); setCancelOpen(true); }}
                >
                  <X className="w-4 h-4" />
                  {trialDaysLeft !== null && trialDaysLeft > 0
                    ? 'Cancel my free trial'
                    : 'Cancel my subscription'}
                </Button>
              )}

              {/* Secondary action: Stripe billing portal for invoices /
                  payment method updates. Always available when there's
                  any Stripe customer record. */}
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => { setManageOpen(false); void handleManageSubscription(); }}
              >
                <ExternalLink className="w-4 h-4" />
                Open Stripe billing portal
              </Button>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setManageOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Cancel confirmation dialog */}
        <AlertDialog open={cancelOpen} onOpenChange={(o) => !cancelling && setCancelOpen(o)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warning" />
                {trialDaysLeft !== null && trialDaysLeft > 0
                  ? 'Cancel your free trial?'
                  : 'Cancel your subscription?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {trialDaysLeft !== null && trialDaysLeft > 0 ? (
                  <>
                    Your free trial will end immediately and you won't be charged.
                    You'll lose access to bot features right away. You can always come back and pick a paid plan later.
                  </>
                ) : (
                  <>
                    Your subscription will be cancelled at the end of your current billing period. You'll keep access until then — Stripe won't charge you again.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancelling}>Keep my plan</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void handleDirectCancel(); }}
                disabled={cancelling}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-2"
              >
                {cancelling && <Loader2 className="w-4 h-4 animate-spin" />}
                {cancelling ? 'Cancelling...' : 'Yes, cancel'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>


        <div className="grid md:grid-cols-3 gap-6">
          {(Object.entries(TIERS) as [string, typeof TIERS[keyof typeof TIERS]][]).map(([key, tier]) => {
            const Icon = tierIcons[key as keyof typeof tierIcons];
            const gradient = tierColors[key as keyof typeof tierColors];
            const isCurrentPlan = currentTier === key;
            const price = annual ? tier.yearlyPrice : tier.monthlyPrice;
            const period = annual ? '/year' : '/month';
            const isPopular = key === 'growth';

            return (
              <div
                key={key}
                className={`relative glass rounded-2xl p-6 space-y-6 transition-all hover:scale-[1.02] ${
                  isPopular ? 'border-2 border-primary shadow-lg shadow-primary/10' : ''
                } ${isCurrentPlan ? 'ring-2 ring-primary/50' : ''}`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-gradient-to-r from-primary to-accent text-primary-foreground text-xs font-bold">
                    Most Popular
                  </div>
                )}
                {isCurrentPlan && (
                  <div className="absolute -top-3 right-4 px-3 py-1 rounded-full bg-primary/20 border border-primary/30 text-primary text-xs font-bold">
                    Your Plan
                  </div>
                )}

                <div className="space-y-3">
                  <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center`}>
                    <Icon className="w-6 h-6 text-primary-foreground" />
                  </div>
                  <h3 className="text-xl font-bold">{tier.name}</h3>
                  {annual ? (() => {
                    const fullAnnual = ('renewalPrice' in tier ? (tier as any).renewalPrice : tier.monthlyPrice) * 12;
                    return (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className="text-2xl font-bold text-muted-foreground line-through opacity-60">${fullAnnual}</span>
                          <span className="text-4xl font-bold text-success">${price}</span>
                          <span className="text-muted-foreground text-sm">{period}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Billed annually — save ${fullAnnual - price}/yr
                        </p>
                      </>
                    );
                  })() : 'renewalPrice' in tier ? (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className="text-2xl font-bold text-muted-foreground line-through opacity-60">${(tier as any).renewalPrice}</span>
                        <span className="text-4xl font-bold text-success">${price}</span>
                        <span className="text-muted-foreground text-sm">{period}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Renews at ${(tier as any).renewalPrice}/mo
                      </p>
                    </>
                  ) : (
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold">${price}</span>
                      <span className="text-muted-foreground text-sm">{period}</span>
                    </div>
                  )}
                </div>

                <ul className="space-y-3">
                  {tier.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <div className="space-y-2">
                  <Button
                    onClick={() => isCurrentPlan ? handleManageSubscription() : handleCheckout(key)}
                    disabled={loadingTier === key || loadingTier === `${key}-trial` || currentTier === 'admin'}
                    className={`w-full gap-2 ${isPopular && !isCurrentPlan ? 'bg-gradient-to-r from-primary to-accent text-primary-foreground' : ''}`}
                    variant={isCurrentPlan ? 'outline' : isPopular ? 'default' : 'secondary'}
                    size="lg"
                  >
                    {loadingTier === key && <Loader2 className="w-4 h-4 animate-spin" />}
                    {currentTier === 'admin' ? 'Admin Access' : isCurrentPlan ? 'Manage Plan' : 'Get Started'}
                  </Button>
                  {!isCurrentPlan && currentTier !== 'admin' && !subscribed && (
                    <Button
                      onClick={() => handleCheckout(key, true)}
                      disabled={loadingTier === key || loadingTier === `${key}-trial`}
                      variant="ghost"
                      size="sm"
                      className="w-full gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {loadingTier === `${key}-trial` && <Loader2 className="w-3 h-3 animate-spin" />}
                      <Gift className="w-3.5 h-3.5" /> 7-day free trial
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          <h2 className="text-2xl font-bold text-center">Feature Comparison</h2>
          <div className="glass rounded-2xl overflow-hidden border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left p-4 font-semibold text-muted-foreground">Feature</th>
                    <th className="p-4 text-center font-semibold">
                      <span className="text-primary">Launch</span>
                      <p className="text-xs text-muted-foreground font-normal mt-0.5">$15/mo</p>
                    </th>
                    <th className="p-4 text-center font-semibold">
                      <span className="text-primary">Growth</span>
                      <p className="text-xs text-muted-foreground font-normal mt-0.5">$29/mo</p>
                    </th>
                    <th className="p-4 text-center font-semibold">
                      <span className="text-warning">Scale</span>
                      <p className="text-xs text-muted-foreground font-normal mt-0.5">$129/mo</p>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonFeatures.map((feat, i) => (
                    <tr key={feat.name} className={i % 2 === 0 ? 'bg-secondary/20' : ''}>
                      <td className="p-4 font-medium">{feat.name}</td>
                      {(['launch', 'growth', 'scale'] as const).map((tierKey) => {
                        const val = feat[tierKey];
                        return (
                          <td key={tierKey} className="p-4 text-center">
                            {typeof val === 'boolean' ? (
                              val ? <Check className="w-5 h-5 text-success mx-auto" /> : <X className="w-5 h-5 text-muted-foreground/40 mx-auto" />
                            ) : (
                              <span className="font-mono font-medium">{val}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground pt-4 pb-8">
          <a href="/terms" className="hover:text-foreground transition-colors underline underline-offset-2">Terms &amp; Conditions</a>
          <span>·</span>
          <a href="/privacy-policy" className="hover:text-foreground transition-colors underline underline-offset-2">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
