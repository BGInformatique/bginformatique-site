/*
 * Veille de prospection — page compagnon du tableau de bord marketing.
 *
 * BG Informatique n'a aucun client au moment d'écrire ceci. La prospection
 * n'est donc pas un canal parmi d'autres : c'est le seul qui compte, et cette
 * page est l'outil qui la tient.
 *
 * Ce que la page fait, et ce qu'elle ne fait PAS
 * ---------------------------------------------
 * Elle ne va RIEN chercher sur Facebook. Aucune API ne permet de chercher des
 * publications publiques (Public Feed et Keyword Insights sont réservées à des
 * partenaires médias approuvés), et le grattage automatisé est interdit par les
 * conditions d'utilisation — le risque étant le blocage définitif du compte
 * personnel, donc la perte des groupes eux-mêmes. Le repérage reste humain :
 * notifications de groupe, 30 minutes par jour ouvrable.
 *
 * Ce que la page apporte : la consignation en cinq secondes, l'ordre de
 * réponse par âge (une réponse en 2 h vaut dix réponses en 24 h), les relances
 * dues, et le rendement par groupe — qui dit lesquels quitter.
 *
 * Données personnelles — décision de conception, pas de discipline
 * ---------------------------------------------------------------
 * Les personnes repérées sont des particuliers. Leur publication contient des
 * renseignements personnels au sens de la Loi 25, et BG en devient responsable
 * dès qu'elle les enregistre. Le modèle n'a donc AUCUN champ de nom, de profil
 * ou de texte recopié : seulement le lien, qui donne accès au besoin sans
 * qu'on garde une copie. Une piste non convertie s'efface après 90 jours.
 * Ce n'est pas une règle qu'on se rappelle — c'est un champ qui n'existe pas.
 *
 * Firestore : users/<uid>/marketing/veille — couvert par la règle existante
 * « match /users/{uid}/marketing/{docId} ». Aucune règle à republier.
 */

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
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";
import {
  lireMandat, lireMandats, rendreSelecteur, surChangementDeMandat,
} from "./mandat.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const CLE = "veille.v1";
const RETENTION_TOMBSTONE = 90 * 24 * 3600 * 1000;
const PURGE_APRES = 90 * 24 * 3600 * 1000;   // Loi 25 : on ne garde pas ce qui n'a pas converti
const RELANCE_APRES = 3 * 24 * 3600 * 1000;  // sans nouvelle après 3 jours, on relance
const PERDU_APRES = 7 * 24 * 3600 * 1000;    // après 7 jours, le fil est mort
const CHAUD = 2 * 3600 * 1000;               // la fenêtre où une réponse compte vraiment
const TIEDE = 6 * 3600 * 1000;
const JOUR = 24 * 3600 * 1000;
const SEMAINE = 7 * JOUR;

