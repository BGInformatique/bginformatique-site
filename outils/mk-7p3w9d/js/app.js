/*
 * Tableau de bord marketing — BG Informatique
 * https://bginformatique.ca/outils/mk-7p3w9d/
 *
 * Outil interne de BG Informatique. Il sert à piloter plusieurs mandats à la
 * fois : chaque tâche porte un client, et les compteurs se filtrent en
 * conséquence. Aucun nom de mandat n'est écrit dans ce fichier — le dépôt est
 * public et déployé tel quel ; les mandats naissent des tâches saisies.
 *
 * Architecture reprise de TimeCalculator (outils/tc-9x2k7m) :
 *   - page cachée du site, non listée et en noindex ;
 *   - connexion Microsoft (Entra ID, locataire unique) via Firebase Auth ;
 *   - données dans Firestore, users/<uid>/marketing/state ;
 *   - miroir localStorage pour l'affichage instantané et le hors-ligne ;
 *   - fusion par enregistrement, pour que deux appareils ne s'écrasent pas.
 *
 * Règles Firestore : outils/tc-9x2k7m/firestore.rules (fichier de référence
 * pour tout le projet « bgtimecalculator »), bloc « MARKETING ».
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
  collection,
  query,
  orderBy,
  limit,
  setDoc,
  onSnapshot,
  arrayUnion,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";
import {
  lireMandat, ecrireMandat, rendreSelecteur, surChangementDeMandat,
  noterMandatExterne, noterMandats, appartientAuMandat,
} from "./mandat.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const CLE = "marketing.v1";
const CLE_MINUTEUR = "marketing.v1.minuteur";
const CLE_QUARANTAINE = "marketing.v1.illisible.";
const CLE_AVANT_IMPORT = "marketing.v1.avant-import";

const RETENTION_TOMBSTONE = 90 * 24 * 3600 * 1000;

// Aucun nom de client n'est écrit ici : le dépôt est public et déployé tel quel.
// Les mandats naissent des tâches saisies, et celui dont le temps compte en STME
// est un réglage rangé dans le document Firestore de l'utilisateur — privé.

const LIB_STATUT = {
  a_faire: "À faire", en_cours: "En cours", bloque: "Bloquée",
  fait: "Faite", reporte: "Reportée",
};
const RANG_PRIO = { haute: 0, moyenne: 1, basse: 2 };
const RANG_STAT = { en_cours: 0, bloque: 1, a_faire: 2, reporte: 3, fait: 4 };

// Lancements Claude : documents lancement-* de la même sous-collection,
// traités sur BG001 par Claude_Lanceur/lanceur.py (hors dépôt). L'outil web
// n'écrit que la demande ; le lanceur écrit la progression et le résultat.
// « attente_autorisation » : la tâche a buté sur un geste que seul le
// propriétaire peut autoriser (connexion, publication, dépense, décision de
// fond). Elle a livré ce qu'elle a préparé et attend une réponse donnée sur
// BG001 (Claude_Lanceur/autorisations.py) ; accorder la remet en file.
const LIB_LANCEMENT = {
  demande: "Claude · demandé", en_cours: "Claude · en cours…",
  attente_autorisation: "Claude · ton accord", refuse: "Claude · refusé",
  fait: "Claude · fait", echec: "Claude · échec", annule: "Claude · annulé",
};

const $ = (id) => document.getElementById(id);
const ech = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const maintenant = () => Date.now();
const jourISO = (d = new Date()) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
};
const nouvelId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/* ═══════════════════════════════  état  ═══════════════════════════════ */

const VIDE = () => ({ taches: [], temps: [], tombstones: {}, config: { mandatStme: "", debutPlan: "" }, updatedAt: 0 });
let state = VIDE();
let userDocRef = null;
let dernierEcrit = null;
/*
 * Le mandat n'est pas un filtre comme les autres : c'est le contexte de travail.
 * Il vit donc en haut de la page, avec le titre, et il SURVIT au rechargement.
 * Sans ça, chaque ouverture ramenait « tous les mandats » — les deux chantiers
 * mélangés dans une seule liste, ce qui n'est le bon écran pour personne.
 *
 * Il commande aussi le mandat par défaut des nouvelles tâches (voir
 * clientParDefaut) : travailler sous un mandat et saisir sous l'autre serait
 * une erreur silencieuse, et elle se répare une tâche à la fois.
 */
let filtreClient = lireMandat(), filtreChantier = "", filtreStatut = "actives", filtreTexte = "";
let pageInv = 0;   // lot courant de l'inventaire de prospection (20 par lot)
let montrerRetires = false;  // les prospects retirés d'un « × » sont cachés
let lotCourriel = "";        // batch affiché dans les courriels préparés
const fichesOuvertes = new Set();   // fiches contact dépliées — survit aux re-rendus
const ouvertes = new Set();

// Un autre onglet a changé de mandat : on suit, sinon deux onglets affichent
// deux mandats en croyant tous les deux montrer « le » mandat courant.
surChangementDeMandat((v) => { filtreClient = v; rendre(); });

// Dernier lancement Claude par tâche (idTache -> doc lancement-*).
let uidCourant = null;
let lancements = new Map();

// Volet Prospection : miroir du journal tenu par le prospecteur sur BG001
// (document marketing/prospection). La page le lit, et peut y déposer un
// « signal » (répondu, RDV fixé…) que le prospecteur applique au journal
// TSV au cycle suivant. Les brouillons de relance, eux, sont des tâches.
let prospection = null;
// Miroir des courriels de prospection préparés, publié par la passerelle
// courriels_msi.py de BG001. La page ne connaît que des numéros de fiche :
// le texte, le destinataire et l'identité d'envoi restent sur la machine.
let courrielsMsi = null;

const LIB_PROSP = {
  a_contacter: "À contacter", contact_prepare: "1er contact prêt",
  contacte_sans_reponse: "Sans réponse", relance_preparee: "Relance prête",
  relance_envoyee: "Relance envoyée", repondu: "A répondu",
  rdv_fixe: "RDV fixé", dormant: "Dormant", injoignable: "Injoignable",
  client: "Client", abandonne: "Abandonné",
};

/* ── plan « Entonnoir 24 » (décisions 31-33) ─────────────────────────────
   La semaine ISO clef des compteurs de gestes, et la phase courante du plan
   — des dates du plan, pas des réglages. */
function semaineISO(d = new Date()) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const j = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - j);
  const an = x.getUTCFullYear();
  const s = Math.ceil(((x - Date.UTC(an, 0, 1)) / 86400000 + 1) / 7);
  return `${an}-S${String(s).padStart(2, "0")}`;
}

function phaseCourante() {
  const a = jourISO();
  if (a <= "2026-08-16") return "Phase 0 — armement · les 12 envois partent le vendredi 14 · sprint lundi 17";
  if (a <= "2026-10-02") return "Sprint de couverture — 12-15 nouveaux/sem · 3 blocs d'appels · alerte < 20 gestes/sem";
  if (a <= "2026-10-30") return "Fenêtre de closing — RDV sous 48 h · soumission sous 48 h · intervention sous 7 jours";
  return "Croisière — 8 nouveaux/sem · 2 blocs d'appels";
}

function normaliser(brut) {
  const s = VIDE();
  if (!brut || typeof brut !== "object") return s;
  s.taches = Array.isArray(brut.taches) ? brut.taches.filter((t) => t && t.id) : [];
  s.temps = Array.isArray(brut.temps) ? brut.temps.filter((e) => e && e.id) : [];
  s.tombstones = brut.tombstones && typeof brut.tombstones === "object" ? brut.tombstones : {};
  // Le champ date ne produit que l'ISO ou vide ; un import peut apporter autre chose.
  const debutBrut = (brut.config && brut.config.debutPlan) || "";
  s.config = {
    mandatStme: (brut.config && brut.config.mandatStme) || "",
    debutPlan: /^\d{4}-\d{2}-\d{2}$/.test(debutBrut) ? debutBrut : "",
  };
  s.updatedAt = Number(brut.updatedAt) || 0;
  for (const t of s.taches) {
    t.maj = Number(t.maj) || 0;
    t.statut = LIB_STATUT[t.statut] ? t.statut : "a_faire";
    t.priorite = RANG_PRIO[t.priorite] !== undefined ? t.priorite : "moyenne";
    t.client = t.client || "";
  }
  for (const e of s.temps) {
    e.maj = Number(e.maj) || 0;
    e.minutes = Math.max(0, Math.round(Number(e.minutes) || 0));
  }
  return s;
}

function lireLocal() {
  let brut = null;
  try {
    brut = localStorage.getItem(CLE);
  } catch { return VIDE(); }
  if (!brut) return VIDE();
  try {
    return normaliser(JSON.parse(brut));
  } catch {
    // Une chaîne illisible est mise de côté, jamais écrasée : elle reste récupérable.
    try { localStorage.setItem(CLE_QUARANTAINE + Date.now(), brut); } catch {}
    avis("Les données locales étaient illisibles. Elles ont été mises de côté ; " +
         "la version infonuagique fait foi.", true);
    return VIDE();
  }
}

function ecrireLocal() {
  try { localStorage.setItem(CLE, JSON.stringify(state)); } catch {}
}

/* ═══════════════════════════  fusion multi-appareils  ═══════════════════ */

function elaguer(tombstones) {
  const limite = maintenant() - RETENTION_TOMBSTONE;
  const out = {};
  for (const [id, ts] of Object.entries(tombstones)) if (ts > limite) out[id] = ts;
  return out;
}

