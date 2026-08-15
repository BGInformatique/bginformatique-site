/*
 * BGFoods — de la liste d'épicerie aux repas de la semaine.
 *
 * CE QUE CE MODULE FAIT, ET DANS QUEL SENS. On ne part pas d'un menu pour en
 * déduire une épicerie : on part de l'épicerie DÉJÀ FAITE — celle que
 * l'optimiseur a bâtie sur les rabais de la semaine — et on cherche quoi
 * cuisiner avec. C'est l'ordre qui fait économiser : le menu suit les
 * spéciaux, pas l'inverse.
 *
 * DEUX SOURCES DE RECETTES.
 *
 *   1. LE RÉPERTOIRE, plus bas. Une vingtaine de soupers ordinaires du
 *      Québec, écrits ici, en clair. Il ne demande ni réseau, ni clé, ni
 *      abonnement, et il donne exactement le même menu demain qu'aujourd'hui
 *      pour la même liste — donc le banc d'essai peut le vérifier.
 *   2. L'IA, en option (voir `consigneRecettes`). Elle apporte de la variété
 *      et lit la liste réelle; elle coûte un appel et ne peut pas être testée
 *      hors ligne. Ses recettes s'ajoutent au répertoire pour la sélection,
 *      elles ne le remplacent pas.
 *
 * UN INGRÉDIENT MOTEUR est celui sans lequel la recette n'est plus la même :
 * le poulet du poulet rôti. La sélection exige qu'il vienne de la liste. Les
 * autres ingrédients manquants tombent dans le « complément » — la courte
 * liste de ce qu'il reste à acheter pour que la semaine tienne.
 *
 * LE GARDE-MANGER (`garde`) n'est jamais acheté : sel, poivre, huile, farine.
 * L'annoncer à racheter chaque semaine ferait un complément illisible, et
 * personne ne va à l'épicerie pour du poivre.
 *
 * Aucun accès au DOM ni à Firebase : le banc d'essai exécute ce module tel quel.
 */
"use strict";

import {
  contientLaitDeVache,
  formatTaille,
  nomNormalise,
  scoreCorrespondance,
} from "./normalisation.js";

/* Plus exigeant que le 0,45 des aubaines : là on cherche le meilleur candidat
   parmi des dizaines de produits, ici on décide si un ingrédient est dans le
   panier ou s'il faut l'acheter. Une fausse reconnaissance envoie cuisiner
   sans l'aliment. */
export const SEUIL_INGREDIENT = 0.6;

export const PORTIONS_REFERENCE = 4;

/* ==================== Le répertoire ====================
 *
 * Chaque recette nourrit QUATRE personnes; les quantités sont mises à
 * l'échelle au moment de planifier. Les étapes sont volontairement courtes :
 * ce n'est pas un livre de cuisine, c'est un aide-mémoire pour un mardi soir.
 */

/* Une boisson végétale n'est pas du lait : elle ne doit pas satisfaire la
   recette qui en demande. L'inverse est déjà réglé par le régime. */
const LAITS_VEGETAUX = ["coco", "amande", "soya", "avoine", "cajou"];

const g = (nom, qte, cle, moteur = false) => ({ nom, qte, unite: "g", cle: cle || nom, moteur });
const ml = (nom, qte, cle, moteur = false) => ({ nom, qte, unite: "ml", cle: cle || nom, moteur });
const un = (nom, qte, cle, moteur = false) => ({ nom, qte, unite: "", cle: cle || nom, moteur });

