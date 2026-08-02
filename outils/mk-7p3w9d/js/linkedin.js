/*
 * Lot LinkedIn — page compagnon du tableau de bord marketing.
 *
 * Une seule page avec toutes les publications du lot courant : le texte se
 * copie d'un bouton, la case « Publié » suit l'avancement. Le contenu vit dans
 * Firestore (users/<uid>/marketing/linkedin-lot), derrière la connexion
 * Microsoft — jamais dans ce dépôt, qui est public.
 *
 * Quand une publication passe à « publié », le lanceur de BG001 consigne la
 * parution dans le journal TSV du mandat (statut lot_livre -> utilise) puis
 * marque ici « consigne: true ». La page n'écrit jamais ce champ à true.
 */

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
import {
  lireMandat, lireMandats, rendreSelecteur, surChangementDeMandat,
  mandatExterne, appartientAuMandat,
} from "./mandat.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const $ = (id) => document.getElementById(id);
const ech = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const maintenant = () => Date.now();

let lot = null;
let lotRef = null;

function avis(message, erreur) {
  const d = document.createElement("div");
  d.className = "banner" + (erreur ? " err" : "");
  d.textContent = message;
  $("banners").appendChild(d);
  setTimeout(() => d.remove(), 8000);
}

/* ═══════════════════════════  rendu  ═══════════════════════════════════ */

/*
 * Chaque mandat a son lot. Le document, lui, est écrit par le lanceur de BG001
 * — un processus qu'on ne voit pas d'ici et à qui on ne va pas imposer un
 * changement de format unilatéralement.
 *
 * On filtre donc à deux niveaux : le mandat porté par la publication si elle en
 * porte un (ce que le lanceur pourra ajouter quand il voudra), sinon
 * l'appartenance du document entier. Le jour où le lanceur écrit un `mandat`
 * par publication, le cloisonnement devient exact sans toucher à cette page.
 *
 * Publier au nom de la mauvaise entreprise est l'erreur la plus coûteuse que
 * cette page puisse causer : en cas de doute, on n'affiche pas.
 */
let mandat = lireMandat();
surChangementDeMandat((v) => { mandat = v; rendre(); });

