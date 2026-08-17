#!/bin/bash
# ==========================================================
#  Script de déploiement - BG Informatique
#  Usage : ./deploy.sh ["message de commit optionnel"]
#
#  Un déploiement équivaut TOUJOURS à un merge sur `main` :
#  quelle que soit la branche de travail, le script committe les
#  modifications locales, fusionne cette branche dans `main`, puis
#  pousse `main` (c'est `main` qui est publié en ligne).
# ==========================================================

set -euo pipefail  # Arrête à la moindre erreur

# Couleurs
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'  # No Color

echo -e "${GREEN}─── Initialisation du déploiement BG Informatique ───${NC}"

# Vérifier qu'on est dans un dépôt git
if [ ! -d ".git" ]; then
  echo -e "${RED}Erreur : ce dossier n'est pas un dépôt git.${NC}"
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# ── Arguments ───────────────────────────────────────────────────────────────
#   ./deploy.sh                          publie ce qui a changé
#   ./deploy.sh "message"                idem, avec un message
#   ./deploy.sh "message" --essai        montre tout, n'écrit rien
#   ./deploy.sh "message" --tout         publie même un chantier mêlé
#   ./deploy.sh "message" --seulement outils/dw-6r2v8k espace-client
#                                        ne commite QUE ces chemins
#
#   « --seulement » avale tout ce qui suit : mettre le message AVANT.
ESSAI=0
TOUT=0
MESSAGE=""
SEULEMENT=()
mode_chemins=0
for arg in "$@"; do
  if [ "$mode_chemins" -eq 1 ]; then SEULEMENT+=("$arg"); continue; fi
  case "$arg" in
    --essai)     ESSAI=1 ;;
    --tout)      TOUT=1 ;;
    --seulement) mode_chemins=1 ;;
    *)           MESSAGE="$arg" ;;
  esac
done

if [ -z "$MESSAGE" ]; then
  MESSAGE="Mise à jour BG Informatique - $(date +'%Y-%m-%d %H:%M:%S')"
fi
COMMIT_MSG="$MESSAGE"

[ "$ESSAI" -eq 1 ] && echo -e "${YELLOW}Mode essai : rien ne sera commité ni poussé.${NC}"

# ── Mise en index, puis garde-fous ──────────────────────────────────────────
#
# On met en index AVANT de vérifier : l'index dit exactement ce qui partirait,
# sans avoir à deviner ce que .gitignore a déjà écarté. Un refus fait
# « git reset » — rien n'est perdu, l'arbre de travail n'est pas touché.
#
# Et surtout : les garde-fous passent AVANT l'anti-cache. Sinon un
# déploiement refusé laisserait derrière lui trente-sept pages avec un « ?v= »
# réécrit pour rien, à démêler à la main.
if [ ${#SEULEMENT[@]} -gt 0 ]; then
  git add -- "${SEULEMENT[@]}"
else
  git add -A
fi

annuler() {
  git reset >/dev/null
  echo
  echo -e "${RED}Déploiement refusé — rien n'a été commité ni poussé.${NC}"
  echo -e "${YELLOW}L'arbre de travail est intact.${NC}"
}

# 1) Garde de CONTENU — ce qui ne doit jamais devenir public.
#    Le dépôt est public et Pages sert tout ce qu'il contient : un fichier
#    déposé ici est lisible par quiconque connaît le chemin, sans aucune
#    porte. Et l'historique garde le fichier même après suppression.
#    outils/mk-7p3w9d/deployer.sh fait déjà ce contrôle pour SON dossier ;
#    ici il vaut pour tout le dépôt, y compris la racine.
FUITE=0
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  case "$base" in
    amorce-*.json)
      echo -e "${RED}  ✗ $f — fichier d'amorce : jamais dans le dépôt.${NC}"; FUITE=1 ;;
    .env|.env.*|*.pem|*.key|*.p12|id_rsa|id_rsa.*|cle-sa*.json|*service-account*.json)
      echo -e "${RED}  ✗ $f — clé ou secret.${NC}"; FUITE=1 ;;
  esac
  # Un export renommé ne se repère pas au nom : on regarde les clés.
  if [ "${base##*.}" = "json" ] && [ -f "$f" ] \
     && grep -lq '"tombstones"\|"idTache"\|"private_key"' "$f" 2>/dev/null; then
    echo -e "${RED}  ✗ $f — contient un état exporté ou une clé privée.${NC}"; FUITE=1
  fi
  if [ -f "$f" ]; then
    taille=$(stat -c%s "$f" 2>/dev/null || echo 0)
    if [ "$taille" -gt 26214400 ]; then
      echo -e "${RED}  ✗ $f — $((taille / 1048576)) Mo, trop lourd pour une page.${NC}"
      FUITE=1
    fi
  fi
