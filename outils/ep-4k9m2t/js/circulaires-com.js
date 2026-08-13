/*
 * BGFoods — récupération des circulaires depuis circulaires.com.
 *
 * UNE SEULE SOURCE. Toutes les circulaires viennent de circulaires.com. La
 * liste des épiceries n'est pas écrite en dur ici : elle est lue dans LEUR
 * annuaire d'alimentation filtré par région. Une bannière qu'ils ne recensent
 * pas n'existe donc pas pour l'outil — c'est voulu.
 *
 * DEUX VISIONNEUSES COEXISTENT CHEZ EUX. Il a fallu les gérer toutes les deux ;
 * n'en lire qu'une laissait seize bannières sur trente et une dans le noir.
 *
 *   Type A — /<slug>/circulaire/?…  Les pages sont derrière des jetons signés
 *     (« index.do?flyer=<base64> »), deux par feuille, avec une pagination.
 *     L'adresse de l'image pleine demande un aller-retour de plus.
 *     Piège : certaines bannières écrivent « index.do?str=…&flyer=… ». Un motif
 *     qui exigeait « index.do?flyer= » collé ne voyait qu'IGA, et faisait
 *     passer Maxi, Metro, Provigo et Super C pour des circulaires de 2 pages.
 *
 *   Type B — /d/flyers.do?…  Une page de choix (semaine courante, semaine
 *     prochaine), puis toutes les pages en JPEG en clair. Plus simple, et rien
 *     à résoudre : l'adresse de l'image est déjà là.
 *     Piège : le dossier n'est pas toujours un numéro — « qc01 », « ax01 »,
 *     « mini » existent aussi.
 *
 * CE QUE ÇA RAPPORTE. Les FICHIERS : pages en images, épicerie, dates de
 * validité. Pas les prix — les bannières publient des affiches. La lecture des
 * prix est le travail de extraction-ia.js.
 *
 * POURQUOI ÇA MARCHE SANS SERVEUR. circulaires.com répond
 * « access-control-allow-origin: * » sur ses pages HTML : une page de
 * bginformatique.ca peut les lire. Attention : les JPEG, eux, n'ont pas cet
 * en-tête. On peut les AFFICHER (un <img> n'a jamais rien demandé à CORS) mais
 * pas lire leurs octets en script. D'où le choix, dans extraction-ia.js, de
 * transmettre des adresses plutôt que des images.
 *
 * SOBRIÉTÉ. Leur robots.txt demande de « respecter les ressources de ce
 * serveur ». On ne va chercher qu'une épicerie à la fois, sur un clic, sans
 * boucle automatique.
 *
 * FRAGILITÉ ASSUMÉE. On lit du HTML écrit pour des yeux. Si leur mise en page
 * change, les fonctions ci-dessous rendent du vide plutôt que d'inventer, et
 * l'écran le dit. Les échantillons de tests/echantillons/ figent la structure
 * du 11 août 2026.
 */
"use strict";

import { devinerValidite } from "./analyseur.js";

export const ORIGINE = "https://www.circulaires.com";

/** Régions telles que circulaires.com les découpe. Saint-Jérôme = Laurentides. */
export const REGION_DEFAUT = "Laurentides";
export const REGIONS = [
  "Laurentides", "Lanaudiere", "Laval", "Montreal", "Monteregie", "Outaouais",
  "Mauricie", "Estrie", "Centre-du-Quebec", "Quebec", "Chaudiere-Appalaches",
  "Bas-Saint-Laurent", "Saguenay - Lac-Saint-Jean", "Abitibi-Temiscamingue",
  "Cote-Nord", "Charlevoix", "Gaspesie", "Iles-de-la-Madeleine", "T",
];

export class ErreurCirculaire extends Error {}

/** Ramène une adresse relative ou protocol-relative à une URL absolue. */
export function absolu(lien, base = ORIGINE) {
  if (!lien) return null;
  const propre = lien.replace(/&amp;/g, "&");
  if (propre.startsWith("//")) return "https:" + propre;
  if (propre.startsWith("http")) return propre;
  return new URL(propre, base.endsWith("/") ? base : base + "/").href;
}

