/*
 * Suite de tests de TimeCalculator.
 *
 * S'exécute dans genere/banc.html, APRÈS app-instrumente.js : l'application
 * réelle est chargée (Firebase remplacé par les bouchons de tests/bouchons/),
 * et son intérieur est accessible par globalThis.__tc (voir pont.js).
 *
 * À la fin, les résultats sont envoyés en POST à /__resultats, où lancer.sh
 * les lit pour produire un code de sortie. La page affiche aussi un tableau,
 * utile quand on l'ouvre à la main dans un navigateur.
 *
 * Le fuseau attendu est America/Toronto (imposé par lancer.sh) : les tests
 * de changement d'heure — 8 mars et 1er novembre 2026 — en dépendent.
 */

import { MICROSOFT_TENANT_ID } from "/js/firebase-config.js";

const tc = globalThis.__tc;
const bouchon = globalThis.__bouchon;

/* ---------- Harnais ---------- */

const resultats = [];
let sectionCourante = "?";

function section(nom) {
  sectionCourante = nom;
}

async function test(nom, fn) {
  try {
    await fn();
    resultats.push({ section: sectionCourante, nom, ok: true });
  } catch (e) {
    resultats.push({
      section: sectionCourante,
      nom,
      ok: false,
      message: String((e && e.stack) || e).split("\n").slice(0, 3).join(" | "),
    });
  }
}

function egal(obtenu, attendu, quoi) {
  if (!Object.is(obtenu, attendu)) {
    throw new Error(`${quoi || "valeur"} : attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`);
  }
}

function vrai(condition, quoi) {
  if (!condition) throw new Error(quoi || "condition fausse");
}

function contient(chaine, morceau, quoi) {
  if (!String(chaine).includes(morceau)) {
    throw new Error(`${quoi || "chaîne"} : « ${morceau} » absent de « ${String(chaine).slice(0, 300)}… »`);
  }
}

function absent(chaine, morceau, quoi) {
  if (String(chaine).includes(morceau)) {
    throw new Error(`${quoi || "chaîne"} : « ${morceau} » ne devrait PAS s'y trouver`);
  }
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function attendreQue(fn, quoi, delaiMs = 3000) {
  const debut = Date.now();
  while (Date.now() - debut < delaiMs) {
    if (fn()) return;
    await attendre(25);
  }
  throw new Error(`délai dépassé : ${quoi}`);
}

/* Fenêtres natives détournées : un banc sans écran ne peut pas répondre à
 * confirm(), et alert() y bloquerait tout. */
const alertes = [];
let reponseConfirm = true;
window.alert = (m) => alertes.push(String(m));
window.confirm = () => reponseConfirm;

const erreursGlobales = [];
window.addEventListener("error", (e) => erreursGlobales.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => erreursGlobales.push(String(e.reason)));

async function fermerDialogues() {
  if (tc.els.punchDialog.open) tc.els.punchDialog.close();
  if (tc.els.interventionDialog.open) tc.els.interventionDialog.close();
  await attendre(0); // laisser les écouteurs « close » s'exécuter
}

async function reinitialiser() {
  await fermerDialogues();
  reponseConfirm = true;
  alertes.length = 0;
  tc.state = tc.emptyState();
  tc.syncBloquee = false;
  tc.applyingRemote = false;
  tc.editOrigin = null;
  tc.activeBanners.clear();
  tc.renderBanners();
  tc.dayOverrides.clear();
  tc.summaryExpanded.clear();
  tc.els.filterPeriod.value = "all";
  tc.els.customRange.hidden = true;
  tc.els.filterClient.value = "";
  tc.els.filterToVerify.checked = false;
  tc.persistLocal();
  bouchon.viderEcritures();
  bouchon.echecEcriture = null;
  tc.render();
}

// Champs factices pour timesFromFields (qui ne lit que .value).
const ch = (value) => ({ value });

// Une date locale du jour J (0 = aujourd'hui, -1 = hier) à h:m.
function ceJour(decalageJours, h, m) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + decalageJours, h, m);
}

const evenement = { preventDefault() {} };

/* =====================================================================
 * A. Formats et durées
 * =================================================================== */
