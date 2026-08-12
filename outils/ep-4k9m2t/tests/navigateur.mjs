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
