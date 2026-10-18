
-- Storage bucket for reference images
INSERT INTO storage.buckets (id, name, public) VALUES ('reference-images', 'reference-images', true);

-- Allow anyone to view reference images
CREATE POLICY "Reference images are publicly accessible"
ON storage.objects FOR SELECT USING (bucket_id = 'reference-images');

-- Allow authenticated users to upload reference images
CREATE POLICY "Users can upload reference images"
ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'reference-images' AND auth.uid() IS NOT NULL);

-- Allow authenticated users to delete their own reference images
CREATE POLICY "Users can delete their reference images"
ON storage.objects FOR DELETE USING (bucket_id = 'reference-images' AND auth.uid() IS NOT NULL);

-- Outreach targets table - stores AI analysis results and outreach config
CREATE TABLE public.outreach_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  image_url TEXT NOT NULL,
  ai_description TEXT,
  content_tags TEXT[] DEFAULT '{}',
  custom_message TEXT DEFAULT 'Hey! Check your DMs 👀',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.outreach_profiles ENABLE ROW LEVEL SECURITY;

-- Public access for this bot dashboard (no auth required for simplicity)
CREATE POLICY "Allow all access to outreach profiles"
ON public.outreach_profiles FOR ALL USING (true) WITH CHECK (true);

-- Outreach queue - users found matching the reference
CREATE TABLE public.outreach_queue (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id UUID REFERENCES public.outreach_profiles(id) ON DELETE CASCADE,
  instagram_username TEXT,
  match_reason TEXT,
  match_score REAL DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  custom_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.outreach_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to outreach queue"
ON public.outreach_queue FOR ALL USING (true) WITH CHECK (true);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_outreach_profiles_updated_at
BEFORE UPDATE ON public.outreach_profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
