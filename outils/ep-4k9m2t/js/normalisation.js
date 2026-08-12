/*
 * BGFoods — normalisation des unités et des noms de produits.
 *
 * Deux rôles, et c'est tout ce que ce fichier fait :
 *  - ramener n'importe quel format (500 g, 1,5 L, 12 x 355 ml, 3,99 $/lb) à
 *    une unité de base (g, ml, unité), sans quoi comparer deux épiceries n'a
 *    aucun sens : un 500 g à 4 $ et un 1 kg à 7 $ ne se comparent pas de tête;
 *  - normaliser les noms pour apparier « lait 2 % » avec
 *    « Lait partiellement écrémé 2 % Natrel ».
 *
 * Aucun accès au DOM ni à Firebase : le banc d'essai importe ce module tel
 * quel et l'exécute sous node.
 */
"use strict";

/* ---------- Unités ---------- */

export const MASSE = "g";
export const VOLUME = "ml";
export const UNITE = "unite";

// Facteur de conversion vers l'unité de base.
export const FACTEURS = {
  mg: [0.001, MASSE],
  g: [1, MASSE],
  gr: [1, MASSE],
  gramme: [1, MASSE],
  grammes: [1, MASSE],
  kg: [1000, MASSE],
  lb: [453.59237, MASSE],
  lbs: [453.59237, MASSE],
  livre: [453.59237, MASSE],
  livres: [453.59237, MASSE],
  oz: [28.349523, MASSE],
  ml: [1, VOLUME],
  cl: [10, VOLUME],
  dl: [100, VOLUME],
  l: [1000, VOLUME],
  litre: [1000, VOLUME],
  litres: [1000, VOLUME],
  unite: [1, UNITE],
  unites: [1, UNITE],
  un: [1, UNITE],
  ch: [1, UNITE],
  chacun: [1, UNITE],
  paquet: [1, UNITE],
  sac: [1, UNITE],
  boite: [1, UNITE],
  douzaine: [12, UNITE],
};

// Quantité de référence servant à AFFICHER le prix unitaire.
const BASE_AFFICHAGE = { [MASSE]: 100, [VOLUME]: 100, [UNITE]: 1 };
const ETIQUETTE_BASE = { [MASSE]: "/100 g", [VOLUME]: "/100 ml", [UNITE]: "/unité" };

