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
| **Chantiers ouverts** | tâches non terminées, et la part déjà faite |

La STME (« semaine de travail marketing effectif ») est une unité du **Cahier de
déploiement V5 d'un client**, pas de BG : 40 h de travail effectif, 52 au plan. Un
seul mandat à la fois peut être suivi de cette façon — le sélecteur est dans la tuile,
et le choix est enregistré avec l'état. Le compteur ne mesure que ce qui est réellement
consigné : il ne suit pas le calendrier, et il ignore les autres mandats.

---

## Filet de sécurité

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
3. **Fusion multi-appareils** (`tests/fusion.js`) — 15 essais sur la perte de données
   silencieuse : ajout croisé, édition concurrente, résurrection après suppression,
   et l'état vide qui écrase l'autre.

Le hook `.githooks/pre-commit` le lance avant tout commit touchant `js/` ou `css/`,
et lit son **code de sortie** : `0` passé ou sauté, `2` non concluant, autre = échec,
commit refusé. Le banc marketing n'utilise jamais `2` — un échec est un échec.

Filet de rattrapage : `.github/workflows/tests-marketing.yml`, qui **exige** gjs et
python3 sur le runner. Sans cette exigence, un banc sauté rendrait la CI verte sans
rien avoir vérifié.

## Vérifier un déploiement

```
./deploy.sh "Tableau de bord marketing : <ce qui change>"
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