/*
 * Le corridor exo Saint-Jérôme ↔ Montmorency. C'est de la géographie, pas une
 * donnée de mandat : sa place est bien dans le dépôt public.
 *
 * Vérifié auprès d'exo les 2 et 3 août 2026.
 *
 * La zone n'est PAS un corridor entre deux points : c'est une étoile. La 709
 * relie Saint-Jérôme à Montmorency (61 arrêts, ~70 min, tous les jours) en
 * passant par le TERMINUS SAINTE-THÉRÈSE — d'où repartent quinze autres lignes.
 * C'est ce carrefour, et non le trajet lui-même, qui définit ce qui est
 * atteignable :
 *
 *     240, 241 → Boisbriand          246, 247 → Blainville
 *     242      → Rosemère et Laval   249      → Lorraine et Terrebonne
 *     243      → Mirabel             250      → Sainte-Anne-des-Plaines
 *     251, 252 → Sainte-Thérèse      405, 600, 605 → Deux-Montagnes, St-Eustache
 *     709      → Saint-Jérôme        509 → même trajet, express aux heures de pointe
 *
 * Attention aux numéros : le réseau des Laurentides nord a été renuméroté le
 * 23 juin 2025. Les anciens numéros à un ou deux chiffres qui traînent encore
 * dans les applications tierces ne valent plus rien.
 *
 * S'y ajoute le TRAIN. La ligne exo2, renumérotée « ligne 12 », relie
 * Saint-Jérôme à Lucien-L'Allier au centre-ville de Montréal : 14 gares sur
 * 62,8 km. Cinq d'entre elles sont déjà dans la zone d'autobus (Saint-Jérôme,
 * Mirabel, Blainville, Sainte-Thérèse, Rosemère) ; les neuf autres l'étendent
 * jusqu'à Laval, Montréal-Ouest et le centre-ville.
 *
 * ⚠️ Atteignable ne veut pas dire rentable. C'est un train de banlieue, pas un
 * métro : la fréquence est faible hors pointe, et un aller-retour au
 * centre-ville occupe une demi-journée pour une intervention d'une heure. La
 * zone étendue sert à consigner une piste sans la jeter, pas à promettre un
 * déplacement. La promesse publique de déplacement reste la zone d'autobus.
 *
 * Ce que la première liste, écrite de mémoire, avait faux :
 *   - Sainte-Anne-des-Plaines manquait, alors qu'une ligne y va directement.
 *   - Prévost, Saint-Hippolyte et Piedmont ne sont PAS desservis. Les annoncer
 *     aurait été une promesse de déplacement fausse.
 *   - La zone était trop étroite : Terrebonne, Deux-Montagnes et Saint-Eustache
 *     sont atteignables depuis Sainte-Thérèse, et n'y figuraient pas.
 *
 * ⚠️ Changement de service annoncé par exo le 24 août 2026 (retour à l'horaire
 * régulier après l'été, sur la couronne nord). À revérifier ce jour-là.
 */
const VILLES = [
  // ── Zone principale : autobus depuis le terminus Sainte-Thérèse ──────────
  "Saint-Jérôme",                  // 709 — terminus nord
  "Sainte-Thérèse",                // 251, 252 — le carrefour
  "Sainte-Anne-des-Plaines",       // 250
  "Blainville",                    // 246, 247 · aussi une gare
  "Boisbriand",                    // 240, 241
  "Rosemère",                      // 242 · aussi une gare
  "Lorraine",                      // 249
  "Terrebonne",                    // 249, et 23 du secteur Terrebonne-Mascouche
  "Mirabel",                       // 243 · aussi une gare (ouverte en 2021)
  "Deux-Montagnes",                // 405, 600, 605 (express)
  "Saint-Eustache",                // 405, 600, 605 (express)
  "Bois-des-Filion",               // adjacent à Lorraine : desserte à valider
  "Laval (Montmorency)",           // 709 — terminus sud ; 242 via Rosemère
  // ── Zone étendue : train exo2, renuméroté « ligne 12 » ───────────────────
  "Laval (Sainte-Rose)",
  "Laval (Vimont)",
  "Laval (De la Concorde)",        // correspondance métro ligne orange
  "Montréal (Ahuntsic–Chabanel)",  // gares Bois-de-Boulogne et Chabanel
  "Montréal (Parc–Villeray)",      // gare Parc
  "Montréal (Vendôme–NDG)",        // gare Vendôme, correspondance métro
  "Montréal-Ouest",
  "Montréal (centre-ville)",       // Lucien-L'Allier — terminus sud
  "Hors zone",
];

const TYPES = {
  pc_lent: "PC lent", virus: "Virus / arnaque", wifi: "WiFi / réseau",
  imprimante: "Imprimante", donnees: "Sauvegarde / données", courriel: "Courriel",
  nouveau_pc: "Nouveau PC", motdepasse: "Mots de passe / compte piraté",
  aines: "Aide aux aînés", entreprise: "Entreprise", autre: "Autre",
};

const SOURCES = {
  facebook: "Facebook", reference: "Référence", fiche_google: "Fiche Google",
  partenaire: "Partenaire", terrain: "Terrain", autre: "Autre",
};

/*
 * Le pipeline. « repere » est le seul statut qui presse : tout le reste attend
 * l'autre partie. C'est pourquoi l'écran s'ouvre sur lui.
 */
const STATUTS = {
  repere: "Repérée", repondu: "Répondu", en_discussion: "En discussion",
  rdv: "RDV fixé", client: "Client", perdu: "Perdue", hors_zone: "Hors zone",
};
const ACQUIS = ["en_discussion", "rdv", "client"];   // la piste a produit un échange
const CLOS = ["client", "perdu", "hors_zone"];       // plus rien à faire

