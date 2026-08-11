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

  const maintenant = Date.now();
  const circulaire = etatMod.ajouter(
    etat,
    "circulaires",
    { epicerie, debut, fin, source: options.source || "", pages: pages.length, statut: "brouillon" },
    maintenant,
  );

  const aubaines = analyseur.analyserPages(pages);
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
    aubaines.length ? "ok" : "warn",
    9000,
  );
  if (!aubaines.length) {
    avis(
      "import-vide",
      "Aucune aubaine n'a été reconnue. Le texte du PDF est peut-être disposé en " +
        "colonnes illisibles : collez-le à la main dans l'encadré prévu à cet effet.",
      "warn",
    );
  } else {
    retirerAvis("import-vide");
  }
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
