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
import * as extractionIA from "../js/extraction-ia.js";
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

/* ---------- Taille du foyer ---------- */
{
  egal("deux adultes valent la référence", optimiseur.partsFoyer({ adultes: 2 }), 2);
  egal("un foyer vide ne multiplie rien", optimiseur.facteurFoyer({}), 1);
  egal("un foyer non renseigné ne multiplie rien", optimiseur.facteurFoyer(), 1);
  proche("un ado compte plus qu'un adulte",
    optimiseur.partsFoyer({ adultes: 2, ados: 1 }), 3.2, 0.001);
  proche("un enfant compte moins",
    optimiseur.partsFoyer({ adultes: 2, enfants: 1 }), 2.6, 0.001);

  egal("deux adultes : quantités inchangées", optimiseur.quantiteAjustee(1, { adultes: 2 }), 1);
  egal("quatre adultes : quantités doublées", optimiseur.quantiteAjustee(1, { adultes: 4 }), 2);
  egal("2 adultes + 2 ados + 1 enfant",
    optimiseur.quantiteAjustee(1, { adultes: 2, ados: 2, enfants: 1 }), 3);
  egal("une quantité ne descend jamais sous 1",
    optimiseur.quantiteAjustee(1, { adultes: 1 }), 1);
  egal("la quantité écrite est multipliée, pas remplacée",
    optimiseur.quantiteAjustee(3, { adultes: 4 }), 6);
  egal("une saisie absurde ne casse rien", optimiseur.quantiteAjustee(null, { adultes: -5 }), 1);
}

/* ---------- Panier bâti sur les spéciaux ---------- */
{
  const ETAT_PANIER = etatDepuis([
    ["IGA",
      "Poitrines de poulet désossées 3,99 $/lb Rég. 7,99 $\n"
      + "Longe de porc désossée 1,85 $/lb\n"
      + "Cubes de boeuf à ragoût 6,99 $/lb\n"
      + "Bifteck d'aloyau 10,99 $/lb\n"
      + "Fraises du Québec 454 g 1,99 $ Rég. 3,99 $\n"
      + "Brocoli 1,47 $\nCarottes 340 g 1,50 $\nPommes 2,99 $\nTomates 1,50 $/lb\n"
      + "Lait 2 % Natrel 2 L 4,49 $\nFromage Cheddar 400 g 5,49 $\n"
      + "Pain tranché 675 g 2,99 $\n"],
  ]);

  const panier = optimiseur.meilleursSpeciaux(ETAT_PANIER, { dateCible: AUJOURDHUI });
  verifier("un panier est proposé", panier.length > 0, `${panier.length} article(s)`);

  const parCategorie = {};
  for (const article of panier) {
    const a = ETAT_PANIER.aubaines.find((x) => x.nom === article.requete);
    parCategorie[a.categorie] = (parCategorie[a.categorie] || 0) + 1;
  }
  verifier("le panier est réparti, pas rempli d'une seule catégorie",
    Object.keys(parCategorie).length >= 2, JSON.stringify(parCategorie));
  verifier("les quotas par catégorie sont respectés",
    Object.entries(parCategorie).every(([c, n]) => n <= optimiseur.QUOTAS_PANIER[c]),
    JSON.stringify(parCategorie));

  // Le poulet a le plus fort rabais annoncé : il doit passer devant l'aloyau,
  // qui est plus cher et sans prix régulier.
  const viandes = panier.filter((x) => /poulet|porc|boeuf|aloyau/i.test(x.requete));
  verifier("la viande au plus fort rabais est retenue",
    viandes.some((v) => /poulet/i.test(v.requete)), JSON.stringify(viandes.map((v) => v.requete)));

  const prioritaires = panier.filter((x) => x.priorite);
  egal("deux protéines arrivent étoilées", prioritaires.length, optimiseur.NB_PRIORITAIRES);
  verifier("et ce sont bien des viandes",
    prioritaires.every((p) => /poulet|porc|boeuf|aloyau/i.test(p.requete)),
    JSON.stringify(prioritaires.map((p) => p.requete)));

  const grandFoyer = optimiseur.meilleursSpeciaux(ETAT_PANIER,
    { dateCible: AUJOURDHUI, foyer: { adultes: 2, ados: 2 } });
  verifier("le panier d'un grand foyer porte des quantités plus élevées",
    grandFoyer.every((a) => a.quantite === 2), JSON.stringify(grandFoyer.map((a) => a.quantite)));

  // Un même produit en rabais dans deux épiceries ne doit apparaître qu'une fois.
  const ETAT_DOUBLE = etatDepuis([
    ["IGA", "Fraises du Québec 454 g 2,99 $\n"],
    ["Maxi", "Fraises du Québec 454 g 2,49 $\n"],
  ]);
  const sansDoublon = optimiseur.meilleursSpeciaux(ETAT_DOUBLE, { dateCible: AUJOURDHUI });
  egal("un produit en rabais dans deux épiceries n'est pris qu'une fois", sansDoublon.length, 1);

  egal("sans aubaine, pas de panier inventé",
    optimiseur.meilleursSpeciaux({ circulaires: [], aubaines: [] }, { dateCible: AUJOURDHUI }).length, 0);

  // Sans prix régulier, on ne peut rien affirmer sur le rabais.
  egal("aucun rabais annoncé : on ne l'invente pas",
    optimiseur.rabaisRelatif({ prixCents: 299, prixRegulierCents: null }), null);
  proche("rabais lu quand la circulaire l'annonce",
    optimiseur.rabaisRelatif({ prixCents: 200, prixRegulierCents: 400 }), 0.5, 0.001);
}

