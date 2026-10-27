# GPX Studio

Dashboard moderne pour **tracer, analyser et exporter des traces GPX** de course à pied et de randonnée.

## Fonctionnalités

- 🗺️ **Carte interactive** : Topo (OpenTopoMap), Plan, Satellite, Nuit + calque des sentiers balisés
- ✏️ **Tracé facile** : clic pour ajouter un point, glisser pour déplacer, clic sur la ligne pour insérer, double-clic / clic droit pour supprimer
- 🥾 **Suivi des chemins** (routage piéton OSRM) ou **ligne droite**, au choix pour chaque segment
- 🔁 Boucler vers le départ, aller-retour, inverser le sens, annuler / rétablir (Ctrl+Z / Ctrl+Y)
- 📈 **Profil altimétrique** coloré selon la pente, synchronisé avec la carte au survol
- 📊 Distance, D+, D-, altitude max, pente max, **durée estimée** (km-effort pour la course, DIN 33466 pour la rando)
- 💾 **Export GPX 1.1** avec altitudes (et horaires estimés en option pour le partenaire virtuel des montres)
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
| Routage piéton | [routing.openstreetmap.de](https://routing.openstreetmap.de) (OSRM, profil foot) |
| Altitudes | [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api) (Copernicus DEM 90 m) |
| Recherche | [Nominatim](https://nominatim.openstreetmap.org) |
| Fonds de carte | OpenTopoMap, CARTO, Esri World Imagery, Waymarked Trails |

## Stack

React 19 · TypeScript · Vite · Leaflet · lucide-react
