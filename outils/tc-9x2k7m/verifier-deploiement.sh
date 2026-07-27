#!/usr/bin/env bash
#
# Compare ce qui est réellement servi sur bginformatique.ca avec les fichiers
# de ce dossier. Répond à une seule question : « la version en ligne est-elle
# à jour ? »
#
# Usage :  ./outils/tc-9x2k7m/verifier-deploiement.sh
#
# À exécuter une ou deux minutes après un push : GitHub Pages prend un moment
# à reconstruire.

set -uo pipefail

BASE="https://bginformatique.ca/outils/tc-9x2k7m"
DOSSIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FICHIERS=("index.html" "js/app.js" "js/firebase-config.js" "css/style.css")

echo "Comparaison de $DOSSIER"
echo "               avec $BASE"
echo

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ecarts=0
for f in "${FICHIERS[@]}"; do
  local_path="$DOSSIER/$f"
  if [ ! -f "$local_path" ]; then
    printf "  %-24s ABSENT localement\n" "$f"
    ecarts=$((ecarts + 1))
    continue
  fi

  # Téléchargement dans un fichier, jamais dans une variable : une
  # substitution de commande supprime les sauts de ligne finaux et ferait
  # croire à un écart sur des fichiers pourtant identiques.
  distant="$tmp/$(echo "$f" | tr '/' '_')"
  if ! curl -fsS --max-time 30 "$BASE/$f" -o "$distant" 2>/dev/null; then
    printf "  %-24s ✗ inaccessible en ligne\n" "$f"
    ecarts=$((ecarts + 1))
    continue
  fi

  somme_locale="$(sha256sum "$local_path" | cut -d' ' -f1)"
  somme_distante="$(sha256sum "$distant" | cut -d' ' -f1)"

  if [ "$somme_locale" = "$somme_distante" ]; then
    printf "  %-24s ✓ identique\n" "$f"
  else
    printf "  %-24s ✗ DIFFÉRENT (local %s… / en ligne %s…)\n" \
      "$f" "${somme_locale:0:8}" "${somme_distante:0:8}"
    ecarts=$((ecarts + 1))
  fi
done

echo
if [ "$ecarts" -eq 0 ]; then
  echo "✅ La version en ligne correspond exactement à ce dossier."
  exit 0
fi

echo "❌ $ecarts fichier(s) ne correspondent pas."
echo
echo "Pistes, dans l'ordre :"
echo "  1. Le déploiement est-il terminé ?  gh run list --limit 3"
echo "  2. Les changements sont-ils poussés ?  git status -sb"
echo "  3. Attendre une minute et relancer : GitHub Pages met un moment à publier."
exit 1
