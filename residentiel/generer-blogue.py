#!/usr/bin/env python3
"""Régénère l'index du blogue résidentiel à partir des articles présents.

    ./residentiel/generer-blogue.py            # écrit
    ./residentiel/generer-blogue.py --essai    # montre ce qui changerait

Pourquoi ce script existe
-------------------------
Publier un article demandait trois gestes : écrire la page, l'ajouter à la main
dans `blogue.html`, l'ajouter à la main dans `sitemap.xml`. Deux de ces trois
gestes s'oublient — et un index qui ne liste pas le dernier article, ou un
sitemap qui l'ignore, annule une partie du travail d'écriture.

Ici, la source de vérité est le DOSSIER : tout `residentiel/blogue-*.html` est un
article. Le script relit leur `<title>`, leur meta description et leur
`datePublished` (dans le JSON-LD), puis réécrit le bloc de cartes de l'index
entre ses deux marqueurs, et met le sitemap à jour. Publier redevient un seul
geste : déposer le fichier et lancer ce script.

Ce qu'il ne fait PAS : écrire les articles, ni toucher à quoi que ce soit hors
des marqueurs. L'index reste une page qu'on peut redessiner à la main.
"""

import glob
import html
import os
import re
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.dirname(ICI)
INDEX = os.path.join(ICI, "blogue.html")
SITEMAP = os.path.join(RACINE, "sitemap.xml")
BASE = "https://bginformatique.ca/residentiel/"

DEBUT = "<!-- ARTICLES:DÉBUT"
FIN = "<!-- ARTICLES:FIN -->"

# Une icône par article, choisie sur le nom du fichier. Sans correspondance, on
# retombe sur la première : mieux vaut une icône générique qu'une carte bancale.
ICONES = {
    "arnaque|soutien|phish|hameconnage|virus":
        '<path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    "photo|sauvegarde|donnees":
        '<rect width="18" height="14" x="3" y="5" rx="2"/><circle cx="12" cy="12" r="3"/>',
    "wifi|reseau|internet":
        '<path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M12 20h.01"/>',
    "lent|performance|ordinateur":
        '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/>',
}
ICONE_DEFAUT = '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>'

MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
        "août", "septembre", "octobre", "novembre", "décembre"]


def champ(source, motif, defaut=""):
    m = re.search(motif, source, re.S | re.I)
    return html.unescape(m.group(1).strip()) if m else defaut


def lire_article(chemin):
    s = open(chemin, encoding="utf-8").read()
    titre = champ(s, r"<title>(.*?)</title>")
    # Le « | BG Informatique » est bon pour l'onglet, inutile sur une carte.
    titre = titre.split(" | ")[0].strip()
    desc = champ(s, r'<meta name="description" content="(.*?)"')
    date = champ(s, r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"')
    if not titre:
        raise SystemExit(f"  ✗ {os.path.basename(chemin)} n'a pas de <title>.")
    if not date:
        raise SystemExit(f"  ✗ {os.path.basename(chemin)} n'a pas de datePublished "
                         f"dans son JSON-LD : impossible de l'ordonner.")
    return {"fichier": os.path.basename(chemin), "titre": titre,
            "desc": desc, "date": date}


def date_lisible(iso):
    a, m, j = iso.split("-")
    return f"{int(j)} {MOIS[int(m) - 1]} {a}"


def icone(fichier):
    for motif, chemin in ICONES.items():
        if re.search(motif, fichier):
            return chemin
    return ICONE_DEFAUT


def carte(a):
    return f"""      <a href="/residentiel/{a['fichier']}" class="res-card">
        <span class="res-card-icon"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{icone(a['fichier'])}</svg></span>
        <h3>{html.escape(a['titre'])}</h3>
        <p>{html.escape(a['desc'])}</p>
        <span class="more">{date_lisible(a['date'])} · Lire →</span>
      </a>"""


def bloc(articles):
    if not articles:
        return ('    <p class="res-note">Aucun article pour l\'instant. '
                'Revenez bientôt.</p>')
    return '    <div class="res-grid">\n' + "\n".join(carte(a) for a in articles) + "\n    </div>"


def maj_index(articles, essai):
    s = open(INDEX, encoding="utf-8").read()
    i, j = s.find(DEBUT), s.find(FIN)
    if i < 0 or j < 0:
        raise SystemExit("  ✗ Marqueurs ARTICLES:DÉBUT / ARTICLES:FIN absents de "
                         "blogue.html — le script ne devine pas où écrire.")
    fin_debut = s.index("-->", i) + 3
    neuf = s[:fin_debut] + "\n" + bloc(articles) + "\n    " + s[j:]
    if neuf == s:
        print("  = index déjà à jour")
        return False
    if not essai:
        open(INDEX, "w", encoding="utf-8").write(neuf)
    print(f"  ✓ index {'serait ' if essai else ''}mis à jour "
          f"({len(articles)} article{'s' if len(articles) > 1 else ''})")
    return True


def maj_sitemap(articles, essai):
    """Le sitemap est la deuxième chose qu'on oublie. On n'y touche que pour les
    URL du blogue résidentiel : le reste du fichier est écrit ailleurs."""
    if not os.path.exists(SITEMAP):
        print("  · sitemap.xml absent — passé")
        return False
    s = open(SITEMAP, encoding="utf-8").read()
    voulues = [BASE + "blogue.html"] + [BASE + a["fichier"] for a in articles]
    manquantes = [u for u in voulues if f"<loc>{u}</loc>" not in s]
    if not manquantes:
        print("  = sitemap déjà à jour")
        return False
    ajout = "".join(f"  <url>\n    <loc>{u}</loc>\n"
                    f"    <changefreq>monthly</changefreq>\n"
                    f"    <priority>0.6</priority>\n  </url>\n" for u in manquantes)
    neuf = s.replace("</urlset>", ajout + "</urlset>")
    if not essai:
        open(SITEMAP, "w", encoding="utf-8").write(neuf)
    print(f"  ✓ sitemap : {len(manquantes)} URL {'seraient ' if essai else ''}ajoutée(s)")
    for u in manquantes:
        print(f"      {u}")
    return True


def main():
    essai = "--essai" in sys.argv
    if essai:
        print("Mode essai : rien ne sera écrit.")
    fichiers = sorted(glob.glob(os.path.join(ICI, "blogue-*.html")))
    articles = [lire_article(f) for f in fichiers]
    # Le plus récent en premier : c'est l'ordre qu'un lecteur attend.
    articles.sort(key=lambda a: (a["date"], a["fichier"]), reverse=True)
    print(f"{len(articles)} article(s) trouvé(s) dans residentiel/ :")
    for a in articles:
        print(f"  · {a['date']}  {a['titre']}")
    maj_index(articles, essai)
    maj_sitemap(articles, essai)
    print("Terminé." if not essai else "Essai terminé — rien n'a été écrit.")


if __name__ == "__main__":
    main()
