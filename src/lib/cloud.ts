import { supabase } from "./supabase";
import type { SavedRoute } from "./store";

// Saved routes in the user's account (table `routes`, row level security:
// each user only ever sees their own rows).

interface Row {
  id: string;
  name: string;
  activity: "run" | "hike";
  waypoints: SavedRoute["waypoints"];
  pois: NonNullable<SavedRoute["pois"]>;
  distance: number;
  gain: number;
  updated_at: string;
}

const fromRow = (r: Row): SavedRoute => ({
  id: r.id,
  name: r.name,
  activity: r.activity,
  waypoints: r.waypoints,
  pois: r.pois,
  distance: r.distance,
  gain: r.gain,
  updatedAt: Date.parse(r.updated_at),
});

export class RouteLimitError extends Error {}

export async function listRoutes(): Promise<SavedRoute[]> {
  const { data, error } = await supabase!.from("routes").select("*").order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as Row[]).map(fromRow);
}

/** Inserts (id null) or updates a route; returns it as stored. */
export async function saveRoute(r: Omit<SavedRoute, "id" | "updatedAt"> & { id: string | null }): Promise<SavedRoute> {
  const values = {
    name: r.name.trim().slice(0, 200) || "Parcours",
    activity: r.activity,
    waypoints: r.waypoints,
    pois: r.pois ?? [],
    distance: r.distance,
    gain: r.gain,
  };
  const query = r.id
    ? supabase!.from("routes").update(values).eq("id", r.id).select().single()
    : supabase!.from("routes").insert(values).select().single();
  const { data, error } = await query;
  if (error) {
    // Raised by the database trigger when a free account already has 5 routes
    if (error.message.includes("free route limit")) throw new RouteLimitError(error.message);
    throw error;
  }
  return fromRow(data as Row);
}

export async function deleteRoute(id: string) {
  const { error } = await supabase!.from("routes").delete().eq("id", id);
  if (error) throw error;
}