function rendre() {
  rendreSelecteur("f-mandat", lireMandats(), mandat, (v) => { mandat = v; rendre(); });

  const proprietaire = (lot && lot.mandat) || mandatExterne();
  const tous = (lot && Array.isArray(lot.posts)) ? lot.posts : [];
  const posts = tous
    .filter((p) => p.mandat
      ? appartientAuMandat(mandat, p.mandat)
      : appartientAuMandat(mandat, proprietaire))
    .sort((a, b) => (a.n || 0) - (b.n || 0));

  // La section existe pour tous les mandats, même vide : une section qui
  // disparaît se cherche, et on finit par croire l'outil cassé.
  $("hors-mandat").hidden = posts.length > 0;
  $("app-lot").hidden = !posts.length;
  if (!posts.length) {
    $("hors-mandat").textContent = tous.length
      ? `Aucune publication pour ce mandat. Le lot en ligne en porte ${tous.length} ` +
        `pour « ${proprietaire || "un autre mandat"} ».`
      : "Aucun lot publié pour l'instant. Le lanceur de BG001 en dépose un quand il en produit.";
    return;
  }
  const faites = posts.filter((p) => p.statutPub === "publie").length;

  $("lot-titre").textContent = "// " + (lot.titre || "Lot LinkedIn");
  $("c-pub").textContent = `${faites} publiée${faites > 1 ? "s" : ""} sur ${posts.length}`;
  $("c-pub-j").classList.toggle("plein", faites >= posts.length);
  $("c-pub-j").firstElementChild.style.width =
    (posts.length ? (faites / posts.length) * 100 : 0) + "%";

  const cible = $("l-posts");
  cible.innerHTML = "";
  for (const p of posts) {
    const publie = p.statutPub === "publie";
    const el = document.createElement("div");
    el.className = "pub" + (publie ? " fait" : "");
    el.innerHTML = `
      <div class="pub-entete">
        <div class="pub-num">${p.n}</div>
        <div class="pub-sujet">
          <div class="titre-t">${ech(p.sujet)}</div>
          <div class="etiq">
            <span class="pil">${ech(p.pilier || "")}</span>
            <span class="pil">${ech(p.format || "")}</span>
            <span class="pil">${ech(p.code || "")}</span>
            ${publie && p.publieLe ? `<span class="pil fait">publié le ${ech(new Date(p.publieLe).toLocaleDateString("fr-CA"))}</span>` : ""}
            ${publie && p.consigne ? `<span class="pil temps">journal consigné ✓</span>` : ""}
            ${publie && !p.consigne ? `<span class="pil temps">consignation en attente…</span>` : ""}
          </div>
        </div>
        <div class="pub-boutons">
          <button class="btn" data-copier>Copier</button>
          <button class="btn ${publie ? "btn-ghost" : ""}" data-publier>${publie ? "Annuler « publié »" : "Marquer publié"}</button>
        </div>
      </div>
      <div class="pub-texte">${ech(p.texte)}</div>`;

    el.querySelector("[data-copier]").onclick = async (ev) => {
      const b = ev.currentTarget;
      try {
        await navigator.clipboard.writeText(p.texte);
        b.textContent = "Copié ✓";
        setTimeout(() => { b.textContent = "Copier"; }, 2000);
      } catch {
        avis("Copie refusée par le navigateur — sélectionner le texte à la main.", true);
      }
    };
    el.querySelector("[data-publier]").onclick = () => {
      if (publie && !confirm(`Annuler « publié » pour la publication ${p.n} ?`)) return;
      p.statutPub = publie ? "a_publier" : "publie";
      p.publieLe = publie ? 0 : maintenant();
      // Jamais true depuis la page : c'est le lanceur qui confirme le journal.
      p.consigne = false;
      p.maj = maintenant();
      enregistrer();
    };
    cible.appendChild(el);
  }
}

function enregistrer() {
  if (!lotRef || !lot) return;
  lot.updatedAt = maintenant();
  rendre();
  setDoc(lotRef, JSON.parse(JSON.stringify(lot)))
    .catch((e) => avis("Écriture refusée : " + e.message, true));
}

/* ═══════════════════════════  authentification  ════════════════════════ */

const provider = new OAuthProvider("microsoft.com");
provider.setCustomParameters({ tenant: MICROSOFT_TENANT_ID });

$("btn-login").addEventListener("click", () => {
  $("auth-error").hidden = true;
  signInWithPopup(auth, provider).catch((e) => {
    $("auth-error").textContent = "Connexion échouée : " + e.message;
    $("auth-error").hidden = false;
  });
});

$("btn-logout").addEventListener("click", () => signOut(auth));

let desabonner = null;

onAuthStateChanged(auth, (user) => {
  if (desabonner) { desabonner(); desabonner = null; }

  if (!user) {
    lot = null;
    lotRef = null;
    $("auth-gate").hidden = false;
    $("app").hidden = true;
    $("btn-logout").hidden = true;
    $("qui").hidden = true;
    return;
  }

  $("auth-gate").hidden = true;
  $("app").hidden = false;
  $("btn-logout").hidden = false;
  $("qui").hidden = false;
  $("qui").innerHTML = `<b>${ech(user.displayName || "Connecté")}</b>${ech(user.email || "")}`;

  lotRef = doc(db, "users", user.uid, "marketing", "linkedin-lot");
  desabonner = onSnapshot(lotRef, (snap) => {
    if (!snap.exists()) {
      $("l-posts").innerHTML = `<div class="vide">Aucun lot en ligne. Le lot se verse depuis BG001.</div>`;
      return;
    }
    lot = snap.data();
    rendre();
  }, (e) => avis("Lecture Firestore refusée : " + e.message, true));
});
