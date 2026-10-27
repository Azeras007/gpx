import { renderToStaticMarkup } from "react-dom/server";
import {
  Camera,
  Droplet,
  House,
  MapPin,
  Mountain,
  SquareParking,
  Tent,
  TriangleAlert,
  Telescope,
  Toilet,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import type { PoiType } from "../lib/geo";
import type { OsmPoi } from "../lib/services";

export const POI_ICONS: Record<PoiType, LucideIcon> = {
  water: Droplet,
  food: Utensils,
  hut: House,
  summit: Mountain,
  view: Camera,
  danger: TriangleAlert,
  parking: SquareParking,
  note: MapPin,
};

export const OSM_ICONS: Record<OsmPoi["kind"], LucideIcon> = {
  water: Droplet,
  hut: House,
  shelter: Tent,
  peak: Mountain,
  view: Telescope,
  toilets: Toilet,
};

export function PoiIcon({ type, size = 16 }: { type: PoiType; size?: number }) {
  const Icon = POI_ICONS[type];
  return <Icon size={size} strokeWidth={1.9} />;
}

/** Static SVG markup of an icon, for Leaflet's HTML markers. */
export const iconMarkup = (Icon: LucideIcon, size = 15) => renderToStaticMarkup(<Icon size={size} strokeWidth={2} />);
