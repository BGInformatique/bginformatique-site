/*
 * BGFoods — du besoin à la liste : appariement des articles demandés avec les
 * aubaines en vigueur, choix du meilleur prix, regroupement par épicerie.
 *
 * La comparaison se fait au PRIX UNITAIRE quand les candidats sont
 * comparables (même unité de base), sinon au prix affiché. C'est tout
 * l'intérêt de l'outil : un 500 g à 4,49 $ et un 1 kg à 7,99 $ ne se
 * départagent pas de tête dans une allée.
 */
"use strict";

import {
  UNITE,
  categorieDevinee,
  formatPrixEtiquette,
  formatTaille,
  nomNormalise,
  prixUnitaire,
  scoreCorrespondance,
  versBase,
} from "./normalisation.js";

export const SEUIL_CORRESPONDANCE = 0.45;
const MAX_ALTERNATIVES = 4;

/* ---------- Recalcul après correction manuelle ---------- */

/** Recalcule quantité de base et prix unitaire d'une aubaine modifiée à la main. */
export function recalculer(aubaine) {
  const type = aubaine.typePrix || "unite";
  const multi = aubaine.multiQte || 0;
  let baseQte = null;
  let baseUnite = null;

  if (type === "poids" && aubaine.prixUnite) {
    // Le prix vise une quantité (1 lb, 1 kg, 100 g) et non l'emballage.
    const converti = versBase(Number(aubaine.prixQte) || 1, aubaine.prixUnite);
    if (converti) {
      baseQte = converti.quantite;
      baseUnite = converti.base;
    }
  } else if (aubaine.tailleValeur && aubaine.tailleUnite) {
    const converti = versBase(Number(aubaine.tailleValeur), aubaine.tailleUnite);
    if (converti) {
      baseQte = converti.quantite;
      baseUnite = converti.base;
      if (type === "multiple" && multi > 1) baseQte *= multi;
    }
  }
  if (baseQte === null) {
    baseQte = type === "multiple" && multi > 1 ? multi : 1;
    baseUnite = UNITE;
  }

  aubaine.baseQte = baseQte;
  aubaine.baseUnite = baseUnite;
  aubaine.prixParUnite = aubaine.prixCents ? prixUnitaire(aubaine.prixCents, baseQte, baseUnite) : null;
  aubaine.nomNormalise = nomNormalise(aubaine.nom || "");
  if (!aubaine.categorie) aubaine.categorie = categorieDevinee(aubaine.nom || "");
  return aubaine;
}

/* ---------- Aubaines en vigueur ---------- */

/**
 * Aplatit l'état en une liste d'aubaines portant leur épicerie et leurs dates,
 * limitée à celles dont la circulaire couvre la date demandée.
 */
export function aubainesActives(etat, dateCible, options = {}) {
  const { epiceries = null, valideesSeulement = false } = options;
  const circulaires = new Map((etat.circulaires || []).map((c) => [c.id, c]));
  const actives = [];
  for (const aubaine of etat.aubaines || []) {
    const circulaire = circulaires.get(aubaine.circulaireId);
    if (!circulaire) continue;
    if (circulaire.debut > dateCible || circulaire.fin < dateCible) continue;
    if (valideesSeulement && !aubaine.validee) continue;
    if (epiceries && epiceries.length && !epiceries.includes(circulaire.epicerie)) continue;
    if (!aubaine.prixCents) continue;
    actives.push({ ...aubaine, epicerie: circulaire.epicerie, debut: circulaire.debut, fin: circulaire.fin });
  }
  return actives;
}

/* ---------- Coût d'un exemplaire ---------- */

/** Coût d'un exemplaire, en tenant compte des « 2 pour 5 $ ». */
export function coutUnitaire(aubaine) {
  if (aubaine.typePrix === "multiple" && aubaine.multiQte > 1) {
    return aubaine.prixCents / aubaine.multiQte;
  }
  return aubaine.prixCents;
}

