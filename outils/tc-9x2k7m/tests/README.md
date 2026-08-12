# Banc d'essai de TimeCalculator

```bash
./outils/tc-9x2k7m/tests/lancer.sh
```

Codes de sortie : `0` tout passe · `1` au moins un échec (ou rapport vide) ·
`2` le banc n'a pas pu tourner. Prérequis : `python3` et `firefox` — ni node,
ni npm, aucune dépendance à installer.

## Ce qui est testé

130 tests en 19 sections : formats et calendrier (y compris les changements
d'heure de mars et novembre), saisie des heures, normalisation des données,
fusion entre appareils (pierres tombales comprises), enregistrement local,
authentification, réception des instantanés Firestore — dont le cas qui a
déjà effacé des données : l'instantané « document inexistant » venu du cache —
punch in/out et punch oublié, formulaires, interventions, filtres, rendu
(échappement XSS compris), exports CSV, rapport hebdomadaire, Rapport Simple — dont ce qu'il ne doit
PAS contenir, et les punchs d'une même journée jamais fusionnés —,
import/export
JSON, deux onglets simultanés, raccourcis clavier, et les interventions
chronométrées : plusieurs chronos à la fois, démarrage au moment présent,
heures conservées au millième, chrono maintenu tant que rien n'est
enregistré, fusion par identifiant, reprise de l'ancien format à un seul
chrono, chrono oublié.

## Comment ça marche

L'application est un module ES : un navigateur refuse de la charger depuis
`file://`, il faut du HTTP. Et elle parle à Firebase, qu'un banc ne doit
jamais toucher. D'où la mécanique :

1. `preparer.py` régénère `genere/` depuis les **vrais** fichiers :
   `banc.html` est l'`index.html` réel où une carte d'imports
   (`<script type="importmap">`) détourne les URL gstatic vers `bouchons/`,
   et `app-instrumente.js` est le `js/app.js` réel + `pont.js` collé à la
   suite, qui expose l'intérieur du module sous `globalThis.__tc`.
   Rien n'est copié à la main : si `app.js` change, le banc suit; si sa forme
   n'est plus reconnue, `preparer.py` échoue bruyamment.
2. `serveur.py` sert le dossier de l'outil sur un port libre et reçoit les
   résultats en `POST /__resultats`.
3. `lancer.sh` ouvre la page dans Firefox sans écran (profil jetable,
   `TZ=America/Toronto`), attend `genere/resultats.json`, l'affiche et fixe
   le code de sortie.

Si la page casse avant même de tester (erreur de syntaxe dans un module,
symbole du pont disparu d'`app.js`), un filet dans `banc.html` envoie quand
même les erreurs capturées après 20 s : l'échec est toujours nommé, jamais
silencieux.

## Où le banc est lancé

- **Barrière locale** : le hook `.githooks/pre-commit` le lance avant tout
  commit touchant `js/` ou `css/` de l'outil, et refuse le commit s'il
  échoue (`git commit --no-verify` pour passer outre une fois).
- **Alarme infonuagique** : `.github/workflows/tests-timecalculator.yml` le
  relance après chaque push touchant l'outil — utile quand le commit vient
  d'un poste sans Firefox.

## Diagnostic manuel

```bash
python3 tests/preparer.py
python3 tests/serveur.py   # note le port affiché
# puis ouvrir http://127.0.0.1:<port>/tests/genere/banc.html
```

Le tableau des résultats s'affiche en bas de page; la console du navigateur
montre les erreurs. `genere/` est régénéré à chaque exécution et ignoré par
git — n'y modifier jamais rien à la main.

## Données d'essai

Le dépôt est public : ce dossier ne doit JAMAIS contenir de vrais noms de
clients, numéros de billets ou descriptions de travaux. Tout est fictif et
doit le rester.
