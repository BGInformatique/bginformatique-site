// Bouchon de firebase-app.js — le banc ne joint jamais Google.
export function initializeApp(config) {
  const bouchon = (globalThis.__bouchon = globalThis.__bouchon || {});
  bouchon.config = config;
  return { nom: "banc" };
}