const $ = (id) => document.getElementById(id);
const maintenant = () => Date.now();
const nouvelId = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  "x" + maintenant().toString(36) + Math.random().toString(36).slice(2, 10);
const ech = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let state = VIDE();
let uidCourant = null;
let userDocRef = null;
let dernierEcrit = null;
let desabonner = null;
let filtreStatut = "";

/*
 * Le mandat courant, partagé avec les autres écrans. Une piste appartient au
 * mandat sous lequel elle a été repérée : la veille de BG pour elle-même et
 * celle qu'on ferait un jour pour un client ne se mélangent pas, pas plus que
 * leurs entonnoirs ou leur rendement par groupe.
 *
 * Les enregistrements d'avant ce champ n'ont pas de mandat. Ils restent
 * visibles sous « Tous les mandats » et sous celui qu'on leur donnera en les
 * rouvrant — on ne devine pas à leur place.
 */
let mandatCourant = lireMandat();
surChangementDeMandat((v) => { mandatCourant = v; rendre(); });
const duMandat = (x) => !mandatCourant || x.mandat === mandatCourant;

function VIDE() {
  return { pistes: [], groupes: [], tombstones: {}, updatedAt: 0 };
}

/* ═══════════════════════════  état et fusion  ══════════════════════════ */

function normaliser(brut) {
  const s = VIDE();
  if (!brut || typeof brut !== "object") return s;
  s.pistes = Array.isArray(brut.pistes) ? brut.pistes.filter((p) => p && p.id) : [];
  s.groupes = Array.isArray(brut.groupes) ? brut.groupes.filter((g) => g && g.id) : [];
  s.tombstones = brut.tombstones && typeof brut.tombstones === "object" ? brut.tombstones : {};
  s.updatedAt = Number(brut.updatedAt) || 0;
  for (const p of s.pistes) {
    p.maj = Number(p.maj) || 0;
    p.cree = Number(p.cree) || p.maj;
    p.statut = STATUTS[p.statut] ? p.statut : "repere";
    p.source = SOURCES[p.source] ? p.source : "facebook";
    p.type = TYPES[p.type] ? p.type : "autre";
    p.mandat = typeof p.mandat === "string" ? p.mandat : "";
    // Garde-fou : un import d'une version future ne doit pas réintroduire un
    // champ nominatif. On le retire à la lecture plutôt que de faire confiance.
    delete p.nom; delete p.profil; delete p.texte;
  }
  for (const g of s.groupes) {
    g.maj = Number(g.maj) || 0;
    g.cree = Number(g.cree) || g.maj;
    g.mandat = typeof g.mandat === "string" ? g.mandat : "";
  }
  return s;
}

function elaguer(tombstones) {
  const limite = maintenant() - RETENTION_TOMBSTONE;
  const out = {};
  for (const [id, ts] of Object.entries(tombstones)) if (ts > limite) out[id] = ts;
  return out;
}

/*
 * Même raisonnement que le tableau de bord : deux appareils modifient la même
 * liste sans se voir, alors on compare enregistrement par enregistrement et le
 * plus récemment modifié gagne. Une suppression laisse une pierre tombale,
 * sinon l'appareil qui a encore la piste la ressusciterait à la synchro.
 */
function fusionner(a, b) {
  const tombstones = {};
  for (const src of [a.tombstones || {}, b.tombstones || {}]) {
    for (const [id, ts] of Object.entries(src)) {
      if (!tombstones[id] || ts > tombstones[id]) tombstones[id] = ts;
    }
  }
  const fusionListe = (l1, l2) => {
    const parId = new Map();
    for (const r of [...(l1 || []), ...(l2 || [])]) {
      const p = parId.get(r.id);
      if (!p || (r.maj || 0) > (p.maj || 0)) parId.set(r.id, r);
    }
    return [...parId.values()].filter((r) => !(tombstones[r.id] > (r.maj || 0)));
  };
  return {
    pistes: fusionListe(a.pistes, b.pistes),
    groupes: fusionListe(a.groupes, b.groupes),
    tombstones: elaguer(tombstones),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };
}

