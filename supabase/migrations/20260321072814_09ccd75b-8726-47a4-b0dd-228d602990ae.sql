ALTER TABLE public.session_history
ADD COLUMN IF NOT EXISTS instagram_account_username TEXT;

CREATE INDEX IF NOT EXISTS idx_session_history_user_account_started_at
ON public.session_history (user_id, instagram_account_username, started_at DESC);