/*
 * Deux appareils modifient la même liste sans se voir. On ne compare donc pas
 * les documents entiers — on compare enregistrement par enregistrement, et le
 * plus récemment modifié gagne. Une suppression laisse une pierre tombale,
 * sinon l'autre appareil, qui a encore l'enregistrement, le ressusciterait à
 * la prochaine synchro.
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
  // Les réglages ne sont pas une liste : pas de fusion par enregistrement
  // possible. On prend ceux du côté le plus récemment enregistré, et on retombe
  // sur l'autre s'il est vide — un réglage existant ne doit pas être effacé par
  // un appareil qui n'en a jamais eu.
  const recent = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
  const autre = recent === a ? b : a;
  const config = {
    mandatStme: (recent.config && recent.config.mandatStme) ||
                (autre.config && autre.config.mandatStme) || "",
    debutPlan: (recent.config && recent.config.debutPlan) ||
               (autre.config && autre.config.debutPlan) || "",
  };

  return {
    taches: fusionListe(a.taches, b.taches),
    temps: fusionListe(a.temps, b.temps),
    tombstones: elaguer(tombstones),
    config,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };
}

/* ═══════════════════════════  synchronisation  ═════════════════════════ */

let minuterieSync = null;

function enregistrer() {
  state.updatedAt = maintenant();
  ecrireLocal();
  rendre();
  planifierSync();
}

function planifierSync() {
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
      avis("Synchronisation infonuagique en attente : " + e.message, true);
    });
}

/*
 * Réception d'un instantané Firestore.
 *
 * Le piège, hérité de TimeCalculator : hors ligne ou avant la première réponse
 * du serveur, Firestore livre un instantané venu du CACHE où le document paraît
 * inexistant. Amorcer le document à partir de là écrirait un état vide par-dessus
 * les vraies données. On n'amorce donc jamais depuis un instantané de cache.
 */
