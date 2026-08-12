/*
 * Bouchon de firebase-auth.js.
 *
 * Le banc ouvre la session tout de suite : la page à regarder est celle d'un
 * propriétaire connecté, pas la porte d'entrée. La fenêtre surgissante
 * Microsoft n'a rien à faire dans un rendu automatique.
 */
const bouchon = (globalThis.__bouchon = globalThis.__bouchon || {});
bouchon.connexions = 0;
bouchon.deconnexions = 0;

let rappel = null;

export function getAuth() {
  return { utilisateur: null };
}

export class OAuthProvider {
  constructor(fournisseur) {
    this.fournisseur = fournisseur;
    this.parametres = null;
  }

  setCustomParameters(parametres) {
    this.parametres = parametres;
    bouchon.parametresOAuth = parametres;
  }
}

export function signInWithPopup() {
  bouchon.connexions += 1;
  return Promise.resolve({ user: bouchon.utilisateur });
}

export function signOut() {
  bouchon.deconnexions += 1;
  if (rappel) rappel(null);
  return Promise.resolve();
}

export function onAuthStateChanged(auth, fonction) {
  rappel = fonction;
  bouchon.utilisateur = { uid: "banc-uid", email: "jeremie@bginformatique.ca" };
  // Asynchrone comme le vrai : un rappel synchrone masquerait tout problème
  // d'ordre entre l'ouverture de session et l'abonnement au document.
  Promise.resolve().then(() => fonction(bouchon.utilisateur));
  return () => { rappel = null; };
}
