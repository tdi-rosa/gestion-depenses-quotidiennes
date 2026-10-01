# Gestion de dépenses quotidiennes

PWA installable pour suivre ses dépenses, son budget mensuel et l'évolution de ses dépenses au quotidien.

## Fonctionnalités

- ajout et suppression de dépenses
- stockage local avec IndexedDB
- budget mensuel et reste disponible
- dépenses du jour, des 7 derniers jours et du mois
- moyenne journalière et projection de fin de mois
- graphique des 30 derniers jours
- import CSV bancaire avec déduplication
- export et restauration JSON
- fonctionnement hors ligne grâce au service worker
- installable comme PWA sur Android

## Données

Les données restent dans le navigateur de l'appareil. Cette version ne contourne pas les protections de Lyf Pay et ne lit pas le stockage privé d'une autre application Android.

L'architecture permet d'ajouter ultérieurement un fournisseur bancaire/open-banking ou une autre source autorisée.

## Lancer en local

Un serveur HTTP est recommandé pour tester correctement le service worker :

```bash
python3 -m http.server 8080
```

Puis ouvrir `http://localhost:8080`.

## Déploiement

Le dépôt contient un workflow GitHub Pages. Dans **Settings → Pages**, sélectionner **GitHub Actions** comme source.
