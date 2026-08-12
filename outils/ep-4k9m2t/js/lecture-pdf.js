/*
 * BGFoods — extraction du texte d'un PDF, entièrement dans le navigateur.
 *
 * Aucun serveur ne lit la circulaire : pdf.js est chargé à la demande, la
 * première fois qu'on importe un PDF, et le fichier ne quitte jamais
 * l'appareil.
 *
 * pdf.js rend un PDF comme une nuée de fragments de texte positionnés, pas
 * comme des lignes. Or l'analyseur raisonne EN LIGNES (« Fraises 454 g
 * 2,99 $ »). Tout l'intérêt de ce fichier est là : regrouper les fragments
 * par hauteur, les ordonner de gauche à droite, et décider où mettre une
 * espace — un « 2,99 » recollé à « $ » sans espace reste lisible, mais deux
 * colonnes fusionnées inventent des produits.
 */
"use strict";

// Version épinglée : une mise à jour silencieuse de pdf.js ne doit pas changer
// la lecture des circulaires du jour au lendemain. Pour la faire évoluer,
// changer les DEUX liens ensemble (la bibliothèque refuse un worker d'une
// autre version) et repasser une vraie circulaire dans l'outil.
const VERSION_PDFJS = "4.6.82";
const URL_PDFJS = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION_PDFJS}/build/pdf.min.mjs`;
const URL_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION_PDFJS}/build/pdf.worker.min.mjs`;

// Deux fragments dont les hauteurs diffèrent de moins de ça sont sur la même
// ligne. Les circulaires mélangent beaucoup de tailles de police; trop serré,
// une ligne se scinde en deux et le prix se retrouve orphelin.
const TOLERANCE_LIGNE = 3;

let pdfjsCharge = null;

export class ErreurLecture extends Error {}

async function chargerPdfjs() {
  if (pdfjsCharge) return pdfjsCharge;
  pdfjsCharge = import(/* @vite-ignore */ URL_PDFJS)
    .then((module) => {
      module.GlobalWorkerOptions.workerSrc = URL_WORKER;
      return module;
    })
    .catch((e) => {
      pdfjsCharge = null;
      throw new ErreurLecture(
        "Le lecteur PDF n'a pas pu être chargé (pas de connexion, ou le service " +
          "qui l'héberge est injoignable). Collez le texte de la circulaire dans " +
          "l'onglet prévu à cet effet.",
      );
    });
  return pdfjsCharge;
}

/** Reconstruit les lignes d'une page à partir des fragments positionnés. */
export function lignesDepuisFragments(items, tolerance = TOLERANCE_LIGNE) {
  const lignes = [];
  for (const item of items) {
    const texte = item.str;
    if (!texte || !texte.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const largeur = item.width || 0;

    let ligne = lignes.find((l) => Math.abs(l.y - y) <= tolerance);
    if (!ligne) {
      ligne = { y, fragments: [] };
      lignes.push(ligne);
    }
    ligne.fragments.push({ x, fin: x + largeur, texte });
  }

  lignes.sort((a, b) => b.y - a.y); // du haut de la page vers le bas
  return lignes.map((ligne) => {
    ligne.fragments.sort((a, b) => a.x - b.x);
    let sortie = "";
    let finPrecedente = null;
    for (const fragment of ligne.fragments) {
      if (finPrecedente !== null) {
        // Un mot coupé en plusieurs fragments se recolle sans espace; un vrai
        // blanc typographique en demande une.
        const ecart = fragment.x - finPrecedente;
        if (ecart > 1) sortie += " ";
      }
      sortie += fragment.texte;
      finPrecedente = fragment.fin;
    }
    return sortie.replace(/\s{2,}/g, " ").trim();
  });
}

/**
 * Lit un fichier et retourne le texte page par page.
 * Accepte un PDF ou un fichier texte; refuse le reste en le disant.
 */
export async function lireFichier(fichier) {
  const nom = (fichier.name || "").toLowerCase();

  if (nom.endsWith(".txt") || nom.endsWith(".text") || nom.endsWith(".md")) {
    return { pages: [await fichier.text()], methode: "texte", avertissements: [] };
  }

  if (!nom.endsWith(".pdf")) {
    throw new ErreurLecture(
      "Format non pris en charge : seuls les PDF et les fichiers texte se lisent " +
        "ici. Pour une photo de circulaire, tapez ou collez les aubaines à la main.",
    );
  }

  const pdfjs = await chargerPdfjs();
  const donnees = new Uint8Array(await fichier.arrayBuffer());
  const document = await pdfjs.getDocument({ data: donnees }).promise;

  const pages = [];
  const avertissements = [];
  for (let numero = 1; numero <= document.numPages; numero++) {
    const page = await document.getPage(numero);
    const contenu = await page.getTextContent();
    pages.push(lignesDepuisFragments(contenu.items).join("\n"));
  }

  const vides = pages.filter((p) => !p.trim()).length;
  if (vides === pages.length) {
    throw new ErreurLecture(
      "Ce PDF ne contient aucun texte : c'est une circulaire scannée, ou faite " +
        "d'images. Rien à extraire — collez le texte, ou saisissez les aubaines " +
        "qui vous intéressent.",
    );
  }
  if (vides) avertissements.push(`${vides} page(s) sans texte ont été ignorées.`);

  return {
    pages,
    methode: "pdf",
    avertissements,
    imagesProbables: enImages(pages),
  };
}

/**
 * Une circulaire faite d'images se reconnaît à sa maigreur : les grandes
 * bannières publient un PDF où tout est aplati en image, avec au mieux une
 * ligne de texte pour les dates de validité.
 *
 * Sans ce contrôle, l'outil disait « le texte est peut-être en colonnes
 * illisibles » — trompeur, puisqu'il n'y a pas de texte du tout à lire.
 * Distinguer les deux cas change la consigne donnée à l'utilisateur : dans un
 * cas relancer autrement, dans l'autre cesser d'essayer.
 */
export function enImages(pages) {
  if (!pages.length) return true;
  const caracteres = pages.reduce((somme, p) => somme + p.replace(/\s/g, "").length, 0);
  const pagesAvecTexte = pages.filter((p) => p.replace(/\s/g, "").length >= 40).length;
  // Une vraie circulaire textuelle porte des milliers de caractères par page.
  return caracteres / pages.length < 120 || pagesAvecTexte < pages.length / 2;
}
