/*
 * Demandes web — vue du propriétaire
 * https://bginformatique.ca/outils/dw-6r2v8k/
 *
 * Les demandes écrites par les clients dans l'espace client arrivent ici par
 * le pont de BG001, qui les recopie dans users/<uid>/clientsweb/state. Cette
 * page ne parle donc QU'au dossier du propriétaire, avec la règle éprouvée
 * des autres outils — aucune lecture inter-utilisateurs, ici ni ailleurs.
 *
 * L'ÉCLAIR NE DÉCIDE PAS DU TRAVAIL, IL L'AUTORISE. Il dépose un document
 * « lancement-* » dans la même sous-collection ; le lanceur de BG001 le
 * ramasse, choisit le dossier de travail DANS SA PROPRE TABLE d'après
 * clientUid, et lance Claude. Le texte du client voyage en donnée, jamais en
 * instruction : une page web ne redéfinit pas ce que la machine s'autorise.
 *
 * C'est aussi la porte manuelle voulue : rien ne part sur le site d'un client
 * sans que quelqu'un ait lu la demande et appuyé.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, OAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, MICROSOFT_TENANT_ID } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const els = {
  gate: $("auth-gate"),
  main: document.querySelector("main"),
  btnLogin: $("btn-login"),
  btnLogout: $("btn-logout"),
  authError: $("auth-error"),
  banners: $("banners"),
  filtres: $("filtres"),
  liste: $("liste"),
  synchro: $("synchro"),
};

/* ---------- État ---------- */

let etatDoc = { demandes: [] };   // miroir écrit par le pont
let lancements = {};              // id de demande → dernier lancement connu
let refState = null;
let refCollection = null;
let filtre = "a_traiter";

const ETATS = {
  recue:    "Reçue",
  analyse:  "En analyse",
  en_cours: "En cours",
  en_ligne: "En ligne",
  refusee:  "À revoir",
  annulee:  "Annulée",
};

const FILTRES = [
  { cle: "a_traiter", texte: "À traiter" },
  { cle: "en_cours",  texte: "En cours" },
  { cle: "terminees", texte: "Terminées" },
  { cle: "toutes",    texte: "Toutes" },
];

/* ---------- Authentification ---------- */

const provider = new OAuthProvider("microsoft.com");
provider.setCustomParameters({ tenant: MICROSOFT_TENANT_ID });

els.btnLogin.addEventListener("click", () => {
  els.authError.hidden = true;
  signInWithPopup(auth, provider).catch((e) => {
    els.authError.textContent = "Connexion échouée : " + e.message;
    els.authError.hidden = false;
  });
});

els.btnLogout.addEventListener("click", () => signOut(auth));

let stopState = null;
let stopLancements = null;

onAuthStateChanged(auth, (user) => {
  if (stopState) { stopState(); stopState = null; }
  if (stopLancements) { stopLancements(); stopLancements = null; }

  if (!user) {
    els.gate.hidden = false;
    els.main.hidden = true;
    els.btnLogout.hidden = true;
    return;
  }

  els.gate.hidden = true;
  els.main.hidden = false;
  els.btnLogout.hidden = false;

  refState = doc(db, "users", user.uid, "clientsweb", "state");
  refCollection = collection(db, "users", user.uid, "clientsweb");

  stopState = onSnapshot(refState,
    (snap) => {
      if (!snap.exists()) {
        // Rien encore : le pont n'a pas tourné, ou aucune demande n'est
        // arrivée. On n'écrit RIEN ici — ce document appartient au pont.
        etatDoc = { demandes: [] };
        els.synchro.textContent = "En attente du pont de BG001";
        rendre();
        return;
      }
      etatDoc = snap.data() || { demandes: [] };
      els.synchro.textContent = "Synchro : " +
        (snap.metadata.fromCache ? "hors ligne" : "à jour");
      rendre();
    },
    (e) => banner("danger", "Lecture refusée : " + e.message +
      " — le bloc « clientsweb » des règles Firestore est-il publié ?"),
  );

  // Les lancements vivent dans la même sous-collection, un document chacun.
  stopLancements = onSnapshot(refCollection, (snap) => {
    lancements = {};
    snap.forEach((d) => {
      if (d.id === "state") return;
      const l = d.data();
      if (!l || !l.idDemande) return;
      const connu = lancements[l.idDemande];
      if (!connu || (l.demandeLe || 0) > (connu.demandeLe || 0)) {
        lancements[l.idDemande] = { ...l, _id: d.id };
      }
    });
    rendre();
  });
});

