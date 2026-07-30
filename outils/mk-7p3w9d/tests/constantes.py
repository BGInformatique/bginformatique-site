#!/usr/bin/env python3
"""Constantes référencées mais jamais déclarées.

    python3 outils/mk-7p3w9d/tests/constantes.py outils/mk-7p3w9d/js/app.js

Pourquoi ce contrôle existe : `new Function(src)` compile une référence morte
sans broncher — l'erreur n'arrive qu'à l'exécution, sur le chemin de code
concerné, donc souvent en production. C'est arrivé en retirant la constante
qui portait le mandat par défaut : la déclaration partait, un appel restait, et
toute création de tâche aurait planté. Le contrôle de syntaxe n'avait rien vu.

Un simple grep ne suffit pas : il lit aussi les chaînes et les commentaires, et
noie le vrai défaut sous les faux positifs (« MARKETING » dans un commentaire,
« ID_TACHE » dans un en-tête TSV). On retire donc chaînes et commentaires avant
de regarder, avec un petit automate — pas une expression régulière, qui ne sait
pas où commence une chaîne.
"""

import re
import sys
from pathlib import Path

# Identifiants tout en majuscules d'au moins trois caractères : la forme des
# constantes de module. JSON est une globale du langage, pas une constante à nous.
FORME = re.compile(r"\b[A-Z][A-Z0-9_]{2,}\b")
# Globales du langage et du navigateur qui portent cette forme : elles ne sont
# déclarées nulle part dans le fichier, et ce n'est pas un défaut.
CONNUES = {"JSON", "URL", "NaN", "DOM", "XML", "CSS", "API"}


def _avant_regex(out):
    """Un « / » ouvre-t-il une expression régulière, ou est-ce une division ?

    Règle usuelle : c'est une regex sauf si le dernier signe utile est la fin
    d'une valeur — identifiant, nombre, ou fermeture de parenthèse/crochet.
    Sans cette distinction, /\\\\/g fait prendre le « " » suivant pour le début
    d'une chaîne, et tout le reste du fichier se décale.
    """
    j = len(out) - 1
    while j >= 0 and out[j].isspace():
        j -= 1
    if j < 0:
        return True
    return not (out[j].isalnum() or out[j] in "_$)]")


def code_seul(src):
    """Retire chaînes, gabarits, regex et commentaires ; garde les lignes."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        suite = src[i + 1] if i + 1 < n else ""

        if c == "/" and suite not in ("/", "*") and _avant_regex(out):
            i += 1
            en_classe = False
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "[":
                    en_classe = True
                elif src[i] == "]":
                    en_classe = False
                elif src[i] == "/" and not en_classe:
                    i += 1
                    break
                elif src[i] == "\n":
                    break            # une regex ne franchit pas la ligne
                i += 1
            out.append("0")          # une regex est une valeur, comme un nombre
            continue

        if c == "/" and suite == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and suite == "*":
            i += 2
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                if src[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2
            continue
        if c in "\"'`":
            guillemet, i = c, i + 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == guillemet:
                    i += 1
                    break
                if src[i] == "\n":
                    out.append("\n")     # les gabarits multilignes gardent leurs lignes
                i += 1
            out.append('""')
            continue

        out.append(c)
        i += 1
    return "".join(out)


def main():
    if len(sys.argv) < 2:
        print("usage : constantes.py <fichier.js>", file=sys.stderr)
        return 2
    src = Path(sys.argv[1]).read_text(encoding="utf-8")
    nu = code_seul(src)

    declarees = set(re.findall(r"\b(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\b", nu))
    # Les noms importés sont déclarés ailleurs : on les tient pour connus.
    for bloc in re.findall(r"\bimport\s*\{([^}]*)\}", nu):
        declarees.update(re.findall(r"\b([A-Z][A-Z0-9_]{2,})\b", bloc))
    # Propriétés (obj.CONSTANTE) et clés d'objet : ce ne sont pas des références libres.
    libres = set()
    for m in FORME.finditer(nu):
        avant = nu[:m.start()].rstrip()
        apres = nu[m.end():].lstrip()
        if avant.endswith(".") or apres.startswith(":"):
            continue
        libres.add(m.group())

    orphelines = sorted(libres - declarees - CONNUES)
    if orphelines:
        print("  ✗ référencées sans déclaration :", file=sys.stderr)
        for o in orphelines:
            ligne = next((i + 1 for i, l in enumerate(nu.splitlines())
                          if re.search(r"\b" + o + r"\b", l)), "?")
            print(f"      {o}  (ligne {ligne})", file=sys.stderr)
        print("    (constante retirée sans nettoyer ses appels ?)", file=sys.stderr)
        return 1

    print(f"  ✓ aucune constante orpheline ({len(declarees)} déclarées, "
          f"{len(libres)} référencées)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
