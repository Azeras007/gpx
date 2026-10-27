// Starts a Stripe Checkout for the Pro subscription of the signed-in user.
import { cors, env, json } from "../_shared/http.ts";
import { customerFor, siteUrl, stripe, userFrom } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Connectez-vous pour vous abonner." }, 401);
    const { period } = await req.json().catch(() => ({ period: "yearly" }));
    const price = period === "monthly" ? env("STRIPE_PRICE_MONTHLY") : env("STRIPE_PRICE_YEARLY");
    const customer = await customerFor(user);
    const site = siteUrl();

    // Already subscribed: open the billing portal rather than charging twice.
    const current = await stripe.subscriptions.list({ customer, status: "all", limit: 10 });
    if (current.data.some((s) => ["active", "trialing", "past_due"].includes(s.status))) {
      const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${site}/app.html` });
      return json({ url: portal.url, alreadySubscribed: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      // Founder offer and influencer codes are Stripe promotion codes
      allow_promotion_codes: true,
      subscription_data: { metadata: { supabase_user_id: user.id } },
      locale: "fr",
      success_url: `${site}/app.html?checkout=success`,
      cancel_url: `${site}/app.html?checkout=cancel`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Paiement indisponible pour le moment." }, 500);
  }
});