function appliquerInstantane(snap) {
  if (!snap.exists()) {
    if (snap.metadata && snap.metadata.fromCache) return;
    if (state.taches.length || state.temps.length) pousser();
    else etatSync("aucune donnée — importer pour commencer");
    return;
  }
  const distant = normaliser(snap.data());
  state = fusionner(state, distant);
  ecrireLocal();
  rendre();
  etatSync(snap.metadata && snap.metadata.fromCache ? "cache local" : "à jour");
  // Si la fusion a produit autre chose que le document distant, on le remonte.
  const charge = JSON.stringify(state);
  if (charge !== JSON.stringify(distant)) {
    dernierEcrit = null;
    planifierSync();
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

function enregistrerTache(d) {
  if (d.id) {
    const t = state.taches.find((x) => x.id === d.id);
    if (!t) return;
    Object.assign(t, d, { maj: maintenant() });
  } else {
    state.taches.push({
      id: nouvelId(), titre: "", detail: "", client: clientParDefaut(), chantier: "Pilotage",
      stme: "", priorite: "moyenne", statut: "a_faire", echeance: "", estimeMin: "",
      jour: "", source: "", cree: maintenant(), ...d, maj: maintenant(),
    });
  }
  enregistrer();
}

function lancerClaude(t) {
  if (!uidCourant) return;
  const l = lancements.get(t.id);
  // Activation accidentelle : le même bouton annule le lancement actif. Le
  // lanceur de BG001 interrompt alors le processus s'il est déjà parti.
  if (l && l.docId && (l.statut === "demande" || l.statut === "en_cours")) {
    if (!confirm(`Annuler le lancement Claude pour « ${t.titre} » ?`)) return;
    setDoc(doc(db, "users", uidCourant, "marketing", l.docId),
      { statut: "annule", maj: maintenant() }, { merge: true })
      .catch((e) => avis("Annulation refusée : " + e.message, true));
    return;
  }
  if (!confirm(`Lancer Claude sur BG001 pour « ${t.titre} » ?\n\n` +
               "La tâche s'exécutera sans intervention ; le résultat s'affichera ici.")) return;
  const nom = `lancement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setDoc(doc(db, "users", uidCourant, "marketing", nom), {
    idTache: t.id, titre: t.titre || "", detail: t.detail || "",
    client: t.client || "", chantier: t.chantier || "",
    statut: "demande", demandeLe: maintenant(), maj: maintenant(),
  }).catch((e) => avis("Lancement refusé : " + e.message, true));
}

/* Répondre à une réponse rendue. On ne crée pas un nouveau lancement : on
   renvoie le MÊME document au lanceur avec la correction et la réponse
   précédente, pour que la tâche reprenne son travail au lieu de le refaire.
   Les corrections successives sont empilées côté lanceur. */
function corrigerClaude(t, lc) {
  if (!uidCourant || !lc || !lc.docId) return;
  const remarque = prompt(`Qu'est-ce qui doit changer dans la réponse de Claude ?\n\n` +
                          `« ${t.titre} »`, "");
  if (remarque === null) return;
  const texte = remarque.trim();
  if (!texte) {
    avis("Correction vide — rien n'a été renvoyé.", true);
    return;
  }
  const ts = maintenant();
  setDoc(doc(db, "users", uidCourant, "marketing", lc.docId), {
    correction: texte,
    resultatPrecedent: (lc.resultat || lc.erreur || "").slice(0, 20000),
    correctionLe: ts, statut: "demande", demandeLe: ts, maj: ts,
    resultat: "", erreur: "",
  }, { merge: true })
    .then(() => avis("Correction envoyée — la tâche repart avec ta remarque."))
    .catch((e) => avis("Correction refusée : " + e.message, true));
}

function supprimerTache(id) {
  state.taches = state.taches.filter((t) => t.id !== id);
  const rattaches = state.temps.filter((e) => e.idTache === id).map((e) => e.id);
  state.temps = state.temps.filter((e) => e.idTache !== id);
  const ts = maintenant();
  for (const x of [id, ...rattaches]) state.tombstones[x] = ts;
  enregistrer();
}

function ajouterTemps(idTache, minutes, note) {
  minutes = Math.round(Number(minutes) || 0);
  if (minutes <= 0) return;
  state.temps.push({
    id: nouvelId(), date: jourISO(), idTache,
    minutes, note: note || "", maj: maintenant(),
  });
  enregistrer();
}

function supprimerTemps(id) {
  state.temps = state.temps.filter((e) => e.id !== id);
  state.tombstones[id] = maintenant();
  enregistrer();
}

/* ═══════════════════════════  minuteur  ════════════════════════════════ */

function minuteur() {
  try { return JSON.parse(localStorage.getItem(CLE_MINUTEUR)) || null; }
  catch { return null; }
}

function demarrer(id) {
  if (minuteur()) arreter(true);
  try { localStorage.setItem(CLE_MINUTEUR, JSON.stringify({ id, debut: Date.now() })); } catch {}
  const t = state.taches.find((x) => x.id === id);
  if (t && t.statut === "a_faire") enregistrerTache({ id, statut: "en_cours" });
  else rendre();
}

function arreter(silencieux) {
  const m = minuteur();
  try { localStorage.removeItem(CLE_MINUTEUR); } catch {}
  if (!m) return;
  const minutes = Math.round((Date.now() - m.debut) / 60000);
  if (minutes >= 1) ajouterTemps(m.id, minutes, "minuteur");
  else if (!silencieux) rendre();
}

/* ═══════════════════════════  calculs  ═════════════════════════════════ */

const somme = (l) => l.reduce((s, e) => s + (e.minutes || 0), 0);

function fmt(m) {
  if (!m) return "0";
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return r + " min";
  return r ? `${h} h ${String(r).padStart(2, "0")}` : `${h} h`;
}

const tacheDe = (idTache) => state.taches.find((t) => t.id === idTache);

const trier = (a, b) =>
  (RANG_STAT[a.statut] ?? 9) - (RANG_STAT[b.statut] ?? 9) ||
  (RANG_PRIO[a.priorite] ?? 9) - (RANG_PRIO[b.priorite] ?? 9) ||
  (a.echeance || "9999").localeCompare(b.echeance || "9999") ||
  (a.titre || "").localeCompare(b.titre || "");

/* ═══════════════════════════  rendu  ═══════════════════════════════════ */

/* Une tâche lancée peut s'être arrêtée pour demander un accord : elle a livré
   ce qu'elle pouvait et attend une réponse donnée sur le poste. La question
   reste lisible carte fermée — c'est une question posée au propriétaire, pas
   une trace à dépiler comme un résultat. */
function blocAutorisation(lc) {
  if (!lc || lc.statut !== "attente_autorisation" || !lc.autorisationDemande) return "";
  const categorie = lc.autorisationCategorie ? " · " + ech(lc.autorisationCategorie) : "";
  const options = lc.autorisationOptions
    ? '<div class="cl-note">Options : ' + ech(lc.autorisationOptions) + "</div>" : "";
  // Le texte à coller voyage avec la demande, jamais en fichier : le geste se
  // fait souvent depuis le téléphone, où aucun chemin de fichier ne sert.
  const ouQuand = (lc.autorisationOu || lc.autorisationQuand)
    ? '<div class="cl-note">' +
      (lc.autorisationOu ? "Où : " + ech(lc.autorisationOu) : "") +
      (lc.autorisationQuand ? "<br>Quand : " + ech(lc.autorisationQuand) : "") +
      "</div>" : "";
  const aColler = lc.autorisationTexte
    ? '<div class="cl-note">Texte à coller — tel quel, rien à y ajouter :</div>' +
      '<pre class="cl-coller">' + ech(lc.autorisationTexte) + "</pre>" : "";
  // La marche à suivre s'adresse à quelqu'un qui n'a pas suivi le travail et
  // qui la lit peut-être des jours plus tard, du téléphone : elle doit se
  // suffire. Son absence s'affiche, plutôt que de laisser deviner les étapes.
  const brins = (lc.autorisationEtapes || "").split("|")
    .map(function (e) { return e.trim(); }).filter(Boolean);
  const etapes = brins.length
    ? '<div class="cl-note">Comment faire :</div><ol class="cl-etapes">' +
      brins.map(function (e) { return "<li>" + ech(e) + "</li>"; }).join("") + "</ol>"
    : '<div class="cl-note cl-manque">⚠️ Aucune marche à suivre fournie — ' +
      "ne devine pas, redemande-la avec <code>autorisations.py corriger</code></div>";
  const verif = lc.autorisationVerif
    ? '<div class="cl-note">Réussi quand : ' + ech(lc.autorisationVerif) + "</div>" : "";
  const siRate = lc.autorisationSiRate
    ? '<div class="cl-note">Si ça rate : ' + ech(lc.autorisationSiRate) + "</div>" : "";
  const ref = ech(String(lc.docId || "").slice(-6));
  return '<div class="cl-autor">' +
    '<div class="cl-entete">// Claude attend ton accord' + categorie + "</div>" +
    ech(lc.autorisationDemande) + options + ouQuand + etapes + aColler + verif + siRate +
    '<div class="cl-note">Réponse à donner sur le poste : ' +
    "<code>autorisations.py accorder " + ref + "</code></div></div>";
}

function carte(t, contexte) {
  const m = minuteur(), actif = m && m.id === t.id;
  const auj = jourISO();
  const total = somme(state.temps.filter((e) => e.idTache === t.id));
  const dujour = somme(state.temps.filter((e) => e.idTache === t.id && e.date === auj));
  const epingle = t.jour === "manuel";
  const retard = t.echeance && t.echeance < auj && t.statut !== "fait";

  const pil = [`<span class="pil ${t.statut}">${LIB_STATUT[t.statut]}</span>`];
  if (!filtreClient && t.client) pil.push(`<span class="pil client">${ech(t.client)}</span>`);
  if (t.chantier) pil.push(`<span class="pil">${ech(t.chantier)}</span>`);
  if (t.stme) pil.push(`<span class="pil">STME ${ech(t.stme)}</span>`);
  if (t.echeance) pil.push(`<span class="pil ${retard ? "retard" : ""}">${retard ? "En retard · " : ""}${ech(t.echeance)}</span>`);
  if (total) pil.push(`<span class="pil temps">${fmt(total)} consigné${dujour ? ` · ${fmt(dujour)} aujourd'hui` : ""}</span>`);
  else if (t.estimeMin) pil.push(`<span class="pil temps">estimé ${fmt(Number(t.estimeMin))}</span>`);

  const lc = lancements.get(t.id);
  if (lc && LIB_LANCEMENT[lc.statut]) {
    pil.push(`<span class="pil claude ${ech(lc.statut)}">${LIB_LANCEMENT[lc.statut]}</span>`);
  }
  // Une demande qui attend un accord reste vivante : le bouton éclair sert
  // alors à abandonner le lancement, jamais à en ouvrir un second par-dessus.
  // (Sans apostrophe : le contrôle des constantes lit ce commentaire comme du
  // texte de gabarit, et un nombre impair décale sa lecture du fichier.)
  const lcOccupe = lc && (lc.statut === "demande" || lc.statut === "en_cours" ||
                          lc.statut === "attente_autorisation");
  // Une réponse rendue se discute : le bouton retour renvoie la tâche au
  // lanceur avec ce que le propriétaire veut voir changer.
  const lcRendu = lc && (lc.statut === "fait" || lc.statut === "echec");

  // Calculé AVANT le gabarit de la carte, jamais dedans : un gabarit imbriqué
  // dans un ${…} inverse la lecture du contrôle des constantes
  // (tests/constantes.py) — voir le même choix pour rendreProspection().
  const outilCourriel = t.statut === "fait" || !brouillonDe(t) ? "" :
    ((prospection && prospection.demandesCourriel || {})[t.id]
      ? `<span class="ic" title="Ouverture sur BG001…">…</span>`
      : `<button class="ic ic-mail" data-ecrire title="Ouvrir un courriel avec le brouillon, sur BG001">✉</button>`) +
    `<button class="ic" data-copier-brouillon title="Copier le brouillon (pour LinkedIn ou ailleurs)">⧉</button>`;

  const el = document.createElement("div");
  el.className = "carte" + (t.statut === "fait" ? " fait" : "") +
    (actif ? " actif" : "") + (ouvertes.has(t.id) ? " ouvert" : "");
  el.innerHTML = `
    <div class="prio ${ech(t.priorite)}"></div>
    <div class="corps">
      <div class="titre-t" data-bascule>${ech(t.titre)}</div>
      ${t.detail ? `<div class="detail">${ech(t.detail)}</div>` : ""}
      ${t.source ? `<div class="source">// ${ech(t.source)}</div>` : ""}
      ${blocAutorisation(lc)}
      ${lc && (lc.resultat || lc.erreur) ? `<div class="cl-resultat${lc.erreur ? " err" : ""}">
        <div class="cl-entete">// Claude — ${lc.erreur ? "échec" : "résultat"}${lc.finiLe ? " · " + ech(new Date(lc.finiLe).toLocaleString("fr-CA")) : ""}</div>
        ${ech(lc.erreur || lc.resultat)}</div>` : ""}
      <div class="etiq">${pil.join("")}</div>
    </div>
    <div class="outils">
      ${outilCourriel}
      <button class="ic ${t.statut === "fait" ? "on" : ""}" data-fait title="${t.statut === "fait" ? "Remettre à faire" : "Marquer faite"}">
        <svg><use href="#i-coche"></use></svg></button>
      <button class="ic ${actif ? "on" : ""}" data-chrono title="${actif ? "Arrêter le minuteur" : "Démarrer le minuteur"}">
        <svg><use href="#${actif ? "i-stop" : "i-lire"}"></use></svg></button>
      <button class="ic ${lcOccupe ? "on" : ""}" data-claude title="${t.chantier === "LinkedIn"
        ? "Ouvrir la page du lot LinkedIn (tous les posts)"
        : lcOccupe ? "Annuler le lancement Claude en cours" : "Lancer cette tâche avec Claude sur BG001"}">
        <svg><use href="#i-eclair"></use></svg></button>
      ${lcRendu ? `<button class="ic" data-corriger title="Répondre à Claude et relancer avec la correction">↩</button>` : ""}
      <button class="ic" data-manuel title="Consigner du temps à la main">
        <svg><use href="#i-plus"></use></svg></button>
      ${contexte === "tout" ? `<button class="ic ${epingle ? "on" : ""}" data-epingle title="${epingle ? "Retirer des tâches à compléter manuellement" : "Marquer à compléter manuellement"}">
        <svg><use href="#i-epingle"></use></svg></button>` : ""}
      <button class="ic" data-modifier title="Modifier"><svg><use href="#i-crayon"></use></svg></button>
    </div>`;

  el.querySelector("[data-bascule]").onclick = () => {
    ouvertes.has(t.id) ? ouvertes.delete(t.id) : ouvertes.add(t.id);
    rendre();
  };
  const bEcrire = el.querySelector("[data-ecrire]");
  if (bEcrire) bEcrire.onclick = () => demanderCourriel(t.id, bEcrire);
  const bCopie = el.querySelector("[data-copier-brouillon]");
  if (bCopie) bCopie.onclick = async () => {
    try {
      await navigator.clipboard.writeText(brouillonDe(t));
      bCopie.textContent = "✓";
      setTimeout(() => { bCopie.textContent = "⧉"; }, 2000);
    } catch {
      avis("Copie refusée par le navigateur — copier depuis le détail de la tâche.", true);
    }
  };
  el.querySelector("[data-fait]").onclick = () => {
    if (t.statut === "fait") {
      enregistrerTache({ id: t.id, statut: "a_faire" });
      return;
    }
    // Le minuteur en cours sur cette tâche est arrêté et son temps consigné.
    if (actif) arreter(true);
    enregistrerTache({ id: t.id, statut: "fait" });
  };
  el.querySelector("[data-chrono]").onclick = () => (actif ? arreter() : demarrer(t.id));
  // Chantier LinkedIn : l'éclair mène à la page du lot (tous les posts sur une
  // page, copie d'un bouton) — il n'y a rien à confier à Claude, tout est prêt.
  el.querySelector("[data-claude]").onclick = () =>
    (t.chantier === "LinkedIn" ? (window.location.href = "linkedin.html") : lancerClaude(t));
  const bCorriger = el.querySelector("[data-corriger]");
  if (bCorriger) bCorriger.onclick = () => corrigerClaude(t, lc);
  el.querySelector("[data-manuel]").onclick = () => {
    const v = prompt(`Combien de minutes consigner sur « ${t.titre} » ?`, "30");
    if (v === null) return;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) ajouterTemps(t.id, n, "saisie manuelle");
  };
  el.querySelector("[data-modifier]").onclick = () => ouvrirModale(t);
  const bEp = el.querySelector("[data-epingle]");
  if (bEp) bEp.onclick = () => enregistrerTache({ id: t.id, jour: epingle ? "" : "manuel" });
  return el;
}

function remplir(cible, taches, contexte, vide) {
  cible.innerHTML = "";
  if (!taches.length) {
    cible.innerHTML = `<div class="vide">${vide}</div>`;
    return;
  }
  const env = document.createElement("div");
  env.className = "liste";
  taches.forEach((t) => env.appendChild(carte(t, contexte)));
  cible.appendChild(env);
}

/*
 * « Écrire » : le brouillon vit dans le détail de la tâche du prospecteur.
 * Un lien mailto: a d'abord servi à l'ouvrir, mais il ne choisit pas
 * l'identité d'envoi (retombe sur l'identité par défaut du profil, pas celle
 * du mandat) et rien ne garantit qu'il tombe sur Thunderbird plutôt que sur
 * un autre client par défaut. Même piège, même remède que les courriels
 * MSI : la page ne dépose qu'un numéro de tâche dans « demandesCourriel »,
 * et la passerelle courriels_prospection.py de BG001 ouvre la fenêtre avec
 * la syntaxe à champs (from=…,to=…,subject=…,body=…), qui sélectionne la
 * bonne identité dans le champ « De ». Voir demanderCourriel() plus bas.
 */
function brouillonDe(t) {
  const m = /Brouillon prêt[^:]*:\n\n([\s\S]*?)\n\nMarquer cette tâche/
    .exec((t && t.detail) || "");
  return m ? m[1].trim() : "";
}

function demanderCourriel(tacheId, bouton) {
  if (!uidCourant) return;
  bouton.disabled = true;
  setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
    { demandesCourriel: { [tacheId]: { geste: "ouvrir", maj: maintenant() } } },
    { merge: true })
    .then(() => avis("Thunderbird s'ouvre sur BG001 — rien ne part avant ton clic sur « Envoyer »."))
    .catch((e) => { bouton.disabled = false; avis("Demande refusée : " + e.message, true); });
}

/* La fiche contact d'un prospect : tout ce que le journal sait pour le
   joindre, en une ligne sous son rang. Le téléphone est cliquable (tel:) —
   c'est le canal que Dominic a demandé de prioriser. */
function lienTel(brut) {
  const ch = (brut || "").replace(/\D/g, "");
  if (ch.length === 10) return `tel:+1${ch}`;
  if (ch.length === 11 && ch[0] === "1") return `tel:+${ch}`;
  return ch ? `tel:${ch}` : "";
}

function ligneFiche(p) {
  const morceaux = [];
  if (p.contact && p.contact !== "a identifier") morceaux.push(ech(p.contact));
  if (p.telephone) morceaux.push(
    `<a class="p-act" href="${ech(lienTel(p.telephone))}" title="Appeler">☎ ${ech(p.telephone)}</a>`);
  if (p.courriel) morceaux.push(
    `<a class="p-act" href="mailto:${ech(p.courriel)}" title="Écrire (sans brouillon)">${ech(p.courriel)}</a>`);
  if (/^https?:\/\//.test(p.site || "")) morceaux.push(
    `<a class="p-act" href="${ech(p.site)}" target="_blank" rel="noopener noreferrer">site</a>`);
  return morceaux.length ? morceaux.join(" · ")
    : "coordonnées à compléter — journal ou inventaire de prospection (TSV)";
}

/* Les courriels de prospection déjà rédigés sur BG001 (dossier Batchs_
   Courriels). Un clic ouvre la fenêtre de rédaction Thunderbird, remplie et
   signée de la bonne identité — et RIEN NE PART : le clic sur « Envoyer »
   reste un geste humain, comme le veut le dossier.

   La page n'envoie qu'un NUMÉRO de fiche à la passerelle de BG001. Le texte,
   le destinataire et l'identité d'envoi ne transitent jamais par le web :
   ils sont lus sur la machine, au moment d'ouvrir la fenêtre. */
function rendreCourriels() {
  const tout = (courrielsMsi && courrielsMsi.courriels) || [];
  const mien = tout.length &&
    appartientAuMandat(filtreClient, courrielsMsi.mandat || "");
  $("p-courriels").hidden = !mien;
  if (!mien) return 0;

  const lots = [...new Set(tout.map((c) => c.batch))].sort();
  if (lotCourriel && !lots.includes(lotCourriel)) lotCourriel = "";
  const visibles = lotCourriel ? tout.filter((c) => c.batch === lotCourriel) : tout;
  const reste = tout.filter((c) => c.statut === "a_faire").length;
  const demandes = (courrielsMsi && courrielsMsi.demandes) || {};

  $("p-cr-n").textContent = `${tout.length} rédigés · ${reste} à envoyer`;
  $("p-cr-lots").innerHTML =
    `<button class="puce" data-lot="" aria-pressed="${!lotCourriel}">tous</button>` +
    lots.map((l) => `<button class="puce" data-lot="${ech(l)}" ` +
      `aria-pressed="${l === lotCourriel}">lot ${ech(l)}</button>`).join("");
  $("p-cr-lots").querySelectorAll("[data-lot]").forEach((b) => {
    b.onclick = () => { lotCourriel = b.dataset.lot; rendreCourriels(); };
  });

  $("p-cr-liste").innerHTML =
    `<thead><tr><th>#</th><th>Entreprise</th><th>Objet</th><th>Destinataire</th>` +
    `<th>Statut</th><th>Action</th></tr></thead><tbody>` +
    visibles.map((c) => {
      const attente = Boolean(demandes[c.id]);
      const action = attente
        ? `<span class="p-c-note">ouverture sur BG001…</span>`
        : `<button type="button" class="p-act" data-cr="${ech(c.id)}" data-g="ouvrir"
             title="Ouvrir la fenêtre Thunderbird, déjà remplie">✉ ouvrir</button>` +
          (c.statut === "a_faire"
            ? ` · <button type="button" class="p-act" data-cr="${ech(c.id)}" data-g="marquer"
                 title="Inscrire ENVOYÉ sur la fiche du batch">marquer envoyé</button>`
            : "");
      /* L'état du prospect visé, à côté de celui du courriel : « envoyé » ne
         dit rien de la suite tant que le prospecteur n'a pas porté le contact
         au journal. Un courriel que rien ne relie à l'inventaire s'ouvre et
         s'envoie quand même — il ne peut simplement pas déclencher
         l'acceptation tout seul, et il vaut mieux le voir avant. */
      const suite = c.statut !== "envoye" ? ""
        : c.journalId ? " · au journal"
        : c.prospect ? " · acceptation au prochain cycle"
        : " · à porter au journal à la main";
      /* Trois morceaux calculés AVANT le gabarit, jamais dedans : un gabarit
         imbriqué dans un ${…} inverse la lecture du contrôle des constantes
         (tests/constantes.py), et le décalage se paie plus loin dans le
         fichier, sur une ligne qui n'y est pour rien. */
      const infobulle = c.prospect ? ' title="Prospect : ' + ech(c.prospect) + '"' : "";
      const relie = c.prospect ? "" :
        ' <span class="p-c-note" title="Aucune ligne de l’inventaire ne porte ce nom">· non relié</span>';
      const etat = c.statut === "envoye" ? "envoyé le " + ech(c.envoyeLe) : "à envoyer";
      return `<tr${infobulle}>
        <td class="p-c-num">${ech(c.id)}</td>
        <td>${ech(c.nom)}${relie}</td>
        <td class="p-c-note">${ech(c.objet)}</td>
        <td class="p-c-note">${ech(c.a)}</td>
        <td>${etat}<span class="p-c-note">${ech(suite)}</span></td>
        <td class="p-c-dec">${action}</td></tr>`;
    }).join("") + "</tbody>";

  $("p-cr-liste").querySelectorAll("[data-cr]").forEach((b) => {
    b.onclick = () => {
      if (!uidCourant) return;
      b.disabled = true;
      setDoc(doc(db, "users", uidCourant, "marketing", "courriels-msi"),
        { demandes: { [b.dataset.cr]: { geste: b.dataset.g, maj: maintenant() } } },
        { merge: true })
        .then(() => avis(b.dataset.g === "marquer"
          ? "Marqué envoyé — le prospect entre en cadence au prochain cycle."
          : "Thunderbird s'ouvre sur BG001 — rien ne part avant ton clic sur « Envoyer »."))
        .catch((e) => { b.disabled = false; avis("Demande refusée : " + e.message, true); });
    };
  });
  return tout.length;
}

function rendreProspection() {
  const nCourriels = rendreCourriels();
  const liste = (prospection && prospection.prospects) || [];
  /*
   * Chaque mandat a sa prospection. Le miroir, lui, est écrit par le
   * prospecteur de BG001 dans un document unique — un processus qu'on ne voit
   * pas d'ici et qu'on ne peut pas faire changer de format unilatéralement.
   *
   * On filtre donc à deux niveaux : le mandat porté par le prospect s'il en
   * porte un (ce que le prospecteur pourra ajouter quand il voudra), sinon
   * l'appartenance du document entier. Le jour où le prospecteur écrit un
   * `mandat` par prospect, le cloisonnement devient exact sans toucher à cette
   * page.
   *
   * La section reste VISIBLE quand elle est vide pour le mandat courant : une
   * section qui disparaît se cherche, et on finit par croire l'outil cassé.
   */
  const proprietaire = (prospection && prospection.mandat) || state.config.mandatStme || "";
  const sienne = (p) => p.mandat
    ? appartientAuMandat(filtreClient, p.mandat)
    : appartientAuMandat(filtreClient, proprietaire);
  /* Le « × » d'une ligne dépose un retrait ; le prospecteur ne l'appliquera au
     journal qu'à son prochain cycle. La page, elle, retire la ligne TOUT DE
     SUITE : un clic qui ne fait rien pendant une semaine se reclique, et on
     finit par croire le bouton cassé. Un prospect déjà abandonné compte pour
     retiré lui aussi — le bouton « voir les retirés » les ramène tous. */
  const retraits = (prospection && prospection.retraits) || {};
  const sigDe = (p) => (((prospection && prospection.signaux) || {})[p.id] || {}).statut || p.statut;
  const retire = (p) => Boolean(retraits[p.id]) || sigDe(p) === "abandonne";
  const tous = liste.filter(sienne);
  const vivants = tous.filter((p) => !retire(p));
  const nRetires = tous.length - vivants.length;
  const miens = montrerRetires ? tous : vivants;
  const bRetires = $("p-retires");
  bRetires.onclick = () => { montrerRetires = !montrerRetires; rendreProspection(); };
  bRetires.hidden = !nRetires;
  bRetires.textContent = montrerRetires
    ? `masquer les ${nRetires} retiré${nRetires > 1 ? "s" : ""}`
    : `voir les ${nRetires} retiré${nRetires > 1 ? "s" : ""}`;

  // Le volet vit aussi pour les seuls courriels : la passerelle peut avoir
  // publié ses fiches avant que le prospecteur ait écrit son premier miroir.
  $("prospection").hidden = !liste.length && !nCourriels;
  if (!liste.length) return;
  // Le mandat n'a AUCUN prospect : c'est le seul cas où le volet n'a rien à
  // montrer. Une liste vidée par les retraits, elle, garde son inventaire et
  // ses courriels — et son bouton pour ramener les retirés.
  $("p-vide").hidden = tous.length > 0;
  $("p-liste").hidden = !miens.length;
  if (!tous.length) {
    $("p-vide").textContent =
      `Aucun prospect pour ce mandat. Le miroir du prospecteur de BG001 en porte ` +
      `${liste.length} pour « ${proprietaire || "un autre mandat"} ».`;
    $("p-maj").textContent = "";
    $("p-candidats").hidden = true;
    $("ent").hidden = true;
    return;
  }
  const signaux = (prospection && prospection.signaux) || {};
  $("p-maj").textContent = prospection.majLe
    ? `journal du ${new Date(prospection.majLe).toLocaleDateString("fr-CA")} · nom = fiche contact · ligne = tâches du prospect`
    : "";

  /* ── l'entonnoir : contactés → joints → répondus → RDV → clients → revenu.
     Un signal déposé sur la page prime sur le statut du miroir (plus frais),
     et les appels consignés ici comptent avant même que le prospecteur les
     ait reportés au journal. ── */
  const enAttente = (prospection && prospection.appels) || {};
  const tentativesDe = (p) => (p.appelsFaits || 0) + ((enAttente[p.id] || []).length);
  const jointsDe = (p) => (p.appelsJoints || 0) +
    (enAttente[p.id] || []).filter((a) => a.resultat === "joint").length;
  const statutVif = (p) => (signaux[p.id] && signaux[p.id].statut) || p.statut;

  // Même fraîcheur que les étages suivants : le statut signalé prime, et une
  // tentative consignée à l'instant fait un contacté — sinon l'entonnoir
  // pourrait s'inverser (des joints sans contactés).
  const contactes = miens.filter((p) => p.dernierContact || tentativesDe(p) > 0 ||
    !["a_contacter", "contact_prepare"].includes(statutVif(p)));
  const avantPlan = contactes.filter((p) =>
    p.dernierContact && p.dernierContact < "2026-08-14").length;
  const nJoints = miens.filter((p) => jointsDe(p) > 0).length;
  const nRepondus = miens.filter((p) =>
    ["repondu", "rdv_fixe", "client"].includes(statutVif(p))).length;
  const nRdv = miens.filter((p) => ["rdv_fixe", "client"].includes(statutVif(p))).length;
  const nClients = miens.filter((p) => statutVif(p) === "client").length;
  const revenus = (prospection && prospection.revenus) || [];
  const dollars = (t) => revenus.filter((r) => r.type === t)
    .reduce((s, r) => s + (Number(r.montant) || 0), 0);

  $("ent").hidden = false;
  $("ent-phase").textContent = "// " + phaseCourante();
  $("ent-ligne").innerHTML =
    `Contactés <b>${contactes.length}</b>${avantPlan ? ` <span class="p-c-note">(dont ${avantPlan} avant le plan)</span>` : ""} · ` +
    `Joints <b>${nJoints}</b> · Répondus <b>${nRepondus}</b> · RDV <b>${nRdv}</b> · ` +
    `Clients <b>${nClients}</b> · Revenu <b>${dollars("facture").toLocaleString("fr-CA")} $</b>` +
    ` <span class="p-c-note">(carnet ${dollars("carnet").toLocaleString("fr-CA")} $)</span>`;

  /* Les quatre compteurs de gestes de la semaine — chaque geste se compte au
     moment où il se pose ; consigner un appel en compte un tout seul. */
  /* La semaine se recalcule AU CLIC (un onglet peut passer la fin de semaine
     ouvert sans re-rendu), et les compteurs passent par Number() : le doc est
     partagé avec BG001, on n'injecte ni ne concatène ce qu'on n'a pas vérifié. */
  const sem = semaineISO();
  const g = ((prospection && prospection.gestes) || {})[sem] || {};
  const nG = (k) => Number(g[k]) || 0;
  const GESTES = [["appels", "appels"], ["envois", "envois"], ["pubs", "pubs"], ["avis", "avis"]];
  const totalG = GESTES.reduce((s, [k]) => s + nG(k), 0);
  $("g-liste").innerHTML = GESTES.map(([k, l]) =>
    `${l} <b>${nG(k)}</b> <button type="button" class="p-act" data-g="${k}">+1</button>`
  ).join(" · ") + ` · total <b>${totalG}</b>`;
  $("g-liste").querySelectorAll("[data-g]").forEach((b) => {
    b.onclick = () => {
      if (!uidCourant) return;
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { gestes: { [semaineISO()]: { [b.dataset.g]: increment(1) } } }, { merge: true })
        .catch((e) => avis("Geste refusé : " + e.message, true));
    };
  });

  const releves = (prospection && prospection.releves) || [];
  const dernierR = releves.length ? releves[releves.length - 1] : null;
  $("releve-info").textContent = dernierR ? `dernier : ${dernierR.date}` : "aucun relevé encore";
  $("btn-releve").onclick = () => {
    if (!uidCourant) return;
    const semClic = semaineISO();
    const gClic = ((prospection && prospection.gestes) || {})[semClic] || {};
    setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
      { releves: arrayUnion({
        semaine: semClic, date: jourISO(),
        entonnoir: { contactes: contactes.length, joints: nJoints, repondus: nRepondus,
          rdv: nRdv, clients: nClients,
          revenuFacture: dollars("facture"), revenuCarnet: dollars("carnet") },
        gestes: { appels: Number(gClic.appels) || 0, envois: Number(gClic.envois) || 0,
          pubs: Number(gClic.pubs) || 0, avis: Number(gClic.avis) || 0 },
      }) }, { merge: true })
      .catch((e) => avis("Relevé refusé : " + e.message, true));
    avis(`Relevé ${semClic} consigné.`);
  };

  /* Le revenu se consigne en dollars réels, jamais projetés : « facturé »
     quand la première intervention est livrée, « carnet » à l'acceptation. */
  const selR = $("r-prospect");
  const choixR = selR.value;
  selR.innerHTML = `<option value="">— prospect —</option>` + miens.map((p) =>
    `<option value="${ech(p.prospect)}"${p.prospect === choixR ? " selected" : ""}>${ech(p.prospect)}</option>`).join("");
  $("f-revenu").onsubmit = (ev) => {
    ev.preventDefault();
    const montant = Number($("r-montant").value);
    if (!(montant > 0)) { avis("Montant invalide — rien consigné.", true); return; }
    if (!uidCourant) { avis("Non connecté — rien consigné.", true); return; }
    setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
      { revenus: arrayUnion({ date: jourISO(), prospect: selR.value || "",
        montant, type: $("r-type").value }) }, { merge: true })
      .catch((e) => avis("Revenu refusé : " + e.message, true));
    // La persistance locale garantit l'écriture : confirmation immédiate,
    // même hors ligne — le .catch couvre le refus réel des règles.
    $("r-montant").value = "";
    avis("Revenu consigné.");
  };

  /* Liste serrée, sans décor : une ligne par prospect, l'état en texte brut.
     Seule couleur : une échéance dépassée — c'est une information, pas un style. */
  const auj = jourISO();
  const SIGNAL_OPTIONS = `<option value="">signaler…</option>
    <option value="repondu">a répondu</option>
    <option value="rdv_fixe">rendez-vous fixé</option>
    <option value="client">devenu client</option>
    <option value="dormant">mettre en dormance</option>
    <option value="a_contacter">réactiver la cadence</option>`;
  const parId = new Map(miens.map((p) => [p.id, p]));
  $("p-liste").innerHTML =
    `<thead><tr><th>Prospect</th><th>État</th><th>Rel.</th><th>Prochaine</th>` +
    `<th>Note</th><th></th><th></th></tr></thead><tbody>` +
    miens.map((p) => {
      // Ce que la page sait de plus frais que le miroir hebdomadaire : un signal
      // déposé ici, ou la tâche de relance déjà marquée faite (envoi confirmé).
      const t = p.tacheId ? state.taches.find((x) => x.id === p.tacheId) : null;
      const envoye = t && t.statut === "fait";
      const sig = signaux[p.id] && signaux[p.id].statut;
      const etat = sig ? `${LIB_PROSP[sig] || sig} (signalé)`
        : envoye ? "Relance envoyée (à consigner)"
        : (LIB_PROSP[p.statut] || p.statut);
      const enCadence = !sig && !envoye &&
        ["a_contacter", "contacte_sans_reponse", "relance_envoyee"].includes(p.statut);
      const retard = enCadence && p.prochaine && p.prochaine < auj;
      const brouillon = !envoye && !sig ? brouillonDe(t) : "";
      const attenteCourriel = Boolean((prospection && prospection.demandesCourriel || {})[p.tacheId]);
      // Calculé AVANT le gabarit du <tr>, jamais dedans : un gabarit imbriqué
      // dans un ${…} inverse la lecture du contrôle des constantes
      // (tests/constantes.py) — voir le même choix pour rendreCourriels().
      const decisionEcrire = !brouillon ? "" : attenteCourriel
        ? `<span class="p-c-note">ouverture sur BG001…</span>`
        : `<button type="button" class="p-act" data-ecrire
          title="Ouvrir un courriel avec le brouillon, sur BG001${p.courriel ? " — " + ech(p.courriel) : " (destinataire à compléter)"}">✉ écrire</button>`;
      return `<tr data-p="${ech(p.id)}">
        <td class="p-c-nom" title="Fiche contact — un clic">${ech(p.prospect)}</td>
        <td>${ech(etat)}</td>
        <td class="p-c-num">${p.relances || 0}</td>
        <td class="p-c-date${retard ? " p-retard" : ""}">${ech(p.prochaine || "—")}</td>
        <td class="p-c-note">${ech(p.note || "")}</td>
        <td class="p-c-dec">${brouillon ? decisionEcrire + ` ·
          <button type="button" class="p-act" data-cp title="Copier le brouillon (pour LinkedIn ou ailleurs)">copier</button>` : ""}</td>
        <td><select class="p-sig" data-id="${ech(p.id)}">${SIGNAL_OPTIONS}</select>
          <button type="button" class="p-x" data-x
            title="Retirer ce prospect de la liste">×</button></td>
      </tr>
      <tr class="p-fiche"${fichesOuvertes.has(p.id) ? "" : " hidden"}>
        <td colspan="7"><span class="p-fiche-cle">fiche</span> ${ligneFiche(p)}
          <span class="p-c-note">· tentatives ${tentativesDe(p)}${jointsDe(p) ? ` (${jointsDe(p)} joints)` : ""}</span>
          — consigner l'appel :
          <button type="button" class="p-act" data-ap="joint">joint</button> ·
          <button type="button" class="p-act" data-ap="vocal">boîte vocale</button> ·
          <button type="button" class="p-act" data-ap="sans_reponse">sans réponse</button></td>
      </tr>`;
    }).join("") + "</tbody>";

  $("p-liste").querySelectorAll("tr[data-p]").forEach((tr) => {
    const p = parId.get(tr.dataset.p);
    if (!p) return;
    const bEcrire = tr.querySelector("[data-ecrire]");
    if (bEcrire) bEcrire.onclick = () => demanderCourriel(p.tacheId, bEcrire);
    const bCp = tr.querySelector("[data-cp]");
    if (bCp) bCp.onclick = async () => {
      const t = p.tacheId ? state.taches.find((x) => x.id === p.tacheId) : null;
      try {
        await navigator.clipboard.writeText(brouillonDe(t));
        bCp.textContent = "copié ✓";
        setTimeout(() => { bCp.textContent = "copier"; }, 2000);
      } catch {
        avis("Copie refusée par le navigateur — ouvrir la tâche et copier à la main.", true);
      }
    };
    /* Un clic sur le nom déplie la fiche contact (téléphone, courriel, site) ;
       le reste de la ligne garde son rôle : filtrer les tâches du prospect. */
    tr.querySelector(".p-c-nom").onclick = (ev) => {
      ev.stopPropagation();
      const f = tr.nextElementSibling;
      if (!f || !f.classList.contains("p-fiche")) return;
      f.hidden = !f.hidden;
      if (f.hidden) fichesOuvertes.delete(p.id); else fichesOuvertes.add(p.id);
    };
    /* Consigner une tentative d'appel : elle entre dans la boîte « appels »
       du miroir (le prospecteur la reportera au journal) et compte tout de
       suite dans l'entonnoir et les gestes de la semaine. */
    tr.nextElementSibling.querySelectorAll("[data-ap]").forEach((b) => {
      b.onclick = () => {
        if (!uidCourant) return;
        // Le bouton se fige tout de suite : le re-rendu (snapshot local) le
        // remplace de toute façon, et le compteur « tentatives » qui monte
        // sous les yeux EST la confirmation. Le ts rend chaque tentative
        // unique — deux boîtes vocales le même jour font deux entrées.
        b.disabled = true;
        setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
          { appels: { [p.id]: arrayUnion({ date: jourISO(), resultat: b.dataset.ap,
              ts: maintenant() }) },
            gestes: { [semaineISO()]: { appels: increment(1) } } }, { merge: true })
          .catch((e) => { b.disabled = false; avis("Appel non consigné : " + e.message, true); });
      };
    });
    tr.onclick = (ev) => {
      if (ev.target.closest("select") || ev.target.closest("a") || ev.target.closest("button")) return;
      filtreTexte = p.prospect.toLowerCase();
      $("f-texte").value = p.prospect;
      filtreChantier = "";
      filtreStatut = "";
      rendre();
      $("l-tout").scrollIntoView({ behavior: "smooth" });
    };
    tr.querySelector(".p-sig").onchange = (ev) => {
      const v = ev.target.value;
      if (!v || !uidCourant) return;
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { signaux: { [p.id]: { statut: v, maj: maintenant() } } }, { merge: true })
        .catch((e) => avis("Signal refusé : " + e.message, true));
    };
    /* Le retrait ne demande pas confirmation : il se défait d'un clic sur
       « voir les retirés », et une boîte de dialogue à chaque ligne rendrait
       le ménage d'une liste de cent prospects insupportable. */
    tr.querySelector("[data-x]").onclick = (ev) => {
      ev.stopPropagation();
      if (!uidCourant) return;
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { retraits: { [p.id]: { nom: p.prospect, maj: maintenant() } } }, { merge: true })
        .then(() => avis(`« ${p.prospect} » retiré.`))
        .catch((e) => avis("Retrait refusé : " + e.message, true));
    };
  });

  /* Inventaire : le bassin complet de prospects potentiels, cadence incluse,
     par pages de 20. Candidat → accepter/rejeter ; répertorié → cadencer ;
     rien n'entre dans la cadence sans un geste explicite, et un rejet est
     définitif (jamais reproposé). */
  const inv = ((prospection && prospection.inventaire) || [])
    .filter((r) => montrerRetires || !retraits[r.id]);
  const cands = (prospection && prospection.candidats) || [];
  const decisions = (prospection && prospection.candidatures) || {};
  const ajouts = (prospection && prospection.ajouts) || {};
  $("p-candidats").hidden = !inv.length;
  if (!inv.length) return;

  const infoCand = new Map(cands.map((c) => [c.id, c]));
  const cleAjout = (nom) => nom.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "prospect";
  const RANG_INV = { en_cadence: 0, candidat: 1, repertorie: 2, rejete: 3 };
  const LIB_INV = { en_cadence: "en cadence", candidat: "candidat",
    repertorie: "répertorié", rejete: "rejetée" };
  inv.sort((a, b) => (RANG_INV[a.statut] ?? 9) - (RANG_INV[b.statut] ?? 9) ||
    (a.nom || "").localeCompare(b.nom || ""));

  const pages = Math.max(1, Math.ceil(inv.length / 20));
  if (pageInv >= pages) pageInv = pages - 1;
  const visibles = inv.slice(pageInv * 20, pageInv * 20 + 20);
  $("p-inv-n").textContent =
    `${inv.length} prospects potentiels · lot ${pageInv + 1} de ${pages} · nom = fiche contact`;

  /* La fiche contact vaut aussi ici. Une entrée en cadence emprunte celle du
     journal (la plus riche, contre-vérifiée) par son nom ; les autres montrent
     ce que l'inventaire sait (relevé en une passe, source officielle exigée). */
  const norm = (s) => (s || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const prospectParNom = new Map(liste.map((p) => [norm(p.prospect), p]));
  const ficheInv = (r) => (r.statut === "en_cadence" && prospectParNom.get(norm(r.nom)))
    || { contact: r.contact, telephone: r.telephone, courriel: r.courriel, site: r.lien };

  $("p-cand-liste").innerHTML =
    `<thead><tr><th>Prospect</th><th>Secteur</th><th>Ville</th><th>Origine</th>` +
    `<th>Statut</th><th>Lien</th><th>Action</th></tr></thead><tbody>` +
    visibles.map((r) => {
      const c = infoCand.get(r.id);
      const dec = decisions[r.id] && decisions[r.id].decision;
      const cadencee = ajouts[cleAjout(r.nom || "")] || ajouts[r.id];
      let action = "";
      if (r.statut === "candidat") {
        action = dec
          ? (dec === "accepte" ? "acceptée — prochain cycle" : "rejetée — prochain cycle")
          : `<button type="button" class="p-act" data-c="${ech(r.id)}" data-d="accepte">accepter</button> ·
             <button type="button" class="p-act" data-c="${ech(r.id)}" data-d="rejete">rejeter</button>`;
      } else if (r.statut === "repertorie") {
        action = cadencee ? "cadencée — prochain cycle"
          : `<button type="button" class="p-act" data-n="${ech(r.nom)}">cadencer</button>`;
      } else if (r.statut === "en_cadence") {
        action = "—";
      }
      const liens = [];
      if (/^https?:\/\//.test(r.lien || "")) {
        liens.push(`<a class="p-lien" href="${ech(r.lien)}" target="_blank" rel="noopener noreferrer">site</a>`);
      }
      if (c && /^https?:\/\//.test(c.source || "")) {
        liens.push(`<a class="p-lien" href="${ech(c.source)}" target="_blank" rel="noopener noreferrer">src</a>`);
      }
      const infobulle = (c && c.angle) || r.note || "";
      return `<tr data-i="${ech(r.id)}"${infobulle ? ` title="${ech(infobulle)}"` : ""}>
        <td class="p-c-nom" title="Fiche contact — un clic">${ech(r.nom)}</td>
        <td>${ech(r.secteur || "")}</td>
        <td>${ech(r.ville || "")}</td>
        <td class="p-c-note">${ech(r.origine || "")}</td>
        <td class="p-c-note">${LIB_INV[r.statut] || ech(r.statut)}</td>
        <td>${liens.join(" ")}</td>
        <td class="p-c-dec">${action}
          <button type="button" class="p-x" data-xi="${ech(r.id)}"
            title="Retirer ce prospect de l’inventaire">×</button></td></tr>
      <tr class="p-fiche"${fichesOuvertes.has("inv:" + r.id) ? "" : " hidden"}>
        <td colspan="7"><span class="p-fiche-cle">fiche</span> ${ligneFiche(ficheInv(r))}</td>
      </tr>`;
    }).join("") + "</tbody>";

  $("p-cand-liste").querySelectorAll("tr[data-i]").forEach((tr) => {
    const cle = "inv:" + tr.dataset.i;
    tr.querySelector(".p-c-nom").onclick = () => {
      const f = tr.nextElementSibling;
      if (!f || !f.classList.contains("p-fiche")) return;
      f.hidden = !f.hidden;
      if (f.hidden) fichesOuvertes.delete(cle); else fichesOuvertes.add(cle);
    };
  });

  $("p-pages").innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) =>
    `<button class="puce" data-pg="${i}" aria-pressed="${i === pageInv}">` +
    `${i * 20 + 1}–${Math.min(inv.length, (i + 1) * 20)}</button>`).join("") : "";
  $("p-pages").querySelectorAll("[data-pg]").forEach((b) => {
    b.onclick = () => { pageInv = Number(b.dataset.pg); rendreProspection(); };
  });

  $("p-cand-liste").querySelectorAll("[data-c]").forEach((b) => {
    b.onclick = () => {
      if (!uidCourant) return;
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { candidatures: { [b.dataset.c]: { decision: b.dataset.d, maj: maintenant() } } },
        { merge: true })
        .catch((e) => avis("Décision refusée : " + e.message, true));
    };
  });
  $("p-cand-liste").querySelectorAll("[data-xi]").forEach((b) => {
    b.onclick = () => {
      if (!uidCourant) return;
      const nom = (inv.find((r) => r.id === b.dataset.xi) || {}).nom || "";
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { retraits: { [b.dataset.xi]: { nom, maj: maintenant() } } }, { merge: true })
        .then(() => avis(`« ${nom} » retiré.`))
        .catch((e) => avis("Retrait refusé : " + e.message, true));
    };
  });
  $("p-cand-liste").querySelectorAll("[data-n]").forEach((b) => {
    b.onclick = () => {
      if (!uidCourant) return;
      const nom = b.dataset.n;
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { ajouts: { [cleAjout(nom)]: { nom, maj: maintenant() } } }, { merge: true })
        .catch((e) => avis("Mise en cadence refusée : " + e.message, true));
    };
  });
}