export const REPERTOIRE = [
  {
    id: "poulet-roti-riz-brocoli",
    nom: "Poulet rôti, riz et brocoli",
    minutes: 45,
    ingredients: [
      g("poitrines de poulet", 600, "poulet", true),
      g("riz blanc", 300, "riz"),
      un("brocoli", 1, "brocoli"),
      un("citron", 1, "citron"),
    ],
    garde: ["huile d'olive", "paprika", "sel", "poivre"],
    etapes: [
      "Chauffer le four à 200 °C. Frotter le poulet d'huile, de paprika, de sel et de poivre.",
      "Cuire 25 à 30 minutes, jusqu'à 74 °C au thermomètre.",
      "Pendant ce temps, cuire le riz selon l'emballage.",
      "Cuire le brocoli à la vapeur 5 minutes; arroser de jus de citron.",
      "Laisser reposer le poulet 5 minutes avant de le trancher.",
    ],
  },
  {
    id: "pates-cremeuses-poulet",
    nom: "Pâtes crémeuses au poulet et aux épinards",
    minutes: 30,
    ingredients: [
      g("poitrines de poulet", 500, "poulet", true),
      g("pâtes courtes", 400, "pâtes"),
      ml("crème 15 %", 250, "crème"),
      g("épinards", 150, "épinards"),
      g("parmesan râpé", 60, "parmesan"),
      un("gousses d'ail", 3, "ail"),
    ],
    garde: ["huile d'olive", "sel", "poivre"],
    etapes: [
      "Cuire les pâtes dans l'eau bouillante salée; garder une tasse d'eau de cuisson.",
      "Couper le poulet en lanières et le saisir à feu vif jusqu'à coloration.",
      "Ajouter l'ail, puis la crème; laisser réduire 3 minutes.",
      "Ajouter les épinards, les pâtes et le parmesan; détendre à l'eau de cuisson.",
    ],
  },
  {
    id: "mijote-poulet-legumes",
    nom: "Mijoté de poulet aux légumes",
    minutes: 90,
    ingredients: [
      g("hauts de cuisse de poulet", 800, "poulet", true),
      un("carottes", 4, "carotte"),
      un("pommes de terre", 6, "pomme de terre"),
      un("oignon", 1, "oignon"),
      ml("bouillon de poulet", 750, "bouillon"),
    ],
    garde: ["farine", "huile", "thym", "laurier", "sel", "poivre"],
    etapes: [
      "Fariner le poulet et le saisir dans un chaudron; réserver.",
      "Faire revenir l'oignon, les carottes et les pommes de terre en gros morceaux.",
      "Remettre le poulet, mouiller au bouillon, ajouter thym et laurier.",
      "Couvrir et laisser mijoter 1 heure à feu doux.",
    ],
  },
  {
    id: "pate-chinois",
    nom: "Pâté chinois",
    minutes: 60,
    ingredients: [
      g("bœuf haché", 500, "boeuf hache", true),
      g("pommes de terre", 1500, "pomme de terre"),
      ml("maïs en crème", 540, "maïs"),
      { nom: "lait", qte: 80, unite: "ml", cle: "lait", moteur: false, exclut: LAITS_VEGETAUX },
      un("oignon", 1, "oignon"),
    ],
    garde: ["beurre", "sel", "poivre"],
    etapes: [
      "Cuire les pommes de terre à l'eau salée, puis les piler avec le lait et le beurre.",
      "Faire revenir l'oignon, ajouter le bœuf haché et cuire jusqu'à ce qu'il ne soit plus rosé.",
      "Monter dans un plat : viande, maïs, purée.",
      "Cuire 30 minutes à 190 °C, puis 3 minutes sous le gril pour dorer.",
    ],
  },
  {
    id: "spaghetti-sauce-viande",
    nom: "Spaghetti, sauce à la viande",
    minutes: 50,
    ingredients: [
      g("bœuf haché", 500, "boeuf hache", true),
      g("spaghetti", 400, "pâtes"),
      ml("tomates en dés", 796, "tomates en conserve"),
      un("oignon", 1, "oignon"),
      un("carotte", 1, "carotte"),
      un("gousses d'ail", 2, "ail"),
    ],
    garde: ["huile d'olive", "origan", "sucre", "sel", "poivre"],
    etapes: [
      "Faire revenir l'oignon, la carotte râpée et l'ail.",
      "Ajouter le bœuf haché et le défaire à la cuillère jusqu'à cuisson complète.",
      "Verser les tomates, une pincée de sucre, l'origan; mijoter 30 minutes.",
      "Cuire les pâtes et les napper de sauce.",
    ],
  },
  {
    id: "chili-boeuf-haricots",
    nom: "Chili au bœuf et haricots rouges",
    minutes: 55,
    ingredients: [
      g("bœuf haché", 500, "boeuf hache", true),
      ml("haricots rouges", 540, "haricots rouges"),
      ml("tomates en dés", 796, "tomates en conserve"),
      un("poivron", 1, "poivron"),
      un("oignon", 1, "oignon"),
    ],
    garde: ["cumin", "poudre de chili", "huile", "sel", "poivre"],
    etapes: [
      "Faire revenir oignon et poivron en dés.",
      "Ajouter le bœuf, cuire, puis les épices — 1 minute pour les réveiller.",
      "Ajouter tomates et haricots égouttés; mijoter 30 minutes à découvert.",
      "Servir tel quel, ou sur du riz s'il en reste.",
    ],
  },
  {
    id: "filet-porc-erable",
    nom: "Filet de porc à l'érable et pommes de terre au four",
    minutes: 45,
    ingredients: [
      g("filet de porc", 700, "porc", true),
      g("pommes de terre grelots", 1000, "pomme de terre"),
      ml("sirop d'érable", 60, "sirop d'érable"),
    ],
    garde: ["moutarde de Dijon", "huile", "romarin", "sel", "poivre"],
    etapes: [
      "Chauffer le four à 200 °C; enrober les pommes de terre d'huile et de romarin.",
      "Mélanger sirop et moutarde; en badigeonner le filet.",
      "Saisir le filet à la poêle, puis l'enfourner avec les pommes de terre 20 à 25 minutes.",
      "Laisser reposer 5 minutes; napper du jus de cuisson.",
    ],
  },
  {
    id: "cotelettes-porc-pommes",
    nom: "Côtelettes de porc aux pommes",
    minutes: 35,
    ingredients: [
      un("côtelettes de porc", 4, "porc", true),
      { nom: "pommes", qte: 3, unite: "", cle: "pomme", moteur: false, exclut: ["terre"] },
      un("oignon", 1, "oignon"),
      ml("bouillon de poulet", 250, "bouillon"),
    ],
    garde: ["beurre", "thym", "sel", "poivre"],
    etapes: [
      "Saisir les côtelettes 3 minutes par côté; réserver.",
      "Faire tomber l'oignon et les pommes en quartiers dans le même poêlon.",
      "Déglacer au bouillon, remettre les côtelettes, couvrir 10 minutes.",
      "Servir avec le jus et les pommes.",
    ],
  },
  {
    id: "saumon-erable-quinoa",
    nom: "Saumon à l'érable, quinoa et asperges",
    minutes: 30,
    ingredients: [
      g("filets de saumon", 600, "saumon", true),
      g("quinoa", 250, "quinoa"),
      g("asperges", 400, "asperges"),
      ml("sirop d'érable", 45, "sirop d'érable"),
    ],
    garde: ["sauce soya", "huile", "poivre"],
    etapes: [
      "Rincer le quinoa et le cuire 15 minutes dans deux fois son volume d'eau.",
      "Mélanger sirop et sauce soya; en badigeonner le saumon.",
      "Cuire le saumon 12 minutes à 200 °C, peau dessous.",
      "Rôtir les asperges 8 minutes au four, sur la même plaque.",
    ],
  },
  {
    id: "poisson-pane-legumes",
    nom: "Poisson pané maison et légumes rôtis",
    minutes: 40,
    ingredients: [
      g("filets de poisson blanc", 600, "poisson", true),
      g("chapelure", 120, "chapelure"),
      un("œufs", 2, "oeufs"),
      un("carottes", 4, "carotte"),
      un("courgette", 1, "courgette"),
    ],
    garde: ["farine", "huile", "citron", "sel", "poivre"],
    etapes: [
      "Chauffer le four à 220 °C; étaler les légumes en bâtonnets sur une plaque huilée.",
      "Passer les filets dans la farine, l'œuf battu, puis la chapelure.",
      "Déposer sur une seconde plaque et cuire 15 minutes, en retournant à mi-cuisson.",
      "Servir avec un quartier de citron.",
    ],
  },
  {
    id: "omelette-legumes-fromage",
    nom: "Grosse omelette aux légumes et au fromage",
    minutes: 20,
    ingredients: [
      un("œufs", 8, "oeufs", true),
      g("fromage râpé", 120, "fromage"),
      un("poivron", 1, "poivron"),
      g("champignons", 200, "champignons"),
      un("oignon vert", 2, "oignon vert"),
    ],
    garde: ["beurre", "sel", "poivre"],
    etapes: [
      "Faire suer poivron et champignons dans le beurre.",
      "Battre les œufs, saler, poivrer, verser sur les légumes.",
      "Cuire à feu moyen-doux en ramenant les bords vers le centre.",
      "Parsemer de fromage, plier et servir avec du pain.",
    ],
  },
  {
    id: "quiche-jambon-fromage",
    nom: "Quiche au jambon et au fromage",
    minutes: 55,
    ingredients: [
      un("œufs", 6, "oeufs", true),
      ml("crème 15 %", 250, "crème"),
      g("jambon", 200, "jambon"),
      g("fromage râpé", 150, "fromage"),
      un("croûte à tarte", 1, "croûte à tarte"),
    ],
    garde: ["muscade", "sel", "poivre"],
    etapes: [
      "Chauffer le four à 190 °C.",
      "Battre œufs et crème; saler, poivrer, râper un peu de muscade.",
      "Répartir jambon et fromage dans la croûte, verser l'appareil.",
      "Cuire 35 à 40 minutes, jusqu'à ce que le centre soit pris.",
    ],
  },
  {
    id: "soupe-poulet-nouilles",
    nom: "Soupe poulet et nouilles",
    minutes: 35,
    ingredients: [
      g("poulet cuit", 300, "poulet", true),
      g("nouilles aux œufs", 150, "nouilles"),
      un("carottes", 3, "carotte"),
      un("branches de céleri", 2, "céleri"),
      ml("bouillon de poulet", 2000, "bouillon"),
    ],
    garde: ["thym", "laurier", "sel", "poivre"],
    etapes: [
      "Porter le bouillon à ébullition avec carottes et céleri en dés.",
      "Cuire 15 minutes, jusqu'à ce que les légumes soient tendres.",
      "Ajouter les nouilles, puis le poulet effiloché; 6 minutes de plus.",
      "Rectifier le sel — un bouillon du commerce en contient déjà beaucoup.",
    ],
  },
  {
    id: "potage-legumes",
    nom: "Potage aux légumes du frigo",
    minutes: 40,
    ingredients: [
      un("carottes", 6, "carotte", true),
      un("pommes de terre", 3, "pomme de terre"),
      un("oignon", 1, "oignon"),
      ml("bouillon de légumes", 1000, "bouillon"),
    ],
    garde: ["huile", "sel", "poivre"],
    etapes: [
      "Faire suer l'oignon; ajouter carottes et pommes de terre en morceaux.",
      "Mouiller au bouillon à hauteur; cuire 25 minutes.",
      "Réduire au pied-mélangeur jusqu'à texture lisse.",
      "Se congèle bien en portions — c'est le dîner de la semaine prochaine.",
    ],
  },
  {
    id: "pates-gratinees-tomate",
    nom: "Pâtes gratinées à la tomate",
    minutes: 40,
    ingredients: [
      g("pâtes courtes", 400, "pâtes", true),
      ml("sauce tomate", 700, "sauce tomate"),
      g("fromage râpé", 200, "fromage"),
      un("oignon", 1, "oignon"),
    ],
    garde: ["huile d'olive", "origan", "sel", "poivre"],
    etapes: [
      "Cuire les pâtes une minute de moins que le temps indiqué.",
      "Mélanger avec la sauce et l'oignon revenu.",
      "Verser dans un plat, couvrir de fromage.",
      "Gratiner 15 minutes à 200 °C.",
    ],
  },
  {
    id: "tofu-croustillant-riz",
    nom: "Tofu croustillant, riz et brocoli",
    minutes: 35,
    ingredients: [
      g("tofu ferme", 450, "tofu", true),
      g("riz blanc", 300, "riz"),
      un("brocoli", 1, "brocoli"),
      ml("sauce soya", 60, "sauce soya"),
    ],
    garde: ["fécule de maïs", "huile", "miel", "ail", "gingembre"],
    etapes: [
      "Éponger le tofu en cubes et l'enrober de fécule.",
      "Le dorer à la poêle sur toutes les faces; réserver.",
      "Faire une sauce : soya, miel, ail et gingembre, réduite 2 minutes.",
      "Y rouler le tofu; servir sur le riz avec le brocoli vapeur.",
    ],
  },
  {
    id: "mijote-lentilles",
    nom: "Mijoté de lentilles et de légumes",
    minutes: 45,
    ingredients: [
      g("lentilles sèches", 300, "lentilles", true),
      ml("tomates en dés", 796, "tomates en conserve"),
      un("carottes", 3, "carotte"),
      un("oignon", 1, "oignon"),
      un("branches de céleri", 2, "céleri"),
    ],
    garde: ["huile", "cumin", "laurier", "sel", "poivre"],
    etapes: [
      "Rincer les lentilles.",
      "Faire revenir oignon, carottes et céleri en dés.",
      "Ajouter lentilles, tomates et deux tasses d'eau; laisser mijoter 30 minutes.",
      "Vérifier la cuisson des lentilles avant de saler.",
    ],
  },
  {
    id: "tacos-boeuf",
    nom: "Tacos au bœuf",
    minutes: 25,
    ingredients: [
      g("bœuf haché", 500, "boeuf hache", true),
      un("tortillas", 8, "tortillas"),
      un("laitue", 1, "laitue"),
      un("tomates", 2, "tomate"),
      g("fromage râpé", 150, "fromage"),
    ],
    garde: ["cumin", "poudre de chili", "huile", "sel"],
    etapes: [
      "Cuire le bœuf haché avec les épices et un fond d'eau.",
      "Couper laitue et tomates.",
      "Réchauffer les tortillas 30 secondes à la poêle sèche.",
      "Chacun garnit la sienne.",
    ],
  },
  {
    id: "sandwichs-poulet",
    nom: "Sandwichs au poulet et salade verte",
    minutes: 15,
    ingredients: [
      g("poulet cuit", 300, "poulet", true),
      un("tranches de pain", 8, "pain"),
      un("branches de céleri", 2, "céleri"),
      un("laitue", 1, "laitue"),
    ],
    garde: ["mayonnaise", "sel", "poivre"],
    etapes: [
      "Effilocher le poulet, hacher le céleri.",
      "Mélanger avec la mayonnaise, saler, poivrer.",
      "Garnir le pain, ajouter une feuille de laitue.",
      "Servir avec le reste de la laitue en salade.",
    ],
  },
  {
    id: "crepes-repas",
    nom: "Crêpes-repas au jambon et au fromage",
    minutes: 35,
    ingredients: [
      un("œufs", 3, "oeufs", true),
      { nom: "lait", qte: 500, unite: "ml", cle: "lait", moteur: false, exclut: LAITS_VEGETAUX },
      g("jambon", 150, "jambon"),
      g("fromage râpé", 150, "fromage"),
    ],
    garde: ["farine", "beurre", "sel"],
    etapes: [
      "Fouetter 250 g de farine, les œufs, le lait et une pincée de sel; laisser reposer 15 minutes.",
      "Cuire les crêpes une à une dans un poêlon beurré.",
      "Garnir de jambon et de fromage, plier en quatre.",
      "Passer 3 minutes au four pour faire fondre le fromage.",
    ],
  },
  {
    id: "saute-boeuf-brocoli",
    nom: "Sauté de bœuf et brocoli sur riz",
    minutes: 30,
    ingredients: [
      g("bœuf en lanières", 500, "boeuf", true),
      un("brocoli", 1, "brocoli"),
      g("riz blanc", 300, "riz"),
      ml("sauce soya", 60, "sauce soya"),
      un("gousses d'ail", 2, "ail"),
    ],
    garde: ["fécule de maïs", "huile", "gingembre"],
    etapes: [
      "Cuire le riz.",
      "Saisir le bœuf à feu très vif, par petites quantités; réserver.",
      "Sauter le brocoli 4 minutes avec l'ail et le gingembre.",
      "Remettre le bœuf, ajouter la sauce soya liée d'une cuillère de fécule.",
    ],
  },
  {
    id: "salade-repas-thon",
    nom: "Salade-repas au thon et pommes de terre",
    minutes: 30,
    ingredients: [
      un("boîtes de thon", 2, "thon", true),
      g("pommes de terre grelots", 500, "pomme de terre"),
      un("œufs", 4, "oeufs"),
      g("haricots verts", 300, "haricots verts"),
      un("laitue", 1, "laitue"),
    ],
    garde: ["huile d'olive", "vinaigre", "moutarde", "sel", "poivre"],
    etapes: [
      "Cuire les pommes de terre 15 minutes, les haricots 5 minutes, les œufs 9 minutes.",
      "Refroidir le tout à l'eau froide.",
      "Monter la vinaigrette : huile, vinaigre, moutarde.",
      "Dresser sur la laitue, thon égoutté par-dessus.",
    ],
  },
];

