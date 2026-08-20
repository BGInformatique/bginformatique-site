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
  carteFiches: $("carte-fiches"),
  listeFiches: $("liste-fiches"),
  synchroFiches: $("synchro-fiches"),
};

/* Les champs d'une fiche d'installation, dans l'ordre de lecture, avec le
   libellé affiché. Même liste que le formulaire client et que le pont. */
const CHAMPS_FICHE = [
  ["entreprise", "Entreprise"],
  ["contactPublic", "Contact à afficher"],
  ["adresse", "Adresse"],
  ["horaires", "Heures"],
  ["reseaux", "Réseaux"],
  ["domaine", "Domaine"],
  ["domaineEtat", "Domaine acheté"],
  ["registraire", "Registraire"],
  ["githubEtat", "Compte GitHub"],
  ["githubCourriel", "Courriel GitHub"],
  ["siteActuel", "Site actuel"],
  ["notes", "Notes"],
];

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
let stopFiches = null;

onAuthStateChanged(auth, (user) => {
  if (stopState) { stopState(); stopState = null; }
  if (stopLancements) { stopLancements(); stopLancements = null; }
  if (stopFiches) { stopFiches(); stopFiches = null; }

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
  //
  // On ne retient QUE les « lancement-* ». Les signal-* portent eux aussi un
  // idDemande, avec un demandeLe plus récent (ils sont écrits juste après le
  // lancement) : sans ce filtre, le signal gagnait la comparaison ci-dessous
  // et l'éclair se rouvrait aussitôt sur une demande déjà partie — deux fois
  // le même travail sur le site d'un client.
  stopLancements = onSnapshot(refCollection, (snap) => {
    lancements = {};
    snap.forEach((d) => {
      if (!d.id.startsWith("lancement-")) return;
      const l = d.data();
      if (!l || !l.idDemande) return;
      const connu = lancements[l.idDemande];
      if (!connu || (l.demandeLe || 0) > (connu.demandeLe || 0)) {
        lancements[l.idDemande] = { ...l, _id: d.id };
      }
    });
    rendre();
  });

  /* Les fiches d'installation, déposées par le pont dans leur propre document.
     Lecture seule ici : ce document appartient au pont, comme « state ». */
  stopFiches = onSnapshot(doc(db, "users", user.uid, "clientsweb", "fiches"),
    (snap) => rendreFiches(snap.exists() ? (snap.data().fiches || []) : []),
    () => rendreFiches([]),
  );
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

/* ---------- Fiches d'installation ---------- */

/*
 * De la lecture, et deux gestes : copier la fiche pour l'avoir sous la main
 * pendant le montage, et la verrouiller quand le site est en place. Pas
 * d'éclair : une fiche n'est pas un travail à confier à Claude — créer un
 * dépôt GitHub, acheter un domaine et brancher un DNS se font à la main, avec
 * des comptes qui ne vivent pas sur BG001.
 */
function rendreFiches(fiches) {
  els.carteFiches.hidden = !fiches.length;
  if (!fiches.length) return;

  const aMonter = fiches.filter((f) => !f.verrouillee).length;
  els.synchroFiches.textContent = aMonter
    ? aMonter + " à monter"
    : "toutes montées";

  els.listeFiches.replaceChildren(...fiches.map(carteFiche));
}

function carteFiche(f) {
  const el = document.createElement("article");
  el.className = "demande " + (f.verrouillee ? "etat-en_ligne" : "etat-recue");

  const tete = document.createElement("div");
  tete.className = "d-tete";

  const gauche = document.createElement("div");
  const nom = document.createElement("span");
  nom.className = "d-client";
  nom.textContent = f.entreprise || f.clientNom || f.clientCourriel || "Sans nom";
  const courriel = document.createElement("span");
  courriel.className = "d-type";
  courriel.textContent = f.clientCourriel ? " — " + f.clientCourriel : "";
  gauche.append(nom, courriel);

  const past = document.createElement("span");
  past.className = "pastille " + (f.verrouillee ? "etat-en_ligne" : "etat-analyse");
  past.textContent = f.verrouillee ? "Site monté" : "À monter";

  const pastActivation = document.createElement("span");
  pastActivation.className = "pastille " + (f.approuvee ? "etat-en_ligne" : "etat-recue");
  pastActivation.textContent = f.approuvee ? "Demandes activées" : "Demandes fermées";

  tete.append(gauche, past, pastActivation);

  const meta = document.createElement("div");
  meta.className = "d-meta";
  meta.textContent = [dateLisible(f.majLe), f.dossier && "dossier : " + f.dossier]
    .filter(Boolean).join(" · ");

  const corps = document.createElement("div");
  corps.className = "d-corps";
  corps.textContent = texteFiche(f);

  el.append(tete, meta, corps);

  if (!f.declare) {
    const avert = document.createElement("div");
    avert.className = "non-relie";
    avert.textContent = "Client pas encore relié à un dossier sur BG001 — " +
      "à déclarer dans ~/.config/bg-lanceur/clients-web.json une fois le dépôt créé.";
    el.append(avert);
  }

  const zone = document.createElement("div");
  zone.className = "d-actions";

  const copier = document.createElement("button");
  copier.className = "btn btn-mini";
  copier.textContent = "Copier la fiche";
  copier.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(texteFiche(f));
      copier.textContent = "Copiée";
      setTimeout(() => { copier.textContent = "Copier la fiche"; }, 2000);
    } catch (e) {
      banner("warn", "Copie impossible : " + e.message);
    }
  });
  zone.append(copier);

  const verrou = document.createElement("button");
  verrou.className = "btn btn-mini";
  verrou.textContent = f.verrouillee ? "Rouvrir la fiche" : "Marquer le site monté";
  verrou.addEventListener("click", () => verrouillerFiche(f, !f.verrouillee));
  zone.append(verrou);

  /* Le formulaire de demandes du client reste fermé tant qu'on n'a pas lu sa
     fiche et décidé d'ouvrir l'accès — voir firestore.rules côté espace
     client, qui refuse la création d'une demande tant que « approuvee » n'est
     pas vrai. */
  const activation = document.createElement("button");
  activation.className = "btn btn-mini";
  activation.textContent = f.approuvee ? "Suspendre les demandes" : "Activer les demandes";
  activation.addEventListener("click", () => activerDemandes(f, !f.approuvee));
  zone.append(activation);

  el.append(zone);
  return el;
}

