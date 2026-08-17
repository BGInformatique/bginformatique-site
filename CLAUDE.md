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

## La bibliothèque : une liste CLOSE de guides, pas un blogue

Il n'y a plus de blogue. Un blogue est un flux — il faut le nourrir, il grossit
sans fin, et le même sujet finit traité deux fois à deux profondeurs. C'était
déjà le cas : la section « hameçonnage » du Centre d'aide (594 octets) doublait
l'article sur le faux soutien technique (14 Ko).

La liste des sujets est arrêtée dans `_bibliotheque/sujets.tsv` : **14 guides**,
un par vraie question, tirés des services que le site vend et des questions du
Centre d'aide. On **met à jour** une page ; on n'en ajoute pas une deuxième sur
le même sujet.

```
./generer-bibliotheque.py --etat     # ce qui est écrit, ce qui reste
./generer-bibliotheque.py --essai    # ce qui changerait
./generer-bibliotheque.py            # index × 2 + sitemap + Centre d'aide
```

**Écrire un nouveau guide** = passer un sujet du registre à `ETAT=ecrit` avec son
`FICHIER`, puis lancer le script. **Un sujet qui n'est pas au registre n'existe
pas** : `deploy.sh` refuse de publier un `blogue-*.html` inconnu, parce qu'une
page absente de l'index et du sitemap est publiée pour rien.

Le titre, la description, la date et le temps de lecture sont lus **dans la
page** — le registre porte le plan, la page porte la vérité. Le champ `ANCRES`
relie un guide aux questions du Centre d'aide qu'il approfondit ; le script y
pose le lien « Pour aller au fond » entre `<!-- GUIDE:DÉBUT -->` et `FIN`.

Les fichiers gardent leur nom `blogue-*.html` : ces URL sont indexées et
répondent 200. Les renommer pour un préfixe plus joli coûterait le référencement
que ces textes servent à aller chercher. Seul le mot affiché a changé —
« Guides », pas « Blogue ».

## Règles Firestore
Elles ne se déploient **pas** avec le site : Firebase ne lit pas ce dépôt.
Après toute modification d'un `firestore.rules`, le publier en console —
voir `outils/tc-9x2k7m/SECURITE-FIRESTORE.md`.
