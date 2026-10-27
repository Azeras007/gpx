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
- 🎯 **Objectif de temps** → allure (ou vitesse) nécessaire, applicable en un clic
- 🎒 **Dans le sac** : eau et glucides conseillés selon la durée et la chaleur prévue
- 🧭 **Points utiles OpenStreetMap** autour du parcours (eau, refuges, abris, sommets, points de vue) ajoutables en repères
- ▶️ **Survol animé** du parcours (style Relive) avec distance, altitude et temps
- 🖼️ **Image à partager** (format story) avec le tracé, le profil et les stats
- 🗺️ Fonds **IGN Plan** et **IGN Photo**, **relief ombré**, tracé **coloré selon la pente**
- 📥 Import par **glisser-déposer** d'un fichier GPX
- 🏷️ Difficulté, calories estimées, raccourcis clavier (touche `?`)
- 📈 **Profil altimétrique** coloré selon la pente, synchronisé avec la carte au survol
- 📊 Distance, D+, D-, altitude max, pente max, **durée estimée** (km-effort pour la course, DIN 33466 pour la rando)
- 💾 **Export GPX** (trace ou itinéraire), avec altitudes, repères et horaires estimés en option
- 🔗 **Lien de partage** : tout le parcours est encodé dans l'URL
- 📂 **Import GPX** (trk, rte ou wpt) et bibliothèque de parcours enregistrés dans le navigateur
- 🔎 Recherche de lieux, géolocalisation, interface responsive (bottom sheet sur mobile)

- 🧭 **Randonnées balisées** : GR, GR de Pays, PR et parcours de trail de la zone (OpenStreetMap), à prévisualiser et charger en un clic

## Offre gratuite / Pro

L'app distingue un niveau gratuit et un abonnement **Pro** (24,99 €/an ou 3,99 €/mois, essai de 14 jours) :
boucle automatique, « ne jamais repasser », plan de sortie, horaires dans le GPX, cartes IGN et relief,
points d'eau et refuges, parcours illimités (5 en gratuit).

Avec Supabase et Stripe configurés, le statut Pro est décidé **côté serveur** (webhook Stripe, essai unique,
limite de parcours appliquée par la base). Sans configuration, l'app tourne en mode local de démonstration.
Toute la mise en place est décrite dans **[SETUP.md](SETUP.md)**.

## Usage personnel

Pour héberger votre propre copie sans abonnement, définissez `VITE_PERSONAL=true` (dans `.env.local` ou dans les
variables d'environnement de l'hébergeur) : toutes les fonctions sont débloquées et les écrans d'offre disparaissent.

## Pages

- `index.html` : page d'accueil commerciale (présentation, tarifs, FAQ)
- `app.html` : l'application

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173 (accueil) et /app.html (application)
npm run build    # build de production dans dist/
```

## Services utilisés (gratuits, sans clé)

| Usage | Service |
| --- | --- |
| Routage sentiers + évitement | [BRouter](https://brouter.de) (profil hiking-mountain, zones nogo) |
| Routage routes & chemins | [routing.openstreetmap.de](https://routing.openstreetmap.de) (OSRM, profil foot) |
| Météo | [Open-Meteo Forecast API](https://open-meteo.com/en/docs) |
| Altitudes | Tuiles [Terrarium](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data), secours : Open-Meteo Elevation |
| Points utiles, randonnées balisées | [Overpass API](https://overpass-api.de) (OpenStreetMap) |
| Fonds IGN | [Géoplateforme IGN](https://geoservices.ign.fr) |
| Recherche | [Nominatim](https://nominatim.openstreetmap.org) |
| Fonds de carte | OpenTopoMap, CARTO, Esri World Imagery, Waymarked Trails |

## Stack

React 19 · TypeScript · Vite · Leaflet · Supabase (comptes, base de données, fonctions) · Stripe · polices Fraunces et Instrument Sans auto-hébergées

## Avant un usage commercial

Les serveurs publics gratuits utilisés (OpenTopoMap, CARTO, brouter.de, routing.openstreetmap.de, Overpass,
Open-Meteo gratuit) sont réservés à un usage léger ou non commercial. Avant de vendre l'abonnement : fournisseur de
tuiles sous licence, BRouter auto-hébergé, base de randonnées extraite d'OpenStreetMap, météo sous offre commerciale.
Les données OpenStreetMap (ODbL) et IGN (licence Etalab) imposent une mention visible.
