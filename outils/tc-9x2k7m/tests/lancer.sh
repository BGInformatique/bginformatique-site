#!/usr/bin/env bash
#
# Lance la suite de tests de TimeCalculator et répond par un code de sortie :
#   0  tous les tests passent
#   1  au moins un test échoue
#   2  le banc n'a pas pu tourner (génération, serveur, navigateur, délai)
#
# Usage :  ./outils/tc-9x2k7m/tests/lancer.sh
#
# Fonctionnement : preparer.py régénère le banc depuis les VRAIS index.html
# et app.js, serveur.py sert le tout en HTTP (un module ES ne se charge pas
# depuis file://), Firefox sans écran ouvre la page, la page exécute les
# tests puis renvoie ses résultats en POST au serveur. Le fuseau est forcé à
# America/Toronto : les tests de changement d'heure en dépendent.

set -uo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELAI_RESULTATS=90   # secondes accordées à Firefox pour livrer les résultats

command -v python3 >/dev/null || { echo "python3 introuvable" >&2; exit 2; }
command -v firefox >/dev/null || { echo "firefox introuvable" >&2; exit 2; }

# 1. Régénérer le banc depuis les vrais fichiers
python3 "$ICI/preparer.py" || exit 2
rm -f "$ICI/genere/resultats.json"

# 2. Serveur HTTP (port libre choisi par le système, annoncé sur stdout)
JOURNAL="$ICI/genere/serveur.log"
: > "$JOURNAL"
python3 "$ICI/serveur.py" > "$JOURNAL" 2>&1 &
SERVEUR=$!

PROFIL="$(mktemp -d)"
FIREFOX=""
nettoyer() {
  [ -n "$FIREFOX" ] && kill "$FIREFOX" 2>/dev/null
  kill "$SERVEUR" 2>/dev/null
  wait "$SERVEUR" 2>/dev/null
  rm -rf "$PROFIL"
}
trap nettoyer EXIT

PORT=""
for _ in $(seq 1 50); do
  PORT="$(sed -n 's/^PORT=//p' "$JOURNAL")"
  [ -n "$PORT" ] && break
  sleep 0.1
done
if [ -z "$PORT" ]; then
  echo "Le serveur du banc n'a pas démarré :" >&2
  cat "$JOURNAL" >&2
  exit 2
fi

# 3. Firefox sans écran, profil neuf et isolé (--no-remote : sinon il refuse
#    de démarrer quand un Firefox est déjà ouvert sur le poste)
TZ=America/Toronto firefox --headless --no-remote --profile "$PROFIL" \
  "http://127.0.0.1:$PORT/tests/genere/banc.html" >/dev/null 2>&1 &
FIREFOX=$!

# 4. Attendre les résultats
ecoule=0
while [ ! -f "$ICI/genere/resultats.json" ] && [ "$ecoule" -lt "$DELAI_RESULTATS" ]; do
  sleep 1
  ecoule=$((ecoule + 1))
done

if [ ! -f "$ICI/genere/resultats.json" ]; then
  echo "❌ Aucun résultat reçu après ${DELAI_RESULTATS} s." >&2
  echo "   La page a probablement échoué avant la fin — ouvrir" >&2
  echo "   http://127.0.0.1:$PORT/tests/genere/banc.html dans un navigateur" >&2
  echo "   avec sa console pour voir l'erreur." >&2
  exit 2
fi

# 5. Présenter les résultats et fixer le code de sortie
python3 - "$ICI/genere/resultats.json" <<'PY'
import json
import sys

donnees = json.load(open(sys.argv[1], encoding="utf-8"))
tests = donnees.get("tests", [])
if not tests:
    # Un rapport vide n'est pas un succès : c'est une suite qui n'a pas tourné.
    print("❌ Rapport vide : aucun test exécuté.")
    sys.exit(1)
echecs = [t for t in tests if not t.get("ok")]

sections = {}
for t in tests:
    s = sections.setdefault(t.get("section", "?"), [0, 0])
    s[0] += 1
    if t.get("ok"):
        s[1] += 1

for nom, (total, ok) in sections.items():
    marque = "✓" if ok == total else "✗"
    print(f"  {marque} {nom} : {ok}/{total}")

print()
if echecs:
    print(f"❌ {len(echecs)} échec(s) sur {len(tests)} tests :")
    for t in echecs:
        print(f"   ✗ [{t.get('section')}] {t.get('nom')}")
        print(f"       {t.get('message', '(sans message)')}")
    sys.exit(1)

print(f"✅ {len(tests)} tests, tous réussis.")
sys.exit(0)
PY
