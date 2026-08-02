/*
 * Banc d'essai du cloisonnement par mandat.
 *
 *   gjs outils/mk-7p3w9d/tests/mandat.js
 *
 * Même principe que les autres bancs : on EXTRAIT la fonction du vrai
 * `js/mandat.js` plutôt que d'en garder une copie qui divergerait.
 *
 * Ce qui est vérifié : `appartientAuMandat`, la règle qui décide si une section
 * écrite par un processus externe — le miroir de prospection, le lot LinkedIn —
 * s'affiche sous le mandat courant. Elle tient en trois lignes, et c'est
 * précisément le genre de règle qu'on croit évidente jusqu'à ce qu'elle montre
 * les prospects d'un mandat pendant qu'on travaille sur l'autre.
 *
 * Les deux « inconnu » doivent répondre OUI : sans mandat choisi on regarde
 * tout, et sans appartenance connue on préfère montrer que cacher. Cacher à
 * tort est le défaut le plus coûteux — on cherche une section qui existe
 * pourtant, et on finit par croire l'outil cassé.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

const ICI = GLib.path_get_dirname(new Error().fileName || '.');
const SRC = ICI + '/../js/mandat.js';

const [ok, bytes] = GLib.file_get_contents(SRC);
if (!ok) { print('  ✗ js/mandat.js introuvable'); System.exit(1); }
const source = new TextDecoder().decode(bytes);

function extraire(nom) {
  // « export function x( » aussi bien que « function x( » : le module en
  // exporte, et le banc doit suivre si l'un devient l'autre.
  const marque = 'function ' + nom + '(';
  const debut = source.indexOf(marque);
  if (debut < 0) throw new Error('fonction introuvable : ' + nom);
  if (source.indexOf(marque, debut + 1) >= 0) {
    throw new Error('« ' + nom + ' » est déclarée plus d\'une fois dans mandat.js.');
  }
  let i = source.indexOf('{', debut), profondeur = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') profondeur++;
    else if (source[i] === '}') { profondeur--; if (!profondeur) return source.slice(debut, i + 1); }
  }
  throw new Error('accolade non fermée : ' + nom);
}

const { appartientAuMandat } = new Function(
  extraire('appartientAuMandat') + '\nreturn { appartientAuMandat };'
)();

let reussis = 0, echoues = 0;
function verifier(nom, condition, detail) {
  if (condition) { reussis++; print('  ✓ ' + nom); }
  else { echoues++; print('  ✗ ' + nom + (detail ? ' — ' + detail : '')); }
}

print('');
print('Cloisonnement par mandat — ' + SRC);
print('');

const A = 'Mandat A', B = 'Mandat B';

verifier('le mandat courant est le propriétaire : on affiche',
         appartientAuMandat(A, A) === true);
verifier('un AUTRE mandat que le propriétaire : on cache',
         appartientAuMandat(B, A) === false);
verifier('« tous les mandats » : on affiche',
         appartientAuMandat('', A) === true);
verifier('propriétaire inconnu : on affiche plutôt que de cacher à tort',
         appartientAuMandat(A, '') === true);
verifier('les deux inconnus : on affiche',
         appartientAuMandat('', '') === true);

// Le cas qui a motivé le garde-fou : un mandat vide côté document ne doit pas
// se comparer par égalité, sinon toute section sans propriétaire disparaîtrait
// dès qu'un mandat est choisi — l'outil paraîtrait vidé de sa prospection.
verifier('un propriétaire vide ne se compare pas par égalité stricte',
         appartientAuMandat(A, undefined) === true && appartientAuMandat(A, null) === true);

// La casse et les espaces comptent : « MSI » et « msi » sont deux mandats
// différents pour le reste de l'outil (la liste naît des tâches saisies), et
// cette fonction ne doit pas prétendre le contraire.
verifier('la comparaison est stricte, sans normalisation de casse',
         appartientAuMandat('msi', 'MSI') === false);

print('');
print('  ' + reussis + ' réussis, ' + echoues + ' échoués');
print('');
if (echoues) System.exit(1);
