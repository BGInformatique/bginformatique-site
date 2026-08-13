# Espace client

**https://bginformatique.ca/espace-client/** — `noindex, nofollow`, absent du
sitemap. Ce n'est pas une page cachée comme les outils internes : les clients
doivent pouvoir la retrouver. Elle est simplement privée derrière la connexion.

Le client se connecte avec le compte Microsoft auquel il a été **invité**,
écrit ses demandes de modification, et en suit l'avancement. BG Informatique
les lit dans un outil séparé et décide quand les lancer.

---

## Le chemin complet d'une demande

```
Client → espace-client/ ──────────────▶ projet Firebase CLIENTS
                                         demandes/<id>   statut « recue »
                                                  │
                             pont_clients.py (BG001, toutes les 5 min)
                                                  ▼
                              projet INTERNE  users/<uid>/clientsweb/state
                                                  │
                        outils/dw-6r2v8k/  ← Jérémie lit, décide, ⚡
                                                  ▼
                              users/<uid>/clientsweb/lancement-<…>
                                                  │
                                    lanceur.py (BG001)
                                                  ▼
                    claude -p  dans  SitesWebClient/<NomDuClient>/
                                                  │
                                    ./deploy.sh  →  site en ligne
                                                  │
                              pont ──▶ demandes/<id>  statut « en_ligne »
                                                  ▼
                                     Le client voit « En ligne »
```

**Rien ne part sur le site d'un client sans que quelqu'un ait lu la demande et
appuyé sur l'éclair.** C'est le point de la conception, pas une étape en trop :
une demande mal comprise appliquée pendant une absence casse un site que
personne ne surveille.

---

## Pourquoi deux projets Firebase

| | Projet | Qui s'y connecte |
|---|---|---|
| Outils internes | `bgtimecalculator` | Jérémie seulement |
| Espace client | **nouveau** | les clients invités |

Les comptes clients n'existent pas dans le projet qui porte la feuille de temps
et le tableau de bord marketing. Ce n'est pas une question de règles bien
écrites : c'est qu'il n'y a **rien à atteindre**.

Le prix de ce cloisonnement : BG001 a deux identités (deux comptes de service)
et un pont pour relier les deux mondes. C'est `pont_clients.py`.

Conséquence heureuse : la vue de Jérémie reste une lecture
`users/<son-uid>/…`, donc la même règle éprouvée que ses autres outils.
**Aucune règle inter-utilisateurs n'existe nulle part**, et le principe
d'anti-verrouillage des outils internes reste entier.

---

## Installation

### Étape 1 — Créer le projet Firebase

1. <https://console.firebase.google.com> → **Ajouter un projet**.
   Nom suggéré : `bg-espace-client`. Google Analytics : **non**.
2. **Build → Firestore Database → Créer une base de données**, mode
   **production**, région `northamerica-northeast1` (Montréal).
3. **Paramètres du projet → Vos applications → Web (`</>`)** → enregistrer
   l'app. Copier l'objet `firebaseConfig` affiché.
4. Coller ces valeurs dans **`js/firebase-config.js`**.

> Tant que ce fichier n'est pas rempli, la page affiche « Installation en
> cours » au lieu de planter : elle peut donc être publiée avant que le projet
> existe.

### Étape 2 — Brancher la connexion Microsoft

1. **Entra ID → Inscriptions d'applications → Nouvelle inscription**.
   Nom : « Espace client BG ». Comptes pris en charge :
   **Comptes dans cet annuaire organisationnel uniquement** (locataire unique).
   URI de redirection (Web) : `https://<projet>.firebaseapp.com/__/auth/handler`
2. **Certificats et secrets → Nouveau secret client**. Copier la valeur
   *tout de suite* : elle ne se réaffiche jamais.
3. Firebase → **Authentication → Sign-in method → Microsoft** : activer, coller
   l'ID d'application et le secret.
4. **Authentication → Settings → Domaines autorisés** : ajouter
   `bginformatique.ca`. Retirer ce qui n'a rien à y faire — tout domaine
   inconnu permettrait à un clone d'hameçonnage de lancer la vraie connexion.

> Le verrou du locataire est **là**, dans « locataire unique », et nulle part
> ailleurs. Les règles Firestore ne peuvent pas le vérifier : le paramètre
> `tenant` part vers Microsoft et n'entre pas dans le jeton Firebase.

### Étape 3 — Inviter un client

**Entra ID → Utilisateurs → Nouvel utilisateur → Inviter un utilisateur
externe.** Le client garde son propre courriel, son mot de passe et sa MFA ;
aucune licence n'est requise.

Il reçoit une invitation Microsoft, l'accepte une fois, puis se connecte à
l'espace client. C'est **l'invitation qui fait la porte** : personne hors du
locataire ne peut entrer.

Récupérer ensuite son **UID Firebase** : Firebase → **Authentication → Users**,
après sa première connexion. C'est cet UID qui va dans la table de BG001
(étape 5).

