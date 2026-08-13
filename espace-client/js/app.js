/*
 * Espace client — BG Informatique
 * https://bginformatique.ca/espace-client/
 *
 * Le client se connecte avec le compte Microsoft auquel il a été invité
 * (invité B2B du locataire BG), écrit ses demandes et en suit l'avancement.
 *
 * CE QUE CETTE PAGE PEUT FAIRE, ET RIEN DE PLUS : créer une demande à son
 * nom, relire les siennes, annuler une demande encore intacte. Elle ne lit
 * jamais celles d'un autre client, ne change jamais un statut d'avancement,
 * ne connaît aucun dépôt ni aucun chemin de fichier. L'avancement est écrit
 * par BG001 (accès serveur), jamais par un navigateur — voir firestore.rules.
 *
 * Modèle de données : un document par demande, dans la collection racine
 * « demandes ». Pas de sous-collection sous users/ : le pont de BG001 doit
 * pouvoir lire l'ensemble des demandes en une requête, sans parcourir les
 * comptes un par un.
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
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  doc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, MICROSOFT_TENANT_ID, CONFIG_REMPLIE } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

const els = {
  installation: $("installation"),
  porte: $("porte"),
  app: $("app"),
  btnConnexion: $("btn-connexion"),
  btnSortie: $("btn-sortie"),
  erreurConnexion: $("erreur-connexion"),
  identite: $("identite"),
  identiteNom: $("identite-nom"),
  formulaire: $("formulaire"),
  btnEnvoyer: $("btn-envoyer"),
  avisEnvoi: $("avis-envoi"),
  avisErreur: $("avis-erreur"),
  liste: $("liste"),
};

/* Le projet Firebase n'existe pas encore : on le dit en français et on
   s'arrête là, plutôt que de laisser initializeApp lever une exception. */
if (!CONFIG_REMPLIE) {
  els.installation.hidden = false;
} else {
  demarrer();
}

function demarrer() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const provider = new OAuthProvider("microsoft.com");
  provider.setCustomParameters({ tenant: MICROSOFT_TENANT_ID });

  els.btnConnexion.addEventListener("click", () => {
    els.erreurConnexion.hidden = true;
    signInWithPopup(auth, provider).catch((e) => {
      els.erreurConnexion.textContent = messageConnexion(e);
      els.erreurConnexion.hidden = false;
    });
  });

  els.btnSortie.addEventListener("click", () => signOut(auth));

  let arreterEcoute = null;
  let utilisateur = null;

  onAuthStateChanged(auth, (user) => {
    if (arreterEcoute) { arreterEcoute(); arreterEcoute = null; }
    utilisateur = user;

    if (!user) {
      els.porte.hidden = false;
      els.app.hidden = true;
      els.btnSortie.hidden = true;
      els.identite.hidden = true;
      return;
    }

    els.porte.hidden = true;
    els.app.hidden = false;
    els.btnSortie.hidden = false;
    els.identite.hidden = false;
    els.identiteNom.textContent = user.displayName || user.email || "vous";

    /* La contrainte « clientUid == moi » n'est pas qu'un filtre d'affichage :
       les règles Firestore refusent toute requête qui ne la porte pas. Une
       page modifiée dans un navigateur ne peut donc pas élargir la liste. */
    const q = query(
      collection(db, "demandes"),
      where("clientUid", "==", user.uid),
      orderBy("creeLe", "desc"),
    );

    arreterEcoute = onSnapshot(q,
      (snap) => afficherListe(snap.docs.map((d) => ({ id: d.id, ...d.data() })), db),
      (e) => avis(els.avisErreur, "La liste de vos demandes n'a pas pu être chargée : " + e.message),
    );
  });

  els.formulaire.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!els.formulaire.checkValidity()) { els.formulaire.reportValidity(); return; }
    if (!utilisateur) return;

    els.btnEnvoyer.disabled = true;
    els.btnEnvoyer.textContent = "Envoi en cours…";
    els.avisErreur.hidden = true;

    try {
      await addDoc(collection(db, "demandes"), {
        clientUid: utilisateur.uid,
        clientNom: utilisateur.displayName || "",
        clientCourriel: utilisateur.email || "",
        type: $("type").value,
        urgence: document.querySelector('input[name="urgence"]:checked').value,
        page: $("page").value.trim(),
        description: $("description").value.trim(),
        statut: "recue",
        creeLe: serverTimestamp(),
      });

      els.formulaire.reset();
      avis(els.avisEnvoi, null);
    } catch (err) {
      avis(els.avisErreur, "Votre demande n'a pas pu être envoyée : " + err.message +
        " — écrivez-nous à boiesgrimardj@gmail.com si cela se reproduit.");
    } finally {
      els.btnEnvoyer.disabled = false;
      els.btnEnvoyer.textContent = "Envoyer ma demande";
    }
  });
}

