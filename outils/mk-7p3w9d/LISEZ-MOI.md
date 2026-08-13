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
`users/<uid>/timecalculator/state` : les deux outils ne se voient pas et ne
peuvent pas s'écraser. (Une lecture croisée du time-tracker a existé quelques
heures le 31 juillet pour une charte marketing vs N2, retirée le soir même
avec le recentrage sur les tâches.)

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
   `~/Bureau/BG Informatique/Tableau_de_Bord/amorce-<mandat>.json`. Le mandat
   par défaut à la saisie naît des tâches importées (`config.mandatStme`).

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

## Recentrage du 31 juillet 2026 : un tableau de bord de TÂCHES

Décision de Jérémie, le 31 juillet au soir : **plus de statistiques à l'écran.**
Les sept tuiles (Aujourd'hui, Cette semaine, STME, Plan V5, Rythme, Formation
technique, Chantiers ouverts) et les deux chartes hebdomadaires, ajoutées le
même jour, ont été retirées de l'interface — le code reste dans l'historique
git si le besoin revient.

Ce qui reste, et c'est le cœur : les deux colonnes de tâches (épinglées
aujourd'hui / tous les chantiers), l'ajout rapide, les filtres par mandat,
chantier et statut, un **filtre texte** (titre, détail, source, mandat), le
minuteur et la consignation de temps par tâche avec le journal du jour, la
modale d'édition, et toute l'automatisation : bouton éclair (Claude sur BG001),
page « Lot LinkedIn », tâches déposées chaque lundi par le prospecteur.

## Volet Prospection (1er août 2026)

