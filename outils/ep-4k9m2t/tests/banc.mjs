/*
 * Banc d'essai de BGFoods.
 *
 *   node outils/ep-4k9m2t/tests/banc.mjs
 *
 * Il n'y a AUCUNE copie de la logique ici : le banc importe les vrais modules
 * de js/ et les exécute. Une copie divergerait, et un test qui teste sa propre
 * copie ne prouve rien.
 *
 * Les cas viennent de circulaires réelles (IGA, Maxi, Super C). Ce qui est
 * couvert : les formats de prix québécois, les conversions d'unités,
 * l'appariement des noms, et le choix du meilleur prix — c'est-à-dire tout ce
 * qui, en cassant, ferait acheter plus cher sans le dire.
 */
"use strict";

import * as normalisation from "../js/normalisation.js";
import * as analyseur from "../js/analyseur.js";
import * as optimiseur from "../js/optimiseur.js";
import * as etatMod from "../js/etat.js";
import { lignesDepuisFragments, enImages } from "../js/lecture-pdf.js";
import * as circulairesCom from "../js/circulaires-com.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let reussis = 0;
const echecs = [];

function verifier(titre, condition, detail = "") {
  if (condition) {
    reussis++;
  } else {
    echecs.push(`${titre}${detail ? ` — ${detail}` : ""}`);
  }
}

function egal(titre, obtenu, attendu) {
  const memeChose = JSON.stringify(obtenu) === JSON.stringify(attendu);
  verifier(titre, memeChose, memeChose ? "" : `obtenu ${JSON.stringify(obtenu)}, attendu ${JSON.stringify(attendu)}`);
}

function proche(titre, obtenu, attendu, tolerance = 0.1) {
  const ok = obtenu !== null && obtenu !== undefined && Math.abs(obtenu - attendu) <= tolerance;
  verifier(titre, ok, ok ? "" : `obtenu ${obtenu}, attendu ~${attendu}`);
}

/* ==================== Normalisation ==================== */

egal("conversion litres", normalisation.versBase(1.5, "L"), { quantite: 1500, base: "ml" });
egal("conversion kilos", normalisation.versBase(2, "kg"), { quantite: 2000, base: "g" });
proche("conversion livres", normalisation.versBase(1, "lb").quantite, 453.59, 0.01);
egal("unité inconnue refusée", normalisation.versBase(1, "brouette"), null);

proche("prix unitaire du 2 L", normalisation.prixUnitaire(449, 2000, "ml"), 22.45, 0.01);
egal("prix unitaire sans quantité", normalisation.prixUnitaire(449, 0, "ml"), null);

egal("prix en français", normalisation.formatPrix(299), "2,99 $");
egal("prix absent", normalisation.formatPrix(null), "—");
egal("prix unitaire affiché", normalisation.formatPrixUnitaire(65.86, "g"), "0,66 $ /100 g");

egal("format multipaquet lisible", normalisation.formatTaille(12000, "ml"), "12 L");
egal("format en kilos", normalisation.formatTaille(1360, "g"), "1,36 kg");
egal("format en unités", normalisation.formatTaille(6, "unite"), "6 unités");
egal("format simple", normalisation.formatTaille(454, "g"), "454 g");
egal("format absent", normalisation.formatTaille(null, "g"), "");

egal("étiquette simple", normalisation.formatPrixEtiquette(299), "2,99 $");
egal("étiquette multiple", normalisation.formatPrixEtiquette(500, "multiple", { multiQte: 2 }), "2/5,00 $");
egal("étiquette à la livre", normalisation.formatPrixEtiquette(399, "poids", { prixUnite: "lb", prixQte: 1 }), "3,99 $/lb");
egal("étiquette aux 100 g", normalisation.formatPrixEtiquette(349, "poids", { prixUnite: "g", prixQte: 100 }), "3,49 $/100 g");

egal("nom normalisé", normalisation.nomNormalise("Poitrines de poulet désossées"), "poitrine poulet desossee");
egal("pourcentage conservé", normalisation.nomNormalise("Lait 2 % Natrel"), "lait 2 % natrel");

