/*
 * BGFoods — lecture du texte d'une circulaire.
 *
 * Une circulaire, une fois son texte extrait du PDF, ressemble à ceci :
 *
 *   Poitrines de poulet désossées  8,80 $/kg   3,99 $/lb
 *   Fraises du Québec 454 g   2,99 $
 *   2/5,00 $  Yogourt Source 16 x 100 g
 *   Céréales Kellogg's 320-500 g  3,49 $  Rég. 5,99 $
 *
 * Ce module transforme ces lignes en aubaines structurées, chacune avec un
 * indice de confiance : rien n'est présenté comme certain, l'humain valide
 * ensuite dans l'écran de correction.
 *
 * FRONTIÈRES DE MOTS : on n'utilise PAS « \b » ici. En JavaScript, « é » n'est
 * pas un caractère de mot, donc /\béconomisez/ ne trouve jamais « économisez »
 * — le contraire de Python, d'où ce code est porté. Les bornes AVANT/APRÈS
 * ci-dessous incluent les lettres accentuées et se comportent, elles, comme on
 * s'y attend en français.
 */
"use strict";

import {
  UNITE,
  categorieDevinee,
  nomNormalise,
  jetons,
  prixUnitaire,
  sansAccents,
  uniteCanonique,
  versBase,
} from "./normalisation.js";

/* ---------- Briques d'expressions régulières ---------- */

const AVANT = "(?<![A-Za-zÀ-ÿ0-9])";
const APRES = "(?![A-Za-zÀ-ÿ0-9])";
// Un nombre d'argent : « 1 299,99 », « 3,99 », « 12 ».
const NOMBRE = "\\d{1,4}(?:[ \\u00a0\\u202f]\\d{3})*(?:[.,]\\d{1,2})?";

/* Une regex marquée « g » retient sa position entre deux appels, et
   String.matchAll REPREND cette position au lieu de repartir du début. Une
   simple vérification « y a-t-il un prix ? » suffisait alors à faire manquer
   le prix suivant, en silence : les circulaires à une seule ligne
   ressortaient vides. D'où deux jeux distincts — « g » pour parcourir,
   sans « g » pour tester — plutôt qu'une remise à zéro à ne jamais oublier. */
const ARGENT_SOURCE = `(?:\\$\\s*(?<pre>${NOMBRE})|(?<post>${NOMBRE})\\s*\\$)`;
const CENTS_SOURCE = `(?<![\\d,.])(?<cents>\\d{1,2})\\s*(?:¢|cents?${APRES})`;

const ARGENT_RE = new RegExp(ARGENT_SOURCE, "g");
const CENTS_RE = new RegExp(CENTS_SOURCE, "g");
const ARGENT_TEST_RE = new RegExp(ARGENT_SOURCE);
const CENTS_TEST_RE = new RegExp(CENTS_SOURCE);

// « /kg », « / 100 g », « le kg », « la livre » — collé à la fin d'un prix.
const PAR_UNITE_RE = new RegExp(
  `\\s*(?:\\/|par\\s+|le\\s+|la\\s+)\\s*(?<qte>\\d+(?:[.,]\\d+)?)?\\s*(?<unite>kg|g|lb|livres?|ml|l|oz)${APRES}`,
  "iy",
);

const MULTIPLE_RE = /(?<n>[2-9]|1\d)\s*(?:\/|pour)\s*$/i;

const MULTIPAQUET_RE = new RegExp(
  `(?<n>\\d{1,3})\\s*[x×]\\s*(?<v>${NOMBRE})\\s*(?<u>mg|g|kg|ml|cl|dl|l)${APRES}`,
  "i",
);
const TAILLE_RE = new RegExp(
  `(?<![\\w,])(?<v>${NOMBRE})\\s*(?:[-–à]\\s*(?<v2>${NOMBRE})\\s*)?(?<u>mg|kg|g|ml|cl|dl|l|lb|livres?|oz)${APRES}`,
  "gi",
);
const COMPTE_RE = new RegExp(
  `(?:paquet|sac|bo[iî]te|emballage|caisse)\\s+de\\s+(?<n1>\\d{1,3})` +
    `|(?<n2>\\d{1,3})\\s*(?:unit[ée]s?|morceaux|rouleaux|tranches|sachets)${APRES}`,
  "i",
);

