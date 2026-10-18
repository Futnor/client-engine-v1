CREATE TABLE public.trial_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  ip_address text NOT NULL,
  claimed_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.trial_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own trial claim"
ON public.trial_claims FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX idx_trial_claims_ip ON public.trial_claims (ip_address);
CREATE INDEX idx_trial_claims_user ON public.trial_claims (user_id);