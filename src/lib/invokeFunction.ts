import { supabase } from '@/integrations/supabase/client';

/**
 * Drop-in replacement for `supabase.functions.invoke()` that surfaces the
 * REAL error message from the edge function's response body instead of the
 * opaque "Edge Function returned a non-2xx status code" wrapper.
 *
 * Why this exists:
 *   The `@supabase/supabase-js` v2 SDK swallows the response body when the
 *   function returns 4xx/5xx and returns a generic Error. Edge functions
 *   that already produce structured `{ error: '...' }` JSON have all the
 *   info we need — we just need to actually read it. This helper does a
 *   plain `fetch` so the body is parsed and surfaced to the caller.
 *
 * Usage:
 *   const { data, error } = await invokeFunction<{ url: string }>(
 *     'create-checkout',
 *     { priceId, withTrial },
 *   );
 *   if (error) { toast.error(error); return; }
 *   if (data?.url) window.open(data.url, '_blank');
 */
export async function invokeFunction<TData = unknown>(
  functionName: string,
  body?: unknown,
): Promise<{ data: TData | null; error: string | null; status?: number }> {
  // Pull URL + anon key from the same env vars the supabase client uses.
  const baseUrl = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
  const anonKey = (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!baseUrl || !anonKey) {
    return { data: null, error: 'Supabase env vars are not configured.' };
  }

  // Get the current user's access token so RLS / auth.getUser() works inside
  // the edge function. Anonymous calls send only the anon key.
  let accessToken: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    accessToken = data.session?.access_token;
  } catch {
    // Treat as unauthenticated; some functions allow this.
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: anonKey,
    Authorization: `Bearer ${accessToken || anonKey}`,
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const msg = (e as Error)?.message || 'Network error';
    return { data: null, error: `Network error calling ${functionName}: ${msg}` };
  }

  // Try to parse the body as JSON regardless of status — most functions
  // return JSON for both success and failure.
  let parsed: any = null;
  let rawText = '';
  try {
    rawText = await res.text();
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    // Non-JSON body — fall through and use rawText as the error message
    // when the status is non-2xx.
  }

  if (!res.ok) {
    // Server may return error as a string OR a nested object (PostgrestError,
    // Stripe error, etc). Coerce to a readable string instead of letting
    // "[object Object]" leak to the UI.
    const coerce = (v: unknown): string | null => {
      if (v == null) return null;
      if (typeof v === 'string') return v;
      if (typeof v === 'object') {
        const o = v as any;
        return o.message || o.error_description || o.hint || o.details
          || o.code || JSON.stringify(o);
      }
      return String(v);
    };
    const fromBody =
      (parsed && (coerce(parsed.error) || coerce(parsed.message) || coerce(parsed.reason))) ||
      (rawText && rawText.length < 400 ? rawText : null);
    const error =
      fromBody ||
      `${functionName} returned ${res.status} ${res.statusText}`;
    return { data: null, error, status: res.status };
  }

  return { data: (parsed as TData) ?? null, error: null, status: res.status };
}
