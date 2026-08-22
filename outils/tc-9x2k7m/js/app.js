/*
 * TimeCalculator — feuille de temps (punch in/out) et journal des
 * interventions techniques.
 *
 * Deux registres indépendants :
 *  - punches : périodes travaillées, enregistrées sans aucune question
 *    au punch out — c'est la feuille de temps;
 *  - interventions : travaux décrits pour un client (client, billet,
 *    catégorie, description, facturable, à vérifier), inscrites soit
 *    manuellement, soit au chronomètre : « Démarrer » part du moment présent
 *    et les détails se remplissent à la fin, quand on sait ce qui a été fait.
 *
 * Le regroupement par billet, client ou catégorie se fait EN LECTURE SEULE,
 * à l'affichage et à l'export : aucune intervention n'est jamais fusionnée,
 * réécrite, ni dotée d'heures qui n'ont pas existé.
 *
 * Données : localStorage (clé "timecalculator.v1") + Firestore par compte
 * Microsoft. La synchro fusionne ENREGISTREMENT PAR ENREGISTREMENT (voir
 * mergeStates) : deux appareils qui modifient des choses différentes ne
 * s'écrasent plus l'un l'autre.
 */
"use strict";

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

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Cache persistant : sans lui, le travail fait hors ligne (salle de serveurs,
// client sans Wi-Fi) ne survit pas à la fermeture de l'onglet. Le gestionnaire
// multi-onglets évite en plus que deux onglets se disputent la connexion.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const STORAGE_KEY = "timecalculator.v1";
// Copie de l'état remplacé par un import, au cas où ce serait le mauvais fichier.
const IMPORT_BACKUP_KEY = "timecalculator.v1.avant-import";
// Une chaîne illisible est mise de côté au lieu d'être écrasée : elle reste récupérable.
const QUARANTINE_PREFIX = "timecalculator.v1.illisible.";

// Un chronomètre encore ouvert après ce délai — punch ou intervention — est
// presque toujours un arrêt oublié.
const CHRONO_OUBLIE_MS = 12 * 3600 * 1000;

// Les pierres tombales plus vieilles que ça sont élaguées : elles n'ont plus
// d'appareil à convaincre, et elles feraient gonfler le document indéfiniment.
const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;

/* ---------- État ---------- */

// state.activePunch    : { start: ms } ou null
// state.activePunchAt  : ms — dernier changement de activePunch (arbitrage entre appareils)
// state.activeInterventions  : [{ id, start, client, updatedAt }] — chronos
//                        d'intervention en marche, plusieurs à la fois. Ils se
//                        fusionnent enregistrement par enregistrement comme les
//                        autres registres, pierres tombales comprises.
// state.punches        : [{ id, start, end, updatedAt }]
// state.interventions  : [{ id, start, end, client, ticket, category, description,
//                           billable, toVerify, verifyNote, updatedAt }]
// state.tombstones     : { id: ms } — enregistrements supprimés, pour que la
//                        fusion ne les ressuscite pas depuis l'autre appareil
// state.updatedAt      : ms — dernière modification locale, tous registres confondus

// Avis à afficher dès que le DOM est prêt (load() s'exécute avant le rendu).
const pendingBanners = [];

let state = load();
let timerInterval = null;

// Journée en cours : seule journée dépliée par défaut dans la feuille de
// temps. Les choix manuels (déplier/replier) valent pour la session.
let todayKey = dateISO(new Date());
const dayOverrides = new Map();
// À l'impression, toutes les journées sont dépliées quel que soit l'état à l'écran.
let printing = false;

function emptyState() {
  return {
    activePunch: null,
    activePunchAt: 0,
    activeInterventions: [],
    punches: [],
    interventions: [],
    tombstones: {},
    updatedAt: 0,
  };
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    pendingBanners.push({
      id: "storage",
      tone: "danger",
      text:
        "Le navigateur refuse l'accès au stockage local (navigation privée ou paramètre de confidentialité). " +
        "Rien ne sera conservé sur cet appareil — la synchro infonuagique reste votre seul filet.",
    });
    return emptyState();
  }
  if (!raw) return emptyState();

  let data = null;
  try {
    data = JSON.parse(raw);
    if (!data || (!Array.isArray(data.punches) && !Array.isArray(data.interventions))) {
      throw new Error("structure inattendue");
    }
  } catch (e) {
    quarantine(raw, e);
    return emptyState();
  }

  const { state: next, rejets } = normalizeState(data);
  if (rejets > 0) {
    pendingBanners.push({
      id: "rejets",
      tone: "warn",
      text: `${rejets} enregistrement${rejets > 1 ? "s" : ""} illisible${rejets > 1 ? "s ont" : " a"} été écarté${rejets > 1 ? "s" : ""} au chargement (date ou durée invalide). Rien n'a été renvoyé vers l'infonuagique avant votre vérification.`,
    });
    // Tant que des rejets n'ont pas été arbitrés, on ne pousse rien : sinon
    // l'appareil qui a mal lu ses données les amputerait aussi pour l'autre.
    syncBloquee = true;
  }
  return next;
}

// Met la chaîne illisible de côté plutôt que de la laisser se faire écraser
// par le premier Punch In : tant qu'elle existe, elle reste récupérable.
function quarantine(raw, err) {
  const key = QUARANTINE_PREFIX + dateISO(new Date()) + "-" + Date.now();
  let sauve = false;
  try {
    localStorage.setItem(key, raw);
    sauve = true;
  } catch (e) {
    /* quota plein : on n'a pas mieux à offrir que l'avertissement */
  }
  // Un état vide ne doit jamais partir vers Firestore : il effacerait le
  // document réel dès la première écriture.
  syncBloquee = true;
  pendingBanners.push({
    id: "corrompu",
    tone: "danger",
    text:
      "Les données locales sont illisibles (" + err.message + "). La synchronisation vers l'infonuagique est " +
      "SUSPENDUE pour ne pas effacer vos données en ligne. " +
      (sauve
        ? `La version d'origine est conservée sous « ${key} » dans le stockage de ce navigateur.`
        : "Elle n'a pas pu être mise de côté (stockage plein)."),
  });
}

// Écarte les enregistrements inutilisables au lieu de les laisser produire
// des « NaN h » partout. Conserve tous les autres champs tels quels : la
// liste des champs connus n'est PAS une liste blanche, sans quoi toVerify,
// verifyNote ou tout champ ajouté plus tard seraient amputés au chargement.
function normalizeState(data) {
  let rejets = 0;

  const punches = [];
  for (const p of Array.isArray(data.punches) ? data.punches : []) {
    const clean = sanePeriod(p);
    if (clean) punches.push(clean);
    else rejets++;
  }

  const interventions = [];
  for (const i of Array.isArray(data.interventions) ? data.interventions : []) {
    const clean = sanePeriod(i);
    if (!clean) {
      rejets++;
      continue;
    }
    const record = {
      ...i,
      ...clean,
      clients: strList(i.clients, i.client),
      ticket: str(i.ticket),
      category: str(i.category) || "Autre",
      description: typeof i.description === "string" ? i.description : "",
      billable: i.billable !== false,
      toVerify: i.toVerify === true,
      verifyNote: typeof i.verifyNote === "string" ? i.verifyNote : "",
    };
    // L'ancien champ `client` (chaîne unique) ne doit pas survivre au spread
    // de `...i` — sinon un vieil enregistrement le garde indéfiniment à côté
    // du nouveau `clients`, et Firestore n'accepte pas `undefined` : delete,
    // pas une réaffectation.
    delete record.client;
    interventions.push(record);
  }

  let activePunch = null;
  if (data.activePunch && Number.isFinite(Number(data.activePunch.start))) {
    activePunch = { start: Number(data.activePunch.start) };
  }

  // Chronos d'intervention en marche. L'ancien format n'en portait qu'un
  // (activeIntervention) : il est repris, avec un identifiant DÉDUIT de son
  // heure de départ — deux appareils qui font la conversion chacun de leur
  // côté fabriquent ainsi le même, et la fusion n'en fait pas deux copies.
  const activeInterventions = [];
  const vus = new Set();
  const ajouteChrono = (id, start, client, updatedAt) => {
    if (!Number.isFinite(start) || vus.has(id)) return;
    vus.add(id);
    activeInterventions.push({ id, start, client, updatedAt: updatedAt || start });
  };
  for (const c of Array.isArray(data.activeInterventions) ? data.activeInterventions : []) {
    if (!c || typeof c !== "object") continue;
    const start = Number(c.start);
    ajouteChrono(str(c.id) || "chrono-" + start, start, str(c.client), num(c.updatedAt));
  }
  if (data.activeIntervention && Number.isFinite(Number(data.activeIntervention.start))) {
    const start = Number(data.activeIntervention.start);
    ajouteChrono("chrono-" + start, start, "", num(data.activeInterventionAt));
  }
  activeInterventions.sort((a, b) => a.start - b.start);

  const tombstones = {};
  if (data.tombstones && typeof data.tombstones === "object") {
    const limite = Date.now() - TOMBSTONE_TTL_MS;
    for (const [id, at] of Object.entries(data.tombstones)) {
      const ms = Number(at);
      if (Number.isFinite(ms) && ms > limite) tombstones[id] = ms;
    }
  }

  return {
    state: {
      activePunch,
      activePunchAt: num(data.activePunchAt),
      activeInterventions,
      punches,
      interventions,
      tombstones,
      updatedAt: num(data.updatedAt),
    },
    rejets,
  };
}