function texteNu(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&ucirc;/g, "û")
    .replace(/&agrave;/g, "à")
    .replace(/&amp;/g, "&");
}

/* ---------- Annuaire ---------- */

/**
 * Page « /alimentation/?region=… » -> épiceries recensées pour cette région.
 * Le nom de la bannière est porté par l'`alt` d'une image, pas par du texte :
 * dépouiller les balises sans regarder l'attribut ne rendait rien.
 */
export function extraireEpiceries(html) {
  const horsAnnuaire = new Set([
    "alimentation", "maison", "bureau", "renovation", "sante", "mode", "auto",
    "recherche", "outils", "web", "d", "b",
  ]);
  const trouvees = new Map();
  const motif = /href="(?:https?:)?\/\/www\.circulaires\.com\/([a-z0-9-]+)\/\?region=[^"]*"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  for (const m of (html || "").matchAll(motif)) {
    const slug = m[1];
    if (horsAnnuaire.has(slug) || trouvees.has(slug)) continue;
    const interne = m[2];
    const alt = /alt="([^"]+)"/i.exec(interne);
    let nom = texteNu(interne).replace(/\s+/g, " ").trim();
    if (!nom && alt) nom = alt[1].replace(/&amp;/g, "&").trim();
    nom = nom.replace(/^Circulaire\s+/i, "").replace(/\s*(Laurentides|Lanaudi.re|Laval|Montr.al|Mont.r.gie|Outaouais|Mauricie|Estrie|Qu.bec|Charlevoix|Gasp.sie|Cote-Nord|C.te-Nord)\s*$/i, "").trim();
    if (nom) trouvees.set(slug, { slug, nom });
  }
  return [...trouvees.values()].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

/* ---------- Repérage de la circulaire ---------- */

/**
 * Page d'une épicerie -> lien de sa circulaire, et type de visionneuse.
 * Les liens portent un identifiant de magasin et un horodatage qui changent
 * chaque semaine : il faut les relire à chaque fois, jamais les fabriquer.
 */
export function extraireLienCirculaire(html) {
  const a = /href="([^"]*\/circulaire\/\?[^"]*)"/i.exec(html || "");
  if (a) return { type: "A", lien: absolu(a[1]) };
  const b = /href="([^"]*flyers\.do\?[^"]*)"/i.exec(html || "");
  if (b) return { type: "B", lien: absolu(b[1]) };
  return null;
}

/** Page de choix du type B -> les circulaires proposées (courante, prochaine). */
export function extraireChoix(html, urlPage) {
  const base = urlPage || ORIGINE;
  const liens = [];
  for (const m of (html || "").matchAll(/href="(\.?\/?\?[^"]*dpage=[^"]*)"/gi)) {
    const lien = absolu(m[1], base);
    if (!liens.includes(lien)) liens.push(lien);
  }
  return liens;
}

/* ---------- Type A ---------- */

/**
 * Feuille de la visionneuse A -> pages trouvées, pagination, validité.
 * Chaque page apparaît deux fois : une vignette affichable telle quelle, et un
 * lien « imageform » qui mène à l'image pleine. On garde les deux.
 */
export function extraireVisionneuse(html, urlPage) {
  html = html || "";
  const base = urlPage || ORIGINE;

  const pages = [];
  const vus = new Set();
  for (const tuile of html.split(/<td[^>]*class="img"/i).slice(1)) {
    const pleine = /window\.open\('([^']+)'/i.exec(tuile);
    const vignette = /<img[^>]+src="([^"]+)"/i.exec(tuile);
    if (!pleine || !vignette) continue;
    const lien = absolu(pleine[1], base);
    if (vus.has(lien)) continue;
    vus.add(lien);
    pages.push({ formulaire: lien, apercu: absolu(vignette[1], base) });
  }

  // Pagination. Le « [^"]* » avant flyer= est ce qui manquait : plusieurs
  // bannières glissent « str=… » entre index.do et flyer=.
  const pagination = [];
  for (const m of html.matchAll(/class="navi(?:norm|mark)"\s+href="([^"]*index\.do\?[^"]*flyer=[^"]+)"/gi)) {
    const lien = absolu(m[1], base);
    if (!pagination.includes(lien)) pagination.push(lien);
  }

  return { pages, pagination, validite: devinerValidite(texteNu(html)) };
}

