/*
 * BGFoods — injecter des circulaires, sortir des listes d'épicerie.
 *
 * Trois écrans, dans l'ordre où on s'en sert :
 *   Liste       — on écrit ses besoins, l'outil choisit l'épicerie la moins
 *                 chère par article et regroupe la liste par magasin;
 *   Aubaines    — tous les rabais en vigueur, par épicerie et catégorie;
 *   Circulaires — l'import (PDF lu dans le navigateur, ou texte collé) et la
 *                 correction des lignes mal lues.
 *
 * La comparaison se fait au prix unitaire (100 g / 100 ml / unité) : c'est la
 * seule façon de départager un 500 g et un 1 kg. Tout le calcul vit dans
 * normalisation.js, analyseur.js et optimiseur.js, sans DOM — le banc d'essai
 * les exécute directement.
 *
 * Données : localStorage (« bgfoods.v1 ») + Firestore par compte Microsoft,
 * chemin users/<uid>/bgfoods/state. La synchro fusionne ENREGISTREMENT PAR
 * ENREGISTREMENT (etat.js) : importer une circulaire sur l'ordinateur pendant
 * qu'on coche la liste au magasin ne perd ni l'un ni l'autre.
 */
"use strict";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  OAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  setDoc,
  onSnapshot,
  collection,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";

import * as etatMod from "./etat.js";
import * as analyseur from "./analyseur.js";
import * as optimiseur from "./optimiseur.js";
import {
  CATEGORIES,
  formatPrix,
  formatPrixUnitaire,
  formatTaille,
  formatNombre,
  dateDuJour,
  nomNormalise,
} from "./normalisation.js";
import { ErreurLecture, lireFichier } from "./lecture-pdf.js";
import * as circulairesCom from "./circulaires-com.js";
import * as extractionIA from "./extraction-ia.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Cache persistant : au magasin, le réseau est souvent mauvais. Sans lui, la
// liste déjà chargée disparaîtrait au rechargement de la page.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const UNITES = ["g", "kg", "ml", "l", "lb", "oz", "unite"];
const DELAI_ECRITURE_MS = 900;

let etat = etatMod.lireLocal(window.localStorage);
let utilisateur = null;
let arretEcoute = null;
let premiereLectureFaite = false;
let minuterieEcriture = null;
let resultatCourant = null;
let circulaireOuverte = null;
// Déclarés ICI et pas près de leur code : onAuthStateChanged appelle son rappel
// pendant l'évaluation du module, donc avant qu'un `let` situé plus bas existe.
// Placés plus loin, ils faisaient échouer tout le reste du fichier.
let arretEcouteLancements = null;
const lancementsVus = new Map();
// Veille sur les nouvelles circulaires (voir sa section). Même raison d'être
// ici : `rendre()` la dessine, et `rendre()` part dès la connexion.
let veilleFaite = false;
const veille = { statut: "vide", trouvailles: [], progres: "", note: "", ton: "" };

/* ==================== Utilitaires d'écran ==================== */

const $ = (selecteur) => document.querySelector(selecteur);
const $$ = (selecteur) => [...document.querySelectorAll(selecteur)];

function echapper(valeur) {
  return String(valeur ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function aujourdHui() {
  return dateDuJour();
}

function avis(id, texte, ton = "") {
  const contenant = $("#banners");
  let banniere = contenant.querySelector(`[data-avis="${id}"]`);
  if (!banniere) {
    banniere = document.createElement("div");
    banniere.dataset.avis = id;
    contenant.appendChild(banniere);
  }
  banniere.className = `banner ${ton}`.trim();
  banniere.textContent = texte;
  return banniere;
}

function retirerAvis(id) {
  const banniere = $(`#banners [data-avis="${id}"]`);
  if (banniere) banniere.remove();
}

function avisEphemere(id, texte, ton = "ok", delai = 4000) {
  avis(id, texte, ton);
  setTimeout(() => retirerAvis(id), delai);
}

/* ==================== Enregistrement ==================== */

function enregistrer() {
  etat.updatedAt = Date.now();
  if (!etatMod.ecrireLocal(window.localStorage, etat)) {
    avis(
      "stockage",
      "Le navigateur refuse le stockage local (navigation privée ?). La synchro " +
        "infonuagique reste votre seul filet.",
      "warn",
    );
  }
  planifierEcriture();
  rendre();
}

function planifierEcriture() {
  if (!utilisateur) return;
  // On n'écrit jamais avant d'avoir lu : sans ça, un appareil qui vient de
  // s'ouvrir écraserait dans le nuage ce que l'autre y a déposé.
  if (!premiereLectureFaite) return;
  clearTimeout(minuterieEcriture);
  minuterieEcriture = setTimeout(pousserVersLeNuage, DELAI_ECRITURE_MS);
}

async function pousserVersLeNuage() {
  if (!utilisateur || !premiereLectureFaite) return;
  try {
    await setDoc(doc(db, "users", utilisateur.uid, "bgfoods", "state"), etat);
    retirerAvis("synchro");
  } catch (e) {
    avis(
      "synchro",
      "Enregistrement infonuagique refusé : " + (e && e.code === "permission-denied"
        ? "les règles Firestore du bloc BGFOODS ne sont pas publiées (voir LISEZ-MOI)."
        : e.message || e),
      "err",
    );
  }
}

function ecouterLeNuage() {
  if (arretEcoute) arretEcoute();
  arretEcoute = onSnapshot(
    doc(db, "users", utilisateur.uid, "bgfoods", "state"),
    (instantane) => {
      const distant = instantane.exists() ? instantane.data() : null;
      const avant = JSON.stringify(etat);
      etat = etatMod.fusionner(etat, distant);
      premiereLectureFaite = true;
      etatMod.ecrireLocal(window.localStorage, etat);
      rendre();
      // La veille attend l'état : les épiceries à surveiller sont celles qu'on
      // a déjà importées. Tant qu'il n'y en a aucune, on ne marque rien comme
      // fait — un appareil qui reçoit ses données au deuxième instantané doit
      // profiter de la veille lui aussi.
      if (!veilleFaite && etat.circulaires.length) {
        veilleFaite = true;
        verifierNouvellesCirculaires().catch(() => { /* la carte porte déjà le détail */ });
      }
      // La fusion a apporté quelque chose que le nuage n'a pas : on le renvoie.
      if (JSON.stringify(etat) !== JSON.stringify(distant) && avant !== JSON.stringify(etat)) {
        planifierEcriture();
      } else if (!distant) {
        planifierEcriture();
      }
      retirerAvis("lecture");
    },
    (e) => {
      premiereLectureFaite = true;
      avis(
        "lecture",
        "Lecture Firestore refusée : " + (e.code === "permission-denied"
          ? "le bloc BGFOODS des règles n'est pas publié (voir LISEZ-MOI). L'outil " +
            "fonctionne quand même sur cet appareil, sans synchro."
          : e.message),
        "err",
      );
    },
  );
}

/* ==================== Connexion ==================== */

$("#btn-login").addEventListener("click", async () => {
  const fournisseur = new OAuthProvider("microsoft.com");
  fournisseur.setCustomParameters({ tenant: MICROSOFT_TENANT_ID, prompt: "select_account" });
  try {
    await signInWithPopup(auth, fournisseur);
  } catch (e) {
    const erreur = $("#auth-error");
    erreur.textContent = `Connexion impossible : ${e.message}`;
    erreur.hidden = false;
  }
});

$("#btn-logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (compte) => {
  utilisateur = compte;
  premiereLectureFaite = false;
  $("#auth-gate").hidden = !!compte;
  $("main").hidden = !compte;
  $("#onglets").hidden = !compte;
  $("#btn-logout").hidden = !compte;
  if (compte) {
    ecouterLeNuage();
    ecouterLancements();
    rendre();
  } else {
    if (arretEcoute) { arretEcoute(); arretEcoute = null; }
    if (arretEcouteLancements) { arretEcouteLancements(); arretEcouteLancements = null; }
    lancementsVus.clear();
    veilleFaite = false;
    veille.statut = "vide";
    veille.trouvailles = [];
  }
});

/* ==================== Onglets ==================== */

const VUES = ["liste", "plans", "aubaines", "circulaires"];

/** Change d'onglet. Écrit une fois : trois boutons y mènent maintenant. */
function ouvrirOnglet(nom) {
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.onglet === nom)));
  for (const vue of VUES) $(`#vue-${vue}`).hidden = vue !== nom;
}

$$(".tab").forEach((onglet) => {
  onglet.addEventListener("click", () => ouvrirOnglet(onglet.dataset.onglet));
});

/* ==================== Import des circulaires ==================== */

function importerPages(pages, options = {}) {
  const texte = pages.join("\n");
  const epicerie =
    (options.epicerie || "").trim() || analyseur.devinerEpicerie(texte) || "Épicerie inconnue";

  let debut = options.debut || "";
  let fin = options.fin || "";
  const avertissements = [...(options.avertissements || [])];
  if (!debut || !fin) {
    const devinee = analyseur.devinerValidite(texte);
    if (devinee) {
      debut = debut || devinee.debut;
      fin = fin || devinee.fin;
    } else {
      const defaut = analyseur.validiteParDefaut();
      debut = debut || defaut.debut;
      fin = fin || defaut.fin;
      avertissements.push("Dates de validité non trouvées : la semaine en cours a été retenue.");
    }
  }
  if (fin < debut) [debut, fin] = [fin, debut];

  const aubaines = analyseur.analyserPages(pages);

  if (!aubaines.length) {
    // Une circulaire sans aubaine n'a aucune utilité et encombrerait la liste.
    // Ce qu'on a quand même tiré du fichier — l'épicerie et les dates — est
    // reporté dans le formulaire : la saisie à la main part de là.
    $("#import-epicerie").value = options.epicerie || epicerie;
    $("#import-debut").value = debut;
    $("#import-fin").value = fin;
    retirerAvis("import");
    avis(
      "import-vide",
      options.imagesProbables
        ? `Cette circulaire est faite d'images : elle ne contient pas de texte à lire ` +
          `(les grandes bannières publient presque toutes leur circulaire ainsi). ` +
          `L'épicerie et les dates ont été récupérées et reportées ci-dessus — ` +
          `saisissez les aubaines qui vous intéressent dans « Coller le texte », ` +
          `une par ligne, par exemple « Poitrines de poulet 3,99 $/lb ».`
        : `Aucune aubaine n'a été reconnue. Le texte du PDF est peut-être disposé en ` +
          `colonnes que la lecture ne recompose pas : collez-le à la main dans ` +
          `l'encadré « Coller le texte ».`,
      "warn",
    );
    return;
  }
  retirerAvis("import-vide");

  const maintenant = Date.now();
  const circulaire = etatMod.ajouter(
    etat,
    "circulaires",
    // `slug` : l'identifiant de l'épicerie chez circulaires.com. Il ne sert pas
    // à l'affichage, mais à la veille — sans lui, retrouver la bannière la
    // semaine suivante demande de fouiller leur annuaire par le nom.
    { epicerie, slug: options.slug || "", debut, fin,
      source: options.source || "", pages: pages.length, statut: "brouillon" },
    maintenant,
  );
  for (const aubaine of aubaines) {
    etatMod.ajouter(etat, "aubaines", { ...aubaine, circulaireId: circulaire.id, validee: 0 }, maintenant);
  }

  circulaireOuverte = circulaire.id;
  enregistrer();

  const detail = avertissements.length ? ` ${avertissements.join(" ")}` : "";
  avisEphemere(
    "import",
    `${aubaines.length} aubaine(s) extraite(s) de ${pages.length} page(s) — ${epicerie}, ` +
      `du ${debut} au ${fin}.${detail}`,
    "ok",
    9000,
  );
}

