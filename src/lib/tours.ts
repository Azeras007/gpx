import type { difficulty, LatLng } from "./geo";
import type { Trail } from "./services";

// Shared by the explorer (loaded on demand) and the route card on the map.

export const KIND_HINT: Record<Trail["kind"], string> = {
  GR: "Grande Randonnée",
  GRP: "GR de Pays",
  PR: "Petite Randonnée",
  Trail: "Parcours de trail",
  Rando: "Sentier balisé",
  Course: "Course partagée",
  Marche: "Randonnée partagée",
};

export interface TourStats {
  distance: number;
  gain: number;
  duration: number;
  level: ReturnType<typeof difficulty>;
}

export interface Tour {
  trail: Trail;
  line: LatLng[];
  stats: TourStats | null;
}

