#!/usr/bin/env python3
"""Génère les pages de villes résidentielles à partir de `villes.json`.

    ./residentiel/generer-villes.py            # écrit
    ./residentiel/generer-villes.py --essai    # montre ce qui changerait

Pourquoi ce script existe
-------------------------
Une page de ville, écrite à la main, demande six gestes : rédiger la page,
recopier l'en-tête et le pied de page, écrire les données structurées, l'ajouter
au sitemap, la lier depuis l'index résidentiel, et lier les villes voisines
entre elles. Cinq de ces six gestes sont mécaniques, et trois s'oublient.

Ici, la source de vérité est `villes.json`. L'en-tête et le pied de page sont
**relus depuis une page existante** (`services.html`) plutôt que recopiés : si
le site est redessiné, les pages de villes suivent sans qu'on y touche.

Le garde-fou qui compte
-----------------------
Google traite un gabarit dupliqué avec le nom changé comme une page-portail et
l'ignore — parfois il pénalise. Le script REFUSE donc d'écrire une page dont le
champ `contexte` fait moins de 200 caractères. C'est la règle du brief SEO
transformée en code : au moins 30 % de contenu qui n'existe nulle part ailleurs.

Ce qu'il ne fait PAS : écrire le contenu propre à la ville, ni supprimer une
page dont la fiche est passée à `actif: false` — on ne supprime pas une URL
indexée par effet de bord.
"""

import datetime
import html
import json
import os
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.dirname(ICI)
FICHES = os.path.join(ICI, "villes.json")
REFERENCE = os.path.join(ICI, "services.html")
INDEX = os.path.join(ICI, "index.html")
SITEMAP = os.path.join(RACINE, "sitemap.xml")
BASE = "https://bginformatique.ca/residentiel/"

CONTEXTE_MINIMUM = 200

DEBUT_VILLES = "<!-- VILLES:DÉBUT"
FIN_VILLES = "<!-- VILLES:FIN -->"

# La grille de prix vient de tarifs.html. Elle est répétée ici plutôt que
# relue : un prix est une décision d'affaires, pas une donnée à déduire d'un
# gabarit. S'il change là-bas, il change ici — et le test le dira.
SERVICES = [
    ("Nettoyage &amp; optimisation", "70–110 $", "oui"),
    ("Retrait de virus / rançongiciel", "80–140 $", "oui"),
    ("WiFi &amp; réseau maison", "70–130 $", "souvent"),
    ("Imprimante &amp; périphériques", "60–100 $", "oui"),
    ("Sauvegarde &amp; récupération", "90–200 $", "souvent"),
    ("Nouveau PC — config &amp; transfert", "90–160 $", "domicile"),
    ("Courriel &amp; Microsoft/Office", "60–100 $", "oui"),
]

# Le libellé affiché pour chaque état, identique à tarifs.html.
ETATS = {"oui": "oui", "souvent": "souvent", "domicile": "à domicile"}


def echapper(t):
    """Pour un attribut HTML : les guillemets doivent partir."""
    return html.escape(t, quote=True)


def texte(t):
    """Pour du contenu affiché : on laisse les apostrophes tranquilles.

    `html.escape(quote=True)` transforme ' en &#x27;, qui s'affiche bien mais
    rend la source illisible — et en français, une phrase sur deux en contient.
    """
    return html.escape(t, quote=False)


def par_le_trajet(v):
    """« ligne 709 depuis… » → « par la ligne 709 depuis… », sans article bancal."""
    t = v["trajet"]
    return f"par la {t}" if t.startswith("ligne") else t


def extraire(texte, debut, fin, quoi):
    """Découpe un bloc entre deux repères, bornes comprises."""
    i = texte.find(debut)
    j = texte.find(fin, i)
    if i == -1 or j == -1:
        raise SystemExit(f"Repère introuvable dans {REFERENCE} : {quoi}")
    return texte[i:j + len(fin)]


def feuilles_style(t):
    """Relit les deux <link> de feuilles de style d'une page vivante.

    Elles portent un `?v=` que `deploy.sh` recalcule à chaque déploiement (un
    condensé du contenu de style.css + residentiel.css). Les recopier en dur ici
    avait deux effets : une page générée arrivait sans version — donc servie
    depuis le cache du navigateur après un changement de CSS — et le script se
    croyait en retard sur chaque page dès le lendemain d'un déploiement, ce qui
    rendait l'état « inchangé » inutilisable. Même principe que `chrome()` : on
    relit une page vivante au lieu de dupliquer.
    """
    liens = [l for l in t.splitlines()
             if 'rel="stylesheet"' in l and l.lstrip().startswith("<link rel=")]
    if len(liens) != 2:
        raise SystemExit(
            f"Attendu 2 feuilles de style dans {REFERENCE}, trouvé {len(liens)}. "
            "Le gabarit des pages de villes en dépend — vérifier l'en-tête.")
    return "\n".join(liens)


