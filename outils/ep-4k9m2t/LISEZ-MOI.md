# BGFoods — circulaires et listes d'épicerie

**https://bginformatique.ca/outils/ep-4k9m2t/** — page cachée, `noindex, nofollow`,
absente du sitemap et volontairement absente de `robots.txt` (y déclarer un chemin
revient à l'annoncer).

Outil interne de **BG Informatique**. On y injecte les circulaires de la semaine, et
il en sort une liste d'épicerie qui retient, pour chaque article, l'épicerie la moins
chère. Aucun serveur : tout le calcul se fait dans le navigateur.

Créé le 11 août 2026, sur le patron de TimeCalculator (`outils/tc-9x2k7m`).

---

## Ce qui est partagé avec les autres outils

| Élément | Détail |
|---|---|
| Projet Firebase | `bgtimecalculator` — même `js/firebase-config.js` |
| Connexion | Microsoft / Entra ID, locataire unique `9e6d32d9-…` |
| Règles Firestore | `outils/tc-9x2k7m/firestore.rules`, **bloc `BGFOODS`** |
| Déploiement | `./deploy.sh` à la racine du dépôt |

**Chemin Firestore : `users/<uid>/bgfoods/state`.** Distinct de
`users/<uid>/timecalculator/state` et de `users/<uid>/marketing/state` : les trois
outils ne se voient pas et ne peuvent pas s'écraser.

> ⚠️ **Les règles doivent être publiées avant que la synchro fonctionne.** Firebase ne
> lit pas ce dépôt. Coller `outils/tc-9x2k7m/firestore.rules` dans Console → Firestore
> Database → Règles, en suivant `outils/tc-9x2k7m/SECURITE-FIRESTORE.md`. Tant que le
> bloc `BGFOODS` n'est pas en ligne, la connexion réussit mais la lecture est refusée —
> l'outil l'affiche en clair et continue de fonctionner **sur l'appareil courant**,
> sans synchro.
>
> C'est un **ajout** : les blocs TimeCalculator et MARKETING ne sont pas modifiés.
> Vérification au simulateur : `get users/<uid>/bgfoods/state` authentifié →
> **autorisé** ; non authentifié → **refusé**.

---

## Le parcours

### 1. Injecter — onglet « Circulaires »

Deux entrées : **téléverser** un PDF (lu dans le navigateur par pdf.js, le fichier ne
part nulle part) ou **coller le texte**. L'épicerie et les dates de validité sont
détectées dans le texte; les deux restent modifiables avant l'import.

L'analyseur reconnaît les formats des circulaires québécoises :

| Écrit dans la circulaire | Interprété |
|---|---|
| `Fraises du Québec 454 g 2,99 $` | 2,99 $ — 454 g — 0,66 $/100 g |
| `Poitrines de poulet 8,80 $/kg 3,99 $/lb` | au poids, 3,99 $/lb — 0,88 $/100 g |
| `2/5,00 $ Yogourt Oikos 4 x 100 g` | offre multiple, 2,50 $ l'unité |
| `Céréales 320-500 g 3,49 $ Rég. 5,99 $` | 3,49 $, économie de 2,50 $ |
| `Avocats Hass 99 ¢` | 0,99 $ |
| `Bagels 6 unités 3,49 $` | 0,58 $ l'unité |
| un prix seul sur sa ligne | recollé au libellé voisin |

### 2. Corriger

Chaque aubaine porte un **indice de confiance**; les lignes douteuses sont surlignées.
Tout se corrige dans le tableau — la modification est enregistrée aussitôt et le prix
unitaire recalculé. « Valider en lot » accepte d'un coup ce qui dépasse un seuil.

### 3. Sortir la liste — onglet « Liste d'épicerie »

On écrit ses besoins, un par ligne (`2 lait 2 %`, `poulet (bio)`). L'outil cherche
chaque article dans les circulaires **en vigueur à la date choisie**, compare les
candidats **au prix unitaire** — c'est ce qui rend comparables un 500 g et un 1 kg —
et regroupe par épicerie, avec les totaux et les économies.

Deux réglages : **maximum d'épiceries** (pour ne pas courir la ville) et **aubaines
validées seulement**.

**Générer enregistre aussi la liste sous son nom.** C'est voulu : les cases cochées au
magasin, sur le téléphone, sont celles de la liste préparée à la maison. L'impression
du navigateur donne le PDF.

---

## Structure

```
index.html              une page, trois onglets
css/style.css           palette commune aux outils internes
js/normalisation.js     unités, prix unitaires, appariement des noms
js/analyseur.js         texte de circulaire → aubaines structurées
js/optimiseur.js        meilleur prix, regroupement par épicerie
js/etat.js              registres et fusion multi-appareils
js/lecture-pdf.js       extraction du texte d'un PDF (pdf.js, à la demande)
js/app.js               écran, connexion, Firestore
tests/                  banc d'essai (voir plus bas)
```

Les cinq premiers modules ne touchent ni au DOM ni à Firebase : le banc les importe
et les exécute directement.

---

## Banc d'essai

```bash
./outils/ep-4k9m2t/tests/lancer.sh
```

- `tests/banc.mjs` (node) — 113 vérifications : formats de prix, conversions d'unités,
  appariement des noms, meilleur prix, limite d'épiceries, reconstruction des lignes
  d'un PDF, et **fusion multi-appareils** (les quatre façons de perdre du travail
  entre l'ordinateur et le téléphone).
- `tests/navigateur.mjs` (Playwright) — 29 vérifications sur la page complète, avec
  les bouchons de `tests/bouchons/` à la place de Firebase : connexion, import,
  correction, génération, cases cochées, écriture Firestore, fusion, écran mobile.

Le hook `.githooks/pre-commit` lance le banc dès qu'un fichier de `js/` ou `css/`
entre dans un commit. Sans node, le banc sort en 2 (« n'a pas pu tourner ») et le
commit passe avec un avertissement. Si Chromium se trouve ailleurs que là où
Playwright l'attend : `BGFOODS_CHROMIUM=/chemin/vers/chrome`.

---

## Points à connaître

- **pdf.js vient d'un CDN** (`cdn.jsdelivr.net`, version épinglée dans
  `js/lecture-pdf.js`), chargé seulement au premier import de PDF. Sans réseau, ou si
  le CDN change, l'outil le dit et propose de coller le texte. Pour changer de
  version, modifier les **deux** liens ensemble — la bibliothèque refuse un worker
  d'une autre version — et repasser une vraie circulaire dans l'outil.
- **Les circulaires des grandes bannières sont faites d'images, et rien ne les lira.**
  Mesuré sur la circulaire IGA du 6 au 12 août 2026 : 8 pages, dont une seule portant
  du texte — la ligne des dates. L'outil le reconnaît (`enImages()`), le dit, et
  reporte l'épicerie et les dates dans le formulaire pour la saisie à la main.

  L'OCR a été essayé et **écarté sur mesure**, pas par principe : page rendue à
  300 dpi, coupée en deux pour ne pas lire en travers des colonnes, tesseract en mode
  « texte épars » → 6 285 caractères en 1 270 lignes, et **2 aubaines reconnues, toutes
  deux fausses** (« Panier 13 Asset Ré. 6498 à » à 895,00 $). Les gros prix à cents en
  exposant ressortent détachés de leur produit. tesseract.js dans le navigateur
  donnerait la même chose, en dix mégaoctets et deux minutes par circulaire — pour des
  prix inventés dans une comparaison censée faire économiser.

  Les agrégateurs (circulaires.com) n'aident pas : ils servent les mêmes images dans
  une visionneuse, sans données de produit.

  Ce qui marche : le site des bannières (`iga.net`, `metro.ca`, `provigo.ca`…) publie
  la circulaire en HTML, texte sélectionnable — copier-coller dans « Coller le texte ».
  Ou saisir à la main les quelques articles qui comptent, une ligne chacun.
- **Les formats variables** (« 320-500 g ») sont ramenés à la borne basse : le prix
  unitaire affiché est donc prudent, jamais flatteur.
- **Les prix affichés viennent des circulaires importées** et doivent être confirmés
  en magasin.
- Une circulaire importée **sans dates** prend la semaine en cours. Si on colle une
  circulaire annonçant d'autres dates, les saisir avant l'import — sinon elle ne
  ressortira pas dans une liste datée hors de cette semaine.