/* ==================== Quantités ==================== */

/**
 * Met une quantité à l'échelle du nombre de portions.
 *
 * On arrondit GROSSIÈREMENT, et c'est voulu : « 466,7 g de bœuf haché » est
 * une fausse précision — le paquet en fait 500. Au-delà de 100, on va au
 * multiple de 10 le plus proche; les dénombrements (2 oignons) restent entiers
 * et ne descendent jamais sous 1.
 */
export function mettreALEchelle(qte, unite, facteur) {
  const valeur = (Number(qte) || 0) * (Number(facteur) || 1);
  if (!valeur) return 0;
  if (!unite) return Math.max(1, Math.round(valeur));
  if (valeur >= 100) return Math.round(valeur / 10) * 10;
  if (valeur >= 20) return Math.round(valeur / 5) * 5;
  return Math.round(valeur * 10) / 10;
}

/**
 * « 600 g de poitrines de poulet », « 2,25 kg de pommes de terre », « 2 oignons ».
 *
 * L'écriture passe par `formatTaille`, celle des circulaires : 2250 g devient
 * 2,25 kg, comme sur l'emballage qu'on ira chercher.
 */
export function ingredientTexte(ingredient, facteur = 1) {
  if (ingredient.texte) return ingredient.texte;
  const valeur = mettreALEchelle(ingredient.qte, ingredient.unite, facteur);
  if (!ingredient.unite) return `${String(valeur).replace(".", ",")} ${ingredient.nom}`;
  return `${formatTaille(valeur, ingredient.unite)} de ${ingredient.nom}`;
}

