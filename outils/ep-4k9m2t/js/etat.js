/*
 * BGFoods — état de l'outil et fusion multi-appareils.
 *
 * Quatre registres : les circulaires importées, les aubaines qu'on en a
 * tirées, les listes d'épicerie enregistrées, et les plans d'épicerie.
 *
 * UN PLAN n'est pas une liste. La liste est le résultat d'un calcul, figée au
 * moment où on la génère. Le plan est ce qu'on veut : des articles qu'on garde
 * d'une semaine à l'autre, dont certains sont marqués prioritaires. Un seul
 * plan est actif à la fois, et c'est lui qui alimente la génération.
 *
 * LA FUSION EST LE CŒUR DE CE FICHIER. On importe la circulaire sur
 * l'ordinateur et on coche la liste au magasin sur le téléphone : les deux
 * appareils écrivent le même document Firestore. Une fusion « le plus récent
 * gagne » sur l'état ENTIER perdrait le travail de l'un des deux à chaque
 * fois. Ici la fusion se fait ENREGISTREMENT PAR ENREGISTREMENT, avec des
 * pierres tombales pour que l'appareil qui n'a pas vu une suppression ne
 * ressuscite pas ce qu'on vient d'effacer.
 *
 * Aucun accès au DOM ni à Firebase : le banc d'essai exécute ce module tel quel.
 */
"use strict";

export const CLE_STOCKAGE = "bgfoods.v1";
export const REGISTRES = ["circulaires", "aubaines", "listes", "plans"];

// Une pierre tombale plus vieille que ça n'a plus d'appareil à convaincre.
export const TTL_TOMBE_MS = 180 * 24 * 3600 * 1000;

export function etatVide() {
  return { circulaires: [], aubaines: [], listes: [], plans: [], tombes: {}, updatedAt: 0 };
}

/** Identifiant court et unique, sans dépendance externe. */
export function nouvelId(prefixe = "x") {
  const alea = Math.random().toString(36).slice(2, 8);
  return `${prefixe}-${Date.now().toString(36)}-${alea}`;
}

/** Complète un état partiel (venu du stockage ou du nuage) sans rien perdre. */
export function normaliserEtat(brut) {
  const etat = etatVide();
  if (!brut || typeof brut !== "object") return etat;
  for (const registre of REGISTRES) {
    if (Array.isArray(brut[registre])) etat[registre] = brut[registre].filter((e) => e && e.id);
  }
  if (brut.tombes && typeof brut.tombes === "object") etat.tombes = { ...brut.tombes };
  etat.updatedAt = Number(brut.updatedAt) || 0;
  return etat;
}

/**
 * Fusionne deux états enregistrement par enregistrement.
 *
 * Règles, dans l'ordre :
 *   1. une pierre tombale plus récente que l'enregistrement l'emporte : ce qui
 *      a été supprimé reste supprimé;
 *   2. sinon, la version au `updatedAt` le plus élevé gagne;
 *   3. à égalité, on garde `a` — le choix est arbitraire mais il doit être
 *      STABLE, sinon deux appareils se renvoient indéfiniment la balle.
 */
export function fusionner(a, b) {
  const gauche = normaliserEtat(a);
  const droite = normaliserEtat(b);

  const tombes = { ...gauche.tombes };
  for (const [id, quand] of Object.entries(droite.tombes)) {
    if (!tombes[id] || quand > tombes[id]) tombes[id] = quand;
  }

  const fusion = etatVide();
  for (const registre of REGISTRES) {
    const parId = new Map();
    for (const enregistrement of [...gauche[registre], ...droite[registre]]) {
      const existant = parId.get(enregistrement.id);
      if (!existant || (enregistrement.updatedAt || 0) > (existant.updatedAt || 0)) {
        parId.set(enregistrement.id, enregistrement);
      }
    }
    fusion[registre] = [...parId.values()].filter((e) => {
      const tombe = tombes[e.id];
      return !tombe || tombe < (e.updatedAt || 0);
    });
  }

  // Une aubaine dont la circulaire a disparu n'est atteignable par aucun
  // écran : elle ne ferait que gonfler le document, sans jamais servir.
  const circulaires = new Set(fusion.circulaires.map((c) => c.id));
  fusion.aubaines = fusion.aubaines.filter((a2) => circulaires.has(a2.circulaireId));

  const limite = Math.max(gauche.updatedAt, droite.updatedAt) - TTL_TOMBE_MS;
  fusion.tombes = Object.fromEntries(Object.entries(tombes).filter(([, quand]) => quand >= limite));
  fusion.updatedAt = Math.max(gauche.updatedAt, droite.updatedAt);
  return fusion;
}

/* ---------- Écritures ---------- */

export function toucher(enregistrement, maintenant = Date.now()) {
  enregistrement.updatedAt = maintenant;
  return enregistrement;
}

export function ajouter(etat, registre, enregistrement, maintenant = Date.now()) {
  if (!enregistrement.id) enregistrement.id = nouvelId(registre.slice(0, 3));
  toucher(enregistrement, maintenant);
  etat[registre].push(enregistrement);
  etat.updatedAt = maintenant;
  return enregistrement;
}

export function remplacer(etat, registre, id, changements, maintenant = Date.now()) {
  const enregistrement = etat[registre].find((e) => e.id === id);
  if (!enregistrement) return null;
  Object.assign(enregistrement, changements);
  toucher(enregistrement, maintenant);
  etat.updatedAt = maintenant;
  return enregistrement;
}

/**
 * Supprime un enregistrement ET pose sa pierre tombale. Sans la tombe, la
 * synchro suivante le ferait réapparaître depuis l'autre appareil.
 */
export function supprimer(etat, registre, id, maintenant = Date.now()) {
  const avant = etat[registre].length;
  etat[registre] = etat[registre].filter((e) => e.id !== id);
  etat.tombes[id] = maintenant;
  etat.updatedAt = maintenant;

  // Supprimer une circulaire emporte ses aubaines : chacune reçoit sa propre
  // tombe, sinon un autre appareil les remettrait sans leur circulaire.
  if (registre === "circulaires") {
    for (const aubaine of etat.aubaines.filter((a) => a.circulaireId === id)) {
      etat.tombes[aubaine.id] = maintenant;
    }
    etat.aubaines = etat.aubaines.filter((a) => a.circulaireId !== id);
  }
  return avant !== etat[registre].length;
}

/* ---------- Stockage local ---------- */

export function lireLocal(stockage) {
  try {
    const brut = stockage.getItem(CLE_STOCKAGE);
    return brut ? normaliserEtat(JSON.parse(brut)) : etatVide();
  } catch (e) {
    return etatVide();
  }
}

export function ecrireLocal(stockage, etat) {
  try {
    stockage.setItem(CLE_STOCKAGE, JSON.stringify(etat));
    return true;
  } catch (e) {
    return false;
  }
}
