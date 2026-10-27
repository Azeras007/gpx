# Mise en ligne : comptes et paiements

Sans configuration, l'app tourne en **mode local** : pas de comptes, parcours et essai Pro dans le navigateur.
Ce guide branche les **comptes** (Supabase) et les **abonnements** (Stripe). Comptez une heure.

Qui est Pro est décidé **uniquement côté serveur** : la table `subscriptions` n'est écrite que par le webhook
Stripe et par la fonction `start_trial()` (un seul essai par compte). La limite de 5 parcours en gratuit est
appliquée par la base de données.

## 1. Supabase (comptes + base de données)

1. Créez un projet sur [supabase.com](https://supabase.com), **région Europe** (données de localisation, RGPD).
2. *SQL Editor* → collez et exécutez `supabase/migrations/20261027000000_accounts_and_billing.sql`
   (ou `supabase link` puis `supabase db push` avec la CLI).
3. *Authentication → URL Configuration* :
   - **Site URL** : l'adresse de votre site (ex. `https://monsite.fr`)
   - **Redirect URLs** : `https://monsite.fr/app.html` et `http://localhost:5173/app.html`
4. *Authentication → Providers* : l'e-mail est actif par défaut (lien magique). Google est optionnel.
5. Pour des e-mails fiables en production, branchez un SMTP (Brevo, Resend…) dans *Authentication → SMTP*.

## 2. Stripe (abonnements)

1. Sur [dashboard.stripe.com](https://dashboard.stripe.com), en **mode test** d'abord :
   - *Catalogue de produits* → produit « GPX Studio Pro » avec deux prix récurrents : **3,99 €/mois** et **24,99 €/an**.
     Notez les deux identifiants `price_…`.
   - *Coupons* : pour l'offre fondateur, un coupon de **-20 % « pour toujours »** (24,99 € → 19,99 €/an) et un code promo `FONDATEUR`
     limité à 500 utilisations (les codes promo sont acceptés au paiement).
   - *Paramètres → Portail client* : activez l'annulation, le changement de formule et les factures.
2. Installez la [CLI Supabase](https://supabase.com/docs/guides/cli) et déployez les fonctions :

   ```bash
   supabase link --project-ref <votre-ref>
   supabase secrets set \
     STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_PRICE_MONTHLY=price_... \
     STRIPE_PRICE_YEARLY=price_... \
     SITE_URL=https://monsite.fr
   supabase functions deploy create-checkout
   supabase functions deploy create-portal
   supabase functions deploy delete-account
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```

3. *Développeurs → Webhooks* → point de terminaison
   `https://<votre-ref>.supabase.co/functions/v1/stripe-webhook`, événements :
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copiez le secret de signature puis :

   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```

## 3. L'application

Créez `.env.local` à la racine (jamais commité) :

```
VITE_SUPABASE_URL=https://<votre-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
# Optionnel, si Google est activé dans Supabase
VITE_AUTH_GOOGLE=true
```

`npm run dev`, puis testez :

1. *Connexion* → recevez le lien par e-mail → vous revenez connecté.
2. *Passer Pro → Essayer 14 jours* : le badge « Essai » apparaît. Un second essai est refusé.
3. *S'abonner* → payez avec la carte de test `4242 4242 4242 4242` → retour sur l'app, le badge PRO apparaît
   quelques secondes plus tard (le temps que le webhook arrive).
4. *Mon compte → Gérer mon abonnement* → annulez : le Pro reste actif jusqu'à la fin de la période payée.

Passez ensuite Stripe en **mode live** (nouvelles clés, nouveaux prix, nouveau webhook) au moment du lancement.

## À savoir

- Les fonctions Pro qui tournent entièrement dans le navigateur (boucle, météo…) ne peuvent pas être protégées
  à 100 % : quelqu'un de motivé peut modifier le code JavaScript. Ce qui est réellement protégé côté serveur :
  le statut d'abonnement, l'essai unique et la limite de parcours enregistrés. Quand les services payants
  (cartes, calcul d'itinéraire, météo) passeront derrière vos propres serveurs, ils pourront vérifier
  `is_pro()` à leur tour.
- Avant d'encaisser : CGV (droit de rétractation de 14 jours), CGU, politique de confidentialité et mentions
  légales — voir le business plan.
