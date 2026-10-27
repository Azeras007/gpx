// Stripe → database. The only place where a subscription becomes Pro.
// Deploy with --no-verify-jwt: Stripe does not send a Supabase JWT, the
// request is authenticated by its Stripe signature instead.
import Stripe from "npm:stripe@17.7.0";
import { env, json } from "../_shared/http.ts";
import { admin, stripe } from "../_shared/clients.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

/** Writes the subscription's current state, read fresh from Stripe so event order does not matter. */
async function sync(subscriptionId: string) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let userId: string | undefined = sub.metadata?.supabase_user_id;
  if (!userId) {
    const customer = await stripe.customers.retrieve(customerId);
    userId = "deleted" in customer ? undefined : customer.metadata?.supabase_user_id;
  }
  if (!userId) throw new Error(`No Supabase user for subscription ${sub.id}`);

  const item = sub.items.data[0];
  // Newer Stripe API versions moved the period end from the subscription to its items.
  const periodEnd =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    (item as unknown as { current_period_end?: number } | undefined)?.current_period_end;

  const { error } = await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      status: sub.status,
      plan: item?.price.id === env("STRIPE_PRICE_MONTHLY") ? "monthly" : "yearly",
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      cancel_at_period_end: sub.cancel_at_period_end,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, env("STRIPE_WEBHOOK_SECRET"), undefined, cryptoProvider);
  } catch (e) {
    console.error("Bad signature", e);
    return new Response("Bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription) {
          await sync(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await sync(event.data.object.id);
        break;
    }
  } catch (e) {
    // A 500 makes Stripe retry the event later.
    console.error(e);
    return new Response("Sync failed", { status: 500 });
  }
  return json({ received: true });
});