/* ---------- Affichage ---------- */

/* Les libellés que voit le client. Le statut technique reste dans le
   document ; ce qui est montré est une phrase, pas un code. */
const ETATS = {
  recue:    { texte: "Reçue",           aide: "Votre demande est arrivée. Elle sera examinée sous peu." },
  analyse:  { texte: "En analyse",      aide: "BG Informatique examine ce qui doit être modifié." },
  en_cours: { texte: "En cours",        aide: "La modification est en train d'être appliquée." },
  en_ligne: { texte: "En ligne",        aide: "C'est publié. Comptez une à deux minutes avant de le voir." },
  refusee:  { texte: "À revoir",        aide: "BG Informatique a répondu ci-dessous." },
  annulee:  { texte: "Annulée",         aide: "Vous avez annulé cette demande." },
};

function afficherListe(demandes, db) {
  if (!demandes.length) {
    els.liste.innerHTML = '<p class="vide">Aucune demande pour le moment.</p>';
    return;
  }

  els.liste.replaceChildren(...demandes.map((d) => carte(d, db)));
}

function carte(d, db) {
  const etat = ETATS[d.statut] || ETATS.recue;
  const el = document.createElement("article");
  el.className = "demande etat-" + (d.statut || "recue");

  const tete = document.createElement("div");
  tete.className = "demande-tete";

  const titre = document.createElement("div");
  titre.className = "demande-titre";
  titre.textContent = d.type || "Demande";

  const pastille = document.createElement("span");
  pastille.className = "pastille etat-" + (d.statut || "recue");
  pastille.textContent = etat.texte;

  tete.append(titre, pastille);

  const meta = document.createElement("div");
  meta.className = "demande-meta";
  meta.textContent = [dateLisible(d.creeLe), d.page, d.urgence].filter(Boolean).join(" · ");

  const corps = document.createElement("div");
  corps.className = "demande-corps";
  corps.textContent = d.description || "";

  const aide = document.createElement("div");
  aide.className = "demande-meta";
  aide.style.marginTop = "8px";
  aide.textContent = etat.aide;

  el.append(tete, meta, corps, aide);

  /* La réponse est écrite par BG001, jamais par cette page. */
  if (d.reponse) {
    const rep = document.createElement("div");
    rep.className = "demande-reponse";
    const t = document.createElement("strong");
    t.textContent = "Réponse de BG Informatique";
    const p = document.createElement("div");
    p.textContent = d.reponse;
    rep.append(t, p);
    el.append(rep);
  }

  /* Annulation : possible tant que rien n'a commencé. Au-delà, le travail
     est peut-être déjà fait — le client écrit alors une nouvelle demande. */
  if (d.statut === "recue") {
    const actions = document.createElement("div");
    actions.className = "demande-actions";
    const btn = document.createElement("button");
    btn.className = "btn btn-fantome";
    btn.textContent = "Annuler cette demande";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "demandes", d.id), { statut: "annulee" });
      } catch (e) {
        btn.disabled = false;
        avis(els.avisErreur, "L'annulation n'a pas fonctionné : " + e.message);
      }
    });
    actions.append(btn);
    el.append(actions);
  }

  return el;
}

function dateLisible(ts) {
  if (!ts) return "";
  const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
}

function avis(el, texte) {
  if (texte) el.textContent = texte;
  el.hidden = false;
  if (el === els.avisEnvoi) setTimeout(() => { el.hidden = true; }, 6000);
}

function messageConnexion(e) {
  if (e.code === "auth/popup-closed-by-user") return "La fenêtre de connexion a été fermée avant la fin.";
  if (e.code === "auth/popup-blocked") return "Votre navigateur a bloqué la fenêtre de connexion. Autorisez-la puis réessayez.";
  if (e.code === "auth/unauthorized-domain") return "Ce domaine n'est pas encore autorisé côté Microsoft. Prévenez BG Informatique.";
  return "Connexion échouée : " + e.message;
}