### Étape 4 — Publier les règles

Coller `firestore.rules` (ce dossier) dans **Console → Firestore Database →
Règles**. Avant de publier, le **simulateur** — cinq essais :

| Opération | Chemin | Attendu |
|---|---|---|
| `create` comme uid A, avec `clientUid: A` et `statut: "recue"` | `demandes/x` | **autorisé** |
| `create` comme uid A avec `clientUid: B` | `demandes/x` | **refusé** |
| `create` comme uid A avec `statut: "en_ligne"` | `demandes/x` | **refusé** |
| `get` comme uid B sur un document de A | `demandes/x` | **refusé** |
| `get` non authentifié | `demandes/x` | **refusé** |

Si un essai « autorisé » échoue : ne pas publier. Si un essai « refusé »
passe : ne pas publier.

> Le retour arrière tient en une minute : Règles → **historique des versions**.

### Étape 5 — Le pont sur BG001

1. Firebase (projet clients) → **Paramètres → Comptes de service → Générer une
   nouvelle clé privée**. Déposer le fichier en
   `~/.config/bg-lanceur/cle-sa-clients.json`, puis `chmod 600`.
2. Ce compte de service doit avoir le rôle **`datastore.user`** (console Google
   Cloud → IAM), rien de plus.
3. Remplir `~/.config/bg-lanceur/clients-web.json` : `projet_clients`, puis une
   entrée par client (UID Firebase → nom de dossier).
4. Essai à blanc, qui n'écrit rien :

   ```
   python3 ~/"Bureau/BG Informatique/Claude_Lanceur/pont_clients.py" --essai
   ```

5. Installer le service :

   ```
   cp ~/"Bureau/BG Informatique/Claude_Lanceur/bg-pont-clients.service" \
      ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now bg-pont-clients.service
   ```

### Étape 6 — Le bloc de règles de l'outil interne

Le miroir écrit dans `users/<uid>/clientsweb/…` du projet **interne**. Publier
le bloc `clientsweb` ajouté à `outils/tc-9x2k7m/firestore.rules`, en suivant
`outils/tc-9x2k7m/SECURITE-FIRESTORE.md`. Tant qu'il n'est pas en ligne,
l'outil `dw-6r2v8k` affiche « Lecture refusée ».

### Étape 7 — Le lanceur

`~/.config/bg-lanceur/config.json` contient déjà `clientsweb` dans
`collections`. Redémarrer le lanceur **quand rien ne tourne** :

```
systemctl --user restart bg-lanceur.service
```

---

## Données

Un document par demande, collection racine `demandes` :

```jsonc
{
  "clientUid": "…",        // qui — vérifié par les règles à la création
  "clientNom": "…",
  "clientCourriel": "…",
  "type": "…",             // catégorie choisie dans le menu
  "urgence": "…",
  "page": "…",             // facultatif
  "description": "…",      // le texte du client, ≤ 5000 caractères
  "statut": "recue",       // recue · analyse · en_cours · en_ligne · refusee · annulee
  "creeLe": <timestamp>,
  "reponse": "…"           // écrit par BG001 seulement
}
```

**Le client ne peut poser que les champs de la première moitié.** Le statut
d'avancement et la réponse appartiennent à BG001 : les règles refusent qu'un
navigateur les écrive, et une demande déjà prise en charge ne se modifie plus.

Collection racine plutôt que sous-collection de `users/` : le pont doit lire
toutes les demandes en une requête, sans parcourir les comptes un par un. Le
cloisonnement ne vient donc pas du chemin mais du champ `clientUid`, vérifié à
la création **et** à la lecture.

---

## Ce que cette page ne fait pas

- **Elle n'envoie aucun courriel.** Le suivi remplace l'accusé de réception :
  le client voit son état changer.
- **Elle ne montre jamais la sortie de Claude.** Un résultat de lancement peut
  contenir des chemins, des noms de dépôts, des notes de travail. Le pont
  traduit un statut en phrase fixe ; le seul texte libre qu'un client reçoit
  est celui que Jérémie écrit dans « Marquer à revoir ».
- **Elle ne connaît aucun dépôt.** La table qui relie un compte à un dossier
  vit sur BG001. Une page web ne désigne pas le dépôt sur lequel la machine
  travaille.

---

## Déployer

Depuis la racine du dépôt, en ne commitant que cette zone :

```
./deploy.sh "espace client : …" --seulement espace-client
```

Sans `--seulement`, le script refuse dès que d'autres zones du dépôt ont des
modifications en attente — c'est ce qui empêche d'emporter le chantier d'un
autre outil dans le même commit. `--essai` montre tout sans rien écrire.

> GitHub Pages publie le dépôt **entier** depuis `main`. La portée décide de
> ce qu'on **commite**, pas de ce qui part en ligne : tout ce qui est déjà
> commité est déjà servi.
