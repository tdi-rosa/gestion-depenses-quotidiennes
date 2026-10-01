# Gestion de dépenses quotidiennes — Spendline

PWA installable pour suivre automatiquement ses dépenses bancaires, son budget mensuel et son rythme de dépense.

## Architecture

```
Fairphone / PWA Spendline
        ↓ HTTPS
Backend Node sur Railway
        ↓
Bridge API
        ↓
Banque
```

La PWA et l'API sont servies par le même service Railway. Les identifiants Bridge ne sont jamais envoyés au navigateur.

## Fonctionnalités

- connexion bancaire via Bridge Connect
- synchronisation automatique des dépenses à l'ouverture
- synchronisation incrémentale avec le champ `updated_at`
- synchronisation toutes les 5 minutes lorsque l'application reste ouverte
- import des débits bancaires, avec mise à jour et suppression des opérations modifiées
- ajout manuel et import CSV en secours
- stockage local IndexedDB
- budget mensuel, reste disponible et projection de fin de mois
- graphique des 30 derniers jours
- export/restauration JSON
- fonctionnement hors ligne pour les données déjà synchronisées
- PWA installable sur Android

## Sécurité

Le backend utilise un lien d'activation privé. Une fois ce lien ouvert sur un appareil, un cookie `HttpOnly`, `Secure` et `SameSite=Lax` autorise l'accès aux routes bancaires.

Variables Railway nécessaires :

```
SPENDLINE_SETUP_TOKEN
SPENDLINE_SESSION_SECRET
BRIDGE_CLIENT_ID
BRIDGE_CLIENT_SECRET
PUBLIC_APP_URL
BRIDGE_CALLBACK_URL
BRIDGE_WEBHOOK_SECRET       # optionnel jusqu'à configuration du webhook
BRIDGE_EXTERNAL_USER_ID     # optionnel, défaut: spendline-owner
```

Les réponses `/api/*` sont exclues du cache du service worker.

## Bridge

Version d'API utilisée : `2025-01-15`.

Le backend crée automatiquement l'utilisateur Bridge associé à `BRIDGE_EXTERNAL_USER_ID`, génère un token utilisateur à la demande et crée les sessions Bridge Connect.

Les transactions sont récupérées depuis :

```
GET /v3/aggregation/transactions
```

La première synchronisation importe 90 jours. Les suivantes utilisent `since` avec le dernier `updated_at` connu.

## Lancer en local

```bash
npm start
```

Puis ouvrir `http://localhost:3000`.

Sans identifiants Bridge, toute l'interface locale continue de fonctionner ; seule la synchronisation bancaire reste désactivée.