async function sectionA() {
  section("A. Formats");

  await test("fmtDuration : 0, minutes seules, heures", () => {
    egal(tc.fmtDuration(0), "0 min");
    egal(tc.fmtDuration(59), "59 min");
    egal(tc.fmtDuration(60), "1 h 00");
    egal(tc.fmtDuration(90), "1 h 30");
    egal(tc.fmtDuration(605), "10 h 05");
  });

  await test("fmtDecimalHours : virgule décimale", () => {
    egal(tc.fmtDecimalHours(90), "1,50");
    egal(tc.fmtDecimalHours(100), "1,67");
    egal(tc.fmtDecimalHours(0), "0,00");
  });

  await test("minutesBetween arrondit à la minute", () => {
    egal(tc.minutesBetween(0, 90 * 1000), 2); // 1,5 min → 2
    egal(tc.minutesBetween(0, 60 * 1000), 1);
    egal(tc.minutesBetween(0, 29 * 1000), 0);
  });

  await test("dateISO et timeHM avec zéros initiaux", () => {
    egal(tc.dateISO(new Date(2026, 0, 5)), "2026-01-05");
    egal(tc.timeHM(new Date(2026, 0, 5, 7, 8)), "07:08");
  });

  await test("dayLabel : français, majuscule initiale", () => {
    egal(tc.dayLabel(new Date(2026, 6, 15)), "Mercredi 15 juillet 2026");
  });

  await test("escapeHtml neutralise les 5 caractères sensibles", () => {
    egal(tc.escapeHtml(`<a b="c">&'`), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;");
    egal(tc.escapeHtml(null), "");
  });
}

/* =====================================================================
 * B. Calendrier (dont changements d'heure 2026)
 * =================================================================== */
async function sectionB() {
  section("B. Calendrier");

  await test("startOfWeek : le lundi, depuis mercredi, dimanche et lundi", () => {
    egal(tc.dateISO(tc.startOfWeek(new Date(2026, 6, 15))), "2026-07-13"); // mercredi
    egal(tc.dateISO(tc.startOfWeek(new Date(2026, 6, 19))), "2026-07-13"); // dimanche
    egal(tc.dateISO(tc.startOfWeek(new Date(2026, 6, 13))), "2026-07-13"); // lundi
  });

  await test("8 mars 2026 : la journée dure 23 h (heure avancée)", () => {
    const diff = new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime();
    egal(diff, 23 * 3600 * 1000);
  });

  await test("1er novembre 2026 : la journée dure 25 h (heure normale)", () => {
    const diff = new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime();
    egal(diff, 25 * 3600 * 1000);
  });

  await test("addDays passe par le calendrier, pas par +24 h", () => {
    // Le lendemain du 7 mars à minuit est le 8 mars à minuit, même si la
    // nuit ne compte que 23 h.
    egal(tc.dateISO(tc.addDays(new Date(2026, 2, 7), 1)), "2026-03-08");
    egal(tc.addDays(new Date(2026, 2, 7), 1).getHours(), 0);
  });

  await test("addMonths retombe toujours sur le 1er", () => {
    egal(tc.dateISO(tc.addMonths(new Date(2026, 0, 31), 1)), "2026-02-01");
    egal(tc.dateISO(tc.addMonths(new Date(2026, 0, 15), -1)), "2025-12-01");
  });

  await test("isoWeekLabel : même mois et mois à cheval", () => {
    egal(tc.isoWeekLabel(new Date(2026, 6, 13)), "Semaine du 13 au 19 juillet 2026");
    egal(tc.isoWeekLabel(new Date(2026, 5, 29)), "Semaine du 29 juin au 5 juillet 2026");
  });

  await test("parseDateInput : format strict", () => {
    egal(tc.dateISO(tc.parseDateInput("2026-07-15")), "2026-07-15");
    egal(tc.parseDateInput("15/07/2026"), null);
    egal(tc.parseDateInput(""), null);
  });
}

/* =====================================================================
 * C. Champs date/heure et changements d'heure
 * =================================================================== */
async function sectionC() {
  section("C. Saisie des heures");

  await test("période normale : 9 h à 17 h = 480 min", () => {
    const t = tc.timesFromFields(ch("2026-07-15"), ch("09:00"), ch("17:00"));
    egal(t.start, new Date(2026, 6, 15, 9, 0).getTime(), "début");
    egal(tc.minutesBetween(t.start, t.end), 480, "durée");
  });

  await test("fin avant début = le lendemain", () => {
    const t = tc.timesFromFields(ch("2026-07-15"), ch("22:00"), ch("06:00"));
    egal(t.end, new Date(2026, 6, 16, 6, 0).getTime(), "fin le 16");
    egal(tc.minutesBetween(t.start, t.end), 480, "durée");
  });

  await test("nuit du 8 mars : le lendemain n'est PAS « +24 h »", () => {
    const t = tc.timesFromFields(ch("2026-03-07"), ch("23:30"), ch("23:00"));
    egal(t.end, new Date(2026, 2, 8, 23, 0).getTime(), "fin calendrier");
    vrai(
      t.end !== new Date(2026, 2, 7, 23, 0).getTime() + 24 * 3600 * 1000,
      "la version « +24 h » aurait donné 1 h de trop"
    );
    egal(tc.minutesBetween(t.start, t.end), 1350, "23 h 30 affichées = 22 h 30 réelles");
  });

  await test("nuit du 8 mars : 1 h 30 à 3 h 30 = 60 minutes réelles", () => {
    const t = tc.timesFromFields(ch("2026-03-08"), ch("01:30"), ch("03:30"));
    egal(tc.minutesBetween(t.start, t.end), 60);
  });

  await test("nuit du 1er novembre : 23 h à 6 h = 480 minutes réelles", () => {
    const t = tc.timesFromFields(ch("2026-10-31"), ch("23:00"), ch("06:00"));
    egal(tc.minutesBetween(t.start, t.end), 480, "7 h affichées = 8 h réelles");
  });

  await test("champs invalides ou vides → null", () => {
    egal(tc.timesFromFields(ch(""), ch("09:00"), ch("17:00")), null);
    egal(tc.timesFromFields(ch("2026-07-15"), ch(""), ch("17:00")), null);
    egal(tc.timesFromFields(ch("2026-07-15"), ch("9h30"), ch("17:00")), null);
  });

  await test("resolveTimes réutilise les timestamps d'origine si rien n'a bougé", () => {
    // Ambiguïté du retour à l'heure normale : « 01:30 » existe deux fois le
    // 1er novembre. Si l'utilisateur n'a rien touché, on garde les vrais ms.
    const origStart = 1234567890123;
    const origEnd = 1234567890123 + 900000;
    tc.editOrigin = {
      id: "amb1", date: "2026-11-01", start: "01:30", end: "01:45",
      start_ms: origStart, end_ms: origEnd,
    };
    const t = tc.resolveTimes("amb1", ch("2026-11-01"), ch("01:30"), ch("01:45"));
    egal(t.start, origStart, "start intact");
    egal(t.end, origEnd, "end intact");

    const t2 = tc.resolveTimes("amb1", ch("2026-11-01"), ch("01:30"), ch("01:50"));
    vrai(t2.end !== origEnd, "un champ modifié → recalcul");
    tc.editOrigin = null;
  });
}

/* =====================================================================
 * D. Normalisation et chargement
 * =================================================================== */
async function sectionD() {
  section("D. Normalisation");

  await test("sanePeriod rejette l'inutilisable, répare l'identifiant", () => {
    egal(tc.sanePeriod(null), null);
    egal(tc.sanePeriod({ start: 5, end: 5 }), null);
    egal(tc.sanePeriod({ start: "abc", end: 10 }), null);
    const r = tc.sanePeriod({ start: 1, end: 2 });
    vrai(r.id.length > 0, "id réparé");
    egal(r.updatedAt, 0, "updatedAt absent → 0");
  });

  await test("normalizeState : champs inconnus conservés, défauts appliqués", () => {
    const { state: s, rejets } = tc.normalizeState({
      punches: "pas-un-tableau",
      interventions: [
        { id: "a", start: 1000, end: 2000, extra: "garde-moi", client: 42 },
        { start: 2, end: 1 }, // rejet
      ],
    });
    egal(s.punches.length, 0, "punches non-tableau → vide");
    egal(rejets, 1, "une intervention rejetée");
    const i = s.interventions[0];
    egal(i.extra, "garde-moi", "champ inconnu conservé");
    egal(i.client, "42", "client converti en chaîne");
    egal(i.category, "Autre", "catégorie par défaut");
    egal(i.billable, true, "facturable par défaut");
    egal(i.toVerify, false);
    egal(i.verifyNote, "");
  });

  await test("normalizeState : pierres tombales élaguées après 180 jours", () => {
    const { state: s } = tc.normalizeState({
      punches: [],
      interventions: [],
      tombstones: {
        vieux: Date.now() - tc.TOMBSTONE_TTL_MS - 1000,
        recent: Date.now() - 1000,
      },
    });
    egal("vieux" in s.tombstones, false, "vieille pierre élaguée");
    egal("recent" in s.tombstones, true, "récente conservée");
  });

  await test("normalizeState : activePunch invalide → null", () => {
    const { state: s } = tc.normalizeState({ punches: [], interventions: [], activePunch: { start: "n/a" } });
    egal(s.activePunch, null);
    const { state: s2 } = tc.normalizeState({ punches: [], interventions: [], activePunch: { start: 123 } });
    egal(s2.activePunch.start, 123);
  });

  await test("load : données illisibles → quarantaine + synchro suspendue", () => {
    localStorage.setItem(tc.STORAGE_KEY, "{{{pas-du-json");
    const s = tc.load();
    egal(s.punches.length, 0, "état neuf");
    egal(tc.syncBloquee, true, "synchro suspendue");
    const cles = Object.keys(localStorage).filter((k) => k.startsWith(tc.QUARANTINE_PREFIX));
    egal(cles.length, 1, "une clé de quarantaine");
    egal(localStorage.getItem(cles[0]), "{{{pas-du-json", "contenu d'origine intact");
    for (const k of cles) localStorage.removeItem(k);
    tc.syncBloquee = false;
  });

  await test("load : JSON valide mais structure étrangère → quarantaine aussi", () => {
    localStorage.setItem(tc.STORAGE_KEY, '{"foo": 1}');
    tc.load();
    egal(tc.syncBloquee, true);
    const cles = Object.keys(localStorage).filter((k) => k.startsWith(tc.QUARANTINE_PREFIX));
    vrai(cles.length >= 1, "clé de quarantaine présente");
    for (const k of cles) localStorage.removeItem(k);
    tc.syncBloquee = false;
  });

  await test("load : enregistrements rejetés → la synchro montante se bloque", () => {
    localStorage.setItem(
      tc.STORAGE_KEY,
      JSON.stringify({ punches: [{ id: "ok", start: 1, end: 2 }, { id: "casse", start: 9, end: 3 }], interventions: [] })
    );
    const s = tc.load();
    egal(s.punches.length, 1, "le bon punch survit");
    egal(tc.syncBloquee, true, "rien ne part vers Firestore avant arbitrage");
    tc.syncBloquee = false;
  });

  await reinitialiser();
}

/* =====================================================================
 * E. Fusion entre appareils
 * =================================================================== */
async function sectionE() {
  section("E. Fusion");

  const etat = (extra) => ({
    activePunch: null, activePunchAt: 0, punches: [], interventions: [],
    tombstones: {}, updatedAt: 0, ...extra,
  });

  await test("union d'enregistrements distincts, triée par début", () => {
    const f = tc.mergeStates(
      etat({ punches: [{ id: "b", start: 200, end: 300, updatedAt: 1 }] }),
      etat({ punches: [{ id: "a", start: 100, end: 150, updatedAt: 1 }] })
    );
    egal(f.punches.length, 2);
    egal(f.punches[0].id, "a", "tri par début");
  });

  await test("même identifiant : le updatedAt le plus récent gagne", () => {
    const f = tc.mergeStates(
      etat({ interventions: [{ id: "x", start: 100, end: 200, client: "local", updatedAt: 5 }] }),
      etat({ interventions: [{ id: "x", start: 100, end: 200, client: "distant", updatedAt: 9 }] })
    );
    egal(f.interventions[0].client, "distant");
  });

  await test("égalité de updatedAt : la version locale est conservée", () => {
    const f = tc.mergeStates(
      etat({ punches: [{ id: "x", start: 100, end: 200, updatedAt: 5 }] }),
      etat({ punches: [{ id: "x", start: 100, end: 250, updatedAt: 5 }] })
    );
    egal(f.punches[0].end, 200);
  });

  await test("pierre tombale postérieure : l'enregistrement disparaît", () => {
    const f = tc.mergeStates(
      etat({ punches: [{ id: "x", start: 100, end: 200, updatedAt: 50 }] }),
      etat({ tombstones: { x: 100 } })
    );
    egal(f.punches.length, 0);
    egal(f.tombstones.x, 100, "pierre conservée");
  });

  await test("réédition postérieure à la suppression : l'enregistrement revient", () => {
    const f = tc.mergeStates(
      etat({ punches: [{ id: "x", start: 100, end: 200, updatedAt: 150 }] }),
      etat({ tombstones: { x: 100 } })
    );
    egal(f.punches.length, 1, "modifié après suppression → conservé");
  });

  await test("pierres tombales : la plus récente de chaque côté", () => {
    const f = tc.mergeStates(
      etat({ tombstones: { a: 10, b: 90 } }),
      etat({ tombstones: { a: 20, c: 30 } })
    );
    egal(f.tombstones.a, 20);
    egal(f.tombstones.b, 90);
    egal(f.tombstones.c, 30);
  });

  await test("punch en cours : arbitré par activePunchAt", () => {
    const distant = tc.mergeStates(
      etat({ activePunch: null, activePunchAt: 10 }),
      etat({ activePunch: { start: 999 }, activePunchAt: 20 })
    );
    egal(distant.activePunch.start, 999, "le plus récent gagne");
    const local = tc.mergeStates(
      etat({ activePunch: null, activePunchAt: 30 }),
      etat({ activePunch: { start: 999 }, activePunchAt: 20 })
    );
    egal(local.activePunch, null, "l'annulation locale plus récente gagne");
  });

  await test("des enregistrements hérités (updatedAt = 0) survivent à l'union", () => {
    const f = tc.mergeStates(
      etat({ punches: [{ id: "vieux", start: 100, end: 200, updatedAt: 0 }] }),
      etat({ punches: [{ id: "neuf", start: 300, end: 400, updatedAt: 999 }] })
    );
    egal(f.punches.length, 2);
  });

  await test("sameState : insensible à l'ordre des pierres tombales", () => {
    const a = etat({ tombstones: { x: 1, y: 2 } });
    const b = etat({ tombstones: { y: 2, x: 1 } });
    egal(tc.sameState(a, b), true);
    const c = etat({ interventions: [{ id: "i", start: 1, end: 2, client: "", ticket: "", category: "Autre", description: "", billable: true, toVerify: false, verifyNote: "n", updatedAt: 0 }] });
    const d = etat({ interventions: [{ id: "i", start: 1, end: 2, client: "", ticket: "", category: "Autre", description: "", billable: true, toVerify: false, verifyNote: "AUTRE", updatedAt: 0 }] });
    egal(tc.sameState(c, d), false, "une note différente compte");
  });
}

/* =====================================================================
 * F. Enregistrement local
 * =================================================================== */
async function sectionF() {
  section("F. Enregistrement");

  await test("save : écrit localStorage, horodate, répond true", async () => {
    await reinitialiser();
    const avant = tc.state.updatedAt;
    tc.state.punches.push({ id: "s1", start: 1000, end: 2000, updatedAt: 1 });
    vrai(tc.save() === true);
    vrai(tc.state.updatedAt > avant, "updatedAt avancé");
    vrai(Math.abs(Date.now() - tc.state.updatedAt) < 5000, "updatedAt ≈ maintenant");
    const relu = JSON.parse(localStorage.getItem(tc.STORAGE_KEY));
    egal(relu.punches.length, 1, "persisté");
  });

  await test("save : échec d'écriture → retour en arrière + avis", async () => {
    await reinitialiser();
    tc.save();
    const updatedAvant = tc.state.updatedAt;
    tc.setPersistLocal(() => {
      throw new Error("stockage plein (simulé)");
    });
    const ok = tc.save();
    tc.setPersistLocal(tc.persistLocal); // restaurer l'original
    egal(ok, false, "save répond false");
    egal(tc.state.updatedAt, updatedAvant, "updatedAt restauré");
    vrai(tc.activeBanners.has("save"), "avis affiché");
    contient(tc.els.banners.textContent, "Impossible d'enregistrer");
    tc.dismissBanner("save");
  });

  await test("syncUp sans compte connecté : aucune écriture", () => {
    egal(tc.userDocRef, null, "pas encore connecté");
    bouchon.viderEcritures();
    tc.syncUp();
    egal(bouchon.ecritures.length, 0);
  });
}

/* =====================================================================
 * G. Authentification
 * =================================================================== */
async function sectionG() {
  section("G. Authentification");

  await test("le fournisseur est Microsoft, avec le bon locataire Azure", () => {
    egal(bouchon.auth.providerId, "microsoft.com");
    egal(bouchon.auth.parametres.tenant, MICROSOFT_TENANT_ID);
  });

  await test("Firestore est initialisé avec le cache persistant multi-onglets", () => {
    egal(bouchon.optionsFirestore.localCache.genre, "persistentLocalCache");
    egal(bouchon.optionsFirestore.localCache.tabManager.genre, "persistentMultipleTabManager");
  });

  await test("sans connexion : barrière visible, application masquée", () => {
    egal(tc.elsAuth.gate.hidden, false);
    egal(tc.elsAuth.main.hidden, true);
    egal(tc.elsAuth.btnLogout.hidden, true);
  });

  await test("connexion : chemin du document et abonnement", async () => {
    await reinitialiser(); // localStorage propre AVANT la connexion (elle recharge)
    bouchon.connecter("uid-essai");
    await attendre(0);
    egal(tc.elsAuth.gate.hidden, true, "barrière masquée");
    egal(tc.elsAuth.main.hidden, false, "application visible");
    egal(tc.elsAuth.btnLogout.hidden, false);
    egal(bouchon.cheminDocument, "users/uid-essai/timecalculator/state", "un document par compte");
    vrai(bouchon.abonnementActif(), "onSnapshot actif");
  });

  await test("déconnexion : abonnement résilié, barrière de retour", async () => {
    const desAvant = bouchon.desabonnements;
    bouchon.deconnecter();
    await attendre(0);
    egal(tc.elsAuth.gate.hidden, false);
    egal(tc.elsAuth.main.hidden, true);
    egal(bouchon.desabonnements, desAvant + 1, "unsubscribe appelé");
    egal(bouchon.abonnementActif(), false, "plus d'instantanés reçus");
  });

  // Reconnecter pour toute la suite.
  bouchon.connecter("uid-essai");
  await attendre(0);
}

/* =====================================================================
 * H. Réception des instantanés Firestore
 * =================================================================== */
async function sectionH() {
  section("H. Synchro Firestore");

  const docDistant = (extra) => ({
    activePunch: null, activePunchAt: 0, punches: [], interventions: [],
    tombstones: {}, updatedAt: 1, ...extra,
  });

  await test("« inexistant » venu du CACHE : ne rien écrire (l'ancien bogue effaceur)", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "pr1", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(), updatedAt: 5 });
    tc.persistLocal();
    bouchon.viderEcritures();
    bouchon.emettreInstantane({ existe: false, depuisCache: true });
    await attendre(0);
    egal(bouchon.ecritures.length, 0, "aucune écriture depuis un instantané de cache");
    egal(tc.state.punches.length, 1, "état local intact");
  });

  await test("« inexistant » confirmé par le SERVEUR : on amorce avec les données locales", async () => {
    bouchon.viderEcritures();
    bouchon.emettreInstantane({ existe: false, depuisCache: false });
    await attendre(0);
    egal(bouchon.ecritures.length, 1, "une écriture d'amorçage");
    egal(bouchon.derniereEcriture().punches.length, 1);
  });

  await test("« inexistant » confirmé + état local vide : rien à amorcer", async () => {
    await reinitialiser();
    bouchon.emettreInstantane({ existe: false, depuisCache: false });
    await attendre(0);
    egal(bouchon.ecritures.length, 0, "un état vide ne part jamais");
  });

  await test("document distant seulement : fusion locale, PAS de réécriture en boucle", async () => {
    await reinitialiser();
    bouchon.emettreInstantane({
      existe: true,
      donnees: docDistant({ punches: [{ id: "r1", start: 1000, end: 61000, updatedAt: 5 }] }),
    });
    await attendre(0);
    egal(tc.state.punches.length, 1, "reçu");
    egal(tc.state.punches[0].id, "r1");
    const relu = JSON.parse(localStorage.getItem(tc.STORAGE_KEY));
    egal(relu.punches.length, 1, "persisté localement");
    egal(bouchon.ecritures.length, 0, "rien à renvoyer : le serveur a déjà tout");
  });

  await test("travail local absent du document : il est renvoyé au serveur", async () => {
    // (état courant : r1 reçu au test précédent)
    tc.state.punches.push({ id: "l1", start: 100000, end: 160000, updatedAt: 7 });
    tc.persistLocal();
    bouchon.viderEcritures();
    bouchon.emettreInstantane({
      existe: true,
      donnees: docDistant({ punches: [{ id: "r1", start: 1000, end: 61000, updatedAt: 5 }] }),
    });
    await attendre(0);
    egal(bouchon.ecritures.length, 1, "le travail hors ligne repart");
    const envoye = bouchon.derniereEcriture();
    egal(envoye.punches.length, 2, "union envoyée");
  });

  await test("instantané identique à l'état : aucun échange (pas de boucle infinie)", async () => {
    bouchon.viderEcritures();
    const miroir = JSON.parse(localStorage.getItem(tc.STORAGE_KEY));
    bouchon.emettreInstantane({ existe: true, donnees: miroir });
    await attendre(0);
    egal(bouchon.ecritures.length, 0, "rien ne repart");
  });

  await test("suppression distante par pierre tombale : appliquée localement", async () => {
    bouchon.viderEcritures();
    const miroir = JSON.parse(localStorage.getItem(tc.STORAGE_KEY));
    miroir.punches = miroir.punches.filter((p) => p.id !== "l1");
    miroir.tombstones = { ...miroir.tombstones, l1: Date.now() };
    bouchon.emettreInstantane({ existe: true, donnees: miroir });
    await attendre(0);
    egal(tc.state.punches.some((p) => p.id === "l1"), false, "l1 supprimé ici aussi");
    egal(bouchon.ecritures.length, 0, "pas de réécriture");
  });

  await test("échec d'envoi : avis « en attente », sans perte locale", async () => {
    await reinitialiser();
    bouchon.echecEcriture = "hors ligne (simulé)";
    tc.state.punches.push({ id: "off1", start: 5000, end: 65000, updatedAt: 1 });
    tc.save();
    await attendreQue(() => tc.activeBanners.has("sync"), "avis de synchro en attente");
    contient(tc.els.banners.textContent, "Synchronisation infonuagique en attente");
    egal(JSON.parse(localStorage.getItem(tc.STORAGE_KEY)).punches.length, 1, "donnée locale intacte");
    bouchon.echecEcriture = null;
    tc.dismissBanner("sync");
  });

  await test("synchro suspendue (syncBloquee) : save n'envoie rien", async () => {
    await reinitialiser();
    tc.syncBloquee = true;
    tc.state.punches.push({ id: "q1", start: 5000, end: 65000, updatedAt: 1 });
    tc.save();
    await attendre(0);
    egal(bouchon.ecritures.length, 0, "quarantaine respectée");
    tc.syncBloquee = false;
  });

  await test("pendant l'application d'un instantané : pas d'écho montant", async () => {
    await reinitialiser();
    tc.applyingRemote = true;
    tc.syncUp();
    await attendre(0);
    egal(bouchon.ecritures.length, 0);
    tc.applyingRemote = false;
  });
}