function sanePeriod(r) {
  if (!r || typeof r !== "object") return null;
  const start = Number(r.start);
  const end = Number(r.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // Un identifiant manquant est réparé, pas motif à rejet : l'enregistrement
  // porte du temps travaillé, ce serait absurde de le jeter pour si peu.
  return { id: str(r.id) || genId(), start, end, updatedAt: num(r.updatedAt) };
}

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

// Normalise le champ client d'une intervention en tableau de noms uniques, non
// vides, dans leur ordre d'origine. Migre l'ancien format (un seul `client`
// en chaîne, d'avant le support multi-client) vers `clients: [nom]`.
function strList(clients, legacyClient) {
  const source = Array.isArray(clients) ? clients : legacyClient != null ? [legacyClient] : [];
  const seen = new Set();
  const out = [];
  for (const v of source) {
    const name = str(v);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Découpe le champ texte "Client" (noms séparés par des virgules) en une
// liste de clients uniques, dans l'ordre de saisie.
function parseClients(text) {
  return strList(String(text || "").split(","));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ---------- Fusion entre appareils ---------- */

/*
 * Fusion ENREGISTREMENT PAR ENREGISTREMENT, et non document par document.
 *
 * L'ancienne synchro remplaçait tout l'état par celui qui arrivait : le poste
 * et le cellulaire s'écrasaient mutuellement dès qu'ils touchaient à des
 * choses différentes. Ici, l'union des deux côtés est prise par identifiant,
 * la version au updatedAt le plus récent l'emporte, et une pierre tombale
 * postérieure supprime l'enregistrement. Conséquence : une fusion ne peut
 * jamais faire disparaître un enregistrement qui n'a pas été explicitement
 * supprimé quelque part.
 */
function mergeStates(local, remote) {
  const tombstones = { ...local.tombstones };
  for (const [id, at] of Object.entries(remote.tombstones || {})) {
    if (!tombstones[id] || at > tombstones[id]) tombstones[id] = at;
  }

  const fusionner = (listeA, listeB) => {
    const parId = new Map();
    for (const r of [...listeA, ...listeB]) {
      const existant = parId.get(r.id);
      if (!existant || r.updatedAt > existant.updatedAt) parId.set(r.id, r);
    }
    const out = [];
    for (const r of parId.values()) {
      const efface = tombstones[r.id];
      // La suppression ne l'emporte que si elle est postérieure à la version
      // conservée : rééditer un enregistrement supprimé ailleurs le ramène.
      if (efface && efface >= r.updatedAt) continue;
      out.push(r);
    }
    return out.sort((a, b) => a.start - b.start);
  };

  const activeDepuisRemote = num(remote.activePunchAt) > num(local.activePunchAt);
  return {
    activePunch: activeDepuisRemote ? remote.activePunch : local.activePunch,
    activePunchAt: Math.max(num(local.activePunchAt), num(remote.activePunchAt)),
    // Les chronos d'intervention passent par la fusion normale : démarrer sur
    // le cellulaire pendant qu'un autre tourne sur le poste garde les deux, et
    // seul un arrêt explicite (pierre tombale) en retire un.
    activeInterventions: fusionner(local.activeInterventions || [], remote.activeInterventions || []),
    punches: fusionner(local.punches, remote.punches),
    interventions: fusionner(local.interventions, remote.interventions),
    tombstones,
    updatedAt: Math.max(num(local.updatedAt), num(remote.updatedAt)),
  };
}

// Deux états sont-ils équivalents ? Sert à savoir si la fusion a apporté
// quelque chose que l'autre côté n'a pas encore.
function sameState(a, b) {
  const cle = (s) =>
    JSON.stringify([
      s.activePunch ? s.activePunch.start : null,
      (s.activeInterventions || []).map((c) => [c.id, c.start, c.client, c.updatedAt]),
      s.punches.map((p) => [p.id, p.start, p.end, p.updatedAt]),
      s.interventions.map((i) => [
        i.id, i.start, i.end, i.clients, i.ticket, i.category,
        i.description, i.billable, i.toVerify, i.verifyNote, i.updatedAt,
      ]),
      Object.entries(s.tombstones).sort(),
    ]);
  return cle(a) === cle(b);
}

/* ---------- Enregistrement ---------- */

let userDocRef = null;
let applyingRemote = false;
// Vrai quand l'état local est suspect : on ne pousse rien vers Firestore.
let syncBloquee = false;
// Dernière chaîne écrite par cet onglet, pour ignorer nos propres échos.
let lastWritten = null;

// Marque un enregistrement comme modifié maintenant : c'est cet horodatage
// qui arbitre la fusion entre appareils.
function touch(record) {
  record.updatedAt = Date.now();
  return record;
}

function persistLocal() {
  const chaine = JSON.stringify(state);
  localStorage.setItem(STORAGE_KEY, chaine);
  lastWritten = chaine;
}

// Renvoie false si l'écriture locale a échoué : l'appelant doit alors annuler
// son changement en mémoire plutôt que de laisser croire qu'il est enregistré.
function save() {
  const avant = state.updatedAt;
  state.updatedAt = Date.now();
  try {
    persistLocal();
    dismissBanner("save");
  } catch (e) {
    state.updatedAt = avant;
    banner({
      id: "save",
      tone: "danger",
      text:
        "Impossible d'enregistrer sur cet appareil : " + e.message + ". Le dernier changement a été annulé " +
        "pour ne rien fausser. Faites une sauvegarde JSON, puis libérez de l'espace avant de continuer.",
    });
    return false;
  }
  syncUp();
  return true;
}

// Envoi vers Firestore : au mieux, jamais bloquant. Un échec est signalé,
// pas noyé dans la console — le cache persistant réémettra l'écriture.
function syncUp() {
  if (!userDocRef || applyingRemote) return;
  if (syncBloquee) return;
  setDoc(userDocRef, state)
    .then(() => dismissBanner("sync"))
    .catch((e) => {
      banner({
        id: "sync",
        tone: "warn",
        text:
          "Synchronisation infonuagique en attente (" + e.message + "). Vos données sont enregistrées sur cet " +
          "appareil et repartiront au retour de la connexion.",
      });
    });
}

function genId() {
  return String(Date.now()) + Math.random().toString(36).slice(2, 7);
}

/* ---------- Utilitaires date/durée ---------- */

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeHM(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayLabel(d) {
  const s = d.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function minutesBetween(startMs, endMs) {
  return Math.round((endMs - startMs) / 60000);
}

function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${pad(m)}`;
}

function fmtDecimalHours(minutes) {
  return (minutes / 60).toFixed(2).replace(".", ",");
}

// Répartit `total` minutes en `n` parts entières dont la somme reste
// exactement `total` (méthode du plus grand reste) : les `reste` premiers
// éléments reçoivent 1 minute de plus que les autres.
function splitMinutesEvenly(total, n) {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const reste = total - base * n;
  return Array.from({ length: n }, (_, idx) => base + (idx < reste ? 1 : 0));
}

// Part de minutes attribuée à chaque client nommé d'UNE intervention,
// répartition égale. Point de calcul unique, réutilisé par le sommaire à
// l'écran groupé par client et par le sommaire de facturation par billet du
// rapport hebdomadaire, pour que les deux vues restent cohérentes entre
// elles. `minutesBetween` n'est appelé qu'une fois ici, jamais recalculé par
// client.
function clientMinuteShares(i) {
  const clients = i.clients && i.clients.length ? i.clients : ["(sans client)"];
  const parts = splitMinutesEvenly(minutesBetween(i.start, i.end), clients.length);
  return clients.map((client, idx) => ({ client, minutes: parts[idx] }));
}

// Arrondi au quart d'heure le plus près, l'égalité tranchée vers le haut :
// 7 min 30 devient 15 min, jamais 0. Le + 0.5 avant le plancher, plutôt que
// Math.round, pour que la règle soit celle-là et pas celle du moteur JS.
// Un seul arrondi, sur le total : arrondir chaque ligne puis additionner
// donnerait un autre nombre, et c'est le total qu'on facture.
function roundToQuarterHour(minutes) {
  return Math.floor(minutes / 15 + 0.5) * 15;
}

/* Toute l'arithmétique de dates passe par le calendrier local et jamais par
 * des additions de millisecondes : « le lendemain à 6 h » n'est pas « dans
 * 24 h » les nuits de changement d'heure (mars et novembre au Québec). */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Début de semaine (lundi)
function startOfWeek(d) {
  const day = (d.getDay() + 6) % 7; // lundi = 0
  return addDays(startOfDay(d), -day);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/* ---------- Éléments ---------- */

const $ = (id) => document.getElementById(id);

const els = {
  banners: $("banners"),
  printMeta: $("print-meta"),
  statusDot: $("status-dot"),
  statusLabel: $("status-label"),
  statusDetail: $("status-detail"),
  punchTimer: $("punch-timer"),
  btnPunchIn: $("btn-punch-in"),
  btnPunchOut: $("btn-punch-out"),
  btnCancelPunch: $("btn-cancel-punch"),
  // Intervention chronométrée
  interventionDot: $("intervention-dot"),
  interventionLabel: $("intervention-label"),
  interventionDetail: $("intervention-detail"),
  interventionList: $("intervention-list"),
  btnStartIntervention: $("btn-start-intervention"),
  statToday: $("stat-today"),
  statWeek: $("stat-week"),
  statMonth: $("stat-month"),
  filterPeriod: $("filter-period"),
  customRange: $("custom-range"),
  filterFrom: $("filter-from"),
  filterTo: $("filter-to"),
  rangeLabel: $("range-label"),
  filterClient: $("filter-client"),
  filterToVerify: $("filter-to-verify"),
  btnExportReport: $("btn-export-report"),
  btnSimpleReport: $("btn-simple-report"),
  btnPrint: $("btn-print"),
  btnExportJson: $("btn-export-json"),
  btnImport: $("btn-import"),
  inputImport: $("input-import"),
  // Feuille de temps
  btnToggleDays: $("btn-toggle-days"),
  btnAddPunch: $("btn-add-punch"),
  btnExportPunches: $("btn-export-punches"),
  punchTotal: $("punch-total"),
  punchTbody: $("punch-tbody"),
  punchEmpty: $("punch-empty"),
  punchDialog: $("punch-dialog"),
  punchDialogTitle: $("punch-dialog-title"),
  punchForm: $("punch-form"),
  pId: $("p-id"),
  pDate: $("p-date"),
  pStart: $("p-start"),
  pEnd: $("p-end"),
  pDuration: $("p-duration"),
  pError: $("p-error"),
  btnPunchDialogCancel: $("btn-punch-dialog-cancel"),
  // Interventions
  btnAddIntervention: $("btn-add-intervention"),
  btnExportInterventions: $("btn-export-interventions"),
  interventionTotal: $("intervention-total"),
  interventionTbody: $("intervention-tbody"),
  interventionEmpty: $("intervention-empty"),
  interventionDialog: $("intervention-dialog"),
  interventionDialogTitle: $("intervention-dialog-title"),
  interventionForm: $("intervention-form"),
  fId: $("f-id"),
  fDate: $("f-date"),
  fStart: $("f-start"),
  fEnd: $("f-end"),
  fDuration: $("f-duration"),
  fClient: $("f-client"),
  fTicket: $("f-ticket"),
  clientList: $("client-list"),
  ticketList: $("ticket-list"),
  fCategory: $("f-category"),
  fDescription: $("f-description"),
  fBillable: $("f-billable"),
  fToVerify: $("f-to-verify"),
  fVerifyNoteWrap: $("f-verify-note-wrap"),
  fVerifyNote: $("f-verify-note"),
  fError: $("f-error"),
  btnInterventionDialogCancel: $("btn-intervention-dialog-cancel"),
  // Sommaire de facturation
  groupBy: $("group-by"),
  groupHead: $("group-head"),
  summaryTbody: $("summary-tbody"),
  summaryEmpty: $("summary-empty"),
  btnExportSummary: $("btn-export-summary"),
};

/* ---------- Avis persistants ---------- */

/* Un toast disparaît tout seul : parfait pour « filtre changé », inacceptable
 * pour « impossible d'enregistrer ». Les deux coexistent donc : showToast pour
 * l'information fugace, les bannières pour ce qui exige une décision. */

const activeBanners = new Map();

function banner(opts) {
  activeBanners.set(opts.id, opts);
  renderBanners();
}

function dismissBanner(id) {
  if (activeBanners.delete(id)) renderBanners();
}

function renderBanners() {
  els.banners.innerHTML = "";
  for (const b of activeBanners.values()) {
    const div = document.createElement("div");
    div.className = `banner banner-${b.tone || "info"}`;
    const p = document.createElement("p");
    p.textContent = b.text;
    div.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "banner-actions";
    for (const a of b.actions || []) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = a.label;
      btn.addEventListener("click", a.run);
      actions.appendChild(btn);
    }
    const close = document.createElement("button");
    close.className = "btn btn-ghost";
    close.textContent = "Fermer";
    close.addEventListener("click", () => dismissBanner(b.id));
    actions.appendChild(close);
    div.appendChild(actions);

    els.banners.appendChild(div);
  }
}

/* ---------- Punch in / out ---------- */

function punchIn() {
  if (state.activePunch) return;
  state.activePunch = { start: Date.now() };
  state.activePunchAt = Date.now();
  if (!save()) {
    state.activePunch = null;
    return;
  }
  renderPunchCard();
  renderInterventionLive();
  renderStats();
}

// Le punch out enregistre la période directement, sans rien demander.
function punchOut() {
  if (!state.activePunch) return;
  const start = state.activePunch.start;
  // Minimum d'une minute pour qu'un punch très court reste visible.
  const end = Math.max(Date.now(), start + 60000);
  const record = touch({ id: genId(), start, end });

  state.punches.push(record);
  state.activePunch = null;
  state.activePunchAt = Date.now();
  if (!save()) {
    // L'écriture a échoué : on remet le punch en cours plutôt que de laisser
    // la période disparaître entre deux états.
    state.punches.pop();
    state.activePunch = { start };
    renderPunchCard();
    return;
  }
  render();
  // Le punch out ne touche pas aux chronos d'intervention : on le dit, sinon
  // ils tournent tout seuls après la fin de la journée.
  const enMarche = state.activeInterventions.length;
  if (enMarche > 0) {
    showToast(
      enMarche === 1
        ? "Punch out enregistré — l'intervention chronométrée continue de tourner."
        : `Punch out enregistré — les ${enMarche} interventions chronométrées continuent de tourner.`
    );
  }
}

function cancelPunch() {
  if (!state.activePunch) return;
  if (!confirm("Annuler le punch en cours ? Aucune période ne sera enregistrée.")) return;
  const previous = state.activePunch;
  state.activePunch = null;
  state.activePunchAt = Date.now();
  if (!save()) {
    state.activePunch = previous;
    return;
  }
  renderPunchCard();
  renderInterventionLive();
  renderStats();
}

function renderPunchCard() {
  const active = !!state.activePunch;
  // Punch out, annulation ou synchro : l'avis de punch oublié n'a plus d'objet.
  if (!active) dismissBanner("punch-oublie");
  els.statusDot.classList.toggle("active", active);
  els.btnPunchIn.hidden = active;
  els.btnPunchOut.hidden = !active;
  els.btnCancelPunch.hidden = !active;
  els.punchTimer.hidden = !active;

  if (active) {
    const start = new Date(state.activePunch.start);
    els.statusLabel.textContent = "Au travail";
    els.statusDetail.textContent = `Punch in à ${timeHM(start)} (${dateISO(start)})`;
    updateTimer();
  } else {
    els.statusLabel.textContent = "Hors service";
    els.statusDetail.textContent = "Appuyez sur « Punch In » pour commencer";
  }
  ensureChronoInterval();
}

// Un seul battement pour les deux chronomètres. Il tourne tant qu'au moins un
// des deux est en marche : arrêter le punch ne doit pas figer l'affichage de
// l'intervention en cours, et inversement.
function tickChronos() {
  updateTimer();
  updateInterventionTimers();
}

function ensureChronoInterval() {
  const besoin = !!state.activePunch || state.activeInterventions.length > 0;
  if (besoin && !timerInterval) {
    timerInterval = setInterval(tickChronos, 1000);
  } else if (!besoin && timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function chronoHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

let lastTimerMinute = -1;

function updateTimer() {
  if (!state.activePunch) return;
  const ecoule = Math.max(0, Date.now() - state.activePunch.start);
  els.punchTimer.textContent = chronoHMS(ecoule);
  // Le sommaire compte le punch en cours : on le rafraîchit à chaque minute.
  const minute = Math.floor(ecoule / 60000);
  if (minute !== lastTimerMinute) {
    lastTimerMinute = minute;
    renderStats();
  }
}

// Un punch out oublié le vendredi soir donne une période de 72 h imputée au
// vendredi. On le signale et on propose de corriger l'heure de fin.
function checkPunchOublie() {
  if (!state.activePunch) {
    dismissBanner("punch-oublie");
    return;
  }
  const depuis = Date.now() - state.activePunch.start;
  if (depuis < CHRONO_OUBLIE_MS) return;
  const start = new Date(state.activePunch.start);
  const heures = Math.floor(depuis / 3600000);
  banner({
    id: "punch-oublie",
    tone: "warn",
    text:
      `Un punch est ouvert depuis ${heures} h (début le ${dateISO(start)} à ${timeHM(start)}). ` +
      "S'il s'agit d'un punch out oublié, enregistrez la période avec la bonne heure de fin plutôt que de laisser courir le chronomètre.",
    actions: [
      {
        label: "Enregistrer avec la bonne heure de fin",
        run: () => {
          // Le punch en cours n'est fermé qu'après un enregistrement réussi :
          // annuler le dialogue ne fait pas disparaître l'heure de début.
          if (!state.activePunch) {
            dismissBanner("punch-oublie");
            return;
          }
          const s = new Date(state.activePunch.start);
          openPunchDialog({
            title: "Corriger la période oubliée",
            date: dateISO(s),
            start: timeHM(s),
            end: timeHM(s),
            closesActivePunch: true,
          });
        },
      },
    ],
  });
}

/* ---------- Interventions chronométrées ---------- */

/*
 * Démarrer une intervention au moment présent : un clic, aucune heure à
 * taper. Le billet et la description se remplissent à la FIN, quand on sait
 * ce qui a été fait — c'est là qu'on peut les décrire, pas avant.
 *
 * PLUSIEURS chronos peuvent tourner en même temps : une sauvegarde qui roule
 * chez un client pendant qu'on dépanne ailleurs, c'est deux interventions
 * distinctes à facturer, pas une seule à découper après coup. Chacun porte
 * son identifiant, se termine séparément, et survit à la fermeture de
 * l'onglet comme au passage d'un appareil à l'autre.
 */
function startIntervention() {
  const chrono = touch({ id: genId(), start: Date.now(), client: "" });
  state.activeInterventions.push(chrono);
  if (!save()) {
    state.activeInterventions.pop();
    return;
  }
  renderInterventionLive();
}

// Terminer CE chrono-là : le formulaire s'ouvre déjà rempli avec les VRAIES
// heures (début chronométré, fin au moment présent). Comme pour le punch
// oublié, le chrono n'est arrêté qu'après un enregistrement réussi : fermer
// le dialogue sans enregistrer ne fait pas disparaître l'heure de début.
function finishIntervention(id) {
  const chrono = state.activeInterventions.find((c) => c.id === id);
  if (!chrono) return;
  // Minimum d'une minute, comme au punch out : sans ça, une intervention de
  // vingt secondes se ferait refuser par le formulaire (durée nulle).
  const end = Math.max(Date.now(), chrono.start + 60000);
  interventionDialogClosesChrono = chrono.id;
  nouvelleIntervention({
    title: "Terminer l'intervention",
    date: dateISO(new Date(chrono.start)),
    start: timeHM(new Date(chrono.start)),
    end: timeHM(new Date(end)),
    client: chrono.client,
    origin: { start: chrono.start, end },
  });
}

function cancelIntervention(id) {
  const idx = state.activeInterventions.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const chrono = state.activeInterventions[idx];
  const qui = chrono.client ? ` (${chrono.client})` : "";
  if (!confirm(`Annuler l'intervention en cours${qui} ? Aucune intervention ne sera inscrite.`)) return;
  state.activeInterventions.splice(idx, 1);
  // Pierre tombale : sans elle, l'autre appareil relancerait le chrono arrêté
  // à la prochaine fusion.
  state.tombstones[chrono.id] = Date.now();
  if (!save()) {
    state.activeInterventions.splice(idx, 0, chrono);
    delete state.tombstones[chrono.id];
    return;
  }
  renderInterventionLive();
}

// Le client saisi en cours de route sert à distinguer deux chronos à l'écran,
// et se retrouve prérempli au moment de terminer.
function updateChronoClient(id, value) {
  const chrono = state.activeInterventions.find((c) => c.id === id);
  if (!chrono) return;
  const avant = { client: chrono.client, updatedAt: chrono.updatedAt };
  chrono.client = value.trim();
  touch(chrono);
  if (!save()) {
    Object.assign(chrono, avant);
    return;
  }
  // Le champ à l'écran porte déjà la valeur : on accorde la signature pour
  // qu'un rendu ultérieur ne reconstruise pas la liste sous le curseur.
  signatureChronosRendue = signatureChronos();
}

// L'heure de début, ajustable pendant que le chrono tourne : un démarrage
// tardif (le technicien commence avant d'ouvrir l'appli) se corrige tout de
// suite, sans attendre la fin de l'intervention pour la retoucher. Le jour
// reste celui déjà en mémoire — seule l'heure change ; le changer de jour se
// fait au formulaire complet, au moment de terminer.
function updateChronoStart(id, value) {
  const chrono = state.activeInterventions.find((c) => c.id === id);
  if (!chrono) return;
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return;
  const avant = new Date(chrono.start);
  const next = new Date(avant.getFullYear(), avant.getMonth(), avant.getDate(), Number(m[1]), Number(m[2]));
  if (isNaN(next.getTime())) return;
  if (next.getTime() > Date.now()) {
    showToast("L'heure de début ne peut pas être dans le futur.");
    // Rien n'a changé en mémoire : on force seulement le prochain rendu à
    // réafficher l'heure d'origine dans le champ, au lieu de garder la
    // saisie invalide affichée à l'écran.
    signatureChronosRendue = null;
    renderInterventionLive();
    return;
  }
  const avantChrono = { start: chrono.start, updatedAt: chrono.updatedAt };
  chrono.start = next.getTime();
  touch(chrono);
  if (!save()) {
    Object.assign(chrono, avantChrono);
    signatureChronosRendue = null;
    renderInterventionLive();
    return;
  }
  // Le champ à l'écran porte déjà la valeur : on accorde la signature pour
  // qu'un rendu ultérieur ne reconstruise pas la liste sous le curseur.
  signatureChronosRendue = signatureChronos();
  updateInterventionTimers();
}

const AVIS_CHRONO = "intervention-oubliee-";

// Une bannière par chrono : celles des chronos disparus n'ont plus d'objet.
function nettoyerAvisChronos() {
  const vivants = new Set(state.activeInterventions.map((c) => AVIS_CHRONO + c.id));
  for (const id of [...activeBanners.keys()]) {
    if (id.startsWith(AVIS_CHRONO) && !vivants.has(id)) dismissBanner(id);
  }
}

function signatureChronos() {
  return JSON.stringify(state.activeInterventions.map((c) => [c.id, c.start, c.client]));
}

// Reconstruire la liste à chaque battement effacerait la saisie en cours dans
// le champ « client » : on ne la rebâtit que lorsqu'elle change vraiment.
let signatureChronosRendue = null;

function renderInterventionLive() {
  const chronos = state.activeInterventions;
  const actif = chronos.length > 0;
  nettoyerAvisChronos();

  els.interventionDot.classList.toggle("active", actif);
  els.interventionLabel.textContent = actif
    ? chronos.length === 1
      ? "1 intervention en cours"
      : `${chronos.length} interventions en cours`
    : "Aucune intervention en cours";
  els.interventionDetail.textContent = actif
    ? "Chaque chrono se termine séparément; les détails s'inscrivent à ce moment-là." +
      // Rappel discret : du temps facturé à un client sans que la journée
      // soit punchée, c'est presque toujours un punch in oublié.
      (state.activePunch ? "" : " · aucun punch en cours")
    : "« Démarrer » lance un chrono maintenant; les détails s'inscrivent à la fin.";

  const signature = signatureChronos();
  if (signature !== signatureChronosRendue) {
    els.interventionList.innerHTML = "";
    for (const c of chronos) els.interventionList.appendChild(chronoRow(c));
    signatureChronosRendue = signature;
  }
  els.interventionList.hidden = !actif;

  updateInterventionTimers();
  ensureChronoInterval();
}

// Construite par le DOM plutôt qu'en HTML : le client est saisi par l'usager
// et se retrouverait sinon concaténé dans un attribut.
function chronoRow(chrono) {
  const start = new Date(chrono.start);
  const veille = dateISO(start) !== dateISO(new Date());

  const li = document.createElement("li");
  li.className = "live-row";
  li.dataset.chrono = chrono.id;

  const dot = document.createElement("span");
  dot.className = "status-dot active";
  li.appendChild(dot);

  const client = document.createElement("input");
  client.type = "text";
  client.className = "live-client";
  client.value = chrono.client || "";
  client.placeholder = "Client (optionnel)";
  client.setAttribute("list", "client-list");
  client.setAttribute("aria-label", "Client de l'intervention en cours");
  client.autocomplete = "off";
  client.dataset.chronoClient = chrono.id;
  li.appendChild(client);

  const depuisLabel = document.createElement("span");
  depuisLabel.className = "live-since";
  depuisLabel.textContent = "depuis";
  li.appendChild(depuisLabel);

  // Modifiable pendant que le chrono tourne : un démarrage tardif (le
  // technicien commence avant d'ouvrir l'appli) se corrige tout de suite,
  // sans attendre la fin de l'intervention. Le jour reste celui déjà en
  // mémoire — le changer se fait au formulaire complet, à la fin.
  const debut = document.createElement("input");
  debut.type = "time";
  debut.className = "live-start";
  debut.value = timeHM(start);
  debut.setAttribute("aria-label", "Heure de début de l'intervention en cours");
  debut.dataset.chronoStart = chrono.id;
  li.appendChild(debut);

  if (veille) {
    const jour = document.createElement("span");
    jour.className = "live-since-day";
    jour.textContent = `(${dateISO(start)})`;
    li.appendChild(jour);
  }

  const timer = document.createElement("span");
  timer.className = "live-timer";
  timer.dataset.chronoTimer = chrono.id;
  timer.textContent = chronoHMS(Date.now() - chrono.start);
  li.appendChild(timer);

  const terminer = document.createElement("button");
  terminer.className = "btn btn-primary";
  terminer.textContent = "Terminer";
  terminer.dataset.finishChrono = chrono.id;
  li.appendChild(terminer);

  const annuler = document.createElement("button");
  annuler.className = "icon-btn delete";
  annuler.textContent = "✕";
  annuler.title = "Annuler cette intervention";
  annuler.setAttribute("aria-label", "Annuler cette intervention en cours");
  annuler.dataset.cancelChrono = chrono.id;
  li.appendChild(annuler);

  return li;
}

function updateInterventionTimers() {
  for (const c of state.activeInterventions) {
    const el = els.interventionList.querySelector(`[data-chrono-timer="${cssEscape(c.id)}"]`);
    if (el) el.textContent = chronoHMS(Date.now() - c.start);
  }
}

// Même logique que le punch oublié : un chrono d'intervention laissé ouvert
// toute la nuit produirait une intervention de 15 h imputée au client.
function checkInterventionOubliee() {
  nettoyerAvisChronos();
  for (const chrono of state.activeInterventions) {
    const depuis = Date.now() - chrono.start;
    if (depuis < CHRONO_OUBLIE_MS) continue;
    const start = new Date(chrono.start);
    const heures = Math.floor(depuis / 3600000);
    const qui = chrono.client ? ` pour ${chrono.client}` : "";
    banner({
      id: AVIS_CHRONO + chrono.id,
      tone: "warn",
      text:
        `Une intervention${qui} est chronométrée depuis ${heures} h (début le ${dateISO(start)} à ${timeHM(start)}). ` +
        "S'il s'agit d'un chrono laissé en marche, inscrivez-la avec la bonne heure de fin plutôt que de la laisser courir.",
      actions: [
        {
          label: "Terminer avec la bonne heure de fin",
          run: () => finishIntervention(chrono.id),
        },
      ],
    });
  }
}

/* ---------- Formulaires : outils communs ---------- */

// Reconstruit les timestamps à partir de champs date/début/fin, en passant par
// le calendrier local. Une fin antérieure au début est le lendemain à cette
// heure-là — pas « 24 h plus tard », qui donnerait une heure de trop la nuit
// du passage à l'heure avancée et une heure de moins en novembre.
function timesFromFields(dateEl, startEl, endEl) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateEl.value);
  const s = /^(\d{1,2}):(\d{2})/.exec(startEl.value);
  const e = /^(\d{1,2}):(\d{2})/.exec(endEl.value);
  if (!d || !s || !e) return null;

  const y = Number(d[1]);
  const mo = Number(d[2]) - 1;
  const day = Number(d[3]);
  const start = new Date(y, mo, day, Number(s[1]), Number(s[2]));
  let end = new Date(y, mo, day, Number(e[1]), Number(e[2]));
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  if (end.getTime() < start.getTime()) {
    end = new Date(y, mo, day + 1, Number(e[1]), Number(e[2]));
  }
  return { start: start.getTime(), end: end.getTime() };
}

function showDuration(el, times) {
  if (!times) {
    el.textContent = "Durée : —";
    return;
  }
  const min = minutesBetween(times.start, times.end);
  const lendemain = dateISO(new Date(times.start)) !== dateISO(new Date(times.end));
  el.textContent =
    `Durée : ${fmtDuration(min)} (${fmtDecimalHours(min)} h)` + (lendemain ? " — fin le lendemain" : "");
}

const INVALID_DURATION_MSG = "Vérifiez la date et les heures : la durée doit être supérieure à zéro.";

// Vrai quand le dialogue de période sert à clore le punch en cours : celui-ci
// n'est effacé qu'après un enregistrement réussi, jamais avant.
let punchDialogClosesActive = false;

// Même rôle pour les chronos d'intervention, mais il faut savoir LEQUEL : le
// dialogue porte l'identifiant du chrono qu'il terminera, et tant que rien
// n'est enregistré ce chrono continue de tourner.
let interventionDialogClosesChrono = null;

// Enregistrement en cours de modification, avec ses timestamps d'origine.
// Une heure affichée « 01:30 » est ambiguë la nuit du retour à l'heure normale
// (elle a lieu deux fois) : si aucun champ n'a été touché, on réutilise les
// timestamps stockés plutôt que d'en reconstruire d'autres.
let editOrigin = null;

function rememberOrigin(record, date, start, end) {
  editOrigin = { id: record.id, date, start, end, start_ms: record.start, end_ms: record.end };
}

function resolveTimes(id, dateEl, startEl, endEl) {
  if (
    editOrigin &&
    editOrigin.id === id &&
    editOrigin.date === dateEl.value &&
    editOrigin.start === startEl.value &&
    editOrigin.end === endEl.value
  ) {
    return { start: editOrigin.start_ms, end: editOrigin.end_ms };
  }
  return timesFromFields(dateEl, startEl, endEl);
}

function showFormError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

/* ---------- Feuille de temps : dialogue et CRUD ---------- */

function openPunchDialog(opts) {
  punchDialogClosesActive = opts.closesActivePunch === true;
  if (!opts.id) editOrigin = null;
  els.punchDialogTitle.textContent = opts.title;
  els.pId.value = opts.id || "";
  els.pDate.value = opts.date;
  els.pStart.value = opts.start;
  els.pEnd.value = opts.end;
  els.pError.hidden = true;
  updatePunchFormDuration();
  els.punchDialog.showModal();
}

function updatePunchFormDuration() {
  showDuration(els.pDuration, timesFromFields(els.pDate, els.pStart, els.pEnd));
}

function submitPunchForm(event) {
  event.preventDefault();
  const id = els.pId.value || genId();
  const t = resolveTimes(id, els.pDate, els.pStart, els.pEnd);
  if (!t || minutesBetween(t.start, t.end) <= 0) {
    return showFormError(els.pError, INVALID_DURATION_MSG);
  }
  const record = touch({ id, start: t.start, end: t.end });

  const chevauche = state.punches.find(
    (p) => p.id !== record.id && p.start < record.end && record.start < p.end
  );
  if (chevauche) {
    const a = new Date(chevauche.start);
    const ok = confirm(
      `Cette période chevauche celle du ${dateISO(a)} (${timeHM(a)}–${timeHM(new Date(chevauche.end))}). ` +
        "Le temps serait compté deux fois. Enregistrer quand même ?"
    );
    if (!ok) return;
  }

  const idx = state.punches.findIndex((p) => p.id === record.id);
  const previous = idx >= 0 ? state.punches[idx] : null;
  const previousActive = state.activePunch;
  const previousActiveAt = state.activePunchAt;
  if (idx >= 0) state.punches[idx] = record;
  else state.punches.push(record);
  // Le punch en cours n'est clos qu'ici, une fois la période bien formée.
  if (punchDialogClosesActive) {
    state.activePunch = null;
    state.activePunchAt = Date.now();
  }

  if (!save()) {
    if (idx >= 0) state.punches[idx] = previous;
    else state.punches.pop();
    state.activePunch = previousActive;
    state.activePunchAt = previousActiveAt;
    return showFormError(els.pError, "Enregistrement impossible — voir l'avis en haut de la page.");
  }
  punchDialogClosesActive = false;
  editOrigin = null;
  els.punchDialog.close();
  ensureVisible(record.start);
  render();
}

function editPunch(id) {
  const p = state.punches.find((x) => x.id === id);
  if (!p) return;
  const start = new Date(p.start);
  const end = new Date(p.end);
  rememberOrigin(p, dateISO(start), timeHM(start), timeHM(end));
  openPunchDialog({
    title: "Modifier la période",
    id: p.id,
    date: dateISO(start),
    start: timeHM(start),
    end: timeHM(end),
  });
}

function deletePunch(id) {
  const idx = state.punches.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const p = state.punches[idx];
  const start = new Date(p.start);
  if (!confirm(`Supprimer la période du ${dateISO(start)} (${timeHM(start)}–${timeHM(new Date(p.end))}) ?`)) return;
  state.punches.splice(idx, 1);
  // Pierre tombale : sans elle, l'autre appareil réintroduirait la période
  // supprimée à la prochaine fusion.
  state.tombstones[id] = Date.now();
  if (!save()) {
    state.punches.splice(idx, 0, p);
    delete state.tombstones[id];
    return;
  }
  render();
}

/* ---------- Interventions : dialogue et CRUD ---------- */

function openInterventionDialog(opts) {
  if (!opts.id) editOrigin = null;
  els.interventionDialogTitle.textContent = opts.title;
  els.fId.value = opts.id || "";
  els.fDate.value = opts.date;
  els.fStart.value = opts.start;
  els.fEnd.value = opts.end;
  els.fClient.value = opts.client || "";
  els.fTicket.value = opts.ticket || "";
  els.fCategory.value = opts.category || "Dépannage";
  els.fDescription.value = opts.description || "";
  els.fBillable.checked = opts.billable !== false;
  els.fToVerify.checked = !!opts.toVerify;
  els.fVerifyNote.value = opts.verifyNote || "";
  els.fVerifyNoteWrap.hidden = !els.fToVerify.checked;
  els.fError.hidden = true;
  refreshDatalists();
  updateInterventionFormDuration();
  els.interventionDialog.showModal();
  els.fDescription.focus();
}

// Reprend le contexte de la dernière intervention de la journée : mêmes client
// et billet, et début collé sur sa fin. Un technicien qui reste sur le même
// billet n'a plus rien à retaper; les champs restent modifiables.
function nouvelleIntervention(prefill) {
  const now = new Date();
  const jour = prefill && prefill.date ? prefill.date : dateISO(now);
  const duJour = state.interventions
    .filter((i) => dateISO(new Date(i.start)) === jour)
    .sort((a, b) => a.end - b.end);
  const derniere = duJour[duJour.length - 1] || null;

  let debut;
  if (prefill && prefill.start) {
    debut = prefill.start;
  } else if (derniere && derniere.end <= now.getTime()) {
    debut = timeHM(new Date(derniere.end));
  } else {
    debut = timeHM(new Date(now.getTime() - 3600 * 1000));
  }

  const opts = {
    title: (prefill && prefill.title) || "Inscrire une intervention",
    date: jour,
    start: debut,
    end: (prefill && prefill.end) || timeHM(now),
    client: (prefill && prefill.client) || (derniere ? derniere.clients.join(", ") : ""),
    ticket: (prefill && prefill.ticket) || (derniere ? derniere.ticket : ""),
    category: derniere ? derniere.category : "Dépannage",
  };

  // Heures déjà connues à la milliseconde (fin d'une intervention
  // chronométrée) : on les garde telles quelles au lieu de les reconstruire
  // depuis « HH:MM », qui perdrait les secondes et serait ambigu la nuit du
  // retour à l'heure normale. Même mécanisme qu'à la modification.
  if (prefill && prefill.origin) {
    opts.id = genId();
    editOrigin = {
      id: opts.id,
      date: opts.date,
      start: opts.start,
      end: opts.end,
      start_ms: prefill.origin.start,
      end_ms: prefill.origin.end,
    };
  }

  openInterventionDialog(opts);
}

// « Ventiler » une période punchée : les heures existent déjà, aucune raison
// de les retaper pour inscrire le billet correspondant.
function ventilerPunch(id) {
  const p = state.punches.find((x) => x.id === id);
  if (!p) return;
  const start = new Date(p.start);
  const end = new Date(p.end);
  nouvelleIntervention({
    date: dateISO(start),
    start: timeHM(start),
    end: timeHM(end),
  });
}

function updateInterventionFormDuration() {
  showDuration(els.fDuration, timesFromFields(els.fDate, els.fStart, els.fEnd));
}

function submitInterventionForm(event) {
  event.preventDefault();
  const id = els.fId.value || genId();
  const t = resolveTimes(id, els.fDate, els.fStart, els.fEnd);
  if (!t || minutesBetween(t.start, t.end) <= 0) {
    return showFormError(els.fError, INVALID_DURATION_MSG);
  }
  const clients = parseClients(els.fClient.value);
  const description = els.fDescription.value.trim();
  if (!clients.length && !description) {
    return showFormError(els.fError, "Inscrivez au moins un client ou une explication.");
  }

  const record = touch({
    id,
    start: t.start,
    end: t.end,
    clients,
    ticket: els.fTicket.value.trim(),
    category: els.fCategory.value,
    description,
    billable: els.fBillable.checked,
    toVerify: els.fToVerify.checked,
    verifyNote: els.fToVerify.checked ? els.fVerifyNote.value.trim() : "",
  });

  const idx = state.interventions.findIndex((i) => i.id === record.id);
  const previous = idx >= 0 ? state.interventions[idx] : null;
  const chronoIdx = interventionDialogClosesChrono
    ? state.activeInterventions.findIndex((c) => c.id === interventionDialogClosesChrono)
    : -1;
  const chrono = chronoIdx >= 0 ? state.activeInterventions[chronoIdx] : null;
  if (idx >= 0) state.interventions[idx] = record;
  else state.interventions.push(record);
  // Le chrono n'est arrêté qu'ici, une fois l'intervention bien formée — et
  // seulement celui-là : les autres continuent de tourner.
  if (chrono) {
    state.activeInterventions.splice(chronoIdx, 1);
    state.tombstones[chrono.id] = Date.now();
  }

  if (!save()) {
    if (idx >= 0) state.interventions[idx] = previous;
    else state.interventions.pop();
    if (chrono) {
      state.activeInterventions.splice(chronoIdx, 0, chrono);
      delete state.tombstones[chrono.id];
    }
    return showFormError(els.fError, "Enregistrement impossible — voir l'avis en haut de la page.");
  }
  interventionDialogClosesChrono = null;
  editOrigin = null;
  els.interventionDialog.close();
  ensureInterventionVisible(record);
  render();
}

function editIntervention(id) {
  const i = state.interventions.find((x) => x.id === id);
  if (!i) return;
  const start = new Date(i.start);
  const end = new Date(i.end);
  rememberOrigin(i, dateISO(start), timeHM(start), timeHM(end));
  openInterventionDialog({
    title: "Modifier l'intervention",
    id: i.id,
    date: dateISO(start),
    start: timeHM(start),
    end: timeHM(end),
    client: (i.clients || []).join(", "),
    ticket: i.ticket,
    category: i.category,
    description: i.description,
    billable: i.billable,
    toVerify: i.toVerify,
    verifyNote: i.verifyNote,
  });
}

function deleteIntervention(id) {
  const idx = state.interventions.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const i = state.interventions[idx];
  const clientLabel = (i.clients || []).join(", ");
  const label = clientLabel ? ` (${clientLabel})` : "";
  if (!confirm(`Supprimer cette intervention${label} ?`)) return;
  state.interventions.splice(idx, 1);
  state.tombstones[id] = Date.now();
  if (!save()) {
    state.interventions.splice(idx, 0, i);
    delete state.tombstones[id];
    return;
  }
  render();
}

function toggleInterventionVerify(id) {
  const i = state.interventions.find((x) => x.id === id);
  if (!i) return;
  const avant = { toVerify: i.toVerify, verifyNote: i.verifyNote, updatedAt: i.updatedAt };
  i.toVerify = !i.toVerify;
  if (!i.toVerify) i.verifyNote = "";
  touch(i);
  if (!save()) {
    Object.assign(i, avant);
    return;
  }
  renderInterventionTable();
  renderSummaryTable();
  if (i.toVerify) {
    const input = els.interventionTbody.querySelector(`[data-verify-note-input="${cssEscape(id)}"]`);
    if (input) {
      // La note naît repliée : on l'ouvre pour celle qu'on vient de cocher,
      // sinon le focus partirait dans un champ invisible.
      const details = input.closest("details");
      if (details) details.open = true;
      input.focus();
    }
  }
}

function updateInterventionVerifyNote(id, value) {
  const i = state.interventions.find((x) => x.id === id);
  if (!i) return;
  const avant = { verifyNote: i.verifyNote, updatedAt: i.updatedAt };
  i.verifyNote = value.trim();
  touch(i);
  if (!save()) Object.assign(i, avant);
}

// Les identifiants sont générés par genId() et ne contiennent que des
// caractères sûrs, mais un sélecteur construit par concaténation reste
// fragile : on échappe quand même.
function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

function fillDatalist(el, values) {
  el.innerHTML = "";
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    el.appendChild(opt);
  }
}

function refreshDatalists() {
  fillDatalist(els.clientList, uniqueClients());
  fillDatalist(els.ticketList, uniqueValues((i) => i.ticket));
}

// `pick` retourne soit une valeur scalaire (ticket, catégorie), soit un
// tableau (clients) — les tableaux sont aplatis avant déduplication.
function uniqueValues(pick) {
  const set = new Set();
  for (const i of state.interventions) {
    const v = pick(i);
    if (Array.isArray(v)) {
      for (const x of v) if (x) set.add(x);
    } else if (v) {
      set.add(v);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
}

function uniqueClients() {
  return uniqueValues((i) => i.clients);
}

/* ---------- Filtres et rendu ---------- */

// Toutes les périodes sont fermées : [début, fin[. Une entrée mal datée
// (2027 au lieu de 2026) ne peut plus gonfler « Aujourd'hui » en permanence.
function filterRange() {
  const now = new Date();
  switch (els.filterPeriod.value) {
    case "today": {
      const d = startOfDay(now);
      return [d.getTime(), addDays(d, 1).getTime()];
    }
    case "week": {
      const w = startOfWeek(now);
      return [w.getTime(), addDays(w, 7).getTime()];
    }
    case "last-week": {
      const w = startOfWeek(now);
      return [addDays(w, -7).getTime(), w.getTime()];
    }
    case "2weeks": {
      const w = startOfWeek(now);
      return [addDays(w, -7).getTime(), addDays(w, 7).getTime()];
    }
    case "month":
      return [startOfMonth(now).getTime(), addMonths(now, 1).getTime()];
    case "last-month":
      return [addMonths(now, -1).getTime(), startOfMonth(now).getTime()];
    case "custom": {
      let from = parseDateInput(els.filterFrom.value);
      let to = parseDateInput(els.filterTo.value);
      // Bornes saisies à l'envers : mieux vaut la période voulue qu'un tableau
      // vide sans explication.
      if (from && to && from > to) [from, to] = [to, from];
      return [
        from ? from.getTime() : -Infinity,
        // La borne « au » est inclusive : on va jusqu'à la fin de cette
        // journée-là, par le calendrier et non par +24 h.
        to ? addDays(to, 1).getTime() : Infinity,
      ];
    }
    default:
      return [-Infinity, Infinity];
  }
}

function parseDateInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Libellé de la période affichée : repris tel quel dans les noms de fichiers,
// l'en-tête des CSV et celui du rapport, pour qu'un document retrouvé trois
// mois plus tard dise lui-même ce qu'il contient.
function rangeLabel() {
  const [from, to] = filterRange();
  if (from === -Infinity && to === Infinity) return "toutes les données";
  const debut = from === -Infinity ? "début" : dateISO(new Date(from));
  const fin = to === Infinity ? "fin" : dateISO(addDays(new Date(to), -1));
  return debut === fin ? debut : `${debut} au ${fin}`;
}

function rangeSlug() {
  const [from, to] = filterRange();
  if (from === -Infinity && to === Infinity) return "tout";
  const debut = from === -Infinity ? "debut" : dateISO(new Date(from));
  const fin = to === Infinity ? dateISO(new Date()) : dateISO(addDays(new Date(to), -1));
  return debut === fin ? debut : `${debut}_${fin}`;
}

// Bref avis visuel non bloquant (ex. quand le filtre change automatiquement).
function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Si un enregistrement fraîchement ajouté tombe hors du filtre de période
// actif, on bascule sur « Tout » pour qu'il soit immédiatement visible,
// plutôt que de laisser croire qu'il n'a pas été enregistré.
function ensureVisible(recordStartMs) {
  const [from, to] = filterRange();
  if (recordStartMs >= from && recordStartMs < to) return;
  els.filterPeriod.value = "all";
  els.customRange.hidden = true;
  showToast("Filtre changé pour « Tout » afin d'afficher l'ajout le plus récent.");
}

// Variante pour les interventions : tient compte aussi des filtres client et
// « à vérifier ».
function ensureInterventionVisible(record) {
  const [from, to] = filterRange();
  const periodOk = record.start >= from && record.start < to;
  const clientFilter = els.filterClient.value;
  const clientOk = !clientFilter || (record.clients || []).includes(clientFilter);
  const verifyOk = !els.filterToVerify.checked || record.toVerify;
  if (periodOk && clientOk && verifyOk) return;
  els.filterPeriod.value = "all";
  els.customRange.hidden = true;
  els.filterClient.value = "";
  els.filterToVerify.checked = false;
  showToast("Filtres réinitialisés afin d'afficher l'ajout le plus récent.");
}

function inRange(record, from, to) {
  return record.start >= from && record.start < to;
}

function filteredPunches() {
  const [from, to] = filterRange();
  return state.punches.filter((p) => inRange(p, from, to)).sort((a, b) => b.start - a.start);
}

// Interventions de la période, sans les filtres client et « à vérifier » :
// sert au rapprochement punché / ventilé, qui doit porter sur toute la journée.
function periodInterventions() {
  const [from, to] = filterRange();
  return state.interventions.filter((i) => inRange(i, from, to));
}

function filteredInterventions() {
  const client = els.filterClient.value;
  const toVerifyOnly = els.filterToVerify.checked;
  return periodInterventions()
    .filter((i) => (!client || (i.clients || []).includes(client)) && (!toVerifyOnly || i.toVerify))
    .sort((a, b) => b.start - a.start);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render() {
  els.rangeLabel.textContent = rangeLabel();
  updatePrintMeta();
  renderPunchCard();
  renderInterventionLive();
  renderStats();
  renderPunchTable();
  renderClientFilter();
  renderInterventionTable();
  renderSummaryTable();
  refreshDatalists();
}

// Le sommaire reflète la feuille de temps (les punchs), punch en cours inclus :
// à 15 h, « Aujourd'hui » ne peut plus afficher 0 min pendant que le chrono tourne.
function renderStats() {
  const now = new Date();
  const bornes = {
    today: [startOfDay(now), addDays(startOfDay(now), 1)],
    week: [startOfWeek(now), addDays(startOfWeek(now), 7)],
    month: [startOfMonth(now), addMonths(now, 1)],
  };
  const sums = { today: 0, week: 0, month: 0 };
  const encours = { today: false, week: false, month: false };

  const ajoute = (start, minutes, actif) => {
    for (const cle of ["today", "week", "month"]) {
      const [a, b] = bornes[cle];
      if (start >= a.getTime() && start < b.getTime()) {
        sums[cle] += minutes;
        if (actif) encours[cle] = true;
      }
    }
  };

  for (const p of state.punches) ajoute(p.start, minutesBetween(p.start, p.end), false);
  if (state.activePunch) {
    ajoute(state.activePunch.start, minutesBetween(state.activePunch.start, Date.now()), true);
  }

  // Le repère n'apparaît que sur les tuiles qui comptent réellement le punch
  // en cours : un punch commencé hier ne « coule » pas dans « Aujourd'hui ».
  els.statToday.textContent = fmtDuration(sums.today) + (encours.today ? " ⏵" : "");
  els.statWeek.textContent = fmtDuration(sums.week) + (encours.week ? " ⏵" : "");
  els.statMonth.textContent = fmtDuration(sums.month) + (encours.month ? " ⏵" : "");
  els.statToday.title = encours.today ? "Punch en cours inclus" : "";
}

// La journée en cours est dépliée (détail des périodes); les journées
// terminées sont repliées sur leur total et se déplient d'un clic.
function isDayExpanded(day) {
  if (printing) return true;
  if (dayOverrides.has(day)) return dayOverrides.get(day);
  return day === todayKey;
}

function toggleDay(day) {
  dayOverrides.set(day, !isDayExpanded(day));
  renderPunchTable();
}

function minutesParJour(records) {
  const m = new Map();
  for (const r of records) {
    const day = dateISO(new Date(r.start));
    m.set(day, (m.get(day) || 0) + minutesBetween(r.start, r.end));
  }
  return m;
}

// Tableau de la feuille de temps, groupé par jour avec total quotidien et
// rapprochement avec le temps ventilé en interventions.
function renderPunchTable() {
  const rows = filteredPunches();
  els.punchTbody.innerHTML = "";
  els.punchEmpty.hidden = rows.length > 0;

  const dayTotals = minutesParJour(rows);
  const dayCounts = new Map();
  let total = 0;
  for (const p of rows) {
    const day = dateISO(new Date(p.start));
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    total += minutesBetween(p.start, p.end);
  }

  const interventionsDuJour = minutesParJour(state.interventions);

  let currentDay = null;
  for (const p of rows) {
    const start = new Date(p.start);
    const end = new Date(p.end);
    const day = dateISO(start);

    if (day !== currentDay) {
      currentDay = day;
      const expanded = isDayExpanded(day);
      const count = dayCounts.get(day);
      const punche = dayTotals.get(day);
      const ventile = interventionsDuJour.get(day) || 0;

      const trDay = document.createElement("tr");
      trDay.className = "day-row";
      trDay.dataset.day = day;
      trDay.tabIndex = 0;
      trDay.setAttribute("role", "button");
      trDay.setAttribute("aria-expanded", String(expanded));
      trDay.title = "Cliquer pour afficher ou masquer le détail";
      trDay.innerHTML = `
        <td colspan="2"><span class="chevron">${expanded ? "▾" : "▸"}</span>${escapeHtml(dayLabel(start))} · ${count} période${count > 1 ? "s" : ""}</td>
        <td>Total : ${fmtDuration(punche)}</td>
        <td>${ventile === 0 ? "Aucun billet inscrit" : `Ventilé : ${fmtDuration(ventile)}`}</td>`;
      els.punchTbody.appendChild(trDay);
    }

    if (!isDayExpanded(day)) continue;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${timeHM(start)}</td>
      <td>${timeHM(end)}${dateISO(end) !== day ? ' <span class="next-day" title="Se termine le lendemain">+1</span>' : ""}</td>
      <td>${fmtDuration(minutesBetween(p.start, p.end))}</td>
      <td>
        <span class="row-actions">
          <button class="icon-btn" data-ventiler-punch="${escapeHtml(p.id)}" title="Inscrire une intervention pour cette période" aria-label="Inscrire une intervention pour cette période">🧾</button>
          <button class="icon-btn" data-edit-punch="${escapeHtml(p.id)}" title="Modifier" aria-label="Modifier la période">✏️</button>
          <button class="icon-btn delete" data-delete-punch="${escapeHtml(p.id)}" title="Supprimer" aria-label="Supprimer la période">✕</button>
        </span>
      </td>`;
    els.punchTbody.appendChild(tr);
  }

  const ventileTotal = periodInterventions().reduce((n, i) => n + minutesBetween(i.start, i.end), 0);
  els.punchTotal.innerHTML =
    rows.length === 0
      ? ""
      : `${rows.length} période${rows.length > 1 ? "s" : ""} — total travaillé : ` +
        `<strong>${fmtDuration(total)}</strong> (${fmtDecimalHours(total)} h) · ` +
        `ventilé en interventions : <strong>${fmtDuration(ventileTotal)}</strong>`;
}

function renderClientFilter() {
  const current = els.filterClient.value;
  const clients = uniqueClients();
  els.filterClient.innerHTML = '<option value="">Tous les clients</option>';
  for (const c of clients) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    els.filterClient.appendChild(opt);
  }
  if (clients.includes(current)) els.filterClient.value = current;
}

/* Le tableau des interventions est une liste chronologique, point.
 * L'ancienne « vue fusionnée » y insérait des lignes virtuelles dont l'heure
 * de fin était fabriquée (début + somme des durées) et dont la facturabilité
 * passait au vrai dès qu'une seule intervention du groupe l'était. Le total
 * par billet vit maintenant dans le Sommaire de facturation, qui n'invente
 * aucune heure. */
function renderInterventionTable() {
  const rows = filteredInterventions();
  els.interventionTbody.innerHTML = "";
  els.interventionEmpty.hidden = rows.length > 0;

  let total = 0;
  let billableTotal = 0;
  for (const i of rows) {
    const start = new Date(i.start);
    const end = new Date(i.end);
    const min = minutesBetween(i.start, i.end);
    total += min;
    if (i.billable) billableTotal += min;

    const tr = document.createElement("tr");
    if (i.toVerify) tr.className = "to-verify-row";
    tr.innerHTML = `
      <td>${dateISO(start)}</td>
      <td>${timeHM(start)}</td>
      <td>${timeHM(end)}${dateISO(end) !== dateISO(start) ? ' <span class="next-day" title="Se termine le lendemain">+1</span>' : ""}</td>
      <td>${fmtDuration(min)}</td>
      <td>${escapeHtml((i.clients || []).join(", ")) || "—"}</td>
      <td>${escapeHtml(i.ticket) || "—"}</td>
      <td>${escapeHtml(i.category)}</td>
      <td class="desc">${escapeHtml(i.description) || "—"}</td>
      <td>${i.billable ? "✓" : "—"}</td>
      <td class="center"><input type="checkbox" data-toggle-verify="${escapeHtml(i.id)}" title="À vérifier avant facturation" aria-label="Marquer à vérifier avant facturation" ${i.toVerify ? "checked" : ""}></td>
      <td>
        <span class="row-actions">
          <button class="icon-btn" data-edit-intervention="${escapeHtml(i.id)}" title="Modifier" aria-label="Modifier l'intervention">✏️</button>
          <button class="icon-btn delete" data-delete-intervention="${escapeHtml(i.id)}" title="Supprimer" aria-label="Supprimer l'intervention">✕</button>
        </span>
      </td>`;
    els.interventionTbody.appendChild(tr);

    if (i.toVerify) {
      // La note est REPLIÉE par défaut. Dépliée, elle ajoutait une seconde
      // ligne pleine hauteur à chaque entrée cochée : sur une semaine où tout
      // est à vérifier, le tableau doublait et la colonne Description passait
      // hors écran. <details> plutôt qu'un basculement maison — le textarea
      // reste dans le DOM (l'écouteur « change » et la sauvegarde ne changent
      // pas), et on hérite du clavier et du repli natifs.
      const apercu = (i.verifyNote || "").replace(/\s+/g, " ").trim();
      const trNote = document.createElement("tr");
      trNote.className = "verify-note-row";
      trNote.innerHTML = `
        <td></td>
        <td colspan="10">
          <details class="verify-note-details">
            <summary class="verify-note-summary">
              <span class="verify-note-tag">⚠️ À vérifier</span>
              <span class="verify-note-apercu${apercu ? "" : " vide"}">${escapeHtml(apercu) || "Ajouter une note…"}</span>
            </summary>
            <textarea class="verify-note-input" rows="2" data-verify-note-input="${escapeHtml(i.id)}" aria-label="Note de vérification" placeholder="Note de vérification (optionnelle)… — Entrée pour une nouvelle ligne">${escapeHtml(i.verifyNote || "")}</textarea>
          </details>
        </td>`;
      els.interventionTbody.appendChild(trNote);
    }
  }

  els.interventionTotal.innerHTML =
    rows.length === 0
      ? ""
      : `${rows.length} intervention${rows.length > 1 ? "s" : ""} — total : ` +
        `<strong>${fmtDuration(total)}</strong> (${fmtDecimalHours(total)} h), ` +
        `dont facturable : <strong>${fmtDuration(billableTotal)}</strong> (${fmtDecimalHours(billableTotal)} h)`;
}

/* ---------- Sommaire de facturation (regroupement en lecture seule) ---------- */

const GROUP_LABELS = { ticket: "Billet", client: "Client", category: "Catégorie" };

function groupedInterventions() {
  const cle = els.groupBy.value;
  const groupes = new Map();
  const ajoute = (k, i, min) => {
    if (!groupes.has(k)) groupes.set(k, { cle: k, count: 0, minutes: 0, billable: 0, toVerify: 0, items: [] });
    const g = groupes.get(k);
    g.count++;
    g.minutes += min;
    // Le non facturable ne devient jamais facturable par regroupement.
    if (i.billable) g.billable += min;
    if (i.toVerify) g.toVerify++;
    g.items.push(i);
  };
  for (const i of filteredInterventions()) {
    if (cle === "client") {
      // Une intervention à plusieurs clients répartit sa durée à parts égales
      // entre eux (clientMinuteShares) plutôt que de la compter en entier
      // dans chaque groupe, ce qui gonflerait artificiellement le total.
      for (const share of clientMinuteShares(i)) ajoute(share.client, i, share.minutes);
    } else {
      const k = (i[cle] || "").trim() || "(sans " + GROUP_LABELS[cle].toLowerCase() + ")";
      ajoute(k, i, minutesBetween(i.start, i.end));
    }
  }
  for (const g of groupes.values()) g.items.sort((a, b) => a.start - b.start);
  return [...groupes.values()].sort((a, b) => b.minutes - a.minutes);
}

// Détail d'un groupe : les vraies heures de chaque intervention, jamais un
// intervalle synthétique.
const summaryExpanded = new Set();

function renderSummaryTable() {
  const groupes = groupedInterventions();
  els.groupHead.textContent = GROUP_LABELS[els.groupBy.value];
  els.summaryTbody.innerHTML = "";
  els.summaryEmpty.hidden = groupes.length > 0;

  let total = 0;
  let billable = 0;
  let aVerifier = 0;
  for (const g of groupes) {
    total += g.minutes;
    billable += g.billable;
    aVerifier += g.toVerify;
    const ouvert = summaryExpanded.has(g.cle);

    const tr = document.createElement("tr");
    tr.className = "summary-row";
    tr.dataset.groupe = g.cle;
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", String(ouvert));
    tr.title = "Cliquer pour afficher le détail des interventions";
    tr.innerHTML = `
      <td><span class="chevron">${ouvert ? "▾" : "▸"}</span>${escapeHtml(g.cle)}</td>
      <td>${g.count}</td>
      <td>${fmtDuration(g.minutes)}</td>
      <td>${fmtDecimalHours(g.minutes)} h</td>
      <td>${fmtDuration(g.billable)} (${fmtDecimalHours(g.billable)} h)</td>
      <td class="center">${g.toVerify > 0 ? `<span class="verify-badge">⚠️ ${g.toVerify}</span>` : "—"}</td>`;
    els.summaryTbody.appendChild(tr);

    if (!ouvert) continue;
    for (const i of g.items) {
      const s = new Date(i.start);
      const e = new Date(i.end);
      const trd = document.createElement("tr");
      trd.className = "summary-detail";
      trd.innerHTML = `
        <td>${dateISO(s)} ${timeHM(s)}–${timeHM(e)}</td>
        <td></td>
        <td>${fmtDuration(minutesBetween(i.start, i.end))}</td>
        <td colspan="2" class="desc">${escapeHtml((i.clients || []).join(", ")) || "—"}${i.description ? " — " + escapeHtml(i.description) : ""}</td>
        <td class="center">${i.billable ? "✓" : "—"}${i.toVerify ? " ⚠️" : ""}</td>`;
      els.summaryTbody.appendChild(trd);
    }
  }

  if (groupes.length > 0) {
    const tr = document.createElement("tr");
    tr.className = "total-row";
    tr.innerHTML = `
      <td>TOTAL</td>
      <td>${groupes.reduce((n, g) => n + g.count, 0)}</td>
      <td>${fmtDuration(total)}</td>
      <td>${fmtDecimalHours(total)} h</td>
      <td>${fmtDuration(billable)} (${fmtDecimalHours(billable)} h)</td>
      <td class="center">${aVerifier > 0 ? `⚠️ ${aVerifier}` : "—"}</td>`;
    els.summaryTbody.appendChild(tr);
  }
}

function toggleSummaryGroup(cle) {
  if (summaryExpanded.has(cle)) summaryExpanded.delete(cle);
  else summaryExpanded.add(cle);
  renderSummaryTable();
}

/* ---------- Export / import ---------- */

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Révoquer immédiatement coupe le téléchargement dans certains navigateurs.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function csvField(value) {
  const s = String(value ?? "");
  if (/[;"\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// BOM UTF-8 pour qu'Excel affiche correctement les accents
function downloadCsv(name, lines) {
  downloadFile(name, "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
}

// Rappelle dans le fichier lui-même quelle période et quels filtres l'ont
// produit : un CSV retrouvé plus tard n'est plus une devinette.
function csvEntete(titre, extra) {
  const lignes = [
    csvField(`${titre} — période : ${rangeLabel()}`),
    csvField(`Généré le ${dateISO(new Date())} à ${timeHM(new Date())}`),
  ];
  if (extra) lignes.push(csvField(extra));
  lignes.push("");
  return lignes;
}

function filtresActifs() {
  const bouts = [];
  const client = els.filterClient.value;
  bouts.push(client ? `Filtre client : ${client}` : "Tous les clients");
  if (els.filterToVerify.checked) bouts.push("Seulement les interventions à vérifier");
  return bouts.join(" — ");
}

// Ligne de sous-total ou de total. Les deux exports partagent leurs six
// premières colonnes : le libellé va sous « Fin », les valeurs sous
// « Durée (min) » et « Durée (h) ». Compter les points-virgules à la main
// décalait silencieusement les chiffres d'une colonne dans Excel.
function csvTotalRow(colonnes, libelle, minutes) {
  const cases = new Array(colonnes).fill("");
  cases[3] = libelle;
  cases[4] = minutes;
  cases[5] = fmtDecimalHours(minutes);
  return cases.join(";");
}

function exportPunchesCsv() {
  const rows = filteredPunches();
  if (rows.length === 0) {
    alert("Aucune période à exporter pour cette période.");
    return;
  }
  const lines = csvEntete("Feuille de temps");
  lines.push("Date;Date de fin;Début;Fin;Durée (min);Durée (h)");

  const chrono = [...rows].reverse();
  let currentDay = null;
  let jour = 0;
  let total = 0;
  const sousTotal = (day, min) => lines.push(csvTotalRow(6, `Sous-total ${day}`, min));

  for (const p of chrono) {
    const start = new Date(p.start);
    const end = new Date(p.end);
    const day = dateISO(start);
    if (currentDay !== null && day !== currentDay) {
      sousTotal(currentDay, jour);
      jour = 0;
    }
    currentDay = day;
    const min = minutesBetween(p.start, p.end);
    jour += min;
    total += min;
    lines.push([day, dateISO(end), timeHM(start), timeHM(end), min, fmtDecimalHours(min)].join(";"));
  }
  if (currentDay !== null) sousTotal(currentDay, jour);
  lines.push(csvTotalRow(6, "TOTAL", total));

  downloadCsv(`feuille-de-temps-${rangeSlug()}.csv`, lines);
}

function exportInterventionsCsv() {
  const rows = filteredInterventions();
  if (rows.length === 0) {
    alert("Aucune intervention à exporter pour cette période.");
    return;
  }
  const lines = csvEntete("Interventions", filtresActifs());
  lines.push(
    "Date;Date de fin;Début;Fin;Durée (min);Durée (h);Client;Billet;Catégorie;Description;Facturable;À vérifier;Note de vérification"
  );
  const COLONNES = 13;

  let total = 0;
  let billable = 0;
  for (const i of [...rows].reverse()) {
    const start = new Date(i.start);
    const end = new Date(i.end);
    const min = minutesBetween(i.start, i.end);
    total += min;
    if (i.billable) billable += min;
    lines.push(
      [
        dateISO(start),
        dateISO(end),
        timeHM(start),
        timeHM(end),
        min,
        fmtDecimalHours(min),
        csvField((i.clients || []).join(", ")),
        csvField(i.ticket),
        csvField(i.category),
        csvField(i.description),
        i.billable ? "Oui" : "Non",
        i.toVerify ? "Oui" : "Non",
        csvField(i.toVerify ? i.verifyNote || "" : ""),
      ].join(";")
    );
  }
  lines.push(csvTotalRow(COLONNES, "TOTAL", total));
  lines.push(csvTotalRow(COLONNES, "DONT FACTURABLE", billable));

  downloadCsv(`interventions-${rangeSlug()}.csv`, lines);
}

function exportSummaryCsv() {
  const groupes = groupedInterventions();
  if (groupes.length === 0) {
    alert("Aucune intervention à regrouper pour cette période.");
    return;
  }
  const libelle = GROUP_LABELS[els.groupBy.value];
  const lines = csvEntete(`Sommaire de facturation par ${libelle.toLowerCase()}`, filtresActifs());
  lines.push(`${libelle};Interventions;Durée (min);Durée (h);Facturable (min);Facturable (h);À vérifier`);

  let total = 0;
  let billable = 0;
  let count = 0;
  let aVerifier = 0;
  for (const g of groupes) {
    total += g.minutes;
    billable += g.billable;
    count += g.count;
    aVerifier += g.toVerify;
    lines.push(
      [
        csvField(g.cle),
        g.count,
        g.minutes,
        fmtDecimalHours(g.minutes),
        g.billable,
        fmtDecimalHours(g.billable),
        g.toVerify,
      ].join(";")
    );
  }
  lines.push(["TOTAL", count, total, fmtDecimalHours(total), billable, fmtDecimalHours(billable), aVerifier].join(";"));

  downloadCsv(`sommaire-${els.groupBy.value}-${rangeSlug()}.csv`, lines);
}

/* ---------- Rapport hebdomadaire (impression / PDF) ---------- */

function isoWeekLabel(monday) {
  const sunday = addDays(monday, 6);
  const fmtLong = (d) => d.toLocaleDateString("fr-CA", { day: "numeric", month: "long" });
  const range =
    monday.getMonth() === sunday.getMonth()
      ? `${monday.getDate()} au ${fmtLong(sunday)}`
      : `${fmtLong(monday)} au ${fmtLong(sunday)}`;
  return `Semaine du ${range} ${sunday.getFullYear()}`;
}

function generateWeeklyReport() {
  const [from, to] = filterRange();
  const punches = state.punches.filter((p) => inRange(p, from, to)).sort((a, b) => a.start - b.start);
  const interventions = state.interventions.filter((i) => inRange(i, from, to)).sort((a, b) => a.start - b.start);

  if (punches.length === 0 && interventions.length === 0) {
    alert("Aucune donnée à inclure dans le rapport pour cette période.");
    return;
  }

  const weeks = new Map();
  const weekKeyOf = (ms) => startOfWeek(new Date(ms)).getTime();
  for (const p of punches) {
    const k = weekKeyOf(p.start);
    if (!weeks.has(k)) weeks.set(k, { monday: new Date(k), punches: [], interventions: [] });
    weeks.get(k).punches.push(p);
  }
  for (const i of interventions) {
    const k = weekKeyOf(i.start);
    if (!weeks.has(k)) weeks.set(k, { monday: new Date(k), punches: [], interventions: [] });
    weeks.get(k).interventions.push(i);
  }
  const sortedWeeks = [...weeks.values()].sort((a, b) => a.monday - b.monday);

  let grandPunchMin = 0;
  const grandToVerifyCount = interventions.filter((i) => i.toVerify).length;

  // Deux parties distinctes plutôt qu'un mélange par semaine : toute la
  // feuille de temps d'abord, puis les interventions sur une nouvelle page.
  const punchWeekSections = sortedWeeks
    .map((w) => {
      const punchMin = w.punches.reduce((sum, p) => sum + minutesBetween(p.start, p.end), 0);
      const ventileMin = w.interventions.reduce((sum, i) => sum + minutesBetween(i.start, i.end), 0);
      grandPunchMin += punchMin;

      const punchRows = w.punches.length
        ? w.punches
            .map((p) => {
              const s = new Date(p.start);
              const e = new Date(p.end);
              return `<tr><td>${dateISO(s)}</td><td>${timeHM(s)}</td><td>${timeHM(e)}</td><td>${fmtDuration(minutesBetween(p.start, p.end))}</td></tr>`;
            })
            .join("")
        : `<tr><td colspan="4" class="empty-row">Aucune période travaillée</td></tr>`;

      return `
      <section class="week">
        <h3>${escapeHtml(isoWeekLabel(w.monday))}</h3>
        <table>
          <thead><tr><th>Date</th><th>Début</th><th>Fin</th><th>Durée</th></tr></thead>
          <tbody>${punchRows}</tbody>
          <tfoot><tr><td colspan="3">Total de la semaine — ventilé en interventions : ${fmtDuration(ventileMin)}</td><td>${fmtDuration(punchMin)} (${fmtDecimalHours(punchMin)} h)</td></tr></tfoot>
        </table>
      </section>`;
    })
    .join("");

  const grandInterventionMin = interventions.reduce((sum, i) => sum + minutesBetween(i.start, i.end), 0);
  const grandBillableMin = interventions
    .filter((i) => i.billable)
    .reduce((sum, i) => sum + minutesBetween(i.start, i.end), 0);

  const interventionWeekSections = sortedWeeks
    .map((w) => {
      const interventionMin = w.interventions.reduce((sum, i) => sum + minutesBetween(i.start, i.end), 0);

      const interventionRows = w.interventions.length
        ? w.interventions
            .map((i) => {
              const s = new Date(i.start);
              const e = new Date(i.end);
              return `<tr${i.toVerify ? ' class="to-verify-row"' : ""}>
                <td>${dateISO(s)}</td>
                <td>${timeHM(s)}–${timeHM(e)}</td>
                <td>${fmtDuration(minutesBetween(i.start, i.end))}</td>
                <td>${escapeHtml((i.clients || []).join(", ")) || "—"}</td>
                <td>${escapeHtml(i.ticket) || "—"}</td>
                <td>${escapeHtml(i.category)}</td>
                <td>${escapeHtml(i.description) || "—"}${
                  i.toVerify && i.verifyNote ? `<div class="verify-note">⚠️ ${escapeHtml(i.verifyNote)}</div>` : ""
                }</td>
                <td class="center">${i.billable ? "✓" : "—"}</td>
                <td class="center">${i.toVerify ? "⚠️" : "—"}</td>
              </tr>`;
            })
            .join("")
        : `<tr><td colspan="9" class="empty-row">Aucune intervention</td></tr>`;

      return `
      <section class="week">
        <h3>${escapeHtml(isoWeekLabel(w.monday))}</h3>
        <table>
          <thead><tr><th>Date</th><th>Heures</th><th>Durée</th><th>Client</th><th>Billet</th><th>Catégorie</th><th>Description</th><th>Fact.</th><th>Vérif.</th></tr></thead>
          <tbody>${interventionRows}</tbody>
          <tfoot><tr><td colspan="7">Total de la semaine</td><td colspan="2">${fmtDuration(interventionMin)}</td></tr></tfoot>
        </table>
      </section>`;
    })
    .join("");

  // Sommaire par billet inclus dans le rapport : c'est ce qui sert à facturer,
  // et il reprend les vraies heures de chaque intervention. Le regroupement se
  // fait par CLIENT d'abord, par billet ensuite : deux interventions sans
  // billet mais chez deux clients différents ne doivent jamais tomber dans le
  // même « (sans billet) », sinon la ligne fait croire qu'un seul client
  // absorbe des heures qui appartiennent en réalité à plusieurs. Une même
  // intervention à plusieurs clients (clientMinuteShares) répartit sa durée
  // à parts égales entre eux, pour la même raison.
  const parBillet = new Map();
  for (const i of interventions) {
    const ticket = (i.ticket || "").trim() || "(sans billet)";
    for (const share of clientMinuteShares(i)) {
      const k = `${share.client}␟${ticket}`;
      if (!parBillet.has(k)) {
        parBillet.set(k, { client: share.client, ticket, minutes: 0, billable: 0, count: 0, toVerify: 0 });
      }
      const g = parBillet.get(k);
      g.minutes += share.minutes;
      if (i.billable) g.billable += share.minutes;
      if (i.toVerify) g.toVerify++;
      g.count++;
    }
  }
  const summaryRows = [...parBillet.values()]
    .sort((a, b) => b.minutes - a.minutes)
    .map(
      (g) => `<tr${g.toVerify ? ' class="to-verify-row"' : ""}>
        <td>${escapeHtml(g.ticket)}</td>
        <td>${escapeHtml(g.client)}</td>
        <td class="center">${g.count}</td>
        <td>${fmtDuration(g.minutes)} (${fmtDecimalHours(g.minutes)} h)</td>
        <td>${fmtDuration(g.billable)} (${fmtDecimalHours(g.billable)} h)</td>
        <td class="center">${g.toVerify > 0 ? "⚠️ " + g.toVerify : "—"}</td>
      </tr>`
    )
    .join("");

  const generatedAt = new Date().toLocaleString("fr-CA");

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Rapport d'activité — TimeCalculator</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 32px; color: #1a1a1a; background: #fff; }
  .report-top { page-break-inside: avoid; break-inside: avoid; page-break-after: avoid; break-after: avoid; }
  .report-header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1a3a5c; padding-bottom: 16px; margin-bottom: 24px; }
  .report-header h1 { margin: 0; font-size: 1.6rem; color: #1a3a5c; }
  .report-header .meta { text-align: right; font-size: 0.85rem; color: #555; line-height: 1.5; }
  .summary-bar { display: flex; gap: 16px; margin-bottom: 32px; }
  .summary-card { flex: 1; border: 1px solid #d8dee5; border-radius: 8px; padding: 14px 16px; background: #f7f9fb; }
  .summary-card .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: #667; margin-bottom: 4px; }
  .summary-card .value { font-size: 1.3rem; font-weight: 700; color: #1a3a5c; }
  .summary-card.warning { background: #fff4e5; border-color: #f0b429; }
  .summary-card.warning .value { color: #9a5b00; }
  tr.to-verify-row td { background: #fff4e5; box-shadow: inset 4px 0 0 #d97706; }
  .verify-note { font-size: 0.85rem; font-weight: 700; color: #7c4a00; background: #fff4e5; border: 1px solid #d97706; border-radius: 6px; padding: 3px 7px; margin-top: 4px; display: inline-block; white-space: pre-wrap; }
  .report-part h2 { font-size: 1.2rem; color: #1a3a5c; border-bottom: 2px solid #1a3a5c; padding-bottom: 8px; margin: 0 0 20px; }
  .report-part.page-break { page-break-before: always; break-before: page; }
  section.week { margin-bottom: 28px; page-break-inside: avoid; break-inside: avoid; }
  section.week:first-of-type { page-break-before: avoid; break-before: avoid; }
  section.week h3 { font-size: 0.9rem; color: #445; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.03em; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 4px; }
  th, td { border: 1px solid #e1e6eb; padding: 6px 8px; text-align: left; }
  th { background: #eef2f6; font-weight: 600; }
  tfoot td { background: #f7f9fb; font-weight: 700; }
  td.center { text-align: center; }
  td.empty-row { text-align: center; color: #888; font-style: italic; }
  .print-bar { margin-bottom: 24px; }
  .print-bar button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #1a3a5c; background: #1a3a5c; color: #fff; cursor: pointer; }
  @media print {
    .print-bar { display: none; }
    body { padding: 0; }
    .report-top { page-break-inside: avoid; break-inside: avoid; page-break-after: avoid; break-after: avoid; }
    .report-part.page-break { page-break-before: always; break-before: page; }
    section.week { page-break-inside: avoid; break-inside: avoid; }
    section.week:first-of-type { page-break-before: avoid; break-before: avoid; }
  }
</style>
</head>
<body>
  <div class="print-bar"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>
  <div class="report-top">
    <div class="report-header">
      <h1>Rapport d'activité — TimeCalculator</h1>
      <div class="meta">
        Période : ${escapeHtml(rangeLabel())}<br>
        Généré le ${escapeHtml(generatedAt)}
      </div>
    </div>
    <div class="summary-bar">
      <div class="summary-card"><div class="label">Temps travaillé</div><div class="value">${fmtDuration(grandPunchMin)}</div></div>
      <div class="summary-card"><div class="label">Interventions</div><div class="value">${fmtDuration(grandInterventionMin)}</div></div>
      <div class="summary-card"><div class="label">Dont facturable</div><div class="value">${fmtDuration(grandBillableMin)}</div></div>
      <div class="summary-card${grandToVerifyCount > 0 ? " warning" : ""}"><div class="label">À vérifier</div><div class="value">${grandToVerifyCount}</div></div>
    </div>
  </div>
  <div class="report-part">
    <h2>Feuille de temps</h2>
    ${punchWeekSections}
  </div>
  <div class="report-part page-break">
    <h2>Interventions</h2>
    ${interventionWeekSections}
  </div>
  <div class="report-part page-break">
    <h2>Sommaire de facturation par billet</h2>
    <section class="week">
      <table>
        <thead><tr><th>Billet</th><th>Client(s)</th><th>Interv.</th><th>Durée totale</th><th>Dont facturable</th><th>Vérif.</th></tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
    </section>
  </div>
</body>
</html>`;

  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    alert("Le navigateur a bloqué l'ouverture du rapport. Autorisez les fenêtres pop-up pour ce site.");
    return;
  }
  reportWindow.document.open();
  reportWindow.document.write(html);
  reportWindow.document.close();
}

/* ---------- Rapport Simple (impression / PDF) ---------- */

// Feuille de temps dépouillée : une ligne par période travaillée, rien d'autre
// que le jour et les deux heures. Pas de durée, pas de total, pas d'intervention,
// pas de rapprochement — c'est le document qu'on remet à quelqu'un qui veut
// seulement savoir quand on est arrivé et quand on est parti. Les punchs ne sont
// pas fusionnés par jour : une pause reste lisible comme un trou entre deux
// lignes, alors qu'un « 08:00 à 17:00 » fusionné ferait mentir la journée.
function generateSimpleReport() {
  const [from, to] = filterRange();
  const punches = state.punches.filter((p) => inRange(p, from, to)).sort((a, b) => a.start - b.start);

  if (punches.length === 0) {
    alert("Aucune période travaillée pour cette période.");
    return;
  }

  const weekdayOf = (d) => {
    const s = d.toLocaleDateString("fr-CA", { weekday: "long" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const totalReel = punches.reduce((sum, p) => sum + minutesBetween(p.start, p.end), 0);
  const totalArrondi = roundToQuarterHour(totalReel);

  let dernierJour = null;
  const rows = punches
    .map((p) => {
      const s = new Date(p.start);
      const e = new Date(p.end);
      const jour = dateISO(s);
      // Un trait de séparation dès que la date change : sur papier, c'est ce qui
      // permet de voir d'un coup d'œil les journées coupées en deux.
      const nouveauJour = jour !== dernierJour;
      dernierJour = jour;
      return `<tr${nouveauJour ? ' class="jour-neuf"' : ""}>
        <td>${jour}</td>
        <td>${escapeHtml(weekdayOf(s))}</td>
        <td>${timeHM(s)}</td>
        <td>${timeHM(e)}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Feuille de temps — TimeCalculator</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 32px; color: #1a1a1a; background: #fff; }
  .report-header { border-bottom: 3px solid #1a3a5c; padding-bottom: 12px; margin-bottom: 20px; }
  .report-header h1 { margin: 0 0 4px; font-size: 1.4rem; color: #1a3a5c; }
  .report-header .meta { font-size: 0.85rem; color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
  th, td { border: 1px solid #e1e6eb; padding: 7px 10px; text-align: left; }
  th { background: #eef2f6; font-weight: 600; }
  tr.jour-neuf td { border-top: 2px solid #c3ccd6; }
  tfoot td { background: #f7f9fb; font-weight: 700; border-top: 2px solid #1a3a5c; }
  .print-bar { margin-bottom: 20px; }
  .print-bar button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #1a3a5c; background: #1a3a5c; color: #fff; cursor: pointer; }
  @media print {
    .print-bar { display: none; }
    body { padding: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="print-bar"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>
  <div class="report-header">
    <h1>Feuille de temps</h1>
    <div class="meta">Période : ${escapeHtml(rangeLabel())}</div>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Jour</th><th>Début</th><th>Fin</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">Total des heures travaillées</td><td colspan="2">${fmtDuration(totalArrondi)} (${fmtDecimalHours(totalArrondi)} h)</td></tr></tfoot>
  </table>
</body>
</html>`;

  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    alert("Le navigateur a bloqué l'ouverture du rapport. Autorisez les fenêtres pop-up pour ce site.");
    return;
  }
  reportWindow.document.open();
  reportWindow.document.write(html);
  reportWindow.document.close();
}

function exportJson() {
  downloadFile(
    `timecalculator-sauvegarde-${dateISO(new Date())}.json`,
    JSON.stringify(state, null, 2),
    "application/json"
  );
}

function importJson(file) {
  const reader = new FileReader();
  reader.onerror = () => alert("Le fichier n'a pas pu être lu.");
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert("Fichier de sauvegarde invalide : " + e.message);
      return;
    }
    if (!data || (!Array.isArray(data.interventions) && !Array.isArray(data.punches))) {
      alert("Fichier de sauvegarde invalide : ni périodes ni interventions.");
      return;
    }

    const { state: next, rejets } = normalizeState(data);
    const nP = next.punches.length;
    const nI = next.interventions.length;
    const actuel = `Vous avez actuellement ${state.punches.length} période(s) et ${state.interventions.length} intervention(s).`;
    const rejet = rejets > 0 ? `\n${rejets} enregistrement(s) illisible(s) du fichier seront écartés.` : "";
    if (
      !confirm(
        `Remplacer TOUTES les données actuelles par cette sauvegarde ?\n\n` +
          `Sauvegarde : ${nP} période(s), ${nI} intervention(s).\n${actuel}${rejet}\n\n` +
          `Le remplacement sera aussi propagé à vos autres appareils.\n` +
          `L'état actuel sera conservé dans ce navigateur sous « ${IMPORT_BACKUP_KEY} ».`
      )
    ) {
      return;
    }

    let copie = true;
    try {
      localStorage.setItem(IMPORT_BACKUP_KEY, JSON.stringify(state));
    } catch (e) {
      copie = false;
    }

    // Un import est un remplacement voulu : on horodate tout au présent pour
    // qu'il gagne l'arbitrage de fusion sur les autres appareils, et on pose
    // des pierres tombales sur ce qui disparaît.
    const maintenant = Date.now();
    const gardes = new Set([...next.punches, ...next.interventions].map((r) => r.id));
    const tombstones = { ...state.tombstones, ...next.tombstones };
    for (const r of [...state.punches, ...state.interventions]) {
      if (!gardes.has(r.id)) tombstones[r.id] = maintenant;
    }
    for (const r of [...next.punches, ...next.interventions]) r.updatedAt = maintenant;

    const previous = state;
    state = {
      ...next,
      tombstones,
      activePunchAt: maintenant,
      updatedAt: maintenant,
    };
    if (!save()) {
      state = previous;
      render();
      return;
    }
    render();
    banner({
      id: "import",
      tone: "info",
      text:
        `Import terminé : ${nP} période(s), ${nI} intervention(s).` +
        (rejets > 0 ? ` ${rejets} enregistrement(s) illisible(s) écarté(s).` : "") +
        (copie
          ? ` L'état précédent est conservé sous « ${IMPORT_BACKUP_KEY} » dans ce navigateur.`
          : " L'état précédent n'a PAS pu être sauvegardé (stockage plein)."),
    });
  };
  reader.readAsText(file);
}

/* ---------- Événements ---------- */

els.btnPunchIn.addEventListener("click", punchIn);
els.btnPunchOut.addEventListener("click", punchOut);
els.btnCancelPunch.addEventListener("click", cancelPunch);

els.btnStartIntervention.addEventListener("click", startIntervention);

els.interventionList.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  if (btn.dataset.finishChrono) finishIntervention(btn.dataset.finishChrono);
  if (btn.dataset.cancelChrono) cancelIntervention(btn.dataset.cancelChrono);
});

els.interventionList.addEventListener("change", (event) => {
  const client = event.target.closest("[data-chrono-client]");
  if (client) updateChronoClient(client.dataset.chronoClient, client.value);
  const debut = event.target.closest("[data-chrono-start]");
  if (debut) updateChronoStart(debut.dataset.chronoStart, debut.value);
});

els.btnAddPunch.addEventListener("click", () => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
  openPunchDialog({
    title: "Ajouter une période travaillée",
    date: dateISO(now),
    start: timeHM(oneHourAgo),
    end: timeHM(now),
  });
});

els.punchForm.addEventListener("submit", submitPunchForm);
els.btnPunchDialogCancel.addEventListener("click", () => els.punchDialog.close());
for (const id of ["p-date", "p-start", "p-end"]) {
  $(id).addEventListener("input", updatePunchFormDuration);
}

els.btnAddIntervention.addEventListener("click", () => nouvelleIntervention());

els.interventionForm.addEventListener("submit", submitInterventionForm);
els.btnInterventionDialogCancel.addEventListener("click", () => els.interventionDialog.close());
for (const id of ["f-date", "f-start", "f-end"]) {
  $(id).addEventListener("input", updateInterventionFormDuration);
}

// Un dialogue fermé sans enregistrer ne doit rien laisser derrière lui.
els.punchDialog.addEventListener("close", () => {
  punchDialogClosesActive = false;
  editOrigin = null;
});
els.interventionDialog.addEventListener("close", () => {
  interventionDialogClosesChrono = null;
  editOrigin = null;
});

function renderPeriodDependent() {
  els.rangeLabel.textContent = rangeLabel();
  updatePrintMeta();
  renderPunchTable();
  renderInterventionTable();
  renderSummaryTable();
}

// La feuille imprimée doit porter elle-même la période qu'elle couvre.
function updatePrintMeta() {
  const now = new Date();
  els.printMeta.textContent =
    `Période : ${rangeLabel()} — ${filtresActifs()} — imprimé le ${dateISO(now)} à ${timeHM(now)}`;
}

els.filterPeriod.addEventListener("change", () => {
  els.customRange.hidden = els.filterPeriod.value !== "custom";
  renderPeriodDependent();
});
els.filterFrom.addEventListener("change", renderPeriodDependent);
els.filterTo.addEventListener("change", renderPeriodDependent);
els.filterClient.addEventListener("change", () => {
  updatePrintMeta();
  renderInterventionTable();
  renderSummaryTable();
});
els.filterToVerify.addEventListener("change", () => {
  updatePrintMeta();
  renderInterventionTable();
  renderSummaryTable();
});
els.groupBy.addEventListener("change", () => {
  summaryExpanded.clear();
  renderSummaryTable();
});

els.punchTbody.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (btn) {
    if (btn.dataset.ventilerPunch) ventilerPunch(btn.dataset.ventilerPunch);
    if (btn.dataset.editPunch) editPunch(btn.dataset.editPunch);
    if (btn.dataset.deletePunch) deletePunch(btn.dataset.deletePunch);
    return;
  }
  const dayRow = event.target.closest("tr.day-row");
  if (dayRow) toggleDay(dayRow.dataset.day);
});

// Les lignes de jour sont actionnables au clavier, pas seulement à la souris.
els.punchTbody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const dayRow = event.target.closest("tr.day-row");
  if (!dayRow) return;
  event.preventDefault();
  toggleDay(dayRow.dataset.day);
});

