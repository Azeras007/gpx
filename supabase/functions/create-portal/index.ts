// Stripe customer portal: change plan, update the card, cancel, download invoices.
import { cors, json } from "../_shared/http.ts";
import { customerFor, siteUrl, stripe, userFrom } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Connectez-vous d'abord." }, 401);
    const customer = await customerFor(user);
    const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${siteUrl()}/app.html` });
    return json({ url: portal.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Espace abonnement indisponible pour le moment." }, 500);
  }
});
