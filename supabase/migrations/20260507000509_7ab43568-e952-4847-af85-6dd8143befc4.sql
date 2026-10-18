CREATE POLICY "Users can delete own api keys"
ON public.api_keys
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);