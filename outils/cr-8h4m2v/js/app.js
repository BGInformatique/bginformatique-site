/* =============================================================================
   Boîtes de courriel — tableau de bord
   https://bginformatique.ca/outils/cr-8h4m2v/

   CETTE PAGE NE FAIT QUE LIRE. Elle s'abonne à un seul document Firestore —
   users/<uid>/courriel/etat — écrit par BGCourriel sur BG001, et le dessine.
   Elle n'écrit rien, nulle part : ni dans Firestore, ni dans le courrier. C'est
   ce qui permet de la laisser ouverte en permanence sans jamais se demander si
   un clic a déplacé un courriel.

   D'OÙ VIENNENT LES CHIFFRES. De la machine BG001, qui lit les index de
   Thunderbird toutes les dix minutes. Deux décalages en découlent, et la page
   les AFFICHE tous les deux au lieu de les taire :
     — l'âge de la relève (quand BG001 a lu les boîtes) ;
     — l'âge de l'index (quand Thunderbird a écrit son index sur le disque).
   Le second peut retarder de quelques minutes quand Thunderbird est ouvert. Un
   tableau de bord qui affiche des chiffres sans dire de quand ils datent est
   un tableau de bord auquel on finit par ne plus croire.

   LES TEXTES VENUS DU DOCUMENT SONT DES DONNÉES, JAMAIS DU CODE. Objets,
   adresses et noms d'expéditeurs viennent de courriels reçus — donc de
   l'extérieur. Ils sont tous insérés par textContent ou createTextNode ; il n'y
   a aucun innerHTML construit par concaténation dans ce fichier. Un objet de
   courriel contenant du HTML ne peut donc rien exécuter ici.
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  OAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Cache persistant : la page rouvre sur les derniers chiffres connus au lieu
// d'une page blanche, même sans réseau. L'âge de la relève dit alors tout seul
// qu'ils sont vieux.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const $ = (id) => document.getElementById(id);

const JOUR = 86400;

// Ordre d'affichage des catégories : celui de la mécanique de tri, pas
// l'alphabet. Il va de ce qui rapporte à ce qui encombre.
const ORDRE_CATEGORIES = [
  "demande", "affaires", "facture", "emploi", "technique", "autre", "infolettre",
];

const LIBELLES_CATEGORIES = {
  demande: "Demande du site",
  affaires: "Affaires",
  facture: "Factures et argent",
  emploi: "Emploi",
  technique: "Alertes techniques",
  infolettre: "Infolettres",
  autre: "À trier",
};

// Les raisons d'être dans la file, de la plus pressante à la moins pressante.
const ORDRE_RAISONS = ["marqué", "sans réponse", "à répondre", "à voir"];

const CLASSES_RAISONS = {
  "marqué": "raison-marque",
  "sans réponse": "raison-sans-reponse",
};

// Genre d'anomalie -> icône ET mot. Jamais la couleur seule : une pastille rouge
// sans mot ne dit rien à qui ne distingue pas le rouge du vert.
const ANOMALIES = {
  afflux: { icone: "▲", mot: "Afflux", classe: "genre-afflux" },
  silence: { icone: "◼", mot: "Silence", classe: "genre-silence" },
  expediteur_muet: { icone: "○", mot: "Expéditeur muet", classe: "genre-muet" },
};

// Les deux teintes catégorielles, dans un ORDRE FIXE. Une boîte reçoit sa
// couleur par son rang dans la liste des comptes, laquelle ne dépend pas des
// filtres : filtrer ne repeint donc jamais les survivants.
const SERIES = ["var(--serie-1)", "var(--serie-2)", "var(--serie-3)", "var(--serie-4)"];

let etat = null;
let filtrePeriode = 30;
let filtreBoite = "";
let vueTableaux = false;

/* ── petits utilitaires ──────────────────────────────────────────────────── */

function nombre(n) {
  return (n || 0).toLocaleString("fr-CA");
}

function texte(parent, balise, contenu, classe) {
  const el = document.createElement(balise);
  if (classe) el.className = classe;
  if (contenu !== undefined && contenu !== null) el.textContent = String(contenu);
  parent.appendChild(el);
  return el;
}

