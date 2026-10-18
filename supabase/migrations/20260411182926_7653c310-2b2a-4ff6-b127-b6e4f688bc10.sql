
CREATE TABLE public.dm_tracking (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  recipient_username TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'instagram',
  instagram_account_username TEXT,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  responded BOOLEAN NOT NULL DEFAULT false,
  responded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.dm_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dm tracking" ON public.dm_tracking FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own dm tracking" ON public.dm_tracking FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own dm tracking" ON public.dm_tracking FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_dm_tracking_user_id ON public.dm_tracking(user_id);
CREATE INDEX idx_dm_tracking_recipient ON public.dm_tracking(user_id, recipient_username, platform);