function boutons(cible, entrees, courant, action) {
  $(cible).innerHTML = entrees.map(([v, l]) =>
    `<button class="puce" data-v="${ech(v)}" aria-pressed="${courant === v}">${ech(l)}</button>`).join("");
  $(cible).querySelectorAll("[data-v]").forEach((b) => {
    b.onclick = () => { action(b.dataset.v); rendre(); };
  });
}

function rendre() {
  const auj = jourISO();
  const visible = (t) => !filtreClient || t.client === filtreClient;

  /* ── temps du jour (pied de la colonne Aujourd'hui) ── */
  const tempsVisible = state.temps.filter((e) => {
    const t = tacheDe(e.idTache);
    return !filtreClient || (t && t.client === filtreClient);
  });
  const mJour = somme(tempsVisible.filter((e) => e.date === auj));

  const taches = state.taches.filter(visible);

  /* ── à compléter manuellement ── */
  const duJour = taches.filter((t) => t.jour === "manuel").sort(trier);
  remplir($("l-jour"), duJour, "jour",
    "Rien à faire à la main. La vigie et le bouton épingle y déposent ce qui t'attend.");
  const reste = duJour.filter((t) => t.statut !== "fait").length;
  $("e-jour").textContent = duJour.length
    ? `${reste} à faire · ${duJour.length - reste} faite${duJour.length - reste > 1 ? "s" : ""}` : "";

  const restees = taches.filter((t) => t.jour && t.jour < auj && t.statut !== "fait").sort(trier);
  $("bloc-report").hidden = !restees.length;
  if (restees.length) {
    remplir($("l-report"), restees, "tout", "");
    $("e-report").textContent = `${restees.length} en attente`;
  }

  /* ── filtres ── */
  const clients = [...new Set(state.taches.map((t) => t.client).filter(Boolean))].sort();
  // Un mandat retenu d'une session précédente peut avoir disparu : import annulé,
  // tâches supprimées, ou simple faute de frappe corrigée depuis. Sans ce
  // garde-fou l'écran serait vide, sans qu'aucun bouton paraisse actif — on
  // retombe alors sur « tous les mandats », qui est au moins un état lisible.
  if (filtreClient && !clients.includes(filtreClient)) { filtreClient = ""; ecrireMandat(""); }
  rendreSelecteur("f-client", clients, filtreClient, (v) => { filtreClient = v; rendre(); });

  // Ce tableau de bord est le seul écran qui lit `state` : il dépose donc, pour
  // les autres, le mandat auquel appartiennent les documents écrits par les
  // processus de BG001 (prospection, lot LinkedIn). Voir js/mandat.js.
  noterMandatExterne(state.config.mandatStme || "");
  noterMandats(clients);

  // Suggestions de saisie de la modale : la liste naît des tâches, jamais
  // d'une liste écrite dans le code (le dépôt est public).
  $("l-clients").innerHTML = clients.map((c) => `<option value="${ech(c)}">`).join("");

  const chantiers = [...new Set(taches.map((t) => t.chantier).filter(Boolean))].sort();
  boutons("f-chantier", [["", "Tous"], ...chantiers.map((c) => [c, c])],
    filtreChantier, (v) => { filtreChantier = v; });

  boutons("f-statut", [["actives", "Actives"], ["a_faire", "À faire"], ["en_cours", "En cours"],
    ["bloque", "Bloquées"], ["fait", "Faites"], ["", "Toutes"]],
    filtreStatut, (v) => { filtreStatut = v; });

  /* ── liste complète ── */
  const tout = taches.filter((t) =>
    (!filtreChantier || t.chantier === filtreChantier) &&
    (filtreStatut === "" ||
      (filtreStatut === "actives" ? t.statut !== "fait" : t.statut === filtreStatut)) &&
    (!filtreTexte || [t.titre, t.detail, t.source, t.client]
      .join(" ").toLowerCase().includes(filtreTexte))
  ).sort(trier);
  remplir($("l-tout"), tout, "tout", "Aucune tâche ne correspond à ce filtre.");
  $("e-tout").textContent = `${tout.length} affichée${tout.length > 1 ? "s" : ""} sur ${taches.length}`;

  /* ── journal du temps ── */
  const entrees = tempsVisible.filter((e) => e.date === auj)
    .sort((a, b) => (b.maj || 0) - (a.maj || 0));
  const ul = $("l-temps");
  ul.innerHTML = "";
  $("e-temps").textContent = entrees.length ? fmt(mJour) : "";
  if (!entrees.length) {
    ul.innerHTML = `<li style="color:var(--text-muted)">Rien de consigné aujourd'hui. Le minuteur ▶ d'une tâche démarre le compte.</li>`;
  } else {
    for (const e of entrees) {
      const t = tacheDe(e.idTache);
      const li = document.createElement("li");
      li.innerHTML = `<span class="m">${fmt(e.minutes)}</span>
        <span class="t">${ech(t ? t.titre : "(tâche supprimée)")}</span>
        <button class="x" title="Retirer cette entrée">×</button>`;
      li.querySelector(".x").onclick = () => supprimerTemps(e.id);
      ul.appendChild(li);
    }
  }

  rendreProspection();
}

