/*
 * Banc de rendu : ouvre la vraie page avec un vrai état et en tire des images.
 *
 * POURQUOI CE FICHIER EXISTE. Le validateur de palette vérifie les couleurs, pas
 * la mise en page. Étiquettes qui se chevauchent, barre qui déborde de sa carte,
 * axe coupé par une hauteur fixe : rien de tout cela ne se voit dans le code, et
 * tout se voit sur une image. Ce banc sert donc à REGARDER la page avant de la
 * publier.
 *
 * Il n'invente aucune donnée : l'état vient de
 *   python3 -m bg_courriel collecter --json
 * c'est-à-dire des vraies boîtes. Un jeu de données inventé donnerait une page
 * jolie et fausse — les problèmes de mise en page viennent justement des vrais
 * objets de courriels, longs et accentués.
 *
 * Usage :
 *   cd .../BGCourriel && python3 -m bg_courriel collecter --json > /tmp/etat.json
 *   node tests/apercu.mjs /tmp/etat.json [dossier-de-sortie]
 *
 * Rien n'est écrit dans le dépôt : les images vont dans le dossier indiqué
 * (/tmp par défaut).
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const OUTIL = path.dirname(ICI);
const cheminEtat = process.argv[2];
const sortie = process.argv[3] || "/tmp";

if (!cheminEtat) {
  console.error("usage : node tests/apercu.mjs <etat.json> [dossier-de-sortie]");
  process.exit(2);
}

const etat = JSON.parse(await readFile(cheminEtat, "utf8"));

// La carte d'imports détourne Firebase vers les bouchons, exactement comme le
// banc des autres outils. Le HTML servi est le VRAI index.html, à cette
// injection près : si la page change, le banc suit sans qu'on y touche.
const INJECTION = `
  <script type="importmap">
  {
    "imports": {
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js": "/tests/bouchons/firebase-app.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js": "/tests/bouchons/firebase-auth.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js": "/tests/bouchons/firebase-firestore.js"
    }
  }
  </script>
  <script>
    window.__erreurs = [];
    window.addEventListener("error", (e) => window.__erreurs.push(
      (e.message || "?") + " @ " + (e.filename || "") + ":" + (e.lineno || "")));
    window.addEventListener("unhandledrejection", (e) => window.__erreurs.push(
      "promesse rejetée : " + ((e.reason && e.reason.stack) || e.reason)));
  </script>
`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const serveur = createServer(async (requete, reponse) => {
  try {
    const url = new URL(requete.url, "http://localhost");
    let relatif = decodeURIComponent(url.pathname);
    if (relatif === "/" || relatif === "") relatif = "/index.html";
    const absolu = path.join(OUTIL, relatif);
    // Aucune sortie du dossier de l'outil, même par « .. » : ce serveur ne
    // tourne qu'en local, mais un banc qui sert tout le disque est une mauvaise
    // habitude à ne pas prendre.
    if (!absolu.startsWith(OUTIL)) {
      reponse.writeHead(403).end("hors du dossier");
      return;
    }
    let contenu = await readFile(absolu);
    if (relatif === "/index.html") {
      contenu = Buffer.from(
        contenu.toString("utf8").replace("</head>", `${INJECTION}</head>`), "utf8");
    }
    reponse.writeHead(200, { "Content-Type": TYPES[path.extname(absolu)] || "application/octet-stream" });
    reponse.end(contenu);
  } catch {
    reponse.writeHead(404).end("absent");
  }
});

await new Promise((resoudre) => serveur.listen(0, "127.0.0.1", resoudre));
const port = serveur.address().port;

const navigateur = await chromium.launch();
const images = [];
let echecs = 0;

for (const theme of ["light", "dark"]) {
  const contexte = await navigateur.newContext({
    viewport: { width: 1180, height: 1400 },
    colorScheme: theme,
    deviceScaleFactor: 2,
    locale: "fr-CA",
  });
  const page = await contexte.newPage();
  const erreursConsole = [];
  page.on("console", (m) => {
    if (m.type() === "error") erreursConsole.push(m.text());
  });
  page.on("pageerror", (e) => erreursConsole.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
  // L'ouverture de session du bouchon est asynchrone, comme la vraie.
  await page.waitForFunction(() => globalThis.__bouchon && globalThis.__bouchon.abonnements > 0);
  await page.evaluate((donnees) => {
    globalThis.__bouchon.emettreInstantane({ existe: true, donnees });
  }, etat);
  await page.waitForSelector("main:not([hidden])");
  await page.waitForFunction(() => {
    const el = document.getElementById("hero-action");
    return el && el.textContent !== "—";
  });

  const chemin = path.join(sortie, `apercu-${theme}.png`);
  await page.screenshot({ path: chemin, fullPage: true });
  images.push(chemin);

  // Un débordement horizontal du corps est un défaut de mise en page qu'aucune
  // relecture de code ne montre. On le mesure au lieu de l'espérer.
  const debordement = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const erreursPage = await page.evaluate(() => globalThis.__erreurs || []);

  console.log(`\n── thème ${theme} ─────────────────────────────`);
  console.log(`  image : ${chemin}`);
  console.log(`  débordement horizontal : ${debordement} px`);
  if (debordement > 0) {
    console.log("  ✗ la page défile horizontalement — à corriger");
    echecs += 1;
  }
  for (const erreur of [...erreursPage, ...erreursConsole]) {
    console.log(`  ✗ erreur : ${erreur}`);
    echecs += 1;
  }

  // La vue en tableaux doit se dessiner elle aussi : c'est le jumeau qui rend
  // chaque valeur lisible sans survol.
  await page.click("#btn-tableaux");
  await page.waitForSelector("#table-categories-boite:not([hidden])");
  const lignesTableau = await page.evaluate(() =>
    document.querySelectorAll("#table-categories tbody tr").length);
  console.log(`  vue en tableaux : ${lignesTableau} ligne(s) de catégories`);
  if (!lignesTableau) {
    console.log("  ✗ la vue en tableaux est vide");
    echecs += 1;
  }
  await page.screenshot({ path: path.join(sortie, `apercu-${theme}-tableaux.png`), fullPage: true });

  await contexte.close();
}

// Écran étroit : c'est là que les étiquettes se chevauchent et que les cartes
// débordent.
const contexte = await navigateur.newContext({
  viewport: { width: 390, height: 1200 }, colorScheme: "light",
  deviceScaleFactor: 2, locale: "fr-CA",
});
const page = await contexte.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
await page.waitForFunction(() => globalThis.__bouchon && globalThis.__bouchon.abonnements > 0);
await page.evaluate((donnees) => {
  globalThis.__bouchon.emettreInstantane({ existe: true, donnees });
}, etat);
await page.waitForSelector("main:not([hidden])");
const debordementEtroit = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
await page.screenshot({ path: path.join(sortie, "apercu-etroit.png"), fullPage: true });
console.log(`\n── écran étroit (390 px) ──────────────────────`);
console.log(`  image : ${path.join(sortie, "apercu-etroit.png")}`);
console.log(`  débordement horizontal : ${debordementEtroit} px`);
if (debordementEtroit > 0) {
  console.log("  ✗ la page défile horizontalement sur téléphone");
  echecs += 1;
}
await contexte.close();

await navigateur.close();
serveur.close();

console.log(`\n${echecs === 0 ? "✅ aucun défaut mesuré" : `❌ ${echecs} défaut(s)`}`);
process.exit(echecs === 0 ? 0 : 1);
