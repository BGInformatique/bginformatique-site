/*
 * Espace client — projet Firebase DISTINCT des outils internes.
 *
 * Pourquoi un deuxième projet : les comptes clients ne doivent pas exister
 * dans « bgtimecalculator », qui porte la feuille de temps et le tableau de
 * bord marketing. Un client connecté ici n'a aucune identité là-bas.
 *
 * À REMPLIR après la création du projet (voir LISEZ-MOI.md, étape 1).
 * Tant que « projectId » vaut la valeur d'amorce ci-dessous, la page affiche
 * « installation en cours » au lieu de planter : elle peut donc être publiée
 * avant que le projet existe.
 */
export const firebaseConfig = {
  apiKey: "À_REMPLIR",
  authDomain: "À_REMPLIR.firebaseapp.com",
  projectId: "À_REMPLIR",
  storageBucket: "À_REMPLIR.firebasestorage.app",
  messagingSenderId: "À_REMPLIR",
  appId: "À_REMPLIR",
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
