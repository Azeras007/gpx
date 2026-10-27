// GDPR: deletes the account and everything attached to it (routes and
// subscription rows cascade), after stopping any running subscription.
// Invoices stay in Stripe, which keeps them for accounting.
import { cors, json } from "../_shared/http.ts";
import { admin, stripe, userFrom } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Connectez-vous d'abord." }, 401);
    const { data } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    if (data?.stripe_customer_id) {
      const subs = await stripe.subscriptions.list({ customer: data.stripe_customer_id, status: "all", limit: 20 });
      for (const s of subs.data) {
        if (!["canceled", "incomplete_expired"].includes(s.status)) await stripe.subscriptions.cancel(s.id);
      }
    }
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw error;
    return json({ deleted: true });
  } catch (e) {
    console.error(e);
    return json({ error: "Suppression impossible pour le moment, écrivez-nous." }, 500);
  }
});
