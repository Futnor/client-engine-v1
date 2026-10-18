
-- Track daily AI post comment usage per user for tier-based quota enforcement.
CREATE TABLE IF NOT EXISTS public.ai_post_comment_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  usage_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_ai_post_comment_usage_user_date
  ON public.ai_post_comment_usage (user_id, usage_date);

ALTER TABLE public.ai_post_comment_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their own AI post comment usage"
  ON public.ai_post_comment_usage
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only the service role / edge function increments; users can't write directly.
CREATE POLICY "Service role manages AI post comment usage"
  ON public.ai_post_comment_usage
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER update_ai_post_comment_usage_updated_at
  BEFORE UPDATE ON public.ai_post_comment_usage
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
