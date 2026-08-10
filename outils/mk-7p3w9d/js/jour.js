/*
 * « Ma journée » — page compagnon du tableau de bord marketing.
 *
 * Un seul écran qui répond à « quoi faire aujourd'hui ? », calculé de la
 * date : tâches échues ou épinglées, brouillons de prospection à envoyer,
 * publication LinkedIn du jour ouvrable, candidats à trier, et les rituels
 * de la semaine (cycle du prospecteur le lundi, recherchiste le jeudi,
 * point d'avancement le vendredi). Lecture seule : chaque élément mène à
 * l'endroit où le geste se pose (tableau de bord filtré, page du lot).
 *
 * Données : les mêmes documents Firestore que le tableau de bord
 * (state, prospection, linkedin-lot) — rien de nouveau à sécuriser.
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
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";
import {
  lireMandat, rendreSelecteur, surChangementDeMandat,
  mandatExterne, appartientAuMandat,
} from "./mandat.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const $ = (id) => document.getElementById(id);
const ech = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const jourISO = (d = new Date()) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
};

let state = null, prospection = null, lot = null;

function avis(message, erreur) {
  const d = document.createElement("div");
  d.className = "banner" + (erreur ? " err" : "");
  d.textContent = message;
  $("banners").appendChild(d);
  setTimeout(() => d.remove(), 8000);
}

/* ═══════════════════════════  calcul du jour  ══════════════════════════ */

const versTaches = (texte) => "./#q=" + encodeURIComponent(texte);

function item(badge, classe, texte, lien, quand) {
  return `<div class="j-item"><span class="pil ${classe}">${badge}</span>` +
    (lien ? `<a href="${ech(lien)}">${ech(texte)}</a>`
          : `<span class="j-texte">${ech(texte)}</span>`) +
    (quand ? `<span class="j-quand">${ech(quand)}</span>` : "") + `</div>`;
}

function section(titre, sousTitre, items, urgent) {
  if (!items.length) return "";
  return `<div class="j-sect${urgent ? " urgent" : ""}"><h2>${titre}</h2>` +
    (sousTitre ? `<div class="note">${sousTitre}</div>` : "") + items.join("") + "</div>";
}

/*
 * Le mandat courant, partagé avec le tableau de bord. « Ma journée » mélangeait
 * les deux mandats : la journée d'un mandat n'est pas la journée de l'autre, et
 * une échéance vue au mauvais endroit se traite au mauvais endroit.
 */
let mandat = lireMandat();
surChangementDeMandat((v) => { mandat = v; rendre(); });