export function sansAccents(texte) {
  return (texte || "").normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** « KG » -> « kg »; une unité inconnue donne null plutôt qu'une conversion inventée. */
export function uniteCanonique(unite) {
  if (!unite) return null;
  const cle = sansAccents(String(unite).trim().toLowerCase()).replace(/\.+$/, "");
  return Object.prototype.hasOwnProperty.call(FACTEURS, cle) ? cle : null;
}

/** (1.5, « L ») -> { quantite: 1500, base: « ml » } */
export function versBase(valeur, unite) {
  const cle = uniteCanonique(unite);
  if (cle === null) return null;
  const [facteur, base] = FACTEURS[cle];
  return { quantite: valeur * facteur, base };
}

/** Prix ramené à 100 g / 100 ml / 1 unité, en cents. */
export function prixUnitaire(prixCents, baseQte, baseUnite) {
  if (!baseQte || baseQte <= 0 || !(baseUnite in BASE_AFFICHAGE)) return null;
  return (prixCents / baseQte) * BASE_AFFICHAGE[baseUnite];
}

/* ---------- Affichage ---------- */

export function formatPrix(cents) {
  if (cents === null || cents === undefined) return "—";
  const valeur = (cents / 100).toFixed(2).replace(".", ",");
  // Séparateur de milliers en espace insécable étroite, comme au Québec.
  return valeur.replace(/\B(?=(\d{3})+(?!\d)(?=,))/g, " ") + " $";
}

export function formatNombre(valeur) {
  if (Math.abs(valeur - Math.round(valeur)) < 1e-9) return String(Math.round(valeur));
  return valeur.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

/** Le litre s'écrit « L » pour ne pas se confondre avec le chiffre 1. */
export function uniteAffichee(unite) {
  if (!unite) return "";
  return String(unite).toLowerCase() === "l" ? "L" : unite;
}

/** « 12000 ml » s'affiche « 12 L », « 6 unite » s'affiche « 6 unités ». */
export function formatTaille(valeur, unite) {
  if (valeur === null || valeur === undefined || !unite) return "";
  let v = Number(valeur);
  let u = uniteCanonique(unite) || unite;
  if (u === "ml" && v >= 1000) {
    v /= 1000;
    u = "l";
  } else if (u === "g" && v >= 1000) {
    v /= 1000;
    u = "kg";
  } else if (u === "unite" || u === "unites") {
    return `${formatNombre(v)} ${v > 1 ? "unités" : "unité"}`;
  }
  return `${formatNombre(v)} ${uniteAffichee(u)}`;
}

export function formatPrixUnitaire(valeur, baseUnite) {
  if (valeur === null || valeur === undefined || !baseUnite) return "";
  return `${formatPrix(valeur)} ${ETIQUETTE_BASE[baseUnite] || ""}`.trim();
}

/** « 2/5,00 $ », « 3,99 $/lb », « 3,49 $/100 g », ou simplement « 2,99 $ ». */
export function formatPrixEtiquette(prixCents, typePrix = "unite", options = {}) {
  const { multiQte = null, prixUnite = null, prixQte = null } = options;
  const prix = formatPrix(prixCents);
  if (typePrix === "multiple" && multiQte && multiQte > 1) return `${multiQte}/${prix}`;
  if (typePrix === "poids" && prixUnite) {
    if (prixQte && Math.abs(prixQte - 1) > 1e-9) {
      return `${prix}/${formatNombre(prixQte)} ${uniteAffichee(prixUnite)}`;
    }
    return `${prix}/${uniteAffichee(prixUnite)}`;
  }
  return prix;
}

/* ---------- Noms de produits ---------- */

const MOTS_VIDES = new Set([
  "de", "du", "des", "le", "la", "les", "un", "une", "au", "aux", "et", "ou",
  "en", "a", "l", "d", "pour", "avec", "sans", "chacun", "ch", "reg",
  "regulier", "format", "produit", "produits", "notre", "votre", "qc",
  "quebec", "canada", "no", "select", "selection", "ea",
]);

// Mots dont le « s » final fait partie du mot.
const PLURIEL_INVARIABLE = new Set(["jus", "riz", "pois", "ananas", "os"]);

const JETON_RE = /[a-z0-9%]+/g;

export function singulier(jeton) {
  if (PLURIEL_INVARIABLE.has(jeton) || jeton.length <= 3) return jeton;
  if (jeton.endsWith("aux")) return jeton.slice(0, -3) + "al";
  if (jeton.endsWith("x") || jeton.endsWith("s")) return jeton.slice(0, -1);
  return jeton;
}

/** « Poitrines de poulet désossées » -> ['poitrine', 'poulet', 'desossee'] */
export function jetons(texte) {
  const minuscules = sansAccents(texte || "").toLowerCase();
  return (minuscules.match(JETON_RE) || [])
    .map(singulier)
    .filter((j) => j && !MOTS_VIDES.has(j));
}

export function nomNormalise(texte) {
  return jetons(texte).join(" ");
}

/* Similarité de Ratcliff/Obershelp — l'algorithme de difflib.SequenceMatcher
   en Python, d'où vient la version d'origine de ce code. Reproduire le même
   calcul importe : les seuils (0,82 pour une faute de frappe, 0,45 pour
   accepter une correspondance) ont été réglés sur SES valeurs. */
function correspondances(a, b) {
  if (!a.length || !b.length) return 0;
  let meilleurA = 0;
  let meilleurB = 0;
  let meilleureLongueur = 0;
  // Plus longue sous-chaîne commune, en programmation dynamique sur une
  // seule ligne : les chaînes comparées ici sont des noms de produits.
  let precedent = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const courant = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        courant[j] = precedent[j - 1] + 1;
        if (courant[j] > meilleureLongueur) {
          meilleureLongueur = courant[j];
          meilleurA = i - meilleureLongueur;
          meilleurB = j - meilleureLongueur;
        }
      }
    }
    precedent = courant;
  }
  if (!meilleureLongueur) return 0;
  return (
    meilleureLongueur +
    correspondances(a.slice(0, meilleurA), b.slice(0, meilleurB)) +
    correspondances(a.slice(meilleurA + meilleureLongueur), b.slice(meilleurB + meilleureLongueur))
  );
}

export function similarite(a, b) {
  const total = a.length + b.length;
  if (!total) return 1;
  return (2 * correspondances(a, b)) / total;
}

/**
 * Score 0-1 entre une demande (« lait 2 % ») et le nom d'une aubaine.
 * La couverture des mots demandés domine; la similarité de chaînes absorbe
 * les fautes de frappe et les variantes.
 */
export function scoreCorrespondance(demande, candidat) {
  const jetonsDemande = jetons(demande);
  const jetonsCandidat = jetons(candidat);
  if (!jetonsDemande.length || !jetonsCandidat.length) return 0;

  let trouves = 0;
  for (const jd of jetonsDemande) {
    let meilleur = 0;
    for (const jc of jetonsCandidat) {
      if (jd === jc) {
        meilleur = 1;
        break;
      }
      if (jd.length >= 4 && (jc.startsWith(jd) || jd.startsWith(jc))) {
        meilleur = Math.max(meilleur, 0.85);
      } else {
        const ratio = similarite(jd, jc);
        if (ratio >= 0.82) meilleur = Math.max(meilleur, ratio * 0.9);
      }
    }
    trouves += meilleur;
  }
  const couverture = trouves / jetonsDemande.length;
  const suite = similarite(jetonsDemande.join(" "), jetonsCandidat.join(" "));

  let score = 0.8 * couverture + 0.2 * suite;
  // Une demande entièrement contenue dans le nom du produit est bon signe.
  if (couverture >= 0.999) score = Math.min(1, score + 0.1);
  return Math.round(Math.min(score, 1) * 10000) / 10000;
}