els.interventionTbody.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  if (btn.dataset.editIntervention) editIntervention(btn.dataset.editIntervention);
  if (btn.dataset.deleteIntervention) deleteIntervention(btn.dataset.deleteIntervention);
});

els.interventionTbody.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-toggle-verify]");
  if (checkbox) {
    toggleInterventionVerify(checkbox.dataset.toggleVerify);
    return;
  }
  const noteInput = event.target.closest("[data-verify-note-input]");
  if (noteInput) updateInterventionVerifyNote(noteInput.dataset.verifyNoteInput, noteInput.value);
});

els.summaryTbody.addEventListener("click", (event) => {
  const row = event.target.closest("tr.summary-row");
  if (row) toggleSummaryGroup(row.dataset.groupe);
});
els.summaryTbody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr.summary-row");
  if (!row) return;
  event.preventDefault();
  toggleSummaryGroup(row.dataset.groupe);
});

els.fToVerify.addEventListener("change", () => {
  els.fVerifyNoteWrap.hidden = !els.fToVerify.checked;
  if (els.fToVerify.checked) els.fVerifyNote.focus();
});

els.btnToggleDays.addEventListener("click", () => {
  const jours = [...new Set(filteredPunches().map((p) => dateISO(new Date(p.start))))];
  const toutDeplie = jours.length > 0 && jours.every((j) => isDayExpanded(j));
  for (const j of jours) dayOverrides.set(j, !toutDeplie);
  els.btnToggleDays.textContent = toutDeplie ? "Tout déplier" : "Tout replier";
  renderPunchTable();
});