/* ---------- Budget ----------
   Deux règles, et la première prime : un article étoilé n'est jamais retiré,
   et ce qu'on sacrifie d'abord est ce qui coûte cher SANS être une aubaine. */
{
  const ETAT_BUDGET = etatDepuis([
    ["IGA",
      // Grosse aubaine : cher, mais moitié prix. À garder.
      "Rôti de boeuf 20,00 $ Rég. 40,00 $\n"
      // Cher et plein prix : le premier à sauter.
      + "Huile d'olive 15,00 $\n"
      // Bon marché, sans rabais annoncé.
      + "Pain tranché 675 g 3,00 $\n"],
  ]);
  const articles = [
    { requete: "rôti de boeuf", quantite: 1 },
    { requete: "huile d'olive", quantite: 1 },
    { requete: "pain tranché", quantite: 1 },
  ];

  const sansBudget = optimiseur.optimiser(ETAT_BUDGET, articles, { dateCible: AUJOURDHUI });
  proche("sans budget, tout est acheté", sansBudget.total, 3800, 1);
  egal("et rien n'est mis de côté", sansBudget.retiresBudget.length, 0);
  egal("le budget n'est pas inventé", sansBudget.budgetCents, null);

  const avecBudget = optimiseur.optimiser(ETAT_BUDGET, articles,
    { dateCible: AUJOURDHUI, budgetCents: 2500 });
  verifier("le total rentre dans le budget", avecBudget.total <= 2500,
    `${avecBudget.total} > 2500`);
  egal("un seul article a suffi à rentrer", avecBudget.retiresBudget.length, 1);
  egal("c'est le cher sans rabais qui saute",
    avecBudget.retiresBudget[0].requete, "huile d'olive");
  verifier("la grosse aubaine est gardée",
    avecBudget.groupes.some((g) => g.lignes.some((l) => l.requete === "rôti de boeuf")));
  proche("la marge restante est rapportée", avecBudget.resteBudget, 2500 - avecBudget.total, 1);
  verifier("aucun dépassement signalé", !avecBudget.budgetDepasse);

  // Un article étoilé ne se retire pas, même s'il fait exploser le budget.
  const prioritaire = optimiseur.optimiser(
    ETAT_BUDGET,
    articles.map((a) => (a.requete === "huile d'olive" ? { ...a, priorite: true } : a)),
    { dateCible: AUJOURDHUI, budgetCents: 2500 },
  );
  verifier("un article prioritaire n'est jamais retiré par le budget",
    !prioritaire.retiresBudget.some((l) => l.requete === "huile d'olive"),
    JSON.stringify(prioritaire.retiresBudget.map((l) => l.requete)));

  // Budget si serré que même les prioritaires ne rentrent pas : on le dit.
  const tropSerre = optimiseur.optimiser(
    ETAT_BUDGET,
    articles.map((a) => ({ ...a, priorite: true })),
    { dateCible: AUJOURDHUI, budgetCents: 500 },
  );
  verifier("un budget intenable est annoncé, pas contourné", tropSerre.budgetDepasse);
  egal("et rien n'a été retiré en douce", tropSerre.retiresBudget.length, 0);
  verifier("le dépassement est chiffré", tropSerre.resteBudget < 0, String(tropSerre.resteBudget));

  const large = optimiseur.optimiser(ETAT_BUDGET, articles,
    { dateCible: AUJOURDHUI, budgetCents: 100000 });
  egal("un budget large ne retire rien", large.retiresBudget.length, 0);
}

