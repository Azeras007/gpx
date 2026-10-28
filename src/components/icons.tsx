import { render } from "preact";
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

const markup = new Map<string, string>();

/** Static SVG markup of an icon, for Leaflet's HTML markers (rendered once, then reused). */
export function iconMarkup(Icon: LucideIcon, size = 15) {
  const key = `${Icon.displayName ?? ""}:${size}`;
  let html = markup.get(key);
  if (html == null) {
    const el = document.createElement("div");
    // Preact renders synchronously into a detached element
    render((<Icon size={size} strokeWidth={2} />) as unknown as Parameters<typeof render>[0], el);
    html = el.innerHTML;
    render(null, el);
    if (Icon.displayName) markup.set(key, html);
  }
  return html;
}
