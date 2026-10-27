import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Supabase client, or null when the app runs without a backend (local demo
 * mode: no accounts, routes and the Pro trial stay in the browser).
 */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;

/** Error message of an Edge Function call, whatever shape it came back in. */
export async function functionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    const body = await ctx.json().catch(() => null);
    if (body?.error) return String(body.error);
  }
  return "Service indisponible, réessayez dans un instant.";
}