/* ═══════════════════════════  modale  ══════════════════════════════════ */

let idEnCours = null;
const selStme = $("m-stme");
for (let i = 1; i <= 13; i++) selStme.add(new Option(String(i), String(i)));

function ouvrirModale(t) {
  idEnCours = t ? t.id : null;
  $("mod-titre").textContent = t ? "Modifier la tâche" : "Nouvelle tâche";
  $("m-titre").value = t ? t.titre : "";
  $("m-detail").value = t ? t.detail : "";
  $("m-client").value = (t && t.client) || filtreClient || clientParDefaut();
  $("m-chantier").value = (t && t.chantier) || "Pilotage";
  $("m-stme").value = (t && t.stme) || "";
  /*
   * La STME est le découpage du plan V5 d'UN mandat — celui de `mandatStme`.
   * Sous un autre mandat le champ n'a pas de sens : le proposer, c'est inviter
   * à ranger une tâche dans le plan d'une autre entreprise. On le masque, sans
   * effacer la valeur d'une tâche qui en porterait déjà une.
   */
  const mandatDeLaTache = (t && t.client) || filtreClient || clientParDefaut();
  const stmePertinente = !state.config.mandatStme ||
    mandatDeLaTache === state.config.mandatStme || Boolean(t && t.stme);
  selStme.closest(".champ").hidden = !stmePertinente;
  $("m-prio").value = (t && t.priorite) || "moyenne";
  $("m-statut").value = (t && t.statut) || "a_faire";
  $("m-echeance").value = (t && t.echeance) || "";
  $("m-estime").value = (t && t.estimeMin) || "";
  $("m-source").value = (t && t.source) || "";
  $("m-sup").hidden = !t;
  $("modale").showModal();
}