/* ==================== Appariement liste ↔ recette ==================== */

/**
 * L'ingrédient est-il dans le panier ? Rend l'article trouvé, ou null.
 *
 * `exclut` répare un piège que l'appariement ne peut pas voir tout seul : la
 * clé « pomme » est contenue en entier dans « pommes de terre », donc une
 * poche de patates satisferait la recette aux pommes. Les mots qui changent
 * l'aliment sont donc nommés à la main, sur les rares ingrédients concernés.
 */
export function articlePour(ingredient, articles, seuil = SEUIL_INGREDIENT) {
  const cle = ingredient.cle || ingredient.nom;
  const exclut = ingredient.exclut || [];
  let meilleur = null;
  let meilleurScore = 0;
  for (const article of articles || []) {
    const requete = String(article.requete || article || "");
    if (!requete) continue;
    const normalise = nomNormalise(requete);
    if (exclut.some((mot) => normalise.includes(nomNormalise(mot)))) continue;
    // La clé joue le rôle de la demande : « poulet » doit se retrouver dans
    // « poitrines de poulet », pas l'inverse.
    const score = Math.max(
      scoreCorrespondance(cle, requete),
      scoreCorrespondance(ingredient.nom, requete),
    );
    if (score >= seuil && score > meilleurScore) {
      meilleur = article;
      meilleurScore = score;
    }
  }
  return meilleur;
}

