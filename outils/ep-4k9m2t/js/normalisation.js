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

/**
 * La date d'aujourd'hui, ici — pas à Greenwich.
 *
 * `new Date().toISOString()` rend la date UTC : passé 20 h au Québec, elle
 * annonce déjà demain. L'outil déclarait donc expirées, dès la soirée, les
 * aubaines valides jusqu'au jour même, et proposait le lendemain comme date de
 * magasinage. On décale de l'écart local avant de découper.
 */
export function dateDuJour(maintenant = new Date()) {
  return new Date(maintenant.getTime() - maintenant.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

/*
 * LES LIGATURES SE DÉFONT AVANT LES ACCENTS, et ce n'est pas un détail de
 * typographie. « œ » n'est pas un « o » accentué : NFD ne le décompose pas, il
 * traversait donc intact — et le découpage en jetons, qui ne connaît que
 * [a-z0-9%], coupait « bœuf » en « b » + « uf ».
 *
 * Ce que ça cassait, mesuré sur les circulaires du 6 au 12 août 2026 :
 *   - « œufs » contre « Œufs gros calibre » : score 0,04 au lieu de 1. Les
 *     œufs ne sortaient JAMAIS dans une liste, même en rabais.
 *   - « Œufs » n'avait aucune catégorie — donc jamais retenus par le quota
 *     « Produits laitiers et œufs » d'un panier bâti sur les spéciaux.
 *   - « Bœuf haché » ne s'appariait que par chance, sur le seul mot « haché ».
 */
const LIGATURES = [[/œ/g, "oe"], [/Œ/g, "OE"], [/æ/g, "ae"], [/Æ/g, "AE"]];

export function sansAccents(texte) {
  let sortie = texte || "";
  for (const [motif, remplacement] of LIGATURES) sortie = sortie.replace(motif, remplacement);
  return sortie.normalize("NFD").replace(/\p{Mn}/gu, "");
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
  // Épithètes publicitaires : « Vraie mayonnaise Hellmann's » et « Véritable
  // sirop d'érable » sont les noms IMPRIMÉS dans les circulaires. Sans ce
  // retrait, l'épithète occupait le premier jeton et faisait passer la
  // mayonnaise sous l'ancre du garde-manger. « nature » n'y est pas : un
  // yogourt nature, c'est le produit, pas de la réclame.
  "vrai", "vraie", "veritable", "pur", "pure", "authentique",
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

/*
 * Le vocabulaire vient des circulaires elles-mêmes : les six circulaires du
 * 6 au 12 août 2026 (IGA, Maxi, Metro, Super C, Provigo, Marché Richelieu —
 * 258 aubaines, dépôt BGFoods/aubaines/) ont été passées dans le classement,
 * et chaque produit resté sans catégorie a donné son mot. « Bifteck »,
 * « creton », « bok choy » : ce ne sont pas des inventions, ce sont les mots
 * qui manquaient.
 *
 * Les mots composés (« pomme de terre », « pain de viande ») règlent les cas
 * où le premier mot ment sur le produit; ils gagnent sur les mots simples à
 * position égale (voir categorieDevinee).
 *
 * DÉLIBÉRÉMENT ABSENTS : « chocolat », « bonbon », « friandise ». Sans
 * catégorie, ils tombent dans « Autres » — que les ajouts automatiques
 * refusent. C'est voulu : une tablette de chocolat à moitié prix n'a pas plus
 * sa place qu'un kilo de sucre dans une liste que l'outil remplit tout seul.
 */
export const MOTS_CATEGORIES = {
  "Fruits et légumes": [
    "pomme", "banane", "fraise", "bleuet", "framboise", "raisin", "orange",
    "clementine", "citron", "avocat", "tomate", "laitue", "salade",
    "concombre", "carotte", "patate", "pomme de terre", "oignon", "brocoli",
    "chou", "poivron", "champignon", "melon", "ananas", "peche", "poire",
    "celeri", "epinard", "courgette", "mangue", "mais", "cerise", "prune",
    "nectarine", "kiwi", "litchi", "radis", "romaine", "bok choy", "poireau",
    "abricot", "lime", "pamplemousse", "asperge", "aubergine",
    "haricot vert", "haricot jaune", "gourgane", "ail", "cantaloup", "navet",
    "zucchini", "courge", "ble d'inde", "fruit", "legume",
  ],
  "Viandes et poissons": [
    "poulet", "poitrine", "boeuf", "porc", "steak", "hache", "cotelette",
    "saucisse", "bacon", "jambon", "dinde", "agneau", "saumon", "tilapia",
    "crevette", "poisson", "filet", "roti", "veau", "bifteck", "surlonge",
    "viande", "smoked meat", "canard", "pastrami", "bologne", "pepperoni",
    "salami", "salametti", "chorizo", "charcuterie", "creton", "saucisson",
    "thon", "sushi", "crabe", "simili crabe", "homard", "truite", "morue",
    "petoncle", "palourde", "fruits de mer", "boudin", "tete fromagee",
    "aloyau", "picanha", "cote levee", "pain de viande", "tourtiere",
    // Les pâtés-repas du comptoir : sans ces composés, « pâté au poulet »
    // partait chez les pâtes alimentaires — sansAccents confond pâté et pâtes.
    "pate de campagne", "pate de foie", "pate au poulet", "pate au saumon",
    "pate a la viande", "pate chinois", "pate mexicain",
    // Le tofu est une protéine de repas : c'est ici qu'il joue son rôle —
    // quota des protéines, articles étoilés — pas dans l'allée sèche.
    "tofu", "tempeh",
  ],
  "Produits laitiers et œufs": [
    "lait", "fromage", "yogourt", "yaourt", "beurre", "creme", "oeuf",
    "cheddar", "mozzarella", "margarine", "kefir",
    // Les noms de fromages (brie, feta, oka…) sont ajoutés plus bas depuis
    // MOTS_FROMAGE : une seule liste de fromages à entretenir.
  ],
  Boulangerie: [
    "pain", "baguette", "bagel", "tortilla", "muffin", "croissant", "brioche",
    "gateau", "tarte", "biscuit", "viennoiserie", "pita", "naan",
    // « miche » n'y est pas : par préfixe, il attrapait « Michel » — et le
    // cidre rosé Michel Jodoin entrait au panier automatique par la porte de
    // la boulangerie. Une miche sans le mot « pain » restera sans catégorie,
    // ce qui est le moindre des deux maux.
  ],
  Surgelés: [
    "surgele", "congele", "creme glacee", "pizza surgelee", "frite", "pizza",
    "sorbet", "glacee",
  ],
  Boissons: [
    "jus", "eau", "boisson", "cola", "pepsi", "coca", "biere", "vin", "cafe",
    "the", "limonade", "kombucha",
    // L'alcool doit être NOMMÉ : tout ce qui tombe en Boissons est refusé par
    // les ajouts automatiques, alors qu'un alcool sans catégorie qui glisse
    // ailleurs (le cidre, jadis « miche ») devient achetable tout seul.
    "cidre", "sangria", "spiritueux", "vodka", "whisky", "rhum", "gin",
    "prosecco", "mousseux", "cooler", "seltzer",
  ],
  Épicerie: [
    "pate", "spaghetti", "riz", "conserve", "sauce", "huile", "farine",
    "sucre", "cereale", "craquelin", "croustille", "soupe", "haricot",
    "pois chiche", "lentille", "confiture", "miel", "vinaigre", "chapelure",
    "granola", "barre", "hummus", "legumineuse", "pesto", "mayonnaise",
    "moutarde", "ketchup", "olive", "tartinade", "beurre d'arachide",
    "lait de coco", "noix", "amande", "arachide", "cajou", "sirop",
    "bouillon", "cassonade", "melasse", "levure", "bicarbonate", "fecule",
    "cacao", "gruau", "feves au lard", "mais souffle",
    "rotini", "fusilli", "penne", "macaroni", "linguine", "lasagne", "nouille",
    // Les crèmes condensées : « Crème de champignons » n'est pas un produit
    // laitier — le composé, plus long, bat « crème » à position égale.
    "creme de champignons", "creme de poulet", "creme de celeri",
    "creme de brocoli",
  ],
  "Ménager et soins": [
    "papier", "essuie", "savon", "detergent", "shampoing", "dentifrice",
    "couche", "mouchoir", "nettoyant", "lessive", "deodorant", "rasoir",
    "assouplissant", "eponge", "sac a dechets", "sac a ordures",
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

// « Feta Krinos » sortait sans catégorie : les circulaires nomment le fromage
// par son nom, pas par le mot « fromage ». La liste des fromages existe déjà
// pour l'option sans lait de vache — on la verse dans la catégorie plutôt que
// d'en entretenir une copie qui divergerait.
MOTS_CATEGORIES["Produits laitiers et œufs"].push(...MOTS_FROMAGE);

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

/**
 * Boisson végétale qui remplace le lait — avoine, amande, cajou, soya…
 *
 * POURQUOI CETTE FONCTION EXISTE. Les circulaires n'ont pas le droit d'appeler
 * ça du « lait » : elles écrivent tantôt « Lait d'avoine », tantôt « Boisson à
 * base de plantes ». Les deux tombaient dans des catégories différentes —
 * produits laitiers pour l'un, boissons pour l'autre — et le panier n'avait de
 * quota que pour la première. Le même produit était donc retenu ou ignoré
 * selon le mot choisi par l'épicerie.
 */
export function estBoissonVegetale(nom) {
  const t = sansAccents(String(nom || "").toLowerCase());
  if (MOTS_FROMAGE.some((m) => t.includes(m))) return false;
  // Le lait de coco EN CONSERVE est un ingrédient de cuisson, pas la boisson
  // qui remplace le lait au déjeuner : sans cette exception, l'option sans
  // lait de vache l'auto-ajoutait dans le quota des produits laitiers.
  // « Boisson de coco », elle, se boit — et passe.
  if (/\blait de coco\b/.test(t)) return false;
  const contenant = /\b(lait|boisson|breuvage)\b/.test(t) || t.includes("base de plantes");
  return contenant && MOTS_VEGETAL.some((m) => t.includes(m));
}

/* ---------- Correspondance d'un mot-clé dans un nom de produit ----------
 *
 * PAR JETONS, PLUS JAMAIS PAR SOUS-CHAÎNE. La recherche par sous-chaîne
 * classait par accident : « poireau » et « rouleaux de printemps » contiennent
 * « eau » et partaient dans Boissons; « vaisselle » contient « sel ». Un mot
 * de liste ne doit correspondre qu'à un MOT du produit.
 *
 * Deux règles, réglées sur le vocabulaire des circulaires :
 *   - un jeton du produit égal au mot-clé correspond toujours;
 *   - un jeton qui COMMENCE par un mot-clé d'au moins CINQ lettres
 *     correspond aussi — c'est ce qui fait que « surgele » attrape
 *     « surgelée » et « hache » attrape « hachée ». Sous cinq lettres,
 *     l'égalité seule : « roti » attrapait « rotini » (des pâtes chez les
 *     viandes) et « cari » attrapait « caribou ». Les pluriels ne perdent
 *     rien, singulier() les ramène avant la comparaison.
 *
 * Un mot-clé de plusieurs mots (« pomme de terre », « crème glacée ») doit se
 * retrouver en jetons CONSÉCUTIFS : « pomme » puis « terre » côte à côte.
 */
/** Position (index de jeton) où le mot-clé commence dans le nom, ou -1. */
export function positionDuMot(mot, jetonsNom) {
  const jetonsMot = jetons(mot);
  if (!jetonsMot.length) return -1;
  const correspond = (jetonProduit, jetonMot) =>
    jetonProduit === jetonMot || (jetonMot.length >= 5 && jetonProduit.startsWith(jetonMot));
  for (let i = 0; i + jetonsMot.length <= jetonsNom.length; i++) {
    if (jetonsMot.every((jm, k) => correspond(jetonsNom[i + k], jm))) return i;
  }
  return -1;
}

export function motDansNom(mot, jetonsNom, { auDebut = false } = {}) {
  const position = positionDuMot(mot, jetonsNom);
  return auDebut ? position === 0 : position >= 0;
}

/**
 * Devine la catégorie d'un produit.
 *
 * LA CORRESPONDANCE LA PLUS TÔT DANS LE NOM GAGNE. Les circulaires nomment le
 * produit par ce qu'il EST, puis le décrivent : « Jus d'orange » est un jus
 * (Boissons), pas une orange — c'est le premier ordre d'arrivée qui le dit,
 * pas l'ordre des catégories, qui classait le jus d'orange dans les fruits et
 * la soupe aux tomates dans les légumes. À position égale, le mot-clé composé
 * bat le mot simple (« crème glacée » bat « crème »); à égalité complète,
 * l'ordre des catégories tranche, pour rester déterministe.
 *
 * UNE EXCEPTION AVANT TOUT : « surgelé » ou « congelé » dans le nom dit le
 * rayon, peu importe ce qui est congelé. Des frites surgelées ne sont pas des
 * pommes de terre du rayon des légumes.
 */
export function categorieDevinee(nom) {
  const jetonsNom = jetons(nom || "");
  if (!jetonsNom.length) return null;
  if (["surgele", "congele"].some((mot) => motDansNom(mot, jetonsNom))) return "Surgelés";

  let meilleure = null;
  for (const [categorie, mots] of Object.entries(MOTS_CATEGORIES)) {
    for (const mot of mots) {
      const position = positionDuMot(mot, jetonsNom);
      if (position < 0) continue;
      const longueur = jetons(mot).length;
      if (!meilleure || position < meilleure.position
        || (position === meilleure.position && longueur > meilleure.longueur)) {
        meilleure = { categorie, position, longueur };
      }
    }
  }
  return meilleure ? meilleure.categorie : null;
}

/* ---------- Garde-manger ----------
 *
 * UN KILO DE SUCRE N'EST PAS UNE AUBAINE DE LA SEMAINE. Le garde-manger —
 * sucre, farine, huile, vinaigre, condiments, épices — se rachète quelques
 * fois par année : le proposer en ajout automatique dès qu'il est en gros
 * rabais remplissait la liste de choses que personne n'allait chercher.
 *
 * Cette liste ne JUGE pas le produit, elle retient sa CADENCE D'ACHAT. C'est
 * pourquoi les bases de repas qui se consomment chaque semaine n'y sont pas :
 * pâtes, riz, conserves de tomates, céréales, café, bouillon. Et elle ne
 * bloque que les AJOUTS AUTOMATIQUES — écrire « sucre » dans un plan ou une
 * liste trouve l'aubaine comme avant : c'est vous qui l'avez demandé.
 *
 * LA DÉTECTION EST ANCRÉE AU PREMIER JETON, et cette ancre n'est pas un
 * détail : dans une circulaire, le produit OUVRE son nom (« Ketchup Heinz »,
 * « Sel de mer », « Farine Five Roses ») et la saveur arrive après. Sans
 * l'ancre, tout ce qui est assaisonné devenait du garde-manger :
 *
 *     « Beurre demi-sel »        n'est pas du sel — c'est du beurre;
 *     « Croustilles ketchup »    ne sont pas du ketchup;
 *     « Thon à l'huile »         n'est pas de l'huile;
 *     « Yogourt à la vanille »   n'est pas de la vanille;
 *     « Jambon au miel »         n'est pas du miel;
 *     « Brioches à la cannelle » ne sont pas de la cannelle.
 */
export const MOTS_GARDE_MANGER = [
  // Cuisson et pâtisserie
  "sucre", "cassonade", "farine", "levure", "bicarbonate", "fecule",
  "vanille", "essence de vanille", "extrait de vanille", "melasse",
  "sirop de mais", "poudre a pate", "cacao", "chapelure", "shortening",
  "saindoux", "melange a gateau", "melange a muffins", "melange a biscuits",
  "melange a crepes", "melange a sauce",
  // Huiles et vinaigres (« vinaigre » attrape aussi la vinaigrette)
  "huile", "vinaigre",
  // Condiments et sauces de réserve. « tartinade » est ancré comme le reste :
  // « Tartinade Nutella » en est, « Hummus tartinade Fontaine Santé » — un
  // frais qui se mange dans la semaine — n'en est pas.
  "moutarde", "ketchup", "mayonnaise", "relish", "sauce soya", "sauce bbq",
  "sauce sriracha", "sriracha", "tamari", "sauce worcestershire",
  "sauce piquante", "marinade", "cornichon", "olive", "capre", "raifort",
  "sirop d'erable", "miel", "confiture", "tartinade", "beurre d'arachide",
  // Épices et assaisonnements
  "sel", "poivre", "epice", "assaisonnement", "fines herbes", "origan",
  "basilic seche", "paprika", "cumin", "cari", "curcuma", "cannelle",
  "muscade",
  // Friandises — la seule entorse à la règle de la cadence, et elle est
  // assumée : des bonbons se rachètent souvent, mais ils ne nourrissent
  // aucun repas. Un outil qui remplit une liste d'épicerie tout seul n'a pas
  // à y glisser des jujubes, aussi spectaculaire que soit le rabais.
  "friandise", "bonbon", "sucette", "jujube",
];

export function estGardeManger(nom) {
  const jetonsNom = jetons(nom || "");
  if (!jetonsNom.length) return false;
  return MOTS_GARDE_MANGER.some((mot) => motDansNom(mot, jetonsNom, { auDebut: true }));
}
