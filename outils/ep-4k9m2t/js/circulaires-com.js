/*
 * BGFoods — récupération des circulaires depuis circulaires.com.
 *
 * CE QUE ÇA FAIT, ET CE QUE ÇA NE FAIT PAS. Ça rapporte les FICHIERS : les
 * pages de la circulaire en images, l'épicerie et les dates de validité. Ça
 * ne rapporte PAS les prix : les bannières publient leurs circulaires comme
 * des affiches, et la mesure OCR (voir LISEZ-MOI) a donné 2 aubaines sur une
 * pleine page, toutes deux fausses. Les aubaines se saisissent donc à la
 * main — mais en regardant la circulaire dans le même écran, avec l'épicerie
 * et les dates déjà remplies.
 *
 * POURQUOI C'EST POSSIBLE SANS SERVEUR. circulaires.com répond
 * « access-control-allow-origin: * » : une page de bginformatique.ca peut
 * donc lire son HTML directement. Et les images s'affichent de toute façon
 * en <img>, ce qui n'a jamais rien demandé à CORS.
 *
 * SOBRIÉTÉ. Leur robots.txt accueille les robots en demandant de « respecter
 * les ressources de ce serveur ». On ne va donc chercher que ce qui est
 * demandé, une épicerie à la fois, sans boucle automatique : c'est un clic de
 * l'utilisateur qui déclenche chaque récupération.
 *
 * FRAGILITÉ ASSUMÉE. On lit du HTML écrit pour des yeux, pas une interface
 * publiée. Si leur mise en page change, l'extraction cesse de trouver ses
 * repères — les fonctions ci-dessous retournent alors du vide plutôt que
 * d'inventer, et l'écran le dit. Les échantillons de tests/echantillons/
 * figent la structure du 11 août 2026.
 */
"use strict";

import { devinerValidite } from "./analyseur.js";

export const ORIGINE = "https://www.circulaires.com";

/** Épiceries de la section « Alimentation » de leur annuaire. */
export const EPICERIES = [
  { slug: "supermarche-iga", nom: "IGA" },
  { slug: "maxi", nom: "Maxi" },
  { slug: "maxi-cie", nom: "Maxi & Cie" },
  { slug: "metro", nom: "Metro" },
  { slug: "provigo", nom: "Provigo" },
  { slug: "superc", nom: "Super C" },
  { slug: "marche-adonis", nom: "Marché Adonis" },
  { slug: "marche-ami", nom: "Marché Ami" },
  { slug: "avril-supermarche-sante", nom: "Avril" },
  { slug: "marche-axep", nom: "Marché Axep" },
  { slug: "marche-bonichoix", nom: "Bonichoix" },
  { slug: "bulk-barn", nom: "Bulk Barn" },
  { slug: "club-entrepot", nom: "Club Entrepôt" },
  { slug: "inter-marche", nom: "InterMarché" },
  { slug: "metm", nom: "M et M" },
  { slug: "rachelle-bery", nom: "Rachelle-Béry" },
  { slug: "marche-richelieu", nom: "Marché Richelieu" },
  { slug: "marches-tradition", nom: "Marchés Tradition" },
];

export class ErreurCirculaire extends Error {}

/** Ramène une adresse relative ou protocol-relative à une URL absolue. */
export function absolu(lien, base = ORIGINE) {
  if (!lien) return null;
  if (lien.startsWith("//")) return "https:" + lien;
  if (lien.startsWith("http")) return lien;
  return new URL(lien, base.endsWith("/") ? base : base + "/").href;
}

/**
 * Page d'une épicerie -> lien de sa circulaire courante.
 * Le lien porte un identifiant et un horodatage qui changent chaque semaine :
 * il faut donc le relire à chaque fois plutôt que de le fabriquer.
 */
export function extraireLienVisionneuse(html) {
  const m = /href="([^"]*\/circulaire\/\?[^"]*)"/i.exec(html || "");
  return m ? absolu(m[1].replace(/&amp;/g, "&")) : null;
}

/**
 * Page de la visionneuse -> dates de validité, pagination, et pages trouvées.
 *
 * Chaque page de circulaire apparaît deux fois : une vignette (affichable
 * telle quelle dans un <img>) et un lien « imageform » qui mène à l'image
 * pleine résolution. On garde les deux — la vignette pour montrer tout de
 * suite, l'autre pour quand on clique.
 */
