# Sécurité Firestore — TimeCalculator

Référence : `firestore.rules` dans ce dossier. La console Firebase ne lit pas
ce dépôt — publier une modification des règles est toujours un geste manuel,
décrit ici. Rédigé le 2026-07-30, après examen des règles en production.

Depuis le 2026-07-30, ce fichier de règles couvre **deux outils** : la feuille
de temps TimeCalculator (`users/<uid>/timecalculator/state`) et le tableau de
bord marketing (`users/<uid>/marketing/state`). Deux blocs `match` indépendants,
de même forme ; ni l'un ni l'autre ne peut retirer un accès accordé par l'autre.
Toujours publier le fichier **tel qu'il est** — une copie antérieure au
2026-07-30 effacerait le bloc marketing.

## État des lieux

Les règles en production sont **saines** : chaque compte connecté ne lit et
n'écrit que `users/<son-uid>/timecalculator/**`. Un visiteur non connecté ne
peut rien lire (vérifié par sonde : `403 PERMISSION_DENIED`). Un compte
inconnu qui s'inscrirait n'obtiendrait que son propre dossier vide — jamais
les noms de clients, billets et descriptions du propriétaire.

`firestore.rules` versionne ces règles avec deux différences :

1. **`allow delete: if false`** — l'application ne supprime jamais le
   document; aucun navigateur, même avec un jeton volé, ne doit pouvoir le
   faire. (La console et l'Admin SDK ignorent les règles : le propriétaire
   du projet garde ce pouvoir.)
2. La portée `users/{uid}/timecalculator/…` est commentée pour expliquer
   pourquoi on n'élargit PAS à `users/{uid}/{document=**}` : un compte
   connecté quelconque pourrait sinon héberger des collections parasites
   aux frais du projet.

Aucune urgence : publier au prochain moment calme, jamais un vendredi de paye.

## Publier les règles (10 minutes, verrouillage impossible si suivi dans l'ordre)

1. Console Firebase → **Firestore Database → Règles**. Copier les règles
   ACTUELLES dans un fichier local : c'est le retour arrière.
2. **Authentication → Users** : copier l'`uid` du propriétaire.
3. Coller le contenu de `firestore.rules` dans l'éditeur — **ne pas publier**.
4. Ouvrir le **simulateur** (Rules Playground) et exécuter sept essais.

   TimeCalculator — `users/<uid>/timecalculator/state` :
   - `get`    authentifié avec cet uid → **autorisé**
   - `update` même chemin, même uid → **autorisé**
   - `get`    non authentifié → **refusé**
   - `get`    un AUTRE uid → **refusé**
   - `get`    `users/<uid>/autre/doc`, même uid → **refusé** (sous-collection non couverte)

   Marketing — `users/<uid>/marketing/state` (bloc ajouté le 2026-07-30, même forme) :
   - `get`    authentifié avec cet uid → **autorisé**
   - `get`    non authentifié → **refusé**

   Si un essai « autorisé » échoue : **ne pas publier** (verrouillage du
   propriétaire). Si un essai « refusé » est accepté : **ne pas publier** (fuite).
5. **Publier**, attendre une minute (propagation).
6. Vérifier hors cache : fenêtre de navigation privée → l'outil → connexion →
   la feuille s'affiche → punch in → recharger.
7. **La seule preuve réelle** : Console → Firestore →
   `users/<uid>/timecalculator/state` → `updatedAt` correspond à l'instant du
   punch. Si `updatedAt` n'a pas bougé, ou si la bannière « Synchronisation
   infonuagique en attente » apparaît dans l'outil, l'écriture est refusée :
   revenir en arrière tout de suite.

## Retour arrière en moins d'une minute

Firestore Database → Règles → **historique des versions** : republier la
version précédente. Sinon, recoller le fichier de l'étape 1.

## Au-delà des règles — vérifications console, par ordre d'importance

- **Authentication → Méthode de connexion : désactiver « Adresse e-mail/Mot
  de passe ».** C'est le point le plus important de cette page. Le
  fournisseur est actif (vérifié par sonde le 2026-07-27) alors que seul
  Microsoft sert. Tant qu'il est ouvert, n'importe qui peut se créer un
  compte avec la clé API publique — les règles le confinent à son propre
  dossier vide, mais un fournisseur inutile est une porte inutile, et les
  identités partageant une même adresse peuvent se lier au même compte.
- **Authentication → Settings → Domaines autorisés** : uniquement
  `bginformatique.ca`, `localhost` et les deux domaines `bgtimecalculator.*`
  par défaut (état vérifié sain le 2026-07-27). Tout domaine inconnu
  permettrait à un clone d'hameçonnage de lancer la vraie connexion.
- **Entra ID → Inscription d'application** : « Comptes dans cet annuaire
  organisationnel uniquement » (locataire unique). C'est là — et nulle part
  ailleurs — que le locataire Microsoft est réellement verrouillé : les
  règles Firestore ne peuvent pas le vérifier.
- **Firestore → Data** : aucune autre collection que `users`. Une collection
  oubliée deviendrait inaccessible à la publication des règles.
- **MFA du compte Google** : exigée par Firebase depuis le 29 juillet 2026
  pour accéder à la console. Sans elle, plus moyen de corriger quoi que ce
  soit ici.

## Ce que les règles ne protègent pas

Elles ne décident pas qui obtient un compte (ça, c'est Authentication et
Entra ID). Elles ne valident pas le contenu écrit : un bogue ou un jeton volé
peut écraser la feuille de temps — les filets sont l'export JSON, le
`localStorage` des appareils et la fusion par enregistrement. Elles ne
protègent pas d'un compte Microsoft hameçonné : la MFA du compte Microsoft
compte plus que ce fichier.
