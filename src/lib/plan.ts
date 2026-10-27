import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { functionError, supabase } from "./supabase";

// Free vs Pro.
//
// With a backend (Supabase configured), the plan is read from the
// `subscriptions` table, which only the Stripe webhook and the
// `start_trial()` database function can write: the browser never decides
// that someone is Pro. Without a backend (local demo), a trial is kept in
// localStorage so the offer can still be tried out.

export type ProFeature = "loop" | "avoid" | "planner" | "times" | "maps" | "amenities" | "library";

export const PRO_FEATURES: Record<ProFeature, { title: string; pitch: string }> = {
  loop: { title: "Générateur de boucle", pitch: "Une boucle de la distance voulue depuis votre départ, en un clic." },
  avoid: { title: "Ne jamais repasser au même endroit", pitch: "Chaque segment cherche un autre chemin que ceux déjà empruntés." },
  planner: { title: "Plan de sortie", pitch: "Météo heure par heure, temps de passage, eau et nourriture, objectif de temps." },
  times: { title: "Horaires dans le GPX", pitch: "Courez contre votre plan avec le partenaire virtuel de votre montre." },
  maps: { title: "Cartes IGN et relief", pitch: "Fonds IGN Plan et Photo, relief ombré, tracé coloré selon la pente." },
  amenities: { title: "Points d'eau et refuges", pitch: "Les points utiles à moins de 300 m de votre parcours." },
  library: { title: "Parcours illimités", pitch: "Enregistrez autant de parcours que vous voulez." },
};

export const FREE_ROUTE_LIMIT = 5;

/**
 * Personal install (VITE_PERSONAL=true): everything is unlocked and the
 * offer screens are hidden. Meant for running your own copy, not for selling.
 */
export const PERSONAL = import.meta.env.VITE_PERSONAL === "true";
export const TRIAL_DAYS = 14;
export const PRICES = { monthly: "3,99 €", yearly: "24,99 €", founder: "19,99 €" };

interface Subscription {
  status: string | null;
  plan: "monthly" | "yearly" | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
}

const LOCAL_KEY = "gpx-studio:plan";

function readLocalTrial(): number | null {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}").trialStartedAt ?? null;
  } catch {
    return null;
  }
}

export type CheckoutResult = { ok: true } | { ok: false; needAccount?: boolean; message?: string };

export function usePlan(user: User | null) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [localTrial, setLocalTrial] = useState<number | null>(readLocalTrial);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    if (!supabase || !user) {
      setSub(null);
      return null;
    }
    const { data } = await supabase
      .from("subscriptions")
      .select("status, plan, current_period_end, cancel_at_period_end, trial_ends_at")
      .eq("user_id", user.id)
      .maybeSingle();
    setSub(data as Subscription | null);
    return data as Subscription | null;
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Back from Stripe Checkout: the webhook may land a few seconds after the
  // redirect, so the plan is polled until it shows up.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("checkout");
    if (!result) return;
    // The session is restored asynchronously: wait for the user before
    // consuming the flag, or the poll would never start.
    if (supabase && !user) return;
    params.delete("checkout");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
    if (result !== "success" || !supabase) return;
    let tries = 0;
    let stop = false;
    setSyncing(true);
    const poll = async () => {
      const s = await refresh();
      if (stop) return;
      if (isPaid(s) || ++tries >= 15) setSyncing(false);
      else setTimeout(poll, 2000);
    };
    poll();
    return () => {
      stop = true;
    };
  }, [user, refresh]);

  const now = Date.now();
  const paid = PERSONAL || isPaid(sub);
  const trialEnds = supabase
    ? sub?.trial_ends_at
      ? Date.parse(sub.trial_ends_at)
      : 0
    : localTrial
      ? localTrial + TRIAL_DAYS * 86400000
      : 0;
  const onTrial = !paid && trialEnds > now;

  const startTrial = useCallback(async (): Promise<CheckoutResult> => {
    if (!supabase) {
      const t = readLocalTrial() ?? Date.now();
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify({ trialStartedAt: t }));
      } catch {
        /* storage unavailable */
      }
      setLocalTrial(t);
      return { ok: true };
    }
    if (!user) return { ok: false, needAccount: true };
    const { error } = await supabase.rpc("start_trial");
    if (error) return { ok: false, message: error.message.includes("already") ? "Votre essai gratuit a déjà été utilisé." : error.message };
    await refresh();
    return { ok: true };
  }, [user, refresh]);

  /** Redirects to Stripe Checkout (or to the billing portal if already subscribed). */
  const checkout = useCallback(
    async (period: "monthly" | "yearly"): Promise<CheckoutResult> => {
      if (!supabase) return { ok: false, message: "Le paiement en ligne ouvre très bientôt. Merci de votre patience !" };
      if (!user) return { ok: false, needAccount: true };
      const { data, error } = await supabase.functions.invoke("create-checkout", { body: { period } });
      if (error || !data?.url) return { ok: false, message: error ? await functionError(error) : "Paiement indisponible." };
      window.location.href = data.url;
      return { ok: true };
    },
    [user],
  );

  /** Stripe customer portal: change plan, card, cancel, invoices. */
  const manage = useCallback(async (): Promise<string | null> => {
    if (!supabase || !user) return "Connectez-vous d'abord.";
    const { data, error } = await supabase.functions.invoke("create-portal", { body: {} });
    if (error || !data?.url) return error ? functionError(error) : "Espace abonnement indisponible.";
    window.location.href = data.url;
    return null;
  }, [user]);

  return {
    isPro: paid || onTrial,
    paid,
    onTrial,
    trialDaysLeft: onTrial ? Math.ceil((trialEnds - now) / 86400000) : 0,
    trialUsed: supabase ? !!sub?.trial_ends_at : localTrial != null,
    renewsAt: paid && sub?.current_period_end ? new Date(sub.current_period_end) : null,
    cancelsAtPeriodEnd: !!sub?.cancel_at_period_end,
    period: sub?.plan ?? null,
    syncing,
    startTrial,
    checkout,
    manage,
  };
}

function isPaid(s: Subscription | null) {
  return (
    !!s &&
    ["active", "trialing", "past_due"].includes(s.status ?? "") &&
    !!s.current_period_end &&
    Date.parse(s.current_period_end) > Date.now()
  );
}

export type Plan = ReturnType<typeof usePlan>;