export function economieUnitaire(aubaine) {
  if (!aubaine.prixRegulierCents || aubaine.prixRegulierCents <= aubaine.prixCents) return 0;
  const diviseur = aubaine.typePrix === "multiple" && aubaine.multiQte ? aubaine.multiQte : 1;
  return (aubaine.prixRegulierCents - aubaine.prixCents) / diviseur;
}

export function etiquettePrix(aubaine) {
  return formatPrixEtiquette(aubaine.prixCents, aubaine.typePrix, {
    multiQte: aubaine.multiQte,
    prixUnite: aubaine.prixUnite,
    prixQte: aubaine.prixQte,
  });
}

export function etiquetteTaille(aubaine) {
  return formatTaille(aubaine.tailleValeur, aubaine.tailleUnite);
}

/* ---------- Recherche et classement ---------- */

function classer(candidats) {
  if (!candidats.length) return [];
  // Unité de base majoritaire : c'est elle qui définit ce qui est comparable.
  const comptes = new Map();
  for (const c of candidats) {
    if (c.prixParUnite === null || c.prixParUnite === undefined) continue;
    comptes.set(c.baseUnite, (comptes.get(c.baseUnite) || 0) + 1);
  }
  let dominante = null;
  let meilleurCompte = 0;
  for (const [unite, compte] of comptes) {
    if (compte > meilleurCompte) {
      dominante = unite;
      meilleurCompte = compte;
    }
  }

  return [...candidats].sort((a, b) => {
    const aComparable = a.prixParUnite != null && a.baseUnite === dominante;
    const bComparable = b.prixParUnite != null && b.baseUnite === dominante;
    if (aComparable !== bComparable) return aComparable ? -1 : 1;
    const aPrix = aComparable ? a.prixParUnite : coutUnitaire(a);
    const bPrix = bComparable ? b.prixParUnite : coutUnitaire(b);
    if (aPrix !== bPrix) return aPrix - bPrix;
    // À prix égal, la correspondance la plus franche gagne.
    if (b.score !== a.score) return b.score - a.score;
    return coutUnitaire(a) - coutUnitaire(b);
  });
}

export function trouverCandidats(aubaines, requete, seuil = SEUIL_CORRESPONDANCE) {
  const trouves = [];
  for (const aubaine of aubaines) {
    const score = scoreCorrespondance(requete, aubaine.nom);
    if (score >= seuil) trouves.push({ ...aubaine, score });
  }
  return classer(trouves);
}

/* ---------- Saisie libre des articles ---------- */

const QUANTITE_RE = /^(?<qte>\d{1,3})\s*(?:x|×|\*)?\s+(?<reste>.+)$/i;
const NOTE_RE = /^(?<requete>[^(]+)\((?<note>[^)]*)\)\s*$/;

/** « 2 lait 2 % » ou « poulet (bio) » -> { requete, quantite, note } */
export function analyserArticles(brut) {
  const lignes = [];
  for (const ligneBrute of (brut || "").split("\n")) {
    let texte = ligneBrute.trim().replace(/^[-•*]+/, "").trim();
    if (!texte) continue;

    let quantite = 1;
    const q = QUANTITE_RE.exec(texte);
    if (q) {
      quantite = Math.max(1, parseInt(q.groups.qte, 10));
      texte = q.groups.reste.trim();
    }

    let note = null;
    const n = NOTE_RE.exec(texte);
    if (n) {
      texte = n.groups.requete.trim();
      note = n.groups.note.trim() || null;
    }
    if (texte) lignes.push({ requete: texte, quantite, note });
  }
  return lignes;
}

export function articlesVersTexte(lignes) {
  return (lignes || [])
    .map((l) => `${l.quantite > 1 ? `${l.quantite} ` : ""}${l.requete}${l.note ? ` (${l.note})` : ""}`)
    .join("\n");
}

