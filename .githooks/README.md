# Hooks Git du dépôt

Git ne lit pas ce dossier tout seul. **Une seule commande à lancer par clone :**

```bash
git config core.hooksPath .githooks
```

Sans elle, les hooks ci-dessous ne s'exécutent pas — les commits fonctionnent
quand même, mais sans le garde-fou.

## `pre-commit` — numéro anti-cache

Dès qu'un fichier `js/` ou `css/` d'un outil surveillé entre dans un commit, le
hook met à jour le `?v=<horodatage>` de son `index.html` et le rajoute au commit.

**Pourquoi c'est nécessaire :** un navigateur qui a déjà chargé la page garde le
JS et le CSS en cache. Sans changement du `?v=`, une modification part bien en
ligne mais reste invisible — le pire des cas, parce que rien ne signale l'erreur.

Outils surveillés : voir le tableau `OUTILS` en tête du hook. En ajouter un
revient à ajouter une ligne.

Pour sauter le hook exceptionnellement : `git commit --no-verify`.

## Vérifier qu'un déploiement est bien passé

```bash
./outils/tc-9x2k7m/verifier-deploiement.sh
```

Compare les fichiers servis par bginformatique.ca avec ceux du dossier local et
répond par oui ou par non. À lancer une minute après un push, le temps que
GitHub Pages reconstruise.