function rendre() {
  if (!state) return;

  const mandats = [...new Set((state.taches || []).map((t) => t.client).filter(Boolean))].sort();
  if (mandat && !mandats.includes(mandat)) mandat = "";
  rendreSelecteur("f-mandat", mandats, mandat, (v) => { mandat = v; rendre(); });

  // Les rituels et la publication du jour appartiennent au mandat servi par les
  // processus de BG001 — prospecteur, recherchiste, lot LinkedIn. Sous un autre
  // mandat, ils n'ont rien à faire dans la journée.
  const sien = appartientAuMandat(mandat, mandatExterne());

  const auj = jourISO();
  const d = new Date();
  const js = d.getDay();                       // 0 = dimanche
  // Fériés du Québec sur l'horizon du plan : ni rituel, ni bloc d'appels, et
  // ils ne comptent pas comme jours ouvrés dans l'échéancier J+3/J+6/J+8.
  const FERIES = new Set([
    "2026-09-07", "2026-10-12", "2026-12-25", "2027-01-01", "2027-03-26",
    "2027-05-24", "2027-06-24", "2027-07-01", "2027-09-06", "2027-10-11",
  ]);
  const ouvrable = js >= 1 && js <= 5 && !FERIES.has(auj);
  const dans7 = jourISO(new Date(d.getTime() + 7 * 86400000));
  $("j-date").textContent = "// " +
    d.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const actives = (state.taches || [])
    .filter((t) => !mandat || t.client === mandat)
    .filter((t) => t.statut !== "fait" && t.statut !== "reporte");
  const places = new Set();
  const prendre = (t) => { places.add(t.id); return t; };
  const libres = (f) => actives.filter((t) => !places.has(t.id) && f(t));

  /* ── en retard ── */
  const retard = [];
  for (const t of actives.filter((t) => t.echeance && t.echeance < auj)) {
    retard.push(item("ÉCHUE", "retard", t.titre, versTaches(t.titre), t.echeance));
    prendre(t);
  }
  for (const t of libres((t) => t.jour && t.jour < auj)) {
    retard.push(item("RESTÉE", "reporte", t.titre, versTaches(t.titre), "épinglée le " + t.jour));
    prendre(t);
  }

  /* ── aujourd'hui ── */
  const jour = [];
  // Rituels de la semaine type du plan « Entonnoir 24 » (décisions 31-33).
  // Pendant le sprint (17 août – 2 octobre), le mercredi est un bloc d'appels.
  // Un férié n'a ni rituel ni bloc — la règle de report du plan s'applique.
  const sprint = auj >= "2026-08-17" && auj <= "2026-10-02";
  if (sien && ouvrable && js === 1) jour.push(item("RITUEL", "client",
    "Bloc d'envois : relire les brouillons du prospecteur et TOUT envoyer aujourd'hui " +
    "(règle des 24 h), puis publier la publication LinkedIn", "./"));
  if (sien && ouvrable && js === 2) jour.push(item("RITUEL", "client",
    "Bloc d'appels n° 1 — 9 h 30 à 11 h 30 (2ᵉ tentatives, suivis de soumissions)", "./"));
  if (sien && ouvrable && js === 3 && sprint) jour.push(item("RITUEL", "client",
    "Bloc d'appels n° 3 — 9 h 30 à 11 h 30 (3ᵉ tentatives) — sprint : la production attend", "./"));
  if (sien && ouvrable && js === 4) jour.push(item("RITUEL", "client",
    "Bloc d'appels n° 2 — 9 h 30 à 11 h 30 (1ʳᵉˢ tentatives des envois du lundi), " +
    "puis trier les candidats du moteur", "./"));
  if (sien && ouvrable && js === 5) jour.push(item("RITUEL", "temps",
    "Relevé d'entonnoir — bouton « Relevé du vendredi » au tableau de bord, " +
    "puis planifier les relances de la semaine", "./"));

  // La liste d'appels du jour, les jours de bloc : qui est dû (J+3 / J+6 /
  // J+8 ouvrés après l'envoi, 3 tentatives max), douleur d'abord — un site
  // web hors ligne accepte vite, et une acceptation rapide est du revenu.
  // NOTE : cet échéancier téléphonique est distinct de la colonne « Prochaine »
  // du tableau de bord, qui cadence les relances ÉCRITES (J+14, prospecteur).
  const jourBloc = ouvrable && (js === 2 || js === 4 || (js === 3 && sprint));
  if (sien && jourBloc && prospection) {
    const ouvre = (iso, n) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "9999-12-31";
      const d2 = new Date(iso + "T12:00:00");
      let k = 0;
      while (k < n) {
        d2.setDate(d2.getDate() + 1);
        const j2 = d2.getDay();
        if (j2 >= 1 && j2 <= 5 && !FERIES.has(jourISO(d2))) k++;
      }
      return jourISO(d2);
    };
    const enAttente = prospection.appels || {};
    const sig = prospection.signaux || {};
    const statutVif = (p) => (sig[p.id] && sig[p.id].statut) || p.statut;
    // Liste d'admission, pas de blocage : un statut inconnu ne s'appelle pas.
    // « relance_preparee » attend son envoi — le brouillon est déjà listé plus
    // haut, on n'affiche pas l'appel ET l'envoi du même prospect.
    const APPELABLES = new Set(["a_contacter", "contacte_sans_reponse", "relance_envoyee"]);
    const sienP = (p) => p.mandat ? appartientAuMandat(mandat, p.mandat) : sien;
    const dus = (prospection.prospects || [])
      .filter((p) => sienP(p) && p.dernierContact && APPELABLES.has(statutVif(p)))
      .map((p) => ({ p, n: (p.appelsFaits || 0) + ((enAttente[p.id] || []).length) }))
      .filter(({ p, n }) => n < 3 && auj >= ouvre(p.dernierContact, [3, 6, 8][n]) &&
        p.dernierAppel !== auj && !(enAttente[p.id] || []).some((a) => a.date === auj))
      .sort((a, b) =>
        (/hors ligne/i.test(b.p.note || "") ? 1 : 0) - (/hors ligne/i.test(a.p.note || "") ? 1 : 0) ||
        (a.p.dernierContact || "").localeCompare(b.p.dernierContact || ""));
    for (const { p, n } of dus) {
      jour.push(item("APPEL", "retard",
        `${p.prospect} — tentative ${n + 1}${p.telephone ? " · " + p.telephone : ""}` +
        (/hors ligne/i.test(p.note || "") ? " · ⚡ site hors ligne" : ""), "./"));
    }
  }
  // La publication LinkedIn du jour ouvrable.
  const posts = ((lot && lot.posts) || []).slice().sort((a, b) => (a.n || 0) - (b.n || 0));
  const prochainePub = posts.find((p) => p.statutPub !== "publie");
  // Pour LinkedIn on exige un propriétaire CONNU, là où le reste se contente
  // de « appartient ou appartenance inconnue » : publier au nom de la mauvaise
  // entreprise est l'erreur la plus coûteuse de l'outil. Sur un appareil neuf,
  // qui n'a pas encore ouvert le tableau de bord, l'appartenance est inconnue —
  // et la publication d'un mandat apparaîtrait dans la journée de l'autre.
  const linkedinSien = Boolean(mandatExterne()) && sien;
  if (linkedinSien && ouvrable && prochainePub) {
    jour.push(item("LINKEDIN", "en_cours",
      `Publier la publication ${prochainePub.n} — ${prochainePub.sujet || ""}`, "linkedin.html"));
  }
  // Les brouillons de prospection en attente d'envoi.
  for (const t of libres((t) => t.chantier === "Prospection" &&
      /^(Relance \d+|Premier contact) — /.test(t.titre || ""))) {
    jour.push(item("PROSPECTION", "client", t.titre + " (brouillon prêt)", versTaches(t.titre)));
    prendre(t);
  }
  // Épinglées et échéances du jour.
  for (const t of libres((t) => t.jour === auj || t.echeance === auj)) {
    jour.push(item("TÂCHE", "", t.titre, versTaches(t.titre),
      t.echeance === auj ? "échéance aujourd'hui" : ""));
    prendre(t);
  }

  /* ── à trier / à décider ── */
  const trier = [];
  const decisions = (prospection && prospection.candidatures) || {};
  const candidats = ((prospection && prospection.candidats) || [])
    .filter((c) => !decisions[c.id]);
  if (sien && candidats.length) {
    trier.push(item("CANDIDATS", "en_cours",
      `${candidats.length} candidat${candidats.length > 1 ? "s" : ""} de l'engin à accepter ou rejeter`, "./"));
  }
  const bloquees = libres((t) => t.statut === "bloque");
  if (bloquees.length) {
    trier.push(item("BLOQUÉES", "bloque",
      `${bloquees.length} tâche${bloquees.length > 1 ? "s" : ""} bloquée${bloquees.length > 1 ? "s" : ""} — un blocage est-il levé ?`,
      "./"));
  }

  /* ── cette semaine ── */
  const semaine = libres((t) => t.echeance && t.echeance > auj && t.echeance <= dans7)
    .sort((a, b) => a.echeance.localeCompare(b.echeance))
    .map((t) => item("TÂCHE", "", t.titre, versTaches(t.titre), t.echeance));

  const nActions = retard.length + jour.length;
  $("j-compte").textContent = nActions
    ? `${nActions} action${nActions > 1 ? "s" : ""} aujourd'hui`
    : "Journée dégagée";
  $("j-sections").innerHTML =
    section("En retard", "À régler ou à reprogrammer avant le reste.", retard, true) +
    section("Aujourd'hui", "", jour) +
    section("À trier", "", trier) +
    section("Cette semaine", "Les échéances des 7 prochains jours.", semaine) ||
    `<div class="vide">Rien à signaler — choisir une tâche active au tableau de bord.</div>`;
}

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

let abonnements = [];

onAuthStateChanged(auth, (user) => {
  abonnements.forEach((f) => f());
  abonnements = [];

  if (!user) {
    state = prospection = lot = null;
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

  const suivre = (nom, applique) => abonnements.push(onSnapshot(
    doc(db, "users", user.uid, "marketing", nom),
    (snap) => { applique(snap.exists() ? snap.data() : null); rendre(); },
    (e) => avis("Lecture Firestore refusée : " + e.message, true)));
  suivre("state", (v) => { state = v; });
  suivre("prospection", (v) => { prospection = v; });
  suivre("linkedin-lot", (v) => { lot = v; });
});

/* Minuit passé, la journée change : on recalcule sans recharger. */
setInterval(rendre, 300000);
