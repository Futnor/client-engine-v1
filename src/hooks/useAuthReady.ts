import { useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

interface AuthReadyState {
  isReady: boolean;
  session: Session | null;
  user: User | null;
}

const INITIAL_AUTH_STATE: AuthReadyState = {
  isReady: false,
  session: null,
  user: null,
};

export function useAuthReady() {
  const [state, setState] = useState<AuthReadyState>(INITIAL_AUTH_STATE);

  useEffect(() => {
    let isMounted = true;

    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!isMounted) return;
      setState({
        isReady: true,
        session,
        user: session?.user ?? null,
      });
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      setState({
        isReady: true,
        session,
        user: session?.user ?? null,
      });
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return useMemo(() => state, [state]);
}
