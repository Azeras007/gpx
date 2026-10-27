# Instructions pour Claude

- À la fin de chaque fonctionnalité : commit, push sur la branche de travail, puis **ouvrir une pull request vers `main`** (le propriétaire fusionne lui-même ; Vercel déploie depuis `main`).
- Si la pull request précédente de la branche est déjà fusionnée, repartir de `main` à jour avant de continuer.
- L'interface et les textes sont en français.
- Avant de pousser : `npx tsc -b` et `npm run build` doivent passer.