/* ---------- Filtres ---------- */

els.filtres.replaceChildren(...FILTRES.map((f) => {
  const b = document.createElement("button");
  b.className = "filtre";
  b.textContent = f.texte;
  b.setAttribute("aria-pressed", String(f.cle === filtre));
  b.addEventListener("click", () => {
    filtre = f.cle;
    [...els.filtres.children].forEach((c) =>
      c.setAttribute("aria-pressed", String(c === b)));
    rendre();
  });
  return b;
}));

function retenue(d) {
  const s = d.statut || "recue";
  if (filtre === "toutes") return true;
  if (filtre === "a_traiter") return s === "recue" || s === "analyse";
  if (filtre === "en_cours") return s === "en_cours";
  return s === "en_ligne" || s === "refusee" || s === "annulee";
}

/* ---------- Rendu ---------- */

function rendre() {
  const demandes = (etatDoc.demandes || [])
    .filter(retenue)
    .sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));

  if (!demandes.length) {
    els.liste.innerHTML = '<p class="vide">Aucune demande dans ce filtre.</p>';
    return;
  }
  els.liste.replaceChildren(...demandes.map(carte));
}

function carte(d) {
  const statut = d.statut || "recue";
  const el = document.createElement("article");
  el.className = "demande etat-" + statut;

  const tete = document.createElement("div");
  tete.className = "d-tete";

  const gauche = document.createElement("div");
  const client = document.createElement("span");
  client.className = "d-client";
  client.textContent = d.client || d.clientNom || d.clientCourriel || "Client inconnu";
  const type = document.createElement("span");
  type.className = "d-type";
  type.textContent = " — " + (d.type || "demande");
  gauche.append(client, type);

  const past = document.createElement("span");
  past.className = "pastille etat-" + statut;
  past.textContent = ETATS[statut] || statut;

  tete.append(gauche, past);

  const meta = document.createElement("div");
  meta.className = "d-meta";
  const bouts = [dateLisible(d.creeLe), d.page].filter(Boolean);
  meta.textContent = bouts.join(" · ");
  if (d.urgence === "Urgent") {
    const u = document.createElement("span");
    u.className = "urgent";
    u.textContent = (bouts.length ? " · " : "") + "URGENT";
    meta.append(u);
  } else if (d.urgence) {
    meta.textContent += (bouts.length ? " · " : "") + d.urgence;
  }

  const corps = document.createElement("div");
  corps.className = "d-corps";
  corps.textContent = d.description || "";

  el.append(tete, meta, corps);

  /* Client non relié à un dossier de BG001 : on le dit, et l'éclair reste
     fermé. Mieux vaut une demande visible qu'on ne peut pas lancer qu'un
     lancement qui ne sait pas où travailler. */
  if (!d.depotConnu) {
    const avert = document.createElement("div");
    avert.className = "non-relie";
    avert.textContent = "Client non relié à un dossier sur BG001 — " +
      "à déclarer dans ~/.config/bg-lanceur/clients-web.json avant de pouvoir lancer.";
    el.append(avert);
  }

  const lancement = lancements[d.id];
  el.append(actions(d, lancement));

  if (lancement && (lancement.resultat || lancement.erreur)) {
    const res = document.createElement("div");
    res.className = "resultat";
    res.textContent = lancement.erreur || lancement.resultat;
    el.append(res);
  }

  return el;
}