function texteFiche(f) {
  return CHAMPS_FICHE
    .filter(([cle]) => f[cle])
    .map(([cle, libelle]) => libelle + " : " + f[cle])
    .join("\n");
}

/* Même mécanique que « marquer » : une intention déposée pour le pont, qui
   l'applique côté client puis l'efface. La page n'écrit jamais dans le
   projet des clients — elle n'y a aucune identité. */
async function verrouillerFiche(f, verrouiller) {
  if (!refCollection) return;
  try {
    await setDoc(doc(refCollection, "signal-fiche-" + f.clientUid), {
      idFiche: f.clientUid,
      verrouiller: verrouiller,
      demandeLe: Date.now(),
    }, { merge: true });
    banner("warn", verrouiller
      ? "Fiche verrouillée — le client la verra en lecture seule au prochain cycle du pont (5 min)."
      : "Fiche rouverte — le client pourra la modifier au prochain cycle du pont (5 min).");
  } catch (e) {
    banner("danger", "Le signal n'a pas pu être écrit : " + e.message);
  }
}

/* Même mécanique que verrouillerFiche : une intention déposée pour le pont,
   qui l'applique côté client (fiches/<uid>.approuvee) puis efface le signal.
   Même document « signal-fiche-<uid> », avec merge:true — si les deux actions
   sont demandées avant le cycle suivant du pont, les deux s'appliquent. */
async function activerDemandes(f, activer) {
  if (!refCollection) return;
  try {
    await setDoc(doc(refCollection, "signal-fiche-" + f.clientUid), {
      idFiche: f.clientUid,
      activerDemandes: activer,
      demandeLe: Date.now(),
    }, { merge: true });
    banner("warn", activer
      ? "Demandes activées — le client pourra en envoyer au prochain cycle du pont (5 min)."
      : "Demandes suspendues — au prochain cycle du pont (5 min).");
  } catch (e) {
    banner("danger", "Le signal n'a pas pu être écrit : " + e.message);
  }
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