/* ---------- Priorités d'un plan ----------
   L'étoile doit peser sur le CHOIX des épiceries, pas seulement s'afficher.
   Le montage ci-dessous est fait pour que la priorité renverse la décision :
   une épicerie couvre deux articles ordinaires, l'autre le seul prioritaire. */
{
  const ETAT_PRIO = etatDepuis([
    ["Nombreux", "Lait 2 % Natrel 2 L 4,49 $\nFraises du Québec 454 g 2,99 $\n"],
    ["Unique", "Poitrines de poulet désossées 8,80 $/kg 3,99 $/lb\n"],
  ]);
  const articles = [
    { requete: "lait 2 %", quantite: 1 },
    { requete: "fraises", quantite: 1 },
    { requete: "poitrine de poulet", quantite: 1 },
  ];

  const sansPriorite = optimiseur.optimiser(ETAT_PRIO, articles,
    { dateCible: AUJOURDHUI, maxEpiceries: 1 });
  egal("sans priorité, l'épicerie qui couvre le plus l'emporte",
    sansPriorite.groupes[0].epicerie, "Nombreux");

  const avecPriorite = optimiseur.optimiser(
    ETAT_PRIO,
    articles.map((a) => (a.requete === "poitrine de poulet" ? { ...a, priorite: true } : a)),
    { dateCible: AUJOURDHUI, maxEpiceries: 1 },
  );
  egal("un article prioritaire renverse le choix de l'épicerie",
    avecPriorite.groupes[0].epicerie, "Unique");
  egal("et c'est bien lui qu'on rapporte", avecPriorite.groupes[0].lignes[0].requete,
    "poitrine de poulet");
  verifier("la priorité voyage jusqu'à la ligne", avecPriorite.groupes[0].lignes[0].priorite);
  egal("les articles abandonnés restent visibles",
    avecPriorite.sansAubaine.map((l) => l.requete).sort(), ["fraises", "lait 2 %"]);

  // Deux prioritaires valent plus qu'un : le poids n'est pas un simple drapeau.
  verifier("le poids de priorité est supérieur à un article ordinaire",
    optimiseur.POIDS_PRIORITE > 1, String(optimiseur.POIDS_PRIORITE));
}

{
  // Dans un magasin, les prioritaires en tête : au rayon, on les prend d'abord.
  const resultat = optimiseur.optimiser(
    ETAT,
    [{ requete: "lait 2 %", quantite: 1 }, { requete: "fraises", quantite: 1, priorite: true }],
    { dateCible: AUJOURDHUI, maxEpiceries: 1 },
  );
  const ordre = resultat.groupes[0].lignes.map((l) => l.requete);
  egal("les prioritaires passent devant dans le groupe", ordre[0], "fraises");
  egal("sans perdre les autres", ordre.length, 2);
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
  // ---- Annuaire : c'est LEUR liste qui fait foi, jamais une liste écrite ici.
  const epiceries = circulairesCom.extraireEpiceries(echantillon("annuaire"));
  verifier("l'annuaire d'alimentation rend les bannières de la région",
    epiceries.length >= 25, `${epiceries.length} bannières`);
  const slugs = epiceries.map((e) => e.slug);
  for (const attendu of ["supermarche-iga", "maxi", "metro", "superc", "provigo",
                         "marche-richelieu", "marches-tradition", "walmart"]) {
    verifier(`l'annuaire liste ${attendu}`, slugs.includes(attendu));
  }
  // Le nom est porté par l'`alt` d'une image : le dépouillement naïf rendait vide.
  const iga = epiceries.find((e) => e.slug === "supermarche-iga");
  egal("le nom de la bannière est lu malgré l'absence de texte", iga.nom, "IGA");
  verifier("le nom ne traîne pas la région", !/Laurentides/.test(iga.nom), iga.nom);
  egal("annuaire méconnaissable : aucune épicerie inventée",
    circulairesCom.extraireEpiceries("<html></html>").length, 0);
}

