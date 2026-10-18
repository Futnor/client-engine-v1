-- Distinguish brand-new outreach DMs from follow-ups in pre-existing chats.
-- Response rate computed across both buckets undercounts true cold-outreach
-- response rate, since follow-ups in already-engaged threads almost always
-- have replies. NULL = legacy rows where the snapshot wasn't captured.

ALTER TABLE public.dm_tracking
  ADD COLUMN IF NOT EXISTS was_first_contact BOOLEAN DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_dm_tracking_first_contact
  ON public.dm_tracking(user_id, platform, was_first_contact, sent_at DESC);