verifier("appariement du lait", normalisation.scoreCorrespondance("lait 2 %", "Lait 2 % Natrel 2 L") > 0.8);
verifier("appariement du poulet", normalisation.scoreCorrespondance("poulet", "Poitrines de poulet désossées") > 0.5);
verifier("produit sans rapport rejeté", normalisation.scoreCorrespondance("poulet", "Fraises du Québec") < 0.3);
verifier("tolérance au pluriel", normalisation.scoreCorrespondance("fraise", "Fraises du Québec") > 0.6);

egal("catégorie viande", normalisation.categorieDevinee("Poitrines de poulet"), "Viandes et poissons");
egal("catégorie laitier", normalisation.categorieDevinee("Lait 2 %"), "Produits laitiers et œufs");
egal("catégorie inconnue", normalisation.categorieDevinee("Objet mystère"), null);

/* ==================== Analyse des circulaires ==================== */

{
  const a = analyseur.analyserLigne("Fraises du Québec 454 g 2,99 $");
  verifier("fraises reconnues", a !== null);
  egal("prix des fraises", a.prixCents, 299);
  egal("format des fraises", [a.tailleValeur, a.tailleUnite], [454, "g"]);
  proche("prix unitaire des fraises", a.prixParUnite, 65.86);
  verifier("nom des fraises", a.nom.toLowerCase().startsWith("fraises"), a.nom);
}

{
  const a = analyseur.analyserLigne("Poitrines de poulet désossées 8,80 $/kg 3,99 $/lb");
  egal("type de prix au poids", a.typePrix, "poids");
  egal("la livre est retenue, pas le kilo", a.prixCents, 399);
  egal("unité du prix", [a.prixQte, a.prixUnite], [1, "lb"]);
  proche("une livre en grammes", a.baseQte, 453.59, 0.01);
  proche("prix unitaire du poulet", a.prixParUnite, 87.96);
  verifier("nom du poulet", a.nom.toLowerCase().includes("poulet"), a.nom);
}

{
  const a = analyseur.analyserLigne("2/5,00 $ Yogourt grec Oikos 4 x 100 g");
  egal("offre multiple", a.typePrix, "multiple");
  egal("quantité de l'offre", a.multiQte, 2);
  egal("prix total de l'offre", a.prixCents, 500);
  proche("quantité totale obtenue", a.baseQte, 800, 0.001);
  verifier("nom du yogourt", normalisation.nomNormalise(a.nom).includes("yogourt"), a.nom);
}

{
  const a = analyseur.analyserLigne("Craquelins Ritz 200 g 2 pour 6,00 $");
  egal("« 2 pour » en toutes lettres", a.multiQte, 2);
  egal("prix du « 2 pour »", a.prixCents, 600);
}

{
  const a = analyseur.analyserLigne("Céréales Kellogg's 320-500 g 3,49 $ Rég. 5,99 $");
  egal("prix de l'aubaine", a.prixCents, 349);
  egal("prix régulier repéré", a.prixRegulierCents, 599);
  egal("format variable pris à la borne basse", a.tailleValeur, 320);
}

{
  const a = analyseur.analyserLigne("Avocats Hass 99 ¢");
  egal("prix en cents", a.prixCents, 99);
  verifier("nom des avocats", a.nom.toLowerCase().startsWith("avocats"), a.nom);
}

{
  const a = analyseur.analyserLigne("Fromage de chèvre 3,49 $/100 g");
  egal("prix aux 100 g", [a.prixQte, a.prixUnite], [100, "g"]);
  proche("prix unitaire déjà aux 100 g", a.prixParUnite, 349, 0.5);
}

{
  const a = analyseur.analyserLigne("Bagels 6 unités 3,49 $");
  egal("unité de base", a.baseUnite, "unite");
  egal("nombre d'unités", a.baseQte, 6);
  proche("prix par bagel", a.prixParUnite, 58.17);
}

egal("mot promotionnel retiré", analyseur.analyserLigne("Brocoli 1,49 $ ch.").nom, "Brocoli");
egal("ligne sans prix ignorée", analyseur.analyserLigne("Fruits et légumes"), null);
egal("entête ignorée", analyseur.analyserLigne("Circulaire du 6 au 12 août 2026"), null);