function lireLocal() {
  try {
    const brut = localStorage.getItem(CLE);
    if (brut) state = normaliser(JSON.parse(brut));
  } catch { /* un stockage illisible ne doit pas empêcher la page d'ouvrir */ }
}

function ecrireLocal() {
  try { localStorage.setItem(CLE, JSON.stringify(state)); } catch { /* quota */ }
}

/* ═══════════════════════════  synchronisation  ═════════════════════════ */

let minuterieSync = null;

function enregistrer() {
  state.updatedAt = maintenant();
  ecrireLocal();
  rendre();
  clearTimeout(minuterieSync);
  minuterieSync = setTimeout(pousser, 600);
}

function pousser() {
  if (!userDocRef) return;
  const charge = JSON.stringify(state);
  if (charge === dernierEcrit) return;
  dernierEcrit = charge;
  etatSync("enregistrement…");
  setDoc(userDocRef, JSON.parse(charge))
    .then(() => etatSync("à jour"))
    .catch((e) => {
      dernierEcrit = null;
      etatSync("hors ligne");
      avis("Synchronisation en attente : " + e.message, true);
    });
}

/*
 * Hors ligne, Firestore livre un instantané venu du CACHE où le document
 * paraît inexistant. Amorcer depuis là écrirait un état vide par-dessus les
 * vraies données — on n'amorce jamais depuis un instantané de cache.
 */
function appliquerInstantane(snap) {
  if (!snap.exists()) {
    if (snap.metadata && snap.metadata.fromCache) return;
    if (state.pistes.length || state.groupes.length) pousser();
    else etatSync("aucune piste — commencer par ajouter des groupes");
    return;
  }
  const distant = normaliser(snap.data());
  state = fusionner(state, distant);
  ecrireLocal();
  rendre();
  etatSync(snap.metadata && snap.metadata.fromCache ? "cache local" : "à jour");
  const charge = JSON.stringify(state);
  if (charge !== JSON.stringify(distant)) {
    dernierEcrit = null;
    clearTimeout(minuterieSync);
    minuterieSync = setTimeout(pousser, 600);
  } else {
    dernierEcrit = charge;
  }
}

function etatSync(txt) { $("etat-sync").textContent = "Synchro : " + txt; }

function avis(message, erreur) {
  const d = document.createElement("div");
  d.className = "banner" + (erreur ? " err" : "");
  d.textContent = message;
  $("banners").appendChild(d);
  setTimeout(() => d.remove(), 12000);
}

/* ═══════════════════════════  opérations  ══════════════════════════════ */

function ajouterPiste(d) {
  state.pistes.push({
    id: nouvelId(), source: "facebook", groupe: "", ville: "", type: "autre",
    lien: "", statut: "repere", note: "", mandat: mandatCourant,
    cree: maintenant(), ...d,
    maj: maintenant(),
  });
  enregistrer();
}

function majPiste(id, d) {
  const p = state.pistes.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, d, { maj: maintenant() });
  enregistrer();
}

function supprimerPiste(id) {
  state.pistes = state.pistes.filter((p) => p.id !== id);
  state.tombstones[id] = maintenant();
  enregistrer();
}

function ajouterGroupe(nom, ville) {
  if (!nom.trim()) return;
  state.groupes.push({
    id: nouvelId(), nom: nom.trim(), ville, mandat: mandatCourant,
    cree: maintenant(), maj: maintenant(),
  });
  enregistrer();
}

function supprimerGroupe(id) {
  state.groupes = state.groupes.filter((g) => g.id !== id);
  state.tombstones[id] = maintenant();
  enregistrer();
}

/*
 * Purge Loi 25. Une occasion ratée il y a trois mois n'a plus de valeur, et la
 * garder n'a que des inconvénients. On ne touche jamais aux pistes devenues
 * clients : celles-là sont une relation d'affaires, pas une veille.
 */
function pistesAPurger() {
  const limite = maintenant() - PURGE_APRES;
  return state.pistes.filter((p) => p.statut !== "client" && p.cree < limite);
}