/* =====================================================================
 * I. Punch in / out
 * =================================================================== */
async function sectionI() {
  section("I. Punch");

  await test("punch in : chronomètre en marche, état persisté", async () => {
    await reinitialiser();
    tc.punchIn();
    vrai(tc.state.activePunch, "punch actif");
    vrai(tc.state.activePunchAt > 0);
    egal(tc.els.btnPunchOut.hidden, false, "bouton punch out visible");
    egal(tc.els.btnPunchIn.hidden, true);
    vrai(JSON.parse(localStorage.getItem(tc.STORAGE_KEY)).activePunch, "persisté");
    const start = tc.state.activePunch.start;
    tc.punchIn();
    egal(tc.state.activePunch.start, start, "second punch in ignoré");
  });

  await test("punch out immédiat : période d'au moins une minute", async () => {
    tc.punchOut();
    egal(tc.state.activePunch, null);
    egal(tc.state.punches.length, 1);
    const p = tc.state.punches[0];
    vrai(p.end - p.start >= 60000, "minimum 1 minute");
    egal(tc.els.btnPunchIn.hidden, false, "retour au repos");
  });

  await test("annulation du punch : aucune période créée", async () => {
    tc.punchIn();
    reponseConfirm = true;
    tc.cancelPunch();
    egal(tc.state.activePunch, null);
    egal(tc.state.punches.length, 1, "toujours la seule période du test précédent");
  });

  await test("punch oublié depuis 13 h : avis proposé", async () => {
    await reinitialiser();
    tc.state.activePunch = { start: Date.now() - 13 * 3600 * 1000 };
    tc.state.activePunchAt = Date.now();
    tc.checkPunchOublie();
    vrai(tc.activeBanners.has("punch-oublie"), "avis présent");
    contient(tc.els.banners.textContent, "punch est ouvert depuis 13 h");
  });

  await test("fermer le dialogue de correction SANS enregistrer ne perd pas le punch", async () => {
    // Régression critique : l'ancienne version fermait le punch avant le
    // dialogue — Échap faisait disparaître l'heure de début pour toujours.
    const bouton = [...tc.els.banners.querySelectorAll("button")].find(
      (b) => b.textContent === "Enregistrer avec la bonne heure de fin"
    );
    vrai(bouton, "bouton de correction présent");
    const debutAvant = tc.state.activePunch.start;
    bouton.click();
    vrai(tc.els.punchDialog.open, "dialogue ouvert");
    egal(tc.punchDialogClosesActive, true, "le dialogue doit clore le punch");
    tc.els.punchDialog.close(); // équivalent d'Échap
    await attendreQue(() => tc.punchDialogClosesActive === false, "écouteur close exécuté");
    vrai(tc.state.activePunch, "le punch en cours EXISTE ENCORE");
    egal(tc.state.activePunch.start, debutAvant, "heure de début intacte");
  });

  await test("corriger la période oubliée : enregistrée, punch clos, avis retiré", async () => {
    const bouton = [...tc.els.banners.querySelectorAll("button")].find(
      (b) => b.textContent === "Enregistrer avec la bonne heure de fin"
    );
    bouton.click();
    const debut = new Date(tc.state.activePunch.start);
    tc.els.pEnd.value = tc.timeHM(new Date(debut.getTime() + 3600 * 1000));
    tc.submitPunchForm(evenement);
    await attendre(0);
    egal(tc.state.activePunch, null, "punch clos");
    egal(tc.state.punches.length, 1, "période enregistrée");
    egal(tc.minutesBetween(tc.state.punches[0].start, tc.state.punches[0].end), 60, "durée corrigée");
    egal(tc.activeBanners.has("punch-oublie"), false, "avis retiré");
    egal(tc.els.punchDialog.open, false, "dialogue fermé");
  });
}