/** Une recette contient-elle du lait de vache ? Le fromage ne compte pas. */
export function contientDuLait(recette) {
  const noms = [
    ...(recette.ingredients || []).map((i) => i.nom),
    ...(recette.garde || []),
  ];
  return noms.some((nom) => contientLaitDeVache(nom));
}

/* ==================== Planification ====================
 *
 * Glouton, un repas à la fois : à chaque tour on prend la recette qui utilise
 * le plus d'articles ENCORE INUTILISÉS. Sans cette préférence, cinq recettes
 * au poulet se suivraient parce que le poulet est ce qu'il y a de moins cher
 * cette semaine — et les légumes achetés pourriraient.
 *
 * L'optimum exact demanderait d'essayer toutes les combinaisons de recettes.
 * Pour cinq repas dans une vingtaine de recettes, le glouton donne le même
 * menu neuf fois sur dix et se lit en dix lignes.
 */

const POIDS_NOUVEAU = 3;      // un article du panier qu'aucun repas n'utilise encore
const POIDS_REPETE = 0.5;     // le même, déjà servi ailleurs : encore utile, moins urgent
const PENALITE_ACHAT = 1;     // un ingrédient qu'il faudra aller acheter

export function planifierRepas(articles, options = {}) {
  const {
    nbRepas = 5,
    portions = PORTIONS_REFERENCE,
    sansLaitDeVache = false,
    repertoire = REPERTOIRE,
    seuil = SEUIL_INGREDIENT,
  } = options;

  const facteur = Math.max(0.25, (Number(portions) || PORTIONS_REFERENCE) / PORTIONS_REFERENCE);
  const disponibles = repertoire.filter((r) => !sansLaitDeVache || !contientDuLait(r));
  const panier = (articles || []).filter((a) => String((a && a.requete) || a || "").trim());

  // Tableau d'appariement calculé une seule fois : recette → ingrédient →
  // article. Le glouton le relit à chaque tour sans jamais le recalculer.
  const apparie = new Map();
  for (const recette of disponibles) {
    apparie.set(recette.id, (recette.ingredients || []).map(
      (ingredient) => ({ ingredient, article: articlePour(ingredient, panier, seuil) })));
  }

  const utilises = new Set();
  const cleArticle = (article) => String(article.requete || article);
  const repas = [];
  const restantes = [...disponibles];

  while (repas.length < Math.max(0, nbRepas) && restantes.length) {
    let choisie = null;
    let meilleurScore = 0;
    for (const recette of restantes) {
      const lignes = apparie.get(recette.id);
      // Un moteur absent du panier disqualifie : on planifie ce qu'on a acheté,
      // on ne redécide pas le souper à la place de l'épicerie.
      if (lignes.some((l) => l.ingredient.moteur && !l.article)) continue;
      let score = 0;
      for (const { article } of lignes) {
        if (!article) score -= PENALITE_ACHAT;
        else score += utilises.has(cleArticle(article)) ? POIDS_REPETE : POIDS_NOUVEAU;
      }
      // À égalité, l'ordre du répertoire tranche : le même panier doit rendre
      // le même menu, sinon on ne peut ni le vérifier ni s'y fier.
      if (score > meilleurScore) {
        meilleurScore = score;
        choisie = recette;
      }
    }
    // Plus rien qui touche au panier : on s'arrête et on le dit, plutôt que de
    // compléter le menu avec des recettes dont TOUT serait à acheter.
    if (!choisie) break;

    const lignes = apparie.get(choisie.id);
    for (const { article } of lignes) if (article) utilises.add(cleArticle(article));
    restantes.splice(restantes.indexOf(choisie), 1);
    // Une recette dont les quantités sont écrites en toutes lettres — celles
    // de l'IA — ne se met pas à l'échelle : on annonce alors SES portions à
    // elle, plutôt que de prétendre avoir ajusté ce qu'on n'a pas compris.
    const chiffree = (choisie.ingredients || []).every((i) => Number(i.qte) > 0);
    const facteurRecette = chiffree ? facteur : 1;
    repas.push({
      ordre: repas.length + 1,
      recetteId: choisie.id,
      nom: choisie.nom,
      minutes: choisie.minutes || null,
      source: choisie.source || "repertoire",
      portions: chiffree
        ? Math.round(PORTIONS_REFERENCE * facteur)
        : (choisie.portions || PORTIONS_REFERENCE),
      ingredients: lignes.map(({ ingredient, article }) => ({
        nom: ingredient.nom,
        cle: ingredient.cle || ingredient.nom,
        texte: ingredientTexte(ingredient, facteurRecette),
        depuisLaListe: !!article,
        article: article ? cleArticle(article) : null,
      })),
      garde: [...(choisie.garde || [])],
      etapes: [...(choisie.etapes || [])],
    });
  }

  // Le complément : ce qu'il reste à acheter, chaque ingrédient une seule fois
  // même s'il sert à trois repas.
  const complement = [];
  const vus = new Set();
  for (const r of repas) {
    for (const ingredient of r.ingredients) {
      if (ingredient.depuisLaListe || vus.has(ingredient.cle)) continue;
      vus.add(ingredient.cle);
      complement.push({ requete: ingredient.nom, cle: ingredient.cle, pour: r.nom });
    }
  }

  const inutilises = panier
    .map((a) => cleArticle(a))
    .filter((cle) => !utilises.has(cle));

  return {
    repas,
    complement,
    inutilises,
    portions: Math.round(PORTIONS_REFERENCE * facteur),
    // Écart entre ce qui a été demandé et ce que le panier permet : c'est ce
    // que l'écran annonce plutôt que de faire semblant d'avoir une semaine.
    demandes: Math.max(0, nbRepas),
    manquants: Math.max(0, Math.max(0, nbRepas) - repas.length),
  };
}