els.btnExportPunches.addEventListener("click", exportPunchesCsv);
els.btnExportInterventions.addEventListener("click", exportInterventionsCsv);
els.btnExportSummary.addEventListener("click", exportSummaryCsv);
els.btnExportReport.addEventListener("click", generateWeeklyReport);
els.btnSimpleReport.addEventListener("click", generateSimpleReport);
els.btnExportJson.addEventListener("click", exportJson);
els.btnPrint.addEventListener("click", () => window.print());
els.btnImport.addEventListener("click", () => els.inputImport.click());
els.inputImport.addEventListener("change", () => {
  if (els.inputImport.files.length > 0) {
    importJson(els.inputImport.files[0]);
    els.inputImport.value = "";
  }
});

// Deux onglets du même navigateur : la fusion s'applique aussi ici, pour que
// l'onglet resté ouvert ne réécrive pas ce que l'autre vient d'enregistrer.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY || event.newValue == null) return;
  if (event.newValue === lastWritten) return;
  try {
    const { state: distant } = normalizeState(JSON.parse(event.newValue));
    const fusionne = mergeStates(state, distant);
    if (sameState(fusionne, state)) return;
    state = fusionne;
    lastWritten = event.newValue;
    render();
    showToast("Données mises à jour depuis un autre onglet.");
  } catch (e) {
    /* l'autre onglet a écrit quelque chose d'illisible : on garde notre état */
  }
});