egal(
  "prix orphelins recollés",
  analyseur.recollerPrixOrphelins(["Lait 2 % Natrel 2 L", "4,49 $", "Beurre non salé 454 g", "5,49 $"]),
  ["Lait 2 % Natrel 2 L 4,49 $", "Beurre non salé 454 g 5,49 $"],
);
egal(
  "pastille de prix placée avant le produit",
  analyseur.recollerPrixOrphelins(["2,99 $", "Fraises du Québec 454 g"]),
  ["Fraises du Québec 454 g 2,99 $"],
);

egal("doublons supprimés", analyseur.analyserPages(["Brocoli 1,49 $", "Brocoli 1,49 $"]).length, 1);
egal(
  "page complète",
  analyseur.analyserPage("Fruits et légumes\nFraises du Québec 454 g 2,99 $\nAvocats Hass 99 ¢\nLait 2 % Natrel 2 L 4,49 $\n").length,
  3,
);

egal("dates en toutes lettres", analyseur.devinerValidite("Circulaire du 6 au 12 août 2026"), {
  debut: "2026-08-06",
  fin: "2026-08-12",
});
egal("dates ISO", analyseur.devinerValidite("Valide 2026-01-02 au 2026-01-08"), {
  debut: "2026-01-02",
  fin: "2026-01-08",
});
egal("aucune date trouvée", analyseur.devinerValidite("Aucune date ici", "2026-08-10"), null);
egal("changement d'année", analyseur.devinerValidite("Du 28 décembre au 3 janvier 2026"), {
  debut: "2026-12-28",
  fin: "2027-01-03",
});

egal("épicerie IGA", analyseur.devinerEpicerie("IGA — Circulaire du 6 au 12 août"), "IGA");
egal("épicerie Super C", analyseur.devinerEpicerie("Bienvenue chez Super C"), "Super C");
egal("bannière inconnue", analyseur.devinerEpicerie("Aucune bannière connue"), null);

/* ==================== Optimisation ==================== */

const AUJOURDHUI = "2026-08-11";
const FIN = "2026-08-17";

function etatDepuis(circulaires) {
  const etat = { circulaires: [], aubaines: [] };
  let idAubaine = 0;
  circulaires.forEach(([epicerie, texte, debut, fin], index) => {
    const id = `c${index}`;
    etat.circulaires.push({ id, epicerie, debut: debut || AUJOURDHUI, fin: fin || FIN });
    for (const aubaine of analyseur.analyserPages([texte])) {
      etat.aubaines.push({ ...aubaine, id: `a${idAubaine++}`, circulaireId: id, validee: 0 });
    }
  });
  return etat;
}

const ETAT = etatDepuis([
  ["IGA", "Lait 2 % Natrel 2 L 4,49 $\nPoitrines de poulet désossées 8,80 $/kg 3,99 $/lb\nFraises du Québec 454 g 2,99 $\n"],
  ["Maxi", "Lait 2 % Québon 2 L 4,27 $\nPoitrines de poulet désossées 9,90 $/kg 4,49 $/lb\nFraises 454 g 3,49 $\n"],
]);

{
  const resultat = optimiseur.optimiser(
    ETAT,
    [{ requete: "lait 2 %", quantite: 1 }, { requete: "poitrine de poulet", quantite: 1 }],
    { dateCible: AUJOURDHUI },
  );
  const choix = {};
  for (const groupe of resultat.groupes) for (const ligne of groupe.lignes) choix[ligne.requete] = ligne.meilleure.epicerie;
  egal("lait le moins cher chez Maxi", choix["lait 2 %"], "Maxi");
  egal("poulet le moins cher chez IGA", choix["poitrine de poulet"], "IGA");
  egal("deux épiceries", resultat.nbEpiceries, 2);
  proche("total de la liste", resultat.total, 427 + 399, 0.01);
}

{
  const resultat = optimiseur.optimiser(ETAT, [{ requete: "lait 2 %", quantite: 3 }], { dateCible: AUJOURDHUI });
  proche("la quantité multiplie le sous-total", resultat.total, 3 * 427, 0.01);
}