/* =====================================================================
 * J. Feuille de temps : formulaire
 * =================================================================== */
async function sectionJ() {
  section("J. Formulaire de période");

  await test("ajout manuel valide", async () => {
    await reinitialiser();
    tc.openPunchDialog({ title: "t", date: "2026-07-15", start: "09:00", end: "10:30" });
    tc.submitPunchForm(evenement);
    await attendre(0);
    egal(tc.state.punches.length, 1);
    egal(tc.minutesBetween(tc.state.punches[0].start, tc.state.punches[0].end), 90);
    egal(tc.els.punchDialog.open, false);
  });

  await test("durée nulle refusée avec message", async () => {
    tc.openPunchDialog({ title: "t", date: "2026-07-15", start: "09:00", end: "09:00" });
    tc.submitPunchForm(evenement);
    egal(tc.state.punches.length, 1, "rien d'ajouté");
    egal(tc.els.pError.hidden, false, "erreur affichée");
    contient(tc.els.pError.textContent, "durée doit être supérieure à zéro");
    await fermerDialogues();
  });

  await test("chevauchement : refusé si on répond non, accepté si oui", async () => {
    tc.openPunchDialog({ title: "t", date: "2026-07-15", start: "09:30", end: "10:00" });
    reponseConfirm = false;
    tc.submitPunchForm(evenement);
    egal(tc.state.punches.length, 1, "refusé");
    vrai(tc.els.punchDialog.open, "le dialogue reste ouvert");
    reponseConfirm = true;
    tc.submitPunchForm(evenement);
    await attendre(0);
    egal(tc.state.punches.length, 2, "accepté en connaissance de cause");
    await fermerDialogues();
  });

  await test("modifier sans toucher aux heures conserve les timestamps exacts", async () => {
    await reinitialiser();
    const start = new Date(2026, 10, 1, 1, 30).getTime(); // 1er nov, heure ambiguë
    tc.state.punches.push({ id: "amb", start, end: start + 900000, updatedAt: 1 });
    tc.persistLocal();
    tc.render();
    tc.editPunch("amb");
    vrai(tc.els.punchDialog.open);
    tc.submitPunchForm(evenement);
    await attendre(0);
    egal(tc.state.punches[0].start, start, "start au millième près");
    egal(tc.state.punches[0].end, start + 900000, "end au millième près");
    vrai(tc.state.punches[0].updatedAt > 1, "modification horodatée");
  });

  await test("suppression : refus conserve tout, accord pose une pierre tombale", async () => {
    reponseConfirm = false;
    tc.deletePunch("amb");
    egal(tc.state.punches.length, 1, "refus → conservé");
    egal("amb" in tc.state.tombstones, false);
    reponseConfirm = true;
    tc.deletePunch("amb");
    egal(tc.state.punches.length, 0, "supprimé");
    vrai(tc.state.tombstones.amb > 0, "pierre tombale posée");
  });
}

/* =====================================================================
 * K. Interventions
 * =================================================================== */
async function sectionK() {
  section("K. Interventions");

  async function inscrire(champs) {
    tc.openInterventionDialog({ title: "t", date: "2026-07-15", start: "09:00", end: "10:00", ...champs });
    if (champs && champs.apres) champs.apres();
    tc.submitInterventionForm(evenement);
    await attendre(0);
  }

  await test("inscription : champs taillés, note vidée si « à vérifier » décoché", async () => {
    await reinitialiser();
    tc.openInterventionDialog({ title: "t", date: "2026-07-15", start: "09:00", end: "10:00" });
    tc.els.fClient.value = "  ClientX  ";
    tc.els.fTicket.value = " T-1 ";
    tc.els.fCategory.value = "Maintenance";
    tc.els.fDescription.value = "  Nettoyage  ";
    tc.els.fBillable.checked = true;
    tc.els.fToVerify.checked = false;
    tc.els.fVerifyNote.value = "cette note doit disparaître";
    tc.submitInterventionForm(evenement);
    await attendre(0);
    egal(tc.state.interventions.length, 1);
    const i = tc.state.interventions[0];
    egal(i.client, "ClientX", "client taillé");
    egal(i.ticket, "T-1");
    egal(i.category, "Maintenance");
    egal(i.description, "Nettoyage");
    egal(i.verifyNote, "", "note ignorée quand la case est décochée");
  });

  await test("ni client ni description : refusé", async () => {
    tc.openInterventionDialog({ title: "t", date: "2026-07-15", start: "10:00", end: "11:00" });
    tc.els.fClient.value = "   ";
    tc.els.fDescription.value = "";
    tc.submitInterventionForm(evenement);
    egal(tc.state.interventions.length, 1, "rien d'ajouté");
    egal(tc.els.fError.hidden, false);
    contient(tc.els.fError.textContent, "au moins un client ou une explication");
    await fermerDialogues();
  });

  await test("« à vérifier » avec note : conservées", async () => {
    tc.openInterventionDialog({ title: "t", date: "2026-07-15", start: "10:00", end: "11:00" });
    tc.els.fClient.value = "ClientY";
    tc.els.fToVerify.checked = true;
    tc.els.fVerifyNote.value = "  confirmer les heures  ";
    tc.submitInterventionForm(evenement);
    await attendre(0);
    const i = tc.state.interventions[1];
    egal(i.toVerify, true);
    egal(i.verifyNote, "confirmer les heures");
  });

  await test("bascule « à vérifier » : décocher efface la note", async () => {
    const id = tc.state.interventions[1].id;
    tc.toggleInterventionVerify(id);
    egal(tc.state.interventions[1].toVerify, false);
    egal(tc.state.interventions[1].verifyNote, "", "note effacée avec la case");
    tc.toggleInterventionVerify(id);
    egal(tc.state.interventions[1].toVerify, true, "re-cochable");
  });

  await test("note de vérification modifiée en ligne : taillée et horodatée", async () => {
    const id = tc.state.interventions[1].id;
    const avant = tc.state.interventions[1].updatedAt;
    await attendre(2); // Date.now() doit avancer
    tc.updateInterventionVerifyNote(id, "  nouvelle note  ");
    egal(tc.state.interventions[1].verifyNote, "nouvelle note");
    vrai(tc.state.interventions[1].updatedAt >= avant, "horodatée");
  });

  await test("suppression avec pierre tombale", async () => {
    const id = tc.state.interventions[1].id;
    reponseConfirm = true;
    tc.deleteIntervention(id);
    egal(tc.state.interventions.length, 1);
    vrai(tc.state.tombstones[id] > 0);
  });

  await test("nouvelle intervention : reprend client, billet et heure de la dernière du jour", async () => {
    await reinitialiser();
    const now = new Date();
    const finDerniere = ceJour(0, 0, 20); // 00 h 20 aujourd'hui : presque toujours passé
    tc.state.interventions.push({
      id: "prec", start: ceJour(0, 0, 5).getTime(), end: finDerniere.getTime(),
      client: "Clinique ABC", ticket: "T-77", category: "Installation",
      description: "x", billable: true, toVerify: false, verifyNote: "", updatedAt: 1,
    });
    tc.persistLocal();
    tc.nouvelleIntervention();
    vrai(tc.els.interventionDialog.open);
    egal(tc.els.fClient.value, "Clinique ABC", "client repris");
    egal(tc.els.fTicket.value, "T-77", "billet repris");
    egal(tc.els.fCategory.value, "Installation", "catégorie reprise");
    const attenduDebut =
      finDerniere.getTime() <= now.getTime()
        ? tc.timeHM(finDerniere)
        : tc.timeHM(new Date(now.getTime() - 3600 * 1000));
    egal(tc.els.fStart.value, attenduDebut, "début collé sur la fin précédente");
    await fermerDialogues();
  });

  await test("ventiler un punch : mêmes date et heures, rien à retaper", async () => {
    tc.state.punches.push({ id: "pv", start: ceJour(0, 8, 0).getTime(), end: ceJour(0, 9, 15).getTime(), updatedAt: 1 });
    tc.ventilerPunch("pv");
    vrai(tc.els.interventionDialog.open);
    egal(tc.els.fDate.value, tc.dateISO(new Date()));
    egal(tc.els.fStart.value, "08:00");
    egal(tc.els.fEnd.value, "09:15");
    await fermerDialogues();
  });
}

/* =====================================================================
 * L. Filtres et périodes
 * =================================================================== */
async function sectionL() {
  section("L. Filtres");

  await test("inRange : bornes [début, fin[", () => {
    egal(tc.inRange({ start: 100 }, 100, 200), true, "borne basse incluse");
    egal(tc.inRange({ start: 199 }, 100, 200), true);
    egal(tc.inRange({ start: 200 }, 100, 200), false, "borne haute exclue");
  });

  await test("période « aujourd'hui » : du minuit local au minuit suivant", () => {
    tc.els.filterPeriod.value = "today";
    const [de, a] = tc.filterRange();
    const now = new Date();
    egal(de, tc.startOfDay(now).getTime());
    egal(a, tc.addDays(tc.startOfDay(now), 1).getTime());
  });

  await test("période « 2 dernières semaines » : lundi précédent → lundi prochain", () => {
    tc.els.filterPeriod.value = "2weeks";
    const [de, a] = tc.filterRange();
    const lundi = tc.startOfWeek(new Date());
    egal(de, tc.addDays(lundi, -7).getTime());
    egal(a, tc.addDays(lundi, 7).getTime());
  });

  await test("période personnalisée : bornes inversées remises à l'endroit, « au » inclusif", () => {
    tc.els.filterPeriod.value = "custom";
    tc.els.filterFrom.value = "2026-07-31";
    tc.els.filterTo.value = "2026-07-01";
    const [de, a] = tc.filterRange();
    egal(de, new Date(2026, 6, 1).getTime(), "borne basse remise à l'endroit");
    egal(a, new Date(2026, 7, 1).getTime(), "le 31 juillet est inclus en entier");
    egal(tc.rangeLabel(), "2026-07-01 au 2026-07-31");
    egal(tc.rangeSlug(), "2026-07-01_2026-07-31");
  });

  await test("filtres client et « à vérifier » combinés", async () => {
    await reinitialiser();
    const base = { start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(), category: "Autre", description: "d", billable: true, verifyNote: "", updatedAt: 1, ticket: "" };
    tc.state.interventions.push(
      { ...base, id: "ia", client: "A", toVerify: false },
      { ...base, id: "ib", client: "B", toVerify: true },
      { ...base, id: "ic", client: "A", toVerify: true }
    );
    tc.render();
    tc.els.filterClient.value = "A";
    egal(tc.filteredInterventions().length, 2, "client A");
    tc.els.filterToVerify.checked = true;
    const restants = tc.filteredInterventions();
    egal(restants.length, 1, "client A et à vérifier");
    egal(restants[0].id, "ic");
    tc.els.filterClient.value = "";
    tc.els.filterToVerify.checked = false;
  });

  await test("un ajout hors période bascule le filtre sur « Tout », avec avis", () => {
    tc.els.filterPeriod.value = "today";
    tc.ensureVisible(ceJour(-40, 9, 0).getTime());
    egal(tc.els.filterPeriod.value, "all", "filtre élargi");
    vrai(document.querySelector(".toast"), "toast affiché");
  });

  await test("uniqueValues : tri français, doublons éliminés, vides ignorés", async () => {
    await reinitialiser();
    const base = { start: 1000, end: 61000, category: "Autre", description: "d", billable: true, toVerify: false, verifyNote: "", updatedAt: 1, ticket: "" };
    tc.state.interventions.push(
      { ...base, id: "u1", client: "Éric" },
      { ...base, id: "u2", client: "abc" },
      { ...base, id: "u3", client: "Éric" },
      { ...base, id: "u4", client: "" }
    );
    const valeurs = tc.uniqueValues((i) => i.client);
    egal(valeurs.length, 2);
    egal(valeurs[0], "abc", "tri insensible aux accents");
    egal(valeurs[1], "Éric");
  });
}

