#!/usr/bin/env bash
#
# Banc d'essai de BGFoods.
#   ./outils/ep-4k9m2t/tests/lancer.sh
#
# Appelé par .githooks/pre-commit avant qu'un changement de js/ ou css/ parte
# en ligne : deploy.sh publie main directement, donc un test qui échoue après
# le push échoue après la mise en ligne — trop tard.
#
# Deux étapes, toutes deux sur les VRAIS modules de js/, jamais sur une copie :
#   1. le calcul (banc.mjs) : formats de prix, unités, appariement des noms,
#      choix du meilleur prix, fusion multi-appareils, lecture des PDF;
#   2. la page complète (navigateur.mjs), Firebase remplacé par les bouchons.
#
# Contrairement aux bancs de TimeCalculator et du marketing, celui-ci demande
# node plutôt que gjs : les modules de BGFoods sont de vrais modules ES, donc
# le banc les IMPORTE au lieu de les découper à la ficelle. Sans node, on sort
# en 2 — « le banc n'a pas pu tourner » — et GitHub Actions sert de rattrapage.

set -uo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null; then
  echo "  node absent — banc de BGFoods sauté (GitHub Actions le lancera)." >&2
  exit 2
fi

echo "── Calcul (banc.mjs)"
if ! node "$ICI/banc.mjs"; then
  echo "  ✗ Banc échoué à l'étape calcul." >&2
  exit 1
fi

echo
echo "── Page complète (navigateur.mjs)"
node "$ICI/navigateur.mjs"
CODE=$?
if [ "$CODE" -eq 2 ]; then
  # Playwright ou Chromium absent : le banc du calcul, lui, a bien tourné.
  echo "  (étape navigateur sautée, faute d'outil)"
elif [ "$CODE" -ne 0 ]; then
  echo "  ✗ Banc échoué à l'étape navigateur." >&2
  exit 1
fi

echo
echo "✅ Banc d'essai de BGFoods : tout passe."
