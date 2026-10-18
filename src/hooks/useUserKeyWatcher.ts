import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const STORAGE_KEY = 'futnor_user_key_id';

export function rememberUserKeyId(keyId: string) {
  try { localStorage.setItem(STORAGE_KEY, keyId); } catch {}
}

export function clearUserKeyId() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

/**
 * Polls the User Key that was used to sign in. If the main account
 * deletes/revokes that key, this signs the borrowed session out.
 */
export function useUserKeyWatcher(isAuthenticated: boolean) {
  useEffect(() => {
    if (!isAuthenticated) return;
    const keyId = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
    if (!keyId) return;

    let cancelled = false;

    const check = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('api-key', {
          body: { action: 'check', keyId },
        });
        if (cancelled) return;
        if (error) return; // network blip — try again next tick
        if (data && data.alive === false) {
          clearUserKeyId();
          toast.error('Your User Key was deleted. Signing out.');
          await supabase.auth.signOut();
        }
      } catch {}
    };

    check();
    const id = window.setInterval(check, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [isAuthenticated]);
}
