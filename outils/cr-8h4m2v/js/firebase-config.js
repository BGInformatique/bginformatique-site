// Même projet Firebase que les autres outils du site : un seul jeu de règles,
// un seul compte connecté, un seul endroit à surveiller. Ces valeurs sont
// publiques par nature — ce qui protège les données, ce sont les règles
// Firestore et la connexion Microsoft, jamais le secret de cette clé.
export const firebaseConfig = {
  apiKey: "AIzaSyCgYqytpoOLaRowG-LIgAEn0Kd_b0-bfgk",
  authDomain: "bgtimecalculator.firebaseapp.com",
  projectId: "bgtimecalculator",
  storageBucket: "bgtimecalculator.firebasestorage.app",
  messagingSenderId: "655087724240",
  appId: "1:655087724240:web:6de2ad7395c49be8c6e0d5",
};

export const MICROSOFT_TENANT_ID = "9e6d32d9-b9fb-43a9-8a96-cdd1e707ebac";
