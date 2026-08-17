#!/usr/bin/env python3
"""Réécrit l'entête et le pied de page de toutes les pages depuis _gabarits/.

    ./generer-gabarit.py --essai       # montre chaque écart, n'écrit rien
    ./generer-gabarit.py --diff        # montre ligne à ligne CE QUI change
    ./generer-gabarit.py               # applique
    ./generer-gabarit.py --extraire    # (re)fabrique _gabarits/ depuis les pages

Pourquoi ce script existe
-------------------------
Le même entête et le même pied de page sont recopiés dans 45 fichiers. Changer
une phrase — « diagnostic gratuit » en « estimation sans frais » — a demandé un
balayage de 47 fichiers et 106 lignes. Le coût n'est pas l'effort : c'est la
DIVERGENCE. Une page garde l'ancien numéro, l'ancienne promesse, un « & » nu au
lieu de « &amp; », et personne ne s'en aperçoit avant des mois.

Ici, la source de vérité est `_gabarits/` : quatre fragments, deux familles.
Chaque page reçoit celui de sa famille, reconnue à la classe de son propre
entête (`res-header` → résidentiel, `site-header` → entreprises). Rien n'est
deviné : une page dont l'entête ou le pied n'est pas reconnu est SIGNALÉE et
laissée intacte.

Ce qu'il ne fait PAS : toucher au contenu entre l'entête et le pied, changer la
famille d'une page, ni inventer un gabarit. Le dossier `_gabarits/` commence par
un souligné : GitHub Pages (Jekyll) ne le publie pas.

La page active
--------------
`aria-current="page"` n'est pas dans le gabarit — il dépend de la page. Le
script le retire du fragment puis le repose sur le lien dont l'adresse est celle
de la page. Un article `blogue-*.html` marque l'index `blogue.html` de sa
section, comme il le faisait déjà à la main.
"""

import difflib
import glob
import os
import re
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
GABARITS = os.path.join(ICI, "_gabarits")

# La famille se lit sur la page elle-même, jamais sur son chemin : des pages de
# la racine appartiennent à l'une ou à l'autre, et c'est voulu.
FAMILLES = {"res-header": "residentiel", "site-header": "entreprises",
            "res-footer": "residentiel", "site-footer": "entreprises"}

# Ce qui échappe au gabarit, et pourquoi. L'exception porte sur la BALISE, pas
# sur la page : le 404 a un pied volontairement réduit à une ligne, mais son
# entête est le standard — l'exclure en entier le laisserait dériver.
#
# Le chemin COMPLET, pas le nom de fichier : « index.html » seul exclurait
# aussi residentiel/index.html et entreprises/index.html, qui sont des pages
# ordinaires portant le gabarit de leur famille.
EXCEPTIONS = {
    "index.html": {"header", "footer"},   # page d'aiguillage, sans navigation
    "404.html": {"footer"},               # pied réduit à une ligne, à dessein
}

DIFF = "--diff" in sys.argv
ESSAI = "--essai" in sys.argv or DIFF   # montrer, c'est ne pas écrire
EXTRAIRE = "--extraire" in sys.argv


def pages():
    """Toutes les pages du site, hors outils et espace client (autres dépôts
    logiques, avec leur propre gabarit)."""
    trouvees = []
    for motif in ("*.html", "residentiel/*.html", "entreprises/*.html"):
        trouvees += glob.glob(os.path.join(ICI, motif))
    return sorted(f for f in trouvees
                  if exceptees(f) != {"header", "footer"})


def exceptees(chemin):
    """Les balises que cette page garde à elle, par décision explicite."""
    return EXCEPTIONS.get(os.path.relpath(chemin, ICI).replace(os.sep, "/"), set())


def bornes(source, balise):
    """(début, fin) du bloc <balise>…</balise> apparié, ou None.

    Les balises imbriquées sont comptées : un <footer> dans un <footer> ne
    couperait pas le bloc au mauvais endroit.
    """
    depart = re.search(r"<%s\b" % balise, source)
    if not depart:
        return None
    i, profondeur = depart.start(), 0
    for t in re.finditer(r"</?%s\b[^>]*>" % balise, source[i:]):
        profondeur += -1 if t.group(0).startswith("</") else 1
        if profondeur == 0:
            return i, i + t.end()
    return None


def famille(source, balise):
    """La famille d'une page, lue sur la classe de sa balise."""
    b = bornes(source, balise)
    if not b:
        return None
    ouvrante = source[b[0]:source.index(">", b[0]) + 1]
    for classe, nom in FAMILLES.items():
        if classe in ouvrante:
            return nom
    return None


def url(chemin):
    """L'adresse publique d'un fichier : /residentiel/faq.html"""
    return "/" + os.path.relpath(chemin, ICI).replace(os.sep, "/")