function purger() {
  const cibles = pistesAPurger();
  if (!cibles.length) return;
  if (!confirm(`Effacer ${cibles.length} piste(s) non converties de plus de 90 jours ?\n\n` +
               `C'est la purge prévue : on ne conserve pas les renseignements ` +
               `personnels de gens qui ne sont jamais devenus clients.\n\n` +
               `Elle porte sur TOUS les mandats, pas seulement celui affiché : ` +
               `une obligation de conservation ne dépend pas de l'onglet ouvert.`)) return;
  const ids = new Set(cibles.map((p) => p.id));
  state.pistes = state.pistes.filter((p) => !ids.has(p.id));
  for (const id of ids) state.tombstones[id] = maintenant();
  enregistrer();
  avis(`${ids.size} piste(s) effacée(s).`);
}

/* ═══════════════════════════  calculs  ═════════════════════════════════ */

function age(p) { return maintenant() - (p.cree || 0); }

function chaleur(p) {
  const a = age(p);
  if (a < CHAUD) return { cl: "chaud", txt: "à répondre maintenant" };
  if (a < TIEDE) return { cl: "tiede", txt: "refroidit" };
  return { cl: "froid", txt: "froide — répondre quand même, brièvement" };
}

function duree(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " h";
  return Math.floor(h / 24) + " j";
}

function relanceDue(p) {
  if (CLOS.includes(p.statut) || p.statut === "repere") return false;
  return maintenant() - (p.maj || 0) > RELANCE_APRES;
}

function aAbandonner(p) {
  if (CLOS.includes(p.statut) || p.statut === "repere") return false;
  return maintenant() - (p.maj || 0) > PERDU_APRES;
}

/*
 * Rendement d'un groupe. Le chiffre qui compte n'est pas le nombre de pistes
 * repérées — c'est le nombre qui a produit un échange. Un groupe très actif
 * dont personne ne répond jamais coûte du temps sans rien rendre.
 */
function rendementGroupes() {
  const parNom = new Map();
  for (const g of state.groupes.filter(duMandat)) {
    parNom.set(g.nom, { nom: g.nom, ville: g.ville, cree: g.cree, id: g.id,
                        repere: 0, acquis: 0, clients: 0 });
  }
  for (const p of state.pistes.filter(duMandat)) {
    if (!p.groupe) continue;
    if (!parNom.has(p.groupe)) {
      parNom.set(p.groupe, { nom: p.groupe, ville: "", cree: p.cree, id: null,
                             repere: 0, acquis: 0, clients: 0 });
    }
    const r = parNom.get(p.groupe);
    r.repere++;
    if (ACQUIS.includes(p.statut)) r.acquis++;
    if (p.statut === "client") r.clients++;
  }
  return [...parNom.values()].sort((a, b) => b.acquis - a.acquis || b.repere - a.repere);
}

/* ═══════════════════════════  rendu  ═══════════════════════════════════ */

function rendre() {
  rendreSelecteur("f-mandat", lireMandats(), mandatCourant,
    (v) => { mandatCourant = v; rendre(); });
  rendreEntonnoir();
  rendreUrgent();
  rendreEnCours();
  rendreGroupes();
  remplirListes();
}

function rendreEntonnoir() {
  const depuis = maintenant() - 4 * SEMAINE;
  const recentes = state.pistes.filter(duMandat).filter((p) => p.cree >= depuis);
  const n = (f) => recentes.filter(f).length;
  const repere = recentes.length;
  const repondu = n((p) => p.statut !== "repere" && p.statut !== "hors_zone");
  const acquis = n((p) => ACQUIS.includes(p.statut));
  const clients = n((p) => p.statut === "client");
  const taux = (a, b) => (b ? Math.round((a / b) * 100) + " %" : "—");

  $("e-repere").textContent = repere;
  $("e-repondu").textContent = repondu;
  $("e-acquis").textContent = acquis;
  $("e-clients").textContent = clients;
  $("e-t1").textContent = taux(repondu, repere);
  $("e-t2").textContent = taux(acquis, repondu);
  $("e-t3").textContent = taux(clients, acquis);

  const aPurger = pistesAPurger().length;
  $("btn-purge").hidden = !aPurger;
  $("btn-purge").textContent = `Purger ${aPurger} piste(s) de plus de 90 jours`;
}