{
  const resultat = optimiseur.optimiser(ETAT, [{ requete: "papier hygiénique", quantite: 1 }], { dateCible: AUJOURDHUI });
  egal("article introuvable", resultat.nbArticles, 0);
  egal("article listé à part", resultat.sansAubaine.map((l) => l.requete), ["papier hygiénique"]);
}

{
  const resultat = optimiseur.optimiser(
    ETAT,
    [{ requete: "lait 2 %", quantite: 1 }, { requete: "poitrine de poulet", quantite: 1 }, { requete: "fraises", quantite: 1 }],
    { dateCible: AUJOURDHUI, maxEpiceries: 1 },
  );
  egal("une seule épicerie retenue", resultat.nbEpiceries, 1);
  egal("tous les articles couverts", resultat.nbArticles, 3);
  egal("IGA est le meilleur compromis", resultat.groupes[0].epicerie, "IGA");
}

{
  const resultat = optimiseur.optimiser(ETAT, [{ requete: "lait 2 %", quantite: 1 }], { dateCible: AUJOURDHUI });
  const ligne = resultat.groupes[0].lignes[0];
  verifier("des solutions de rechange sont proposées", ligne.alternatives.length > 0);
  egal("la rechange est l'autre épicerie", ligne.alternatives[0].epicerie, "IGA");
}

{
  const expire = etatDepuis([["Vieille", "Lait 2 % 2 L 1,00 $", "2026-08-01", "2026-08-02"]]);
  const resultat = optimiseur.optimiser(expire, [{ requete: "lait", quantite: 1 }], { dateCible: AUJOURDHUI });
  egal("circulaire expirée exclue", resultat.nbArticles, 0);
}

{
  const etat = etatDepuis([["Super C", "Fraises du Québec 454 g 2/5,00 $"]]);
  const resultat = optimiseur.optimiser(etat, [{ requete: "fraises", quantite: 1 }], { dateCible: AUJOURDHUI });
  const ligne = resultat.groupes[0].lignes[0];
  egal("étiquette de l'offre multiple", optimiseur.etiquettePrix(ligne.meilleure), "2/5,00 $");
  proche("coût ramené à l'unité", ligne.cout, 250, 0.01);
}

{
  const etat = etatDepuis([["IGA", "Céréales Kellogg's 320-500 g 3,49 $ Rég. 5,99 $"]]);
  const resultat = optimiseur.optimiser(etat, [{ requete: "céréales", quantite: 2 }], { dateCible: AUJOURDHUI });
  proche("économie comptée par article", resultat.economies, 2 * 250, 0.01);
}

{
  const groupes = optimiseur.aubainesParEpicerie(ETAT, { dateCible: AUJOURDHUI });
  egal("aubaines groupées par épicerie", groupes.map((g) => g.epicerie).sort(), ["IGA", "Maxi"]);
  verifier("trois aubaines par épicerie", groupes.every((g) => g.nombre === 3));
}

{
  const filtre = optimiseur.aubainesParEpicerie(ETAT, { dateCible: AUJOURDHUI, recherche: "poulet" });
  verifier("recherche filtrante", filtre.every((g) => g.aubaines === undefined || true) && filtre.length === 2);
  const noms = filtre.flatMap((g) => g.categories.flatMap((c) => c.aubaines.map((a) => a.nom)));
  verifier("seul le poulet ressort", noms.every((n) => n.toLowerCase().includes("poulet")), noms.join(" | "));
}

egal("saisie libre des articles", optimiseur.analyserArticles("2 lait 2 %\n- poulet (bio)\n\n3x fraises"), [
  { requete: "lait 2 %", quantite: 2, note: null },
  { requete: "poulet", quantite: 1, note: "bio" },
  { requete: "fraises", quantite: 3, note: null },
]);
egal("articles réécrits en texte", optimiseur.articlesVersTexte([
  { requete: "lait 2 %", quantite: 2, note: null },
  { requete: "fraises", quantite: 1, note: null },
]), "2 lait 2 %\nfraises");

{
  // Correction manuelle : passer d'un prix à l'unité à un prix au poids doit
  // recalculer le prix unitaire, sans quoi la comparaison entre épiceries ment.
  const aubaine = optimiseur.recalculer({
    nom: "Boeuf haché",
    prixCents: 299,
    typePrix: "poids",
    prixUnite: "lb",
    prixQte: 1,
  });
  proche("recalcul après correction", aubaine.prixParUnite, 65.92, 0.05);
  egal("catégorie devinée au recalcul", aubaine.categorie, "Viandes et poissons");
}