/* ---------- Taille du foyer ----------
 *
 * Les quantités d'un plan sont écrites POUR UN MÉNAGE DE DEUX ADULTES, et
 * multipliées ensuite selon qui mange. Un adolescent compte pour davantage
 * qu'un adulte — c'est l'âge où l'on mange le plus — et un enfant pour moins.
 *
 * Ce sont des ordres de grandeur, pas une science : ils servent à éviter
 * d'acheter pour deux quand on est cinq. Ils sont écrits ici, en clair, pour
 * qu'on puisse les contester.
 */
export const PARTS = { adultes: 1, ados: 1.2, enfants: 0.6 };
export const FOYER_REFERENCE = 2;   // deux adultes

export function partsFoyer(foyer = {}) {
  const n = (v) => Math.max(0, parseInt(v, 10) || 0);
  return n(foyer.adultes) * PARTS.adultes
    + n(foyer.ados) * PARTS.ados
    + n(foyer.enfants) * PARTS.enfants;
}

/** Multiplicateur de quantité. Un foyer non renseigné ne change rien. */
export function facteurFoyer(foyer = {}) {
  const parts = partsFoyer(foyer);
  return parts > 0 ? parts / FOYER_REFERENCE : 1;
}

export function quantiteAjustee(quantite, foyer) {
  const base = Math.max(1, parseInt(quantite, 10) || 1);
  return Math.max(1, Math.round(base * facteurFoyer(foyer)));
}

/* ---------- Panier bâti sur les spéciaux ----------
 *
 * Quand on demande un plan sans avoir rien choisi, on en propose un à partir
 * des rabais en cours. Le panier est réparti par catégorie plutôt que pris
 * dans l'ordre du meilleur rabais : sinon une semaine à fort rabais sur la
 * viande donnerait douze viandes et aucun légume.
 */
export const QUOTAS_PANIER = {
  "Viandes et poissons": 3,
  "Fruits et légumes": 4,
  "Produits laitiers et œufs": 2,
  "Épicerie": 2,
  "Boulangerie": 1,
  "Surgelés": 1,
};

/** Les repas se bâtissent autour des protéines : elles arrivent étoilées. */
export const CATEGORIE_PRIORITAIRE = "Viandes et poissons";
export const NB_PRIORITAIRES = 2;

/**
 * Rabais relatif, quand la circulaire annonce un prix régulier.
 * Sans prix régulier on ne peut RIEN affirmer : on rend null plutôt que zéro,
 * pour ne pas faire passer un article non comparé pour un article sans rabais.
 */
export function rabaisRelatif(aubaine) {
  const regulier = aubaine.prixRegulierCents;
  if (!regulier || !aubaine.prixCents || regulier <= aubaine.prixCents) return null;
  return (regulier - aubaine.prixCents) / regulier;
}

/**
 * Meilleurs spéciaux de la semaine, en articles prêts pour un plan.
 * Classement : d'abord ce dont on connaît le rabais, du plus fort au plus
 * faible; ensuite le reste, au meilleur prix unitaire. Un même produit n'est
 * pris qu'une fois, même s'il est en rabais dans deux épiceries.
 */
export function meilleursSpeciaux(etat, options = {}) {
  const {
    dateCible = new Date().toISOString().slice(0, 10),
    valideesSeulement = false,
    quotas = QUOTAS_PANIER,
    foyer = null,
  } = options;

  const disponibles = aubainesActives(etat, dateCible, { valideesSeulement });
  const parNom = new Map();
  for (const a of disponibles) {
    const cle = a.nomNormalise || a.nom;
    const connu = parNom.get(cle);
    if (!connu || coutUnitaire(a) < coutUnitaire(connu)) parNom.set(cle, a);
  }

  const classer = (x, y) => {
    const rx = rabaisRelatif(x);
    const ry = rabaisRelatif(y);
    if (rx !== null && ry !== null) return ry - rx;
    if (rx !== null) return -1;
    if (ry !== null) return 1;
    return (x.prixParUnite || Infinity) - (y.prixParUnite || Infinity);
  };

  const articles = [];
  for (const [categorie, quota] of Object.entries(quotas)) {
    const candidats = [...parNom.values()]
      .filter((a) => a.categorie === categorie)
      .sort(classer)
      .slice(0, quota);
    candidats.forEach((a, rang) => {
      articles.push({
        requete: a.nom,
        quantite: foyer ? quantiteAjustee(1, foyer) : 1,
        note: null,
        priorite: categorie === CATEGORIE_PRIORITAIRE && rang < NB_PRIORITAIRES,
      });
    });
  }
  return articles;
}

