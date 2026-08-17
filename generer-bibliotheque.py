#!/usr/bin/env python3
"""La bibliothèque : un nombre FINI de guides, tenus à jour, jamais un flux.

    ./generer-bibliotheque.py --etat      # où on en est, n'écrit rien
    ./generer-bibliotheque.py --essai     # ce qui changerait, n'écrit rien
    ./generer-bibliotheque.py             # applique

Pourquoi ce script existe
-------------------------
Un blogue est un flux : il faut le nourrir, il grossit sans fin, et le même
sujet finit traité deux fois à deux profondeurs — c'était déjà le cas ici, la
section « hameçonnage » du Centre d'aide (594 octets) doublant l'article sur le
faux soutien technique (14 Ko).

Une bibliothèque est bornée. Sa liste est arrêtée d'avance dans
`_bibliotheque/sujets.tsv` : un sujet par vraie question, tiré des services que
le site vend et des questions du Centre d'aide. On MET À JOUR une page, on n'en
ajoute pas une deuxième sur le même sujet. Quand les quatorze sujets sont
écrits, la bibliothèque est finie — et c'est le but.

Ce que le script fait
---------------------
  1. VÉRIFIE la borne : toute page `blogue-*.html` présente sur le disque doit
     être au registre, et tout sujet marqué « ecrit » doit avoir sa page. Un
     écart arrête tout — c'est la garde qui empêche le retour du flux.
  2. régénère les deux index (résidentiel et entreprises) entre leurs marqueurs ;
  3. met le sitemap à jour ;
  4. pose dans le Centre d'aide, sous chaque question, le lien vers le guide
     qui l'approfondit — pour que le court et le long cessent de se concurrencer.

Ce qu'il ne fait PAS : écrire les guides, ni renommer les pages. Les fichiers
gardent leur nom `blogue-*.html` parce que ces URL sont indexées et répondent
200 : casser une adresse pour un préfixe plus joli coûterait le référencement
que ces textes servent justement à aller chercher.

Le titre, la description et la date d'un guide écrit sont lus DANS SA PAGE : le
registre porte le plan, la page porte la vérité.
"""

import glob
import html
import os
import re
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
REGISTRE = os.path.join(ICI, "_bibliotheque", "sujets.tsv")
SITEMAP = os.path.join(ICI, "sitemap.xml")
CENTRE_AIDE = os.path.join(ICI, "guides-depannage.html")
BASE = "https://bginformatique.ca/"

INDEX = {"residentiel": os.path.join(ICI, "residentiel", "blogue.html"),
         "entreprises": os.path.join(ICI, "entreprises", "blogue.html")}

DEBUT, FIN = "<!-- ARTICLES:DÉBUT", "<!-- ARTICLES:FIN -->"
LIEN_DEBUT, LIEN_FIN = "<!-- GUIDE:DÉBUT -->", "<!-- GUIDE:FIN -->"

MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
        "août", "septembre", "octobre", "novembre", "décembre"]

# Une icône par sujet, choisie sur le slug. Sans correspondance, la générique.
ICONES = {
    "arnaque|soutien|hameconnage|publicites|rancongiciel|mots-de-passe":
        '<path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    "sauvegarde|photos|loi-25":
        '<rect width="18" height="14" x="3" y="5" rx="2"/><circle cx="12" cy="12" r="3"/>',
    "wifi|reseau":
        '<path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M12 20h.01"/>',
    "lent|demarrage|imprimante":
        '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/>',
}
ICONE_DEFAUT = ('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>'
                '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>')

ETAT = "--etat" in sys.argv
ESSAI = "--essai" in sys.argv or ETAT


# ── le registre ─────────────────────────────────────────────────────────────

def lire_registre():
    lignes = [l for l in open(REGISTRE, encoding="utf-8").read().splitlines() if l.strip()]
    entetes = lignes[0].split("\t")
    sujets = []
    for l in lignes[1:]:
        c = l.split("\t") + [""] * len(entetes)
        s = dict(zip(entetes, c))
        s["ANCRES"] = [a.strip() for a in s["ANCRES"].split(",") if a.strip()]
        sujets.append(s)
    return sujets