/* ==================== Reconstruction des lignes d'un PDF ====================
   pdf.js livre des fragments positionnés, pas des lignes. Si ce regroupement
   se trompe, l'analyseur reçoit des colonnes fusionnées et invente des
   produits — sans jamais rien signaler. */

function fragment(texte, x, y, largeur = texte.length * 5) {
  return { str: texte, transform: [1, 0, 0, 1, x, y], width: largeur };
}

{
  const lignes = lignesDepuisFragments([
    fragment("2,99 $", 300, 700, 30),
    fragment("Fraises du Québec", 60, 700, 90),
    fragment("Lait 2 %", 60, 680, 40),
  ]);
  egal("fragments regroupés par hauteur, ordonnés de gauche à droite", lignes, [
    "Fraises du Québec 2,99 $",
    "Lait 2 %",
  ]);
}

{
  // Un mot coupé en deux fragments contigus se recolle sans espace parasite.
  const lignes = lignesDepuisFragments([fragment("Frai", 60, 700, 20), fragment("ses", 80, 700, 15)]);
  egal("mot coupé recollé", lignes, ["Fraises"]);
}

{
  // Deux hauteurs très proches restent la même ligne : les circulaires
  // mélangent les tailles de police dans un même bloc de prix.
  const lignes = lignesDepuisFragments([fragment("Brocoli", 60, 700, 40), fragment("1,49 $", 200, 698, 30)]);
  egal("hauteurs voisines fusionnées", lignes, ["Brocoli 1,49 $"]);
}

{
  const lignes = lignesDepuisFragments([fragment("Haut", 60, 900, 20), fragment("Bas", 60, 100, 20), fragment("   ", 60, 500, 5)]);
  egal("lecture du haut vers le bas, fragments vides ignorés", lignes, ["Haut", "Bas"]);
}

/* ==================== Circulaires faites d'images ====================
   Cas mesuré sur une vraie circulaire IGA : 8 pages, dont une seule portant du
   texte — la ligne des dates. L'outil doit le reconnaître et le DIRE, au lieu
   de renvoyer l'utilisateur vers un texte en colonnes qui n'existe pas. */

{
  const igaReelle = ["Valide du jeudi 6 août au mercredi 12 août 2026", "", "", "", "", "", "", ""];
  verifier("circulaire en images reconnue", enImages(igaReelle) === true);

  // Les dates restent récupérables même sans une seule aubaine : c'est tout ce
  // que ce genre de PDF donne, et c'est déjà utile pour la saisie à la main.
  egal("dates lues malgré l'absence de texte utile", analyseur.devinerValidite(igaReelle.join("\n")), {
    debut: "2026-08-06",
    fin: "2026-08-12",
  });
  egal("aucune aubaine inventée", analyseur.analyserPages(igaReelle).length, 0);
}

{
  const vraiTexte = [
    "Fraises du Québec 454 g 2,99 $\nPoitrines de poulet 3,99 $/lb\nLait 2 % 2 L 4,49 $\n".repeat(6),
    "Céréales Kellogg's 320-500 g 3,49 $\nPain tranché 675 g 2,99 $\n".repeat(6),
  ];
  verifier("circulaire textuelle non confondue", enImages(vraiTexte) === false);
}

/* ==================== Récupération depuis circulaires.com ====================
   Les fonctions d'extraction sont éprouvées sur les VRAIES pages du site,
   enregistrées le 11 août 2026 dans tests/echantillons/. On lit du HTML écrit
   pour des yeux : le jour où leur mise en page changera, ces essais tomberont
   — c'est précisément leur rôle. */

const ICI = dirname(fileURLToPath(import.meta.url));
const echantillon = (nom) =>
  readFileSync(join(ICI, `echantillons/circulaires-com-${nom}.html`), "utf-8");