done < <(git diff --cached --name-only -z)

# 2) Garde de PORTÉE — ne pas emporter le chantier d'à côté.
#    « git add -A » met tout dans un seul commit au message générique : le
#    travail en cours d'un autre outil part en ligne avec le vôtre, souvent
#    sans qu'on s'en aperçoive avant de le voir publié.
#    La garde ne se déclenche QUE si le lot touche plusieurs zones — le cas
#    courant (une page, un outil) passe sans rien demander.
zone_de() {
  case "$1" in
    outils/*/*) echo "outils/$(echo "$1" | cut -d/ -f2)" ;;
    */*)        echo "${1%%/*}" ;;
    *)          echo "racine" ;;
  esac
}

ZONES=""
while IFS= read -r -d '' f; do
  ZONES+="$(zone_de "$f")"$'\n'
done < <(git diff --cached --name-only -z)
ZONES="$(echo "$ZONES" | grep -v '^$' | sort -u)"
NB_ZONES="$(echo "$ZONES" | grep -c . || true)"

MELE=0
if [ "$NB_ZONES" -gt 1 ] && [ "$TOUT" -eq 0 ] && [ ${#SEULEMENT[@]} -eq 0 ]; then
  MELE=1
  echo -e "${YELLOW}Ce déploiement touche $NB_ZONES zones du dépôt :${NC}"
  while IFS= read -r z; do
    if [ -n "$z" ]; then
      echo -e "${BLUE}  $z${NC}"
      # « || true » : la dernière ligne qui ne correspond pas à la zone rend 1,
      # et sous « set -e » cela suffirait à tuer le script AVANT le message
      # qui explique comment s'en sortir. Vu en essai, pas en production.
      git diff --cached --name-only | while IFS= read -r f; do
        if [ "$(zone_de "$f")" = "$z" ]; then echo "      $f"; fi
      done || true
    fi
  done <<< "$ZONES"
fi

# 3) Rappel — les règles Firestore ne partent PAS avec le site.
if git diff --cached --name-only | grep -q 'firestore\.rules'; then
  echo -e "${YELLOW}Rappel : firestore.rules a changé.${NC}"
  echo "  Firebase ne lit pas ce dépôt — publier les règles en console,"
  echo "  voir outils/tc-9x2k7m/SECURITE-FIRESTORE.md."
fi

# 4) Rappel — l'entête et le pied de page viennent de _gabarits/.
#    Une page qui les porte recopiés est le point de départ de la divergence :
#    elle garde l'ancien numéro ou l'ancienne promesse pendant des mois sans
#    que personne ne le voie. Le rappel ne bloque pas — corriger le gabarit
#    peut très bien être le prochain geste, pas celui-ci.
if git diff --cached --name-only | grep -q '\.html$'; then
  if ! python3 "$(git rev-parse --show-toplevel)/generer-gabarit.py" --essai >/dev/null 2>&1; then
    echo -e "${YELLOW}Rappel : des pages ont un entête ou un pied dérivé du gabarit.${NC}"
    echo "  Voir ce qui diffère :  ./generer-gabarit.py --diff"
    echo "  Aligner :              ./generer-gabarit.py"
  fi
fi

# L'essai RAPPORTE, il ne bloque pas : il passe donc après les deux gardes,
# pour pouvoir dire aussi « ça serait refusé, et voici pourquoi ». Une
# vérification qui s'arrête à la première objection ne sert qu'une fois.
if [ "$ESSAI" -eq 1 ]; then
  echo -e "${BLUE}Serait commité :${NC}"
  git diff --cached --name-only | sed 's/^/  /'
  if [ "$FUITE" -eq 1 ] || [ "$MELE" -eq 1 ]; then
    echo -e "${YELLOW}En vrai, ce déploiement serait REFUSÉ (voir ci-dessus).${NC}"
  fi
  git reset >/dev/null
  echo -e "${GREEN}─── Essai terminé : rien n'a été écrit. ───${NC}"
  exit 0
fi

if [ "$FUITE" -eq 1 ]; then
  annuler
  echo "Ces fichiers vivent hors du dépôt : ~/Bureau/BG Informatique/Tableau_de_Bord/"
  echo "pour les amorces, ~/.config/bg-lanceur/ pour les clés."
  exit 1
fi

if [ "$MELE" -eq 1 ]; then
  annuler
  echo "Si c'est voulu :        ./deploy.sh \"message\" --tout"
  echo "Sinon, ciblez :         ./deploy.sh \"message\" --seulement <zone> [<zone>…]"
  exit 1
fi

# 0) Cache-busting des applications (outils/<slug>/ et espace-client/) : force le
#    rechargement des assets par le navigateur à chaque déploiement.
#    Chaque outil a ses propres js/app.js et css/style.css ; la boucle évite
#    d'oublier le prochain, comme ç'a failli arriver en ajoutant mk-7p3w9d.
#
#    Certains outils ont leur PROPRE script de déploiement, plus étroit :
#      outils/mk-7p3w9d/deployer.sh   (tableau de bord marketing)
#    La boucle reste quand même ici, et ce n'est pas une redondance : ce
#    script-ci fait « git add . », donc il peut publier n'importe quel outil
#    même si personne n'a lancé son déployeur. Sans la boucle, ce chemin-là
#    mettrait en ligne un JS modifié sans invalider le cache — le changement
#    serait déployé mais invisible.
#    Les APPLICATIONS du site : chaque dossier qui porte ses propres js/ et
#    css/. Ce ne sont plus seulement les outils privés — l'espace client est
#    une application publique bâtie pareil, et il doit être versionné par
#    cette boucle-ci, pas par celle du site (voir 0b).
#
#    Toutes les pages, pas seulement index.html : mk-7p3w9d a jour.html,
#    linkedin.html et veille.html, avec chacune son propre js/. Tant que la
#    boucle ne prenait que index.html, ces trois pages partaient en ligne avec
#    un ?v= figé — le JS déployé, et le navigateur qui gardait l'ancien.
# Restreint l'anti-cache à ce qu'on publie vraiment. Sans ça, un déploiement
# ciblé réécrirait quand même le « ?v= » des autres outils : des diffs
# parasites resteraient dans l'arbre, à démêler plus tard sans savoir d'où ils
# viennent.
dans_portee() {
  if [ ${#SEULEMENT[@]} -eq 0 ]; then return 0; fi
  local p="${1#./}" s
  for s in "${SEULEMENT[@]}"; do
    s="${s%/}"
    case "$p" in "$s"|"$s"/*) return 0 ;; esac
  done
  return 1
}

OUTIL_VERSION=$(date +'%Y%m%d%H%M%S')
for APP_DIR in outils/*/ espace-client/; do
  [ -d "$APP_DIR" ] || continue
  dans_portee "$APP_DIR" || continue
  for APP_PAGE in "$APP_DIR"*.html; do
    [ -f "$APP_PAGE" ] || continue
    sed -i -E \
      -e "s#(js/[A-Za-z0-9_-]+\.js)\?v=[0-9a-z]+#\1?v=${OUTIL_VERSION}#g" \
      -e "s#(css/[A-Za-z0-9_-]+\.css)\?v=[0-9a-z]+#\1?v=${OUTIL_VERSION}#g" \
      "$APP_PAGE"
  done
done

# 0b) Cache-busting des feuilles de style du site.
#     style.css et residentiel.css évoluent ensemble : un navigateur qui
#     garde l'une en cache et recharge l'autre affichait du texte blanc sans
#     son fond sombre. La version est un condensé du CONTENU des deux
#     fichiers — elle ne bouge donc que s'ils changent vraiment, ce qui évite
#     de toucher les 37 pages à chaque déploiement.
CSS_VERSION=$(cat style.css residentiel.css | md5sum | cut -c1-8)
while IFS= read -r -d '' f; do
  dans_portee "$f" || continue
  sed -i -E \
    "s#(href=\"[^\"]*(style|residentiel)\.css)(\?v=[0-9a-f]+)?\"#\1?v=${CSS_VERSION}\"#g" \
    "$f"
#     Les applications sont exclues : chacune a son propre css/style.css, déjà
#     versionné à l'étape 0. Sans cette exclusion, la substitution ci-dessous
#     réécrirait leur ?v= avec le condensé du CSS du site — deux versionneurs
#     sur le même attribut, et le cache-busting des outils cesserait d'être fiable.
#     espace-client/ est dans le lot pour cette raison exacte : son
#     href="css/style.css" correspond au motif ci-dessous, et sans l'exclusion
#     sa version suivrait le CSS du SITE au lieu du sien.
done < <(find . -name '*.html' \
              -not -path './outils/*' \
              -not -path './espace-client/*' \
              -not -path './.git/*' -print0)
echo -e "${BLUE}Feuilles de style versionnées : v=${CSS_VERSION}${NC}"

# 1) Committer — dans la portée choisie plus haut, et pas au-delà.
#    L'anti-cache vient de modifier des pages : il faut les remettre en index.
#    Un « git add . » ici annulerait le « --seulement » de la ligne de
#    commande — soit exactement l'accident que ce script cherche à empêcher.
if [ ${#SEULEMENT[@]} -gt 0 ]; then
  git add -- "${SEULEMENT[@]}"
else
  git add -A
fi

if git diff --cached --quiet; then
  echo -e "${YELLOW}Aucune modification à committer.${NC}"
else
  echo -e "${BLUE}Sera commité :${NC}"
  git diff --cached --name-only | sed 's/^/  /'

  # Ce qui reste dehors, montré pour qu'on ne le découvre pas dans six jours.
  if [ ${#SEULEMENT[@]} -gt 0 ]; then
    RESTE="$(git status --porcelain | grep -v '^[MARCD]' || true)"
    if [ -n "$RESTE" ]; then
      echo -e "${YELLOW}Laissé de côté (hors de la portée demandée) :${NC}"
      echo "$RESTE" | sed 's/^/  /'
    fi
  fi

  echo -e "${BLUE}Commit : $COMMIT_MSG${NC}"
  git commit -m "$COMMIT_MSG"
fi

# 2) Publier sur `main` (déploiement = merge sur main)
echo -e "${BLUE}Publication sur main...${NC}"
git fetch origin main

if [ "$CURRENT_BRANCH" = "main" ]; then
  # Déjà sur main : s'aligner sur origin/main puis pousser
  git merge --ff-only origin/main || {
    echo -e "${RED}Erreur : 'main' local a divergé de origin/main. Résolvez le conflit manuellement.${NC}"
    exit 1
  }
  git push origin main
else
  # Sur une branche de travail : fusionner dans main puis pousser main
  git checkout main
  git merge --ff-only origin/main || {
    echo -e "${RED}Erreur : 'main' local a divergé de origin/main. Résolvez le conflit manuellement.${NC}"
    git checkout "$CURRENT_BRANCH"
    exit 1
  }

  if git merge --ff-only "$CURRENT_BRANCH"; then
    echo -e "${GREEN}Fast-forward de main.${NC}"
  else
    git merge --no-ff "$CURRENT_BRANCH" -m "Déploiement : fusion de $CURRENT_BRANCH dans main"
  fi

  git push origin main

  # Revenir sur la branche de travail et la synchroniser
  git checkout "$CURRENT_BRANCH"
  git push origin "$CURRENT_BRANCH"
fi

echo -e "${GREEN}─── Succès : déploiement terminé ! ───${NC}"
echo -e "${GREEN}Le site sera en ligne sur https://bginformatique.ca dans quelques instants.${NC}"
