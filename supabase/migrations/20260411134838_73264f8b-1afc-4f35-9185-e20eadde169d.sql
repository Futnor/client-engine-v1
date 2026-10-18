ALTER TABLE public.business_profiles
  ADD COLUMN whatsapp_phone_number_id text DEFAULT '',
  ADD COLUMN whatsapp_access_token text DEFAULT '',
  ADD COLUMN whatsapp_verify_token text DEFAULT '';