{
  const lien = circulairesCom.extraireLienVisionneuse(echantillon("epicerie"));
  verifier("lien de la visionneuse trouvé", !!lien && lien.includes("/circulaire/?"), String(lien));

  const vue = circulairesCom.extraireVisionneuse(echantillon("visionneuse"), lien);
  egal("dates de validité lues", vue.validite, { debut: "2026-08-06", fin: "2026-08-12" });
  egal("pages de cette feuille", vue.pages.length, 2);
  egal("feuilles paginées", vue.pagination.length, 7);

  // Le paramètre `flyer` est du base64url : « *iga-01.jpg**imageform**<empreinte> ».
  const jeton = /flyer=([A-Za-z0-9_-]+)/.exec(vue.pages[0].formulaire)[1];
  verifier(
    "le lien de page mène au formulaire d'image",
    circulairesCom.decodeJeton(jeton).includes("**imageform**"),
    circulairesCom.decodeJeton(jeton),
  );
  verifier("chaque page porte sa vignette", vue.pages.every((p) => p.vignette.startsWith("https://")));
}

{
  // L'image pleine résolution est portée par un `src`, pas par un `href` :
  // ne chercher que les liens laissait passer la seule chose qu'on cherchait.
  const image = circulairesCom.extraireImagePleine(echantillon("imageform"));
  verifier("adresse de l'image pleine résolution trouvée", !!image, String(image));
  const jeton = /flyer=([A-Za-z0-9_-]+)/.exec(image)[1];
  verifier(
    "et c'est bien l'image, pas son formulaire",
    circulairesCom.decodeJeton(jeton).includes("**image**"),
    circulairesCom.decodeJeton(jeton),
  );
}

{
  egal("adresse protocol-relative complétée",
    circulairesCom.absolu("//www.circulaires.com/x/"), "https://www.circulaires.com/x/");
  egal("page sans circulaire : rien plutôt qu'une invention",
    circulairesCom.extraireLienVisionneuse("<html><body>rien ici</body></html>"), null);
  egal("HTML méconnaissable : aucune page inventée",
    circulairesCom.extraireVisionneuse("<html></html>").pages.length, 0);
  egal("jeton illisible toléré", circulairesCom.decodeJeton("!!!pas du base64!!!"), "");
  verifier("les épiceries d'alimentation sont listées", circulairesCom.EPICERIES.length >= 18);
}

{
  // La récupération complète, servie par les échantillons : aucun appel réseau.
  const parUrl = (url) => {
    if (url.endsWith("/supermarche-iga/")) return echantillon("epicerie");
    if (url.includes("/circulaire/?")) return echantillon("visionneuse");
    return "<html></html>";
  };
  const recuperer = async (url) => ({ ok: true, status: 200, text: async () => parUrl(url) });
  const circulaire = await circulairesCom.chercherCirculaire("supermarche-iga", { recuperer });
  egal("épicerie nommée", circulaire.epicerie, "IGA");
  egal("dates rapportées", circulaire.validite, { debut: "2026-08-06", fin: "2026-08-12" });
  verifier("des pages sont rapportées", circulaire.pages.length >= 2, String(circulaire.pages.length));

  const vide = async () => ({ ok: true, status: 200, text: async () => "<html></html>" });
  let messageErreur = "";
  await circulairesCom.chercherCirculaire("epicerie-sans-circulaire", { recuperer: vide })
    .catch((e) => { messageErreur = e.message; });
  verifier("absence de circulaire annoncée clairement",
    messageErreur.includes("Aucune circulaire trouvée"), messageErreur);
}

/* ==================== Fusion multi-appareils ====================
   Les quatre façons de perdre du travail entre l'ordinateur et le téléphone.
   Un échec ici ne casse rien à l'écran : il efface silencieusement. */

function etatAvec(circulaires, aubaines, listes = [], tombes = {}, updatedAt = 100) {
  return { circulaires, aubaines, listes, tombes, updatedAt };
}

{
  // 1. Ajout croisé : chacun a importé une circulaire différente.
  const pc = etatAvec([{ id: "c1", epicerie: "IGA", updatedAt: 100 }], []);
  const cell = etatAvec([{ id: "c2", epicerie: "Maxi", updatedAt: 110 }], []);
  const fusion = etatMod.fusionner(pc, cell);
  egal("ajout croisé conservé", fusion.circulaires.map((c) => c.id).sort(), ["c1", "c2"]);
}

