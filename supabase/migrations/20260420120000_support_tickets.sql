-- Support tickets system
-- Public can submit tickets from /support; only admins can read and reply.
-- Admin gate mirrors ADMIN_EMAILS in src/lib/subscriptionTiers.ts — keep in sync.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  subject TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
  ON public.support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_email
  ON public.support_tickets(email);

CREATE TABLE IF NOT EXISTS public.support_ticket_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  from_admin BOOLEAN NOT NULL,
  admin_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket
  ON public.support_ticket_replies(ticket_id, created_at ASC);

-- updated_at trigger (reuses public.update_updated_at_column from earlier migrations)
DO $$ BEGIN
  CREATE TRIGGER support_tickets_set_updated_at
    BEFORE UPDATE ON public.support_tickets
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Admin gate: mirrors ADMIN_EMAILS in src/lib/subscriptionTiers.ts.
-- If you add admins there, also add them here.
CREATE OR REPLACE FUNCTION public.is_support_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    auth.role() = 'service_role'
    OR lower(coalesce(auth.jwt() ->> 'email', '')) IN (
      'admin@futnor.com',
      'owner@example.com'
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_support_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_support_admin() TO authenticated, service_role;

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_replies ENABLE ROW LEVEL SECURITY;

-- Anyone (anon or authenticated) can submit a ticket
DO $$ BEGIN
  CREATE POLICY "Anyone can submit support tickets"
    ON public.support_tickets FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Admins can read all tickets
DO $$ BEGIN
  CREATE POLICY "Admins can read support tickets"
    ON public.support_tickets FOR SELECT
    TO authenticated
    USING (public.is_support_admin());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Admins can update ticket status
DO $$ BEGIN
  CREATE POLICY "Admins can update support tickets"
    ON public.support_tickets FOR UPDATE
    TO authenticated
    USING (public.is_support_admin())
    WITH CHECK (public.is_support_admin());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Replies are admin-only
DO $$ BEGIN
  CREATE POLICY "Admins can read support replies"
    ON public.support_ticket_replies FOR SELECT
    TO authenticated
    USING (public.is_support_admin());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins can insert support replies"
    ON public.support_ticket_replies FOR INSERT
    TO authenticated
    WITH CHECK (public.is_support_admin());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tell PostgREST to reload its schema cache so the new tables are exposed via the REST API.
-- Without this, clients hit "Could not find the table 'public.support_tickets' in the schema cache"
-- until the next PostgREST restart or background refresh.
NOTIFY pgrst, 'reload schema';