function rendreUrgent() {
  const liste = state.pistes
    .filter(duMandat)
    .filter((p) => p.statut === "repere")
    .sort((a, b) => a.cree - b.cree);
  $("u-compte").textContent = liste.length;
  $("u-vide").hidden = liste.length > 0;
  $("u-liste").innerHTML = liste.map((p) => {
    const c = chaleur(p);
    return `<div class="v-carte ${c.cl}" data-id="${p.id}">
      <div class="v-haut">
        <span class="v-age">${duree(age(p))}</span>
        <span class="v-etat">${c.txt}</span>
      </div>
      <div class="v-quoi">${ech(TYPES[p.type])} · ${ech(p.ville || "ville ?")}</div>
      <div class="v-ou mono">${ech(p.groupe || SOURCES[p.source])}</div>
      ${p.note ? `<div class="v-note">${ech(p.note)}</div>` : ""}
      <div class="v-actions">
        ${p.lien ? `<a class="btn btn-ghost" href="${ech(p.lien)}" target="_blank" rel="noopener">Ouvrir</a>` : ""}
        <button class="btn" data-act="repondu">J'ai répondu</button>
        <button class="btn btn-ghost" data-act="hors_zone">Hors zone</button>
        <button class="btn btn-ghost" data-act="suppr">×</button>
      </div>
    </div>`;
  }).join("");
}

function rendreEnCours() {
  const liste = state.pistes
    .filter(duMandat)
    .filter((p) => !CLOS.includes(p.statut) && p.statut !== "repere")
    .filter((p) => !filtreStatut || p.statut === filtreStatut)
    .sort((a, b) => a.maj - b.maj);
  $("c-vide").hidden = liste.length > 0;
  $("c-liste").innerHTML = liste.map((p) => {
    const due = relanceDue(p), mort = aAbandonner(p);
    const options = Object.entries(STATUTS)
      .map(([k, v]) => `<option value="${k}"${k === p.statut ? " selected" : ""}>${v}</option>`)
      .join("");
    return `<div class="v-carte ${mort ? "froid" : due ? "tiede" : ""}" data-id="${p.id}">
      <div class="v-haut">
        <span class="v-age">sans nouvelle depuis ${duree(maintenant() - p.maj)}</span>
        ${mort ? `<span class="v-etat">à classer perdue</span>`
               : due ? `<span class="v-etat">relance due</span>` : ""}
      </div>
      <div class="v-quoi">${ech(TYPES[p.type])} · ${ech(p.ville || "ville ?")}</div>
      <div class="v-ou mono">${ech(p.groupe || SOURCES[p.source])}</div>
      <div class="v-actions">
        ${p.lien ? `<a class="btn btn-ghost" href="${ech(p.lien)}" target="_blank" rel="noopener">Ouvrir</a>` : ""}
        <select class="champ v-statut">${options}</select>
        <button class="btn btn-ghost" data-act="suppr">×</button>
      </div>
    </div>`;
  }).join("");
}

function rendreGroupes() {
  const r = rendementGroupes();
  $("g-vide").hidden = r.length > 0;
  $("g-liste").innerHTML = r.map((g) => {
    // Six semaines sans un seul échange : le groupe coûte du temps et ne rend
    // rien. On le signale plutôt que de laisser la veille s'alourdir.
    const vieux = g.cree && maintenant() - g.cree > 6 * SEMAINE;
    const strile = vieux && g.acquis === 0;
    return `<tr class="${strile ? "sterile" : ""}" data-id="${g.id || ""}">
      <td>${ech(g.nom)}${strile ? ` <span class="v-etat">à quitter</span>` : ""}</td>
      <td class="mono">${ech(g.ville || "—")}</td>
      <td class="mono">${g.repere}</td>
      <td class="mono">${g.acquis}</td>
      <td class="mono">${g.clients}</td>
      <td>${g.id ? `<button class="btn btn-ghost" data-act="suppr-groupe">×</button>` : ""}</td>
    </tr>`;
  }).join("");
}

function remplirListes() {
  const noms = [...new Set(state.groupes.filter(duMandat).map((g) => g.nom))].sort();
  $("l-groupes").innerHTML = noms.map((n) => `<option value="${ech(n)}">`).join("");
}

/* ═══════════════════════════  événements  ══════════════════════════════ */