const INDICE_REGULIER_RE = new RegExp(
  `(r[ée]g\\.?|r[ée]gulier|au lieu de|valeur|[ée]conomisez|[ée]pargnez|rabais de)\\s*$`,
  "i",
);

const MOTS_PROMO_RE = new RegExp(
  `${AVANT}(ch\\.?|chacun|chaque|seulement|aubaine|sp[ée]cial|nouveau|prix|` +
    `[ée]conomisez|[ée]pargnez|r[ée]g\\.?|r[ée]gulier|au lieu de|avec carte|` +
    `carte privil[èe]ge|limite \\d+|par famille)${APRES}\\.?`,
  "gi",
);

const ENTETE_RE = new RegExp(
  `^(circulaire|valide|du \\d|cette semaine|page \\d|nos aubaines|en vigueur|` +
    `offre valide|www\\.|https?:\\/\\/|\\d{3}[- ]\\d{3}[- ]\\d{4})`,
  "i",
);

const MOIS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

export const EPICERIES_CONNUES = [
  "IGA", "Maxi", "Metro", "Métro", "Super C", "Provigo", "Loblaws", "Walmart",
  "Costco", "Adonis", "Avril", "Bonichoix", "Tigre Géant", "Rachelle-Béry",
  "Marché Richelieu", "Marché Ami", "Intermarché", "Sobeys", "Farm Boy",
];

/* ---------- Utilitaires ---------- */

function versNombre(brut) {
  return parseFloat(String(brut).replace(/[   ]/g, "").replace(",", "."));
}

function enCents(valeur) {
  return Math.round(valeur * 100);
}

function retirerPlages(texte, plages) {
  if (!plages.length) return texte;
  const morceaux = [];
  let curseur = 0;
  for (const [debut, fin] of [...plages].sort((a, b) => a[0] - b[0])) {
    if (debut > curseur) morceaux.push(texte.slice(curseur, debut));
    curseur = Math.max(curseur, fin);
  }
  morceaux.push(texte.slice(curseur));
  return morceaux.join(" ");
}