{
  // ---- Type A : jetons signés, pagination, image pleine en deux temps.
  const cible = circulairesCom.extraireLienCirculaire(echantillon("epicerie"));
  egal("visionneuse de type A reconnue", cible.type, "A");
  verifier("lien de la visionneuse trouvé", cible.lien.includes("/circulaire/?"), cible.lien);

  const vue = circulairesCom.extraireVisionneuse(echantillon("visionneuse"), cible.lien);
  egal("dates de validité lues", vue.validite, { debut: "2026-08-06", fin: "2026-08-12" });
  egal("pages de cette feuille", vue.pages.length, 2);
  egal("feuilles paginées", vue.pagination.length, 7);

  const jeton = /flyer=([A-Za-z0-9_-]+)/.exec(vue.pages[0].formulaire)[1];
  verifier("le lien de page mène au formulaire d'image",
    circulairesCom.decodeJeton(jeton).includes("**imageform**"),
    circulairesCom.decodeJeton(jeton));
  verifier("chaque page porte son aperçu", vue.pages.every((p) => p.apercu.startsWith("https://")));
}

{
  // ---- Le défaut qui faisait passer Maxi pour une circulaire de 2 pages :
  // certaines bannières écrivent « index.do?str=…&flyer=… ». Un motif qui
  // exigeait « index.do?flyer= » collé ne voyait aucune feuille suivante.
  const vue = circulairesCom.extraireVisionneuse(echantillon("visionneuse-maxi"),
    "https://www.circulaires.com/maxi/circulaire/");
  egal("pagination trouvée malgré le « str= » intercalé", vue.pagination.length, 6);
  verifier("les feuilles suivantes sont bien des pages de circulaire",
    vue.pagination.every((l) => l.includes("flyer=")), vue.pagination[1]);
}

{
  // ---- Type B : page de choix, puis les JPEG en clair.
  const cible = circulairesCom.extraireLienCirculaire(echantillon("epicerie-b"));
  egal("visionneuse de type B reconnue", cible.type, "B");
  const choix = circulairesCom.extraireChoix(echantillon("choix-b"), cible.lien);
  egal("les deux semaines proposées sont vues", choix.length, 2);
  verifier("chaque choix pointe une circulaire", choix.every((l) => l.includes("dpage=")), choix[0]);

  const vue = circulairesCom.extraireVisionneuseB(echantillon("visionneuse-b"),
    "https://circulaires.com/d/?sname=marche-richelieu&dpage=11");
  egal("toutes les pages d'un coup", vue.pages.length, 7);
  egal("dates lues sur la visionneuse B", vue.validite, { debut: "2026-08-13", fin: "2026-08-19" });
  verifier("l'image pleine est déjà connue, sans aller-retour",
    vue.pages.every((p) => p.pleine === p.apercu && /\.jpg/.test(p.pleine)), vue.pages[0].pleine);
  verifier("le décor du site n'est pas pris pour une page",
    vue.pages.every((p) => !p.pleine.includes("/images/")));
}

{
  // Le dossier n'est pas toujours numérique : « qc01 », « ax01 », « mini »
  // existent. L'exiger chiffré rendait InterMarché, Axep et TAU muets.
  const faux = '<img src="./inter-marche/qc01/qc-03.jpg?0811">'
             + '<img src="./marches-tau/mini/tau-01.jpg?0811">';
  egal("dossiers non numériques acceptés",
    circulairesCom.extraireVisionneuseB(faux, "https://circulaires.com/d/").pages.length, 2);
}

{
  egal("adresse protocol-relative complétée",
    circulairesCom.absolu("//www.circulaires.com/x/"), "https://www.circulaires.com/x/");
  egal("page sans circulaire : rien plutôt qu'une invention",
    circulairesCom.extraireLienCirculaire("<html><body>rien ici</body></html>"), null);
  egal("HTML méconnaissable : aucune page inventée",
    circulairesCom.extraireVisionneuse("<html></html>").pages.length, 0);
  egal("jeton illisible toléré", circulairesCom.decodeJeton("!!!pas du base64!!!"), "");
}

