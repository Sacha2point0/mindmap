# Worklab Mindmap

Logiciel de cartes mentales collaboratif en ligne : comptes utilisateurs, administration, partage par lien (lecture seule ou modification, sans compte), branches et sous-branches, mise en forme, liens, images et documents joints.

## Architecture

```
Navigateur (HTML/CSS/JS, sans étape de compilation)
   │  HTTPS — API JSON + synchronisation toutes les 1,5 s
   ▼
Node.js / Express  (server/index.js)
   ├── auth.js    comptes, sessions (cookie httpOnly), mots de passe bcrypt
   ├── admin.js   gestion des utilisateurs (rôles, désactivation, suppression)
   ├── maps.js    cartes, journal des modifications, liens de partage, fichiers
   └── db.js      MySQL en production / SQLite en local (via Knex)
```

**Pourquoi pas de WebSockets ?** Sur un hébergement mutualisé, les connexions permanentes ne sont pas garanties. La collaboration passe donc par un journal d'opérations : chaque modification (ajout, déplacement, mise en forme…) est envoyée au serveur, numérotée, puis récupérée par les autres participants toutes les 1,5 seconde. Ça fonctionne sur n'importe quel hébergement Node.js. Les modifications simultanées sur des nœuds différents ne se gênent pas. Sur le même nœud, la dernière arrivée l'emporte.

Le modèle de données et les opérations sont dans `public/js/ops.js`, un fichier partagé par le navigateur et le serveur.

## Lancer en local

```bash
npm install
npm run dev
```

Puis ouvrir http://localhost:3000. Le premier compte créé devient administrateur. En local, les données sont dans `data/` (base SQLite et fichiers envoyés).

## Déployer sur Hostinger (hébergement mutualisé avec Node.js)

1. **Base de données** : dans hPanel > *Bases de données* > *MySQL*, créez une base et un utilisateur. Notez le nom de la base, l'utilisateur et le mot de passe.
2. **Archive** : sur votre Mac, lancez `npm run package`. Le fichier `worklab-mindmap.zip` est créé à côté du dossier du projet (sans `node_modules` ni données locales).
3. **Application Node.js** : dans hPanel > *Sites web* > *Ajouter un site* > *Application web Node.js*, importez l'archive. Vous pouvez aussi connecter un dépôt GitHub.
   - Version de Node : 20 ou plus récente
   - Fichier d'entrée : `server/index.js`
   - Commande de démarrage : `npm start`
4. **Variables d'environnement** : saisissez celles de `.env.example` dans l'interface Hostinger, au minimum :
   - `NODE_ENV=production`
   - `JWT_SECRET` : une longue chaîne aléatoire
   - `DB_CLIENT=mysql`, `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
   - `UPLOAD_DIR` : un dossier **hors du dossier de l'application**, pour que les fichiers envoyés survivent aux redéploiements (par exemple `/home/<votre-utilisateur>/mindmap-uploads`)
   - `ADMIN_EMAIL` : votre adresse, pour devenir administrateur à l'inscription
5. **Domaine** : associez un domaine ou sous-domaine (par exemple `mindmap.worklab.fr`) et activez le certificat SSL. Le HTTPS est indispensable, car les cookies de session sont réservés au HTTPS en production.
6. Ouvrez le site et créez votre compte : il sera administrateur.

Les tables sont créées automatiquement au premier démarrage.

> À vérifier dans votre offre : l'emplacement exact des options Node.js dans hPanel, les versions de Node proposées et l'endroit où un dossier persistant peut être créé pour `UPLOAD_DIR`. L'interface Hostinger évolue régulièrement.

### Mettre à jour

Refaites `npm run package` et réimportez l'archive, ou poussez sur GitHub si le déploiement est connecté. Les données (MySQL + `UPLOAD_DIR`) ne sont pas touchées.

### Sauvegardes

Sauvegardez régulièrement la base MySQL (hPanel propose des sauvegardes) **et** le dossier `UPLOAD_DIR`.

## Utilisation

| Action | Raccourci |
|---|---|
| Ajouter une sous-branche | `Tab` |
| Ajouter une branche sœur | `Entrée` |
| Modifier le texte | double-clic, `Espace`, `F2` ou taper directement |
| Retour à la ligne dans un nœud | `Maj + Entrée` |
| Supprimer | `Suppr` / `Retour arrière` |
| Se déplacer entre les nœuds | flèches |
| Annuler / rétablir | `⌘Z` / `⇧⌘Z` |
| Zoomer | `⌘ + molette`, pincement du trackpad, ou boutons en bas à gauche |
| Déplacer la vue | glisser le fond, ou molette ou trackpad |

- **Déplacer une branche** : glissez-la sur un autre nœud (au centre : devient enfant ; en haut ou en bas : se place avant ou après).
- **Notes** : saisissez une note dans le panneau de droite (section *Note*). Une icône 📝 apparaît sur la branche, et un clic dessus affiche la note (les adresses web y sont cliquables). Les notes sont incluses dans les exports HTML et XMind.
- **Images et documents** : glissez des fichiers depuis l'ordinateur sur un nœud, collez une image (`⌘V`) ou utilisez le panneau de droite.
- **Coller une liste** : chaque ligne devient une sous-branche du nœud sélectionné.
- **Dossiers** : sur la page d'accueil, *+ Nouveau dossier* (sous-dossiers possibles). Rangez une carte en la glissant sur un dossier ou sur un nom du fil d'Ariane, ou avec *Déplacer*. Supprimer un dossier remonte son contenu d'un niveau (rien n'est effacé). La recherche trouve les cartes dans tous les dossiers.
- **Importer XMind** : bouton sur la page d'accueil, la carte est créée dans le dossier ouvert. Les fichiers XMind récents (branches, styles, liens, images, pièces jointes, notes) et XMind 8 (branches, liens, pièces jointes) sont pris en charge. Une carte est créée par feuille.
- **Exporter** : bouton *Exporter* → image PNG, PDF (liens cliquables), page HTML autonome (carte + plan détaillé, images et documents inclus) ou fichier XMind (branches, mise en forme, liens, images, documents en sous-branches).
- **Partager** : bouton *Partager* (propriétaire uniquement), qui crée des liens en lecture seule ou en modification, révocables à tout moment.

## Limites actuelles (V1)

- Pas de réinitialisation de mot de passe par e-mail : un administrateur peut définir un nouveau mot de passe depuis l'administration.
- Pas encore d'historique des versions.
- Les fichiers envoyés restent sur le serveur tant que la carte existe, même s'ils sont retirés d'un nœud.