/* ---------- Catégories ---------- */

export const MOTS_CATEGORIES = {
  "Fruits et légumes": [
    "pomme", "banane", "fraise", "bleuet", "framboise", "raisin", "orange",
    "clementine", "citron", "avocat", "tomate", "laitue", "salade",
    "concombre", "carotte", "patate", "pomme de terre", "oignon", "brocoli",
    "chou", "poivron", "champignon", "melon", "ananas", "peche", "poire",
    "celeri", "epinard", "courgette", "mangue",
  ],
  "Viandes et poissons": [
    "poulet", "poitrine", "boeuf", "porc", "steak", "hache", "cotelette",
    "saucisse", "bacon", "jambon", "dinde", "agneau", "saumon", "tilapia",
    "crevette", "poisson", "filet", "roti", "veau",
  ],
  "Produits laitiers et œufs": [
    "lait", "fromage", "yogourt", "yaourt", "beurre", "creme", "oeuf",
    "cheddar", "mozzarella", "margarine",
  ],
  Boulangerie: [
    "pain", "baguette", "bagel", "tortilla", "muffin", "croissant", "brioche",
    "gateau", "tarte", "biscuit",
  ],
  Surgelés: ["surgele", "congele", "creme glacee", "pizza surgelee", "frite"],
  Boissons: [
    "jus", "eau", "boisson", "cola", "pepsi", "coca", "biere", "vin", "cafe",
    "the", "limonade", "kombucha",
  ],
  Épicerie: [
    "pate", "spaghetti", "riz", "conserve", "sauce", "huile", "farine",
    "sucre", "cereale", "craquelin", "croustille", "soupe", "haricot",
    "pois chiche", "lentille", "confiture", "miel", "vinaigre",
  ],
  "Ménager et soins": [
    "papier", "essuie", "savon", "detergent", "shampoing", "dentifrice",
    "couche", "mouchoir", "nettoyant", "lessive",
  ],
};

export const CATEGORIES = Object.keys(MOTS_CATEGORIES);

/* ---------- Lait de vache ----------
 *
 * Sert à favoriser les produits sans lait de vache, LE FROMAGE EXCEPTÉ.
 *
 * L'ordre des trois listes est ce qui rend la reconnaissance correcte, et
 * chacune répare un piège précis :
 *
 *   1. Le fromage passe d'abord — c'est l'exception demandée, et « fromage à
 *      la crème » ne doit pas être écarté à cause du mot « crème ».
 *   2. Puis le végétal : « lait de coco », « boisson d'amande » et surtout
 *      « beurre d'arachide » contiennent les mots du lait sans en être.
 *   3. Ce qui reste et porte un mot du lait est du lait de vache.
 *
 * « Sans lactose » n'est PAS une exception : c'est du lait de vache dont on a
 * retiré le sucre, pas un produit d'une autre origine.
 */
export const MOTS_FROMAGE = [
  "fromage", "cheddar", "mozzarella", "brie", "camembert", "feta", "parmesan",
  "parmigiano", "gouda", "havarti", "gorgonzola", "ricotta", "mascarpone",
  "raclette", "emmental", "gruyere", "bocconcini", "halloumi", "oka",
  "boursin", "cottage", "suisse",
];

export const MOTS_VEGETAL = [
  "amande", "soya", "soja", "avoine", "coco", "cajou", "noisette", "chanvre",
  "arachide", "cacahuete", "vegetal", "vegetale", "plantes", "riz",
];

export const MOTS_LAIT_DE_VACHE = [
  "lait", "creme", "yogourt", "yaourt", "beurre", "babeurre", "kefir",
  "lactantia", "natrel", "quebon",
];

/**
 * Ce produit contient-il du lait de vache ? Le fromage rend toujours false :
 * c'est l'exception voulue, pas un oubli.
 */
export function contientLaitDeVache(nom) {
  const t = sansAccents(String(nom || "").toLowerCase());
  if (MOTS_FROMAGE.some((m) => t.includes(m))) return false;
  if (MOTS_VEGETAL.some((m) => t.includes(m))) return false;
  return MOTS_LAIT_DE_VACHE.some((m) => t.includes(m));
}

export function categorieDevinee(nom) {
  const normalise = sansAccents((nom || "").toLowerCase());
  for (const [categorie, mots] of Object.entries(MOTS_CATEGORIES)) {
    for (const mot of mots) {
      if (normalise.includes(mot)) return categorie;
    }
  }
  return null;
}
