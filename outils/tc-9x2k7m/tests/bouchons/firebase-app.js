/*
 * Bouchon de firebase-app.js.
 *
 * L'application importe Firebase depuis gstatic. Pendant les essais, une
 * carte d'imports (voir preparer.py) détourne ces URL vers ce dossier :
 * aucune requête ne sort de la machine, aucun compte n'est nécessaire.
 */

export function initializeApp(config) {
  return { name: "[bouchon]", options: config };
}