// À l'impression, toutes les journées sont dépliées et les boutons disparaissent.
window.addEventListener("beforeprint", () => {
  printing = true;
  updatePrintMeta();
  renderPunchTable();
});
window.addEventListener("afterprint", () => {
  printing = false;
  renderPunchTable();
});

// Raccourcis : uniquement hors des champs de saisie et hors dialogue.
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const t = event.target;
  if (t && (t.closest("input, textarea, select") || t.isContentEditable)) return;
  if (document.querySelector("dialog[open]")) return;
  if (document.querySelector("main").hidden) return;
  const k = event.key.toLowerCase();
  if (k === "p") {
    event.preventDefault();
    if (state.activePunch) punchOut();
    else punchIn();
  } else if (k === "d") {
    event.preventDefault();
    startIntervention();
  } else if (k === "t") {
    event.preventDefault();
    // La dernière démarrée : avec plusieurs chronos en marche, c'est celle
    // qu'on vient d'ouvrir, donc celle qu'on termine le plus souvent.
    const derniere = [...state.activeInterventions].sort((a, b) => a.start - b.start).pop();
    if (derniere) finishIntervention(derniere.id);
  } else if (k === "i") {
    event.preventDefault();
    nouvelleIntervention();
  }
});

/* ---------- Authentification et synchronisation ---------- */

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
    elsAuth.error.textContent = "Connexion échouée : " + e.message;
    elsAuth.error.hidden = false;
  });
});