$("f-mod").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const d = {
    titre: $("m-titre").value.trim(), detail: $("m-detail").value.trim(),
    client: $("m-client").value, chantier: $("m-chantier").value,
    stme: $("m-stme").value, priorite: $("m-prio").value, statut: $("m-statut").value,
    echeance: $("m-echeance").value, estimeMin: $("m-estime").value,
    source: $("m-source").value.trim(),
  };
  if (!d.titre) return;
  if (idEnCours) d.id = idEnCours;
  $("modale").close();
  enregistrerTache(d);
});

$("m-annul").onclick = () => $("modale").close();
$("m-sup").onclick = () => {
  const t = state.taches.find((x) => x.id === idEnCours);
  if (!t || !confirm(`Supprimer « ${t.titre} » et le temps qui y est rattaché ?`)) return;
  $("modale").close();
  supprimerTache(idEnCours);
};

$("f-ajout").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const titre = $("a-titre").value.trim();
  if (!titre) return;
  $("a-titre").value = "";
  enregistrerTache({
    titre, client: filtreClient || clientParDefaut(),
    chantier: filtreChantier || "Pilotage", jour: jourISO(),
  });
});

/*
 * Mandat proposé par défaut : le plus utilisé parmi les tâches existantes.
 * Vide au tout premier usage — on ne devine pas un nom de client, et le dépôt
 * étant public, aucun n'y est écrit.
 */