{
  // 2. Édition concurrente : la correction la plus récente gagne.
  const ancien = etatAvec([{ id: "c1", updatedAt: 100 }], [{ id: "a1", circulaireId: "c1", nom: "Lait", updatedAt: 100 }]);
  const recent = etatAvec([{ id: "c1", updatedAt: 100 }], [{ id: "a1", circulaireId: "c1", nom: "Lait 2 %", updatedAt: 200 }], [], {}, 200);
  egal("édition la plus récente retenue", etatMod.fusionner(ancien, recent).aubaines[0].nom, "Lait 2 %");
  egal("fusion commutative", etatMod.fusionner(recent, ancien).aubaines[0].nom, "Lait 2 %");
}

{
  // 3. Résurrection : l'appareil qui n'a pas vu la suppression la réimpose.
  const supprime = etatAvec([{ id: "c1", updatedAt: 100 }], [], [], { a1: 300 }, 300);
  const retardataire = etatAvec([{ id: "c1", updatedAt: 100 }], [{ id: "a1", circulaireId: "c1", updatedAt: 100 }]);
  egal("aubaine supprimée reste supprimée", etatMod.fusionner(supprime, retardataire).aubaines.length, 0);
}

{
  // 4. Recréation après suppression : ce qui est plus récent que la tombe revient.
  const supprime = etatAvec([{ id: "c1", updatedAt: 100 }], [], [], { a1: 300 }, 300);
  const recree = etatAvec([{ id: "c1", updatedAt: 100 }], [{ id: "a1", circulaireId: "c1", updatedAt: 400 }], [], {}, 400);
  egal("recréation postérieure conservée", etatMod.fusionner(supprime, recree).aubaines.length, 1);
}

{
  // Supprimer une circulaire emporte ses aubaines, tombes comprises.
  const etat = etatMod.etatVide();
  etatMod.ajouter(etat, "circulaires", { id: "c1", epicerie: "IGA" }, 100);
  etatMod.ajouter(etat, "aubaines", { id: "a1", circulaireId: "c1", nom: "Lait" }, 100);
  etatMod.supprimer(etat, "circulaires", "c1", 500);
  egal("circulaire supprimée", etat.circulaires.length, 0);
  egal("ses aubaines aussi", etat.aubaines.length, 0);
  verifier("tombe posée sur l'aubaine", etat.tombes.a1 === 500);

  const retardataire = etatAvec([{ id: "c1", epicerie: "IGA", updatedAt: 100 }], [{ id: "a1", circulaireId: "c1", updatedAt: 100 }]);
  const fusion = etatMod.fusionner(etat, retardataire);
  egal("rien ne ressuscite après la fusion", [fusion.circulaires.length, fusion.aubaines.length], [0, 0]);
}

{
  // Une aubaine orpheline ne doit pas survivre à la fusion.
  const orpheline = etatAvec([], [{ id: "a9", circulaireId: "disparue", updatedAt: 100 }]);
  egal("aubaine orpheline écartée", etatMod.fusionner(etatMod.etatVide(), orpheline).aubaines.length, 0);
}

{
  const stockage = {
    valeurs: {},
    getItem(cle) { return this.valeurs[cle] ?? null; },
    setItem(cle, valeur) { this.valeurs[cle] = valeur; },
  };
  const etat = etatMod.etatVide();
  etatMod.ajouter(etat, "listes", { id: "l1", nom: "Semaine", articles: [] }, 100);
  etatMod.ecrireLocal(stockage, etat);
  egal("relecture du stockage local", etatMod.lireLocal(stockage).listes[0].nom, "Semaine");
  egal("stockage illisible toléré", etatMod.lireLocal({ getItem: () => "{pas du json" }).listes.length, 0);
}

/* ==================== Verdict ==================== */

console.log(`\n  ${reussis} vérification(s) passée(s)`);
if (echecs.length) {
  console.log(`  ${echecs.length} ÉCHEC(S) :`);
  for (const echec of echecs) console.log(`    ✗ ${echec}`);
  process.exit(1);
}
console.log("✅ Banc d'essai de BGFoods : tout passe.\n");
