/*
 * BGFoods — faire lire les pages d'une circulaire par un modèle de vision.
 *
 * POURQUOI DES ADRESSES, PAS DES IMAGES. Les JPEG de circulaires.com n'ont pas
 * d'en-tête CORS : le navigateur peut les AFFICHER mais pas lire leurs octets.
 * Impossible, donc, de les encoder en base64 depuis la page. On transmet
 * l'adresse, et c'est le serveur d'Anthropic qui va chercher l'image
 * (source « url »). Ça tombe bien : ça évite aussi de faire transiter un
 * mégaoctet par page dans le navigateur.
 *
 * DEUX VOIES, PARCE QUE LA PAGE EST PUBLIQUE.
 *
 *   1. Avec votre clé. Elle vit dans le localStorage de VOTRE navigateur et
 *      n'est jamais écrite dans le code : cet outil est servi tel quel sur
 *      bginformatique.ca, une clé déposée ici serait lisible par n'importe qui.
 *      Cette voie est facturée par Anthropic, séparément d'un abonnement Claude.
 *
 *   2. Sans clé. On prépare un ordre à coller dans une session Claude Code
 *      ouverte sur votre poste. Rien n'est facturé — c'est l'abonnement qui
 *      travaille. La réponse revient dans la boîte « Coller le texte ».
 *
 * POURQUOI DU TEXTE PLUTÔT QU'UN FORMAT STRUCTURÉ. Le modèle rend les mêmes
 * lignes qu'on saisirait à la main ; c'est analyseur.js, déjà éprouvé, qui les
 * lit. Un seul analyseur à maintenir, et la sortie de l'IA reste vérifiable à
 * l'œil avant d'entrer dans les données.
 */
"use strict";

const CLE_STOCKAGE = "bgfoods.cle-anthropic";
export const MODELE_DEFAUT = "claude-sonnet-5";
export const POINT_API = "https://api.anthropic.com/v1/messages";

export class ErreurExtraction extends Error {}

/* ---------- La clé ---------- */

export function cleStockee() {
  try {
    return localStorage.getItem(CLE_STOCKAGE) || "";
  } catch (e) {
    return "";
  }
}

export function enregistrerCle(cle) {
  try {
    if (cle) localStorage.setItem(CLE_STOCKAGE, cle.trim());
    else localStorage.removeItem(CLE_STOCKAGE);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- La consigne ---------- */

export const CONSIGNE = `Tu lis une page de circulaire d'épicerie québécoise.

Rends UNE LIGNE PAR ARTICLE EN RABAIS, rien d'autre : pas de titre, pas de
puce, pas de commentaire, pas de ligne vide.

Chaque ligne : le nom du produit, son format s'il est écrit, puis le prix,
exactement comme la circulaire l'affiche. Exemples de la forme attendue :

Fraises du Québec 454 g 2,99 $
Poitrines de poulet désossées 3,99 $/lb
2/5,00 $ Yogourt Source 16 x 100 g
Fromage Cheddar Perron 320-500 g 8,99 $
Pain Bon Matin 675 g 99 ¢

Règles :
- Recopie le prix tel quel : « /lb », « /kg », « 2 pour 6,00 $ », « 99 ¢ ».
- Garde le format (454 g, 12 x 355 ml, 1,89 L, 6 unités) dans le nom.
- N'invente aucun prix. Si un prix est illisible, saute l'article.
- Ignore les prix barrés, les « Rég. », les cartes de fidélité, la publicité
  qui n'est pas un aliment, et les points bonis.
- Si la page ne contient aucun article en rabais, ne rends rien du tout.`;

/* ---------- Voie 1 : la clé ---------- */

/**
 * Fait lire une page par le modèle. Rend le texte brut des lignes d'aubaines.
 * `envoyer` est injectable pour que le banc d'essai n'appelle pas l'API.
 */
export async function lirePage(urlImage, options = {}) {
  const cle = options.cle || cleStockee();
  if (!cle) throw new ErreurExtraction("Aucune clé Anthropic enregistrée.");
  const envoyer = options.envoyer || ((u, i) => fetch(u, i));

  const reponse = await envoyer(POINT_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cle,
      "anthropic-version": "2023-06-01",
      // Sans cet en-tête, l'API refuse les appels venant d'un navigateur.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal: options.signal,
    body: JSON.stringify({
      model: options.modele || MODELE_DEFAUT,
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: urlImage } },
          { type: "text", text: CONSIGNE },
        ],
      }],
    }),
  });

  if (!reponse.ok) {
    let detail = "";
    try {
      detail = ((await reponse.json()).error || {}).message || "";
    } catch (e) { /* la réponse d'erreur n'était pas du JSON */ }
    if (reponse.status === 401) {
      throw new ErreurExtraction("Clé refusée par Anthropic (401). Vérifiez-la.");
    }
    if (reponse.status === 429) {
      throw new ErreurExtraction("Anthropic limite le débit (429). Réessayez dans un instant.");
    }
    throw new ErreurExtraction(`Anthropic a répondu ${reponse.status}. ${detail}`.trim());
  }

  const corps = await reponse.json();
  return (corps.content || [])
    .filter((bloc) => bloc.type === "text")
    .map((bloc) => bloc.text)
    .join("\n")
    .trim();
}

