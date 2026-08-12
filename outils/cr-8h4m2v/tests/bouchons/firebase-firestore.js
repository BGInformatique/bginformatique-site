/*
 * Bouchon de firebase-firestore.js.
 *
 * La page ne fait que LIRE : ce bouchon n'a donc pas à simuler l'écriture, mais
 * il expose quand même setDoc et updateDoc — en ÉCHEC BRUYANT. Si un jour
 * quelqu'un ajoute une écriture dans app.js, le banc le dira au lieu de la
 * laisser passer. Les règles Firestore la refuseraient de toute façon en
 * production, et un refus découvert en production coûte plus cher qu'ici.
 *
 *   __bouchon.emettreInstantane({existe, donnees, depuisCache})
 *   __bouchon.cheminDocument      → le chemin auquel la page s'est abonnée
 *   __bouchon.emettreErreur(msg)  → simule une lecture refusée
 */
const bouchon = (globalThis.__bouchon = globalThis.__bouchon || {});

bouchon.cheminDocument = null;
bouchon.abonnements = 0;
bouchon.optionsFirestore = null;

let rappelInstantane = null;
let rappelErreur = null;

export function initializeFirestore(app, options) {
  bouchon.optionsFirestore = options;
  return { nom: "banc-db" };
}

export function persistentLocalCache(options) {
  return { genre: "persistentLocalCache", options };
}

export function persistentMultipleTabManager() {
  return { genre: "persistentMultipleTabManager" };
}

export function doc(db, ...segments) {
  bouchon.cheminDocument = segments.join("/");
  return { chemin: bouchon.cheminDocument };
}

export function onSnapshot(reference, surInstantane, surErreur) {
  bouchon.abonnements += 1;
  rappelInstantane = surInstantane;
  rappelErreur = surErreur || null;
  return () => { rappelInstantane = null; rappelErreur = null; };
}

export function setDoc() {
  throw new Error("banc : la page ne doit rien écrire (setDoc appelé)");
}

export function updateDoc() {
  throw new Error("banc : la page ne doit rien écrire (updateDoc appelé)");
}

bouchon.emettreInstantane = ({ existe = true, donnees = null, depuisCache = false }) => {
  if (!rappelInstantane) throw new Error("banc : aucun abonnement en cours");
  rappelInstantane({
    exists: () => existe,
    data: () => donnees,
    metadata: { fromCache: depuisCache },
  });
};

bouchon.emettreErreur = (message) => {
  if (rappelErreur) rappelErreur(new Error(message));
};