def chrome():
    """Relit l'en-tête, le pied de page et les scripts de fin d'une page vivante."""
    t = open(REFERENCE, encoding="utf-8").read()
    entete = extraire(t, '<header class="res-header"', "</header>", "en-tête")
    # `aria-current="page"` désigne Services sur la page de référence : sur une
    # page de ville, aucune entrée du menu n'est la page courante.
    entete = entete.replace(' aria-current="page"', "")
    pied = extraire(t, '<footer class="res-footer"', "</footer>", "pied de page")
    fin = t[t.find("</footer>") + len("</footer>"):t.find("</body>")]
    return entete, pied, fin, feuilles_style(t)


def faq(v):
    """Trois questions par ville. La première est la vraie question du visiteur."""
    nom = v["nom"]
    q = [
        (f"Est-ce que le déplacement à {nom} est vraiment inclus ?",
         f"Oui, sans condition et sans frais cachés. {nom} fait partie de la zone "
         f"desservie : on s'y rend {par_le_trajet(v)}. Le prix annoncé avant "
         f"l'intervention est le prix final."),
        (f"Est-ce qu'il faut prendre congé pour un rendez-vous à {nom} ?",
         "Non — et c'est justement pour ça que les rendez-vous se prennent aussi en soirée "
         "et la fin de semaine. Vous n'avez pas à poser une journée pour faire "
         "réparer un ordinateur."),
        (f"Est-ce qu'il faut se déplacer pour tout, à {nom} ?",
         "Non. La majorité des problèmes — lenteur, virus, courriel, imprimante, "
         "sauvegarde — se règlent à distance, par connexion sécurisée : c'est plus "
         "rapide et moins cher. Le déplacement sert quand il faut toucher au "
         "matériel, brancher un réseau ou accompagner quelqu'un en personne."),
    ]
    return q


def page(v, entete, pied, fin_scripts, feuilles):
    nom = v["nom"]
    slug = v["slug"]
    url = f"{BASE}depannage-informatique-{slug}.html"
    titre = f"Dépannage informatique à domicile {nom} | BG Informatique"
    meta = (f"Dépannage informatique résidentiel à {nom} : virus, lenteur, WiFi, "
            f"sauvegarde. À distance ou à domicile, déplacement inclus. "
            f"Jour, soir et fin de semaine.")
    questions = faq(v)

    # Les classes viennent de tarifs.html et faq.html : on réutilise le style
    # existant plutôt que d'en inventer, sinon la page arrive sans habillage.
    lignes_prix = "\n".join(
        f'          <tr>\n'
        f'            <td class="service-name">{n}</td>\n'
        f'            <td><span class="dot-state" data-state="{etat}">{ETATS[etat]}</span></td>\n'
        f'            <td class="price-tag">{p}</td>\n'
        f'          </tr>'
        for n, p, etat in SERVICES
    )

    blocs_faq = "\n".join(
        f'        <details>\n'
        f'          <summary>{texte(q)}</summary>\n'
        f'          <div class="a">{texte(r)}</div>\n'
        f'        </details>'
        for q, r in questions
    )

    ld_faq = json.dumps({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer", "text": r}}
            for q, r in questions
        ],
    }, ensure_ascii=False, indent=2)

    ld_service = json.dumps({
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": "Dépannage informatique résidentiel",
        "name": f"Dépannage informatique à domicile — {nom}",
        "url": url,
        "areaServed": {"@type": "City", "name": nom, "addressRegion": "QC",
                       "addressCountry": "CA"},
        "provider": {
            "@type": "LocalBusiness",
            "name": "BG Informatique",
            "telephone": "+1-450-231-9199",
            "url": "https://bginformatique.ca/",
            "address": {"@type": "PostalAddress", "addressLocality": "Saint-Jérôme",
                        "addressRegion": "QC", "addressCountry": "CA"},
            # Pas de openingHoursSpecification : BG reçoit SUR RENDEZ-VOUS, et
            # schema.org n'a pas d'équivalent pour ça — toute plage écrite ici est une
            # promesse d'être joignable à ces heures précises, que Google affiche et
            # dont il mesure les appels abandonnés. Les horaires font autorité sur la
            # fiche Google, où ils se corrigent en trente secondes. Décision du
            # 11 août 2026, Positionnement-BG-et-marche-local.md § 5.
        },
    }, ensure_ascii=False, indent=2)

    gare = f"<p>{texte(v['gare'])}</p>\n      " if v.get("gare") else ""
    local = (f"<p>{texte(v['contexte_local'])}</p>\n      "
             if v.get("contexte_local") else "")

    voisines = ""
    if v.get("voisines"):
        liens = " · ".join(
            f'<a href="/residentiel/depannage-informatique-{s}.html">{s.replace("-", " ").title()}</a>'
            for s in v["voisines"]
        )
        voisines = (
            '<section class="res-section res-section--tight">\n'
            '  <div class="res-wrap">\n'
            '    <p class="res-villes-aussi">On dessert aussi : ' + liens + '</p>\n'
            '  </div>\n'
            '</section>\n\n'
        )

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>{echapper(titre)}</title>
  <meta name="description" content="{echapper(meta)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="{url}">

  <meta property="og:title" content="{echapper(f'Dépannage informatique à domicile — {nom}')}">
  <meta property="og:description" content="{echapper(meta)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="https://bginformatique.ca/og-image.png">
  <meta property="og:locale" content="fr_CA">
  <meta name="twitter:card" content="summary_large_image">

  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">

