/*
 * Mandat courant — module partagé par les quatre écrans de l'outil.
 *
 * L'outil pilote plusieurs mandats à la fois. Le mandat n'est pas un filtre
 * parmi d'autres : c'est le CONTEXTE de travail, et il doit valoir partout, du
 * tableau de bord à la veille. Deux mandats mélangés dans un même écran, ce
 * n'est pas un inconfort d'affichage — c'est une tâche saisie sous le mauvais
 * mandat, un temps consigné au mauvais endroit, une relance envoyée au nom de
 * la mauvaise entreprise.
 *
 * Le choix vit dans localStorage plutôt que dans Firestore : c'est un réglage
 * d'appareil, pas une donnée de mandat. Deux appareils peuvent légitimement
 * travailler sur deux mandats différents en même temps.
 *
 * Aucun nom de mandat n'est écrit ici — le dépôt est public. Les mandats
 * naissent des enregistrements saisis, et rien d'autre.
 */

const CLE = "marketing.v1.mandat";

/*
 * Deux documents ne nous appartiennent pas : « prospection » et
 * « linkedin-lot » sont écrits par le prospecteur et le lanceur de BG001. On ne
 * peut donc pas les déplacer sous un chemin par mandat sans casser ces
 * processus — qui, eux, n'ont pas de raison de connaître ce changement.
 *
 * On note plutôt À QUI ils appartiennent. Le tableau de bord, seul écran qui
 * lit `state`, dépose ici le mandat suivi (`config.mandatStme`) ; les autres
 * écrans le relisent sans avoir à s'abonner à `state` pour si peu.
 *
 * Vide = appartenance inconnue : on affiche alors, plutôt que de cacher à tort.
 */
const CLE_EXTERNE = "marketing.v1.mandat-externe";

/*
 * La liste des mandats connus. Elle naît des tâches, donc seul le tableau de
 * bord la voit — les autres écrans ne s'abonnent pas à `state` pour si peu.
 * Il la dépose ici pour qu'ils puissent afficher le même sélecteur.
 *
 * Ce n'est pas de la donnée de mandat au sens du dépôt : ça ne quitte jamais
 * l'appareil, et rien de tout ça n'est écrit dans le code.
 */
const CLE_MANDATS = "marketing.v1.mandats";

function lire(cle) {
  try { return localStorage.getItem(cle) || ""; } catch { return ""; }
}

function ecrire(cle, v) {
  try {
    if (v) localStorage.setItem(cle, v);
    else localStorage.removeItem(cle);
  } catch { /* stockage plein ou refusé : le choix vaut pour la session */ }
}

export function lireMandat() { return lire(CLE); }
export function ecrireMandat(v) { ecrire(CLE, v); }

export function mandatExterne() { return lire(CLE_EXTERNE); }
export function noterMandatExterne(v) {
  if (v !== lire(CLE_EXTERNE)) ecrire(CLE_EXTERNE, v);
}

export function lireMandats() {
  try {
    const v = JSON.parse(localStorage.getItem(CLE_MANDATS) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch { return []; }
}

export function noterMandats(liste) {
  const propre = JSON.stringify([...new Set(liste.filter(Boolean))].sort());
  try {
    if (propre !== localStorage.getItem(CLE_MANDATS)) localStorage.setItem(CLE_MANDATS, propre);
  } catch { /* stockage plein ou refusé */ }
}

/*
 * Un document écrit par un processus externe appartient-il au mandat courant ?
 *
 * Les deux « inconnu » répondent oui : sans mandat choisi on regarde tout, et
 * sans appartenance connue on préfère montrer que cacher. Cacher à tort est le
 * défaut le plus coûteux — on cherche une section qui existe pourtant.
 */
export function appartientAuMandat(mandatCourant, proprietaire) {
  if (!mandatCourant) return true;
  if (!proprietaire) return true;
  return mandatCourant === proprietaire;
}

/*
 * Le sélecteur de l'en-tête. Mêmes pastilles que les filtres, mais en bleu une
 * fois choisies : le mandat commande tout l'écran, il ne doit pas se lire comme
 * un filtre de plus.
 */
export function rendreSelecteur(cible, mandats, courant, onChange) {
  const el = typeof cible === "string" ? document.getElementById(cible) : cible;
  if (!el) return;
  const ech = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const entrees = [["", "Tous les mandats"], ...mandats.map((m) => [m, m])];
  el.innerHTML = entrees.map(([v, l]) =>
    `<button class="puce" data-v="${ech(v)}" aria-pressed="${courant === v}">${ech(l)}</button>`
  ).join("");
  el.querySelectorAll("[data-v]").forEach((b) => {
    b.onclick = () => { ecrireMandat(b.dataset.v); onChange(b.dataset.v); };
  });
}

/*
 * Un onglet change de mandat, les autres suivent. Sans ça, deux onglets ouverts
 * affichent deux mandats différents en croyant tous les deux montrer « le »
 * mandat courant — et c'est exactement là qu'on saisit au mauvais endroit.
 */
export function surChangementDeMandat(cb) {
  window.addEventListener("storage", (ev) => {
    if (ev.key === CLE) cb(lireMandat());
  });
}