def marquer_active(fragment, adresse):
    """Repose aria-current="page" sur le lien de navigation de la page courante.

    Le gabarit arrive nu. Un article de blogue marque l'index de sa section :
    /residentiel/blogue-faux-soutien.html → /residentiel/blogue.html

    Le marquage reste À L'INTÉRIEUR du <nav>. Le bouton d'appel à l'action et
    le lien du téléphone portent parfois la même adresse qu'un élément de menu
    (« Estimation sans frais → » pointe sur /entreprises/diagnostic.html) : les
    marquer « page courante » serait faux, et les habillerait en page active.
    """
    fragment = re.sub(r'\s*aria-current="page"', "", fragment)
    nav = bornes(fragment, "nav")
    if not nav:
        return fragment
    debut, fin = nav
    menu = fragment[debut:fin]

    cibles = [adresse]
    dossier, fichier = os.path.split(adresse)
    if fichier.startswith("blogue-"):
        cibles.append(f"{dossier}/blogue.html")
    for cible in cibles:
        motif = '(<a\\s[^>]*href="%s")' % re.escape(cible)
        menu, n = re.subn(motif, r'\1 aria-current="page"', menu, count=1)
        if n:
            return fragment[:debut] + menu + fragment[fin:]
    return fragment


def lire(nom):
    chemin = os.path.join(GABARITS, nom)
    if not os.path.exists(chemin):
        raise SystemExit(f"  ✗ {nom} manque dans _gabarits/ — lancer --extraire.")
    return open(chemin, encoding="utf-8").read().rstrip("\n")


# ── extraction : fabriquer les gabarits depuis ce qui existe ────────────────

def extraire():
    """Écrit _gabarits/ à partir de la variante MAJORITAIRE de chaque famille.

    Majoritaire, et non « celle d'une page choisie » : c'est la version que le
    site porte déjà partout, donc l'extraction ne change rien à l'œil. Les
    minoritaires sont des dérives — elles seront alignées à l'application.
    """
    os.makedirs(GABARITS, exist_ok=True)
    for balise in ("header", "footer"):
        variantes = {}
        for f in pages():
            if balise in exceptees(f):
                continue
            s = open(f, encoding="utf-8").read()
            fam, b = famille(s, balise), bornes(s, balise)
            if not fam or not b:
                continue
            nu = re.sub(r'\s*aria-current="page"', "", s[b[0]:b[1]])
            variantes.setdefault((fam, nu), []).append(os.path.basename(f))
        gagnantes = {}
        for (fam, nu), fichiers in variantes.items():
            if len(fichiers) > len(gagnantes.get(fam, ("", []))[1]):
                gagnantes[fam] = (nu, fichiers)
        for fam, (nu, fichiers) in sorted(gagnantes.items()):
            nom = f"{fam}-{balise}.html"
            with open(os.path.join(GABARITS, nom), "w", encoding="utf-8") as g:
                g.write(nu + "\n")
            minoritaires = sum(len(v) for (f2, _), v in variantes.items()
                               if f2 == fam) - len(fichiers)
            print(f"  ✓ {nom} — extrait de {len(fichiers)} page(s)"
                  + (f", {minoritaires} dérive(s) à aligner" if minoritaires else ""))
    return 0


# ── application ─────────────────────────────────────────────────────────────

def appliquer():
    fragments = {(fam, balise): lire(f"{fam}-{balise}.html")
                 for fam in ("residentiel", "entreprises")
                 for balise in ("header", "footer")}
    touchees = inchangees = 0
    soucis = []
    for f in pages():
        source = open(f, encoding="utf-8").read()
        neuf, changes = source, []
        for balise in ("header", "footer"):
            if balise in exceptees(f):
                continue
            fam, b = famille(neuf, balise), bornes(neuf, balise)
            if not b:
                soucis.append(f"{url(f)} : aucun <{balise}> — laissée intacte")
                continue
            if not fam:
                soucis.append(f"{url(f)} : <{balise}> de famille inconnue — laissée intacte")
                continue
            # Le marquage de la page courante n'appartient qu'à la navigation
            # d'entête : le poser aussi au pied donnerait deux « page courante »
            # dans le même document.
            remplacant = fragments[(fam, balise)]
            if balise == "header":
                remplacant = marquer_active(remplacant, url(f))
            if neuf[b[0]:b[1]] == remplacant:
                continue
            if DIFF:
                print(f"\n  ── {url(f)} · <{balise}>")
                ecart = difflib.unified_diff(
                    neuf[b[0]:b[1]].splitlines(), remplacant.splitlines(),
                    lineterm="", n=1)
                print("\n".join("     " + l for l in list(ecart)[2:]))
            # Découpe par indices : tout ce qui est hors du bloc est intouché.
            neuf = neuf[:b[0]] + remplacant + neuf[b[1]:]
            changes.append(f"{balise} ({fam})")
        if not changes:
            inchangees += 1
            continue
        touchees += 1
        print(f"  {'~' if ESSAI else '✓'} {url(f)} — {', '.join(changes)}")
        if not ESSAI:
            with open(f, "w", encoding="utf-8") as g:
                g.write(neuf)
    print(f"\n  {touchees} page(s) {'seraient ' if ESSAI else ''}alignée(s), "
          f"{inchangees} déjà conforme(s).")
    for s in soucis:
        print(f"  ⚠ {s}")
    if ESSAI and touchees:
        print("\n  Essai : rien n'a été écrit. Relancer sans --essai pour appliquer.")
    # En mode essai, le code de retour EST le verdict : 1 s'il reste une
    # dérive. C'est ce que deploy.sh interroge avant de publier.
    return 1 if (ESSAI and touchees) else 0


if __name__ == "__main__":
    print("Gabarit du site — entête et pied de page\n")
    sys.exit(extraire() if EXTRAIRE else appliquer())