$("#btn-importer-fichier").addEventListener("click", async () => {
  const champ = $("#fichier");
  const fichier = champ.files && champ.files[0];
  if (!fichier) {
    avisEphemere("fichier", "Choisissez d'abord un fichier.", "warn");
    return;
  }
  const bouton = $("#btn-importer-fichier");
  bouton.disabled = true;
  bouton.textContent = "Lecture…";
  try {
    const lu = await lireFichier(fichier);
    importerPages(lu.pages, {
      epicerie: $("#import-epicerie").value,
      debut: $("#import-debut").value,
      fin: $("#import-fin").value,
      source: fichier.name,
      avertissements: lu.avertissements,
      imagesProbables: lu.imagesProbables,
    });
    champ.value = "";
  } catch (e) {
    avis("fichier", e instanceof ErreurLecture ? e.message : `Lecture impossible : ${e.message}`, "err");
  } finally {
    bouton.disabled = false;
    bouton.textContent = "Extraire les aubaines";
  }
});

$("#btn-importer-texte").addEventListener("click", () => {
  const texte = $("#texte-circulaire").value;
  if (!texte.trim()) {
    avisEphemere("texte", "Collez d'abord le texte de la circulaire.", "warn");
    return;
  }
  importerPages([texte], {
    epicerie: $("#import-epicerie").value,
    debut: $("#import-debut").value,
    fin: $("#import-fin").value,
    source: "Texte collé",
  });
  $("#texte-circulaire").value = "";
});

/* ==================== Récupération depuis circulaires.com ==================== */

/** La circulaire actuellement affichée, avec ses adresses d'images résolues. */
let circulaireCourante = null;

/**
 * Remplit la liste des épiceries depuis l'annuaire de circulaires.com.
 * Rien n'est écrit en dur : une bannière qu'ils ne recensent pas pour la région
 * choisie n'apparaît pas, et c'est la règle qu'on s'est donnée — une seule
 * source. La liste change donc avec la région.
 */
async function rendreChoixEpiceries() {
  const selecteur = $("#cc-epicerie");
  const region = $("#cc-region").value || circulairesCom.REGION_DEFAUT;
  selecteur.innerHTML = '<option value="">Chargement…</option>';
  selecteur.disabled = true;
  try {
    const epiceries = await circulairesCom.chercherEpiceries({ region });
    selecteur.innerHTML = epiceries
      .map((e) => `<option value="${echapper(e.slug)}" data-nom="${echapper(e.nom)}">${echapper(e.nom)}</option>`)
      .join("");
    selecteur.disabled = false;
    $("#cc-compte").textContent =
      `${epiceries.length} épiceries recensées par circulaires.com pour cette région.`;
  } catch (e) {
    selecteur.innerHTML = '<option value="">indisponible</option>';
    $("#cc-compte").textContent = "";
    avis("circulaires-com", `Annuaire injoignable : ${e.message}`, "err");
  }
}

/**
 * Affiche les pages récupérées. Les vignettes pointent directement chez eux :
 * une image s'affiche sans rien demander à CORS. Si leur serveur refuse la
 * requête venue d'ici, l'image ne charge pas — on montre alors un lien plutôt
 * qu'un cadre vide.
 */
function rendreCirculaireTrouvee(circulaire) {
  const contenant = $("#cc-resultat");
  if (!circulaire.pages.length) {
    contenant.innerHTML =
      '<p class="vide">Circulaire trouvée, mais aucune page n\'a pu être lue. ' +
      "La mise en page du site a peut-être changé.</p>";
    return;
  }
  const validite = circulaire.validite
    ? `du ${circulaire.validite.debut} au ${circulaire.validite.fin}`
    : "dates non annoncées";
  contenant.innerHTML = `
    <p class="small muted">${circulaire.pages.length} page(s) — ${echapper(circulaire.epicerie)},
      ${echapper(validite)}.
      <a href="${echapper(circulaire.source)}" target="_blank" rel="noopener">Voir sur circulaires.com</a></p>
    <div class="barre">
      <button class="btn" id="btn-cc-eclair" title="Faire lire ces pages par Claude sur BG001 — sans frais">
        <svg class="ic-eclair" width="14" height="14" aria-hidden="true"><use href="#i-eclair"></use></svg>
        Lire sur BG001</button>
      <button class="btn btn-ghost" id="btn-cc-extraire">Extraire ici (avec ma clé)</button>
      <button class="btn btn-ghost" id="btn-cc-ordre">Copier l'ordre pour le terminal</button>
    </div>
    <div id="cc-lancement"></div>
    <div id="cc-progres" class="small muted"></div>
    <div class="pages">${circulaire.pages
      .map(
        (page, index) => `<a href="#" data-page="${index}" title="Ouvrir en pleine résolution">
          <img src="${echapper(page.apercu)}" alt="Page ${index + 1}" loading="lazy" referrerpolicy="no-referrer"
               onerror="this.replaceWith(Object.assign(document.createElement('span'),
                        {className:'indisponible', textContent:'Page ${index + 1} — ouvrir'}))">
          <span class="numero">Page ${index + 1}</span></a>`,
      )
      .join("")}</div>`;
}

/**
 * Résout l'adresse pleine résolution de chaque page.
 * Type B : elle est déjà connue, rien à faire. Type A : un aller-retour par
 * page, en série pour ménager leur serveur.
 */
