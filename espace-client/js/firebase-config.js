/*
 * Espace client — projet Firebase DISTINCT des outils internes.
 *
 * Pourquoi un deuxième projet : les comptes clients ne doivent pas exister
 * dans « bgtimecalculator », qui porte la feuille de temps et le tableau de
 * bord marketing. Un client connecté ici n'a aucune identité là-bas.
 *
 * Le projet « WebsiteMaestro » (websitemaestro-872c7) a été créé le
 * 2026-08-13 et l'application web « Espace client » y est enregistrée : les
 * valeurs ci-dessous sont les vraies. Elles n'ont rien de secret — ce fichier
 * part dans le navigateur de chaque visiteur. Ce qui protège les données,
 * c'est l'authentification et les règles Firestore, jamais ces six lignes.
 *
 * La sentinelle plus bas reste en place : tant que « projectId » vaut la
 * valeur d'amorce, la page affiche « installation en cours » au lieu de
 * planter. Elle ne sert plus, mais elle coûte une ligne et elle resservira au
 * prochain montage.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyB7TkGN6OdC1E_HdIrEcwas-bpuUO65UDc",
  authDomain: "websitemaestro-872c7.firebaseapp.com",
  projectId: "websitemaestro-872c7",
  storageBucket: "websitemaestro-872c7.firebasestorage.app",
  messagingSenderId: "901431697368",
  appId: "1:901431697368:web:e665059c969c9575789cad",
};

/*
 * Locataire Entra ID de BG Informatique — le même que les outils internes.
 * Les clients y entrent comme INVITÉS (B2B) : ils gardent leur propre
 * courriel, leur propre mot de passe et leur propre MFA. C'est l'invitation
 * qui fait la porte : personne hors du locataire ne peut se connecter.
 *
 * Ce verrou se règle dans Entra ID (inscription d'application « locataire
 * unique »), jamais dans les règles Firestore — le paramètre « tenant »
 * ci-dessous part vers Microsoft et n'entre pas dans le jeton Firebase.
 */
export const MICROSOFT_TENANT_ID = "9e6d32d9-b9fb-43a9-8a96-cdd1e707ebac";

/* Sentinelle d'installation : voir le commentaire en tête. */
export const CONFIG_REMPLIE = !firebaseConfig.projectId.startsWith("À_REMPLIR");