elsAuth.btnLogout.addEventListener("click", () => signOut(auth));

let unsubscribeSnapshot = null;

onAuthStateChanged(auth, (user) => {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }

  if (!user) {
    userDocRef = null;
    elsAuth.gate.hidden = false;
    elsAuth.main.hidden = true;
    elsAuth.btnLogout.hidden = true;
    return;
  }

  elsAuth.gate.hidden = true;
  elsAuth.main.hidden = false;
  elsAuth.btnLogout.hidden = false;

  userDocRef = doc(db, "users", user.uid, "timecalculator", "state");

  // Affichage instantané depuis le cache local pendant que Firestore répond.
  state = load();
  checkPunchOublie();
  checkInterventionOubliee();
  render();

  unsubscribeSnapshot = onSnapshot(userDocRef, (snap) => {
    applyRemoteSnapshot(snap);
  });
});

/*
 * Réception d'un instantané Firestore.
 *
 * Le piège corrigé ici : hors ligne (ou juste avant la première réponse du
 * serveur), Firestore livre un instantané venu du cache où le document paraît
 * inexistant. L'ancienne version poussait alors l'état local par-dessus le
 * document réel — et si le localStorage venait d'être vidé, elle y écrivait un
 * état VIDE, effaçant des semaines de feuille de temps. On n'amorce donc jamais
 * un document depuis un instantané de cache.
 */
