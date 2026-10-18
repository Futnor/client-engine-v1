ALTER TABLE public.trial_claims
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE INDEX IF NOT EXISTS idx_trial_claims_email ON public.trial_claims (lower(email));
CREATE INDEX IF NOT EXISTS idx_trial_claims_ip ON public.trial_claims (ip_address);
CREATE INDEX IF NOT EXISTS idx_trial_claims_stripe_customer ON public.trial_claims (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_trial_claims_user ON public.trial_claims (user_id);

UPDATE public.trial_claims tc
SET email = lower(p.email)
FROM public.profiles p
WHERE tc.user_id = p.id AND tc.email IS NULL AND p.email IS NOT NULL;