async function adressesPleines(circulaire, surProgres = () => {}) {
  const urls = [];
  for (let i = 0; i < circulaire.pages.length; i++) {
    surProgres(i + 1, circulaire.pages.length);
    const url = await circulairesCom.imagePleine(circulaire.pages[i]);
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Gestion de la clé. Elle ne quitte jamais cet appareil : la page est publique,
 * une clé écrite dans le code serait lisible par tout le monde.
 */
$("#btn-cc-cle").addEventListener("click", () => {
  const actuelle = extractionIA.cleStockee();
  const saisie = prompt(
    "Clé Anthropic pour l'extraction automatique.\n\n" +
    "Elle reste dans ce navigateur, sur cet appareil. Laissez vide pour l'effacer " +
    "et passer par votre session Claude Code (sans frais).",
    actuelle,
  );
  if (saisie === null) return;
  extractionIA.enregistrerCle(saisie);
  avisEphemere("cle", saisie.trim()
    ? "Clé enregistrée sur cet appareil."
    : "Clé effacée. L'extraction passera par l'ordre à coller dans le terminal.", "ok");
});

$("#cc-region").addEventListener("change", () => {
  $("#cc-resultat").innerHTML = "";
  circulaireCourante = null;
  rendreChoixEpiceries();
});

$("#btn-cc-chercher").addEventListener("click", async () => {
  const bouton = $("#btn-cc-chercher");
  const choisi = $("#cc-epicerie").selectedOptions[0];
  const slug = $("#cc-epicerie").value;
  if (!slug) return;
  bouton.disabled = true;
  bouton.textContent = "Recherche…";
  retirerAvis("circulaires-com");
  try {
    const circulaire = await circulairesCom.chercherCirculaire(slug, {
      region: $("#cc-region").value,
      nom: choisi ? choisi.dataset.nom : slug,
    });
    circulaireCourante = circulaire;
    rendreCirculaireTrouvee(circulaire);
    // Ce qu'on a récolté sert tout de suite : les champs d'import sont remplis,
    // il ne reste qu'à saisir les aubaines en regardant les pages.
    $("#import-epicerie").value = circulaire.epicerie;
    if (circulaire.validite) {
      $("#import-debut").value = circulaire.validite.debut;
      $("#import-fin").value = circulaire.validite.fin;
    }
    $("#texte-circulaire").focus();
  } catch (e) {
    avis(
      "circulaires-com",
      e instanceof circulairesCom.ErreurCirculaire
        ? e.message
        : `Impossible de joindre circulaires.com : ${e.message}`,
      "err",
    );
  } finally {
    bouton.disabled = false;
    bouton.textContent = "Chercher la circulaire";
  }
});

/* ==================== L'éclair : lancer sur BG001 ====================
 *
 * Même mécanisme que le tableau de bord marketing. La page n'exécute rien :
 * elle DÉPOSE UNE DEMANDE dans Firestore (un document « lancement-* » à côté
 * de « state »), et le lanceur de BG001 la ramasse, fait lire les pages par
 * Claude, puis réécrit le résultat dans le même document. La page le regarde
 * arriver et importe les aubaines toute seule.
 *
 * POURQUOI CETTE VOIE PLUTÔT QUE LA CLÉ. Rien n'est facturé : c'est
 * l'abonnement de la machine qui travaille. En échange, il faut que BG001 soit
 * allumé — ce qui est déjà le cas quand vous préparez vos repas à la maison.
 *
 * CE QUE LA PAGE N'ENVOIE PAS. Aucune consigne d'exécution. Le document ne
 * porte que des données : l'épicerie, les dates, les adresses des pages. Ce
 * que la machine s'autorise à faire est écrit dans le lanceur, pas ici — une
 * page web ne doit pas pouvoir redéfinir le cadre de travail de l'agent.
 */

function ecouterLancements() {
  if (arretEcouteLancements) arretEcouteLancements();
  if (!utilisateur) return;
  // « state » n'a pas de champ `statut` : le filtre l'écarte de lui-même.
  const file = query(
    collection(db, "users", utilisateur.uid, "bgfoods"),
    where("outil", "==", "BGFoods"),
  );
  arretEcouteLancements = onSnapshot(file, (instantane) => {
    instantane.forEach((document) => {
      const l = { id: document.id, ...document.data() };
      const avant = lancementsVus.get(l.id);
      lancementsVus.set(l.id, l);
      rendreEtatLancement(l);
      // On importe une fois, et une seule. Deux gardes, pour deux oublis
      // différents : `avant` couvre les instantanés répétés d'une même session
      // (Firestore renvoie tout le lot à chaque changement), et le drapeau
      // `recolte` écrit dans le document couvre le RECHARGEMENT de la page —
      // sans lui, chaque ouverture réimporterait les demandes terminées, que
      // le lanceur conserve trente jours.
      if (l.statut === "fait" && !l.recolte && (!avant || avant.statut !== "fait")) {
        recolterLancement(l);
      }
    });
  }, (e) => avis("lancement", `File de lancement illisible : ${e.message}`, "err"));
}

/**
 * Écrit la demande dans Firestore. Deux appelants : l'éclair (une circulaire
 * affichée) et la veille (les circulaires parues depuis la dernière visite).
 * Le document ne porte que des données — voir l'entête de section.
 */
async function deposerLancement(circulaire, urls) {
  const validite = circulaire.validite || {};
  const nom = `lancement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await setDoc(doc(db, "users", utilisateur.uid, "bgfoods", nom), {
    outil: "BGFoods",
    statut: "demande",
    slug: circulaire.slug,
    epicerie: circulaire.epicerie,
    debut: validite.debut || "",
    fin: validite.fin || "",
    titre: `Lire les ${urls.length} pages de la circulaire ${circulaire.epicerie}`
      + (validite.debut ? ` (valide du ${validite.debut} au ${validite.fin})` : ""),
    detail: urls.join("\n"),
    demandeLe: Date.now(),
    maj: Date.now(),
  });
}

/** Demande à BG001 de lire la circulaire affichée. */
async function lancerSurBG001() {
  if (!circulaireCourante || !utilisateur) return;
  const bouton = $("#btn-cc-eclair");
  const progres = $("#cc-progres");

  const enCours = [...lancementsVus.values()].find(
    (l) => l.slug === circulaireCourante.slug && (l.statut === "demande" || l.statut === "en_cours"),
  );
  if (enCours) {
    if (!confirm(`Annuler le lancement en cours pour ${circulaireCourante.epicerie} ?`)) return;
    return setDoc(doc(db, "users", utilisateur.uid, "bgfoods", enCours.id),
      { statut: "annule", maj: Date.now() }, { merge: true })
      .catch((e) => avis("lancement", `Annulation refusée : ${e.message}`, "err"));
  }

  bouton.disabled = true;
  retirerAvis("lancement");
  try {
    progres.textContent = "Résolution des adresses d'images…";
    const urls = await adressesPleines(circulaireCourante, (i, n) => {
      progres.textContent = `Résolution des adresses — page ${i} sur ${n}…`;
    });
    if (!urls.length) throw new Error("aucune adresse d'image n'a pu être résolue");

    await deposerLancement(circulaireCourante, urls);
    progres.textContent = "";
    avis("lancement",
      `Demandé à BG001 : ${urls.length} pages de ${circulaireCourante.epicerie}. `
      + "Les aubaines s'importeront ici toutes seules.", "ok");
  } catch (e) {
    progres.textContent = "";
    avis("lancement", `Lancement impossible : ${e.message}`, "err");
  } finally {
    bouton.disabled = false;
  }
}

/** Note dans le document qu'on a déjà pris ses aubaines. */
function marquerRecolte(l) {
  const copie = lancementsVus.get(l.id);
  if (copie) copie.recolte = true;
  if (!utilisateur) return;
  setDoc(doc(db, "users", utilisateur.uid, "bgfoods", l.id),
    { recolte: true, maj: Date.now() }, { merge: true })
    .catch(() => { /* la garde en mémoire tient le temps de la session */ });
}

const LIB_LANCEMENT = {
  demande: "⚡ demandé à BG001", en_cours: "⚡ BG001 lit les pages…",
  fait: "⚡ lu par BG001", echec: "⚡ échec sur BG001", annule: "⚡ annulé",
};

function rendreEtatLancement(l) {
  const zone = $("#cc-lancement");
  if (!zone || !circulaireCourante || l.slug !== circulaireCourante.slug) return;
  const quand = l.finiLe || l.debuteLe || l.demandeLe;
  // Deux pièges d'affichage, corrigés ici :
  //   « 10 h 21 min 00 s » se lisait comme une DURÉE alors que c'est l'heure ;
  //   « 2,28 $ US » se lisait comme une FACTURE alors que claude ne fait que
  //   chiffrer les jetons consommés — sur BG001 il travaille sous abonnement,
  //   sans facturation à l'unité.
  const heure = quand
    ? new Date(quand).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })
    : "";
  zone.innerHTML = `<span class="small muted">${echapper(LIB_LANCEMENT[l.statut] || l.statut)}`
    + (heure ? ` · à ${echapper(heure)}` : "")
    + (typeof l.coutUsd === "number"
      ? ` · <span title="Valeur des jetons consommés, telle que rapportée par claude. `
        + `BG001 travaille sous abonnement : ce n'est pas une facture.">`
        + `≈ ${echapper(l.coutUsd.toFixed(2).replace(".", ","))} $ US de jetons</span>`
      : "")
    + "</span>"
    + (l.erreur ? `<div class="banner err">${echapper(l.erreur)}</div>` : "");
}

/**
 * Le résultat est du texte : on le passe par l'analyseur habituel, comme une
 * saisie à la main. Rien n'entre dans les données sans avoir été lu par lui.
 */
function recolterLancement(l) {
  // Marqué AVANT l'import : si l'écriture échoue, on préfère ne pas importer
  // plutôt qu'importer sans pouvoir s'en souvenir.
  marquerRecolte(l);
  const texte = (l.resultat || "").trim();
  if (!texte) {
    avis("lancement", `BG001 a fini pour ${l.epicerie} sans reconnaître d'aubaine.`, "warn");
    return;
  }
  importerPages([texte], {
    epicerie: l.epicerie || "",
    slug: l.slug || "",
    debut: l.debut || "",
    fin: l.fin || "",
    source: `BG001 — ${l.epicerie || "circulaire"}`,
  });
  avisEphemere("lancement", `Aubaines de ${l.epicerie} importées depuis BG001.`, "ok", 8000);
}

/* ==================== Veille : la circulaire de la semaine ====================
 *
 * LE MANQUE QUE ÇA COMBLE. Les aubaines cessent d'exister à la date de fin de
 * leur circulaire — c'est juste, un rabais expiré n'est pas un rabais. Mais
 * l'outil s'arrêtait là : la circulaire suivante, que circulaires.com publie
 * pourtant dès qu'elle est disponible, n'arrivait que si on repassait à la
 * main par « Chercher la circulaire », épicerie par épicerie. Une semaine sur
 * deux, l'outil s'ouvrait donc vide.
 *
 * CE QUI EST AUTOMATIQUE, ET CE QUI NE L'EST PAS. Le CONSTAT est automatique :
 * à l'ouverture, pour chaque épicerie déjà suivie, on lit les dates de sa
 * circulaire courante et on les compare à la dernière connue. La LECTURE des
 * pages, elle, reste un clic : elle occupe BG001 plusieurs minutes et fait
 * entrer des centaines d'aubaines. Ouvrir la page au magasin, sur le
 * téléphone, ne doit pas déclencher tout ça sans qu'on l'ait demandé.
 *
 * SOBRIÉTÉ. Le constat ne charge pas les pages : deux ou trois requêtes par
 * épicerie, sur les seules bannières déjà importées, une fois par ouverture.
 */


/**
 * Les épiceries déjà suivies, avec la dernière circulaire connue de chacune.
 * On repart de ce qui a été importé : suivre tout l'annuaire interrogerait
 * trente bannières dont on n'a jamais rien voulu.
 */
function epiceriesSuivies() {
  const parEpicerie = new Map();
  for (const c of etat.circulaires) {
    const nom = (c.epicerie || "").trim();
    if (!nom) continue;
    // Objet neuf : on ne touche pas aux enregistrements de l'état.
    const suivi = parEpicerie.get(nom) || { epicerie: nom, slug: "", fin: "" };
    if (c.slug) suivi.slug = c.slug;
    if ((c.fin || "") > suivi.fin) suivi.fin = c.fin || "";
    parEpicerie.set(nom, suivi);
  }
  return [...parEpicerie.values()].sort((a, b) => a.epicerie.localeCompare(b.epicerie, "fr"));
}

/**
 * Retrouve l'identifiant circulaires.com des épiceries importées avant que
 * l'outil ne l'enregistre (ou saisies à la main). Une seule requête pour
 * toutes, et seulement si au moins une en a besoin.
 */
async function resoudreSlugs(suivis, region) {
  if (suivis.every((s) => s.slug)) return;
  const annuaire = await circulairesCom.chercherEpiceries({ region });
  const parNom = new Map(annuaire.map((e) => [nomNormalise(e.nom), e.slug]));
  for (const suivi of suivis) {
    if (!suivi.slug) suivi.slug = parNom.get(nomNormalise(suivi.epicerie)) || "";
  }
}

/** Une lecture est-elle déjà demandée pour cette circulaire-là ? */
function lancementEnCours(slug, fin) {
  return [...lancementsVus.values()].some(
    (l) => l.slug === slug && (l.statut === "demande" || l.statut === "en_cours")
      && (!fin || !l.fin || l.fin === fin),
  );
}

async function verifierNouvellesCirculaires(options = {}) {
  if (veille.statut === "verification" || veille.statut === "mise-a-jour") return;
  const suivis = epiceriesSuivies();
  if (!suivis.length) {
    veille.statut = "vide";
    veille.trouvailles = [];
    rendreVeille();
    return;
  }

  const region = ($("#cc-region") && $("#cc-region").value) || circulairesCom.REGION_DEFAUT;
  veille.statut = "verification";
  veille.progres = "";
  veille.note = "";
  rendreVeille();

  const trouvailles = [];
  const muettes = [];
  try {
    await resoudreSlugs(suivis, region);
  } catch (e) {
    // Annuaire injoignable : on continue avec les identifiants déjà connus
    // plutôt que d'abandonner la veille entière.
  }
  for (const suivi of suivis) {
    if (!suivi.slug) { muettes.push(suivi.epicerie); continue; }
    veille.progres = suivi.epicerie;
    rendreVeille();
    try {
      const trouve = await circulairesCom.chercherValidite(suivi.slug, { region });
      if (trouve && trouve.validite && trouve.validite.fin > suivi.fin) {
        trouvailles.push({ ...suivi, validite: trouve.validite, pages: trouve.pages, region });
      }
    } catch (e) {
      muettes.push(suivi.epicerie);
    }
  }

  veille.progres = "";
  veille.trouvailles = trouvailles;
  veille.statut = trouvailles.length ? "trouve" : "ajour";
  veille.note = muettes.length
    ? `${muettes.length} épicerie(s) n'ont pas répondu : ${muettes.join(", ")}.`
    : "";
  veille.ton = "";
  rendreVeille();

  retirerAvis("veille");
  if (trouvailles.length) {
    const banniere = avis(
      "veille",
      `${trouvailles.length} nouvelle(s) circulaire(s) chez circulaires.com : `
      + trouvailles.map((t) => `${t.epicerie} (jusqu'au ${t.validite.fin})`).join(", ")
      + ".",
      "warn",
    );
    const bouton = document.createElement("button");
    bouton.className = "btn btn-ghost";
    bouton.type = "button";
    bouton.id = "btn-veille-voir";
    bouton.textContent = "Mettre à jour";
    bouton.addEventListener("click", () => ouvrirOnglet("circulaires"));
    banniere.append(" ", bouton);
  } else if (options.manuel) {
    avisEphemere("veille", "Aucune nouvelle circulaire : vos aubaines sont celles de la semaine.", "ok");
  }
}

/** Fait lire par BG001 les circulaires repérées par la veille. */
async function mettreAJourCirculaires(cibles) {
  if (!cibles.length || !utilisateur) return;
  veille.statut = "mise-a-jour";
  veille.note = "";
  rendreVeille();

  const deposees = [];
  const echecs = [];
  for (const cible of cibles) {
    if (lancementEnCours(cible.slug, cible.validite.fin)) { deposees.push(cible); continue; }
    veille.progres = `${cible.epicerie} — récupération des pages…`;
    rendreVeille();
    try {
      const circulaire = await circulairesCom.chercherCirculaire(cible.slug, {
        region: cible.region, nom: cible.epicerie,
      });
      const urls = await adressesPleines(circulaire, (i, n) => {
        veille.progres = `${cible.epicerie} — adresse de la page ${i} sur ${n}…`;
        rendreVeille();
      });
      if (!urls.length) throw new Error("aucune adresse d'image n'a pu être résolue");
      await deposerLancement(circulaire, urls);
      deposees.push(cible);
    } catch (e) {
      echecs.push(`${cible.epicerie} (${e.message})`);
    }
  }

  veille.progres = "";
  // Ce qui est parti chez BG001 sort de la liste : le résultat reviendra tout
  // seul par la file de lancement, il n'y a plus rien à demander pour ces
  // épiceries-là.
  veille.trouvailles = veille.trouvailles.filter((t) => !deposees.includes(t));
  veille.statut = veille.trouvailles.length ? "trouve" : "demande";
  veille.note = echecs.length ? `Échec pour ${echecs.join(", ")}.` : "";
  veille.ton = echecs.length ? "err" : "";
  rendreVeille();
  retirerAvis("veille");
  if (deposees.length) {
    avis("lancement",
      `Demandé à BG001 : ${deposees.map((d) => d.epicerie).join(", ")}. `
      + "Les aubaines s'importeront ici toutes seules.", "ok");
  }
}

const LIB_VEILLE = {
  verification: "Vérification chez circulaires.com…",
  "mise-a-jour": "Envoi à BG001…",
  ajour: "Vos circulaires sont celles de la semaine — rien de neuf chez circulaires.com.",
  demande: "Demandé à BG001. Les aubaines arriveront d'elles-mêmes.",
  vide: "Aucune circulaire importée : la veille surveillera les épiceries dès la première.",
};

function rendreVeille() {
  const zone = $("#veille");
  if (!zone) return;
  const occupe = veille.statut === "verification" || veille.statut === "mise-a-jour";
  const liste = veille.trouvailles.length
    ? `<ul class="veille-liste">${veille.trouvailles
        .map((t) => `<li><strong>${echapper(t.epicerie)}</strong> — du
          ${echapper(t.validite.debut)} au ${echapper(t.validite.fin)},
          ${t.pages} page(s)</li>`)
        .join("")}</ul>`
    : "";

  zone.innerHTML = `<div class="card no-print">
    <h2>Circulaire de la semaine</h2>
    <p class="small muted">${veille.trouvailles.length
      ? `${veille.trouvailles.length} épicerie(s) ont publié une circulaire plus récente que
         celle que vous avez. La lecture des pages se fait sur BG001, sans frais.`
      : echapper(LIB_VEILLE[veille.statut] || "")}</p>
    ${liste}
    ${veille.progres ? `<p class="small muted">${echapper(veille.progres)}</p>` : ""}
    ${veille.note ? `<p class="small ${veille.ton === "err" ? "err" : "muted"}">${echapper(veille.note)}</p>` : ""}
    <div class="barre">
      ${veille.trouvailles.length
        ? `<button class="btn" id="btn-veille-tout"${occupe ? " disabled" : ""}>
             <svg class="ic-eclair" width="14" height="14" aria-hidden="true"><use href="#i-eclair"></use></svg>
             Mettre à jour (${veille.trouvailles.length})</button>`
        : ""}
      <button class="btn btn-ghost" id="btn-veille-verifier"${occupe ? " disabled" : ""}>Vérifier maintenant</button>
    </div>
  </div>`;
}

/* ---------- Envoyer la circulaire à l'extraction ---------- */

/**
 * Le bouton d'extraction. Avec une clé, l'IA lit les pages et les aubaines
 * arrivent seules. Sans clé, on ne bloque pas : on prépare l'ordre à coller
 * dans une session Claude Code, qui ne coûte rien de plus que l'abonnement.
 */
async function extraireCirculaireCourante() {
  if (!circulaireCourante) return;
  const bouton = $("#btn-cc-extraire");
  const progres = $("#cc-progres");
  const cle = extractionIA.cleStockee();

  if (!cle) {
    const garder = confirm(
      "Aucune clé Anthropic n'est enregistrée dans ce navigateur.\n\n" +
      "OK : entrer une clé maintenant (elle reste sur cet appareil, facturée par Anthropic).\n" +
      "Annuler : copier plutôt l'ordre à coller dans votre session Claude Code, sans frais.",
    );
    if (!garder) return copierOrdre();
    const saisie = prompt("Clé Anthropic (sk-ant-…) — stockée uniquement dans ce navigateur :");
    if (!saisie) return;
    extractionIA.enregistrerCle(saisie);
  }

  bouton.disabled = true;
  retirerAvis("extraction");
  try {
    progres.textContent = "Résolution des adresses d'images…";
    const urls = await adressesPleines(circulaireCourante, (i, n) => {
      progres.textContent = `Résolution des adresses — page ${i} sur ${n}…`;
    });
    if (!urls.length) throw new Error("aucune adresse d'image n'a pu être résolue");

    const cout = extractionIA.coutApproximatif(urls.length);
    if (!confirm(
      `${urls.length} pages vont être lues par ${extractionIA.MODELE_DEFAUT}.\n` +
      `Coût approximatif : ${cout.toFixed(2)} $ US, facturé par Anthropic.\n\nContinuer ?`,
    )) { progres.textContent = ""; return; }

    const { texte, echecs } = await extractionIA.lireCirculaire(urls, {
      surProgres: (p) => {
        progres.textContent = `Lecture page ${p.page} sur ${p.total}${
          p.etat === "lue" ? ` — ${p.lignes} ligne(s)` : p.etat === "échec" ? " — échec" : "…"}`;
      },
    });

    if (!texte.trim()) {
      avis("extraction", "L'IA n'a reconnu aucune aubaine sur ces pages.", "warn");
      progres.textContent = "";
      return;
    }
    // On passe par l'analyseur habituel : même lecture des prix que pour une
    // saisie à la main, donc mêmes prix unitaires et mêmes vérifications.
    importerPages([texte], {
      epicerie: circulaireCourante.epicerie,
      slug: circulaireCourante.slug,
      debut: circulaireCourante.validite ? circulaireCourante.validite.debut : "",
      fin: circulaireCourante.validite ? circulaireCourante.validite.fin : "",
      source: `circulaires.com — ${circulaireCourante.epicerie}`,
    });
    progres.textContent = "";
    if (echecs.length) {
      avis("extraction", `${echecs.length} page(s) n'ont pas pu être lues : ${echecs[0].raison}`, "warn");
    }
  } catch (e) {
    progres.textContent = "";
    avis("extraction", `Extraction interrompue : ${e.message}`, "err");
  } finally {
    bouton.disabled = false;
  }
}

/** Prépare l'ordre à coller dans une session Claude Code ouverte sur le poste. */
async function copierOrdre() {
  const progres = $("#cc-progres");
  try {
    progres.textContent = "Résolution des adresses d'images…";
    const urls = await adressesPleines(circulaireCourante, (i, n) => {
      progres.textContent = `Résolution des adresses — page ${i} sur ${n}…`;
    });
    const ordre = extractionIA.ordrePourTerminal(circulaireCourante, urls);
    await navigator.clipboard.writeText(ordre);
    progres.textContent = "";
    avis("extraction",
      `Ordre copié pour ${urls.length} page(s). Collez-le dans votre session Claude Code, ` +
      "puis remettez les lignes obtenues dans « Coller le texte ».", "ok");
  } catch (e) {
    progres.textContent = "";
    avis("extraction", `Copie impossible : ${e.message}`, "err");
  }
}

$("#veille").addEventListener("click", (evenement) => {
  if (evenement.target.closest("#btn-veille-tout")) {
    return mettreAJourCirculaires([...veille.trouvailles]);
  }
  if (evenement.target.closest("#btn-veille-verifier")) {
    return verifierNouvellesCirculaires({ manuel: true });
  }
});

$("#cc-resultat").addEventListener("click", async (evenement) => {
  if (evenement.target.closest("#btn-cc-eclair")) return lancerSurBG001();
  if (evenement.target.closest("#btn-cc-extraire")) return extraireCirculaireCourante();
  if (evenement.target.closest("#btn-cc-ordre")) return copierOrdre();

  const lien = evenement.target.closest("[data-page]");
  if (!lien) return;
  evenement.preventDefault();
  const page = (circulaireCourante || { pages: [] }).pages[Number(lien.dataset.page)];
  if (!page) return;
  // Type A : l'adresse pleine résolution demande un aller-retour de plus.
  // Type B : elle est déjà connue. Dans les deux cas on ouvre un onglet, où le
  // site sert l'image comme pour ses visiteurs.
  const secours = page.pleine || page.formulaire || page.apercu;
  try {
    const image = await circulairesCom.imagePleine(page);
    window.open(image || secours, "_blank", "noopener");
  } catch (e) {
    window.open(secours, "_blank", "noopener");
  }
});

/* ==================== Écran des circulaires ==================== */

function rendreCirculaires() {
  const contenant = $("#liste-circulaires");
  const circulaires = [...etat.circulaires].sort((a, b) => (b.fin || "").localeCompare(a.fin || ""));
  if (!circulaires.length) {
    contenant.innerHTML = '<p class="vide">Aucune circulaire importée pour l\'instant.</p>';
    return;
  }
  const today = aujourdHui();
  const lignes = circulaires
    .map((c) => {
      const aubaines = etat.aubaines.filter((a) => a.circulaireId === c.id);
      const validees = aubaines.filter((a) => a.validee).length;
      const expiree = (c.fin || "") < today;
      return `<tr${expiree ? ' class="muted"' : ""}>
        <td><strong>${echapper(c.epicerie)}</strong></td>
        <td class="small">${echapper(c.debut)} → ${echapper(c.fin)}
          ${expiree ? '<span class="etiquette">expirée</span>' : ""}</td>
        <td class="small">${validees}/${aubaines.length} validée(s)</td>
        <td class="small muted">${echapper(c.source || "—")}</td>
        <td class="nowrap">
          <button class="btn btn-ghost btn-mini" data-ouvrir="${c.id}">Corriger</button>
          <button class="btn btn-danger btn-mini" data-supprimer-circulaire="${c.id}">Supprimer</button>
        </td></tr>`;
    })
    .join("");
  contenant.innerHTML = `<div class="defilant"><table>
      <thead><tr><th>Épicerie</th><th>Validité</th><th>Aubaines</th><th>Source</th><th></th></tr></thead>
      <tbody>${lignes}</tbody></table></div>`;
}

function rendreCorrection() {
  const contenant = $("#correction");
  const circulaire = etat.circulaires.find((c) => c.id === circulaireOuverte);
  if (!circulaire) {
    contenant.innerHTML = "";
    return;
  }
  const aubaines = etat.aubaines
    .filter((a) => a.circulaireId === circulaire.id)
    .sort((a, b) => a.validee - b.validee || b.confiance - a.confiance);

  const optionsUnites = (choisie) =>
    ['<option value=""></option>']
      .concat(UNITES.map((u) => `<option value="${u}"${choisie === u ? " selected" : ""}>${u}</option>`))
      .join("");
  const optionsCategories = (choisie) =>
    ['<option value="">—</option>']
      .concat(
        CATEGORIES.map(
          (c) => `<option value="${echapper(c)}"${choisie === c ? " selected" : ""}>${echapper(c)}</option>`,
        ),
      )
      .join("");

  const lignes = aubaines
    .map(
      (a) => `<tr data-aubaine="${a.id}" class="${a.validee ? "validee" : a.confiance < 0.6 ? "doute" : ""}"
                  title="${echapper(a.texteBrut || "")}">
      <td><input type="checkbox" data-champ="validee"${a.validee ? " checked" : ""}></td>
      <td><input type="text" data-champ="nom" value="${echapper(a.nom)}" size="26"></td>
      <td><input type="text" data-champ="tailleValeur" value="${a.tailleValeur ?? ""}" size="4">
          <select data-champ="tailleUnite">${optionsUnites(a.tailleUnite)}</select></td>
      <td><input type="text" data-champ="prix" value="${a.prixCents ? (a.prixCents / 100).toFixed(2).replace(".", ",") : ""}" size="5"> $
          <input type="text" data-champ="regulier" value="${a.prixRegulierCents ? (a.prixRegulierCents / 100).toFixed(2).replace(".", ",") : ""}" size="5" placeholder="rég."></td>
      <td><select data-champ="typePrix">
            <option value="unite"${a.typePrix === "unite" ? " selected" : ""}>à l'unité</option>
            <option value="multiple"${a.typePrix === "multiple" ? " selected" : ""}>x pour y</option>
            <option value="poids"${a.typePrix === "poids" ? " selected" : ""}>au poids</option>
          </select>
          <input type="text" data-champ="multiQte" value="${a.multiQte ?? ""}" size="2" title="quantité du « 2 pour 5 $ »">
          <select data-champ="prixUnite">${optionsUnites(a.prixUnite)}</select></td>
      <td class="prix">${echapper(formatPrixUnitaire(a.prixParUnite, a.baseUnite))}</td>
      <td><select data-champ="categorie">${optionsCategories(a.categorie)}</select></td>
      <td class="muted small">${Math.round((a.confiance || 0) * 100)} %</td>
      <td><button class="btn btn-danger btn-mini" data-supprimer-aubaine="${a.id}">✕</button></td>
    </tr>`,
    )
    .join("");

  contenant.innerHTML = `<div class="card">
    <div class="epicerie-titre">
      <h2>${echapper(circulaire.epicerie)} — correction</h2>
      <span class="small muted">${aubaines.length} aubaine(s) · du ${echapper(circulaire.debut)} au ${echapper(circulaire.fin)}</span>
    </div>
    <p class="small muted">Chaque correction est enregistrée aussitôt et le prix unitaire
      est recalculé. Les lignes à faible confiance sont surlignées.</p>
    <div class="barre">
      <button class="btn btn-ghost" data-valider-tout="0.6">Valider celles au-dessus de 60 %</button>
      <button class="btn btn-ghost" data-valider-tout="0">Tout valider</button>
      <button class="btn btn-ghost" data-fermer-correction="1">Fermer</button>
    </div>
    ${aubaines.length
      ? `<div class="defilant"><table class="correction">
          <thead><tr><th>✓</th><th>Produit</th><th>Format</th><th>Prix / régulier</th>
            <th>Type</th><th>Prix unitaire</th><th>Catégorie</th><th>Conf.</th><th></th></tr></thead>
          <tbody>${lignes}</tbody></table></div>`
      : '<p class="vide">Aucune aubaine extraite de cette circulaire.</p>'}
  </div>`;
}

function versCents(valeur) {
  const propre = String(valeur ?? "").replace(/[$\s ]/g, "").replace(",", ".");
  if (!propre) return null;
  const nombre = parseFloat(propre);
  return Number.isFinite(nombre) ? Math.round(nombre * 100) : null;
}

function versNombreOuNul(valeur) {
  const propre = String(valeur ?? "").replace(",", ".").trim();
  if (!propre) return null;
  const nombre = parseFloat(propre);
  return Number.isFinite(nombre) ? nombre : null;
}

$("#vue-circulaires").addEventListener("change", (evenement) => {
  const champ = evenement.target.dataset.champ;
  const ligne = evenement.target.closest("[data-aubaine]");
  if (!champ || !ligne) return;

  const aubaine = etat.aubaines.find((a) => a.id === ligne.dataset.aubaine);
  if (!aubaine) return;

  const valeur = evenement.target.type === "checkbox" ? evenement.target.checked : evenement.target.value;
  const changements = {};
  if (champ === "prix") changements.prixCents = versCents(valeur);
  else if (champ === "regulier") changements.prixRegulierCents = versCents(valeur);
  else if (champ === "tailleValeur") changements.tailleValeur = versNombreOuNul(valeur);
  else if (champ === "multiQte") changements.multiQte = versNombreOuNul(valeur);
  else if (champ === "validee") changements.validee = valeur ? 1 : 0;
  else changements[champ] = valeur || null;

  const modifiee = optimiseur.recalculer({ ...aubaine, ...changements });
  etatMod.remplacer(etat, "aubaines", aubaine.id, modifiee);
  enregistrer();
});

$("#vue-circulaires").addEventListener("click", (evenement) => {
  const cible = evenement.target;

  if (cible.dataset.ouvrir) {
    circulaireOuverte = cible.dataset.ouvrir;
    rendre();
    $("#correction").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (cible.dataset.fermerCorrection) {
    circulaireOuverte = null;
    rendre();
    return;
  }
  if (cible.dataset.supprimerCirculaire) {
    if (!confirm("Supprimer cette circulaire et toutes ses aubaines ?")) return;
    if (circulaireOuverte === cible.dataset.supprimerCirculaire) circulaireOuverte = null;
    etatMod.supprimer(etat, "circulaires", cible.dataset.supprimerCirculaire);
    enregistrer();
    return;
  }
  if (cible.dataset.supprimerAubaine) {
    etatMod.supprimer(etat, "aubaines", cible.dataset.supprimerAubaine);
    enregistrer();
    return;
  }
  if (cible.dataset.validerTout !== undefined && cible.dataset.validerTout !== "") {
    const seuil = parseFloat(cible.dataset.validerTout);
    const maintenant = Date.now();
    let comptees = 0;
    for (const aubaine of etat.aubaines) {
      if (aubaine.circulaireId !== circulaireOuverte || aubaine.validee) continue;
      if ((aubaine.confiance || 0) < seuil) continue;
      etatMod.remplacer(etat, "aubaines", aubaine.id, { validee: 1 }, maintenant);
      comptees++;
    }
    etatMod.remplacer(etat, "circulaires", circulaireOuverte, { statut: "validee" }, maintenant);
    enregistrer();
    avisEphemere("validation", `${comptees} aubaine(s) validée(s).`);
  }
});

/* ==================== Écran des aubaines ==================== */

function filtresAubaines() {
  return {
    dateCible: $("#filtre-date").value || aujourdHui(),
    epiceries: $("#filtre-epicerie").value ? [$("#filtre-epicerie").value] : null,
    categorie: $("#filtre-categorie").value || null,
    recherche: $("#filtre-recherche").value.trim() || null,
    valideesSeulement: $("#filtre-validees").checked,
  };
}

function rendreAubaines() {
  const groupes = optimiseur.aubainesParEpicerie(etat, filtresAubaines());
  const contenant = $("#resultat-aubaines");
  if (!groupes.length) {
    contenant.innerHTML =
      '<div class="card"><p class="vide">Aucune aubaine ne correspond à ces filtres.</p></div>';
    return;
  }
  contenant.innerHTML = groupes
    .map(
      (groupe) => `<div class="card">
      <div class="epicerie-titre"><h2>${echapper(groupe.epicerie)}</h2>
        <span class="small muted">${groupe.nombre} aubaine(s)</span></div>
      ${groupe.categories
        .map(
          (categorie) => `<h3 class="small muted" style="margin-top:12px">${echapper(categorie.categorie)}</h3>
        <div class="defilant"><table>
          <thead><tr><th style="width:3rem" title="Ajouter au plan actif">Plan</th>
            <th>Produit</th><th>Format</th><th>Prix</th><th>Prix unitaire</th><th>Régulier</th></tr></thead>
          <tbody>${categorie.aubaines
            .map(
              (a) => `<tr>
              <td><input type="checkbox" data-au-plan="${echapper(a.id)}"
                ${dansLePlan(a) ? "checked" : ""}
                title="Ajouter cette aubaine au plan actif"></td>
              <td>${echapper(a.nom)}</td>
              <td class="small muted">${echapper(formatTaille(a.tailleValeur, a.tailleUnite))}</td>
              <td class="prix">${echapper(optimiseur.etiquettePrix(a))}</td>
              <td class="prix muted small">${echapper(formatPrixUnitaire(a.prixParUnite, a.baseUnite))}</td>
              <td class="prix muted small">${a.prixRegulierCents ? echapper(formatPrix(a.prixRegulierCents)) : ""}</td>
            </tr>`,
            )
            .join("")}</tbody></table></div>`,
        )
        .join("")}
    </div>`,
    )
    .join("");
}

["#filtre-date", "#filtre-epicerie", "#filtre-categorie", "#filtre-validees"].forEach((selecteur) =>
  $(selecteur).addEventListener("change", rendreAubaines),
);
$("#filtre-recherche").addEventListener("input", rendreAubaines);
$("#btn-imprimer-aubaines").addEventListener("click", () => window.print());

/* ==================== Écran de la liste ==================== */

function optionsListe() {
  return {
    nom: $("#liste-nom").value.trim() || "Liste d'épicerie",
    dateCible: $("#date-cible").value || aujourdHui(),
    maxEpiceries: parseInt($("#max-epiceries").value, 10) || null,
    valideesSeulement: $("#validees").checked,
  };
}

/**
 * Générer enregistre aussi la liste, sous son nom. C'est ce qui fait que les
 * cases cochées au magasin, sur le téléphone, sont celles de la liste
 * préparée à la maison.
 */
/* ==================== Plans d'épicerie ====================
 *
 * Un plan garde ce qu'on achète d'une semaine à l'autre; la liste, elle, est
 * le résultat figé d'un calcul. Un seul plan est actif, et c'est lui qui
 * alimente la génération — sinon deux sources de vérité se contrediraient.
 *
 * L'étoile n'est pas décorative : un article prioritaire pèse POIDS_PRIORITE
 * fois plus dans le choix des épiceries. Quand on se limite à deux magasins,
 * ce sont eux qui décident lesquels.
 */

function planActif() {
  return etat.plans.find((p) => p.actif) || null;
}

/**
 * Un article de plan pointe-t-il cette aubaine ?
 *
 * Le rapprochement se fait sur le NOM NORMALISÉ, pas sur l'identifiant de
 * l'aubaine. Un plan sert d'une semaine à l'autre, alors que les aubaines sont
 * réimportées et changent d'identifiant à chaque circulaire : lier par id
 * décrocherait toutes les cases le jeudi suivant. C'est aussi ce que fait
 * l'optimiseur, qui cherche les aubaines à partir du texte de l'article.
 */
function dansLePlan(aubaine) {
  const plan = planActif();
  if (!plan) return false;
  const cible = aubaine.nomNormalise || nomNormalise(aubaine.nom || "");
  return (plan.articles || []).some((a) => nomNormalise(a.requete || "") === cible);
}

/**
 * Plan qui recevra une aubaine cochée, quitte à le créer.
 *
 * SANS CETTE FONCTION, LA CASE ÉTAIT UNE IMPASSE. Elle exigeait un plan actif;
 * n'en trouvant pas, elle affichait un avis et se décochait — ce qui se vit
 * comme « je ne peux pas cocher ». Cocher une aubaine EST une façon de
 * commencer un plan : on en crée donc un plutôt que de refuser.
 *
 * Le plan créé ici part VIDE, à l'inverse de celui du bouton « Créer le plan »
 * qui se garnit des meilleurs spéciaux : ici vous choisissez vous-même, et
 * treize articles surgis d'un clic seraient une mauvaise surprise.
 */
function planPourRecevoir() {
  const actif = planActif();
  if (actif) return actif;

  // Un plan existe mais dort : on le réveille plutôt que d'en empiler un autre.
  const dernier = [...etat.plans].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (dernier) {
    etatMod.remplacer(etat, "plans", dernier.id, { actif: 1 });
    avisEphemere("plan-cree", `Plan « ${dernier.nom} » activé pour recevoir vos aubaines.`, "ok");
    return etat.plans.find((p) => p.id === dernier.id);
  }

  const cree = etatMod.ajouter(etat, "plans", {
    nom: "Mon plan",
    maxEpiceries: null,
    foyer: { adultes: 2, ados: 0, enfants: 0 },
    budgetCents: null,
    sansLaitDeVache: 0,
    articles: [],
    actif: 1,
  });
  avisEphemere("plan-cree", "Plan « Mon plan » créé : vos aubaines cochées s'y ajoutent. "
    + "Renommez-le et réglez foyer, budget et régime dans l'onglet Plans.", "ok", 9000);
  return cree;
}

/** Coche/décoche une aubaine dans le plan actif. */
function basculerAubaineDansPlan(idAubaine, coche) {
  const aubaine = etat.aubaines.find((a) => a.id === idAubaine);
  if (!aubaine) return;
  // Décocher ne doit jamais créer de plan : sans plan, il n'y a rien à retirer.
  const plan = coche ? planPourRecevoir() : planActif();
  if (!plan) return;
  const cible = aubaine.nomNormalise || nomNormalise(aubaine.nom || "");
  const articles = (plan.articles || []).filter(
    (a) => nomNormalise(a.requete || "") !== cible);
  if (coche) {
    // Le nom de l'aubaine devient la REQUÊTE de l'article : c'est ce que
    // l'optimiseur sait chercher, et ça reste valable la semaine prochaine
    // même si le prix ou l'épicerie change.
    articles.push({ requete: aubaine.nom, quantite: 1, note: null, priorite: false });
  }
  etatMod.remplacer(etat, "plans", plan.id, { articles });
  retirerAvis("plan");
  enregistrer();
}

/**
 * Barre d'action de l'onglet Aubaines : ce qui est coché, et de quoi lancer.
 *
 * Sans elle, on cochait des aubaines sans voir où elles allaient, puis il
 * fallait changer d'onglet pour générer. Le parcours « je coche ce qui
 * m'intéresse, je lance » se termine ici.
 */
function rendreBarrePlanAubaines() {
  const zone = $("#barre-plan-aubaines");
  if (!zone) return;
  const plan = planActif();
  if (!plan) {
    zone.innerHTML = '<p class="small muted">Cochez la colonne <strong>Plan</strong> '
      + "sur les aubaines qui vous intéressent : un plan se crée au premier clic.</p>";
    return;
  }
  const articles = plan.articles || [];
  const prio = articles.filter((a) => a.priorite).length;
  zone.innerHTML = `<div class="banner">
    <strong>${articles.length}</strong> article(s) dans « ${echapper(plan.nom)} »${
    prio ? `, dont ${prio} prioritaire(s)` : ""}.
    <button class="btn" id="btn-lancer-plan"${articles.length ? "" : " disabled"}>Lancer le plan</button>
    <button class="btn btn-ghost" id="btn-ouvrir-plan">Ajuster le plan</button>
    ${articles.length ? '<button class="btn btn-ghost" id="btn-vider-plan">Tout décocher</button>' : ""}
  </div>`;
}

$("#barre-plan-aubaines").addEventListener("click", (evenement) => {
  const plan = planActif();
  if (evenement.target.closest("#btn-ouvrir-plan")) return ouvrirOnglet("plans");

  if (evenement.target.closest("#btn-vider-plan")) {
    if (!plan || !confirm(`Retirer les ${(plan.articles || []).length} article(s) `
      + `du plan « ${plan.nom} » ?`)) return;
    etatMod.remplacer(etat, "plans", plan.id, { articles: [] });
    return enregistrer();
  }

  if (evenement.target.closest("#btn-lancer-plan")) {
    // Générer PUIS montrer le résultat : arriver sur un onglet vide donnerait
    // l'impression que le bouton n'a rien fait.
    genererListe();
    ouvrirOnglet("liste");
  }
});

$("#resultat-aubaines").addEventListener("change", (evenement) => {
  const case_ = evenement.target.closest("[data-au-plan]");
  if (!case_) return;
  basculerAubaineDansPlan(case_.dataset.auPlan, case_.checked);
});

function rendrePlans() {
  const contenant = $("#liste-plans");
  if (!contenant) return;
  const plans = [...etat.plans].sort((a, b) => (b.actif ? 1 : 0) - (a.actif ? 1 : 0)
    || (a.nom || "").localeCompare(b.nom || "", "fr"));
  if (!plans.length) {
    contenant.innerHTML = '<div class="card"><p class="vide">Aucun plan. '
      + "Créez-en un ci-dessus : « Semaine type », par exemple.</p></div>";
    return;
  }
  // Aubaines en vigueur aujourd'hui : le plan indique lesquels de ses articles
  // sont en rabais cette semaine, sinon il faudrait naviguer pour le savoir.
  const enVigueur = optimiseur.aubainesActives(etat, aujourdHui());
  const meilleurePour = (requete) => {
    const candidats = optimiseur.trouverCandidats(enVigueur, requete);
    return candidats.length ? candidats[0] : null;
  };

  contenant.innerHTML = plans.map((plan) => {
    const articles = plan.articles || [];
    const prioritaires = articles.filter((a) => a.priorite).length;
    const foyer = plan.foyer || {};
    const parts = optimiseur.partsFoyer(foyer);
    const facteur = optimiseur.facteurFoyer(foyer);
    return `<div class="card${plan.actif ? " plan-actif" : ""}" data-plan="${echapper(plan.id)}">
      <div class="barre">
        <h2 style="flex:1">${echapper(plan.nom || "Plan")}${plan.actif
          ? ' <span class="etiquette-actif">actif</span>' : ""}</h2>
        <button class="btn ${plan.actif ? "btn-ghost" : ""}" data-activer>${
          plan.actif ? "Désactiver" : "Activer"}</button>
        <button class="btn btn-ghost" data-supprimer-plan>Supprimer</button>
      </div>
      <p class="small muted">${articles.length} article(s), dont ${prioritaires} prioritaire(s).
        ${plan.maxEpiceries ? `Maximum ${plan.maxEpiceries} épicerie(s).` : "Sans limite d'épiceries."}</p>
      <div class="champs">
        <div><label>Adultes</label>
          <input type="number" min="0" max="20" data-foyer="adultes" value="${Number(foyer.adultes) || 0}"></div>
        <div><label>Ados</label>
          <input type="number" min="0" max="20" data-foyer="ados" value="${Number(foyer.ados) || 0}"></div>
        <div><label>Enfants</label>
          <input type="number" min="0" max="20" data-foyer="enfants" value="${Number(foyer.enfants) || 0}"></div>
        <div><label>Budget ($)</label>
          <input type="number" min="0" step="5" data-budget
            value="${plan.budgetCents ? (plan.budgetCents / 100).toFixed(2) : ""}"
            placeholder="sans limite"></div>
        <div><label>Régime</label>
          <label class="case"><input type="checkbox" data-sans-lait
            ${plan.sansLaitDeVache ? "checked" : ""}>
            sans lait de vache (fromage permis)</label></div>
        <div><label>Quantités</label>
          <p class="small muted" style="margin:6px 0 0">${formatNombre(parts)} part(s) —
            × ${formatNombre(facteur)}</p></div>
      </div>
      <table class="deals">
        <thead><tr><th style="width:3rem">Prio</th><th>Article</th>
          <th style="width:4rem">Qté</th><th>En aubaine cette semaine</th>
          <th style="width:3rem"></th></tr></thead>
        <tbody>${articles.map((a, i) => {
          const offre = meilleurePour(a.requete);
          return `<tr>
          <td><button class="etoile${a.priorite ? " on" : ""}" data-priorite="${i}"
            title="${a.priorite ? "Retirer la priorité" : "Marquer prioritaire"}"
            aria-pressed="${a.priorite ? "true" : "false"}">★</button></td>
          <td>${echapper(a.requete)}${a.note ? ` <span class="small muted">(${echapper(a.note)})</span>` : ""}</td>
          <td>${optimiseur.quantiteAjustee(a.quantite, foyer)}${
            optimiseur.quantiteAjustee(a.quantite, foyer) !== (a.quantite || 1)
              ? ` <span class="small muted">(${a.quantite || 1} × ${formatNombre(facteur)})</span>` : ""}</td>
          <td class="small">${offre
            ? `${echapper(offre.epicerie)} — <span class="prix">${echapper(optimiseur.etiquettePrix(offre))}</span>`
            : '<span class="muted">à prix courant</span>'}</td>
          <td><button class="ic" data-retirer="${i}" title="Retirer">✕</button></td>
        </tr>`;
        }).join("")}</tbody>
      </table>
      <div class="barre">
        <input type="text" data-nouvel-article style="flex:1"
          placeholder="2 poitrines de poulet (bio)  —  quantité au début, note entre parenthèses">
        <button class="btn" data-ajouter>Ajouter</button>
      </div>
    </div>`;
  }).join("");
}

$("#btn-creer-plan").addEventListener("click", () => {
  const nom = $("#plan-nom").value.trim();
  if (!nom) return avisEphemere("plan", "Donnez un nom au plan.", "warn");
  const max = parseInt($("#plan-max").value, 10);
  const foyer = {
    adultes: parseInt($("#plan-adultes").value, 10) || 0,
    ados: parseInt($("#plan-ados").value, 10) || 0,
    enfants: parseInt($("#plan-enfants").value, 10) || 0,
  };
  // Le budget est saisi en dollars et rangé en cents, comme tous les montants
  // de l'outil : mélanger les deux unités finit toujours par coûter un facteur
  // cent quelque part.
  const budget = parseFloat(String($("#plan-budget").value).replace(",", "."));
  const budgetCents = Number.isFinite(budget) && budget > 0 ? Math.round(budget * 100) : null;

  const sansLaitDeVache = $("#plan-sans-lait").checked;

  // Rien de choisi : on propose un panier bâti sur les rabais en cours plutôt
  // qu'un plan vide, qui n'apprendrait rien et qu'il faudrait remplir à la main.
  const articles = optimiseur.meilleursSpeciaux(etat, {
    dateCible: aujourdHui(), foyer, sansLaitDeVache,
  });

  etatMod.ajouter(etat, "plans", {
    nom,
    maxEpiceries: Number.isFinite(max) && max > 0 ? max : null,
    foyer,
    budgetCents,
    sansLaitDeVache: sansLaitDeVache ? 1 : 0,
    articles,
    actif: etat.plans.length ? 0 : 1,   // le premier plan créé sert tout de suite
  });
  $("#plan-nom").value = "";
  $("#plan-max").value = "";
  enregistrer();
  avisEphemere("plan", articles.length
    ? `Plan « ${nom} » créé avec ${articles.length} article(s) tirés des spéciaux — `
      + "retirez ce qui ne vous sert pas."
    : `Plan « ${nom} » créé. Aucune aubaine en cours : ajoutez vos articles à la main.`,
    "ok", 9000);
});

// Le foyer se modifie à même la carte : changer « 2 adultes » en « 2 adultes,
// 3 ados » doit se voir tout de suite sur les quantités, sans recréer le plan.
$("#liste-plans").addEventListener("change", (evenement) => {
  const carte = evenement.target.closest("[data-plan]");
  if (!carte) return;
  const plan = etat.plans.find((p) => p.id === carte.dataset.plan);
  if (!plan) return;

  const champFoyer = evenement.target.closest("[data-foyer]");
  if (champFoyer) {
    const foyer = { ...(plan.foyer || {}) };
    foyer[champFoyer.dataset.foyer] = Math.max(0, parseInt(champFoyer.value, 10) || 0);
    etatMod.remplacer(etat, "plans", plan.id, { foyer });
    return enregistrer();
  }

  const caseSansLait = evenement.target.closest("[data-sans-lait]");
  if (caseSansLait) {
    etatMod.remplacer(etat, "plans", plan.id, { sansLaitDeVache: caseSansLait.checked ? 1 : 0 });
    return enregistrer();
  }

  const champBudget = evenement.target.closest("[data-budget]");
  if (champBudget) {
    const dollars = parseFloat(String(champBudget.value).replace(",", "."));
    etatMod.remplacer(etat, "plans", plan.id, {
      budgetCents: Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null,
    });
    return enregistrer();
  }
});

$("#liste-plans").addEventListener("click", (evenement) => {
  const carte = evenement.target.closest("[data-plan]");
  if (!carte) return;
  const plan = etat.plans.find((p) => p.id === carte.dataset.plan);
  if (!plan) return;
  const articles = [...(plan.articles || [])];

  if (evenement.target.closest("[data-activer]")) {
    const activer = !plan.actif;
    // Un seul actif : deux plans actifs, et on ne saurait plus lequel a servi.
    for (const autre of etat.plans) {
      if (autre.actif) etatMod.remplacer(etat, "plans", autre.id, { actif: 0 });
    }
    if (activer) etatMod.remplacer(etat, "plans", plan.id, { actif: 1 });
    return enregistrer();
  }

  if (evenement.target.closest("[data-supprimer-plan]")) {
    if (!confirm(`Supprimer le plan « ${plan.nom} » ?`)) return;
    etatMod.supprimer(etat, "plans", plan.id);
    return enregistrer();
  }

  const etoile = evenement.target.closest("[data-priorite]");
  if (etoile) {
    const i = Number(etoile.dataset.priorite);
    if (!articles[i]) return;
    articles[i] = { ...articles[i], priorite: !articles[i].priorite };
    etatMod.remplacer(etat, "plans", plan.id, { articles });
    return enregistrer();
  }

  const retrait = evenement.target.closest("[data-retirer]");
  if (retrait) {
    articles.splice(Number(retrait.dataset.retirer), 1);
    etatMod.remplacer(etat, "plans", plan.id, { articles });
    return enregistrer();
  }

  if (evenement.target.closest("[data-ajouter]")) {
    const champ = carte.querySelector("[data-nouvel-article]");
    // Même lecture que la zone de saisie : « 2 lait 2 % (bio) » s'y comprend.
    const nouveaux = optimiseur.analyserArticles(champ.value);
    if (!nouveaux.length) return avisEphemere("plan", "Écrivez un article à ajouter.", "warn");
    etatMod.remplacer(etat, "plans", plan.id, {
      articles: [...articles, ...nouveaux.map((a) => ({ ...a, priorite: false }))],
    });
    champ.value = "";
    return enregistrer();
  }
});

/* ==================== Génération de la liste ==================== */

function genererListe() {
  const options = optionsListe();
  const plan = planActif();
  // Le plan actif fait foi : sans cette règle, la zone de saisie et le plan se
  // contrediraient et on ne saurait pas lequel a produit la liste.
  // Les quantités d'un plan sont écrites pour deux adultes : c'est ici qu'on
  // les met à l'échelle du foyer, une seule fois, juste avant le calcul.
  const articles = plan
    ? (plan.articles || []).map((a) => ({
      ...a, quantite: optimiseur.quantiteAjustee(a.quantite, plan.foyer),
    }))
    : optimiseur.analyserArticles($("#articles").value);
  if (plan && plan.maxEpiceries && !options.maxEpiceries) {
    options.maxEpiceries = plan.maxEpiceries;
  }
  if (plan && plan.budgetCents) options.budgetCents = plan.budgetCents;
  if (plan && plan.sansLaitDeVache) options.sansLaitDeVache = true;
  if (plan) options.nom = options.nom || plan.nom;
  if (!articles.length) {
    avisEphemere("liste", plan
      ? `Le plan « ${plan.nom} » ne contient aucun article.`
      : "Écrivez d'abord ce dont vous avez besoin.", "warn");
    return;
  }

  const existante = etat.listes.find((l) => l.nom === options.nom);
  const donnees = {
    nom: options.nom,
    articles,
    dateCible: options.dateCible,
    maxEpiceries: options.maxEpiceries,
    valideesSeulement: options.valideesSeulement ? 1 : 0,
  };
  const liste = existante
    ? etatMod.remplacer(etat, "listes", existante.id, donnees)
    : etatMod.ajouter(etat, "listes", { ...donnees, coches: {} });

  resultatCourant = { ...optimiseur.optimiser(etat, articles, options), listeId: liste.id };
  enregistrer();
}

function rendreResultat() {
  const contenant = $("#resultat-liste");
  if (!resultatCourant) {
    contenant.innerHTML = "";
    return;
  }
  const liste = etat.listes.find((l) => l.id === resultatCourant.listeId);
  const coches = (liste && liste.coches) || {};
  const resultat = resultatCourant;

  const entete = `<div class="card">
    <div class="epicerie-titre">
      <h2>${echapper(resultat.nom)}</h2>
      <span class="small muted">Magasinage du ${echapper(resultat.dateCible)}</span>
    </div>
    <p class="small muted">${resultat.nbArticles} article(s) dans ${resultat.nbEpiceries} épicerie(s) ·
      total estimé <strong>${echapper(formatPrix(resultat.total))}</strong>
      ${resultat.economies ? `· économies estimées <strong class="gain">${echapper(formatPrix(resultat.economies))}</strong>` : ""}</p>
  </div>`;

  const groupes = resultat.groupes
    .map(
      (groupe) => `<div class="card">
      <div class="epicerie-titre"><h2>${echapper(groupe.epicerie)}</h2>
        <span class="prix">${echapper(formatPrix(groupe.total))}
          ${groupe.economies ? `<span class="gain small">économies ${echapper(formatPrix(groupe.economies))}</span>` : ""}</span></div>
      <div class="defilant"><table class="liste">
        <thead><tr><th></th><th>Article</th><th>Aubaine retenue</th><th>Format</th>
          <th>Prix</th><th>Prix unitaire</th><th>Sous-total</th></tr></thead>
        <tbody>${groupe.lignes
          .map((ligne) => {
            const cle = ligne.meilleure.id;
            const alternatives = ligne.alternatives.length
              ? `<div class="small muted no-print">aussi : ${ligne.alternatives
                  .map((alt) => `${echapper(alt.epicerie)} ${echapper(optimiseur.etiquettePrix(alt))}`)
                  .join(" · ")}</div>`
              : "";
            return `<tr>
              <td><input type="checkbox" data-coche="${echapper(cle)}"${coches[cle] ? " checked" : ""}></td>
              <td>${ligne.priorite ? '<span class="etoile on" title="Article prioritaire du plan">★</span> ' : ""}${echapper(ligne.requete)}${ligne.quantite > 1 ? ` <span class="etiquette">× ${ligne.quantite}</span>` : ""}
                ${ligne.note ? `<div class="small muted">${echapper(ligne.note)}</div>` : ""}</td>
              <td>${echapper(ligne.meilleure.nom)}${alternatives}</td>
              <td class="small muted">${echapper(optimiseur.etiquetteTaille(ligne.meilleure))}</td>
              <td class="prix">${echapper(optimiseur.etiquettePrix(ligne.meilleure))}</td>
              <td class="prix muted small">${echapper(formatPrixUnitaire(ligne.meilleure.prixParUnite, ligne.meilleure.baseUnite))}</td>
              <td class="prix">${echapper(formatPrix(ligne.cout))}</td>
            </tr>`;
          })
          .join("")}</tbody>
        <tfoot><tr><td colspan="6">Sous-total ${echapper(groupe.epicerie)}</td>
          <td class="prix">${echapper(formatPrix(groupe.total))}</td></tr></tfoot>
      </table></div>
    </div>`,
    )
    .join("");

  // Le budget : ce qu'on a mis de côté pour y rentrer, et l'aveu franc quand
  // les prioritaires seuls le dépassent.
  const budget = resultat.budgetCents
    ? `<div class="card">
        <h2>Budget</h2>
        <p>${echapper(formatPrix(resultat.total))} sur ${echapper(formatPrix(resultat.budgetCents))}
          — ${resultat.resteBudget >= 0
            ? `<strong>${echapper(formatPrix(resultat.resteBudget))} de marge</strong>`
            : `<strong>${echapper(formatPrix(-resultat.resteBudget))} de dépassement</strong>`}</p>
        ${resultat.budgetDepasse
          ? '<p class="banner warn">Les articles prioritaires dépassent à eux seuls le budget. '
            + "Rien n'a été retiré : retirez une étoile, augmentez le budget, ou assumez le dépassement.</p>"
          : ""}
        ${resultat.retiresBudget.length
          ? `<p class="small muted">Mis de côté pour rentrer dans le budget — ce qui coûtait
              le plus cher sans être une aubaine :</p>
            <ul class="small">${resultat.retiresBudget
              .map((l) => `<li>${echapper(l.requete)}${l.quantite > 1 ? ` × ${l.quantite}` : ""}
                — ${echapper(formatPrix(l.cout))} chez ${echapper(l.meilleure.epicerie)}</li>`)
              .join("")}</ul>`
          : '<p class="small muted">Rien n\'a eu besoin d\'être retiré.</p>'}
      </div>`
    : "";

  const orphelins = resultat.sansAubaine.length
    ? `<div class="card">
        <h2>Sans aubaine — prix courant</h2>
        <p class="small muted">Ces articles ne correspondent à aucune aubaine en vigueur.</p>
        ${resultat.sansAubaine
          .map(
            (ligne) => `<label class="case"><input type="checkbox" data-coche="hors:${echapper(ligne.requete)}"
              ${coches[`hors:${ligne.requete}`] ? " checked" : ""}>
              ${echapper(ligne.requete)}${ligne.quantite > 1 ? ` × ${ligne.quantite}` : ""}</label>`,
          )
          .join("")}
      </div>`
    : "";

  contenant.innerHTML = entete + budget + groupes + orphelins;
}

$("#resultat-liste").addEventListener("change", (evenement) => {
  const cle = evenement.target.dataset.coche;
  if (!cle || !resultatCourant) return;
  const liste = etat.listes.find((l) => l.id === resultatCourant.listeId);
  if (!liste) return;
  const coches = { ...(liste.coches || {}) };
  if (evenement.target.checked) coches[cle] = true;
  else delete coches[cle];
  etatMod.remplacer(etat, "listes", liste.id, { coches });
  enregistrer();
});

function rendreListesEnregistrees() {
  const contenant = $("#listes-enregistrees");
  const listes = [...etat.listes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $("#carte-listes-enregistrees").hidden = !listes.length;
  if (!listes.length) return;

  contenant.innerHTML = `<div class="defilant"><table>
    <tbody>${listes
      .map(
        (l) => `<tr>
        <td><strong>${echapper(l.nom)}</strong></td>
        <td class="small muted">${(l.articles || []).length} article(s)${l.dateCible ? ` · ${echapper(l.dateCible)}` : ""}</td>
        <td class="nowrap">
          <button class="btn btn-ghost btn-mini" data-charger-liste="${l.id}">Ouvrir</button>
          <button class="btn btn-danger btn-mini" data-supprimer-liste="${l.id}">Supprimer</button>
        </td></tr>`,
      )
      .join("")}</tbody></table></div>`;
}

$("#carte-listes-enregistrees").addEventListener("click", (evenement) => {
  const cible = evenement.target;
  if (cible.dataset.chargerListe) {
    const liste = etat.listes.find((l) => l.id === cible.dataset.chargerListe);
    if (!liste) return;
    $("#liste-nom").value = liste.nom;
    $("#articles").value = optimiseur.articlesVersTexte(liste.articles || []);
    $("#date-cible").value = liste.dateCible || aujourdHui();
    $("#max-epiceries").value = liste.maxEpiceries || "";
    $("#validees").checked = !!liste.valideesSeulement;
    genererListe();
    return;
  }
  if (cible.dataset.supprimerListe) {
    if (!confirm("Supprimer cette liste ?")) return;
    if (resultatCourant && resultatCourant.listeId === cible.dataset.supprimerListe) resultatCourant = null;
    etatMod.supprimer(etat, "listes", cible.dataset.supprimerListe);
    enregistrer();
  }
});

$("#btn-generer").addEventListener("click", genererListe);

// Le bandeau est reconstruit à chaque rendu : on écoute le conteneur, pas le
// bouton, qui n'existe plus après le rendu suivant.
$("#bandeau-plan").addEventListener("click", (evenement) => {
  if (evenement.target.closest("#btn-voir-plan")) ouvrirOnglet("plans");
});
$("#btn-imprimer").addEventListener("click", () => {
  if (!resultatCourant) genererListe();
  if (resultatCourant) window.print();
});

/* ==================== Rendu global ==================== */

function rendreSelecteurs() {
  const epiceries = [...new Set(etat.circulaires.map((c) => c.epicerie))].sort();

  const selecteur = $("#filtre-epicerie");
  const choisie = selecteur.value;
  selecteur.innerHTML =
    '<option value="">toutes</option>' +
    epiceries.map((e) => `<option value="${echapper(e)}">${echapper(e)}</option>`).join("");
  selecteur.value = epiceries.includes(choisie) ? choisie : "";

  const categories = $("#filtre-categorie");
  if (categories.options.length <= 1) {
    categories.innerHTML =
      '<option value="">toutes</option>' +
      CATEGORIES.concat("Autres")
        .map((c) => `<option value="${echapper(c)}">${echapper(c)}</option>`)
        .join("");
  }

  $("#liste-epiceries").innerHTML = epiceries
    .concat(analyseur.EPICERIES_CONNUES)
    .filter((e, i, tous) => tous.indexOf(e) === i)
    .map((e) => `<option value="${echapper(e)}">`)
    .join("");
}

function rendre() {
  if (!utilisateur) return;
  rendreChoixEpiceries();
  rendreSelecteurs();
  rendreCirculaires();
  rendreVeille();
  rendreCorrection();
  rendreAubaines();
  rendrePlans();
  rendreBandeauPlan();
  rendreBarrePlanAubaines();
  rendreListesEnregistrees();
  rendreResultat();
}

/**
 * Dit dans l'onglet Liste quel plan alimente la génération. Sans ça, la zone
 * de saisie resterait visible tout en étant ignorée : on croirait à un bogue.
 */
function rendreBandeauPlan() {
  const zone = $("#bandeau-plan");
  if (!zone) return;
  const plan = planActif();
  if (!plan) {
    zone.innerHTML = "";
    $("#articles").disabled = false;
    return;
  }
  const articles = plan.articles || [];
  const prio = articles.filter((a) => a.priorite).length;
  zone.innerHTML = `<p class="banner">Le plan <strong>${echapper(plan.nom)}</strong> est actif :
    la liste se génère à partir de ses ${articles.length} article(s)${
    prio ? `, dont ${prio} prioritaire(s)` : ""} — la zone ci-dessous est ignorée.
    <button class="btn btn-ghost" id="btn-voir-plan">Modifier le plan</button></p>`;
  $("#articles").disabled = true;
}

/* ==================== Démarrage ==================== */

$("#date-cible").value = aujourdHui();
$("#filtre-date").value = aujourdHui();

// Exposé pour le banc d'essai en navigateur, qui vérifie le rendu sans Firebase.
window.bgfoods = {
  get etat() {
    return etat;
  },
  set etat(nouveau) {
    etat = etatMod.normaliserEtat(nouveau);
    rendre();
  },
  genererListe,
  rendre,
  formatPrix,
  formatNombre,
  // Le résultat courant n'est pas dans l'état : le banc en a besoin pour
  // vérifier que c'est bien le plan actif qui a produit la liste.
  resultat: () => resultatCourant,
  planActif,
};
