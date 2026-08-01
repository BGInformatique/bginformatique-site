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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";

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
const LIB_LANCEMENT = {
  demande: "Claude · demandé", en_cours: "Claude · en cours…",
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
let filtreClient = "", filtreChantier = "", filtreStatut = "actives", filtreTexte = "";
const ouvertes = new Set();

// Dernier lancement Claude par tâche (idTache -> doc lancement-*).
let uidCourant = null;
let lancements = new Map();

// Volet Prospection : miroir du journal tenu par le prospecteur sur BG001
// (document marketing/prospection). La page le lit, et peut y déposer un
// « signal » (répondu, RDV fixé…) que le prospecteur applique au journal
// TSV au cycle suivant. Les brouillons de relance, eux, sont des tâches.
let prospection = null;

const LIB_PROSP = {
  a_contacter: "À contacter", contact_prepare: "1er contact prêt",
  contacte_sans_reponse: "Sans réponse", relance_preparee: "Relance prête",
  relance_envoyee: "Relance envoyée", repondu: "A répondu",
  rdv_fixe: "RDV fixé", dormant: "Dormant", client: "Client",
  abandonne: "Abandonné",
};
const CLASSE_PROSP = {
  contact_prepare: "en_cours", relance_preparee: "en_cours",
  repondu: "fait", rdv_fixe: "fait", client: "fait",
  dormant: "reporte", abandonne: "bloque",
};

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

function carte(t, contexte) {
  const m = minuteur(), actif = m && m.id === t.id;
  const auj = jourISO();
  const total = somme(state.temps.filter((e) => e.idTache === t.id));
  const dujour = somme(state.temps.filter((e) => e.idTache === t.id && e.date === auj));
  const epingle = t.jour === auj;
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
  const lcOccupe = lc && (lc.statut === "demande" || lc.statut === "en_cours");

  const el = document.createElement("div");
  el.className = "carte" + (t.statut === "fait" ? " fait" : "") +
    (actif ? " actif" : "") + (ouvertes.has(t.id) ? " ouvert" : "");
  el.innerHTML = `
    <div class="prio ${ech(t.priorite)}"></div>
    <div class="corps">
      <div class="titre-t" data-bascule>${ech(t.titre)}</div>
      ${t.detail ? `<div class="detail">${ech(t.detail)}</div>` : ""}
      ${t.source ? `<div class="source">// ${ech(t.source)}</div>` : ""}
      ${lc && (lc.resultat || lc.erreur) ? `<div class="cl-resultat${lc.erreur ? " err" : ""}">
        <div class="cl-entete">// Claude — ${lc.erreur ? "échec" : "résultat"}${lc.finiLe ? " · " + ech(new Date(lc.finiLe).toLocaleString("fr-CA")) : ""}</div>
        ${ech(lc.erreur || lc.resultat)}</div>` : ""}
      <div class="etiq">${pil.join("")}</div>
    </div>
    <div class="outils">
      <button class="ic ${t.statut === "fait" ? "on" : ""}" data-fait title="${t.statut === "fait" ? "Remettre à faire" : "Marquer faite"}">
        <svg><use href="#i-coche"></use></svg></button>
      <button class="ic ${actif ? "on" : ""}" data-chrono title="${actif ? "Arrêter le minuteur" : "Démarrer le minuteur"}">
        <svg><use href="#${actif ? "i-stop" : "i-lire"}"></use></svg></button>
      <button class="ic ${lcOccupe ? "on" : ""}" data-claude title="${t.chantier === "LinkedIn"
        ? "Ouvrir la page du lot LinkedIn (tous les posts)"
        : lcOccupe ? "Annuler le lancement Claude en cours" : "Lancer cette tâche avec Claude sur BG001"}">
        <svg><use href="#i-eclair"></use></svg></button>
      <button class="ic" data-manuel title="Consigner du temps à la main">
        <svg><use href="#i-plus"></use></svg></button>
      ${contexte === "tout" ? `<button class="ic ${epingle ? "on" : ""}" data-epingle title="${epingle ? "Retirer d'aujourd'hui" : "Épingler à aujourd'hui"}">
        <svg><use href="#i-epingle"></use></svg></button>` : ""}
      <button class="ic" data-modifier title="Modifier"><svg><use href="#i-crayon"></use></svg></button>
    </div>`;

  el.querySelector("[data-bascule]").onclick = () => {
    ouvertes.has(t.id) ? ouvertes.delete(t.id) : ouvertes.add(t.id);
    rendre();
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
  el.querySelector("[data-manuel]").onclick = () => {
    const v = prompt(`Combien de minutes consigner sur « ${t.titre} » ?`, "30");
    if (v === null) return;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) ajouterTemps(t.id, n, "saisie manuelle");
  };
  el.querySelector("[data-modifier]").onclick = () => ouvrirModale(t);
  const bEp = el.querySelector("[data-epingle]");
  if (bEp) bEp.onclick = () => enregistrerTache({ id: t.id, jour: epingle ? "" : auj });
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

function rendreProspection() {
  const liste = (prospection && prospection.prospects) || [];
  $("prospection").hidden = !liste.length;
  if (!liste.length) return;
  const signaux = (prospection && prospection.signaux) || {};
  $("p-maj").textContent = prospection.majLe
    ? `journal du ${new Date(prospection.majLe).toLocaleDateString("fr-CA")} — ` +
      "cliquer un prospect pour voir ses tâches"
    : "";
  const cible = $("p-liste");
  cible.innerHTML = "";
  for (const p of liste) {
    // Ce que la page sait de plus frais que le miroir hebdomadaire : un signal
    // déposé ici, ou la tâche de relance déjà marquée faite (envoi confirmé).
    const t = p.tacheId ? state.taches.find((x) => x.id === p.tacheId) : null;
    const envoye = t && t.statut === "fait";
    const sig = signaux[p.id] && signaux[p.id].statut;
    const statut = sig || (envoye ? "relance_envoyee" : p.statut);
    const el = document.createElement("div");
    el.className = "p-carte";
    el.innerHTML = `
      <div class="p-nom">${ech(p.prospect)}</div>
      <div class="etiq">
        <span class="pil ${CLASSE_PROSP[statut] || ""}">${LIB_PROSP[statut] || ech(statut)}</span>
        ${p.relances ? `<span class="pil">${p.relances} relance${p.relances > 1 ? "s" : ""}</span>` : ""}
      </div>
      <div class="p-note">${sig ? "signalé — le journal suivra au prochain cycle"
        : envoye ? "envoi noté — journal à jour au prochain cycle"
        : p.prochaine ? "prochaine action : " + ech(p.prochaine) : ""}</div>
      <select class="p-sig" title="Signaler un changement d'état au prospecteur">
        <option value="">signaler…</option>
        <option value="repondu">a répondu</option>
        <option value="rdv_fixe">rendez-vous fixé</option>
        <option value="client">devenu client</option>
        <option value="dormant">mettre en dormance</option>
        <option value="a_contacter">réactiver la cadence</option>
      </select>`;
    if (p.note) el.title = p.note;
    el.onclick = (ev) => {
      if (ev.target.closest("select")) return;
      filtreTexte = p.prospect.toLowerCase();
      $("f-texte").value = p.prospect;
      filtreChantier = "";
      filtreStatut = "";
      rendre();
      $("l-tout").scrollIntoView({ behavior: "smooth" });
    };
    el.querySelector(".p-sig").onchange = (ev) => {
      const v = ev.target.value;
      if (!v || !uidCourant) return;
      setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
        { signaux: { [p.id]: { statut: v, maj: maintenant() } } }, { merge: true })
        .catch((e) => avis("Signal refusé : " + e.message, true));
    };
    cible.appendChild(el);
  }

  /* Candidats du recherchiste : rien n'entre dans la cadence sans un
     Accepter explicite ; un Rejeter est définitif (jamais reproposé). */
  const cands = (prospection && prospection.candidats) || [];
  const decisions = (prospection && prospection.candidatures) || {};
  const ajouts = (prospection && prospection.ajouts) || {};
  $("p-candidats").hidden = !cands.length && !Object.keys(ajouts).length;
  const zc = $("p-cand-liste");
  zc.innerHTML = "";
  for (const c of cands) {
    const d = decisions[c.id] && decisions[c.id].decision;
    const el = document.createElement("div");
    el.className = "p-carte p-cand-carte";
    el.innerHTML = `
      <div class="p-nom">${ech(c.nom)}</div>
      <div class="etiq">
        ${c.secteur ? `<span class="pil">${ech(c.secteur)}</span>` : ""}
        ${c.ville ? `<span class="pil">${ech(c.ville)}</span>` : ""}
        ${c.taille ? `<span class="pil">${ech(c.taille)}</span>` : ""}
      </div>
      <div class="p-note">${ech(c.angle || "")}</div>
      ${/^https?:\/\//.test(c.site || "") ? `<a class="p-lien" href="${ech(c.site)}"
        target="_blank" rel="noopener noreferrer">${ech(c.site)}</a>` : ""}
      ${d ? `<div class="p-note">${d === "accepte"
          ? "accepté — en cadence au prochain cycle"
          : "rejeté — ne sera plus proposé"}</div>`
        : `<div class="p-actions">
             <button type="button" class="btn p-btn" data-d="accepte">Accepter</button>
             <button type="button" class="btn btn-ghost p-btn" data-d="rejete">Rejeter</button>
           </div>`}`;
    el.querySelectorAll("[data-d]").forEach((b) => {
      b.onclick = () => {
        if (!uidCourant) return;
        setDoc(doc(db, "users", uidCourant, "marketing", "prospection"),
          { candidatures: { [c.id]: { decision: b.dataset.d, maj: maintenant() } } },
          { merge: true })
          .catch((e) => avis("Décision refusée : " + e.message, true));
      };
    });
    zc.appendChild(el);
  }
  for (const a of Object.values(ajouts)) {
    const el = document.createElement("div");
    el.className = "p-carte p-cand-carte";
    el.innerHTML = `<div class="p-nom">${ech(a.nom || "")}</div>
      <div class="p-note">ajout manuel — en cadence au prochain cycle</div>`;
    zc.appendChild(el);
  }
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

  /* ── aujourd'hui ── */
  const duJour = taches.filter((t) => t.jour === auj).sort(trier);
  remplir($("l-jour"), duJour, "jour",
    "Rien d'épinglé. Choisis à droite ce que tu attaques aujourd'hui.");
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
  boutons("f-client", [["", "Tous les mandats"], ...clients.map((c) => [c, c])],
    filtreClient, (v) => { filtreClient = v; });

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

let desabonner = null;
let desabonnerLancements = null;
let desabonnerProspection = null;

onAuthStateChanged(auth, (user) => {
  if (desabonner) { desabonner(); desabonner = null; }
  if (desabonnerLancements) { desabonnerLancements(); desabonnerLancements = null; }
  if (desabonnerProspection) { desabonnerProspection(); desabonnerProspection = null; }

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
    (snap) => { prospection = snap.exists() ? snap.data() : null; rendreProspection(); },
    () => { prospection = null; });

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
