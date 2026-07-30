#!/usr/bin/env bash
# ==========================================================
#  Déploiement — Tableau de bord marketing (outils/mk-7p3w9d)
#  Usage : ./outils/mk-7p3w9d/deployer.sh ["message de commit"]
#          ./outils/mk-7p3w9d/deployer.sh --essai     (rien n'est écrit)
#
#  Pourquoi un script séparé de deploy.sh :
#
#  deploy.sh fait « git add . ». Il emporte donc tout ce qui traîne dans
#  l'arbre de travail — le chantier d'un autre outil, un fichier de données
#  oublié — dans un commit unique au message générique. Ici, on ne met en
#  index QUE les chemins de cet outil ; le reste est laissé où il est, et
#  affiché pour qu'on le voie.
#
#  CE QUE CE SCRIPT NE FAIT PAS, ET NE PEUT PAS FAIRE
#  GitHub Pages publie le dépôt ENTIER depuis `main`. Pousser cet outil
#  publie donc aussi tout ce qui est déjà commité sur main. Un déploiement
#  « seulement marketing » n'existe pas : la séparation porte sur ce qu'on
#  COMMITE, pas sur ce qui part en ligne.
# ==========================================================

set -euo pipefail

VERT='\033[0;32m'; BLEU='\033[0;34m'; JAUNE='\033[1;33m'; ROUGE='\033[0;31m'; NC='\033[0m'

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE="$(git -C "$ICI" rev-parse --show-toplevel)"
cd "$RACINE"

OUTIL="outils/mk-7p3w9d"
# Ce que cet outil possède. Rien d'autre ne sera mis en index.
CHEMINS=("$OUTIL" ".github/workflows/tests-marketing.yml")

ESSAI=0
MESSAGE=""
for arg in "$@"; do
  case "$arg" in
    --essai) ESSAI=1 ;;
    *) MESSAGE="$arg" ;;
  esac
done

echo -e "${VERT}─── Déploiement du tableau de bord marketing ───${NC}"
[ "$ESSAI" -eq 1 ] && echo -e "${JAUNE}Mode essai : rien ne sera commité ni poussé.${NC}"

# ── 1) Tronc commun : on ne déploie que depuis main ────────────────────────
BRANCHE="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCHE" != "main" ]; then
  echo -e "${ROUGE}Branche « $BRANCHE » : ce script ne déploie que depuis main.${NC}"
  echo "  Le dépôt est en tronc commun. Pour fusionner une branche, passer par ./deploy.sh."
  exit 1
fi

# ── 2) Garde-fou données clients ──────────────────────────────────────────
#     Le dépôt est public et Pages sert tout ce qu'il contient. Un fichier
#     d'état déposé dans le dossier de l'outil serait lisible par quiconque
#     connaît le slug, SANS aucune porte — index.html est protégé par la
#     connexion, les fichiers à côté ne le sont pas.
echo -e "${BLEU}Recherche de données de mandat dans l'outil…${NC}"
fuites=0
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  case "$base" in
    amorce-*.json)
      echo -e "${ROUGE}  $f — fichier d'amorce : jamais dans le dépôt.${NC}"; fuites=1 ;;
  esac
  # Une sauvegarde exportée renommée ne se repère pas au nom : on regarde
  # les clés de l'état.
  if [ "${base##*.}" = "json" ] && grep -lq '"tombstones"\|"idTache"' "$f" 2>/dev/null; then
    echo -e "${ROUGE}  $f — contient un état exporté (clés « tombstones » / « idTache »).${NC}"
    fuites=1
  fi
done < <(find "$OUTIL" -type f -print0)

if [ "$fuites" -eq 1 ]; then
  echo -e "${ROUGE}Déploiement refusé : sortir ces fichiers du dépôt.${NC}"
  echo "  Ils vivent dans ~/Bureau/BG Informatique/Tableau_de_Bord/ et s'importent"
  echo "  par le sélecteur de fichier de l'outil. .gitignore couvre amorce-*.json."
  exit 1
fi
echo "  ✓ aucune donnée de mandat"