/* =====================================================================
 * M. Rendu
 * =================================================================== */
async function sectionM() {
  section("M. Rendu");

  async function semer() {
    await reinitialiser();
    tc.state.punches.push(
      { id: "mp1", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(), updatedAt: 1 },
      { id: "mp2", start: ceJour(-1, 22, 0).getTime(), end: ceJour(-1, 23, 0).getTime(), updatedAt: 1 }
    );
    tc.state.interventions.push({
      id: "mi1", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 9, 30).getTime(),
      client: "Client <b>X</b>", ticket: "T-1", category: "Dépannage",
      description: "desc", billable: true, toVerify: true, verifyNote: "vérifier tarif", updatedAt: 1,
    });
    tc.persistLocal();
    tc.render();
  }

  await test("sommaire du haut : « Aujourd'hui » reflète les punchs du jour", async () => {
    await semer();
    egal(tc.els.statToday.textContent, "1 h 00");
  });

  await test("feuille de temps : aujourd'hui déplié, hier replié", async () => {
    await semer();
    const lignesJour = tc.els.punchTbody.querySelectorAll("tr.day-row");
    egal(lignesJour.length, 2, "deux journées");
    // 2 lignes de jour + 1 seule ligne de détail (celle d'aujourd'hui)
    egal(tc.els.punchTbody.querySelectorAll("tr").length, 3);
    tc.toggleDay(tc.dateISO(ceJour(-1, 12, 0)));
    egal(tc.els.punchTbody.querySelectorAll("tr").length, 4, "hier déplié au clic");
  });

  await test("temps ventilé affiché, sans aucun écart", async () => {
    // La feuille de temps dit ce qui a été punché et ce qui a été ventilé.
    // L'écart entre les deux n'y figure plus : demandé, et retiré partout.
    await semer();
    contient(tc.els.punchTbody.textContent, "Ventilé : 30 min");
    absent(tc.els.punchTbody.textContent, "écart", "aucun écart dans les lignes de jour");
    absent(tc.els.punchTotal.textContent, "écart", "aucun écart dans le total");
    egal(tc.els.punchTbody.querySelector(".gap-warn"), null, "plus de mise en alerte");
    contient(tc.els.punchTbody.textContent, "Aucun billet inscrit", "journée sans intervention signalée");
    contient(tc.els.punchTotal.textContent, "2 périodes");
  });

  await test("période à cheval sur minuit : badge « +1 »", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "nuit", start: ceJour(-1, 23, 0).getTime(), end: ceJour(0, 1, 0).getTime(), updatedAt: 1 });
    tc.render();
    tc.toggleDay(tc.dateISO(ceJour(-1, 12, 0)));
    vrai(tc.els.punchTbody.querySelector("span.next-day"), "badge +1 affiché");
  });

  await test("un nom de client hostile est affiché en texte, jamais interprété", async () => {
    await semer();
    contient(tc.els.interventionTbody.innerHTML, "Client &lt;b&gt;X&lt;/b&gt;", "échappé");
    egal(tc.els.interventionTbody.querySelector("b"), null, "aucune balise injectée");
  });

  await test("intervention à vérifier : ligne marquée + note éditable dessous", async () => {
    await semer();
    vrai(tc.els.interventionTbody.querySelector("tr.to-verify-row"), "ligne marquée");
    const note = tc.els.interventionTbody.querySelector("textarea[data-verify-note-input]");
    vrai(note, "champ de note présent");
    egal(note.value, "vérifier tarif");
  });

  await test("sommaire de facturation : regroupé, total, détail au clic, lecture seule", async () => {
    await semer();
    tc.els.groupBy.value = "ticket";
    tc.renderSummaryTable();
    const lignes = tc.els.summaryTbody.querySelectorAll("tr.summary-row");
    egal(lignes.length, 1, "un billet");
    contient(lignes[0].textContent, "T-1");
    contient(lignes[0].textContent, "30 min");
    vrai(tc.els.summaryTbody.querySelector("tr.total-row"), "ligne TOTAL");
    egal(tc.els.summaryTbody.querySelectorAll("tr.summary-detail").length, 0, "détail replié");
    tc.toggleSummaryGroup("T-1");
    const details = tc.els.summaryTbody.querySelectorAll("tr.summary-detail");
    egal(details.length, 1, "détail déplié");
    contient(details[0].textContent, "09:00–09:30", "les vraies heures, pas un intervalle inventé");
    egal(tc.state.interventions.length, 1, "AUCUNE intervention créée ou fusionnée");
  });

  await test("sans billet : regroupé sous « (sans billet) »", async () => {
    await semer();
    tc.state.interventions.push({
      id: "mi2", start: ceJour(0, 10, 0).getTime(), end: ceJour(0, 10, 30).getTime(),
      client: "C", ticket: "", category: "Autre", description: "d",
      billable: false, toVerify: false, verifyNote: "", updatedAt: 1,
    });
    tc.els.groupBy.value = "ticket";
    tc.renderSummaryTable();
    contient(tc.els.summaryTbody.textContent, "(sans billet)");
  });

  await test("le non-facturable ne devient jamais facturable par regroupement", async () => {
    const groupes = tc.groupedInterventions();
    const sans = groupes.find((g) => g.cle === "(sans billet)");
    egal(sans.minutes, 30);
    egal(sans.billable, 0, "0 minute facturable");
  });

  await test("impression : tout se déplie, puis revient comme avant", async () => {
    await semer();
    egal(tc.els.punchTbody.querySelectorAll("tr").length, 3, "hier replié");
    tc.printing = true;
    tc.renderPunchTable();
    egal(tc.els.punchTbody.querySelectorAll("tr").length, 4, "tout déplié à l'impression");
    tc.printing = false;
    tc.renderPunchTable();
    egal(tc.els.punchTbody.querySelectorAll("tr").length, 3, "état d'écran restauré");
  });
}

/* =====================================================================
 * N. Exports CSV
 * =================================================================== */
async function sectionN() {
  section("N. Exports CSV");

  async function semerCsv() {
    await reinitialiser();
    tc.intercepterTelechargements();
    tc.state.punches.push(
      { id: "c1", start: ceJour(-1, 14, 0).getTime(), end: ceJour(-1, 15, 0).getTime(), updatedAt: 1 },
      { id: "c2", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(), updatedAt: 1 },
      { id: "c3", start: ceJour(0, 10, 30).getTime(), end: ceJour(0, 11, 0).getTime(), updatedAt: 1 }
    );
    tc.state.interventions.push(
      {
        id: "ci1", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(),
        client: "Cli;ent", ticket: "T-1", category: "Maintenance",
        description: "Réparation; écran", billable: true, toVerify: true,
        verifyNote: 'Note "spéciale"', updatedAt: 1,
      },
      {
        id: "ci2", start: ceJour(0, 10, 30).getTime(), end: ceJour(0, 11, 0).getTime(),
        client: "Cli;ent", ticket: "T-1", category: "Maintenance",
        description: "suite", billable: false, toVerify: false, verifyNote: "", updatedAt: 1,
      }
    );
    tc.render();
  }

  await test("csvField : point-virgule, guillemets, retour de ligne", () => {
    egal(tc.csvField("simple"), "simple");
    egal(tc.csvField("a;b"), '"a;b"');
    egal(tc.csvField('dit "oui"'), '"dit ""oui"""');
    egal(tc.csvField("l1\nl2"), '"l1\nl2"');
    egal(tc.csvField(null), "");
  });

  await test("csvTotalRow : libellé et chiffres dans les bonnes colonnes", () => {
    egal(tc.csvTotalRow(6, "TOTAL", 90), ";;;TOTAL;90;1,50");
    egal(tc.csvTotalRow(13, "TOTAL", 90).split(";").length, 13, "13 colonnes exactement");
  });

  await test("feuille de temps : BOM Excel, sous-totaux par jour, TOTAL", async () => {
    await semerCsv();
    tc.exportPunchesCsv();
    const f = tc.dernierFichier();
    egal(f.name, "feuille-de-temps-tout.csv");
    egal(f.content.charCodeAt(0), 0xfeff, "BOM UTF-8 pour Excel");
    const lignes = f.content.slice(1).split("\r\n");
    contient(lignes[0], "Feuille de temps — période : toutes les données");
    contient(lignes[1], "Généré le ");
    egal(lignes[3], "Date;Date de fin;Début;Fin;Durée (min);Durée (h)");
    contient(f.content, `;;;Sous-total ${tc.dateISO(ceJour(-1, 12, 0))};60;1,00`);
    contient(f.content, `;;;Sous-total ${tc.dateISO(new Date())};90;1,50`);
    contient(f.content, ";;;TOTAL;150;2,50");
  });

  await test("interventions : 13 colonnes, champs à risque cités, note seulement si à vérifier", async () => {
    await semerCsv();
    tc.exportInterventionsCsv();
    const f = tc.dernierFichier();
    egal(f.name, "interventions-tout.csv");
    contient(f.content, '"Cli;ent"', "client avec point-virgule cité");
    contient(f.content, '"Réparation; écran"');
    contient(f.content, '"Note ""spéciale"""', "guillemets doublés");
    const totale = f.content.slice(1).split("\r\n").find((l) => l.startsWith(";;;TOTAL"));
    vrai(totale, "ligne TOTAL");
    egal(totale.split(";").length, 13, "TOTAL aligné sur les 13 colonnes");
    contient(f.content, ";;;TOTAL;90;1,50");
    contient(f.content, ";;;DONT FACTURABLE;60;1,00");
  });

  await test("sommaire par billet : lignes de groupe et TOTAL", async () => {
    await semerCsv();
    tc.els.groupBy.value = "ticket";
    tc.renderSummaryTable();
    tc.exportSummaryCsv();
    const f = tc.dernierFichier();
    egal(f.name, "sommaire-ticket-tout.csv");
    contient(f.content, "Billet;Interventions;Durée (min);Durée (h);Facturable (min);Facturable (h);À vérifier");
    contient(f.content, "T-1;2;90;1,50;60;1,00;1");
    contient(f.content, "TOTAL;2;90;1,50;60;1,00;1");
  });

  await test("aucune donnée : avis, aucun fichier", async () => {
    await reinitialiser();
    tc.intercepterTelechargements();
    alertes.length = 0;
    tc.exportPunchesCsv();
    egal(tc.fichiers.length, 0, "pas de fichier vide");
    egal(alertes.length, 1);
    contient(alertes[0], "Aucune période à exporter");
  });
}

