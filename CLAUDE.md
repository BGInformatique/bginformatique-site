## Déploiement
Après chaque modification validée, publie en lançant `./deploy.sh "message"`.
Ne pas proposer de commit manuel ni de PR — utiliser le script uniquement.

`deploy.sh` refuse de publier si le lot touche **plusieurs zones** du dépôt
(la racine, `espace-client/`, chaque `outils/<slug>/`). C'est voulu : sans
cette garde, un `git add .` emporte le chantier en cours d'un autre outil dans
le même commit, et il part en ligne.

Quand ça arrive, ne pas forcer par réflexe — regarder ce qui traîne, puis :

```
./deploy.sh "message" --seulement espace-client      # ne commiter que cette zone
./deploy.sh "message" --tout                         # publier tout, en connaissance de cause
./deploy.sh "message" --essai                        # tout montrer, ne rien écrire
```

Le script refuse aussi, sans appel, un fichier qui n'a rien à faire dans un
dépôt public : `amorce-*.json`, clé de compte de service, `.env`, état exporté
(repéré au contenu, pas au nom), fichier de plus de 25 Mo.

`outils/mk-7p3w9d/` a son propre déployeur, plus étroit encore, qui lance en
plus son banc d'essai : `./outils/mk-7p3w9d/deployer.sh "message"`.

## Entête et pied de page : ne pas les éditer dans les pages

Ils sont recopiés dans 45 fichiers, et c'est là que naît la divergence : une
page garde l'ancien numéro ou l'ancienne promesse pendant des mois sans que
personne ne le voie. La source de vérité est `_gabarits/` — quatre fragments,
deux familles (`residentiel`, `entreprises`). La famille d'une page se lit sur
la classe de son propre entête, jamais sur son chemin : des pages de la racine
appartiennent à l'une ou à l'autre, et c'est voulu.

```
./generer-gabarit.py --essai      # ce qui a dérivé (retour 1 s'il en reste)
./generer-gabarit.py --diff       # ligne à ligne, ce qui changerait
./generer-gabarit.py              # aligner toutes les pages
```

Corriger une phrase du menu ou du pied = modifier **un** fragment de
`_gabarits/`, puis lancer le script. Ne jamais faire un balayage à la main sur
les 45 pages : c'est ce que ce montage remplace.

`aria-current="page"` n'est pas dans le gabarit — le script le repose sur le
bon lien, à l'intérieur du `<nav>` seulement. Un article `blogue-*.html` marque
l'index `blogue.html` de sa section.

Les exceptions portent sur la **balise**, pas sur la page : `index.html` de la
racine est hors gabarit en entier (page d'aiguillage, sans navigation), mais
`404.html` n'excepte que son `<footer>` — son entête reste aligné. Exclure une
page en entier la laisse dériver. `deploy.sh` rappelle la dérive sans bloquer.

Attention au nom : l'exception se déclare par le **chemin complet**.
`index.html` seul excepterait aussi `residentiel/index.html` et
`entreprises/index.html`, qui sont des pages ordinaires.

## Règles Firestore
Elles ne se déploient **pas** avec le site : Firebase ne lit pas ce dépôt.
Après toute modification d'un `firestore.rules`, le publier en console —
voir `outils/tc-9x2k7m/SECURITE-FIRESTORE.md`.