/**
 * Fait lire toutes les pages d'une circulaire, l'une après l'autre.
 * En série et non en parallèle : c'est plus lent, mais ça ne déclenche pas les
 * limites de débit et ça permet d'afficher l'avancement page par page.
 */
export async function lireCirculaire(pages, options = {}) {
  const surProgres = options.surProgres || (() => {});
  const morceaux = [];
  const echecs = [];
  for (let i = 0; i < pages.length; i++) {
    surProgres({ page: i + 1, total: pages.length, etat: "en cours" });
    try {
      const texte = await lirePage(pages[i], options);
      if (texte) morceaux.push(texte);
      surProgres({ page: i + 1, total: pages.length, etat: "lue", lignes: texte ? texte.split("\n").length : 0 });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      echecs.push({ page: i + 1, raison: e.message });
      surProgres({ page: i + 1, total: pages.length, etat: "échec", raison: e.message });
    }
  }
  return { texte: morceaux.join("\n"), echecs };
}

/* ---------- Voie 2 : la session Claude Code ---------- */

/** L'ordre à coller dans un terminal Claude Code ouvert sur le poste. */
export function ordrePourTerminal(circulaire, urls) {
  const dates = circulaire.validite && circulaire.validite.debut
    ? `valide du ${circulaire.validite.debut} au ${circulaire.validite.fin}`
    : "dates non détectées";
  return [
    `Lis ces ${urls.length} page(s) de la circulaire ${circulaire.epicerie} (${dates}) `
      + `et rends-moi les aubaines, une par ligne, sous la forme `
      + `« Fraises du Québec 454 g 2,99 $ » ou « Poitrines de poulet 3,99 $/lb » `
      + `ou « 2/5,00 $ Yogourt Source 16 x 100 g ». `
      + `Recopie les prix tels quels (/lb, /kg, ¢). N'invente rien, ignore les prix barrés. `
      + `Rends uniquement les lignes, sans titre ni commentaire.`,
    "",
    ...urls,
  ].join("\n");
}

/* ---------- Estimation ---------- */

/**
 * Coût approximatif d'une lecture, pour que le bouton ne soit pas un saut dans
 * le vide. Une page de circulaire pleine résolution coûte à peu près 4 800
 * jetons d'entrée une fois redimensionnée, et la réponse est courte.
 */
export function coutApproximatif(nbPages, modele = MODELE_DEFAUT) {
  const tarifs = {
    "claude-sonnet-5": { entree: 2, sortie: 10 },
    "claude-opus-5": { entree: 5, sortie: 25 },
    "claude-haiku-4-5": { entree: 1, sortie: 5 },
  };
  const t = tarifs[modele] || tarifs["claude-sonnet-5"];
  const dollars = nbPages * (4800 * t.entree + 700 * t.sortie) / 1e6;
  return dollars;
}