export function extraireVisionneuse(html, urlPage) {
  html = html || "";
  const base = urlPage || ORIGINE;

  // Les deux liens d'une même tuile se suivent : le window.open (pleine
  // résolution) puis le src de la vignette.
  const pages = [];
  const vus = new Set();
  const tuiles = html.split(/<td[^>]*class="img"/i).slice(1);
  for (const tuile of tuiles) {
    const pleine = /window\.open\('([^']+)'/i.exec(tuile);
    const vignette = /<img[^>]+src="([^"]+)"/i.exec(tuile);
    if (!pleine || !vignette) continue;
    const lien = absolu(pleine[1].replace(/&amp;/g, "&"), base);
    if (vus.has(lien)) continue;
    vus.add(lien);
    pages.push({ formulaire: lien, vignette: absolu(vignette[1].replace(/&amp;/g, "&"), base) });
  }

  // Pagination : les feuilles suivantes de la même circulaire.
  const pagination = [];
  for (const m of html.matchAll(/class="navi(?:norm|mark)"\s+href="([^"]*index\.do\?flyer=[^"]+)"/gi)) {
    const lien = absolu(m[1].replace(/&amp;/g, "&"), base);
    if (!pagination.includes(lien)) pagination.push(lien);
  }

  // « Valide du jeudi 6 août au mercredi 12 août 2026 » : l'analyseur sait
  // déjà lire cette forme, inutile d'en écrire une seconde.
  const texte = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&ucirc;/g, "û").replace(/&eacute;/g, "é");
  const validite = devinerValidite(texte);

  return { pages, pagination, validite };
}

/** Page « imageform » -> adresse de l'image pleine résolution. */
export function extraireImagePleine(html, urlPage) {
  // L'image est portée par un `src`, pas par un `href` : chercher seulement
  // les liens laissait passer la seule chose qu'on cherchait.
  const m = /(?:src|href)="([^"]*index\.do\?flyer=[^"]*)"/gi;
  for (const trouve of (html || "").matchAll(m)) {
    const lien = trouve[1];
    // Le paramètre est du base64url : « *iga-01.jpg**image**<empreinte> ».
    const jeton = /flyer=([A-Za-z0-9_-]+)/.exec(lien);
    if (!jeton) continue;
    if (decodeJeton(jeton[1]).includes("**image**")) {
      return absolu(lien.replace(/&amp;/g, "&"), urlPage || ORIGINE);
    }
  }
  return null;
}

/** Décode le paramètre `flyer`, sans jamais lever d'exception. */
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

/* ---------- Récupération ---------- */

async function lire(url, recuperer) {
  const reponse = await recuperer(url);
  if (!reponse.ok) throw new ErreurCirculaire(`circulaires.com a répondu ${reponse.status}`);
  return reponse.text();
}

/**
 * Récupère la circulaire courante d'une épicerie : dates et pages en images.
 * `recuperer` est injecté pour que le banc d'essai puisse servir les
 * échantillons enregistrés au lieu d'appeler le site.
 */
export async function chercherCirculaire(slug, options = {}) {
  const recuperer = options.recuperer || ((url) => fetch(url));
  const maxFeuilles = options.maxFeuilles || 12;

  const pageEpicerie = await lire(`${ORIGINE}/${slug}/`, recuperer);
  const lienVisionneuse = extraireLienVisionneuse(pageEpicerie);
  if (!lienVisionneuse) {
    throw new ErreurCirculaire(
      "Aucune circulaire trouvée pour cette épicerie sur circulaires.com — " +
        "elle n'en publie peut-être pas cette semaine.",
    );
  }

  const premiere = await lire(lienVisionneuse, recuperer);
  const debut = extraireVisionneuse(premiere, lienVisionneuse);

  const pages = [...debut.pages];
  const vues = new Set([lienVisionneuse]);
  // Les feuilles suivantes, une à une : le site demande qu'on ménage ses
  // ressources, et une circulaire tient en une dizaine de feuilles.
  for (const lien of debut.pagination.slice(0, maxFeuilles)) {
    if (vues.has(lien)) continue;
    vues.add(lien);
    const feuille = extraireVisionneuse(await lire(lien, recuperer), lien);
    for (const page of feuille.pages) {
      if (!pages.some((p) => p.formulaire === page.formulaire)) pages.push(page);
    }
  }

  return {
    slug,
    epicerie: (EPICERIES.find((e) => e.slug === slug) || {}).nom || slug,
    validite: debut.validite,
    pages,
    source: lienVisionneuse,
  };
}

/** Adresse de l'image pleine résolution d'une page (un aller-retour de plus). */
export async function imagePleine(page, options = {}) {
  const recuperer = options.recuperer || ((url) => fetch(url));
  return extraireImagePleine(await lire(page.formulaire, recuperer), page.formulaire);
}