/** Page « imageform » -> adresse de l'image pleine résolution (1900 × 3800 px). */
export function extraireImagePleine(html, urlPage) {
  // L'image est portée par un `src`, pas par un `href` : ne chercher que les
  // liens laissait passer la seule chose qu'on cherchait.
  for (const trouve of (html || "").matchAll(/(?:src|href)="([^"]*index\.do\?[^"]*flyer=[^"]*)"/gi)) {
    const jeton = /flyer=([A-Za-z0-9_-]+)/.exec(trouve[1]);
    if (jeton && decodeJeton(jeton[1]).includes("**image**")) {
      return absolu(trouve[1], urlPage || ORIGINE);
    }
  }
  return null;
}

/** Décode le paramètre `flyer` (base64url), sans jamais lever d'exception. */
export function decodeJeton(jeton) {
  try {
    const complet = jeton.replace(/-/g, "+").replace(/_/g, "/");
    const rembourre = complet + "=".repeat((4 - (complet.length % 4)) % 4);
    return typeof atob === "function"
      ? atob(rembourre)
      : Buffer.from(rembourre, "base64").toString("binary");
  } catch (e) {
    return "";
  }
}

/* ---------- Type B ---------- */

/**
 * Page de la visionneuse B -> toutes les pages en JPEG, d'un coup.
 * Le dossier n'est pas toujours numérique (« qc01 », « ax01 », « mini ») :
 * l'exiger chiffré rendait InterMarché, Axep et TAU muets alors qu'ils
 * publiaient bel et bien.
 */