/* =====================================================================
 * O. Rapport hebdomadaire
 * =================================================================== */
async function sectionO() {
  section("O. Rapport");

  await test("le rapport contient les semaines, le sommaire par billet et échappe tout", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "rp", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 11, 0).getTime(), updatedAt: 1 });
    tc.state.interventions.push({
      id: "ri", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(),
      client: "Client <script>", ticket: "T-9", category: "Dépannage",
      description: "d", billable: true, toVerify: true, verifyNote: "note & rappel", updatedAt: 1,
    });
    tc.render();
    let html = null;
    const openOriginal = window.open;
    window.open = () => ({ document: { open() {}, write(h) { html = h; }, close() {} } });
    tc.generateWeeklyReport();
    window.open = openOriginal;
    vrai(html, "rapport produit");
    contient(html, "Rapport d'activité — TimeCalculator");
    contient(html, tc.isoWeekLabel(tc.startOfWeek(new Date())), "semaine identifiée");
    contient(html, "Sommaire de facturation par billet");
    contient(html, "T-9");
    contient(html, "Client &lt;script&gt;", "client hostile échappé");
    absent(html, "<script>Client", "aucune balise injectée");
    contient(html, "note &amp; rappel", "note de vérification incluse et échappée");
    contient(html, "ventilé en interventions : 1 h 00", "temps ventilé de la semaine");
    absent(html, "écart", "aucun écart dans le rapport non plus");
  });

  await test("fenêtre bloquée : explication claire, pas d'erreur", async () => {
    alertes.length = 0;
    const openOriginal = window.open;
    window.open = () => null;
    tc.generateWeeklyReport();
    window.open = openOriginal;
    egal(alertes.length, 1);
    contient(alertes[0], "pop-up");
  });

  await test("aucune donnée dans la période : avis plutôt que rapport vide", async () => {
    await reinitialiser();
    alertes.length = 0;
    tc.generateWeeklyReport();
    egal(alertes.length, 1);
    contient(alertes[0], "Aucune donnée");
  });

  // Le Rapport Simple ne vaut que par ce qu'il NE contient pas : si une durée,
  // un total ou une intervention se glisse dedans un jour, ces tests le disent.
  await test("le Rapport Simple ne montre que le jour et les deux heures", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "rs", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 11, 30).getTime(), updatedAt: 1 });
    tc.state.interventions.push({
      id: "rsi", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(),
      client: "Client <script>", ticket: "T-9", category: "Dépannage",
      description: "d", billable: true, toVerify: true, verifyNote: "n", updatedAt: 1,
    });
    tc.render();
    let html = null;
    const openOriginal = window.open;
    window.open = () => ({ document: { open() {}, write(h) { html = h; }, close() {} } });
    tc.generateSimpleReport();
    window.open = openOriginal;
    vrai(html, "rapport produit");
    contient(html, "Feuille de temps");
    contient(html, "09:00", "heure de départ");
    contient(html, "11:30", "heure de fin");
    contient(html, "Total des heures travaillées");
    contient(html, "2 h 30 (2,50 h)", "total, seul chiffre du rapport");
    absent(html, "Client", "aucune intervention, donc aucun client");
    absent(html, "T-9", "aucun billet");
    absent(html, "Sommaire", "aucun sommaire de facturation");
    absent(html, "Dépannage", "aucune catégorie");
  });

  await test("le Rapport Simple ne fusionne pas les punchs d'une même journée", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "rs1", start: ceJour(0, 8, 0).getTime(), end: ceJour(0, 12, 0).getTime(), updatedAt: 1 });
    tc.state.punches.push({ id: "rs2", start: ceJour(0, 13, 0).getTime(), end: ceJour(0, 17, 0).getTime(), updatedAt: 1 });
    tc.render();
    let html = null;
    const openOriginal = window.open;
    window.open = () => ({ document: { open() {}, write(h) { html = h; }, close() {} } });
    tc.generateSimpleReport();
    window.open = openOriginal;
    contient(html, "08:00", "début du matin");
    contient(html, "12:00", "fin du matin — la pause reste visible");
    contient(html, "13:00", "retour de pause");
    contient(html, "17:00", "fin de la journée");
    egal((html.match(/<tr/g) || []).length, 4, "en-tête, deux lignes non fusionnées, total");
    contient(html, "8 h 00 (8,00 h)", "total des deux périodes, la pause exclue");
  });

  // L'arrondi porte sur le total et sur lui seul : c'est ce qui se facture.
  await test("le total du Rapport Simple est arrondi au quart d'heure", async () => {
    await reinitialiser();
    // 9 h 00 à 11 h 08 = 2 h 08 : 8 min dépassent le quart d'heure, donc 2 h 15.
    tc.state.punches.push({ id: "ar", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 11, 8).getTime(), updatedAt: 1 });
    tc.render();
    let html = null;
    const openOriginal = window.open;
    window.open = () => ({ document: { open() {}, write(h) { html = h; }, close() {} } });
    tc.generateSimpleReport();
    window.open = openOriginal;
    contient(html, "2 h 15 (2,25 h)", "arrondi vers le haut");
    contient(html, "11:08", "l'heure réelle reste affichée telle quelle");
    absent(html, "arrondi au quart", "aucune mention de l'arrondi dans le rapport");
  });

  await test("l'arrondi additionne d'abord, arrondit ensuite", async () => {
    await reinitialiser();
    // Deux périodes de 1 h 07 : arrondies séparément ça ferait 2 h 00,
    // additionnées d'abord ça fait 2 h 14, donc 2 h 15.
    tc.state.punches.push({ id: "a1", start: ceJour(0, 8, 0).getTime(), end: ceJour(0, 9, 7).getTime(), updatedAt: 1 });
    tc.state.punches.push({ id: "a2", start: ceJour(0, 10, 0).getTime(), end: ceJour(0, 11, 7).getTime(), updatedAt: 1 });
    tc.render();
    let html = null;
    const openOriginal = window.open;
    window.open = () => ({ document: { open() {}, write(h) { html = h; }, close() {} } });
    tc.generateSimpleReport();
    window.open = openOriginal;
    contient(html, "2 h 15 (2,25 h)", "un seul arrondi, sur la somme");
    absent(html, "2 h 00 (2,00 h)", "pas d'arrondi ligne par ligne");
  });

  await test("règle d'arrondi : au plus près, l'égalité vers le haut", async () => {
    egal(tc.roundToQuarterHour(0), 0);
    egal(tc.roundToQuarterHour(7), 0, "sous la moitié : vers le bas");
    egal(tc.roundToQuarterHour(8), 15, "au-dessus de la moitié : vers le haut");
    egal(tc.roundToQuarterHour(15), 15, "déjà un quart d'heure : inchangé");
    egal(tc.roundToQuarterHour(480), 480, "8 h pile : inchangé");
    egal(tc.roundToQuarterHour(487), 480);
    egal(tc.roundToQuarterHour(488), 495);
    // L'égalité stricte est hors d'atteinte avec des minutes entières, mais la
    // règle doit être la bonne le jour où une durée arrive au demi-quart près.
    egal(tc.roundToQuarterHour(7.5), 15, "égalité tranchée vers le haut");
    egal(tc.roundToQuarterHour(22.5), 30, "égalité tranchée vers le haut");
  });

  await test("Rapport Simple sans période travaillée : avis plutôt que page vide", async () => {
    await reinitialiser();
    alertes.length = 0;
    tc.generateSimpleReport();
    egal(alertes.length, 1);
    contient(alertes[0], "Aucune période travaillée");
  });

  await test("Rapport Simple, fenêtre bloquée : explication claire", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "rs3", start: ceJour(0, 9, 0).getTime(), end: ceJour(0, 10, 0).getTime(), updatedAt: 1 });
    tc.render();
    alertes.length = 0;
    const openOriginal = window.open;
    window.open = () => null;
    tc.generateSimpleReport();
    window.open = openOriginal;
    egal(alertes.length, 1);
    contient(alertes[0], "pop-up");
  });
}

/* =====================================================================
 * P. Sauvegarde et import JSON
 * =================================================================== */
