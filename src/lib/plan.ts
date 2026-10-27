import { useCallback, useEffect, useState } from "react";

// Free vs Pro.
//
// IMPORTANT: this state lives in the browser, so anyone can unlock Pro from
// the devtools. It is only meant to test the offer. Before selling, Pro must
// be granted by a server that receives Stripe's webhook, and this module
// should read the user's plan from that server instead.

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
export const TRIAL_DAYS = 14;
export const PRICES = { monthly: "3,99 €", yearly: "24,99 €", founder: "19,99 €" };

/** Stripe Payment Links, set in a `.env` file (see README). */
export const CHECKOUT_LINKS = {
  monthly: import.meta.env.VITE_STRIPE_LINK_MONTHLY as string | undefined,
  yearly: import.meta.env.VITE_STRIPE_LINK_YEARLY as string | undefined,
};

interface PlanState {
  pro: boolean;
  trialStartedAt: number | null;
}

const KEY = "gpx-studio:plan";

function read(): PlanState {
  try {
    return { pro: false, trialStartedAt: null, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { pro: false, trialStartedAt: null };
  }
}

function write(s: PlanState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function usePlan() {
  const [state, setState] = useState<PlanState>(read);
  useEffect(() => write(state), [state]);

  // Back from Stripe Checkout (success URL ends with ?checkout=success).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("checkout") === "success") {
      setState((s) => ({ ...s, pro: true }));
      params.delete("checkout");
      const rest = params.toString();
      history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
    }
  }, []);

  const trialEnds = state.trialStartedAt ? state.trialStartedAt + TRIAL_DAYS * 86400000 : 0;
  const onTrial = !state.pro && trialEnds > Date.now();
  const trialDaysLeft = onTrial ? Math.ceil((trialEnds - Date.now()) / 86400000) : 0;

  const startTrial = useCallback(() => setState((s) => (s.trialStartedAt ? s : { ...s, trialStartedAt: Date.now() })), []);
  const checkout = useCallback((period: "monthly" | "yearly") => {
    const link = CHECKOUT_LINKS[period];
    if (!link) return false;
    window.location.href = link;
    return true;
  }, []);

  return {
    isPro: state.pro || onTrial,
    paid: state.pro,
    onTrial,
    trialDaysLeft,
    trialUsed: state.trialStartedAt != null,
    startTrial,
    checkout,
  };
}