function nettoyerNom(texte) {
  return texte
    .replace(MOTS_PROMO_RE, " ")
    .replace(/[•·|*]+/g, " ")
    .replace(/[\s.,;:/\\-]+$/, "")
    .replace(/^[\s.,;:/\\-]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ---------- Détection des prix ---------- */

function trouverPrix(texte) {
  const trouves = [];
  ARGENT_RE.lastIndex = 0;
  CENTS_RE.lastIndex = 0;
  for (const m of texte.matchAll(ARGENT_RE)) {
    const brut = m.groups.pre || m.groups.post;
    trouves.push({
      debut: m.index,
      fin: m.index + m[0].length,
      cents: enCents(versNombre(brut)),
      parUnite: null,
      multiQte: null,
      regulier: false,
    });
  }
  for (const m of texte.matchAll(CENTS_RE)) {
    if (trouves.some((h) => h.debut <= m.index && m.index < h.fin)) continue;
    trouves.push({
      debut: m.index,
      fin: m.index + m[0].length,
      cents: parseInt(m.groups.cents, 10),
      parUnite: null,
      multiQte: null,
      regulier: false,
    });
  }

  trouves.sort((a, b) => a.debut - b.debut);
  for (const prix of trouves) {
    const avant = texte.slice(Math.max(0, prix.debut - 30), prix.debut);
    prix.regulier = INDICE_REGULIER_RE.test(avant);

    const multiple = MULTIPLE_RE.exec(avant);
    if (multiple) {
      prix.multiQte = parseInt(multiple.groups.n, 10);
      prix.debut -= avant.length - multiple.index;
    }

    PAR_UNITE_RE.lastIndex = prix.fin;
    const suite = PAR_UNITE_RE.exec(texte);
    if (suite && suite.index === prix.fin) {
      const unite = uniteCanonique(suite.groups.unite);
      if (unite) {
        prix.parUnite = [suite.groups.qte ? versNombre(suite.groups.qte) : 1, unite];
        prix.fin = suite.index + suite[0].length;
      }
    }
  }
  return trouves;
}

function choisirPrix(trouves) {
  const regulierTrouve = trouves.find((h) => h.regulier);
  let regulier = regulierTrouve ? regulierTrouve.cents : null;
  const candidats = trouves.filter((h) => !h.regulier);
  if (!candidats.length) return { meilleur: null, regulier };

  // Une aubaine « 2/5,00 $ » ou un prix au poids l'emporte sur un prix nu.
  const rang = (prix) => (prix.multiQte ? 2 : prix.parUnite ? 1 : 0);
  let meilleur = [...candidats].sort((a, b) => rang(b) - rang(a) || b.cents - a.cents)[0];

  // Deux prix au poids sur la même ligne (8,80 $/kg et 3,99 $/lb) : on garde
  // la mention à la livre, la plus courante au Québec.
  const auPoids = candidats.filter((h) => h.parUnite);
  if (auPoids.length > 1) {
    meilleur = auPoids.find((h) => h.parUnite[1] === "lb") || auPoids[0];
  }

  if (regulier === null && !meilleur.parUnite) {
    const plusChers = candidats.filter((h) => h !== meilleur && h.cents > meilleur.cents);
    if (plusChers.length) regulier = Math.max(...plusChers.map((h) => h.cents));
  }
  return { meilleur, regulier };
}

/* ---------- Détection du format ---------- */

function trouverTaille(texte) {
  const paquet = MULTIPAQUET_RE.exec(texte);
  if (paquet) {
    const unite = uniteCanonique(paquet.groups.u);
    if (unite) {
      const total = parseInt(paquet.groups.n, 10) * versNombre(paquet.groups.v);
      return { valeur: total, unite: paquet.groups.u.toLowerCase(), plage: [paquet.index, paquet.index + paquet[0].length] };
    }
  }

  const compte = COMPTE_RE.exec(texte);
  if (compte) {
    const n = compte.groups.n1 || compte.groups.n2;
    if (n) {
      return { valeur: parseFloat(n), unite: "unite", plage: [compte.index, compte.index + compte[0].length] };
    }
  }

  TAILLE_RE.lastIndex = 0;
  for (const m of texte.matchAll(TAILLE_RE)) {
    if (!uniteCanonique(m.groups.u)) continue;
    // « 320-500 g » : on retient la borne basse, donc un prix unitaire prudent.
    return {
      valeur: versNombre(m.groups.v),
      unite: m.groups.u.toLowerCase(),
      plage: [m.index, m.index + m[0].length],
    };
  }
  return null;
}

/* ---------- Analyse d'une ligne ---------- */

export function analyserLigne(texte, page = 1) {
  const brut = (texte || "").trim();
  if (brut.length < 3 || ENTETE_RE.test(brut)) return null;

  const trouves = trouverPrix(brut);
  const { meilleur, regulier } = choisirPrix(trouves);
  if (!meilleur) return null;

  const plages = trouves.map((h) => [h.debut, h.fin]);

  const taille = trouverTaille(brut);
  if (taille && !plages.some(([d, f]) => d <= taille.plage[0] && taille.plage[0] < f)) {
    plages.push(taille.plage);
  }

  const nom = nettoyerNom(retirerPlages(brut, plages));
  if (!nom || !/[A-Za-zÀ-ÿ]{3}/.test(nom)) return null;

  const aubaine = {
    texteBrut: brut,
    nom,
    page,
    prixCents: meilleur.cents,
    typePrix: "unite",
    prixUnite: null,
    prixQte: null,
    multiQte: null,
    tailleValeur: taille ? taille.valeur : null,
    tailleUnite: taille ? taille.unite : null,
    baseQte: null,
    baseUnite: null,
    prixParUnite: null,
    prixRegulierCents: regulier,
    categorie: null,
    confiance: 0,
    nomNormalise: "",
  };

  if (meilleur.multiQte) {
    aubaine.typePrix = "multiple";
    aubaine.multiQte = meilleur.multiQte;
  } else if (meilleur.parUnite) {
    aubaine.typePrix = "poids";
    aubaine.prixQte = meilleur.parUnite[0];
    aubaine.prixUnite = meilleur.parUnite[1];
  }

  // Quantité réellement obtenue pour le prix affiché.
  if (meilleur.parUnite) {
    const converti = versBase(meilleur.parUnite[0], meilleur.parUnite[1]);
    if (converti) {
      aubaine.baseQte = converti.quantite;
      aubaine.baseUnite = converti.base;
    }
  } else if (taille) {
    const converti = versBase(taille.valeur, taille.unite);
    if (converti) {
      aubaine.baseQte = converti.quantite;
      aubaine.baseUnite = converti.base;
      if (aubaine.multiQte) aubaine.baseQte *= aubaine.multiQte;
    }
  }
  if (aubaine.baseQte === null) {
    aubaine.baseQte = aubaine.multiQte ? aubaine.multiQte : 1;
    aubaine.baseUnite = UNITE;
  }

  aubaine.prixParUnite = prixUnitaire(aubaine.prixCents, aubaine.baseQte, aubaine.baseUnite);
  aubaine.categorie = categorieDevinee(nom);
  aubaine.nomNormalise = nomNormalise(nom);

  let score = 0.5;
  if (taille) score += 0.2;
  if (meilleur.parUnite || meilleur.multiQte) score += 0.1;
  if (jetons(nom).length >= 2) score += 0.15;
  if (regulier !== null) score += 0.05;
  if (nom.length > 70) score -= 0.2;
  aubaine.confiance = Math.round(Math.max(0, Math.min(score, 1)) * 100) / 100;
  return aubaine;
}

/* ---------- Analyse d'un document ---------- */

function contientPrix(ligne) {
  return ARGENT_TEST_RE.test(ligne) || CENTS_TEST_RE.test(ligne);
}

function seulementUnPrix(ligne) {
  if (!contientPrix(ligne)) return false;
  const reste = nettoyerNom(retirerPlages(ligne, trouverPrix(ligne).map((h) => [h.debut, h.fin])));
  return !/[A-Za-zÀ-ÿ]{3}/.test(reste);
}

/**
 * Recolle « 2,99 $ », seul sur sa ligne, au libellé de produit voisin.
 * L'extraction PDF sépare presque toujours le prix (gros caractères) du nom.
 */
export function recollerPrixOrphelins(lignes) {
  const sortie = [];
  const restantes = lignes.map((l) => l.trim());
  let i = 0;
  while (i < restantes.length) {
    const courante = restantes[i];
    if (!courante) {
      i++;
      continue;
    }
    if (seulementUnPrix(courante)) {
      // « Fraises 454 g » puis « 2,99 $ » : on rattache d'abord au libellé qui
      // précède, l'ordre de lecture le plus courant.
      if (sortie.length && !contientPrix(sortie[sortie.length - 1])) {
        sortie[sortie.length - 1] = `${sortie[sortie.length - 1]} ${courante}`;
        i++;
        continue;
      }
      // Sinon la mise en page place la pastille de prix AVANT le produit.
      let j = i + 1;
      while (j < restantes.length && !restantes[j]) j++;
      if (j < restantes.length && restantes[j] && !contientPrix(restantes[j])) {
        sortie.push(`${restantes[j]} ${courante}`);
        restantes[j] = "";
        i = j + 1;
        continue;
      }
    }
    sortie.push(courante);
    i++;
  }
  return sortie;
}

export function analyserPage(texte, page = 1) {
  const aubaines = [];
  for (const ligne of recollerPrixOrphelins((texte || "").split("\n"))) {
    const aubaine = analyserLigne(ligne, page);
    if (aubaine) aubaines.push(aubaine);
  }
  return aubaines;
}

/** Supprime les doublons exacts (même produit, même prix) d'une circulaire. */
export function dedoublonner(aubaines) {
  const vues = new Map();
  for (const aubaine of aubaines) {
    const cle = `${aubaine.nomNormalise}|${aubaine.prixCents}|${aubaine.tailleUnite}`;
    const existante = vues.get(cle);
    if (!existante || aubaine.confiance > existante.confiance) vues.set(cle, aubaine);
  }
  return [...vues.values()];
}

export function analyserPages(pages) {
  const aubaines = [];
  pages.forEach((texte, index) => {
    aubaines.push(...analyserPage(texte, index + 1));
  });
  return dedoublonner(aubaines);
}

/* ---------- Métadonnées de la circulaire ---------- */

export function devinerEpicerie(texte) {
  const entete = (texte || "").split("\n").slice(0, 40).join("\n");
  for (const epicerie of EPICERIES_CONNUES) {
    const motif = new RegExp(`${AVANT}${epicerie.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${APRES}`, "i");
    if (motif.test(entete)) return epicerie;
  }
  return null;
}

function dateISO(annee, mois, jour) {
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  // Une date impossible (31 février) déborde sur le mois suivant : on la
  // refuse plutôt que de retourner un jour que la circulaire n'annonce pas.
  if (d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return null;
  return d.toISOString().slice(0, 10);
}

/** Trouve « du 5 au 11 juin 2026 » ou « 2026-06-05 au 2026-06-11 ». */
export function devinerValidite(texte, aujourdHui = null) {
  const entete = (texte || "").split("\n").slice(0, 60).join("\n");
  const maintenant = aujourdHui ? new Date(`${aujourdHui}T00:00:00Z`) : new Date();

  const iso = /(\d{4}-\d{2}-\d{2})\s*(?:au|à|-|jusqu'au)\s*(\d{4}-\d{2}-\d{2})/i.exec(entete);
  if (iso) return { debut: iso[1], fin: iso[2] };

  const fr = new RegExp(
    `du\\s+(?:[A-Za-zÀ-ÿ]+\\s+)?(\\d{1,2})\\s*(?:er)?\\s*(?:([A-Za-zÀ-ÿ]+)\\s*)?` +
      `(?:au|à)\\s+(?:[A-Za-zÀ-ÿ]+\\s+)?(\\d{1,2})\\s*(?:er)?\\s*([A-Za-zÀ-ÿ]+)\\s*(\\d{4})?`,
    "i",
  ).exec(entete);
  if (fr) {
    const [, j1, nomMois1, j2, nomMois2, annee] = fr;
    const mois2 = MOIS[sansAccents((nomMois2 || "").toLowerCase())];
    const mois1 = MOIS[sansAccents((nomMois1 || "").toLowerCase())] || mois2;
    if (mois1 && mois2) {
      const an = annee ? parseInt(annee, 10) : maintenant.getUTCFullYear();
      const debut = dateISO(an, mois1, parseInt(j1, 10));
      // « du 28 décembre au 3 janvier » : la fin bascule dans l'année suivante.
      const fin = dateISO(mois2 >= mois1 ? an : an + 1, mois2, parseInt(j2, 10));
      if (debut && fin) return { debut, fin };
    }
  }
  return null;
}

export function validiteParDefaut(aujourdHui = null, jours = 7) {
  const base = aujourdHui ? new Date(`${aujourdHui}T00:00:00Z`) : new Date();
  const debut = base.toISOString().slice(0, 10);
  const fin = new Date(base.getTime() + (jours - 1) * 86400000).toISOString().slice(0, 10);
  return { debut, fin };
}