{feuilles}

  <script type="application/ld+json">
{ld_service}
  </script>

  <script type="application/ld+json">
{ld_faq}
  </script>
</head>
<body class="res">

<!-- Page générée par residentiel/generer-villes.py — ne pas modifier à la main.
     Le contenu propre à la ville se change dans residentiel/villes.json. -->

{entete}

<section class="res-pagehero" aria-labelledby="ville-titre">
  <div class="res-wrap">
    <span class="res-eyebrow">// {texte(nom.lower())}</span>
    <h1 id="ville-titre">Dépannage informatique à {texte(nom)} — à domicile ou à distance</h1>
    <p>Diagnostic gratuit, prix confirmé avant qu'on commence, déplacement inclus.
       Rendez-vous le jour, le soir et la fin de semaine — vous n'avez pas à prendre congé.</p>
  </div>
</section>

<section class="res-section">
  <div class="res-wrap">
    <h2>Se rendre à {texte(nom)}</h2>
    <p>{texte(v['contexte'])}</p>
    {gare}{local}<p><strong>Le déplacement est inclus.</strong> Aucun frais de
    transport ne s'ajoute à la facture, et le prix annoncé avant l'intervention
    est le prix final.</p>
  </div>
</section>

<section class="res-section" aria-label="Services et prix">
  <div class="res-wrap">
    <h2>Les demandes les plus fréquentes à {texte(nom)}</h2>
    <div class="table-scroll">
      <table class="price-table">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Réparable à distance</th>
            <th scope="col">Estimation*</th>
          </tr>
        </thead>
        <tbody>
{lignes_prix}
        </tbody>
      </table>
    </div>
    <p><small>* Fourchettes, pas des prix fixes : le prix exact est confirmé après
       le diagnostic, qui est gratuit. Grille complète sur
       <a href="/residentiel/tarifs.html">la page des tarifs</a>.</small></p>
  </div>
</section>

<section class="res-section" aria-label="Questions fréquentes">
  <div class="res-wrap">
    <h2>Questions fréquentes — {texte(nom)}</h2>
    <div class="res-faq">
{blocs_faq}
    </div>
  </div>
</section>

{voisines}<section class="res-section res-section--tight">
  <div class="res-wrap">
    <div class="res-band">
      <h2>Un problème à {texte(nom)} ? On regarde ça aujourd'hui.</h2>
      <p>Décrivez-nous la situation — le diagnostic est gratuit, sans engagement.</p>
      <div class="res-band-cta">
        <a href="/residentiel/rendez-vous.html" class="btn-cta btn-cta--primary">Prendre rendez-vous →</a>
        <a href="/residentiel/index.html#estimateur" class="res-btn-ghost">Estimer un prix</a>
      </div>
    </div>
  </div>
</section>

