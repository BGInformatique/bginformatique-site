/*
 * Bouchon de firebase-firestore.js.
 *
 * Enregistre les écritures au lieu de les envoyer, et laisse le banc
 * fabriquer des instantanés à volonté — y compris le cas qui a déjà
 * effacé des données : un instantané « document inexistant » venu du
 * CACHE et non du serveur.
 *
 *   __bouchon.ecritures            → tableau des états envoyés (copies)
 *   __bouchon.derniereEcriture()   → le dernier, ou null
 *   __bouchon.viderEcritures()
 *   __bouchon.echecEcriture        → message d'erreur à renvoyer, ou null
 *   __bouchon.emettreInstantane({existe, donnees, depuisCache})
 *   __bouchon.optionsFirestore     → ce qui a été passé à initializeFirestore
 */

const bouchon = (globalThis.__bouchon = globalThis.__bouchon || {});

bouchon.ecritures = [];
bouchon.echecEcriture = null;
bouchon.optionsFirestore = null;
bouchon.cheminDocument = null;
bouchon.abonnements = 0;
bouchon.desabonnements = 0;

let rappelInstantane = null;

bouchon.derniereEcriture = () =>
  bouchon.ecritures.length ? bouchon.ecritures[bouchon.ecritures.length - 1] : null;

bouchon.viderEcritures = () => {
  bouchon.ecritures = [];
};

bouchon.emettreInstantane = function ({ existe = true, donnees = {}, depuisCache = false }) {
  if (!rappelInstantane) throw new Error("Aucun abonnement onSnapshot actif");
  rappelInstantane({
    exists: () => existe,
    data: () => JSON.parse(JSON.stringify(donnees)),
    metadata: { fromCache: depuisCache, hasPendingWrites: false },
  });
};

bouchon.abonnementActif = () => rappelInstantane !== null;

export function initializeFirestore(app, options) {
  bouchon.optionsFirestore = options;
  return { app, options };
}

export function persistentLocalCache(o) {
  return { genre: "persistentLocalCache", ...o };
}

export function persistentMultipleTabManager() {
  return { genre: "persistentMultipleTabManager" };
}

export function doc(db, ...segments) {
  const path = segments.join("/");
  bouchon.cheminDocument = path;
  return { db, path };
}

export function setDoc(ref, data) {
  if (bouchon.echecEcriture) {
    return Promise.reject(new Error(bouchon.echecEcriture));
  }
  // Copie : l'application réutilise et modifie l'objet `state` juste après.
  bouchon.ecritures.push(JSON.parse(JSON.stringify(data)));
  return Promise.resolve();
}

export function onSnapshot(ref, cb) {
  rappelInstantane = cb;
  bouchon.abonnements++;
  return () => {
    bouchon.desabonnements++;
    rappelInstantane = null;
  };
}
