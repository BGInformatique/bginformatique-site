/*
 * Banc d'essai en navigateur : la page complète, sans Firebase.
 *
 *   node outils/ep-4k9m2t/tests/navigateur.mjs
 *
 * Le banc de banc.mjs couvre le calcul; celui-ci couvre ce que le calcul ne
 * voit pas — le rendu, les écouteurs d'événements, la connexion, l'écriture
 * vers Firestore. Les modules gstatic sont remplacés à la volée par les
 * bouchons de tests/bouchons/ : aucun réseau, aucun compte, aucune donnée
 * réelle.
 *
 * Playwright et Chromium sont nécessaires. Absents, `lancer.sh` saute cette
 * étape avec le code 2 — c'est le contrat des bancs de ce dépôt.
 */
"use strict";

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(ICI, "..");

let reussis = 0;
const echecs = [];

function verifier(titre, condition, detail = "") {
  if (condition) reussis++;
  else echecs.push(`${titre}${detail ? ` — ${detail}` : ""}`);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function demarrerServeur() {
  const serveur = http.createServer(async (requete, reponse) => {
    const chemin = decodeURIComponent(requete.url.split("?")[0]);
    const fichier = path.join(RACINE, chemin === "/" ? "index.html" : chemin);
    if (!fichier.startsWith(RACINE)) {
      reponse.writeHead(403).end();
      return;
    }
    try {
      const contenu = await fs.readFile(fichier);
      reponse.writeHead(200, { "Content-Type": TYPES[path.extname(fichier)] || "text/plain" });
      reponse.end(contenu);
    } catch {
      reponse.writeHead(404).end("introuvable");
    }
  });
  await new Promise((resoudre) => serveur.listen(0, "127.0.0.1", resoudre));
  return { serveur, port: serveur.address().port };
}

const CIRCULAIRE_IGA = [
  "IGA — Circulaire du 6 au 12 août 2026",
  "Lait 2 % Natrel 2 L 4,49 $",
  "Poitrines de poulet désossées 8,80 $/kg 3,99 $/lb",
  "Fraises du Québec 454 g 2,99 $",
  "Céréales Kellogg's 320-500 g 3,49 $ Rég. 5,99 $",
].join("\n");

const CIRCULAIRE_MAXI = ["Maxi", "Lait 2 % Québon 2 L 4,27 $", "Fraises 454 g 3,49 $"].join("\n");

async function principal() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("  Playwright absent — banc navigateur sauté.");
    process.exit(2);
  }

  const { serveur, port } = await demarrerServeur();
  const base = `http://127.0.0.1:${port}`;
  let navigateur;
  try {
    // BGFOODS_CHROMIUM : chemin d'un Chromium déjà installé (conteneurs, CI),
    // quand celui que Playwright attend n'est pas là.
    const executablePath = process.env.BGFOODS_CHROMIUM || undefined;
    navigateur = await chromium.launch(executablePath ? { executablePath } : {});
  } catch (e) {
    await new Promise((r) => serveur.close(r));
    console.log(`  Chromium indisponible (${e.message.split("\n")[0]}) — banc navigateur sauté.`);
    process.exit(2);
  }

  const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });

  // Les modules Firebase sont servis depuis les bouchons locaux.
  await contexte.route("https://www.gstatic.com/firebasejs/**", async (route) => {
    const nom = route.request().url().split("/").pop();
    const corps = await fs.readFile(path.join(ICI, "bouchons", nom), "utf-8");
    await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: corps });
  });

  // circulaires.com est servi depuis les mêmes échantillons que banc.mjs.
  // Sans ça, ce banc dépendrait du réseau ET de ce que le site publie le jour
  // où on le lance — deux raisons d'échouer qui n'ont rien à voir avec le code.
  await contexte.route("https://www.circulaires.com/**", async (route) => {
    const url = route.request().url();
    let nom = null;
    if (url.includes("/alimentation/")) nom = "annuaire";
    else if (url.includes("index.do")) nom = "imageform";
    else if (url.includes("/maxi/circulaire/")) nom = "visionneuse-maxi";
    else if (url.includes("/circulaire/?")) nom = "visionneuse";
    else if (url.includes("dpage=")) nom = "visionneuse-b";
    else if (url.includes("flyers.do")) nom = "choix-b";
    else if (url.includes("/supermarche-iga/?")) nom = "epicerie";
    else if (url.includes("/maxi/?")) nom = "epicerie-maxi";
    else if (url.includes("/marche-richelieu/?")) nom = "epicerie-b";
    const corps = nom
      ? await fs.readFile(path.join(ICI, "echantillons", `circulaires-com-${nom}.html`), "utf-8")
      : "<html></html>";
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "access-control-allow-origin": "*" },
      body: corps,
    });
  });

  const page = await contexte.newPage();
  const erreursConsole = [];
  page.on("console", (m) => m.type() === "error" && erreursConsole.push(m.text()));
  page.on("pageerror", (e) => erreursConsole.push(String(e)));

  await page.goto(base + "/index.html", { waitUntil: "networkidle" });

  /* ---- Connexion ---- */
  verifier("l'écran de connexion s'affiche", await page.locator("#auth-gate").isVisible());
  verifier("le contenu est caché avant connexion", await page.locator("main").isHidden());

  await page.click("#btn-login");
  await page.waitForTimeout(150);
  verifier("le contenu s'affiche après connexion", await page.locator("main").isVisible());
  verifier(
    "le locataire Microsoft est transmis",
    (await page.evaluate(() => globalThis.__bouchon.auth.parametres.tenant)) ===
      "9e6d32d9-b9fb-43a9-8a96-cdd1e707ebac",
  );

  // Premier instantané : sans lui, l'application n'écrit rien (protection
  // contre l'écrasement du nuage par un appareil qui vient de s'ouvrir).
  await page.evaluate(() => globalThis.__bouchon.emettreInstantane({ existe: false }));
  await page.waitForTimeout(100);
  verifier(
    "le chemin Firestore est celui de BGFoods",
    (await page.evaluate(() => globalThis.__bouchon.cheminDocument)) === "users/uid-essai/bgfoods/state",
  );

  /* ---- Import de deux circulaires ----
     Les dates sont imposées : sans elles, la circulaire Maxi (qui n'en annonce
     aucune) prendrait la semaine en cours, et le banc dépendrait du jour où on
     le lance. */
  await page.click('[data-onglet="circulaires"]');
  await page.fill("#texte-circulaire", CIRCULAIRE_IGA);
  await page.click("#btn-importer-texte");
  await page.waitForTimeout(120);
  await page.fill("#import-debut", "2026-08-06");
  await page.fill("#import-fin", "2026-08-12");
  await page.fill("#texte-circulaire", CIRCULAIRE_MAXI);
  await page.click("#btn-importer-texte");
  await page.waitForTimeout(120);

  const compte = await page.evaluate(() => ({
    circulaires: globalThis.bgfoods.etat.circulaires.length,
    aubaines: globalThis.bgfoods.etat.aubaines.length,
    epiceries: globalThis.bgfoods.etat.circulaires.map((c) => c.epicerie),
    dates: globalThis.bgfoods.etat.circulaires.map((c) => `${c.debut}→${c.fin}`),
  }));
  verifier("deux circulaires importées", compte.circulaires === 2, JSON.stringify(compte));
  // 4 produits chez IGA, 2 chez Maxi : les lignes d'entête n'en sont pas.
  verifier("les aubaines sont extraites", compte.aubaines === 6, `${compte.aubaines} aubaine(s)`);
  verifier("les épiceries sont reconnues", compte.epiceries.includes("IGA") && compte.epiceries.includes("Maxi"), compte.epiceries.join());
  verifier(
    "les dates annoncées par la circulaire IGA sont lues",
    compte.dates.every((d) => d === "2026-08-06→2026-08-12"),
    compte.dates.join(),
  );

  /* ---- Circulaire sans rien à extraire ----
     Rien ne doit être créé, et ce qui a été récupéré doit atterrir dans le
     formulaire pour servir à la saisie à la main.

     Le texte collé emprunte ce chemin-ci; la formulation propre aux circulaires
     EN IMAGES dépend de `imagesProbables`, que seule la lecture d'un PDF peut
     établir — pdf.js venant d'un CDN, ce banc ne peut pas l'exercer. C'est
     `enImages()` qui la couvre, dans banc.mjs, sur le cas IGA réel. */
  const circulairesAvant = await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length);
  await page.fill("#import-debut", "");
  await page.fill("#import-fin", "");
  await page.fill("#texte-circulaire", "IGA\nValide du jeudi 6 août au mercredi 12 août 2026");
  await page.click("#btn-importer-texte");
  await page.waitForTimeout(150);

  verifier(
    "aucune circulaire vide n'est créée",
    (await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length)) === circulairesAvant,
  );
  verifier(
    "les dates récupérées sont reportées dans le formulaire",
    (await page.inputValue("#import-debut")) === "2026-08-06" &&
      (await page.inputValue("#import-fin")) === "2026-08-12",
    `${await page.inputValue("#import-debut")} → ${await page.inputValue("#import-fin")}`,
  );
  verifier("l'épicerie est reportée", (await page.inputValue("#import-epicerie")) === "IGA");
  const avis = await page.locator('[data-avis="import-vide"]').innerText();
  verifier(
    "le message explique quoi faire",
    avis.includes("Aucune aubaine n'a été reconnue") && avis.includes("Coller le texte"),
    avis.slice(0, 90),
  );
  await page.fill("#import-epicerie", "");
  await page.fill("#texte-circulaire", "");

  /* ---- Correction d'une aubaine ---- */
  // La circulaire IGA, nommément : l'ordre d'affichage dépend des dates.
  await page.click('#liste-circulaires tr:has-text("IGA") [data-ouvrir]');
  await page.waitForTimeout(100);
  const premiereLigne = page.locator("#correction tr[data-aubaine]").first();
  const idCorrige = await premiereLigne.getAttribute("data-aubaine");
  await premiereLigne.locator('input[data-champ="prix"]').fill("9,99");
  await premiereLigne.locator('input[data-champ="prix"]').press("Tab");
  await page.waitForTimeout(150);
  const corrigee = await page.evaluate(
    (id) => globalThis.bgfoods.etat.aubaines.find((a) => a.id === id),
    idCorrige,
  );
  verifier("le prix corrigé est enregistré", corrigee.prixCents === 999, String(corrigee.prixCents));
  verifier("le prix unitaire est recalculé", corrigee.prixParUnite > 0);

  await page.click('[data-valider-tout="0"]');
  await page.waitForTimeout(150);
  const validees = await page.evaluate(
    () => globalThis.bgfoods.etat.aubaines.filter((a) => a.validee).length,
  );
  verifier("la validation en lot marque les quatre aubaines d'IGA", validees === 4, String(validees));

  /* ---- Génération de la liste ---- */
  await page.click('[data-onglet="liste"]');
  await page.fill("#articles", "2 lait 2 %\nfraises\npapier hygiénique");
  await page.fill("#date-cible", "2026-08-10");  // couvert par les deux circulaires
  await page.click("#btn-generer");
  await page.waitForTimeout(200);

  const texteListe = await page.locator("#resultat-liste").innerText();
  verifier("le lait le moins cher vient de Maxi", texteListe.includes("Maxi"), texteListe.slice(0, 120));
  verifier("l'article introuvable est listé à part", texteListe.includes("papier hygiénique"));
  verifier("la quantité est reportée", texteListe.includes("× 2"));

  const listeEnregistree = await page.evaluate(() => globalThis.bgfoods.etat.listes[0]);
  verifier("générer enregistre la liste", listeEnregistree && listeEnregistree.articles.length === 3);

  /* ---- Cases cochées : elles doivent survivre et partir au nuage ---- */
  await page.locator("#resultat-liste input[data-coche]").first().check();
  await page.waitForTimeout(1200);
  const coches = await page.evaluate(() => Object.keys(globalThis.bgfoods.etat.listes[0].coches || {}).length);
  verifier("la case cochée est retenue", coches === 1, String(coches));

  const ecritures = await page.evaluate(() => globalThis.__bouchon.ecritures.length);
  verifier("l'état est envoyé à Firestore", ecritures > 0, String(ecritures));
  const derniere = await page.evaluate(() => globalThis.__bouchon.derniereEcriture());
  verifier("l'écriture contient les trois registres", derniere && derniere.circulaires && derniere.aubaines && derniere.listes);

  /* ---- Fusion : ce qui arrive de l'autre appareil ---- */
  await page.evaluate(() => {
    const etat = globalThis.bgfoods.etat;
    globalThis.__bouchon.emettreInstantane({
      existe: true,
      donnees: {
        circulaires: [...etat.circulaires, { id: "c-cell", epicerie: "Super C", debut: "2026-08-06", fin: "2026-08-12", updatedAt: Date.now() }],
        aubaines: etat.aubaines,
        listes: etat.listes,
        tombes: etat.tombes,
        updatedAt: Date.now(),
      },
    });
  });
  await page.waitForTimeout(200);
  const apresFusion = await page.evaluate(() =>
    globalThis.bgfoods.etat.circulaires.map((c) => c.epicerie).sort(),
  );
  verifier("la circulaire venue de l'autre appareil apparaît", apresFusion.includes("Super C"), apresFusion.join());
  verifier("les circulaires locales survivent à la fusion", apresFusion.includes("IGA") && apresFusion.includes("Maxi"));

  /* ---- Aubaines et rendu mobile ---- */
  await page.click('[data-onglet="aubaines"]');
  await page.waitForTimeout(150);
  const texteAubaines = await page.locator("#resultat-aubaines").innerText();
  verifier("les aubaines sont groupées par épicerie", texteAubaines.includes("IGA") && texteAubaines.includes("Maxi"));
  await page.fill("#filtre-recherche", "poulet");
  await page.waitForTimeout(200);
  const filtre = await page.locator("#resultat-aubaines").innerText();
  verifier("la recherche filtre les aubaines", filtre.toLowerCase().includes("poulet") && !filtre.includes("Fraises"), filtre.slice(0, 160));

  const telephone = await contexte.newPage();
  await telephone.setViewportSize({ width: 390, height: 844 });
  await telephone.goto(base + "/index.html", { waitUntil: "networkidle" });
  await telephone.evaluate(() => globalThis.__bouchon.connecter());
  await telephone.waitForTimeout(150);
  verifier("l'écran du téléphone affiche les onglets", await telephone.locator("#onglets").isVisible());

  /* ---- L'éclair : file de lancement sur BG001 ----
     La page ne lit rien elle-même : elle dépose une demande, et le lanceur de
     BG001 réécrit le résultat dans le même document. On simule ici le retour.

     Ce bloc existe parce que la première version se chargeait mal : les
     variables de la file étaient déclarées après onAuthStateChanged, dont le
     rappel part PENDANT l'évaluation du module. L'erreur d'initialisation
     avortait le fichier et plus aucun onglet ne répondait. Un essai qui
     n'ouvrait pas la page ne l'aurait jamais vu. */
  verifier("la file de lancement est écoutée", await page.evaluate(() => globalThis.__bouchon.fileActive()));
  verifier("les deux abonnements coexistent", (await page.evaluate(() => globalThis.__bouchon.abonnements)) >= 2);

  const avantLancement = await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length);
  await page.evaluate(() => globalThis.__bouchon.emettreLancements([{
    id: "lancement-1", outil: "BGFoods", statut: "fait", slug: "superc",
    epicerie: "Super C", debut: "2026-08-06", fin: "2026-08-12",
    resultat: "Longe de porc entière désossée 1,85 $/lb\nPoulet entier Olymel 2,77 $/lb",
    demandeLe: 1, finiLe: 2,
  }]));
  await page.waitForTimeout(200);
  const apres = await page.evaluate(() => ({
    circulaires: globalThis.bgfoods.etat.circulaires.length,
    derniere: globalThis.bgfoods.etat.circulaires.at(-1),
    // Les aubaines ne portent pas le nom de l'épicerie : elles sont rattachées
    // à leur circulaire par circulaireId.
    aubaines: (() => {
      const c = globalThis.bgfoods.etat.circulaires.at(-1);
      return globalThis.bgfoods.etat.aubaines.filter((a) => a.circulaireId === c.id).length;
    })(),
  }));
  verifier("le résultat de BG001 crée la circulaire", apres.circulaires === avantLancement + 1,
    `${avantLancement} → ${apres.circulaires}`);
  verifier("l'épicerie et les dates viennent du lancement",
    apres.derniere.epicerie === "Super C" && apres.derniere.debut === "2026-08-06",
    JSON.stringify(apres.derniere && { e: apres.derniere.epicerie, d: apres.derniere.debut }));
  verifier("les aubaines passent par l'analyseur habituel", apres.aubaines === 2, `${apres.aubaines}`);

  // Le même instantané réémis ne doit pas réimporter : Firestore renvoie tout
  // le lot à chaque changement, et sans garde on doublerait les aubaines.
  await page.evaluate(() => globalThis.__bouchon.emettreLancements([{
    id: "lancement-1", outil: "BGFoods", statut: "fait", slug: "superc",
    epicerie: "Super C", debut: "2026-08-06", fin: "2026-08-12",
    resultat: "Longe de porc entière désossée 1,85 $/lb\nPoulet entier Olymel 2,77 $/lb",
    demandeLe: 1, finiLe: 2,
  }]));
  await page.waitForTimeout(200);
  verifier("un instantané répété n'importe pas deux fois",
    (await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length)) === apres.circulaires);

  // Le rechargement de la page est l'autre cas : la mémoire repart vide, et le
  // lanceur garde les demandes terminées trente jours. Sans le drapeau écrit
  // dans le document, chaque ouverture réimporterait tout.
  verifier("la récolte est notée dans le document",
    (await page.evaluate(() => globalThis.__bouchon.lancementsEcrits
      .some((e) => /lancement-1$/.test(e.chemin) && e.recolte === true))),
    JSON.stringify(await page.evaluate(() => globalThis.__bouchon.lancementsEcrits)));

  const avantRechargement = await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length);
  await page.evaluate(() => globalThis.__bouchon.emettreLancements([{
    id: "lancement-2", outil: "BGFoods", statut: "fait", recolte: true, slug: "metro",
    epicerie: "Metro", debut: "2026-08-06", fin: "2026-08-12",
    resultat: "Rôti de bas de palette désossé 6,99 $/lb",
    demandeLe: 3, finiLe: 4,
  }]));
  await page.waitForTimeout(200);
  verifier("une demande déjà récoltée n'est pas réimportée",
    (await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length)) === avantRechargement,
    `${avantRechargement} → ${await page.evaluate(() => globalThis.bgfoods.etat.circulaires.length)}`);

  /* ---- Veille : la circulaire de la semaine ----
     Les aubaines s'éteignent à la date de fin de leur circulaire, ce qui est
     juste. Mais l'outil s'arrêtait là : la suivante, publiée chez eux, ne
     rentrait que si on repassait à la main par « Chercher la circulaire ».
     Une semaine sur deux, l'outil s'ouvrait vide. */
  await page.click('[data-onglet="circulaires"]');
  verifier("la carte de veille est affichée",
    (await page.locator("#veille .card").count()) === 1);

  // On vieillit ce qui est en mémoire : les circulaires importées deviennent
  // celles de la semaine dernière. Les échantillons, eux, annoncent le 6 au 12.
  await page.evaluate(() => {
    const etat = globalThis.bgfoods.etat;
    for (const c of etat.circulaires) {
      if (c.epicerie === "IGA" || c.epicerie === "Maxi") {
        c.debut = "2026-07-23";
        c.fin = "2026-07-29";
      }
    }
    globalThis.bgfoods.etat = etat;
  });

  await page.click("#btn-veille-verifier");
  await page.waitForSelector("#btn-veille-tout", { timeout: 8000 });
  const texteVeille = await page.locator("#veille").innerText();
  verifier("les deux épiceries en retard sont repérées",
    /Mettre à jour \(2\)/.test(texteVeille), texteVeille.slice(0, 220));
  verifier("l'épicerie et les dates de la nouvelle circulaire sont nommées",
    /IGA/.test(texteVeille) && /Maxi/.test(texteVeille) && /2026-08-12/.test(texteVeille),
    texteVeille.slice(0, 220));
  // L'identifiant chez eux n'était pas enregistré à l'import du texte : il a
  // fallu le retrouver dans leur annuaire, par le nom de la bannière.
  verifier("l'avis se voit depuis n'importe quel onglet",
    /nouvelle\(s\) circulaire\(s\)/.test(
      await page.locator('#banners [data-avis="veille"]').innerText()));

  const lancementsAvant = await page.evaluate(() =>
    globalThis.__bouchon.lancementsEcrits.filter((e) => e.statut === "demande").length);
  await page.click("#btn-veille-tout");
  await page.waitForFunction(
    (avant) => globalThis.__bouchon.lancementsEcrits.filter((e) => e.statut === "demande").length
      >= avant + 2,
    lancementsAvant,
    { timeout: 15000 },
  );
  const demandes = await page.evaluate(() =>
    globalThis.__bouchon.lancementsEcrits.filter((e) => e.statut === "demande"));
  verifier("une demande par épicerie en retard", demandes.length === 2, JSON.stringify(demandes.map((d) => d.slug)));
  verifier("la demande porte l'identifiant circulaires.com",
    demandes.some((d) => d.slug === "supermarche-iga") && demandes.some((d) => d.slug === "maxi"),
    JSON.stringify(demandes.map((d) => d.slug)));
  verifier("la demande porte les dates de la NOUVELLE circulaire",
    demandes.every((d) => d.fin === "2026-08-12"), JSON.stringify(demandes.map((d) => d.fin)));
  verifier("elle transmet des adresses de pages, jamais une consigne",
    demandes.every((d) => d.detail.split("\n").every((u) => /^https:\/\//.test(u))),
    JSON.stringify(demandes.map((d) => d.detail.slice(0, 60))));
  // Ce qui est parti sort de la liste : le résultat reviendra par la file.
  verifier("la liste se vide une fois les demandes déposées",
    (await page.locator("#btn-veille-tout").count()) === 0);

  // On remet les dates de la semaine en cours : la suite du banc travaille sur
  // des aubaines en vigueur, et c'est ce banc-ci qui les avait vieillies.
  await page.evaluate(() => {
    const etat = globalThis.bgfoods.etat;
    for (const c of etat.circulaires) {
      if (c.epicerie === "IGA" || c.epicerie === "Maxi") {
        c.debut = "2026-08-06";
        c.fin = "2026-08-12";
      }
    }
    globalThis.bgfoods.etat = etat;
  });

  /* ---- Plans d'épicerie ----
     Le plan actif remplace la zone de saisie comme source de la liste. Si les
     deux restaient en concurrence, on ne saurait pas laquelle a produit le
     résultat — d'où le bandeau et la zone désactivée, vérifiés ici. */
  await page.click('[data-onglet="plans"]');
  verifier("l'onglet Plans s'affiche", await page.locator("#vue-plans").isVisible());

  await page.fill("#plan-nom", "Semaine type");
  await page.fill("#plan-max", "1");
  await page.click("#btn-creer-plan");
  await page.waitForTimeout(150);
  const plan1 = await page.evaluate(() => globalThis.bgfoods.etat.plans[0]);
  verifier("le plan est créé", plan1 && plan1.nom === "Semaine type", JSON.stringify(plan1));
  verifier("le premier plan est actif d'emblée", !!plan1.actif);
  verifier("le maximum d'épiceries est retenu", plan1.maxEpiceries === 1, String(plan1.maxEpiceries));

  // Créé sans rien avoir coché, le plan se garnit des meilleurs spéciaux :
  // un plan vide n'apprendrait rien et resterait à remplir à la main.
  const garni = await page.evaluate(() => globalThis.bgfoods.etat.plans[0].articles);
  verifier("le plan est garni depuis les spéciaux", garni.length > 0, `${garni.length} article(s)`);
  verifier("des protéines arrivent étoilées", garni.some((a) => a.priorite),
    JSON.stringify(garni.filter((a) => a.priorite).map((a) => a.requete)));

  await page.fill("[data-nouvel-article]", "2 lait 2 % (écrémé)");
  await page.click("[data-ajouter]");
  await page.waitForTimeout(150);
  const article = await page.evaluate(() => globalThis.bgfoods.etat.plans[0].articles.at(-1));
  verifier("l'article s'ajoute à la suite", article.requete === "lait 2 %", JSON.stringify(article));
  verifier("la quantité est lue", article.quantite === 2, String(article.quantite));
  verifier("la note est lue", article.note === "écrémé", String(article.note));
  verifier("il n'est pas prioritaire par défaut", !article.priorite);

  const dernier = await page.evaluate(() => globalThis.bgfoods.etat.plans[0].articles.length - 1);
  await page.click(`[data-priorite="${dernier}"]`);
  await page.waitForTimeout(150);
  verifier("l'étoile marque la priorité",
    await page.evaluate(() => !!globalThis.bgfoods.etat.plans[0].articles.at(-1).priorite));

  /* ---- Taille du foyer ----
     Les quantités sont écrites pour deux adultes puis multipliées. */
  // Un champ nombre n'émet « change » qu'en perdant le focus : sans le Tab,
  // la valeur serait saisie mais jamais enregistrée.
  await page.fill('[data-foyer="ados"]', "2");
  await page.press('[data-foyer="ados"]', "Tab");
  await page.waitForTimeout(250);
  verifier("le foyer est retenu",
    await page.evaluate(() => globalThis.bgfoods.etat.plans[0].foyer.ados === 2));
  const quantiteAffichee = await page.evaluate(() => {
    const lignes = [...document.querySelectorAll("#liste-plans tbody tr")];
    return lignes.length ? lignes[0].children[2].textContent.trim() : "";
  });
  verifier("la quantité affichée suit le foyer", /^[2-9]/.test(quantiteAffichee), quantiteAffichee);

  await page.click('[data-onglet="liste"]');
  verifier("le bandeau annonce le plan actif",
    (await page.locator("#bandeau-plan").innerText()).includes("Semaine type"));
  verifier("la zone de saisie est neutralisée", await page.locator("#articles").isDisabled());

  // La zone contient autre chose que le plan : c'est le plan qui doit gagner.
  await page.evaluate(() => { document.querySelector("#articles").value = "fraises"; });
  await page.click("#btn-generer");
  await page.waitForTimeout(200);
  const liste = await page.evaluate(() => {
    const r = globalThis.bgfoods.resultat();
    return r && {
      articles: r.groupes.flatMap((g) => g.lignes.map((l) => l.requete))
        .concat(r.sansAubaine.map((l) => l.requete)),
      prioritaires: r.groupes.flatMap((g) => g.lignes.filter((l) => l.priorite).map((l) => l.requete)),
    };
  });
  verifier("la liste vient du plan, pas de la zone",
    liste && liste.articles.includes("lait 2 %") && !liste.articles.includes("fraises"),
    JSON.stringify(liste));
  verifier("la priorité se rend jusqu'au résultat",
    liste && liste.prioritaires.length > 0, JSON.stringify(liste.prioritaires));

  /* ---- Cocher une aubaine l'ajoute au plan ----
     Le rapprochement se fait sur le nom normalisé, pas sur l'identifiant de
     l'aubaine : un plan sert d'une semaine à l'autre, alors que les aubaines
     sont réimportées et changent d'identifiant. */
  await page.click('[data-onglet="aubaines"]');
  const avantCoche = await page.evaluate(() => globalThis.bgfoods.etat.plans[0].articles.length);
  // Le plan est déjà garni depuis les spéciaux, donc les cases sont cochées :
  // on éprouve le cycle dans l'ordre décocher → recocher, qui couvre les deux
  // sens sans dépendre d'une aubaine restée libre.
  const uneCase = page.locator("[data-au-plan]").first();
  verifier("les aubaines déjà au plan sont cochées", await uneCase.isChecked());

  await uneCase.uncheck();
  await page.waitForTimeout(200);
  const apresDecoche = await page.evaluate(() => globalThis.bgfoods.etat.plans[0].articles.length);
  verifier("décocher retire l'article du plan", apresDecoche === avantCoche - 1,
    `${avantCoche} → ${apresDecoche}`);

  // La case doit refléter l'état après un nouveau rendu : sinon on ne saurait
  // plus ce qui est déjà au plan.
  await page.evaluate(() => globalThis.bgfoods.rendre());
  await page.waitForTimeout(150);
  verifier("la case reste décochée après rendu", !(await uneCase.isChecked()));

  await uneCase.check();
  await page.waitForTimeout(200);
  const apresRecoche = await page.evaluate(() => ({
    n: globalThis.bgfoods.etat.plans[0].articles.length,
    dernier: globalThis.bgfoods.etat.plans[0].articles.at(-1),
  }));
  verifier("cocher une aubaine l'ajoute au plan", apresRecoche.n === avantCoche,
    `${apresDecoche} → ${apresRecoche.n}`);
  verifier("l'article porte le nom du produit, pas un identifiant",
    apresRecoche.dernier && !!apresRecoche.dernier.requete && !apresRecoche.dernier.id,
    JSON.stringify(apresRecoche.dernier));
  verifier("il n'est pas prioritaire d'office", !apresRecoche.dernier.priorite);
  verifier("la case redevient cochée après rendu", await uneCase.isChecked());

  /* ---- Sans lait de vache ---- */
  await page.click('[data-onglet="plans"]');
  await page.check("[data-sans-lait]");
  await page.waitForTimeout(200);
  verifier("le régime est retenu sur le plan",
    !!(await page.evaluate(() => globalThis.bgfoods.etat.plans[0].sansLaitDeVache)));

  // Le plan est créé sans l'option cochée : on vérifie ici qu'un plan CRÉÉ avec
  // la case ne rapporte aucun produit au lait de vache.
  await page.fill("#plan-nom", "Sans lait");
  await page.check("#plan-sans-lait");
  await page.click("#btn-creer-plan");
  await page.waitForTimeout(250);
  const sansLait = await page.evaluate(() => {
    const p = globalThis.bgfoods.etat.plans.find((x) => x.nom === "Sans lait");
    return p && p.articles.map((a) => a.requete);
  });
  verifier("le plan sans lait est créé", Array.isArray(sansLait), JSON.stringify(sansLait));
  verifier("son panier ne contient ni lait ni yogourt",
    sansLait.every((r) => !/^lait |yogourt|cr[èe]me glac/i.test(r)), JSON.stringify(sansLait));
  await page.evaluate(() => {
    const p = globalThis.bgfoods.etat.plans.find((x) => x.nom === "Sans lait");
    globalThis.bgfoods.etat = {
      ...globalThis.bgfoods.etat,
      plans: globalThis.bgfoods.etat.plans.filter((x) => x.id !== p.id),
    };
  });
  await page.waitForTimeout(150);
  await page.uncheck("[data-sans-lait]");
  await page.waitForTimeout(200);

  /* ---- Budget ----
     Saisi en dollars, rangé en cents, appliqué à la génération. */
  await page.click('[data-onglet="plans"]');
  await page.fill("[data-budget]", "12");
  await page.press("[data-budget]", "Tab");
  await page.waitForTimeout(250);
  verifier("le budget est rangé en cents",
    (await page.evaluate(() => globalThis.bgfoods.etat.plans[0].budgetCents)) === 1200,
    String(await page.evaluate(() => globalThis.bgfoods.etat.plans[0].budgetCents)));

  await page.click('[data-onglet="liste"]');
  await page.click("#btn-generer");
  await page.waitForTimeout(250);
  const avecBudget = await page.evaluate(() => {
    const r = globalThis.bgfoods.resultat();
    return r && { total: r.total, budget: r.budgetCents, retires: r.retiresBudget.length,
      depasse: r.budgetDepasse };
  });
  verifier("le budget est appliqué au calcul", avecBudget && avecBudget.budget === 1200,
    JSON.stringify(avecBudget));
  verifier("le total respecte le budget, ou le dépassement est annoncé",
    avecBudget.total <= 1200 || avecBudget.depasse, JSON.stringify(avecBudget));
  verifier("la carte Budget s'affiche",
    (await page.locator("#resultat-liste").innerText()).includes("Budget"));

  await page.click('[data-onglet="plans"]');
  await page.click("[data-activer]");
  await page.waitForTimeout(150);
  verifier("le plan se désactive",
    await page.evaluate(() => !globalThis.bgfoods.etat.plans[0].actif));
  await page.click('[data-onglet="liste"]');
  verifier("la zone de saisie revient", !(await page.locator("#articles").isDisabled()));

  /* ---- Cocher une aubaine SANS aucun plan ----
     C'est l'état d'un compte qui n'a jamais ouvert l'onglet Plans, et c'était
     une impasse : la case exigeait un plan actif, n'en trouvait pas, et se
     décochait aussitôt. Vécu comme « je ne peux pas cocher ». */
  await page.evaluate(() => {
    globalThis.bgfoods.etat = { ...globalThis.bgfoods.etat, plans: [] };
  });
  await page.waitForTimeout(150);
  await page.click('[data-onglet="aubaines"]');
  verifier("sans plan, aucune case n'est cochée",
    !(await page.locator("[data-au-plan]").first().isChecked()));

  await page.locator("[data-au-plan]").first().check();
  await page.waitForTimeout(250);
  const cree = await page.evaluate(() => globalThis.bgfoods.etat.plans);
  verifier("cocher sans plan en crée un", cree.length === 1, JSON.stringify(cree.map((p) => p.nom)));
  verifier("et il est actif", !!cree[0].actif);
  verifier("l'aubaine cochée s'y trouve", (cree[0].articles || []).length === 1,
    JSON.stringify(cree[0].articles));
  // Le plan créé d'un clic part vide : treize articles surgis d'une case
  // seraient une mauvaise surprise, contrairement au bouton « Créer le plan ».
  verifier("il ne se garnit pas tout seul des spéciaux", cree[0].articles.length === 1);
  verifier("la case reste cochée", await page.locator("[data-au-plan]").first().isChecked());

  /* ---- Le parcours complet : cocher, voir, lancer ----
     Sans la barre d'action, on cochait sans voir où ça allait, puis il fallait
     changer d'onglet pour générer. */
  verifier("la barre annonce le plan et son compte",
    (await page.locator("#barre-plan-aubaines").innerText()).includes("Mon plan"));

  await page.locator("[data-au-plan]").nth(1).check();
  await page.waitForTimeout(200);
  verifier("le compte suit les cases cochées",
    (await page.locator("#barre-plan-aubaines").innerText()).includes("2 article"),
    await page.locator("#barre-plan-aubaines").innerText());

  await page.click("#btn-lancer-plan");
  await page.waitForTimeout(300);
  verifier("lancer bascule sur la liste", await page.locator("#vue-liste").isVisible());
  const lance = await page.evaluate(() => {
    const r = globalThis.bgfoods.resultat();
    return r && r.groupes.flatMap((g) => g.lignes.map((l) => l.requete))
      .concat(r.sansAubaine.map((l) => l.requete));
  });
  verifier("la liste contient les articles cochés", lance && lance.length === 2,
    JSON.stringify(lance));

  // « Ajuster le plan » mène à l'onglet Plans.
  await page.click('[data-onglet="aubaines"]');
  await page.click("#btn-ouvrir-plan");
  verifier("« Ajuster le plan » ouvre l'onglet Plans",
    await page.locator("#vue-plans").isVisible());
  await page.click('[data-onglet="aubaines"]');

  // Décocher ne doit pas recréer un plan par ricochet.
  await page.evaluate(() => {
    globalThis.bgfoods.etat = { ...globalThis.bgfoods.etat, plans: [] };
  });
  await page.waitForTimeout(150);
  const casesAvant = await page.locator("[data-au-plan]").count();
  verifier("les cases restent affichées sans plan", casesAvant > 0);

  verifier("aucune erreur JavaScript", erreursConsole.length === 0, erreursConsole.join(" | "));

  await navigateur.close();
  await new Promise((r) => serveur.close(r));

  console.log(`\n  ${reussis} vérification(s) passée(s) en navigateur`);
  if (echecs.length) {
    console.log(`  ${echecs.length} ÉCHEC(S) :`);
    for (const echec of echecs) console.log(`    ✗ ${echec}`);
    process.exit(1);
  }
  console.log("✅ Banc navigateur de BGFoods : tout passe.\n");
}

principal().catch((e) => {
  console.error("  ✗ Banc navigateur interrompu :", e);
  process.exit(1);
});