/* ==================== La voie de l'IA ====================
 *
 * Même patron que l'extraction des circulaires : avec une clé, l'appel part du
 * navigateur; sans clé, on prépare un ordre à coller dans une session Claude
 * Code, et la réponse revient par une boîte de texte. Rien n'est facturé en
 * douce, et l'outil reste entier sans réseau — le répertoire, lui, est là.
 *
 * On demande du JSON et non des lignes libres : une recette est un objet
 * (ingrédients, étapes), pas une ligne de circulaire. Le lecteur ci-dessous
 * est indulgent sur l'emballage — bloc de code, texte autour — et strict sur
 * le contenu : une recette sans nom, sans ingrédient ou sans étape est
 * écartée plutôt que d'aller salir le menu.
 */

export function consigneRecettes(articles, options = {}) {
  const { nbRecettes = 5, portions = PORTIONS_REFERENCE, sansLaitDeVache = false } = options;
  const panier = (articles || [])
    .map((a) => String((a && a.requete) || a || "").trim())
    .filter(Boolean);
  return [
    `Voici une liste d'épicerie québécoise :`,
    "",
    ...panier.map((a) => `- ${a}`),
    "",
    `Propose ${nbRecettes} recettes de souper simples qui utilisent CES aliments,`,
    `pour ${portions} portions chacune.`,
    sansLaitDeVache
      ? "Aucun lait, aucune crème, aucun beurre, aucun yogourt (le fromage est permis)."
      : "",
    "",
    "Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :",
    "",
    '[{"nom":"Poulet rôti au citron","minutes":45,"portions":4,',
    '  "ingredients":[{"nom":"poitrines de poulet","quantite":"600 g"}],',
    '  "garde":["huile","sel"],',
    '  "etapes":["Chauffer le four à 200 °C.","Cuire 30 minutes."]}]',
    "",
    "Règles : des ingrédients de la liste en priorité; les épices et l'huile",
    "vont dans « garde »; des étapes courtes; pas de commentaire hors du JSON.",
  ].filter((l) => l !== "").join("\n");
}