async function sectionP() {
  section("P. Import/export JSON");

  await test("la sauvegarde JSON contient l'état complet", async () => {
    await reinitialiser();
    tc.intercepterTelechargements();
    tc.state.punches.push({ id: "sj", start: 1000, end: 61000, updatedAt: 3 });
    tc.persistLocal();
    tc.exportJson();
    const f = tc.dernierFichier();
    egal(f.name, `timecalculator-sauvegarde-${tc.dateISO(new Date())}.json`);
    const relu = JSON.parse(f.content);
    egal(relu.punches.length, 1);
    egal(relu.punches[0].id, "sj");
  });

  await test("import : remplace, horodate tout, pose des pierres tombales, garde une copie", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "ancien", start: 1000, end: 61000, updatedAt: 3 });
    tc.persistLocal();
    const avantImport = Date.now();
    const fichier = new File(
      [JSON.stringify({ punches: [{ id: "importe", start: 5000, end: 65000 }], interventions: [] })],
      "sauvegarde.json",
      { type: "application/json" }
    );
    reponseConfirm = true;
    tc.importJson(fichier);
    await attendreQue(() => tc.activeBanners.has("import"), "import terminé");
    egal(tc.state.punches.length, 1);
    egal(tc.state.punches[0].id, "importe", "remplacé");
    vrai(tc.state.tombstones.ancien >= avantImport, "l'ancien ne ressuscitera pas ailleurs");
    vrai(tc.state.punches[0].updatedAt >= avantImport, "horodaté au présent pour gagner la fusion");
    const copie = JSON.parse(localStorage.getItem(tc.IMPORT_BACKUP_KEY));
    egal(copie.punches[0].id, "ancien", "état précédent conservé");
    tc.dismissBanner("import");
  });

  await test("fichier illisible : avis, état intact", async () => {
    const punchsAvant = tc.state.punches.length;
    alertes.length = 0;
    tc.importJson(new File(["pas du json"], "x.json"));
    await attendreQue(() => alertes.length > 0, "avis affiché");
    contient(alertes[0], "Fichier de sauvegarde invalide");
    egal(tc.state.punches.length, punchsAvant, "rien n'a bougé");
  });

  await test("JSON valide mais sans données de l'application : refusé", async () => {
    alertes.length = 0;
    tc.importJson(new File(['{"autre": true}'], "x.json"));
    await attendreQue(() => alertes.length > 0, "avis affiché");
    contient(alertes[0], "ni périodes ni interventions");
  });

  await test("refus au moment de confirmer : rien ne change", async () => {
    const etatAvant = JSON.stringify(tc.state);
    reponseConfirm = false;
    tc.importJson(new File([JSON.stringify({ punches: [{ id: "z", start: 1, end: 2 }], interventions: [] })], "x.json"));
    await attendre(150);
    egal(JSON.stringify(tc.state), etatAvant, "état intact");
    reponseConfirm = true;
  });
}

/* =====================================================================
 * Q. Deux onglets du même navigateur
 * =================================================================== */
async function sectionQ() {
  section("Q. Multi-onglets");

  await test("l'écriture d'un autre onglet est fusionnée, pas écrasée", async () => {
    await reinitialiser();
    tc.state.punches.push({ id: "ici", start: 1000, end: 61000, updatedAt: 5 });
    tc.persistLocal();
    const autreOnglet = JSON.stringify({
      activePunch: null, activePunchAt: 0,
      punches: [
        { id: "ici", start: 1000, end: 61000, updatedAt: 5 },
        { id: "lautre", start: 100000, end: 160000, updatedAt: 6 },
      ],
      interventions: [], tombstones: {}, updatedAt: Date.now(),
    });
    window.dispatchEvent(new StorageEvent("storage", { key: tc.STORAGE_KEY, newValue: autreOnglet }));
    egal(tc.state.punches.length, 2, "les deux périodes coexistent");
    vrai(document.querySelector(".toast"), "avis discret affiché");
  });

  await test("notre propre écho est ignoré", async () => {
    const avant = JSON.stringify(tc.state);
    window.dispatchEvent(new StorageEvent("storage", { key: tc.STORAGE_KEY, newValue: tc.lastWritten }));
    egal(JSON.stringify(tc.state), avant);
  });

  await test("une écriture illisible d'un autre onglet ne casse rien", async () => {
    const avant = JSON.stringify(tc.state);
    window.dispatchEvent(new StorageEvent("storage", { key: tc.STORAGE_KEY, newValue: "{{{" }));
    egal(JSON.stringify(tc.state), avant, "état conservé");
  });
}

/* =====================================================================
 * R. Raccourcis clavier
 * =================================================================== */
async function sectionR() {
  section("R. Raccourcis");

  const touche = (cible, key) =>
    cible.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  await test("« P » : punch in puis punch out", async () => {
    await reinitialiser();
    touche(document.body, "p");
    vrai(tc.state.activePunch, "punch in au clavier");
    touche(document.body, "p");
    egal(tc.state.activePunch, null, "punch out au clavier");
    egal(tc.state.punches.length, 1);
  });

  await test("« I » : ouvre l'inscription d'intervention", async () => {
    touche(document.body, "i");
    vrai(tc.els.interventionDialog.open, "dialogue ouvert");
    await fermerDialogues();
  });

  await test("« D » démarre un chrono à chaque fois, « T » termine le dernier", async () => {
    await reinitialiser();
    touche(document.body, "d");
    await attendre(2);
    touche(document.body, "d");
    egal(tc.state.activeInterventions.length, 2, "deux chronos démarrés au clavier");
    const dernier = tc.state.activeInterventions[1];
    touche(document.body, "t");
    vrai(tc.els.interventionDialog.open, "formulaire de fin ouvert");
    egal(tc.interventionDialogClosesChrono, dernier.id, "c'est le dernier démarré qui est visé");
    await fermerDialogues();
    egal(tc.state.activeInterventions.length, 2, "rien d'arrêté sans enregistrement");
    reponseConfirm = true;
    for (const c of [...tc.state.activeInterventions]) tc.cancelIntervention(c.id);
  });

  await test("dans un champ de saisie : les lettres restent des lettres", async () => {
    const punchsAvant = tc.state.punches.length;
    touche(tc.els.filterFrom, "p");
    egal(tc.state.activePunch, null, "aucun punch déclenché");
    egal(tc.state.punches.length, punchsAvant);
  });

  await test("dialogue ouvert : les raccourcis se taisent", async () => {
    tc.openPunchDialog({ title: "t", date: "2026-07-15", start: "09:00", end: "10:00" });
    touche(document.body, "p");
    egal(tc.state.activePunch, null, "pas de punch pendant un dialogue");
    await fermerDialogues();
  });
}

/* =====================================================================
 * S. Interventions chronométrées (plusieurs à la fois)
 * =================================================================== */