{pied}
{fin_scripts}</body>
</html>
"""


def maj_sitemap(urls, essai):
    t = open(SITEMAP, encoding="utf-8").read()
    aujourdhui = datetime.date.today().isoformat()
    ajouts = [u for u in urls if f"<loc>{u}</loc>" not in t]
    if not ajouts:
        return []
    bloc = "\n".join(
        f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{aujourdhui}</lastmod>\n"
        f"    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>"
        for u in ajouts
    )
    if not essai:
        open(SITEMAP, "w", encoding="utf-8").write(
            t.replace("</urlset>", bloc + "\n\n</urlset>")
        )
    return ajouts


def maj_index(villes, essai):
    """Réécrit le bloc de liens de l'index entre ses deux marqueurs.

    Renvoie trois états, et pas deux : `None` si les marqueurs sont absents,
    `True` si le bloc a été réécrit, `False` s'il était déjà à jour. La version
    d'origine renvoyait un seul booléen, ce qui confondait « marqueurs absents »
    et « rien à changer » — c'est-à-dire l'état normal. Le script annonçait donc
    « liens non posés » à chaque passage réussi, et l'alerte disait le contraire
    de la réalité. Une alerte qui crie tout le temps ne se lit plus.
    """
    t = open(INDEX, encoding="utf-8").read()
    i, j = t.find(DEBUT_VILLES), t.find(FIN_VILLES)
    if i == -1 or j == -1:
        return None
    liens = "\n".join(
        f'      <a href="/residentiel/depannage-informatique-{v["slug"]}.html">'
        f'{texte(v["nom"])}</a>'
        for v in villes
    )
    bloc = (f"{DEBUT_VILLES} — généré par generer-villes.py, ne pas modifier à la main -->\n"
            f'    <nav class="res-villes" aria-label="Villes desservies">\n'
            f"{liens}\n"
            f"    </nav>\n"
            f"    {FIN_VILLES}")
    nouveau = t[:i] + bloc + t[j + len(FIN_VILLES):]
    if nouveau != t and not essai:
        open(INDEX, "w", encoding="utf-8").write(nouveau)
    return nouveau != t


def main():
    essai = "--essai" in sys.argv

    fiches = json.load(open(FICHES, encoding="utf-8"))["villes"]
    actives = [v for v in fiches if v.get("actif")]
    if not actives:
        print("Aucune ville active dans villes.json — rien à faire.")
        return 0

    # Garde-fou : pas de page-portail. On vérifie tout avant d'écrire quoi que
    # ce soit, pour ne pas laisser le dossier à moitié généré.
    refus = [v["nom"] for v in actives
             if len(v.get("contexte", "").strip()) < CONTEXTE_MINIMUM]
    if refus:
        print("Aucune écriture. Ces villes n'ont pas de contexte propre "
              f"(minimum {CONTEXTE_MINIMUM} caractères) :\n")
        for n in refus:
            print(f"  · {n}")
        print("\nUne page de ville sans paragraphe unique est une page-portail : "
              "Google l'ignore,\net elle dilue les pages qui, elles, sont bonnes.")
        return 1

    # Deux villes ne peuvent pas partager le même contexte : ce serait la même
    # page-portail, écrite deux fois.
    vus = {}
    for v in actives:
        c = v["contexte"].strip()
        if c in vus:
            print(f"Aucune écriture. {v['nom']} et {vus[c]} ont un contexte identique.")
            return 1
        vus[c] = v["nom"]

    entete, pied, fin_scripts, feuilles = chrome()

    ecrits, inchanges, urls = [], [], []
    for v in actives:
        chemin = os.path.join(ICI, f"depannage-informatique-{v['slug']}.html")
        contenu = page(v, entete, pied, fin_scripts, feuilles)
        urls.append(f"{BASE}depannage-informatique-{v['slug']}.html")
        ancien = open(chemin, encoding="utf-8").read() if os.path.exists(chemin) else None
        if ancien == contenu:
            inchanges.append(v["nom"])
            continue
        if not essai:
            open(chemin, "w", encoding="utf-8").write(contenu)
        ecrits.append(v["nom"])

    ajouts = maj_sitemap(urls, essai)
    index_change = maj_index(actives, essai)

    tete = "[essai] " if essai else ""
    for n in ecrits:
        print(f"{tete}page      {n}")
    for n in inchanges:
        print(f"{tete}inchangé  {n}")
    for u in ajouts:
        print(f"{tete}sitemap   {u}")
    if index_change is None:
        print("index     ⚠️  marqueurs VILLES:DÉBUT/FIN absents de index.html — "
              "liens non posés")
    elif index_change:
        print(f"{tete}index     bloc des villes réécrit")
    else:
        print(f"{tete}index     {len(actives)} lien(s) déjà en place")

    sans_local = [v["nom"] for v in actives if not v.get("contexte_local", "").strip()]
    if sans_local:
        print("\n⚠️  Ces villes n'ont pas de `contexte_local` — la phrase que seul "
              "quelqu'un d'ici\n    peut écrire (un secteur, un axe, un repère). "
              "La page fonctionne sans, mais\n    c'est ce qui la rend crédible :")
        for n in sans_local:
            print(f"      · {n}")

    print(f"\n{len(ecrits)} page(s) écrite(s), {len(inchanges)} inchangée(s), "
          f"{len(ajouts)} URL ajoutée(s) au sitemap.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
