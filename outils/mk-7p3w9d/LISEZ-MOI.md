# Tableau de bord marketing

**https://bginformatique.ca/outils/mk-7p3w9d/** — page cachée, `noindex, nofollow`,
absente du sitemap et volontairement absente de `robots.txt` (y déclarer un chemin
revient à l'annoncer).

Outil interne de **BG Informatique**. Il pilote plusieurs mandats à la fois : chaque
tâche porte un client, et les compteurs suivent le filtre. Aucun nom de mandat n'est
écrit dans ce dépôt — il est public.

Créé le 30 juillet 2026, sur le patron de TimeCalculator (`outils/tc-9x2k7m`).

---

## Ce qui est partagé avec TimeCalculator

| Élément | Détail |
|---|---|
| Projet Firebase | `bgtimecalculator` — même `js/firebase-config.js` |
| Connexion | Microsoft / Entra ID, locataire unique `9e6d32d9-…` |
| Règles Firestore | `outils/tc-9x2k7m/firestore.rules`, **bloc `MARKETING`** |
| Déploiement | `./deploy.sh` à la racine du dépôt |

**Chemin Firestore : `users/<uid>/marketing/state`.** Distinct de
`users/<uid>/timecalculator/state` : les deux outils ne se voient pas et ne peuvent
pas s'écraser.

> ⚠️ **Les règles doivent être publiées avant que l'outil fonctionne.** Firebase ne
> lit pas ce dépôt. Coller `firestore.rules` dans Console → Firestore Database →
> Règles, en suivant `outils/tc-9x2k7m/SECURITE-FIRESTORE.md`. Tant que le bloc
> `MARKETING` n'est pas en ligne, la connexion réussit mais la lecture est refusée —
> l'outil affiche alors « Lecture Firestore refusée ».
>
> C'est un **ajout** : le bloc TimeCalculator n'est pas modifié, et deux `match` ne se
> soustraient jamais l'un à l'autre. Le simulateur reste la vérification qui compte,
> avec les cinq essais de `SECURITE-FIRESTORE.md` plus deux pour le marketing :
> `get users/<uid>/marketing/state` authentifié → **autorisé** ; non authentifié →
> **refusé**.

---

## Première utilisation

1. Publier les règles (ci-dessus).
2. Ouvrir l'outil, se connecter avec le compte Microsoft.
3. **Importer** → le fichier d'amorce du mandat, gardé **hors dépôt** dans
   `~/Bureau/BG Informatique/Tableau_de_Bord/amorce-<mandat>.json`.
4. Sur la tuile **STME**, choisir le mandat dont le temps doit compter en STME.

L'import **fusionne**, il n'écrase pas. Une copie de l'état précédent est gardée dans
`localStorage` sous `marketing.v1.avant-import`.

> ⚠️ **Le fichier d'amorce ne vit pas dans ce dépôt, et ne doit jamais y revenir.**
> Il contient l'état interne réel d'un mandat — décisions, chemins de fichiers,
> écarts de conformité. Le dépôt est public et GitHub Pages sert tout ce qu'il
> contient : un `.json` déposé ici serait lisible par quiconque connaît le slug,
> **sans aucune porte** — contrairement à `index.html`, rien ne le protège.
> `.gitignore` bloque `outils/*/amorce-*.json` pour que l'oubli ne soit pas possible.
>
> Même raison pour les **noms de mandats** : aucun n'est écrit dans le code. Ils
> naissent des tâches saisies, la saisie propose les existants, et le mandat suivi en
> STME est un réglage rangé dans le document Firestore — donc privé.

---

## Données

Un seul document Firestore, réécrit en entier à chaque sauvegarde :

```
{ taches: [...], temps: [...], tombstones: {...}, config: {...}, updatedAt }
```

Miroir `localStorage` sous `marketing.v1`, pour l'affichage instantané et le
hors-ligne. Une chaîne illisible est mise en quarantaine
(`marketing.v1.illisible.<horodatage>`) plutôt qu'écrasée.

**Fusion par enregistrement.** Deux appareils modifient la même liste sans se voir :
on ne compare pas les documents entiers, on compare enregistrement par
enregistrement et le `maj` le plus récent gagne. Une suppression laisse une pierre
tombale — sans elle, l'autre appareil ressusciterait l'enregistrement à la synchro
suivante. Les pierres tombales sont élaguées après 90 jours.

**Le piège hérité de TimeCalculator, et évité ici :** hors ligne ou avant la première
réponse du serveur, Firestore livre un instantané venu du cache où le document paraît
inexistant. Amorcer le document à partir de là écrirait un état vide par-dessus les
vraies données. `appliquerInstantane()` n'amorce donc jamais depuis un instantané de
cache (`snap.metadata.fromCache`).

---

## Les compteurs

| Compteur | Ce qu'il mesure |
|---|---|
| **Aujourd'hui** | temps consigné depuis minuit, sur une journée de référence de 8 h |
| **Cette semaine** | depuis lundi |
| **STME — mandat suivi** | temps consigné sur le mandat choisi dans la tuile ÷ 40 h |
| **Plan V5 — accompli** | pourcentage des 2 080 h du plan (52 sem × 40 h) déjà consignées sur le mandat suivi ; le repère sur la jauge marque où le plan attend le compteur aujourd'hui |
| **Rythme** | avance ou retard sur le rythme de 40 h par semaine écoulée depuis la date de début du plan, en STME et en heures |
| **Chantiers ouverts** | tâches non terminées, et la part déjà faite |

La STME (« semaine de travail marketing effectif ») est une unité du **Cahier de
déploiement V5 d'un client**, pas de BG : 40 h de travail effectif, 52 au plan. Un
seul mandat à la fois peut être suivi de cette façon — le sélecteur est dans la tuile,
et le choix est enregistré avec l'état. Le compteur ne mesure que ce qui est réellement
consigné : il ne suit pas le calendrier, et il ignore les autres mandats.

Les tuiles **Plan V5** et **Rythme** rapportent ce même temps consigné au plan entier
(52 sem × 40 h = 2 080 h). La **date de début du plan** se règle dans la tuile Rythme
(champ date, rangé dans `config.debutPlan` — donc privé, comme le mandat suivi).
L'« attendu » avance de 40 h par semaine écoulée depuis cette date, au prorata du
jour, plafonné à 2 080 h. Comme les compteurs ne voient que le consigné, du travail
fait **avant** l'outil se rattrape par une entrée de temps manuelle en bloc (bouton
« + » d'une tâche) — c'est le cumul qui compte, pas la date de l'entrée.

---

## Lancements Claude sur BG001

Chaque tâche porte un bouton **éclair** : il dépose une demande d'exécution que la
machine BG001 ramasse et confie à `claude -p` (mode sans interface,
`--permission-mode acceptEdits`). La progression et le résultat reviennent dans
l'outil, en direct, y compris depuis un téléphone.

**Documents** : `users/<uid>/marketing/lancement-<horodatage>-<aléa>` — même
sous-collection que `state`, donc couverts par le même bloc de règles (propriétaire
seul, pas de suppression navigateur). Champs écrits par l'outil : `idTache`,
`titre`, `detail`, `client`, `chantier`, `statut: "demande"`, `demandeLe`. Champs
écrits par le lanceur : `statut` (`en_cours`, `fait`, `echec`), `debuteLe`,
`finiLe`, `resultat`, `erreur`, `coutUsd`, `tours`.

**Annulation (activation accidentelle)** : tant qu'un lancement est « demandé »
ou « en cours », le même bouton éclair l'annule (`statut: "annule"`, écrit par
l'outil). Le lanceur vérifie ce statut avant la prise en charge **et toutes les
15 s pendant l'exécution** : il interrompt alors le processus Claude. Un
lancement annulé n'est jamais requalifié `fait`, même si le travail venait de
se terminer.

**Côté BG001, hors dépôt** : `~/Bureau/BG Informatique/Claude_Lanceur/lanceur.py`,
service systemd `bg-lanceur.service` (utilisateur, `linger` actif — il tourne sans
session ouverte et survit aux redémarrages). Identité : compte de service
`lanceur-marketing@bgtimecalculator` limité au rôle `datastore.user`, clé dans
`~/.config/bg-lanceur/`. L'accès serveur ignore les règles Firestore ; c'est lui qui
purge les lancements terminés après 30 jours. L'outil web reste pleinement utilisable
si le lanceur est éteint — les demandes attendent en file.

L'interrogation de la file ne renvoie que les documents au `statut` « demande » :
`state` n'a pas ce champ et n'est jamais relu par le lanceur.

---

## Page « Lot LinkedIn » (`linkedin.html`)

Le bouton éclair d'une tâche du chantier **LinkedIn** ne lance pas Claude : il
mène à `linkedin.html` — toutes les publications du lot sur **une seule page**,
un bouton **Copier** par texte (à coller tel quel dans LinkedIn), une case
**Publié** et un compteur d'avancement.

**Données** : `users/<uid>/marketing/linkedin-lot` — les textes ne vivent que
dans Firestore, derrière la connexion Microsoft, jamais dans ce dépôt (public).
Le lot se verse depuis BG001 (le fichier maître reste dans le dossier du
mandat, hors dépôt).

**Consignation automatique** : marquer « Publié » déclenche, côté BG001, le
passage de la ligne du journal TSV du mandat de `lot_livre` à `utilise`
(copie `.bak` avant chaque écriture), puis le lanceur confirme dans le document
(`consigne: true` — la page n'écrit jamais ce champ à true, elle affiche
« consignation en attente… » tant que BG001 n'a pas confirmé).

- **Exporter (TSV)** — tâches et temps, au format des journaux de suivi d'un
  dossier client (`_Journal_*.tsv` et compagnie). C'est ce qui permet de reverser
  l'état d'un mandat chez le client.
- **Sauvegarde (JSON)** — l'état complet, réimportable tel quel.

Les règles Firestore ne valident pas le contenu écrit : un bogue ou un jeton volé
peut écraser l'état. Les filets réels sont ces exports, le `localStorage` de chaque
appareil, et la fusion par enregistrement.

---

## Banc d'essai

```
./outils/mk-7p3w9d/tests/lancer.sh          # gjs + python3
```

Trois contrôles, tous sur le vrai `js/app.js`, jamais sur une copie :

1. **Syntaxe** du module, imports retirés.
2. **Constantes orphelines** (`tests/constantes.py`) — une constante retirée dont un
   appel subsiste compile sans broncher et ne plante qu'à l'exécution. C'est arrivé
   avec la constante qui portait le mandat par défaut : la déclaration partait, un
   appel restait, et toute création de tâche aurait planté en ligne.
3. **Fusion multi-appareils** (`tests/fusion.js`) — 17 essais sur la perte de données
   silencieuse : ajout croisé, édition concurrente, résurrection après suppression,
   et l'état vide qui écrase l'autre.

Le hook `.githooks/pre-commit` le lance avant tout commit touchant `js/` ou `css/`,
et lit son **code de sortie** : `0` passé ou sauté, `2` non concluant, autre = échec,
commit refusé. Le banc marketing n'utilise jamais `2` — un échec est un échec.

Filet de rattrapage : `.github/workflows/tests-marketing.yml`, qui **exige** gjs et
python3 sur le runner. Sans cette exigence, un banc sauté rendrait la CI verte sans
rien avoir vérifié.

## Déployer

Cet outil a **son propre script**, distinct du `deploy.sh` du site :

```
./outils/mk-7p3w9d/deployer.sh "ce qui change"
./outils/mk-7p3w9d/deployer.sh --essai     # montre tout, n'écrit rien
```

Ce qu'il fait que `deploy.sh` ne fait pas :

| | `deploy.sh` | `deployer.sh` |
|---|---|---|
| Mise en index | `git add .` — **tout** l'arbre de travail | seulement les chemins de cet outil |
| Banc d'essai | via le hook, donc seulement si `js/` ou `css/` bouge | **toujours**, même pour un changement de `index.html` seul |
| Données de mandat | aucun contrôle | **refuse** de publier un `amorce-*.json` ou un état exporté, même renommé |
| Anti-cache | tous les outils | le sien |
| Branche | fusionne une branche de travail dans `main` | refuse hors de `main` — renvoie à `deploy.sh` |

> **Ce qu'aucun script ne peut faire.** GitHub Pages publie le dépôt **entier**
> depuis `main`. Pousser cet outil publie donc aussi tout ce qui est déjà commité.
> La séparation porte sur ce qu'on **commite**, pas sur ce qui part en ligne.

`deploy.sh` continue de gérer l'anti-cache de tous les outils, et ce n'est pas
redondant : comme il fait `git add .`, il peut publier cet outil sans que son
déployeur ait été lancé. Sans ça, un JS modifié partirait en ligne sans invalidation
de cache — déployé, mais invisible.

## Vérifier un déploiement

```
./outils/mk-7p3w9d/verifier-deploiement.sh
```

La seule preuve qu'une écriture passe : Console → Firestore →
`users/<uid>/marketing/state` → `updatedAt` correspond à l'instant de la
modification. Si la mention « Synchro : hors ligne » persiste dans le pied de page,
l'écriture est refusée.

---

## Version locale

Une première version tournait sur un serveur Python local, dans le dossier d'un
client. Elle est conservée hors ligne dans
`~/Bureau/BG Informatique/Tableau_de_Bord/` — même modèle de données, sans compte ni
synchronisation. **C'est cette version-ci qui fait foi.**