# ── 3) Banc d'essai — barrière, pas formalité ─────────────────────────────
#     Le hook pre-commit ne lance le banc que si un fichier js/ ou css/ est
#     en index. Un changement portant seulement sur index.html passerait donc
#     sans test. Ici on le lance toujours.
echo -e "${BLEU}Banc d'essai…${NC}"
code=0
"$OUTIL/tests/lancer.sh" || code=$?
if [ "$code" -ne 0 ]; then
  echo -e "${ROUGE}Banc échoué (code $code) — déploiement refusé.${NC}"
  exit 1
fi

# ── 4) Anti-cache ─────────────────────────────────────────────────────────
INDEX="$OUTIL/index.html"
if grep -qE '\?v=[0-9]{14}' "$INDEX"; then
  VERSION="$(date +%Y%m%d%H%M%S)"
  if [ "$ESSAI" -eq 0 ]; then
    sed -i -E "s/\?v=[0-9]{14}/?v=${VERSION}/g" "$INDEX"
    echo -e "${BLEU}Anti-cache : ?v=${VERSION}${NC}"
  else
    echo -e "${BLEU}Anti-cache : ?v= serait mis à jour${NC}"
  fi
else
  echo -e "${JAUNE}Attention : $INDEX n'a pas de « ?v=<14 chiffres> » — anti-cache inactif.${NC}"
fi

# ── 5) Index : uniquement les chemins de cet outil ────────────────────────
if [ "$ESSAI" -eq 0 ]; then
  git add -- "${CHEMINS[@]}"
fi

A_COMMITER="$(git diff --cached --name-only -- "${CHEMINS[@]}")"
if [ "$ESSAI" -eq 1 ]; then
  A_COMMITER="$(git status --porcelain -- "${CHEMINS[@]}" | sed 's/^...//')"
fi

if [ -z "$A_COMMITER" ]; then
  echo -e "${JAUNE}Rien à committer pour cet outil.${NC}"
  DEJA_DEVANT="$(git rev-list --count origin/main..main 2>/dev/null || echo 0)"
  if [ "$DEJA_DEVANT" -gt 0 ]; then
    echo "  $DEJA_DEVANT commit(s) local(aux) attendent d'être poussés — relancer après un"
    echo "  « git fetch », ou pousser avec ./deploy.sh si le lot n'est pas que le tien."
  fi
  exit 0
fi

echo -e "${BLEU}Sera commité :${NC}"
echo "$A_COMMITER" | sed 's/^/  /'

# Ce qui reste dehors, montré pour qu'on ne le découvre pas plus tard.
RESTE="$(git status --porcelain | grep -vE "^..\s+($OUTIL|\.github/workflows/tests-marketing\.yml)" || true)"
if [ -n "$RESTE" ]; then
  echo -e "${JAUNE}Laissé de côté (n'appartient pas à cet outil) :${NC}"
  echo "$RESTE" | sed 's/^/  /'
fi

if [ "$ESSAI" -eq 1 ]; then
  echo -e "${VERT}─── Essai terminé : rien n'a été écrit. ───${NC}"
  exit 0
fi

# ── 6) Commit ─────────────────────────────────────────────────────────────
if [ -z "$MESSAGE" ]; then
  MESSAGE="Tableau de bord marketing - $(date +'%Y-%m-%d %H:%M:%S')"
fi
echo -e "${BLEU}Commit : $MESSAGE${NC}"
git commit -m "$MESSAGE"

# ── 7) Publication ────────────────────────────────────────────────────────
echo -e "${BLEU}Publication sur main…${NC}"
git fetch origin main
if ! git merge --ff-only origin/main; then
  echo -e "${ROUGE}main local a divergé de origin/main. Résoudre à la main.${NC}"
  echo "  Le commit est fait ; seule la poussée manque."
  exit 1
fi
git push origin main

echo -e "${VERT}─── Poussé. GitHub Pages publie dans un instant. ───${NC}"
echo "  https://bginformatique.ca/$OUTIL/"
echo
echo "  Vérifier que la version en ligne correspond :"
echo "    ./$OUTIL/verifier-deploiement.sh"
echo
echo -e "${JAUNE}  Rappel : les règles Firestore ne se déploient PAS avec le site.${NC}"
echo "  Firebase ne lit pas le dépôt. Si firestore.rules a changé, le publier en"
echo "  console — voir outils/tc-9x2k7m/SECURITE-FIRESTORE.md."
