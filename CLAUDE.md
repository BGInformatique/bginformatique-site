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

## Règles Firestore
Elles ne se déploient **pas** avec le site : Firebase ne lit pas ce dépôt.
Après toute modification d'un `firestore.rules`, le publier en console —
voir `outils/tc-9x2k7m/SECURITE-FIRESTORE.md`.