function clientParDefaut() {
  const compte = new Map();
  for (const t of state.taches) {
    if (t.client) compte.set(t.client, (compte.get(t.client) || 0) + 1);
  }
  let meilleur = "", n = 0;
  for (const [c, k] of compte) if (k > n) { meilleur = c; n = k; }
  return state.config.mandatStme || meilleur;
}

$("f-texte").addEventListener("input", (ev) => {
  filtreTexte = ev.target.value.trim().toLowerCase();
  rendre();
});

// Arrivée depuis « Ma journée » : #q=<texte> préremplit le filtre texte,
// pour atterrir directement sur la tâche visée.
if (location.hash.startsWith("#q=")) {
  const q = decodeURIComponent(location.hash.slice(3));
  $("f-texte").value = q;
  filtreTexte = q.trim().toLowerCase();
  filtreStatut = "";
}

$("p-ajout").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const nom = $("p-nom").value.trim();
  if (!nom || !uidCourant) return;
  $("p-nom").value = "";
  const cle = nom.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "prospect";
  setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
    { ajouts: { [cle]: { nom, maj: maintenant() } } }, { merge: true })
    .then(() => avis(`« ${nom} » sera intégré à la cadence au prochain cycle du prospecteur.`))
    .catch((e) => avis("Ajout refusé : " + e.message, true));
});