function vider(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function ageTexte(secondes) {
  if (!secondes) return "jamais";
  const ecart = Math.max(0, Date.now() / 1000 - secondes);
  if (ecart < 90) return "à l'instant";
  if (ecart < 5400) return `il y a ${Math.round(ecart / 60)} min`;
  if (ecart < 2 * JOUR) return `il y a ${(ecart / 3600).toFixed(1)} h`;
  return `il y a ${Math.round(ecart / JOUR)} j`;
}

function joursTexte(jours) {
  if (jours === null || jours === undefined) return "—";
  if (jours < 1) return "aujourd'hui";
  if (jours < 2) return "1 j";
  return `${Math.round(jours)} j`;
}

function jourCourt(iso) {
  // « 2026-08-12 » -> « 12 août ». Construit sans Date pour éviter le décalage
  // d'un jour que provoque l'interprétation UTC d'une date nue.
  const mois = ["janv.", "févr.", "mars", "avr.", "mai", "juin",
                "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  return `${Number(m[3])} ${mois[Number(m[2]) - 1]}`;
}

function libelleCategorie(cle) {
  return LIBELLES_CATEGORIES[cle] || cle;
}

function etiquetteExpediteur(texteBrut) {
  // La colonne des noms fait 210 px : au-delà d'une trentaine de caractères, le
  // nom mordrait sur les barres. On coupe par la fin, l'adresse restant lisible
  // par son début.
  const propre = (texteBrut || "").trim();
  return propre.length > 30 ? `${propre.slice(0, 29)}…` : propre;
}

/* ── tranche courante : ce que les filtres laissent passer ───────────────── */

function comptesAffiches() {
  const tous = (etat.comptes || []);
  return filtreBoite ? tous.filter((c) => c.adresse === filtreBoite) : tous;
}

function couleurBoite(adresse) {
  // Le rang vient de la liste COMPLÈTE des comptes : la couleur suit la boîte,
  // pas sa position dans la liste filtrée.
  const rang = (etat.comptes || []).findIndex((c) => c.adresse === adresse);
  return SERIES[(rang < 0 ? 0 : rang) % SERIES.length];
}

function dansLaTranche(courriel) {
  if (filtreBoite && courriel.compte !== filtreBoite) return false;
  const limite = Date.now() / 1000 - filtrePeriode * JOUR;
  return (courriel.recu || 0) >= limite;
}

/* ── bandeaux d'avis ────────────────────────────────────────────────────── */

function rendreBandeaux() {
  const hote = $("banners");
  vider(hote);
  if (!etat) return;

  const avis = [];
  const ageReleve = Date.now() / 1000 - (etat.releveLe || 0) / 1000;

  // Une relève qui ne se renouvelle plus est le pire cas : les chiffres ont
  // l'air normaux et ils sont faux. Le seuil est large (2 h) pour une minuterie
  // qui tourne aux dix minutes.
  if (ageReleve > 7200) {
    avis.push({
      genre: "grave", icone: "⚠",
      texte: `Aucune relève depuis ${ageTexte((etat.releveLe || 0) / 1000)
        }. Les chiffres ci-dessous sont ceux de cette date, pas ceux de maintenant. `
        + "Vérifier la minuterie bg-courriel sur BG001.",
    });
  }

  if (etat.controle && etat.controle.toutOk === false) {
    const ecarts = (etat.controle.parDossier || []).filter((d) => !d.ok);
    if (ecarts.length) {
      avis.push({
        genre: "grave", icone: "⚠",
        texte: `Le comptage de l'outil ne concorde plus avec celui de Thunderbird sur ${
          ecarts.length} dossier(s). Voir « Contrôle » au bas de la page.`,
      });
    }
  }

  for (const plainte of (etat.plaintes || [])) {
    avis.push({ genre: "avert", icone: "⚠", texte: plainte });
  }

  const coupes = etat.coupes || {};
  if (coupes.file) {
    avis.push({
      genre: "info", icone: "ℹ",
      texte: `La file compte ${nombre(coupes.file)} entrée(s) de plus que ce que `
        + "le document peut porter ; les plus urgentes sont affichées. Le compte "
        + "en tête, lui, est complet.",
    });
  }

  for (const avi of avis) {
    const bandeau = texte(hote, "div", null, `banner banner-${avi.genre}`);
    texte(bandeau, "span", avi.icone, "banner-icone");
    texte(bandeau, "span", avi.texte);
  }
}

/* ── nombre héros et tuiles ─────────────────────────────────────────────── */

function rendreEnTete() {
  const comptes = comptesAffiches();
  const somme = (champ) => comptes.reduce((t, c) => t + (c[champ] || 0), 0);
  const action = somme("action");

  $("hero-action").textContent = nombre(action);

  const plusVieux = comptes.reduce(
    (m, c) => Math.max(m, c.nonLus ? (c.plusVieuxNonLu || 0) : 0), 0);
  $("hero-detail").textContent = action === 0
    ? "rien n'attend de geste"
    : `sur ${nombre(somme("total"))} courriels · relève ${ageTexte((etat.releveLe || 0) / 1000)}`;

  // Répartition des raisons : elle explique le nombre héros au lieu de le
  // laisser sans justification.
  const raisons = new Map();
  for (const courriel of (etat.file || [])) {
    if (filtreBoite && courriel.compte !== filtreBoite) continue;
    raisons.set(courriel.action, (raisons.get(courriel.action) || 0) + 1);
  }
  const liste = $("hero-raisons");
  vider(liste);
  for (const raison of ORDRE_RAISONS) {
    const n = raisons.get(raison) || 0;
    if (!n) continue;
    const li = texte(liste, "li");
    texte(li, "strong", nombre(n), CLASSES_RAISONS[raison] || "");
    texte(li, "span", ` ${raison}`);
  }

  $("portee-etat").textContent = filtreBoite
    ? filtreBoite
    : `${nombre(comptes.length)} boîte(s), tout l'historique`;

  const tuiles = [
    { valeur: nombre(somme("total")), label: "courriels au total",
      detail: `${nombre(etat.totaux ? etat.totaux.dossiers : 0)} dossier(s) lus` },
    { valeur: nombre(somme("nonLus")), label: "non lus" },
    { valeur: plusVieux ? joursTexte(plusVieux) : "—", label: "plus vieux non lu",
      detail: plusVieux ? "âge du plus ancien courriel jamais ouvert" : "aucun non lu" },
    { valeur: nombre(retardAffiche()), label: "en retard",
      detail: "non lus qui ne demandent plus de geste" },
  ];

  const hote = $("tuiles");
  vider(hote);
  for (const t of tuiles) {
    const carte = texte(hote, "div", null, "tuile");
    texte(carte, "div", t.valeur, "tuile-valeur");
    texte(carte, "div", t.label, "tuile-label");
    if (t.detail) texte(carte, "div", t.detail, "tuile-detail");
  }
}

function retardAffiche() {
  // Le retard est calculé sur toutes les boîtes par la machine. Filtré sur une
  // seule boîte, il se recalcule ici depuis « recents » — et la note de la
  // section dit alors sur quelle fenêtre, pour ne pas faire passer un compte
  // partiel pour un compte complet.
  if (!filtreBoite) return (etat.totaux && etat.totaux.retard) || 0;
  return (etat.recents || []).filter(
    (c) => c.compte === filtreBoite && !c.lu && !c.action && c.categorie !== "infolettre",
  ).length;
}

function rendreBoites() {
  const corps = $("table-boites").querySelector("tbody");
  vider(corps);
  for (const compte of (etat.comptes || [])) {
    const tr = document.createElement("tr");
    const tdNom = document.createElement("td");
    const pastille = texte(tdNom, "span", null, "pastille");
    pastille.style.background = couleurBoite(compte.adresse);
    tdNom.appendChild(document.createTextNode(compte.adresse));
    tr.appendChild(tdNom);
    texte(tr, "td", nombre(compte.total), "num");
    texte(tr, "td", nombre(compte.nonLus), "num");
    texte(tr, "td", nombre(compte.action), "num");
    // Sans non-lu, il n'y a pas de « plus vieux non lu » : joursTexte(0)
    // écrirait « aujourd'hui », ce qui laisse croire à un courriel du jour.
    texte(tr, "td", compte.nonLus ? joursTexte(compte.plusVieuxNonLu) : "—", "num");
    texte(tr, "td", ageTexte(compte.fraicheur), "attenue");
    corps.appendChild(tr);
  }
}

/* ── file d'action ──────────────────────────────────────────────────────── */

function rendreFile() {
  const corps = $("table-file").querySelector("tbody");
  vider(corps);

  // La file du document est déjà triée par urgence ; le filtre de boîte ne
  // change pas cet ordre. La période NE s'applique PAS à la file : un courriel
  // de 75 jours qui attend une réponse est justement ce qu'on ne veut pas voir
  // disparaître parce qu'on regarde « les 30 derniers jours ». La note le dit.
  const lignes = (etat.file || []).filter(
    (c) => !filtreBoite || c.compte === filtreBoite,
  );

  // Vingt-cinq lignes, pas cent. La première image du tableau de bord montrait
  // une file de cent lignes qui écrasait tout le reste de la page : les
  // graphiques et les anomalies se retrouvaient à deux écrans de défilement, et
  // personne ne les aurait jamais vus. La file est triée par urgence — au-delà
  // du haut de la pile, on ne travaille plus, on contemple.
  const MAX_LIGNES = 25;
  const affichees = lignes.slice(0, MAX_LIGNES);
  const reste = lignes.length - affichees.length;

  $("note-file").textContent = lignes.length
    ? `${nombre(lignes.length)} entrée(s)`
      + (reste > 0 ? ` · les ${MAX_LIGNES} plus urgentes ci-dessous, ${nombre(reste)} de plus` : "")
      + " · tous âges confondus, la période ne s'y applique pas"
    : "";
  $("file-vide").hidden = lignes.length > 0;

  for (const courriel of affichees) {
    const tr = document.createElement("tr");
    texte(tr, "td", courriel.action || "", `raison ${CLASSES_RAISONS[courriel.action] || ""}`);
    texte(tr, "td", joursTexte(courriel.ageJours), "num");
    texte(tr, "td", libelleCategorie(courriel.categorie), "");
    const tdExp = document.createElement("td");
    tdExp.appendChild(document.createTextNode(courriel.expediteurNom || courriel.expediteur || ""));
    tdExp.title = courriel.expediteur || "";
    tr.appendChild(tdExp);
    const tdObjet = texte(tr, "td", courriel.objet || "");
    if (courriel.apercu) tdObjet.title = courriel.apercu;
    const tdBoite = document.createElement("td");
    const pastille = texte(tdBoite, "span", null, "pastille");
    pastille.style.background = couleurBoite(courriel.compte);
    // La partie avant l'arobase suffit : toutes les boîtes sont du même domaine,
    // et l'adresse entière faisait déborder la colonne hors de la carte. La
    // pastille de couleur et l'infobulle portent le reste.
    const compte = courriel.compte || "";
    tdBoite.appendChild(document.createTextNode(compte.split("@")[0] || compte));
    tdBoite.title = compte;
    tdBoite.className = "attenue";
    tr.appendChild(tdBoite);
    corps.appendChild(tr);
  }
}

/* ── infobulle partagée ─────────────────────────────────────────────────── */

const infobulle = {
  el: null,
  montrer(x, y, titre, lignes) {
    if (!this.el) this.el = $("infobulle");
    vider(this.el);
    texte(this.el, "div", titre, "infobulle-titre");
    for (const ligne of lignes) {
      const rangee = texte(this.el, "div", null, "infobulle-ligne");
      if (ligne.couleur) {
        const cle = texte(rangee, "span", null, "infobulle-cle");
        cle.style.background = ligne.couleur;
      }
      // La valeur mène, le nom suit : le lecteur a la série et veut le nombre.
      texte(rangee, "span", ligne.valeur, "infobulle-valeur");
      texte(rangee, "span", ligne.nom, "infobulle-nom");
    }
    this.el.hidden = false;
    const largeur = this.el.offsetWidth;
    const hauteur = this.el.offsetHeight;
    let gauche = x + 14;
    if (gauche + largeur > window.innerWidth - 8) gauche = x - largeur - 14;
    let haut = y - hauteur - 10;
    if (haut < 8) haut = y + 18;
    this.el.style.left = `${Math.max(8, gauche)}px`;
    this.el.style.top = `${haut}px`;
  },
  cacher() {
    if (!this.el) this.el = $("infobulle");
    this.el.hidden = true;
  },
};

/* ── fabrique SVG ───────────────────────────────────────────────────────── */

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(nom, attributs) {
  const el = document.createElementNS(SVGNS, nom);
  for (const [cle, valeur] of Object.entries(attributs || {})) {
    el.setAttribute(cle, String(valeur));
  }
  return el;
}

function svgTexte(parent, x, y, contenu, classe, ancre) {
  const el = svgEl("text", { x, y, class: classe || "viz-tick" });
  if (ancre) el.setAttribute("text-anchor", ancre);
  el.textContent = String(contenu);
  parent.appendChild(el);
  return el;
}

/* Barres horizontales à TEINTE UNIQUE, triées par grandeur.
 *
 * Une seule teinte parce que la longueur de la barre dit déjà la grandeur :
 * colorer chaque barre différemment dépenserait le seul canal libre pour
 * répéter une information déjà lisible. La valeur est écrite au bout de la
 * barre — dehors, jamais dedans, pour qu'aucun texte ne soit rogné par une
 * barre trop courte.
 */
function barresHorizontales(hote, items, options) {
  vider(hote);
  const opts = options || {};
  if (!items.length) {
    texte(hote, "p", opts.vide || "Rien à montrer.", "vide");
    return;
  }
  const hauteurLigne = 30;
  const epaisseur = 14;                 // bien sous les 24 px de plafond
  const largeurNoms = opts.largeurNoms || 210;
  // Deux gouttières réservées à droite, et la mesure a imposé leurs largeurs :
  // la première image montrait la valeur du plus long bâton écrite PAR-DESSUS le
  // texte « 14 non lus » — « 1[14]on lus » à l'écran. Le bâton s'arrête donc
  // avant les deux, au lieu d'aller jusqu'au bord et d'espérer que ça tienne.
  const margeValeur = 52;               // « 1 234 » au bout du bâton
  const margeSecondaire = items.some((i) => i.secondaire) ? 110 : 0;
  const largeur = 720;
  const hauteur = items.length * hauteurLigne + 8;
  const maxi = Math.max(1, ...items.map((i) => i.valeur));
  const largeurBarres = largeur - largeurNoms - margeValeur - margeSecondaire;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${largeur} ${hauteur}`,
    role: "img",
    "aria-label": opts.titre || "Diagramme à barres",
  });

  items.forEach((item, index) => {
    const y = index * hauteurLigne + 6;
    const milieu = y + epaisseur / 2;
    svgTexte(svg, 0, milieu + 4, item.nom, "viz-nom");

    const longueur = Math.max(2, (item.valeur / maxi) * largeurBarres);
    // Bout arrondi de 4 px du côté de la valeur, carré sur la ligne de base :
    // la base doit rester une ligne droite pour que les barres se comparent.
    const x = largeurNoms;
    const r = 4;
    const chemin = longueur <= r
      ? `M${x} ${y} h${longueur} v${epaisseur} h${-longueur} Z`
      : `M${x} ${y} h${longueur - r} a${r} ${r} 0 0 1 ${r} ${r}`
        + ` v${epaisseur - 2 * r} a${r} ${r} 0 0 1 ${-r} ${r}`
        + ` h${-(longueur - r)} Z`;

    const groupe = svgEl("g", {});
    const cible = svgEl("rect", {
      x: x - 4, y: y - 6, width: largeurBarres + 8, height: hauteurLigne,
      class: "viz-cible", tabindex: 0,
      role: "img",
      "aria-label": `${item.nom} : ${item.valeur}${item.secondaire ? ", " + item.secondaire : ""}`,
    });
    const barre = svgEl("path", {
      d: chemin, fill: item.couleur || "var(--seq-moyen)", class: "viz-marque",
    });
    groupe.appendChild(cible);
    groupe.appendChild(barre);
    svg.appendChild(groupe);

    svgTexte(svg, x + longueur + 8, milieu + 4, nombre(item.valeur), "viz-valeur");
    if (item.secondaire) {
      svgTexte(svg, largeur, milieu + 4, item.secondaire, "viz-secondaire", "end");
    }

    const afficher = (evenement) => {
      const boite = cible.getBoundingClientRect();
      const lignes = [{ valeur: nombre(item.valeur), nom: opts.unite || "courriels",
                        couleur: item.couleur || "var(--seq-moyen)" }];
      if (item.detail) lignes.push({ valeur: item.detail, nom: "" });
      infobulle.montrer(
        evenement.clientX || boite.left + boite.width / 2,
        evenement.clientY || boite.top,
        item.nom, lignes,
      );
    };
    cible.addEventListener("pointermove", afficher);
    cible.addEventListener("pointerleave", () => infobulle.cacher());
    cible.addEventListener("focus", afficher);
    cible.addEventListener("blur", () => infobulle.cacher());
  });

  hote.appendChild(svg);
}

/* Colonnes empilées par boîte, une colonne par jour.
 *
 * Empilées et non côte à côte parce que la question est double : « combien en
 * tout ce jour-là » (la hauteur totale) et « venant de quelle boîte » (les
 * segments). Un écart de 2 px de la couleur de la surface sépare les segments —
 * jamais un contour, qui ajouterait de l'encre qui n'est pas de la donnée.
 */
function colonnesEmpilees(hote, jours, series, options) {
  vider(hote);
  const opts = options || {};
  const largeur = 720;
  const hautPlot = 170;
  const bandeAxe = 26;                  // la hauteur inclut les étiquettes de l'axe
  const hauteur = hautPlot + bandeAxe;
  const margeGauche = 34;
  const largeurPlot = largeur - margeGauche - 6;
  const n = jours.length;
  if (!n) {
    texte(hote, "p", "Rien à montrer.", "vide");
    return;
  }

  const totaux = jours.map((_, i) => series.reduce((t, s) => t + (s.valeurs[i] || 0), 0));
  const maxi = Math.max(1, ...totaux);
  const graduation = echelonner(maxi);
  const pas = largeurPlot / n;
  const epaisseur = Math.min(24, Math.max(2, pas - 2));

  const svg = svgEl("svg", {
    viewBox: `0 0 ${largeur} ${hauteur}`,
    role: "img",
    "aria-label": opts.titre || "Volume par jour",
  });

  // Grille : traits d'un cheveu, PLEINS, en retrait.
  for (const valeur of graduation) {
    const y = hautPlot - (valeur / graduation[graduation.length - 1]) * hautPlot;
    svg.appendChild(svgEl("line", {
      x1: margeGauche, y1: y, x2: largeur - 6, y2: y, class: "viz-grille",
    }));
    svgTexte(svg, margeGauche - 8, y + 4, nombre(valeur), "viz-tick", "end");
  }
  svg.appendChild(svgEl("line", {
    x1: margeGauche, y1: hautPlot, x2: largeur - 6, y2: hautPlot, class: "viz-axe",
  }));

  const haut = graduation[graduation.length - 1];

  jours.forEach((jour, i) => {
    const xCentre = margeGauche + pas * (i + 0.5);
    const x = xCentre - epaisseur / 2;
    let cumul = 0;
    const segments = [];

    series.forEach((serie) => {
      const valeur = serie.valeurs[i] || 0;
      if (!valeur) return;
      const hSegment = (valeur / haut) * hautPlot;
      const yHaut = hautPlot - ((cumul + valeur) / haut) * hautPlot;
      segments.push({ serie, valeur, yHaut, hSegment });
      cumul += valeur;
    });

    segments.forEach((segment, rang) => {
      const dernier = rang === segments.length - 1;
      // 2 px retirés en bas de chaque segment sauf le premier : c'est l'écart de
      // surface qui sépare, et il garde la même largeur partout dans la pile.
      const ecart = rang === 0 ? 0 : 2;
      const h = Math.max(1, segment.hSegment - ecart);
      const y = segment.yHaut;
      const r = 4;
      let chemin;
      if (dernier && h > r) {
        // Sommet arrondi de 4 px, base carrée.
        chemin = `M${x} ${y + r} a${r} ${r} 0 0 1 ${r} ${-r} h${epaisseur - 2 * r}`
          + ` a${r} ${r} 0 0 1 ${r} ${r} v${h - r} h${-epaisseur} Z`;
      } else {
        chemin = `M${x} ${y} h${epaisseur} v${h} h${-epaisseur} Z`;
      }
      svg.appendChild(svgEl("path", { d: chemin, fill: segment.serie.couleur }));
    });

    // Cible de survol : toute la colonne, du haut du plot à la base, élargie au
    // pas complet. On vise un jour, jamais une barre de 2 px.
    const cible = svgEl("rect", {
      x: margeGauche + pas * i, y: 0,
      width: Math.max(pas, 10), height: hautPlot,
      class: "viz-cible", tabindex: 0, role: "img",
      "aria-label": `${jour} : ${totaux[i]} courriel(s)`,
    });
    const afficher = (evenement) => {
      const boite = cible.getBoundingClientRect();
      const lignes = series
        .filter((s) => (s.valeurs[i] || 0) > 0)
        .map((s) => ({ valeur: nombre(s.valeurs[i]), nom: s.nom, couleur: s.couleur }));
      if (series.length > 1) {
        lignes.push({ valeur: nombre(totaux[i]), nom: "en tout" });
      }
      if (!lignes.length) lignes.push({ valeur: "0", nom: "courriel" });
      infobulle.montrer(
        evenement.clientX || boite.left + boite.width / 2,
        evenement.clientY || boite.top,
        jourCourt(jour), lignes,
      );
      curseur.setAttribute("x1", xCentre);
      curseur.setAttribute("x2", xCentre);
      curseur.removeAttribute("hidden");
      curseur.style.display = "";
    };
    cible.addEventListener("pointermove", afficher);
    cible.addEventListener("focus", afficher);
    cible.addEventListener("pointerleave", () => {
      infobulle.cacher();
      curseur.style.display = "none";
    });
    cible.addEventListener("blur", () => {
      infobulle.cacher();
      curseur.style.display = "none";
    });
    svg.appendChild(cible);
  });

  // Le curseur trouve le jour : le lecteur vise une date, pas un trait.
  const curseur = svgEl("line", {
    x1: 0, y1: 0, x2: 0, y2: hautPlot, class: "viz-curseur",
  });
  curseur.style.display = "none";
  svg.appendChild(curseur);

  for (const i of indicesEtiquettes(n, 8)) {
    svgTexte(svg, margeGauche + pas * (i + 0.5), hautPlot + 17,
             jourCourt(jours[i]), "viz-tick", "middle");
  }

  hote.appendChild(svg);
}

/* Lignes : 2 px, jointures rondes, marqueur de fin d'au moins 8 px cerclé de la
 * couleur de la surface pour rester lisible là où deux courbes se croisent.
 */
function lignes(hote, jours, series, options) {
  vider(hote);
  const opts = options || {};
  const largeur = 720;
  const hautPlot = 160;
  const bandeAxe = 26;
  const hauteur = hautPlot + bandeAxe;
  const margeGauche = 38;
  const margeDroite = 46;               // place pour l'étiquette de fin
  const largeurPlot = largeur - margeGauche - margeDroite;
  const n = jours.length;
  if (n < 2) {
    texte(hote, "p", opts.vide || "Pas encore assez de points.", "vide");
    return;
  }

  const maxi = Math.max(1, ...series.flatMap((s) => s.valeurs));
  const graduation = echelonner(maxi);
  const haut = graduation[graduation.length - 1];
  const pas = n > 1 ? largeurPlot / (n - 1) : largeurPlot;
  const xDe = (i) => margeGauche + pas * i;
  const yDe = (v) => hautPlot - ((v || 0) / haut) * hautPlot;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${largeur} ${hauteur}`,
    role: "img", "aria-label": opts.titre || "Évolution",
  });

  for (const valeur of graduation) {
    const y = yDe(valeur);
    svg.appendChild(svgEl("line", {
      x1: margeGauche, y1: y, x2: largeur - margeDroite, y2: y, class: "viz-grille",
    }));
    svgTexte(svg, margeGauche - 8, y + 4, nombre(valeur), "viz-tick", "end");
  }
  svg.appendChild(svgEl("line", {
    x1: margeGauche, y1: hautPlot, x2: largeur - margeDroite, y2: hautPlot,
    class: "viz-axe",
  }));

  for (const serie of series) {
    const points = serie.valeurs.map((v, i) => `${xDe(i)},${yDe(v)}`).join(" ");
    svg.appendChild(svgEl("polyline", {
      points, fill: "none", stroke: serie.couleur, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    // Marqueur de fin : anneau de 2 px de la couleur de la surface, puis le
    // point. L'anneau fait partie de la marque, pas de l'espacement.
    const xFin = xDe(n - 1);
    const yFin = yDe(serie.valeurs[n - 1]);
    svg.appendChild(svgEl("circle", {
      cx: xFin, cy: yFin, r: 6, fill: "var(--surface-viz)",
    }));
    svg.appendChild(svgEl("circle", {
      cx: xFin, cy: yFin, r: 4.5, fill: serie.couleur,
    }));
    // Étiquette directe au bout, sélective : la dernière valeur seulement,
    // jamais un nombre sur chaque point.
    svgTexte(svg, xFin + 10, yFin + 4, nombre(serie.valeurs[n - 1]), "viz-valeur");
  }

  const curseur = svgEl("line", {
    x1: 0, y1: 0, x2: 0, y2: hautPlot, class: "viz-curseur",
  });
  curseur.style.display = "none";
  svg.appendChild(curseur);

  // Une cible par jour, large d'un pas : le curseur trouve le X, une seule
  // infobulle donne TOUTES les séries de ce jour.
  jours.forEach((jour, i) => {
    const cible = svgEl("rect", {
      x: xDe(i) - pas / 2, y: 0, width: Math.max(pas, 24), height: hautPlot,
      class: "viz-cible", tabindex: 0, role: "img",
      "aria-label": `${jour} : ${series.map((s) => `${s.nom} ${s.valeurs[i]}`).join(", ")}`,
    });
    const afficher = (evenement) => {
      const boite = cible.getBoundingClientRect();
      infobulle.montrer(
        evenement.clientX || boite.left + boite.width / 2,
        evenement.clientY || boite.top,
        jourCourt(jour),
        series.map((s) => ({
          valeur: nombre(s.valeurs[i]), nom: s.nom, couleur: s.couleur,
        })),
      );
      curseur.setAttribute("x1", xDe(i));
      curseur.setAttribute("x2", xDe(i));
      curseur.style.display = "";
    };
    cible.addEventListener("pointermove", afficher);
    cible.addEventListener("focus", afficher);
    cible.addEventListener("pointerleave", () => {
      infobulle.cacher();
      curseur.style.display = "none";
    });
    cible.addEventListener("blur", () => {
      infobulle.cacher();
      curseur.style.display = "none";
    });
    svg.appendChild(cible);
  });

  for (const i of indicesEtiquettes(n, 7)) {
    svgTexte(svg, xDe(i), hautPlot + 17, jourCourt(jours[i]), "viz-tick", "middle");
  }

  hote.appendChild(svg);
}

/* Quels jours reçoivent une étiquette d'axe.
 *
 * Le dernier jour en reçoit une — c'est celui qu'on regarde — MAIS seulement
 * s'il ne tombe pas trop près du précédent. La première version l'ajoutait
 * toujours, et sur trente jours « 11 août » se superposait à « 12 août » : à
 * l'écran, « 11 aĐ12août ». Deux étiquettes qui se chevauchent valent moins
 * qu'une seule.
 */
function indicesEtiquettes(n, combien) {
  const saut = Math.max(1, Math.ceil(n / combien));
  const indices = [];
  for (let i = 0; i < n; i += saut) indices.push(i);
  const dernier = n - 1;
  if (indices[indices.length - 1] !== dernier) {
    if (dernier - indices[indices.length - 1] >= saut * 0.6) {
      indices.push(dernier);
    } else {
      indices[indices.length - 1] = dernier;
    }
  }
  return indices;
}

function echelonner(maxi) {
  // Graduations rondes : 0 / 5 / 10, jamais 0 / 3,7 / 7,4.
  const cibles = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const brut = maxi / 3;
  const pas = cibles.find((c) => c >= brut) || Math.ceil(brut / 1000) * 1000;
  const graduation = [];
  for (let v = 0; v <= maxi + pas - 1; v += pas) graduation.push(v);
  if (graduation.length < 2) graduation.push(pas);
  return graduation;
}

function rendreLegende(hote, series, forme) {
  vider(hote);
  // Une légende est présente dès DEUX séries : l'identité ne doit jamais
  // reposer sur la seule couleur. Une série unique n'en a pas besoin — le titre
  // de la carte dit déjà ce qui est tracé.
  if (series.length < 2) return;
  for (const serie of series) {
    const entree = texte(hote, "span", null, "legende-entree");
    const cle = texte(entree, "span", null,
                      `legende-cle${forme === "ligne" ? " legende-cle-ligne" : ""}`);
    cle.style.background = serie.couleur;
    // Le texte garde l'encre de texte ; c'est la pastille à côté qui porte
    // l'identité. Une teinte claire serait illisible en texte.
    texte(entree, "span", serie.nom);
  }
}

/* ── sections graphiques ────────────────────────────────────────────────── */

function rendreCategories() {
  const tranche = (etat.recents || []).filter(dansLaTranche);
  const parts = new Map();
  for (const courriel of tranche) {
    const entree = parts.get(courriel.categorie)
      || { total: 0, nonLus: 0, action: 0 };
    entree.total += 1;
    if (!courriel.lu) entree.nonLus += 1;
    if (courriel.action) entree.action += 1;
    parts.set(courriel.categorie, entree);
  }

  const items = ORDRE_CATEGORIES
    .filter((cle) => parts.has(cle))
    .map((cle) => {
      const part = parts.get(cle);
      return {
        cle,
        nom: libelleCategorie(cle),
        valeur: part.total,
        secondaire: part.nonLus ? `${nombre(part.nonLus)} non lus` : "",
        detail: part.action ? `${nombre(part.action)} à traiter` : "rien à traiter",
        part,
      };
    })
    .sort((a, b) => b.valeur - a.valeur);

  $("note-categories").textContent = `${filtrePeriode} derniers jours · ${
    nombre(tranche.length)} courriels`;

  barresHorizontales($("graph-categories"), items, {
    titre: "Courriels par catégorie", unite: "courriels",
    vide: "Aucun courriel dans cette tranche.",
  });

  const corps = $("table-categories").querySelector("tbody");
  vider(corps);
  for (const item of items) {
    const tr = document.createElement("tr");
    texte(tr, "td", item.nom);
    texte(tr, "td", nombre(item.part.total), "num");
    texte(tr, "td", nombre(item.part.nonLus), "num");
    texte(tr, "td", nombre(item.part.action), "num");
    corps.appendChild(tr);
  }
}

function seriesVolume() {
  const tendances = etat.tendances || {};
  const jours = tendances.jours || [];
  const debut = Math.max(0, jours.length - filtrePeriode);
  const joursCoupes = jours.slice(debut);
  const parCompte = tendances.parCompte || {};

  let series = (etat.comptes || [])
    .filter((c) => !filtreBoite || c.adresse === filtreBoite)
    .filter((c) => (parCompte[c.adresse] || []).some((v) => v > 0))
    .map((c) => ({
      nom: c.adresse,
      couleur: couleurBoite(c.adresse),
      valeurs: (parCompte[c.adresse] || []).slice(debut),
    }));

  // Au-delà de quatre boîtes, la queue se replie sur « Autres boîtes » : on
  // n'invente jamais une cinquième teinte, elle serait indistinguable des
  // précédentes pour un œil daltonien.
  if (series.length > SERIES.length) {
    const gardees = series.slice(0, SERIES.length - 1);
    const repliees = series.slice(SERIES.length - 1);
    gardees.push({
      nom: `${repliees.length} autres boîtes`,
      couleur: "var(--seq-faible)",
      valeurs: joursCoupes.map((_, i) => repliees.reduce((t, s) => t + (s.valeurs[i] || 0), 0)),
    });
    series = gardees;
  }
  return { jours: joursCoupes, series };
}

function rendreVolume() {
  const { jours, series } = seriesVolume();
  const total = series.reduce((t, s) => t + s.valeurs.reduce((a, b) => a + b, 0), 0);
  $("note-volume").textContent = `${filtrePeriode} derniers jours · ${
    nombre(total)} courriels reçus`;

  rendreLegende($("legende-volume"), series, "bloc");
  colonnesEmpilees($("graph-volume"), jours, series, {
    titre: "Courriels reçus par jour et par boîte",
  });

  // Jumeau en tableau : toute valeur du graphique se lit aussi sans survol.
  const table = $("table-volume");
  const entete = table.querySelector("thead tr");
  vider(entete);
  texte(entete, "th", "Jour").setAttribute("scope", "col");
  for (const serie of series) {
    const th = texte(entete, "th", serie.nom, "num");
    th.setAttribute("scope", "col");
  }
  if (series.length > 1) {
    texte(entete, "th", "En tout", "num").setAttribute("scope", "col");
  }
  const corps = table.querySelector("tbody");
  vider(corps);
  jours.forEach((jour, i) => {
    const somme = series.reduce((t, s) => t + (s.valeurs[i] || 0), 0);
    if (!somme) return;                 // les jours vides encombrent le tableau
    const tr = document.createElement("tr");
    texte(tr, "td", jourCourt(jour));
    for (const serie of series) texte(tr, "td", nombre(serie.valeurs[i] || 0), "num");
    if (series.length > 1) texte(tr, "td", nombre(somme), "num");
    corps.appendChild(tr);
  });
}

function rendreEvolution() {
  const evolution = (etat.tendances || {}).evolution || {};
  const jours = evolution.jours || [];
  const series = [
    { nom: "non lus", couleur: "var(--serie-1)", valeurs: evolution.nonLus || [] },
    { nom: "à traiter", couleur: "var(--serie-2)", valeurs: evolution.action || [] },
  ];

  const assez = jours.length >= 2;
  $("evolution-vide").hidden = assez;
  $("note-evolution").textContent = assez
    ? `${jours.length} jour(s) de relèves · toutes boîtes`
    : "";

  if (assez) {
    rendreLegende($("legende-evolution"), series, "ligne");
    lignes($("graph-evolution"), jours, series, { titre: "Évolution du non-lu" });
  } else {
    vider($("legende-evolution"));
    vider($("graph-evolution"));
  }

  const corps = $("table-evolution").querySelector("tbody");
  vider(corps);
  jours.forEach((jour, i) => {
    const tr = document.createElement("tr");
    texte(tr, "td", jourCourt(jour));
    texte(tr, "td", nombre((evolution.nonLus || [])[i]), "num");
    texte(tr, "td", nombre((evolution.action || [])[i]), "num");
    corps.appendChild(tr);
  });
}

function rendreExpediteurs() {
  // Recalculé depuis la tranche pour que le filtre de période s'applique
  // vraiment. Le document porte aussi un classement sur 90 jours, mais afficher
  // celui-là sous un filtre « 7 jours » serait un filtre qui ment.
  const tranche = (etat.recents || []).filter(dansLaTranche);
  const parAdresse = new Map();
  for (const courriel of tranche) {
    const cle = courriel.expediteur || "(inconnu)";
    const entree = parAdresse.get(cle) || {
      nom: courriel.expediteurNom || cle, adresse: cle,
      total: 0, nonLus: 0, categorie: courriel.categorie,
    };
    entree.total += 1;
    if (!courriel.lu) entree.nonLus += 1;
    parAdresse.set(cle, entree);
  }

  const classe = [...parAdresse.values()]
    .sort((a, b) => b.total - a.total || a.adresse.localeCompare(b.adresse))
    .slice(0, 12);

  // Deux adresses différentes portent souvent le même nom affiché — Coursera
  // écrit depuis cinq sous-domaines et se présente « Coursera » chaque fois. Le
  // graphique montrait alors deux barres « Coursera » sans moyen de les
  // distinguer. Quand un nom est en double, on montre l'adresse : elle est plus
  // longue, mais elle dit laquelle des deux on regarde.
  const noms = new Map();
  for (const entree of classe) noms.set(entree.nom, (noms.get(entree.nom) || 0) + 1);

  $("note-expediteurs").textContent = `${filtrePeriode} derniers jours · ${
    nombre(parAdresse.size)} expéditeurs distincts`;

  barresHorizontales($("graph-expediteurs"), classe.map((e) => ({
    nom: etiquetteExpediteur(noms.get(e.nom) > 1 ? e.adresse : e.nom),
    valeur: e.total,
    secondaire: e.nonLus ? `${nombre(e.nonLus)} non lus` : "",
    detail: libelleCategorie(e.categorie),
  })), {
    titre: "Principaux expéditeurs", unite: "courriels",
    vide: "Aucun courriel dans cette tranche.",
  });

  const corps = $("table-expediteurs").querySelector("tbody");
  vider(corps);
  for (const entree of classe) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.appendChild(document.createTextNode(entree.adresse));
    tr.appendChild(td);
    texte(tr, "td", nombre(entree.total), "num");
    texte(tr, "td", nombre(entree.nonLus), "num");
    texte(tr, "td", libelleCategorie(entree.categorie));
    corps.appendChild(tr);
  }
}

/* ── santé de la relève ─────────────────────────────────────────────────── */

function rendreAnomalies() {
  const hote = $("anomalies");
  vider(hote);
  const liste = etat.anomalies || [];
  $("anomalies-vide").hidden = liste.length > 0;
  for (const anomalie of liste) {
    const modele = ANOMALIES[anomalie.genre] || { icone: "•", mot: anomalie.genre, classe: "" };
    const li = document.createElement("li");
    texte(li, "span", modele.icone, `anomalie-icone ${modele.classe}`);
    const corps = document.createElement("span");
    // Icône ET mot : la couleur ne porte jamais le sens à elle seule.
    texte(corps, "span", modele.mot, `anomalie-genre ${modele.classe}`);
    corps.appendChild(document.createTextNode(anomalie.texte || ""));
    li.appendChild(corps);
    hote.appendChild(li);
  }
}

function rendreControle() {
  const corps = $("table-controle").querySelector("tbody");
  vider(corps);
  for (const ligne of ((etat.controle || {}).parDossier || [])) {
    const tr = document.createElement("tr");
    texte(tr, "td", ligne.compte);
    texte(tr, "td", ligne.dossier);
    texte(tr, "td", nombre(ligne.total), "num");
    texte(tr, "td", nombre(ligne.totalAnnonce), "num");
    texte(tr, "td", nombre(ligne.nonLus), "num");
    texte(tr, "td", nombre(ligne.nonLusAnnonce), "num");
    texte(tr, "td", ligne.ok ? "✓ concorde" : "✗ écart",
          ligne.ok ? "verdict-ok" : "verdict-ecart");
    corps.appendChild(tr);
  }
}

function rendrePied() {
  const releve = etat.releveLe ? new Date(etat.releveLe) : null;
  const fraicheur = (etat.comptes || []).reduce((m, c) => Math.max(m, c.fraicheur || 0), 0);
  const morceaux = [];
  if (releve) {
    morceaux.push(`Relève du ${releve.toLocaleString("fr-CA")} (${
      ageTexte(etat.releveLe / 1000)}) sur ${etat.machine || "?"}`);
  }
  if (fraicheur) {
    morceaux.push(`index Thunderbird écrit ${ageTexte(fraicheur)}`);
  }
  const coupes = etat.coupes || {};
  if (coupes.horsFenetre) {
    morceaux.push(`${nombre(coupes.horsFenetre)} courriels plus vieux que 90 jours `
      + "comptés dans les totaux mais absents des listes");
  }
  $("pied-releve").textContent = morceaux.join(" · ");
}

/* ── rendu complet ──────────────────────────────────────────────────────── */

function rendre() {
  if (!etat) return;
  rendreBandeaux();
  rendreEnTete();
  rendreBoites();
  rendreFile();
  rendreCategories();
  rendreVolume();
  rendreEvolution();
  rendreExpediteurs();
  rendreAnomalies();
  rendreControle();
  rendrePied();
}

function peuplerFiltreBoites() {
  const select = $("filtre-boite");
  const choisi = select.value;
  vider(select);
  const toutes = document.createElement("option");
  toutes.value = "";
  toutes.textContent = "Toutes les boîtes";
  select.appendChild(toutes);
  for (const compte of (etat.comptes || [])) {
    const option = document.createElement("option");
    option.value = compte.adresse;
    option.textContent = compte.adresse;
    select.appendChild(option);
  }
  // Une boîte disparue du profil ne doit pas laisser un filtre fantôme actif.
  const existe = (etat.comptes || []).some((c) => c.adresse === choisi);
  select.value = existe ? choisi : "";
  filtreBoite = select.value;
}

function basculerVue() {
  vueTableaux = !vueTableaux;
  const bouton = $("btn-tableaux");
  bouton.setAttribute("aria-pressed", String(vueTableaux));
  bouton.textContent = vueTableaux
    ? "Revenir aux graphiques"
    : "Voir les graphiques en tableaux";
  for (const cle of ["categories", "volume", "evolution", "expediteurs"]) {
    $(`table-${cle}-boite`).hidden = !vueTableaux;
    $(`graph-${cle}`).hidden = vueTableaux;
  }
  vider($("legende-volume"));
  vider($("legende-evolution"));
  if (!vueTableaux) rendre();
}

$("filtre-periode").addEventListener("change", (e) => {
  filtrePeriode = Number(e.target.value) || 30;
  rendre();
});

$("filtre-boite").addEventListener("change", (e) => {
  filtreBoite = e.target.value;
  rendre();
});

$("btn-tableaux").addEventListener("click", basculerVue);

window.addEventListener("resize", () => infobulle.cacher());

/* ── authentification et abonnement ─────────────────────────────────────── */

const elsAuth = {
  gate: $("auth-gate"),
  main: document.querySelector("main"),
  btnLogin: $("btn-login"),
  btnLogout: $("btn-logout"),
  error: $("auth-error"),
};

const provider = new OAuthProvider("microsoft.com");
provider.setCustomParameters({ tenant: MICROSOFT_TENANT_ID });

elsAuth.btnLogin.addEventListener("click", () => {
  elsAuth.error.hidden = true;
  signInWithPopup(auth, provider).catch((e) => {
    elsAuth.error.textContent = `Connexion échouée : ${e.message}`;
    elsAuth.error.hidden = false;
  });
});

elsAuth.btnLogout.addEventListener("click", () => signOut(auth));

let desabonner = null;

onAuthStateChanged(auth, (user) => {
  if (desabonner) {
    desabonner();
    desabonner = null;
  }

  if (!user) {
    etat = null;
    elsAuth.gate.hidden = false;
    elsAuth.main.hidden = true;
    elsAuth.btnLogout.hidden = true;
    vider($("banners"));
    return;
  }

  elsAuth.gate.hidden = true;
  elsAuth.main.hidden = false;
  elsAuth.btnLogout.hidden = false;

  const reference = doc(db, "users", user.uid, "courriel", "etat");
  desabonner = onSnapshot(reference, (instantane) => {
    if (!instantane.exists()) {
      // Le cache peut annoncer « rien » avant la première réponse du serveur :
      // ce n'est pas la preuve qu'aucune relève n'existe. On n'affiche le
      // message définitif que si le SERVEUR le confirme.
      if (instantane.metadata && instantane.metadata.fromCache) return;
      etat = null;
      const hote = $("banners");
      vider(hote);
      const bandeau = texte(hote, "div", null, "banner banner-avert");
      texte(bandeau, "span", "⚠", "banner-icone");
      texte(bandeau, "span",
            "Aucune relève n'a encore été poussée. Lancer « python3 -m bg_courriel "
            + "pousser » sur BG001, ou vérifier la minuterie bg-courriel.");
      return;
    }
    etat = instantane.data();
    peuplerFiltreBoites();
    rendre();
  }, (erreur) => {
    const hote = $("banners");
    vider(hote);
    const bandeau = texte(hote, "div", null, "banner banner-grave");
    texte(bandeau, "span", "⚠", "banner-icone");
    texte(bandeau, "span", `Lecture impossible : ${erreur.message}`);
  });
});
