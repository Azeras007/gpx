import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { POI_TYPES, type LatLng, type Poi, type Waypoint } from "../lib/geo";
import type { OsmPoi } from "../lib/services";
import { OSM_ICONS, POI_ICONS, iconMarkup } from "./icons";

export const OSM_KINDS: Record<OsmPoi["kind"], { label: string }> = {
  water: { label: "Point d'eau" },
  hut: { label: "Refuge" },
  shelter: { label: "Abri" },
  peak: { label: "Sommet" },
  view: { label: "Point de vue" },
  toilets: { label: "Toilettes" },
};

export const BASE_LAYERS: Record<string, { label: string; url: string; attribution: string; maxZoom: number }> = {
  topo: {
    label: "Topo",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17,
  },
  plan: {
    label: "Plan",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
  },
  ignplan: {
    label: "IGN Plan",
    url: "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    attribution: '© <a href="https://www.ign.fr">IGN</a>',
    maxZoom: 19,
  },
  ignortho: {
    label: "IGN Photo",
    url: "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    attribution: '© <a href="https://www.ign.fr">IGN</a>',
    maxZoom: 19,
  },
  dark: {
    label: "Nuit",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
  },
};

interface Props {
  waypoints: Waypoint[];
  legs: LatLng[][];
  pendingLegs: boolean[];
  accent: string;
  baseLayer: string;
  trails: boolean;
  hillshade: boolean;
  /** Route drawn in slope colors instead of the accent color. */
  slopeLines: { color: string; coords: LatLng[] }[] | null;
  osmPois: OsmPoi[];
  /** Part of the route already covered by the replay animation. */
  replayTrail: LatLng[] | null;
  /** A waymarked trail being previewed from the explorer. */
  preview: LatLng[] | null;
  hover: LatLng | null;
  kmMarks: { pos: LatLng; km: number }[];
  overlaps: LatLng[][];
  pois: Poi[];
  /** A point of interest is being placed: the next map click adds it. */
  placing: boolean;
  initialView: { lat: number; lng: number; zoom: number } | null;
  onReady: (map: L.Map) => void;
  onAdd: (p: LatLng) => void;
  onInsert: (index: number, p: LatLng) => void;
  onMove: (id: string, p: LatLng) => void;
  onRemove: (id: string) => void;
  onStartClick: () => void;
  onMovePoi: (id: string, p: LatLng) => void;
  onAddOsmPoi: (p: OsmPoi) => void;
  onRouteHover: (p: LatLng | null) => void;
  onRemovePoi: (id: string) => void;
  onViewChange: (v: { lat: number; lng: number; zoom: number }) => void;
}