/* ═══════════════════════════  import / export  ═════════════════════════ */

function telecharger(nom, texte, type) {
  const url = URL.createObjectURL(new Blob([texte], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = nom; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const COLS = ["id", "titre", "detail", "client", "chantier", "stme", "priorite",
              "statut", "echeance", "estimeMin", "jour", "source", "maj"];

$("btn-export").onclick = () => {
  const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
  const lignes = [COLS.map((c) => c.toUpperCase()).join("\t")];
  for (const t of state.taches) lignes.push(COLS.map((c) => esc(t[c])).join("\t"));
  lignes.push("", ["ID", "DATE", "ID_TACHE", "MINUTES", "NOTE"].join("\t"));
  for (const e of state.temps) lignes.push([e.id, e.date, e.idTache, e.minutes, esc(e.note)].join("\t"));
  telecharger(`Taches_Marketing_${jourISO()}.tsv`, lignes.join("\n") + "\n", "text/tab-separated-values");
};

$("btn-export-json").onclick = () =>
  telecharger(`marketing_${jourISO()}.json`, JSON.stringify(state, null, 2), "application/json");

$("btn-import").onclick = () => $("f-import").click();

$("f-import").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  ev.target.value = "";
  let entrant;
  try {
    entrant = normaliser(JSON.parse(await f.text()));
  } catch {
    avis("Fichier illisible : l'import attend un JSON produit par « Sauvegarde (JSON) ».", true);
    return;
  }
  if (!entrant.taches.length && !entrant.temps.length) {
    avis("Ce fichier ne contient aucune tâche.", true);
    return;
  }
  const n = entrant.taches.length, m = entrant.temps.length;
  if (!confirm(`Importer ${n} tâche(s) et ${m} entrée(s) de temps ?\n\n` +
               `Rien n'est effacé : l'import FUSIONNE avec ce qui est déjà là. ` +
               `Une copie de l'état actuel est gardée en filet.`)) return;
  try { localStorage.setItem(CLE_AVANT_IMPORT, JSON.stringify(state)); } catch {}
  state = fusionner(state, entrant);
  enregistrer();
  avis(`Import réussi : ${state.taches.length} tâches au total.`);
});

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

/* Lancer le prospecteur à la demande. La page ne fait que déposer un
   « demandeLancement » dans le doc prospection : la passerelle
   courriels_prospection.py de BG001 la voit (cycle de 5 s) et démarre la
   chaîne d'acquisition — le recherchiste cherche de nouveaux clients
   potentiels, le prospecteur rédige les courriels personnalisés des prospects
   dus. Un candidat tout juste trouvé attend l'acceptation de Jérémie avant
   d'obtenir son courriel, et RIEN NE PART : chaque envoi reste un clic humain
   dans Thunderbird. La réponse (champ « lancement ») revient par le même
   document et rallume le bouton. */
let lancementAttendu = 0;

function statutLancement(texte) {
  const el = $("prospecteur-status");
  el.textContent = texte || "";
  el.hidden = !texte;
}

function majStatutLancement(p) {
  const b = $("btn-lancer-prospecteur");
  const l = p && p.lancement;
  // On n'agit que sur l'accusé de NOTRE demande (l.quand posé par la
  // passerelle au moment où elle la prend), pas sur un vieux statut résiduel.
  if (!l || !lancementAttendu || (l.quand || 0) < lancementAttendu) return;
  lancementAttendu = 0;
  b.disabled = false;
  const quand = l.quand
    ? " à " + new Date(l.quand).toLocaleTimeString("fr-CA",
        { hour: "2-digit", minute: "2-digit" })
    : "";
  statutLancement({
    lance: `Chaîne lancée${quand} sur BG001 — nouveaux candidats et ` +
           `brouillons vont apparaître ici dans quelques minutes.`,
    erreur: `Échec du lancement${l.resume ? " : " + l.resume : ""}.`,
  }[l.etat] || `Chaîne d'acquisition : ${l.etat || "état inconnu"}.`);
}

$("btn-lancer-prospecteur").addEventListener("click", () => {
  if (!uidCourant) { avis("Connexion requise pour lancer le prospecteur.", true); return; }
  if (!confirm(
    "Lancer la chaîne d'acquisition sur BG001 ?\n\n" +
    "1. Le recherchiste cherche de nouveaux clients potentiels.\n" +
    "2. Le prospecteur rédige les courriels personnalisés des prospects dus.\n\n" +
    "Les nouveaux candidats attendent ton acceptation avant d'obtenir un " +
    "courriel. Aucun courriel ne part : chaque envoi reste un clic manuel " +
    "dans Thunderbird."
  )) return;
  const b = $("btn-lancer-prospecteur");
  b.disabled = true;
  lancementAttendu = maintenant();
  statutLancement("Demande envoyée à BG001…");
  setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
    { demandeLancement: { geste: "lancer", maj: maintenant() } }, { merge: true })
    .catch((e) => {
      lancementAttendu = 0; b.disabled = false;
      statutLancement("");
      avis("Demande refusée : " + e.message, true);
    });
  // Filet : sans passerelle active, aucun accusé ne viendra rallumer le bouton.
  const demande = lancementAttendu;
  setTimeout(() => {
    if (lancementAttendu === demande) {
      lancementAttendu = 0; b.disabled = false;
      statutLancement("Pas de réponse de BG001 — la passerelle de prospection tourne-t-elle ?");
    }
  }, 15000);
});

let desabonner = null;
let desabonnerLancements = null;
let desabonnerProspection = null;
let desabonnerCourriels = null;

onAuthStateChanged(auth, (user) => {
  if (desabonner) { desabonner(); desabonner = null; }
  if (desabonnerLancements) { desabonnerLancements(); desabonnerLancements = null; }
  if (desabonnerProspection) { desabonnerProspection(); desabonnerProspection = null; }
  if (desabonnerCourriels) { desabonnerCourriels(); desabonnerCourriels = null; }

  if (!user) {
    userDocRef = null;
    uidCourant = null;
    lancements = new Map();
    prospection = null;
    dernierEcrit = null;
    state = VIDE();
    $("auth-gate").hidden = false;
    $("app").hidden = true;
    $("btn-logout").hidden = true;
    $("qui").hidden = true;
    return;
  }

  $("auth-gate").hidden = true;
  $("app").hidden = false;
  $("btn-logout").hidden = false;
  $("qui").hidden = false;
  $("qui").innerHTML = `<b>${ech(user.displayName || "Connecté")}</b>${ech(user.email || "")}`;

  userDocRef = doc(db, "users", user.uid, "marketing", "state");

  // Affichage instantané depuis le cache local pendant que Firestore répond.
  state = lireLocal();
  rendre();
  etatSync("connexion…");

  desabonner = onSnapshot(userDocRef, appliquerInstantane, (e) => {
    etatSync("erreur");
    avis("Lecture Firestore refusée : " + e.message + ". Les règles du bloc " +
         "MARKETING sont-elles publiées ?", true);
  });

  // Miroir de prospection publié par le prospecteur de BG001. Son absence
  // n'empêche rien : le volet reste simplement caché.
  desabonnerProspection = onSnapshot(doc(db, "users", user.uid, "marketing", "prospection"),
    (snap) => {
      prospection = snap.exists() ? snap.data() : null;
      rendreProspection();
      majStatutLancement(prospection);   // hors de rendreProspection : celui-ci
    },                                   // sort tôt quand le journal est vide
    () => { prospection = null; });

  // Courriels de prospection déjà rédigés sur BG001. Absents (passerelle
  // arrêtée, aucun batch), le bloc reste simplement caché.
  desabonnerCourriels = onSnapshot(doc(db, "users", user.uid, "marketing", "courriels-msi"),
    (snap) => { courrielsMsi = snap.exists() ? snap.data() : null; rendreProspection(); },
    () => { courrielsMsi = null; });

  // File de lancement Claude : seuls les documents portant demandeLe sont des
  // lancements — le document « state » n'en a pas et reste hors de la requête.
  uidCourant = user.uid;
  const reqLancements = query(collection(db, "users", user.uid, "marketing"),
    orderBy("demandeLe", "desc"), limit(30));
  desabonnerLancements = onSnapshot(reqLancements, (snap) => {
    lancements = new Map();
    snap.forEach((d) => {
      const l = d.data();
      if (!l || !l.idTache) return;
      const p = lancements.get(l.idTache);
      if (!p || (l.demandeLe || 0) > (p.demandeLe || 0)) {
        lancements.set(l.idTache, { ...l, docId: d.id });
      }
    });
    rendre();
  }, () => { /* lanceur absent ou index en création : l'outil reste utilisable */ });
});

/* Le minuteur en cours doit rester visible sans recharger la page. */
setInterval(() => { if (minuteur()) rendre(); }, 60000);

window.addEventListener("beforeunload", () => {
  const m = minuteur();
  if (!m) return;
  const minutes = Math.round((Date.now() - m.debut) / 60000);
  if (minutes < 1) return;
  // Consigné localement : Firestore reprendra au prochain chargement.
  ajouterTemps(m.id, minutes, "minuteur");
  try { localStorage.removeItem(CLE_MINUTEUR); } catch {}
});
