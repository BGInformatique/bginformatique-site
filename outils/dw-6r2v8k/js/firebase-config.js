/*
 * Demandes web — vue du propriétaire.
 *
 * Ce fichier pointe le projet des OUTILS INTERNES (« bgtimecalculator »), pas
 * celui de l'espace client. Ce n'est pas une inattention :
 *
 *   - les demandes des clients vivent dans le projet de l'espace client ;
 *   - le pont de BG001 les recopie dans users/<uid>/clientsweb/state ICI ;
 *   - cette page ne lit donc que le dossier du propriétaire, avec la même
 *     règle « propriétaire seul » que TimeCalculator et le marketing.
 *
 * Résultat : aucune règle inter-utilisateurs à écrire nulle part, et le
 * principe d'anti-verrouillage des outils internes reste entier — l'accès du
 * propriétaire ne dépend que de request.auth.uid == uid.
 *
 * Mêmes valeurs que outils/mk-7p3w9d/js/firebase-config.js. Elles sont
 * dupliquées plutôt qu'importées : chaque outil reste déplaçable seul, et
 * c'est déjà la convention du dépôt.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyCgYqytpoOLaRowG-LIgAEn0Kd_b0-bfgk",
  authDomain: "bgtimecalculator.firebaseapp.com",
  projectId: "bgtimecalculator",
  storageBucket: "bgtimecalculator.firebasestorage.app",
  messagingSenderId: "655087724240",
  appId: "1:655087724240:web:6de2ad7395c49be8c6e0d5",
};

export const MICROSOFT_TENANT_ID = "9e6d32d9-b9fb-43a9-8a96-cdd1e707ebac";
