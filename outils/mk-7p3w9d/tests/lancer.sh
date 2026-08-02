#!/usr/bin/env bash
#
# Banc d'essai du tableau de bord marketing.
#   ./outils/mk-7p3w9d/tests/lancer.sh
#
# Appelé par .githooks/pre-commit avant qu'un changement de js/ ou css/ parte
# en ligne : deploy.sh publie main directement, donc un test qui échoue après
# le push échoue après la mise en ligne — trop tard.
#
# Deux vérifications, toutes deux sur le VRAI js/app.js, jamais sur une copie :
#   1. syntaxe du module ;
#   2. fusion multi-appareils (perte de données silencieuse).
#
# Contrairement au banc de TimeCalculator, celui-ci n'a pas besoin de Firefox :
# gjs suffit. Sans gjs, on sort en succès avec un avertissement — le workflow
# GitHub Actions sert alors d'alarme de rattrapage.

set -uo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ICI/../js/app.js"

if ! command -v gjs >/dev/null; then
  echo "  gjs absent — banc sauté ici (GitHub Actions le lancera après le push)." >&2
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Les imports ESM ne sont pas valides dans un corps de fonction : on ne
# vérifie que la syntaxe du reste, ce qui couvre tout le code écrit à la main.
#
# Surtout PAS une plage sed « /^import/,/from "…";$/d » : la dernière plage ne
# trouve jamais sa borne de fin et supprime tout jusqu'au bas du fichier. Le
# banc affichait alors « 20 lignes » et ne vérifiait plus rien. On suit donc
# l'instruction jusqu'à son point-virgule, ligne par ligne.
for JS in "$ICI/../js/app.js" "$ICI/../js/jour.js" "$ICI/../js/linkedin.js" \
         "$ICI/../js/veille.js" "$ICI/../js/mandat.js"; do
  [ -f "$JS" ] || continue
  echo "── Syntaxe de js/$(basename "$JS")"
  # Le mot-clé « export » est retiré, pas la ligne : « export function x() »
  # devient « function x() », donc le corps de la fonction reste vérifié.
  # Supprimer la ligne entière, comme pour les imports, laisserait le corps
  # orphelin et le banc passerait au vert sur du code qui ne compile pas.
  awk '
    /^import[[:space:]]/ { dans = 1 }
    dans { if (/;[[:space:]]*$/) dans = 0; next }
    { sub(/^export[[:space:]]+/, ""); print }
  ' "$JS" > "$tmp/corps.js"

  lignes_js=$(wc -l < "$JS")
  lignes_corps=$(wc -l < "$tmp/corps.js")
  if [ "$lignes_corps" -lt $((lignes_js / 2)) ]; then
    echo "  ✗ Le retrait des imports a mangé le fichier ($lignes_corps/$lignes_js lignes)." >&2
    echo "    Le test de syntaxe ne prouverait rien — banc arrêté." >&2
    exit 1
  fi

  cat > "$tmp/syntaxe.js" <<EOF
const GLib = imports.gi.GLib;
const [ok, bytes] = GLib.file_get_contents('$tmp/corps.js');
const src = new TextDecoder().decode(bytes);
try {
  new Function(src);
  print('  ✓ syntaxe valide (' + src.split('\n').length + ' lignes)');
} catch (e) {
  print('  ✗ ERREUR DE SYNTAXE : ' + e.message);
  imports.system.exit(1);
}
EOF

  if ! gjs "$tmp/syntaxe.js"; then
    echo "  ✗ Banc échoué à l'étape syntaxe ($(basename "$JS"))." >&2
    exit 1
  fi
done

echo
echo "── Constantes référencées mais non déclarées"
if command -v python3 >/dev/null; then
  if ! python3 "$ICI/constantes.py" "$APP"; then
    echo "  ✗ Banc échoué à l'étape constantes." >&2
    exit 1
  fi
else
  echo "  python3 absent — contrôle sauté." >&2
fi

echo
if ! gjs "$ICI/fusion.js"; then
  echo "  ✗ Banc échoué à l'étape fusion." >&2
  exit 1
fi

# Le cloisonnement par mandat : trois lignes qui décident si une section
# s'affiche. Une erreur ici montre les prospects d'un mandat pendant qu'on
# travaille sur l'autre — silencieusement.
if [ -f "$ICI/../js/mandat.js" ]; then
  if ! gjs "$ICI/mandat.js"; then
    echo "  ✗ Banc échoué à l'étape mandat." >&2
    exit 1
  fi
fi

# La veille a sa PROPRE fusion, sur deux listes plutôt qu'une — un bug y perd
# des pistes aussi silencieusement. Elle porte aussi le garde-fou Loi 25, qui
# n'est une promesse que tant que ce banc passe.
if [ -f "$ICI/../js/veille.js" ]; then
  if ! gjs "$ICI/fusion-veille.js"; then
    echo "  ✗ Banc échoué à l'étape veille." >&2
    exit 1
  fi
fi

echo "✅ Banc d'essai du tableau de bord marketing : tout passe."
