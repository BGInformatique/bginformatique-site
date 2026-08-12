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
 *
 * DEUX ABONNEMENTS COEXISTENT depuis l'éclair : le document « state » et la
 * file de lancement (une requête sur la collection). Ils sont gardés séparés —
 * les confondre ferait passer un instantané d'état pour une file, et le banc
 * ne verrait plus la différence.
 *
 *   __bouchon.emettreLancements([{id, ...champs}])
 *   __bouchon.lancementsEcrits     → écritures dont le chemin est lancement-*
 */

const bouchon = (globalThis.__bouchon = globalThis.__bouchon || {});

bouchon.ecritures = [];
bouchon.echecEcriture = null;
bouchon.optionsFirestore = null;
bouchon.cheminDocument = null;
bouchon.abonnements = 0;
bouchon.desabonnements = 0;

let rappelInstantane = null;
let rappelFile = null;

bouchon.lancementsEcrits = [];

bouchon.derniereEcriture = () =>
  bouchon.ecritures.length ? bouchon.ecritures[bouchon.ecritures.length - 1] : null;

bouchon.dernierLancement = () =>
  bouchon.lancementsEcrits.length
    ? bouchon.lancementsEcrits[bouchon.lancementsEcrits.length - 1]
    : null;

bouchon.emettreLancements = function (documents) {
  if (!rappelFile) throw new Error("Aucun abonnement à la file de lancement");
  rappelFile({
    forEach: (f) =>
      documents.forEach(({ id, ...champs }) =>
        f({ id, data: () => JSON.parse(JSON.stringify(champs)) })),
  });
};

bouchon.fileActive = () => rappelFile !== null;

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

export function collection(db, ...segments) {
  return { db, path: segments.join("/"), estCollection: true };
}

export function query(ref, ...contraintes) {
  return { ...ref, estRequete: true, contraintes };
}

export function where(champ, op, valeur) {
  return { genre: "where", champ, op, valeur };
}

export function setDoc(ref, data) {
  if (bouchon.echecEcriture) {
    return Promise.reject(new Error(bouchon.echecEcriture));
  }
  const copie = JSON.parse(JSON.stringify(data));
  // Les demandes de lancement vivent à côté de « state » dans la même
  // collection : on les range à part pour que les essais d'état ne voient pas
  // passer une écriture qui ne les concerne pas.
  if (/\/lancement-/.test(ref.path || "")) {
    bouchon.lancementsEcrits.push({ chemin: ref.path, ...copie });
  } else {
    bouchon.ecritures.push(copie);
  }
  return Promise.resolve();
}

export function onSnapshot(ref, cb) {
  bouchon.abonnements++;
  if (ref && ref.estRequete) {
    rappelFile = cb;
    return () => {
      bouchon.desabonnements++;
      rappelFile = null;
    };
  }
  rappelInstantane = cb;
  return () => {
    bouchon.desabonnements++;
    rappelInstantane = null;
  };
}