$("f-piste").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const lien = $("p-lien").value.trim();
  const ville = $("p-ville").value;
  const type = $("p-type").value;
  const groupe = $("p-groupe").value.trim();
  const note = $("p-note").value.trim();
  const source = $("p-source").value;
  if (!lien && !groupe && !note) {
    avis("Il faut au moins un lien, un groupe ou une note.", true);
    return;
  }
  ajouterPiste({ lien, ville, type, groupe, note, source,
                 statut: ville === "Hors corridor" ? "hors_zone" : "repere" });
  $("p-lien").value = "";
  $("p-note").value = "";
  $("p-lien").focus();
});

// Les deux listes de pistes partagent la même mécanique de boutons.
for (const zone of ["u-liste", "c-liste"]) {
  $(zone).addEventListener("click", (ev) => {
    const bouton = ev.target.closest("[data-act]");
    if (!bouton) return;
    const id = ev.target.closest("[data-id]").dataset.id;
    const act = bouton.dataset.act;
    if (act === "suppr") {
      if (confirm("Effacer cette piste ?")) supprimerPiste(id);
    } else {
      majPiste(id, { statut: act });
    }
  });
  $(zone).addEventListener("change", (ev) => {
    if (!ev.target.classList.contains("v-statut")) return;
    majPiste(ev.target.closest("[data-id]").dataset.id, { statut: ev.target.value });
  });
}

$("f-groupe").addEventListener("submit", (ev) => {
  ev.preventDefault();
  ajouterGroupe($("g-nom").value, $("g-ville").value);
  $("g-nom").value = "";
  $("g-nom").focus();
});

$("g-liste").addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-act='suppr-groupe']")) return;
  const id = ev.target.closest("[data-id]").dataset.id;
  if (id && confirm("Retirer ce groupe du suivi ? Les pistes déjà consignées restent.")) {
    supprimerGroupe(id);
  }
});

$("f-statut").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-statut]");
  if (!b) return;
  filtreStatut = b.dataset.statut;
  for (const x of $("f-statut").querySelectorAll("button")) x.classList.toggle("on", x === b);
  rendreEnCours();
});

$("btn-purge").addEventListener("click", purger);

// L'âge des pistes est la donnée qui bouge toute seule : on rafraîchit sans
// attendre une action, sinon « à répondre maintenant » ment au bout d'une heure.
setInterval(() => { if (!$("app").hidden) { rendreUrgent(); rendreEnCours(); } }, 60000);

/* ═══════════════════════════  authentification  ════════════════════════ */

const provider = new OAuthProvider("microsoft.com");
provider.setCustomParameters({ tenant: MICROSOFT_TENANT_ID });

$("btn-login").addEventListener("click", () => {
  $("auth-error").hidden = true;
  signInWithPopup(auth, provider).catch((e) => {
    $("auth-error").textContent = "Connexion échouée : " + e.message;
    $("auth-error").hidden = false;
  });
});

$("btn-logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (desabonner) { desabonner(); desabonner = null; }
  if (!user) {
    userDocRef = null;
    uidCourant = null;
    dernierEcrit = null;
    $("auth-gate").hidden = false;
    $("app").hidden = true;
    $("btn-logout").hidden = true;
    $("qui").hidden = true;
    return;
  }
  uidCourant = user.uid;
  userDocRef = doc(db, "users", user.uid, "marketing", "veille");
  $("auth-gate").hidden = true;
  $("app").hidden = false;
  $("btn-logout").hidden = false;
  $("qui").textContent = user.email || user.displayName || "connecté";
  $("qui").hidden = false;
  lireLocal();
  rendre();
  etatSync("lecture…");
  desabonner = onSnapshot(userDocRef, appliquerInstantane, (e) => {
    etatSync("lecture refusée");
    avis("Lecture Firestore refusée : " + e.message, true);
  });
});

// Remplissage des menus à l'ouverture — une seule source de vérité, les
// constantes du haut du fichier.
for (const [sel, entrees] of [
  ["p-ville", VILLES.map((v) => [v, v])],
  ["g-ville", VILLES.map((v) => [v, v])],
  ["p-type", Object.entries(TYPES)],
  ["p-source", Object.entries(SOURCES)],
]) {
  $(sel).innerHTML = entrees.map(([k, v]) => `<option value="${ech(k)}">${ech(v)}</option>`).join("");
}
$("p-type").value = "pc_lent";
lireLocal();
rendre();