def lire_page(chemin):
    """Titre, description et date d'un guide — lus dans la page elle-même."""
    s = open(os.path.join(ICI, chemin), encoding="utf-8").read()

    def champ(motif, defaut=""):
        m = re.search(motif, s, re.S | re.I)
        return html.unescape(m.group(1).strip()) if m else defaut

    titre = champ(r"<title>(.*?)</title>").split(" | ")[0].strip()
    desc = champ(r'<meta name="description" content="(.*?)"')
    date = champ(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"')
    if not titre or not date:
        raise SystemExit(f"  ✗ {chemin} : il manque un <title> ou un datePublished.")
    # Temps de lecture : compté sur le texte visible, à 200 mots la minute.
    texte = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", s)
    mots = len(re.sub(r"<[^>]+>", " ", texte).split())
    return {"titre": titre, "desc": desc, "date": date,
            "minutes": max(1, round(mots / 200))}


def verifier(sujets):
    """La borne. Sans elle, « bibliothèque » n'est qu'une intention."""
    soucis = []
    aide = open(CENTRE_AIDE, encoding="utf-8").read()
    au_registre = {s["FICHIER"] for s in sujets if s["FICHIER"]}
    sur_disque = set()
    for motif in ("residentiel/blogue-*.html", "entreprises/blogue-*.html"):
        for f in glob.glob(os.path.join(ICI, motif)):
            sur_disque.add(os.path.relpath(f, ICI).replace(os.sep, "/"))

    for f in sorted(sur_disque - au_registre):
        soucis.append(f"{f} existe mais n'est dans aucun sujet du registre.\n"
                      f"      Un guide hors registre, c'est le flux qui recommence :\n"
                      f"      l'inscrire dans _bibliotheque/sujets.tsv, ou le retirer.")
    for s in sujets:
        if s["ETAT"] == "ecrit" and not s["FICHIER"]:
            soucis.append(f"{s['SLUG']} est marqué « ecrit » sans FICHIER.")
        elif s["ETAT"] == "ecrit" and not os.path.exists(os.path.join(ICI, s["FICHIER"])):
            soucis.append(f"{s['SLUG']} : {s['FICHIER']} est introuvable.")
        for a in s["ANCRES"]:
            if f'id="{a}"' not in aide:
                soucis.append(f"{s['SLUG']} vise l'ancre « {a} », absente du Centre d'aide.")
    return soucis


# ── les deux index ──────────────────────────────────────────────────────────

def txt(v):
    """Échappe pour un nœud TEXTE : &, < et > seulement.

    html.escape() échappe aussi l'apostrophe en &#x27;, ce qui est valide mais
    illisible dans la source — et inutile hors d'un attribut.
    """
    return html.escape(v, quote=False)


def icone(slug):
    for motif, chemin in ICONES.items():
        if re.search(motif, slug):
            return chemin
    return ICONE_DEFAUT


def date_lisible(iso):
    a, m, j = iso.split("-")
    return f"{int(j)} {MOIS[int(m) - 1]} {a}"


def carte_residentielle(s, p):
    return f"""      <a href="/{s['FICHIER']}" class="res-card">
        <span class="res-card-icon"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{icone(s['SLUG'])}</svg></span>
        <h3>{txt(p['titre'])}</h3>
        <p>{txt(p['desc'])}</p>
        <span class="more">{date_lisible(p['date'])} · {p['minutes']} min · Lire →</span>
      </a>"""


def carte_entreprise(s, p):
    return f"""      <article class="card post-card">
        <span class="post-tag">{txt(s['ETIQUETTE'])}</span>
        <h3><a href="/{s['FICHIER']}">{txt(p['titre'])}</a></h3>
        <p>{txt(p['desc'])}</p>
        <p class="post-meta">{date_lisible(p['date'])} · {p['minutes']} min de lecture</p>
        <a href="/{s['FICHIER']}" class="btn-cta btn-cta--ghost" style="margin-top:16px; align-self:flex-start;">Lire le guide →</a>
      </article>"""


def maj_index(volet, ecrits):
    chemin = INDEX[volet]
    s = open(chemin, encoding="utf-8").read()
    i, j = s.find(DEBUT), s.find(FIN)
    if i < 0 or j < 0:
        raise SystemExit(f"  ✗ marqueurs ARTICLES:DÉBUT/FIN absents de {volet}/blogue.html")
    faire = carte_residentielle if volet == "residentiel" else carte_entreprise
    if ecrits:
        corps = "\n".join(faire(s2, p) for s2, p in ecrits)
        bloc = ('    <div class="res-grid">\n' + corps + "\n    </div>"
                if volet == "residentiel" else corps)
    else:
        bloc = '    <p class="res-note">Aucun guide pour l\'instant.</p>'
    fin_debut = s.index("-->", i) + 3
    neuf = s[:fin_debut] + "\n" + bloc + "\n    " + s[j:]
    if neuf == s:
        print(f"  = index {volet} déjà à jour")
        return False
    if not ESSAI:
        open(chemin, "w", encoding="utf-8").write(neuf)
    print(f"  ✓ index {volet} {'serait ' if ESSAI else ''}régénéré ({len(ecrits)} guide(s))")
    return True


# ── le sitemap ──────────────────────────────────────────────────────────────

def maj_sitemap(ecrits):
    if not os.path.exists(SITEMAP):
        print("  · sitemap.xml absent — passé")
        return False
    s = open(SITEMAP, encoding="utf-8").read()
    voulues = [BASE + "residentiel/blogue.html", BASE + "entreprises/blogue.html"]
    voulues += [BASE + su["FICHIER"] for su, _ in ecrits]
    manquantes = [u for u in voulues if f"<loc>{u}</loc>" not in s]
    if not manquantes:
        print("  = sitemap déjà à jour")
        return False
    ajout = "".join(f"  <url>\n    <loc>{u}</loc>\n"
                    f"    <changefreq>monthly</changefreq>\n"
                    f"    <priority>0.6</priority>\n  </url>\n" for u in manquantes)
    if not ESSAI:
        open(SITEMAP, "w", encoding="utf-8").write(s.replace("</urlset>", ajout + "</urlset>"))
    print(f"  ✓ sitemap : {len(manquantes)} URL {'seraient ' if ESSAI else ''}ajoutée(s)")
    return True


# ── le Centre d'aide ────────────────────────────────────────────────────────

def maj_centre_aide(sujets, pages):
    """Sous chaque question, le lien vers le guide qui l'approfondit.

    C'est ce qui fait tenir le modèle : la question garde ses premiers gestes,
    le guide porte le fond, et le même sujet cesse d'être traité deux fois.
    """
    s = open(CENTRE_AIDE, encoding="utf-8").read()
    liens = {}
    for su in sujets:
        if su["ETAT"] != "ecrit":
            continue
        for a in su["ANCRES"]:
            liens[a] = (su, pages[su["SLUG"]])

    change = 0
    for m in list(re.finditer(r'<details class="faq-item" id="([^"]+)">[\s\S]*?</details>', s))[::-1]:
        ancre, bloc = m.group(1), m.group(0)
        i, j = bloc.find(LIEN_DEBUT), bloc.find(LIEN_FIN)
        if i < 0 or j < 0:
            continue
        if ancre in liens:
            su, p = liens[ancre]
            contenu = (f'\n          <p class="guide-lien">Pour aller au fond : '
                       f'<a href="/{su["FICHIER"]}">{txt(p["titre"])}</a> '
                       f'<span class="guide-lien-duree">({p["minutes"]} min)</span></p>\n          ')
        else:
            contenu = "\n          "
        neuf = bloc[:i + len(LIEN_DEBUT)] + contenu + bloc[j:]
        if neuf != bloc:
            s = s[:m.start()] + neuf + s[m.end():]
            change += 1
    if not change:
        print("  = Centre d'aide déjà à jour")
        return False
    if not ESSAI:
        open(CENTRE_AIDE, "w", encoding="utf-8").write(s)
    print(f"  ✓ Centre d'aide : {change} lien(s) {'seraient ' if ESSAI else ''}posé(s)")
    return True


# ── l'état ──────────────────────────────────────────────────────────────────

def afficher_etat(sujets, pages):
    for volet in ("residentiel", "entreprises"):
        du_volet = [s for s in sujets if s["VOLET"] == volet]
        faits = [s for s in du_volet if s["ETAT"] == "ecrit"]
        print(f"\n  {volet.upper()} — {len(faits)}/{len(du_volet)} écrits")
        for s in du_volet:
            if s["ETAT"] == "ecrit":
                p = pages[s["SLUG"]]
                print(f"    ✓ {p['titre'][:62]}")
                print(f"        {p['date']} · {p['minutes']} min · /{s['FICHIER']}")
            else:
                print(f"    ○ {s['TITRE'][:62]}")
                print(f"        à écrire — {s['PROMESSE'][:70]}")
    total = len(sujets)
    faits = sum(1 for s in sujets if s["ETAT"] == "ecrit")
    print(f"\n  ── {faits}/{total} guides écrits. La liste est CLOSE : "
          f"un sujet de plus s'ajoute ici,\n     pas dans un dossier.")


def main():
    print("Bibliothèque BG — guides bornés, tenus à jour\n")
    sujets = lire_registre()

    soucis = verifier(sujets)
    if soucis:
        print("  La borne est rompue :\n")
        for s in soucis:
            print(f"  ✗ {s}")
        return 1

    pages = {}
    for su in sujets:
        if su["ETAT"] != "ecrit":
            continue
        p = lire_page(su["FICHIER"])
        if su.get("RESUME", "").strip():
            p["desc"] = su["RESUME"].strip()
        pages[su["SLUG"]] = p

    if ETAT:
        afficher_etat(sujets, pages)
        return 0

    for volet in ("residentiel", "entreprises"):
        ecrits = [(s, pages[s["SLUG"]]) for s in sujets
                  if s["VOLET"] == volet and s["ETAT"] == "ecrit"]
        ecrits.sort(key=lambda e: (e[1]["date"], e[0]["SLUG"]), reverse=True)
        maj_index(volet, ecrits)

    tous = [(s, pages[s["SLUG"]]) for s in sujets if s["ETAT"] == "ecrit"]
    maj_sitemap(tous)
    maj_centre_aide(sujets, pages)

    if ESSAI:
        print("\n  Essai : rien n'a été écrit.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
