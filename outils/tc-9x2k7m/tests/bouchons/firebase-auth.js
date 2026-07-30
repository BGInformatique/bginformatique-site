/*
 * Bouchon de firebase-auth.js.
 *
 * Le banc pilote l'authentification par globalThis.__bouchon :
 *   __bouchon.connecter("uid-essai")  → onAuthStateChanged reçoit un usager
 *   __bouchon.deconnecter()           → onAuthStateChanged reçoit null
 */

const bouchon = (globalThis.__bouchon = globalThis.__bouchon || {});

let ecouteurs = [];
let utilisateur = null;

bouchon.auth = {
  // Ce que l'application a demandé au fournisseur : le banc vérifie que le
  // locataire Azure est bien transmis.
  providerId: null,
  parametres: null,
  connexionsDemandees: 0,
  deconnexionsDemandees: 0,
  echecConnexion: null,
};

function diffuser() {
  for (const cb of [...ecouteurs]) cb(utilisateur);
}

bouchon.connecter = function (uid) {
  utilisateur = { uid: uid || "uid-essai", email: "essai@bginformatique.ca" };
  diffuser();
  return utilisateur;
};

bouchon.deconnecter = function () {
  utilisateur = null;
  diffuser();
};

bouchon.usagerCourant = () => utilisateur;

export function getAuth(app) {
  return { app };
}

export class OAuthProvider {
  constructor(providerId) {
    this.providerId = providerId;
    bouchon.auth.providerId = providerId;
  }
  setCustomParameters(p) {
    this.customParameters = p;
    bouchon.auth.parametres = p;
    return this;
  }
}

export function signInWithPopup(auth, provider) {
  bouchon.auth.connexionsDemandees++;
  if (bouchon.auth.echecConnexion) {
    return Promise.reject(new Error(bouchon.auth.echecConnexion));
  }
  bouchon.connecter();
  return Promise.resolve({ user: utilisateur });
}

export function signOut() {
  bouchon.auth.deconnexionsDemandees++;
  bouchon.deconnecter();
  return Promise.resolve();
}

export function onAuthStateChanged(auth, cb) {
  ecouteurs.push(cb);
  cb(utilisateur);
  return () => {
    ecouteurs = ecouteurs.filter((x) => x !== cb);
  };
}