function actions(d, lancement) {
  const zone = document.createElement("div");
  zone.className = "d-actions";
  const statut = d.statut || "recue";
  const enCours = lancement && (lancement.statut === "demande" || lancement.statut === "en_cours");

  if (statut === "annulee") {
    const t = document.createElement("span");
    t.className = "d-type";
    t.textContent = "Annulée par le client — rien à faire.";
    zone.append(t);
    return zone;
  }

  const eclair = document.createElement("button");
  eclair.className = "btn btn-eclair";

  if (enCours) {
    eclair.textContent = "✕ Annuler le lancement";
    eclair.addEventListener("click", () => annulerLancement(lancement));
  } else {
    eclair.textContent = "⚡ Lancer sur BG001";
    eclair.disabled = !d.depotConnu;
    eclair.title = d.depotConnu ? "" : "Client non relié à un dossier sur BG001";
    eclair.addEventListener("click", () => lancer(d));
  }
  zone.append(eclair);

  if (lancement && lancement.statut) {
    const et = document.createElement("span");
    et.className = "d-type";
    et.textContent = "Lancement : " + lancement.statut.replace(/_/g, " ");
    zone.append(et);
  }

  /* Marquer « À revoir » : sort la demande de la file sans rien lancer, avec
     un mot pour le client. C'est le SEUL texte libre qui lui parvient — la
     sortie de Claude ne remonte jamais telle quelle jusqu'à lui. */
  if (statut !== "en_ligne" && statut !== "refusee") {
    const revoir = document.createElement("button");
    revoir.className = "btn btn-mini";
    revoir.textContent = "Marquer à revoir";
    revoir.addEventListener("click", () => {
      const mot = prompt("Message pour le client (il le verra dans son espace) :", "");
      if (mot === null) return;
      marquer(d, "refusee", mot.trim());
    });
    zone.append(revoir);
  }

  return zone;
}

/* ---------- Écritures ---------- */

/*
 * Un lancement ne transporte que des DONNÉES : qui, quoi, et l'identifiant du
 * client. Jamais un chemin, jamais une consigne d'exécution — le lanceur
 * choisit le dossier dans sa propre table et écrit lui-même le cadre de
 * travail. C'est la règle posée en tête de lanceur.py, et elle compte double
 * ici puisque le texte vient d'une partie extérieure.
 */
async function lancer(d) {
  if (!refCollection) return;
  const id = "lancement-" + Date.now() + "-" +
    Math.random().toString(36).slice(2, 8);
  try {
    await setDoc(doc(refCollection, id), {
      idDemande: d.id,
      clientUid: d.clientUid || "",
      client: d.client || "",
      titre: (d.type || "Demande") + " — " + (d.client || ""),
      detail: d.description || "",
      page: d.page || "",
      urgence: d.urgence || "",
      statut: "demande",
      demandeLe: Date.now(),
    });
    await marquer(d, "en_cours");
  } catch (e) {
    banner("danger", "Le lancement n'a pas pu être déposé : " + e.message);
  }
}

async function annulerLancement(lancement) {
  try {
    await updateDoc(doc(refCollection, lancement._id), { statut: "annule" });
  } catch (e) {
    banner("danger", "L'annulation n'a pas pu être écrite : " + e.message);
  }
}

/*
 * Le statut d'une demande vit dans le document « state », écrit par le pont.
 * On n'écrase pas tout l'état : on dépose une INTENTION que le pont applique
 * puis efface, exactement comme le tableau de bord marketing signale un
 * changement au prospecteur. Sans ça, deux écrivains se marcheraient dessus
 * sur le même document.
 */
async function marquer(d, statut, reponse) {
  if (!refCollection) return;
  const id = "signal-" + d.id;
  try {
    await setDoc(doc(refCollection, id), {
      idDemande: d.id,
      statutVoulu: statut,
      reponse: reponse || "",
      demandeLe: Date.now(),
    });
  } catch (e) {
    banner("danger", "Le changement d'état n'a pas pu être écrit : " + e.message);
  }
}

/* ---------- Divers ---------- */

function dateLisible(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
  if (isNaN(d)) return "";
  return d.toLocaleDateString("fr-CA", { day: "numeric", month: "short", year: "numeric" });
}

function banner(ton, texte) {
  const b = document.createElement("div");
  b.className = "banner banner-" + ton;
  b.textContent = texte;
  els.banners.replaceChildren(b);
}