export default function MapView(props: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const base = useRef<L.TileLayer | null>(null);
  const trailLayer = useRef<L.TileLayer | null>(null);
  const legGroup = useRef<L.LayerGroup | null>(null);
  const markerGroup = useRef<L.LayerGroup | null>(null);
  const kmGroup = useRef<L.LayerGroup | null>(null);
  const overlapGroup = useRef<L.LayerGroup | null>(null);
  const slopeGroup = useRef<L.LayerGroup | null>(null);
  const osmGroup = useRef<L.LayerGroup | null>(null);
  const replayLine = useRef<L.Polyline | null>(null);
  const previewGroup = useRef<L.LayerGroup | null>(null);
  const hillLayer = useRef<L.TileLayer | null>(null);
  const poiGroup = useRef<L.LayerGroup | null>(null);
  const hoverMarker = useRef<L.CircleMarker | null>(null);
  const legLines = useRef<{ casing: L.Polyline; line: L.Polyline }[]>([]);
  // Callbacks change identity on every render; keep the latest in a ref so the
  // Leaflet handlers registered once always see fresh closures.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const m = L.map(el.current!, {
      zoomControl: false,
      doubleClickZoom: false,
      attributionControl: true,
      worldCopyJump: true,
    });
    const v = props.initialView;
    if (v) m.setView([v.lat, v.lng], v.zoom);
    else m.setView([45.9237, 6.8694], 13); // Chamonix
    L.control.zoom({ position: "bottomright" }).addTo(m);
    L.control.scale({ position: "bottomright", imperial: false }).addTo(m);
    m.attributionControl.setPrefix(false);
    legGroup.current = L.layerGroup().addTo(m);
    previewGroup.current = L.layerGroup().addTo(m);
    slopeGroup.current = L.layerGroup().addTo(m);
    overlapGroup.current = L.layerGroup().addTo(m);
    osmGroup.current = L.layerGroup().addTo(m);
    kmGroup.current = L.layerGroup().addTo(m);
    markerGroup.current = L.layerGroup().addTo(m);
    poiGroup.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => cb.current.onAdd([e.latlng.lat, e.latlng.lng]));
    m.on("moveend", () => {
      const c = m.getCenter();
      cb.current.onViewChange({ lat: c.lat, lng: c.lng, zoom: m.getZoom() });
    });
    map.current = m;
    cb.current.onReady(m);
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Base layer
  useEffect(() => {
    const m = map.current!;
    const cfg = BASE_LAYERS[props.baseLayer] ?? BASE_LAYERS.topo;
    base.current?.remove();
    base.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: 19,
      maxNativeZoom: cfg.maxZoom,
      subdomains: "abc",
      crossOrigin: true,
    }).addTo(m);
    base.current.bringToBack();
    el.current!.dataset.layer = props.baseLayer;
  }, [props.baseLayer]);

  // Hiking trails overlay (Waymarked Trails)
  useEffect(() => {
    const m = map.current!;
    trailLayer.current?.remove();
    trailLayer.current = null;
    if (props.trails) {
      trailLayer.current = L.tileLayer("https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://waymarkedtrails.org">Waymarked Trails</a>',
        maxZoom: 19,
        opacity: 0.85,
      }).addTo(m);
    }
  }, [props.trails]);

  // Route legs
  useEffect(() => {
    const g = legGroup.current!;
    g.clearLayers();
    legLines.current = props.legs.map((leg, i) => {
      const pending = props.pendingLegs[i];
      const casing = L.polyline(leg, {
        color: "#ffffff",
        weight: 9,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(g);
      const line = L.polyline(leg, {
        color: props.accent,
        weight: 5,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        dashArray: pending ? "2 10" : undefined,
        bubblingMouseEvents: false,
        className: "route-line",
      }).addTo(g);
      // Wider invisible hit area for inserting points on the line
      L.polyline(leg, { weight: 18, opacity: 0, bubblingMouseEvents: false })
        .on("click", (e: L.LeafletMouseEvent) => cb.current.onInsert(i + 1, [e.latlng.lat, e.latlng.lng]))
        .on("mouseover", () => line.setStyle({ weight: 7 }))
        .on("mousemove", (e: L.LeafletMouseEvent) => cb.current.onRouteHover([e.latlng.lat, e.latlng.lng]))
        .on("mouseout", () => {
          line.setStyle({ weight: 5 });
          cb.current.onRouteHover(null);
        })
        .addTo(g);
      return { casing, line };
    });
  }, [props.legs, props.pendingLegs, props.accent]);

  // Waypoint markers
  useEffect(() => {
    const g = markerGroup.current!;
    g.clearLayers();
    const wps = props.waypoints;
    const dense = wps.length > 40;
    wps.forEach((wp, i) => {
      const isStart = i === 0;
      const isEnd = i === wps.length - 1 && wps.length > 1;
      const kind = isStart ? "start" : isEnd ? "end" : dense ? "mini" : "mid";
      const size = kind === "mini" ? 9 : kind === "mid" ? 18 : 26;
      const icon = L.divIcon({
        className: "",
        html: `<div class="wp wp-${kind}" style="--accent:${props.accent}">${
          isStart ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' : isEnd ? '<svg viewBox="0 0 24 24"><path d="M5 21V4h9l1 2h5v9h-7l-1-2H7v8z"/></svg>' : ""
        }</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const mk = L.marker([wp.lat, wp.lng], { icon, draggable: true, autoPan: true, zIndexOffset: isStart || isEnd ? 1000 : 0 });
      mk.on("drag", () => {
        const p = mk.getLatLng();
        const cur: LatLng = [p.lat, p.lng];
        const prev = legLines.current[i - 1];
        const next = legLines.current[i];
        if (prev) {
          const a: LatLng = [wps[i - 1].lat, wps[i - 1].lng];
          prev.casing.setLatLngs([a, cur]);
          prev.line.setLatLngs([a, cur]);
        }
        if (next) {
          const b: LatLng = [wps[i + 1].lat, wps[i + 1].lng];
          next.casing.setLatLngs([cur, b]);
          next.line.setLatLngs([cur, b]);
        }
      });
      mk.on("dragend", () => {
        const p = mk.getLatLng();
        cb.current.onMove(wp.id, [p.lat, p.lng]);
      });
      mk.on("contextmenu", () => cb.current.onRemove(wp.id));
      mk.on("dblclick", () => cb.current.onRemove(wp.id));
      if (isStart) mk.on("click", () => cb.current.onStartClick());
      const label = isStart ? "Départ · clic pour boucler" : isEnd ? "Arrivée" : `Point ${i}`;
      mk.bindTooltip(`${label}<br><span>Glisser pour déplacer · double-clic pour supprimer</span>`, {
        direction: "top",
        offset: [0, -size / 2 - 4],
        className: "wp-tip",
      });
      mk.addTo(g);
    });
  }, [props.waypoints, props.accent]);

  // Kilometer markers
  useEffect(() => {
    const g = kmGroup.current!;
    g.clearLayers();
    props.kmMarks.forEach(({ pos, km }) => {
      L.marker(pos, {
        interactive: false,
        icon: L.divIcon({ className: "", html: `<div class="km-mark">${km}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(g);
    });
  }, [props.kmMarks]);

  // Shaded relief, blended over the base map
  useEffect(() => {
    const m = map.current!;
    hillLayer.current?.remove();
    hillLayer.current = null;
    if (props.hillshade) {
      hillLayer.current = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Relief © Esri",
        maxZoom: 19,
        maxNativeZoom: 16,
        opacity: 0.45,
        className: "hillshade",
      }).addTo(m);
    }
  }, [props.hillshade]);

  // Slope-colored route
  useEffect(() => {
    const g = slopeGroup.current!;
    g.clearLayers();
    el.current!.classList.toggle("slope-mode", !!props.slopeLines);
    props.slopeLines?.forEach(({ color, coords }) =>
      L.polyline(coords, { color, weight: 6, lineCap: "round", lineJoin: "round", interactive: false }).addTo(g),
    );
  }, [props.slopeLines, props.legs]);

  // Explorer preview
  useEffect(() => {
    const g = previewGroup.current!;
    g.clearLayers();
    if (!props.preview || props.preview.length < 2) return;
    L.polyline(props.preview, { color: "#ffffff", weight: 10, opacity: 0.9, lineCap: "round", interactive: false }).addTo(g);
    L.polyline(props.preview, { color: "#1d1c18", weight: 4, dashArray: "8 7", lineCap: "round", interactive: false }).addTo(g);
    L.circleMarker(props.preview[0], { radius: 7, color: "#fff", weight: 3, fillColor: "#2e5a45", fillOpacity: 1, interactive: false }).addTo(g);
    map.current!.fitBounds(L.latLngBounds(props.preview), {
      paddingTopLeft: window.innerWidth < 860 ? [30, 90] : [440, 90],
      paddingBottomRight: window.innerWidth < 860 ? [30, 260] : [90, 260],
    });
  }, [props.preview]);

  // Replay trail
  useEffect(() => {
    const m = map.current!;
    if (!props.replayTrail) {
      replayLine.current?.remove();
      replayLine.current = null;
      return;
    }
    if (!replayLine.current) {
      replayLine.current = L.polyline([], { color: "#1d1c18", weight: 3, opacity: 0.9, interactive: false, className: "replay-line" }).addTo(m);
    }
    replayLine.current.setLatLngs(props.replayTrail);
  }, [props.replayTrail]);

  // Amenities found on OpenStreetMap
  useEffect(() => {
    const g = osmGroup.current!;
    g.clearLayers();
    props.osmPois.forEach((p) => {
      const k = OSM_KINDS[p.kind];
      const mk = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: "", html: `<div class="osm-poi">${iconMarkup(OSM_ICONS[p.kind], 13)}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        zIndexOffset: 500,
      });
      const title = (p.name || k.label).replace(/[<>&]/g, "");
      mk.bindTooltip(`${title}${p.ele ? ` · ${Math.round(p.ele)} m` : ""}<br><span>${k.label} · clic pour l'ajouter aux repères</span>`, {
        direction: "top",
        offset: [0, -14],
        className: "wp-tip",
      });
      mk.on("click", () => cb.current.onAddOsmPoi(p));
      mk.addTo(g);
    });
  }, [props.osmPois]);

  // Sections where the route passes again over itself
  useEffect(() => {
    const g = overlapGroup.current!;
    g.clearLayers();
    props.overlaps.forEach((line) => {
      L.polyline(line, { color: "#fbf9f4", weight: 9, opacity: 0.9, lineCap: "round", interactive: false }).addTo(g);
      L.polyline(line, { color: "#a8761c", weight: 4, dashArray: "2 7", lineCap: "round", interactive: false }).addTo(g);
    });
  }, [props.overlaps]);

  // Points of interest
  useEffect(() => {
    const g = poiGroup.current!;
    g.clearLayers();
    props.pois.forEach((poi) => {
      const mk = L.marker([poi.lat, poi.lng], {
        draggable: true,
        zIndexOffset: 2000,
        icon: L.divIcon({
          className: "",
          html: `<div class="poi poi-${poi.type}">${iconMarkup(POI_ICONS[poi.type], 15)}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 37],
        }),
      });
      mk.on("dragend", () => {
        const p = mk.getLatLng();
        cb.current.onMovePoi(poi.id, [p.lat, p.lng]);
      });
      mk.on("contextmenu", () => cb.current.onRemovePoi(poi.id));
      mk.on("dblclick", () => cb.current.onRemovePoi(poi.id));
      const name = poi.name.replace(/[<>&]/g, "");
      mk.bindTooltip(`${name}<br><span>${POI_TYPES[poi.type].label} · double-clic pour supprimer</span>`, {
        direction: "top",
        offset: [0, -38],
        className: "wp-tip",
      });
      mk.addTo(g);
    });
  }, [props.pois]);

  useEffect(() => {
    el.current!.classList.toggle("placing", props.placing);
  }, [props.placing]);

  // Hover marker from the elevation profile
  useEffect(() => {
    const m = map.current!;
    if (!props.hover) {
      hoverMarker.current?.remove();
      hoverMarker.current = null;
      return;
    }
    if (!hoverMarker.current) {
      hoverMarker.current = L.circleMarker(props.hover, {
        radius: 8,
        color: "#fff",
        weight: 3,
        fillColor: props.accent,
        fillOpacity: 1,
        interactive: false,
      }).addTo(m);
    } else {
      hoverMarker.current.setLatLng(props.hover);
      hoverMarker.current.setStyle({ fillColor: props.accent });
    }
  }, [props.hover, props.accent]);

  return <div ref={el} className="map" />;
}
