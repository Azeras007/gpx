# GPX Studio

Dashboard moderne pour **tracer, analyser et exporter des traces GPX** de course à pied et de randonnée.

## Fonctionnalités

- 🗺️ **Carte interactive** : Topo (OpenTopoMap), Plan, Satellite, Nuit + calque des sentiers balisés
- ✏️ **Tracé facile** : clic pour ajouter un point, glisser pour déplacer, clic sur la ligne pour insérer, double-clic / clic droit pour supprimer
- 🥾 **Suivi des chemins** (routage piéton OSRM) ou **ligne droite**, au choix pour chaque segment
- 🚫 **Ne jamais repasser au même endroit** : chaque segment évite les chemins déjà empruntés (zones « nogo » BRouter), et les portions parcourues deux fois sont surlignées en jaune
- ✨ **Générateur de boucle** : choisissez une distance, l'app propose une boucle depuis votre départ sans repasser par les mêmes chemins
- 🌲 Préférence **sentiers** (BRouter, profil randonnée) ou **routes & chemins** (OSRM)
- 🔁 Boucler vers le départ, aller-retour, inverser le sens, annuler / rétablir (Ctrl+Z / Ctrl+Y)
- 📍 **Repères** (point d'eau, ravito, sommet, point de vue, danger, parking, note) affichés sur la carte et le profil, exportés en waypoints
- 🗓️ **Planification** : heure de départ et d'arrivée, **météo heure par heure** sur le parcours, alerte coucher du soleil, **temps de passage** au km
- 🏷️ Difficulté, calories estimées, raccourcis clavier (touche `?`)
- 📈 **Profil altimétrique** coloré selon la pente, synchronisé avec la carte au survol
- 📊 Distance, D+, D-, altitude max, pente max, **durée estimée** (km-effort pour la course, DIN 33466 pour la rando)
- 💾 **Export GPX** (trace ou itinéraire), **KML** et **GeoJSON**, avec altitudes, repères et horaires estimés en option
- 🔗 **Lien de partage** : tout le parcours est encodé dans l'URL
- 📂 **Import GPX** (trk, rte ou wpt) et bibliothèque de parcours enregistrés dans le navigateur
- 🔎 Recherche de lieux, géolocalisation, interface responsive (bottom sheet sur mobile)

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # build de production dans dist/
```

## Services utilisés (gratuits, sans clé)

| Usage | Service |
| --- | --- |
| Routage sentiers + évitement | [BRouter](https://brouter.de) (profil hiking-mountain, zones nogo) |
| Routage routes & chemins | [routing.openstreetmap.de](https://routing.openstreetmap.de) (OSRM, profil foot) |
| Météo | [Open-Meteo Forecast API](https://open-meteo.com/en/docs) |
| Altitudes | [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api) (Copernicus DEM 90 m) |
| Recherche | [Nominatim](https://nominatim.openstreetmap.org) |
| Fonds de carte | OpenTopoMap, CARTO, Esri World Imagery, Waymarked Trails |

## Stack

React 19 · TypeScript · Vite · Leaflet · lucide-react