/* ---------- Limitation du nombre d'épiceries ---------- */

/**
 * Choisit au plus `maxEpiceries` épiceries : la couverture des articles
 * d'abord, le prix ensuite. Glouton — l'optimum exact demanderait d'essayer
 * toutes les combinaisons, pour un gain de quelques cents sur des listes de
 * cette taille.
 */
/**
 * Poids d'un article dans le choix des épiceries.
 *
 * Un article marqué prioritaire dans un plan compte pour PLUSIEURS articles
 * ordinaires : quand on se limite à deux ou trois magasins, ce sont eux qu'on
 * refuse d'abandonner. Sans ce poids, la couverture ne verrait qu'un décompte,
 * et le plan « je veux d'abord mes protéines » n'aurait aucun effet réel.
 */
export const POIDS_PRIORITE = 4;

function choisirEpiceries(candidatsParLigne, maxEpiceries, poids = null) {
  const toutes = new Set();
  for (const candidats of candidatsParLigne) for (const c of candidats) toutes.add(c.epicerie);
  const poidsDe = (i) => (poids && poids[i]) || 1;

  const evaluer = (choisies) => {
    let couvertes = 0;
    let cout = 0;
    candidatsParLigne.forEach((candidats, i) => {
      const options = candidats.filter((c) => choisies.has(c.epicerie));
      if (options.length) {
        couvertes += poidsDe(i);
        cout += Math.min(...options.map(coutUnitaire));
      }
    });
    return { couvertes, cout };
  };

  const choisies = new Set();
  while (choisies.size < maxEpiceries) {
    const actuel = evaluer(choisies);
    let meilleure = null;
    let meilleurGain = null;
    for (const epicerie of [...toutes].filter((e) => !choisies.has(e)).sort()) {
      const essai = evaluer(new Set([...choisies, epicerie]));
      if (essai.couvertes <= actuel.couvertes && essai.cout >= actuel.cout) continue;
      const gain = [essai.couvertes - actuel.couvertes, actuel.cout - essai.cout];
      if (!meilleurGain || gain[0] > meilleurGain[0] || (gain[0] === meilleurGain[0] && gain[1] > meilleurGain[1])) {
        meilleurGain = gain;
        meilleure = epicerie;
      }
    }
    if (!meilleure) break;
    choisies.add(meilleure);
  }
  return choisies.size ? choisies : toutes;
}

/* ---------- Optimisation ---------- */

