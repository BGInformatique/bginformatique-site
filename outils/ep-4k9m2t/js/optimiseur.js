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

/* ---------- Limitation du nombre d'épiceries ---------- */

/**
 * Choisit au plus `maxEpiceries` épiceries : la couverture des articles
 * d'abord, le prix ensuite. Glouton — l'optimum exact demanderait d'essayer
 * toutes les combinaisons, pour un gain de quelques cents sur des listes de
 * cette taille.
 */
function choisirEpiceries(candidatsParLigne, maxEpiceries) {
  const toutes = new Set();
  for (const candidats of candidatsParLigne) for (const c of candidats) toutes.add(c.epicerie);

  const evaluer = (choisies) => {
    let couvertes = 0;
    let cout = 0;
    for (const candidats of candidatsParLigne) {
      const options = candidats.filter((c) => choisies.has(c.epicerie));
      if (options.length) {
        couvertes++;
        cout += Math.min(...options.map(coutUnitaire));
      }
    }
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
    const nonVides = candidatsParLigne.filter((c) => c.length);
    if (nonVides.length) autorisees = choisirEpiceries(nonVides, maxEpiceries);
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
