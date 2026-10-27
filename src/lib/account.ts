import { useCallback, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { functionError, supabase } from "./supabase";

export const googleEnabled = import.meta.env.VITE_AUTH_GOOGLE === "true";

/** Where sign-in links bring the user back: the app page itself. */
const returnUrl = () => `${location.origin}${location.pathname}`;

export function useAccount() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const sendMagicLink = useCallback(async (email: string) => {
    if (!supabase) return "Comptes indisponibles.";
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
    return error ? error.message : null;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    await supabase?.auth.signInWithOAuth({ provider: "google", options: { redirectTo: returnUrl() } });
  }, []);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
  }, []);

  const deleteAccount = useCallback(async () => {
    if (!supabase) return "Comptes indisponibles.";
    const { error } = await supabase.functions.invoke("delete-account", { body: {} });
    if (error) return functionError(error);
    await supabase.auth.signOut();
    return null;
  }, []);

  const user: User | null = session?.user ?? null;
  return { enabled: !!supabase, ready, user, sendMagicLink, signInWithGoogle, signOut, deleteAccount };
}

export type Account = ReturnType<typeof useAccount>;
