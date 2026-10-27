import Stripe from "npm:stripe@17.7.0";
import { createClient, type User } from "jsr:@supabase/supabase-js@2";
import { env } from "./http.ts";

export const stripe = new Stripe(env("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

/** Service-role client: bypasses row level security, server side only. */
export const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** The signed-in user making the request, from the JWT the app sends. */
export async function userFrom(req: Request): Promise<User | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

/** The user's Stripe customer, created on first use and remembered. */
export async function customerFor(user: User): Promise<string> {
  const { data } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  if (data?.stripe_customer_id) return data.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });
  const { error } = await admin
    .from("subscriptions")
    .upsert({ user_id: user.id, stripe_customer_id: customer.id, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw error;
  return customer.id;
}

export const siteUrl = () => env("SITE_URL").replace(/\/$/, "");