export function optimiser(etat, articles, options = {}) {
  const {
    dateCible = new Date().toISOString().slice(0, 10),
    maxEpiceries = null,
    valideesSeulement = false,
    seuil = SEUIL_CORRESPONDANCE,
    nom = "Liste d'épicerie",
  } = options;

  const disponibles = aubainesActives(etat, dateCible, { valideesSeulement });
  const demandes = (articles || []).filter((l) => l && String(l.requete || "").trim());
  const candidatsParLigne = demandes.map((l) => trouverCandidats(disponibles, l.requete, seuil));

  let autorisees = null;
  if (maxEpiceries && maxEpiceries > 0) {
    // On garde l'index d'origine pour que le poids de priorité suive sa ligne.
    const nonVides = [];
    const poids = [];
    candidatsParLigne.forEach((c, i) => {
      if (!c.length) return;
      nonVides.push(c);
      poids.push(demandes[i] && demandes[i].priorite ? POIDS_PRIORITE : 1);
    });
    if (nonVides.length) autorisees = choisirEpiceries(nonVides, maxEpiceries, poids);
  }

  const groupes = new Map();
  const sansAubaine = [];

  demandes.forEach((demande, index) => {
    const candidats = candidatsParLigne[index];
    // `autorisees` restreint le choix; les autres restent visibles en solution
    // de rechange, pour qu'on voie ce qu'on abandonne.
    const retenus = autorisees ? candidats.filter((c) => autorisees.has(c.epicerie)) : candidats;
    const meilleure = retenus.length ? retenus[0] : null;
    const quantite = Math.max(1, parseInt(demande.quantite, 10) || 1);
    const ligne = {
      requete: demande.requete,
      quantite,
      note: demande.note || null,
      priorite: !!demande.priorite,
      meilleure,
      alternatives: candidats.filter((c) => !meilleure || c.id !== meilleure.id).slice(0, MAX_ALTERNATIVES),
      cout: meilleure ? coutUnitaire(meilleure) * quantite : 0,
      economie: meilleure ? economieUnitaire(meilleure) * quantite : 0,
    };

    if (!meilleure) {
      sansAubaine.push(ligne);
      return;
    }
    if (!groupes.has(meilleure.epicerie)) {
      groupes.set(meilleure.epicerie, { epicerie: meilleure.epicerie, lignes: [], total: 0, economies: 0 });
    }
    const groupe = groupes.get(meilleure.epicerie);
    groupe.lignes.push(ligne);
    groupe.total += ligne.cout;
    groupe.economies += ligne.economie;
  });

  // Dans chaque magasin, les prioritaires en tête : au rayon, c'est ce qu'on
  // met dans le panier avant de se laisser distraire.
  for (const groupe of groupes.values()) {
    groupe.lignes.sort((a, b) => (b.priorite ? 1 : 0) - (a.priorite ? 1 : 0));
  }
  sansAubaine.sort((a, b) => (b.priorite ? 1 : 0) - (a.priorite ? 1 : 0));

  // La plus grosse facture en premier : c'est l'épicerie principale de la sortie.
  const ordonnes = [...groupes.values()].sort((a, b) => b.total - a.total || a.epicerie.localeCompare(b.epicerie));
  const total = ordonnes.reduce((somme, g) => somme + g.total, 0);
  const economies = ordonnes.reduce((somme, g) => somme + g.economies, 0);

  return {
    nom,
    dateCible,
    maxEpiceries: maxEpiceries || null,
    groupes: ordonnes,
    sansAubaine,
    total,
    economies,
    nbArticles: ordonnes.reduce((somme, g) => somme + g.lignes.length, 0),
    nbEpiceries: ordonnes.length,
  };
}

/* ---------- Aubaines par épicerie ---------- */

export function aubainesParEpicerie(etat, options = {}) {
  const {
    dateCible = new Date().toISOString().slice(0, 10),
    epiceries = null,
    categorie = null,
    recherche = null,
    valideesSeulement = false,
    seuil = SEUIL_CORRESPONDANCE,
  } = options;

  const actives = aubainesActives(etat, dateCible, { epiceries, valideesSeulement });
  const parEpicerie = new Map();

  for (const aubaine of actives) {
    const cat = aubaine.categorie || "Autres";
    if (categorie && cat !== categorie) continue;
    if (recherche && scoreCorrespondance(recherche, aubaine.nom) < seuil) continue;
    if (!parEpicerie.has(aubaine.epicerie)) parEpicerie.set(aubaine.epicerie, new Map());
    const categories = parEpicerie.get(aubaine.epicerie);
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(aubaine);
  }

  return [...parEpicerie.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([epicerie, categories]) => {
      const listes = [...categories.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([nomCategorie, aubaines]) => ({
          categorie: nomCategorie,
          aubaines: aubaines.sort((a, b) => a.nom.localeCompare(b.nom)),
        }));
      return {
        epicerie,
        categories: listes,
        nombre: listes.reduce((somme, c) => somme + c.aubaines.length, 0),
      };
    });
}