export function extraireVisionneuseB(html, urlPage) {
  html = html || "";
  const base = urlPage || ORIGINE;
  const pages = [];
  const vus = new Set();
  for (const m of html.matchAll(/<img[^>]+src="([^"]*\/[^"/]+\/[^"/]+\.jpe?g(?:\?[^"]*)?)"/gi)) {
    const lien = absolu(m[1], base);
    if (vus.has(lien) || /\/images\//i.test(lien)) continue;
    vus.add(lien);
    pages.push({ apercu: lien, pleine: lien });
  }
  return { pages, validite: devinerValidite(texteNu(html)) };
}

/* ---------- Récupération ---------- */

async function lire(url, recuperer) {
  const reponse = await recuperer(url);
  if (!reponse.ok) throw new ErreurCirculaire(`circulaires.com a répondu ${reponse.status}`);
  return reponse.text();
}

/** Épiceries recensées par circulaires.com pour une région. */
export async function chercherEpiceries(options = {}) {
  const recuperer = options.recuperer || ((url) => fetch(url));
  const region = options.region || REGION_DEFAUT;
  const html = await lire(`${ORIGINE}/alimentation/?region=${encodeURIComponent(region)}`, recuperer);
  const epiceries = extraireEpiceries(html);
  if (!epiceries.length) {
    throw new ErreurCirculaire(
      "L'annuaire d'alimentation de circulaires.com n'a rendu aucune épicerie — " +
        "leur mise en page a peut-être changé.",
    );
  }
  return epiceries;
}

/**
 * Circulaire courante d'une épicerie : dates et pages en images.
 * `recuperer` est injecté pour que le banc d'essai serve les échantillons
 * enregistrés au lieu d'appeler le site.
 */
export async function chercherCirculaire(slug, options = {}) {
  const recuperer = options.recuperer || ((url) => fetch(url));
  const region = options.region || REGION_DEFAUT;
  const maxFeuilles = options.maxFeuilles || 16;
  const nom = options.nom || slug;

  const pageEpicerie = await lire(
    `${ORIGINE}/${slug}/?region=${encodeURIComponent(region)}`, recuperer);
  const cible = extraireLienCirculaire(pageEpicerie);
  if (!cible) {
    throw new ErreurCirculaire(
      "circulaires.com ne publie aucune circulaire pour cette épicerie cette semaine.",
    );
  }

  const commun = { slug, epicerie: nom, region, type: cible.type, source: cible.lien };

  if (cible.type === "B") {
    const choix = extraireChoix(await lire(cible.lien, recuperer), cible.lien);
    if (!choix.length) {
      throw new ErreurCirculaire("circulaires.com annonce cette épicerie mais n'affiche aucune page.");
    }
    const vue = extraireVisionneuseB(await lire(choix[0], recuperer), choix[0]);
    return { ...commun, ...vue, autresCirculaires: choix.slice(1) };
  }

  const premiere = extraireVisionneuse(await lire(cible.lien, recuperer), cible.lien);
  const pages = [...premiere.pages];
  const vues = new Set([cible.lien]);
  // Les feuilles suivantes, une à une : le site demande qu'on ménage ses
  // ressources, et une circulaire tient en une quinzaine de feuilles.
  for (const lien of premiere.pagination.slice(0, maxFeuilles)) {
    if (vues.has(lien)) continue;
    vues.add(lien);
    for (const page of extraireVisionneuse(await lire(lien, recuperer), lien).pages) {
      if (!pages.some((p) => p.formulaire === page.formulaire)) pages.push(page);
    }
  }
  return { ...commun, validite: premiere.validite, pages, autresCirculaires: [] };
}

/**
 * Dates de la circulaire courante, SANS charger toutes ses pages.
 *
 * C'est la fonction de la veille : pour savoir si une nouvelle circulaire est
 * parue, il suffit des dates, et les dates sont annoncées dès la première
 * feuille. `chercherCirculaire` en lit jusqu'à seize — inutile ici, et c'est
 * autant de requêtes en moins sur leur serveur pour une épicerie qui n'a rien
 * publié de neuf.
 *
 * Rend `null` plutôt que de lever quand l'épicerie ne publie rien : sur une
 * veille qui parcourt plusieurs bannières, l'absence de circulaire est un
 * résultat ordinaire, pas une panne.
 */
export async function chercherValidite(slug, options = {}) {
  const recuperer = options.recuperer || ((url) => fetch(url));
  const region = options.region || REGION_DEFAUT;

  const pageEpicerie = await lire(
    `${ORIGINE}/${slug}/?region=${encodeURIComponent(region)}`, recuperer);
  const cible = extraireLienCirculaire(pageEpicerie);
  if (!cible) return null;

  if (cible.type === "B") {
    const choix = extraireChoix(await lire(cible.lien, recuperer), cible.lien);
    if (!choix.length) return null;
    const vue = extraireVisionneuseB(await lire(choix[0], recuperer), choix[0]);
    if (!vue.pages.length) return null;
    return { slug, region, type: "B", source: cible.lien, validite: vue.validite, pages: vue.pages.length };
  }

  const premiere = extraireVisionneuse(await lire(cible.lien, recuperer), cible.lien);
  if (!premiere.pages.length) return null;
  return { slug, region, type: "A", source: cible.lien, validite: premiere.validite, pages: premiere.pages.length };
}

/**
 * Adresse de l'image pleine résolution d'une page.
 * Type B : elle est déjà connue. Type A : un aller-retour de plus.
 */
export async function imagePleine(page, options = {}) {
  if (page && page.pleine) return page.pleine;
  const recuperer = options.recuperer || ((url) => fetch(url));
  return extraireImagePleine(await lire(page.formulaire, recuperer), page.formulaire);
}