En tête de page, une liste serrée — une **ligne** par prospect (tableau dense,
texte brut, demandé le 3 août : utilité d'abord, pas de décor) : état de la
cadence, relances faites,
prochaine action. Les données viennent du **miroir** que le prospecteur de
BG001 publie dans `users/<uid>/marketing/prospection` (même sous-collection,
donc mêmes règles que `state` — rien à republier en console ; aucun nom de
prospect dans le code, le dépôt est public). La source de vérité reste le
journal TSV du dossier de prospection, hors dépôt.

- **L'entonnoir du plan « Entonnoir 24 »** (9-10 août 2026) coiffe le volet :
  six étages (contactés → joints → répondus → RDV → clients → **revenu**
  facturé/carnet en dollars réels), la **phase courante du plan** (dates
  codées : armement → sprint → closing → croisière), les **quatre compteurs de
  gestes** de la semaine (appels · envois · pubs · avis, boutons +1), le
  bouton **« Relevé du vendredi »** (photographie horodatée ajoutée à
  `releves`) et la saisie de revenu. Données dans le document
  `marketing/prospection` : `gestes`, `revenus`, `releves` appartiennent à la
  page ; `appels` est une **boîte de dépôt** que le prospecteur consomme
  (compteurs APPELS au journal TSV, statut `injoignable` après 3 tentatives
  sans joint), puis vide. Le prospecteur pousse désormais son miroir **avec
  updateMask** — il ne touche jamais aux champs de la page.
- **Cliquer le nom** (souligné pointillé) déplie la **fiche contact** sous la
  ligne : contact, téléphone (lien `tel:` — l'appel est le canal priorisé),
  courriel (`mailto:`), site — plus le compteur de tentatives et les boutons
  **« consigner l'appel »** (joint / boîte vocale / sans réponse), qui
  alimentent l'entonnoir et les gestes à la seconde. Les coordonnées viennent
  des colonnes CONTACT / TELEPHONE / COURRIEL / SITE du journal TSV, via le
  miroir (7 août 2026).
  La fiche vaut aussi dans l'**inventaire** : une entrée en cadence emprunte
  la fiche du journal, les autres montrent ce que l'inventaire sait
  (colonnes TELEPHONE / COURRIEL / CONTACT de `_Inventaire.tsv`).
- **Cliquer le reste de la ligne** filtre la liste des tâches sur ce prospect —
  le brouillon de relance est là.
- **« Signaler… »** (répondu, RDV fixé, client, dormance, réactiver) écrit un
  signal dans le miroir ; le prospecteur l'applique au journal TSV au cycle
  suivant, puis l'efface. Un signal prime sur la cadence — un prospect qui a
  répondu ne sera plus relancé.
- La carte sait aussi montrer, avant même le prochain cycle, qu'une relance
  marquée faite est **envoyée** (croisement avec la tâche liée).

**Le modèle de données ne change pas.** Les entrées de temps,
`config.mandatStme` et `config.debutPlan` restent stockés, fusionnés entre
appareils et présents dans les exports TSV/JSON — seul l'affichage a été
retiré. La décision 10 du `Journal_Decisions.md` du mandat (25 % effectif /
75 % formation technique) reste une règle de lecture des heures ; elle n'est
simplement plus calculée ici. Le mandat proposé par défaut à la saisie vient
toujours de `config.mandatStme`, puis du mandat le plus fréquent.

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
écrits par le lanceur : `statut` (`en_cours`, `fait`, `echec`,
`attente_autorisation`, `refuse`), `debuteLe`, `finiLe`, `resultat`, `erreur`,
`coutUsd`, `tours`.

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

### Arrêt sur autorisation (12 août 2026)

Une tâche lancée ne se termine plus « faite » quand elle bute sur un geste qui
n'appartient qu'au propriétaire. Quatre cas, écrits dans le cadre de
`lanceur.py` (jamais reçus d'un document) : **geste** hors de portée (connexion
interactive, console, vérification par téléphone), **publication** ou envoi réel
vers l'extérieur, **dépense** ou engagement, **décision** de fond qui contredit
une décision plus récente. La tâche livre alors tout ce qu'elle a pu préparer,
puis termine sa réponse par un bloc `=== AUTORISATION REQUISE ===`
(`CATEGORIE`, `DEMANDE`, `POURQUOI`, `OPTIONS`, `PRET`, `OU`, `QUAND`, puis
`--- TEXTE A COLLER ---`).

**Le texte prêt à coller voyage AVEC la demande, jamais en fichier.** Le geste
se fait à la main, souvent depuis un téléphone : un chemin de fichier n'y sert à
rien. La tâche met donc l'endroit exact (`OU`), le moment ou la condition à
lever (`QUAND`), puis le texte intégral sous `--- TEXTE A COLLER ---`, tel qu'il
doit être collé. Il ressort à trois endroits : dans la carte (bloc
sélectionnable d'un doigt), dans `autorisations.py voir <n>`, et dans le dossier
`.md` déposé. La règle vaut aussi quand le mur est externe et qu'aucun accord ne
le lève (compte verrouillé, service en panne) : le geste attendra, le texte est
prêt.

Le lanceur lit ce bloc et met le document au statut **`attente_autorisation`** —
un statut qui n'est pas terminal : la purge des 30 jours l'épargne. Champs
ajoutés : `autorisationDemande`, `autorisationCategorie`, `autorisationPourquoi`,
`autorisationOptions`, `autorisationPret`, `autorisationTexte`,
`autorisationOu`, `autorisationQuand`, `autorisationLe`, `autorisationTours`,
`autorisationFichier`. La demande est aussi déposée en clair dans
`Claude_Lanceur/autorisations/<date>-<tâche>.md`, avec le résultat complet.

Dans la carte, la question reste lisible **carte fermée** (bloc `.cl-autor`), et
l'éclair abandonne le lancement au lieu d'en ouvrir un second. La réponse se
donne sur le poste, depuis une session Claude interactive :

```
autorisations.py                      ce qui attend une réponse
autorisations.py voir <n>             la demande au complet
autorisations.py accorder <n> "…"     accorde et remet la tâche en file
autorisations.py refuser <n> "…"      refuse ; statut « refuse », terminal
```

### Répondre à une réponse rendue (12 août 2026)

Une tâche qui a rendu se discute : le bouton **↩** de la carte (visible dès
qu'un lancement est `fait` ou `echec`) demande ce qui doit changer et renvoie le
**même** document au lanceur — `correction`, `resultatPrecedent`, statut
`demande`. Rien n'est relancé à neuf : la tâche revoit un extrait de sa réponse
précédente, reçoit la correction du propriétaire (qui prime sur le `detail`
d'origine partout où les deux se contredisent) et reprend son travail au lieu
de le refaire. Les livrables déjà déposés se modifient sur place.

Le lanceur archive chaque correction jouée dans le tableau `corrections` puis
vide `correction` — sans quoi la reprise suivante la rejouerait par-dessus un
travail déjà corrigé. Les trois dernières restent rappelées à chaque tour :
une correction ne se perd pas au tour d'après. Même geste depuis le poste :

```
autorisations.py reponses             les tâches qui ont rendu, récentes
autorisations.py lire <n>             la réponse au complet
autorisations.py corriger <n> "…"     relance avec la correction
```

Accorder remet le document à `demande` : la tâche repart du début avec la
réponse en tête du prompt et son travail préparatoire déjà dans `Livrables/`.
Une autorisation dit oui à **un geste nommé** ; elle n'élargit jamais le cadre.
Une tâche peut redemander après un accord (`autorisationTours` monte) — c'est
légitime une fois, et le signe qu'il faut refuser ou revoir la tâche ensuite.

---

## Page « Ma journée » (`jour.html`)

L'écran « quoi faire aujourd'hui », calculé de la date — bouton « Ma journée »
dans l'entête du tableau de bord. Quatre sections, dans l'ordre d'attaque :

| Section | Contenu |
|---|---|
| **En retard** | tâches échues, épinglées restées d'un jour précédent |
| **Aujourd'hui** | rituels du jour (lundi : brouillons du prospecteur ; jeudi : candidats du recherchiste ; vendredi : statistiques et point de semaine), publication LinkedIn du jour ouvrable, brouillons de prospection à envoyer, épinglées et échéances du jour |
| **À trier** | candidats de l'engin en attente, tâches bloquées à revoir |
| **Cette semaine** | échéances des 7 prochains jours |

Lecture seule, en direct (mêmes documents Firestore que le tableau de bord —
`state`, `prospection`, `linkedin-lot`). Chaque élément mène au bon endroit :
une tâche ouvre le tableau de bord **préfiltré** sur elle (`./#q=<titre>`),
la publication ouvre la page du lot.

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

---

## Cloisonnement par mandat

L'outil pilote plusieurs mandats. Le mandat est un **contexte**, pas un filtre : il vit
en haut de chaque page, il survit au rechargement, et il se propage d'un onglet à
l'autre (`js/mandat.js`, `localStorage` sous `marketing.v1.mandat`). Chaque mandat a
**chacune des sections**, avec ses propres données.

| Section | Document | Cloisonnement |
|---|---|---|
| Tâches, temps, compteurs | `marketing/state` | Exact — chaque tâche porte un `client` |
| Veille de prospection | `marketing/veille` | Exact — chaque piste et chaque groupe portent un `mandat` |
| Miroir de prospection | `marketing/prospection` | **Approché** — voir le contrat ci-dessous |
| Lot LinkedIn | `marketing/linkedin-lot` | **Approché** — voir le contrat ci-dessous |

### Le contrat attendu des processus de BG001

`marketing/prospection` et `marketing/linkedin-lot` sont écrits par le prospecteur et le
lanceur de BG001, hors de ce dépôt. L'outil web ne peut pas les cloisonner exactement
tant qu'ils ne disent pas à quel mandat chaque enregistrement appartient.

En attendant, la page filtre sur l'appartenance du **document entier**, déduite de
`config.mandatStme`. C'est suffisant tant qu'un seul mandat est prospecté, et faux dès
qu'il y en a deux.

**Pour rendre le cloisonnement exact, il suffit d'un champ — aucun changement de chemin,
aucune règle Firestore à republier :**

```jsonc
// marketing/prospection
{ "mandat": "…",            // facultatif : appartenance du document entier
  "prospects": [ { "id": "…", "mandat": "…", … } ] }   // ← le champ qui compte

// marketing/linkedin-lot
{ "mandat": "…",
  "posts": [ { "n": 1, "mandat": "…", … } ] }          // ← idem
```

La page lit `enregistrement.mandat` en priorité et retombe sur celui du document.
**Le jour où le champ apparaît, le cloisonnement devient exact sans toucher au code
web** — et tant qu'il n'apparaît pas, rien ne casse.

### Deux règles de conduite dans le code

- **Une section vide reste visible.** Cacher une section parce qu'elle n'a rien pour le
  mandat courant fait chercher une fonctionnalité qui existe pourtant, et donne
  l'impression que l'outil est cassé. On affiche l'état vide, et on dit où sont les
  données.
- **En cas d'appartenance inconnue, on montre.** Cacher à tort coûte plus cher que
  montrer à tort — sauf sur le lot LinkedIn, où publier au nom de la mauvaise entreprise
  est l'erreur la plus coûteuse : là, un doute suffit à ne rien afficher.

Le banc `tests/mandat.js` fige cette table de vérité.