async function sectionS() {
  section("S. Interventions chronométrées");

  const chronos = () => tc.state.activeInterventions;
  const lignes = () => tc.els.interventionList.querySelectorAll("li.live-row");

  await test("démarrage : un chrono par clic, ils s'additionnent", async () => {
    await reinitialiser();
    tc.startIntervention();
    egal(chronos().length, 1, "premier chrono");
    egal(tc.els.interventionLabel.textContent, "1 intervention en cours");
    await attendre(2); // Date.now() doit avancer : deux départs distincts
    tc.startIntervention();
    egal(chronos().length, 2, "second chrono, le premier tourne toujours");
    egal(tc.els.interventionLabel.textContent, "2 interventions en cours");
    egal(lignes().length, 2, "deux lignes à l'écran");
    vrai(chronos()[0].id !== chronos()[1].id, "identifiants distincts");
    egal(tc.els.btnStartIntervention.hidden, false, "on peut encore en démarrer");
    egal(
      JSON.parse(localStorage.getItem(tc.STORAGE_KEY)).activeInterventions.length,
      2,
      "persistés sur l'appareil"
    );
  });

  await test("chaque ligne a sa minuterie, son « Terminer » et son annulation", async () => {
    const premier = chronos()[0];
    const ligne = tc.els.interventionList.querySelector(`li[data-chrono="${premier.id}"]`);
    vrai(ligne, "ligne du premier chrono");
    contient(ligne.textContent, "depuis " + tc.timeHM(new Date(premier.start)));
    vrai(ligne.querySelector(`[data-chrono-timer="${premier.id}"]`), "minuterie propre");
    vrai(ligne.querySelector(`[data-finish-chrono="${premier.id}"]`), "bouton Terminer propre");
    vrai(ligne.querySelector(`[data-cancel-chrono="${premier.id}"]`), "bouton d'annulation propre");
  });

  await test("le client saisi en cours de route est conservé et n'efface rien", async () => {
    const [a, b] = chronos();
    tc.updateChronoClient(a.id, "  Clinique ABC  ");
    egal(chronos()[0].client, "Clinique ABC", "taillé");
    egal(chronos()[1].client, "", "l'autre chrono n'est pas touché");
    vrai(chronos()[0].updatedAt >= a.updatedAt, "horodaté pour la fusion");
    // La liste ne doit pas être reconstruite sous le curseur pendant la saisie :
    // le champ doit rester le MÊME nœud après un rendu.
    const champAvant = tc.els.interventionList.querySelector(`[data-chrono-client="${a.id}"]`);
    tc.renderInterventionLive();
    vrai(
      champAvant === tc.els.interventionList.querySelector(`[data-chrono-client="${a.id}"]`),
      "champ reconstruit sous le curseur"
    );
    egal(
      tc.els.interventionList.querySelector(`[data-chrono-client="${b.id}"]`).value,
      "",
      "champ du second chrono toujours vide"
    );
  });

  await test("terminer : formulaire aux vraies heures, client repris, les autres tournent", async () => {
    const [a, b] = chronos();
    tc.finishIntervention(a.id);
    vrai(tc.els.interventionDialog.open, "dialogue ouvert");
    egal(tc.interventionDialogClosesChrono, a.id, "le dialogue vise CE chrono");
    egal(tc.els.fDate.value, tc.dateISO(new Date(a.start)), "date du chrono");
    egal(tc.els.fStart.value, tc.timeHM(new Date(a.start)), "début du chrono, rien à taper");
    egal(tc.els.fClient.value, "Clinique ABC", "client repris du chrono");
    contient(tc.els.interventionDialogTitle.textContent, "Terminer");
    egal(chronos().length, 2, "rien n'est arrêté avant l'enregistrement");
    vrai(chronos().some((c) => c.id === b.id), "le second chrono est intact");
  });

  await test("fermer sans enregistrer : le chrono visé tourne encore", async () => {
    const a = chronos()[0];
    tc.els.interventionDialog.close(); // équivalent d'Échap
    await attendreQue(() => tc.interventionDialogClosesChrono === null, "écouteur close exécuté");
    egal(chronos().length, 2, "les deux chronos sont là");
    egal(chronos()[0].start, a.start, "heure de début intacte");
  });

  await test("enregistrement : heures exactes, minimum d'une minute, ce chrono-là s'arrête", async () => {
    await reinitialiser();
    tc.startIntervention();
    await attendre(2);
    tc.startIntervention();
    const [a, b] = chronos();
    tc.finishIntervention(a.id);
    tc.els.fDescription.value = "Remplacement du disque";
    tc.els.fClient.value = "Clinique ABC";
    tc.submitInterventionForm(evenement);
    await attendre(0);
    egal(tc.state.interventions.length, 1, "intervention inscrite");
    const i = tc.state.interventions[0];
    egal(i.start, a.start, "début au millième près, pas reconstruit depuis « HH:MM »");
    egal(i.end, a.start + 60000, "intervention éclair portée à une minute");
    egal(chronos().length, 1, "un seul chrono arrêté");
    egal(chronos()[0].id, b.id, "c'est bien l'autre qui continue");
    vrai(tc.state.tombstones[a.id] > 0, "pierre tombale sur le chrono arrêté");
    egal(tc.state.tombstones[i.id], undefined, "l'intervention inscrite n'est PAS enterrée");
    egal(tc.els.interventionDialog.open, false, "dialogue fermé");
  });

  await test("annuler : refus conservé, accord ne retire que ce chrono", async () => {
    await attendre(2);
    tc.startIntervention();
    egal(chronos().length, 2);
    const [garde, jete] = chronos();
    reponseConfirm = false;
    tc.cancelIntervention(jete.id);
    egal(chronos().length, 2, "refus → rien de retiré");
    reponseConfirm = true;
    tc.cancelIntervention(jete.id);
    egal(chronos().length, 1, "chrono annulé");
    egal(chronos()[0].id, garde.id, "l'autre est intact");
    vrai(tc.state.tombstones[jete.id] > 0, "pierre tombale posée");
    egal(tc.state.interventions.length, 1, "aucune intervention inscrite par l'annulation");
  });

  await test("fusion : union par identifiant, arrêt respecté, punch indépendant", async () => {
    const etat = (extra) => ({
      activePunch: null, activePunchAt: 0, activeInterventions: [],
      punches: [], interventions: [], tombstones: {}, updatedAt: 0, ...extra,
    });

    // Deux appareils, un chrono chacun : les deux doivent survivre.
    const deux = tc.mergeStates(
      etat({ activeInterventions: [{ id: "c1", start: 1000, client: "", updatedAt: 10 }] }),
      etat({ activeInterventions: [{ id: "c2", start: 2000, client: "B", updatedAt: 20 }] })
    );
    egal(deux.activeInterventions.length, 2, "les deux chronos coexistent");
    egal(deux.activeInterventions[0].id, "c1", "triés par heure de départ");

    // Le client saisi le plus récemment l'emporte.
    const recent = tc.mergeStates(
      etat({ activeInterventions: [{ id: "c1", start: 1000, client: "ancien", updatedAt: 10 }] }),
      etat({ activeInterventions: [{ id: "c1", start: 1000, client: "récent", updatedAt: 30 }] })
    );
    egal(recent.activeInterventions.length, 1, "pas de doublon");
    egal(recent.activeInterventions[0].client, "récent");

    // Arrêté ici, encore en marche là-bas : la pierre tombale gagne.
    const arrete = tc.mergeStates(
      etat({ tombstones: { c1: 40 } }),
      etat({ activeInterventions: [{ id: "c1", start: 1000, client: "", updatedAt: 30 }] })
    );
    egal(arrete.activeInterventions.length, 0, "un chrono arrêté ne repart pas");

    // Le punch s'arbitre toujours à part.
    const avecPunch = tc.mergeStates(
      etat({ activePunch: { start: 111 }, activePunchAt: 50 }),
      etat({ activeInterventions: [{ id: "c9", start: 900, client: "", updatedAt: 60 }] })
    );
    egal(avecPunch.activePunch.start, 111, "punch local conservé");
    egal(avecPunch.activeInterventions.length, 1, "chrono distant conservé");
  });

  await test("ancien format : le chrono unique est repris, sans doublon entre appareils", async () => {
    const ancien = { punches: [], interventions: [], activeIntervention: { start: 1234 }, activeInterventionAt: 99 };
    const { state: a } = tc.normalizeState(ancien);
    egal(a.activeInterventions.length, 1, "chrono repris");
    egal(a.activeInterventions[0].start, 1234);
    egal(a.activeInterventions[0].updatedAt, 99, "horodatage de l'ancien champ conservé");
    // Deux appareils convertissent chacun de leur côté : même identifiant.
    const { state: b } = tc.normalizeState(ancien);
    egal(a.activeInterventions[0].id, b.activeInterventions[0].id, "identifiant déterministe");
    egal(tc.mergeStates(a, b).activeInterventions.length, 1, "la fusion n'en fait pas deux");

    const { state: abime } = tc.normalizeState({
      punches: [], interventions: [], activeInterventions: [{ start: "hier" }, { id: "ok", start: 5000 }],
    });
    egal(abime.activeInterventions.length, 1, "chrono illisible écarté");
    egal(abime.activeInterventions[0].id, "ok");
  });

  await test("le chrono survit au rechargement", async () => {
    await reinitialiser();
    tc.startIntervention();
    tc.updateChronoClient(chronos()[0].id, "Clinique ABC");
    const relu = tc.load(); // relit le stockage local, comme un rechargement
    egal(relu.activeInterventions.length, 1, "chrono retrouvé");
    egal(relu.activeInterventions[0].client, "Clinique ABC", "client retrouvé");
    egal(relu.activeInterventions[0].start, chronos()[0].start);
  });

  await test("chrono oublié : un avis par chrono, l'action termine le bon", async () => {
    await reinitialiser();
    tc.state.activeInterventions.push(
      { id: "vieux", start: Date.now() - 13 * 3600 * 1000, client: "Clinique ABC", updatedAt: 1 },
      { id: "recent", start: Date.now() - 60000, client: "", updatedAt: 1 }
    );
    tc.persistLocal();
    tc.checkInterventionOubliee();
    vrai(tc.activeBanners.has(tc.AVIS_CHRONO + "vieux"), "avis sur le chrono oublié");
    egal(tc.activeBanners.has(tc.AVIS_CHRONO + "recent"), false, "rien sur le chrono récent");
    contient(tc.els.banners.textContent, "chronométrée depuis 13 h");
    contient(tc.els.banners.textContent, "pour Clinique ABC", "le client nomme le chrono visé");

    const bouton = [...tc.els.banners.querySelectorAll("button")].find(
      (b) => b.textContent === "Terminer avec la bonne heure de fin"
    );
    vrai(bouton, "action de correction présente");
    bouton.click();
    egal(tc.interventionDialogClosesChrono, "vieux", "c'est le chrono oublié qui est visé");
    await fermerDialogues();
    egal(chronos().length, 2, "rien perdu après une fermeture");

    // Le chrono disparu emporte son avis avec lui.
    reponseConfirm = true;
    tc.cancelIntervention("vieux");
    egal(tc.activeBanners.has(tc.AVIS_CHRONO + "vieux"), false, "avis retiré avec le chrono");
  });

  await test("punch out : les chronos continuent, avec un avis discret au pluriel", async () => {
    await reinitialiser();
    tc.punchIn();
    tc.startIntervention();
    await attendre(2);
    tc.startIntervention();
    tc.punchOut();
    egal(chronos().length, 2, "chronos intacts");
    const avis = [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ");
    contient(avis, "les 2 interventions chronométrées continuent de tourner");
  });

  await test("le battement survit au punch out : les chronos avancent encore", async () => {
    // Régression : un seul setInterval sert les deux sortes de chronos.
    // L'arrêt du punch ne doit pas figer les interventions en cours.
    const minuteries = () =>
      [...tc.els.interventionList.querySelectorAll("[data-chrono-timer]")].map((e) => e.textContent).join("|");
    const avant = minuteries();
    await attendre(1300);
    vrai(minuteries() !== avant, `minuteries figées à ${avant}`);
  });

  await test("la bande dit quand les chronos tournent hors punch", async () => {
    contient(tc.els.interventionDetail.textContent, "aucun punch en cours");
    tc.punchIn();
    absent(tc.els.interventionDetail.textContent, "aucun punch en cours", "rappel retiré au punch in");
    for (const c of [...chronos()]) tc.cancelIntervention(c.id);
    egal(tc.els.interventionLabel.textContent, "Aucune intervention en cours", "retour au repos");
    egal(tc.els.interventionList.hidden, true, "liste masquée");
  });
}

/* ---------- Exécution et rapport ---------- */

function afficher() {
  // Volontairement autonome (aucun appel à __tc) : ce rapport doit
  // fonctionner même quand l'application elle-même n'a pas pu se charger.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const echecs = resultats.filter((r) => !r.ok);
  const bloc = document.createElement("section");
  bloc.style.cssText =
    "position:fixed;inset:auto 12px 12px 12px;max-height:45vh;overflow:auto;z-index:9999;" +
    "background:#0d1117;color:#e6edf3;border:2px solid " + (echecs.length ? "#f85149" : "#3fb950") + ";" +
    "border-radius:8px;padding:12px 16px;font:13px/1.5 monospace;";
  const titre = echecs.length
    ? `❌ ${echecs.length} échec(s) sur ${resultats.length} tests`
    : `✅ ${resultats.length} tests, tous réussis`;
  bloc.innerHTML =
    `<strong>${titre}</strong>` +
    echecs
      .map(
        (e) =>
          `<div style="margin-top:8px"><strong>[${esc(e.section)}] ${esc(e.nom)}</strong><br>${esc(e.message || "")}</div>`
      )
      .join("");
  document.body.appendChild(bloc);
  document.title = (echecs.length ? "ECHECS " : "OK ") + document.title;
}

async function principale() {
  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
    await sectionG();
    await sectionH();
    await sectionI();
    await sectionJ();
    await sectionK();
    await sectionL();
    await sectionM();
    await sectionN();
    await sectionO();
    await sectionP();
    await sectionQ();
    await sectionR();
    await sectionS();
  } catch (e) {
    resultats.push({
      section: "harnais",
      nom: "exécution complète de la suite",
      ok: false,
      message: String((e && e.stack) || e).slice(0, 500),
    });
  }

  for (const err of erreursGlobales) {
    resultats.push({ section: "harnais", nom: "erreur globale inattendue", ok: false, message: err });
  }
  // Erreurs survenues AVANT ce module (chargement d'app-instrumente.js par
  // exemple), capturées par le script d'amorce injecté dans banc.html.
  for (const err of window.__erreursBanc || []) {
    resultats.push({ section: "harnais", nom: "erreur au chargement de la page", ok: false, message: String(err) });
  }

  try {
    afficher();
  } catch (e) {
    resultats.push({ section: "harnais", nom: "affichage du rapport", ok: false, message: String(e) });
  }
  try {
    window.__resultatsEnvoyes = true; // désarme le filet de banc.html
    await fetch("/__resultats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tests: resultats }),
      keepalive: true, // survit même si le navigateur ferme la page
    });
  } catch (e) {
    /* banc ouvert à la main sans serveur de résultats : le tableau suffit */
  }
}

principale();