/** Ordre à coller dans une session Claude Code — sans frais, hors du navigateur. */
export function ordreRecettesPourTerminal(articles, options = {}) {
  return `${consigneRecettes(articles, options)}\n\n`
    + "Colle le JSON obtenu dans la boîte « Recettes reçues » de BGFoods.";
}

/**
 * Lit la réponse — JSON pur, JSON dans un bloc de code, ou JSON noyé dans du
 * texte. Rend les recettes utilisables et la liste de ce qui a été refusé.
 */
export function lireRecettes(texte) {
  const brut = String(texte || "").trim();
  if (!brut) return { recettes: [], erreurs: ["Rien à lire."] };

  const sansCloture = brut.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let donnees = null;
  for (const candidat of [sansCloture, extraireTableau(sansCloture)]) {
    if (!candidat) continue;
    try {
      donnees = JSON.parse(candidat);
      break;
    } catch (e) { /* on essaie la découpe suivante */ }
  }
  if (!donnees) return { recettes: [], erreurs: ["Réponse illisible : ce n'est pas du JSON."] };
  const tableau = Array.isArray(donnees) ? donnees : [donnees];

  const recettes = [];
  const erreurs = [];
  tableau.forEach((entree, index) => {
    const nom = String((entree && entree.nom) || "").trim();
    const ingredients = Array.isArray(entree && entree.ingredients) ? entree.ingredients : [];
    const etapes = (Array.isArray(entree && entree.etapes) ? entree.etapes : [])
      .map((e) => String(e || "").trim()).filter(Boolean);
    if (!nom || !ingredients.length || !etapes.length) {
      erreurs.push(`Recette ${index + 1} écartée : nom, ingrédients ou étapes manquants.`);
      return;
    }
    const lus = ingredients
      .map((i, rang) => {
        const nomIngredient = String((i && (i.nom || i.ingredient)) || i || "").trim();
        if (!nomIngredient) return null;
        const quantite = String((i && i.quantite) || "").trim();
        return {
          nom: nomIngredient,
          cle: nomIngredient,
          // Les quantités de l'IA restent telles quelles : on ne sait pas les
          // mettre à l'échelle sans les avoir comprises, et une quantité
          // inventée par l'outil serait pire qu'une quantité non ajustée.
          texte: quantite ? `${quantite} de ${nomIngredient}` : nomIngredient,
          // Le premier ingrédient fait le moteur : c'est celui autour duquel
          // le modèle a construit la recette.
          moteur: rang === 0,
        };
      })
      .filter(Boolean);
    if (!lus.length) {
      erreurs.push(`Recette ${index + 1} écartée : aucun ingrédient lisible.`);
      return;
    }
    recettes.push({
      id: `ia-${index + 1}-${nom.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
      nom,
      minutes: Number(entree.minutes) || null,
      portions: Number(entree.portions) || PORTIONS_REFERENCE,
      source: "ia",
      ingredients: lus,
      garde: (Array.isArray(entree.garde) ? entree.garde : [])
        .map((x) => String(x || "").trim()).filter(Boolean),
      etapes,
    });
  });
  if (!recettes.length && !erreurs.length) erreurs.push("Aucune recette dans la réponse.");
  return { recettes, erreurs };
}

/** Découpe le premier tableau JSON d'un texte qui en contient d'autres choses. */
function extraireTableau(texte) {
  const debut = texte.indexOf("[");
  const fin = texte.lastIndexOf("]");
  if (debut === -1 || fin <= debut) return null;
  return texte.slice(debut, fin + 1);
}