function applyRemoteSnapshot(snap) {
  if (!snap.exists()) {
    if (snap.metadata && snap.metadata.fromCache) return;
    // Le serveur confirme qu'il n'y a rien : première connexion. On n'amorce
    // qu'avec des données réelles.
    if (state.punches.length > 0 || state.interventions.length > 0) syncUp();
    return;
  }

  const { state: incoming } = normalizeState(snap.data());
  const fusionne = mergeStates(state, incoming);

  const changementLocal = !sameState(fusionne, state);
  const changementDistant = !sameState(fusionne, incoming);

  if (changementLocal) {
    applyingRemote = true;
    state = fusionne;
    try {
      persistLocal();
    } catch (e) {
      banner({
        id: "save",
        tone: "danger",
        text: "Les données reçues n'ont pas pu être enregistrées sur cet appareil : " + e.message,
      });
    }
    checkPunchOublie();
    checkInterventionOubliee();
    render();
    applyingRemote = false;
  }

  // L'état local contenait quelque chose que le document n'a pas : on le
  // renvoie au lieu de l'abandonner (l'ancienne version se contentait de
  // « return », et le travail hors ligne restait coincé sur l'appareil).
  if (changementDistant) {
    state = fusionne;
    syncUp();
  }
}

/* ---------- Démarrage ---------- */

// Au changement de jour, la journée qui se termine se replie et rejoint
// les autres journées de la semaine; le sommaire repart pour le nouveau jour.
setInterval(() => {
  const now = dateISO(new Date());
  if (now !== todayKey) {
    todayKey = now;
    dayOverrides.clear();
    render();
  }
}, 30000);

for (const b of pendingBanners) banner(b);
try {
  lastWritten = localStorage.getItem(STORAGE_KEY);
} catch (e) {
  lastWritten = null;
}
checkPunchOublie();
checkInterventionOubliee();
render();