{
  // ---- Récupération complète, servie par les échantillons : aucun appel réseau.
  const recuperer = async (url) => ({
    ok: true, status: 200,
    text: async () => {
      if (url.includes("/alimentation/")) return echantillon("annuaire");
      if (url.includes("/supermarche-iga/?")) return echantillon("epicerie");
      if (url.includes("/circulaire/?")) return echantillon("visionneuse");
      if (url.includes("/marche-richelieu/?")) return echantillon("epicerie-b");
      if (url.includes("flyers.do")) return echantillon("choix-b");
      if (url.includes("dpage=")) return echantillon("visionneuse-b");
      return "<html></html>";
    },
  });

  const listees = await circulairesCom.chercherEpiceries({ recuperer });
  verifier("les épiceries viennent de l'annuaire, pas d'une liste en dur",
    listees.length >= 25, `${listees.length}`);

  const a = await circulairesCom.chercherCirculaire("supermarche-iga", { recuperer, nom: "IGA" });
  egal("épicerie nommée", a.epicerie, "IGA");
  egal("dates rapportées", a.validite, { debut: "2026-08-06", fin: "2026-08-12" });
  verifier("des pages sont rapportées", a.pages.length >= 2, String(a.pages.length));

  const b = await circulairesCom.chercherCirculaire("marche-richelieu", { recuperer, nom: "Marché Richelieu" });
  egal("le type B passe par la page de choix", b.type, "B");
  egal("et rend ses pages", b.pages.length, 7);
  egal("la semaine suivante reste accessible", b.autresCirculaires.length, 1);
  egal("image pleine du type B : sans aller-retour",
    await circulairesCom.imagePleine(b.pages[0]), b.pages[0].pleine);

  const vide = async () => ({ ok: true, status: 200, text: async () => "<html></html>" });
  let messageErreur = "";
  await circulairesCom.chercherCirculaire("epicerie-sans-circulaire", { recuperer: vide })
    .catch((e) => { messageErreur = e.message; });
  verifier("absence de circulaire annoncée clairement",
    messageErreur.includes("ne publie aucune circulaire"), messageErreur);
}

/* ==================== Extraction par IA ====================
   On ne touche pas au réseau : l'envoi est injecté. Ce qui compte ici, c'est
   que la clé ne parte jamais dans le code et que la consigne demande bien le
   format que analyseur.js sait lire. */

{
  let recu = null;
  const envoyer = async (url, init) => {
    recu = { url, init, corps: JSON.parse(init.body) };
    return {
      ok: true, status: 200,
      json: async () => ({ content: [{ type: "text", text: "Fraises du Québec 454 g 2,99 $" }] }),
    };
  };
  const texte = await extractionIA.lirePage("https://www.circulaires.com/page-01.jpg",
    { cle: "sk-ant-essai", envoyer });
  egal("la lecture rend les lignes du modèle", texte, "Fraises du Québec 454 g 2,99 $");
  egal("appel dirigé vers l'API Messages", recu.url, extractionIA.POINT_API);
  egal("en-tête d'accès navigateur présent",
    recu.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  // Les JPEG de circulaires.com n'ont pas d'en-tête CORS : impossible d'en lire
  // les octets ici. On transmet l'adresse, et c'est Anthropic qui va la chercher.
  const image = recu.corps.messages[0].content[0];
  egal("l'image est transmise par adresse, pas par octets", image.source.type, "url");
  verifier("la consigne demande le format que l'analyseur sait lire",
    extractionIA.CONSIGNE.includes("$/lb") && extractionIA.CONSIGNE.includes("2/5,00 $"));

  // Ce que le modèle rend doit traverser l'analyseur habituel sans traitement
  // de faveur : mêmes prix unitaires, mêmes vérifications qu'une saisie à la main.
  const lues = analyseur.analyserPage("Fraises du Québec 454 g 2,99 $\nPoitrines de poulet 3,99 $/lb");
  egal("les lignes de l'IA passent par l'analyseur habituel", lues.length, 2);

  let refus = "";
  await extractionIA.lirePage("https://x/p.jpg", { cle: "", envoyer })
    .catch((e) => { refus = e.message; });
  verifier("sans clé, on refuse au lieu d'appeler", refus.includes("Aucune clé"), refus);

  const casse = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) });
  let message401 = "";
  await extractionIA.lirePage("https://x/p.jpg", { cle: "sk-mauvaise", envoyer: casse })
    .catch((e) => { message401 = e.message; });
  verifier("clé refusée : message clair", message401.includes("401"), message401);

  // Une page qui échoue ne doit pas emporter les autres.
  let n = 0;
  const capricieux = async () => {
    n++;
    if (n === 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Pain 2,49 $" }] }) };
  };
  const lot = await extractionIA.lireCirculaire(["a", "b", "c"], { cle: "k", envoyer: capricieux });
  egal("une page en échec n'emporte pas les autres", lot.texte.split("\n").length, 2);
  egal("et l'échec est rapporté", lot.echecs.length, 1);

  verifier("l'ordre pour le terminal porte les adresses",
    extractionIA.ordrePourTerminal({ epicerie: "IGA", validite: { debut: "2026-08-06", fin: "2026-08-12" } },
      ["https://x/1.jpg", "https://x/2.jpg"]).includes("https://x/2.jpg"));
  verifier("le coût annoncé reste dans un ordre de grandeur plausible",
    extractionIA.coutApproximatif(14) > 0.05 && extractionIA.coutApproximatif(14) < 1);
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
