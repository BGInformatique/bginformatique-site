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

/* ==================== Utilitaires d'écran ==================== */

const $ = (selecteur) => document.querySelector(selecteur);
const $$ = (selecteur) => [...document.querySelectorAll(selecteur)];

function echapper(valeur) {
  return String(valeur ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function aujourdHui() {
  return new Date().toISOString().slice(0, 10);
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
    rendre();
  } else if (arretEcoute) {
    arretEcoute();
    arretEcoute = null;
  }
});

/* ==================== Onglets ==================== */

$$(".tab").forEach((onglet) => {
  onglet.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === onglet)));
    for (const vue of ["liste", "aubaines", "circulaires"]) {
      $(`#vue-${vue}`).hidden = vue !== onglet.dataset.onglet;
    }
  });
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
    { epicerie, debut, fin, source: options.source || "", pages: pages.length, statut: "brouillon" },
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
      <button class="btn" id="btn-cc-extraire">Extraire les aubaines de ces ${circulaire.pages.length} pages</button>
      <button class="btn btn-ghost" id="btn-cc-ordre">Copier l'ordre pour le terminal</button>
    </div>
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

$("#cc-resultat").addEventListener("click", async (evenement) => {
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
          <thead><tr><th>Produit</th><th>Format</th><th>Prix</th><th>Prix unitaire</th><th>Régulier</th></tr></thead>
          <tbody>${categorie.aubaines
            .map(
              (a) => `<tr>
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
function genererListe() {
  const options = optionsListe();
  const articles = optimiseur.analyserArticles($("#articles").value);
  if (!articles.length) {
    avisEphemere("liste", "Écrivez d'abord ce dont vous avez besoin.", "warn");
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
              <td>${echapper(ligne.requete)}${ligne.quantite > 1 ? ` <span class="etiquette">× ${ligne.quantite}</span>` : ""}
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

  contenant.innerHTML = entete + groupes + orphelins;
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
  rendreCorrection();
  rendreAubaines();
  rendreListesEnregistrees();
  rendreResultat();
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
};
