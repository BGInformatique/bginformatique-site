/*
 * FRAGMENT — ne s'importe pas tout seul.
 *
 * preparer.py colle ce fichier À LA SUITE de js/app.js pour produire
 * genere/app-instrumente.js. Il s'exécute donc dans la portée du module de
 * l'application et peut atteindre ses fonctions et variables internes, qui
 * ne sont pas exportées.
 *
 * C'est ce qui permet d'éprouver le code réel plutôt qu'une copie : app.js
 * n'est jamais modifié à la main, la version instrumentée est régénérée à
 * chaque exécution du banc. Si un nom listé ici disparaît d'app.js, le banc
 * échoue au chargement — c'est le signal que le pont doit suivre.
 */

globalThis.__tc = {
  /* --- État interne, en lecture et en écriture --- */
  get state() {
    return state;
  },
  set state(v) {
    state = v;
  },
  get printing() {
    return printing;
  },
  set printing(v) {
    printing = v;
  },
  get todayKey() {
    return todayKey;
  },
  set todayKey(v) {
    todayKey = v;
  },
  get applyingRemote() {
    return applyingRemote;
  },
  set applyingRemote(v) {
    applyingRemote = v;
  },
  get syncBloquee() {
    return syncBloquee;
  },
  set syncBloquee(v) {
    syncBloquee = v;
  },
  get lastWritten() {
    return lastWritten;
  },
  set lastWritten(v) {
    lastWritten = v;
  },
  get userDocRef() {
    return userDocRef;
  },
  get editOrigin() {
    return editOrigin;
  },
  set editOrigin(v) {
    editOrigin = v;
  },
  get punchDialogClosesActive() {
    return punchDialogClosesActive;
  },
  get interventionDialogClosesActive() {
    return interventionDialogClosesActive;
  },
  dayOverrides,
  activeBanners,
  summaryExpanded,

  /* --- Éléments du DOM tels que l'application les voit --- */
  els,
  elsAuth,

  /* --- Constantes --- */
  STORAGE_KEY,
  IMPORT_BACKUP_KEY,
  QUARANTINE_PREFIX,
  CHRONO_OUBLIE_MS,
  TOMBSTONE_TTL_MS,
  INVALID_DURATION_MSG,
  GROUP_LABELS,

  /* --- Données --- */
  emptyState,
  load,
  normalizeState,
  sanePeriod,
  mergeStates,
  sameState,
  touch,
  persistLocal,
  save,
  syncUp,
  genId,
  applyRemoteSnapshot,

  // persistLocal est une déclaration de fonction, donc une liaison
  // modifiable : le banc la remplace pour simuler un stockage plein, puis
  // la restaure avec la référence d'origine gardée dans __tc.persistLocal.
  setPersistLocal(fn) {
    persistLocal = fn;
  },

  /* --- Dates et durées --- */
  dateISO,
  timeHM,
  dayLabel,
  minutesBetween,
  fmtDuration,
  fmtDecimalHours,
  startOfDay,
  addDays,
  startOfWeek,
  startOfMonth,
  addMonths,

  /* --- Avis --- */
  banner,
  dismissBanner,
  renderBanners,
  showToast,

  /* --- Punch --- */
  punchIn,
  punchOut,
  cancelPunch,
  renderPunchCard,
  updateTimer,
  chronoHMS,
  ensureChronoInterval,
  checkPunchOublie,
  openPunchDialog,
  submitPunchForm,
  editPunch,
  deletePunch,

  /* --- Formulaires --- */
  timesFromFields,
  resolveTimes,
  showDuration,

  /* --- Intervention chronométrée --- */
  startIntervention,
  finishIntervention,
  cancelIntervention,
  renderInterventionLive,
  updateInterventionTimer,
  checkInterventionOubliee,

  /* --- Interventions --- */
  openInterventionDialog,
  nouvelleIntervention,
  ventilerPunch,
  submitInterventionForm,
  editIntervention,
  deleteIntervention,
  toggleInterventionVerify,
  updateInterventionVerifyNote,
  uniqueValues,
  uniqueClients,

  /* --- Périodes et filtres --- */
  filterRange,
  parseDateInput,
  rangeLabel,
  rangeSlug,
  inRange,
  filteredPunches,
  periodInterventions,
  filteredInterventions,
  ensureVisible,
  ensureInterventionVisible,

  /* --- Rendu --- */
  escapeHtml,
  render,
  renderStats,
  minutesParJour,
  isDayExpanded,
  toggleDay,
  renderPunchTable,
  renderClientFilter,
  renderInterventionTable,
  groupedInterventions,
  renderSummaryTable,
  toggleSummaryGroup,
  updatePrintMeta,

  /* --- Exports --- */
  csvField,
  csvEntete,
  csvTotalRow,
  filtresActifs,
  exportPunchesCsv,
  exportInterventionsCsv,
  exportSummaryCsv,
  isoWeekLabel,
  generateWeeklyReport,
  exportJson,
  importJson,

  /*
   * Détournement des téléchargements : downloadFile est lui aussi une
   * liaison modifiable. Le banc le remplace pour capturer le contenu au
   * lieu d'ouvrir un téléchargement dans un navigateur sans écran.
   * downloadCsv passe par downloadFile : un seul détournement suffit.
   */
  fichiers: [],
  intercepterTelechargements() {
    globalThis.__tc.fichiers = [];
    downloadFile = function (name, content, type) {
      globalThis.__tc.fichiers.push({ name, content, type });
    };
  },
  dernierFichier() {
    const f = globalThis.__tc.fichiers;
    return f.length ? f[f.length - 1] : null;
  },
};
