/*
 * Banc d'essai de la veille de prospection.
 *
 *   gjs outils/mk-7p3w9d/tests/fusion-veille.js
 *
 * Même principe que fusion.js : aucune copie de la logique ici, on EXTRAIT les
 * fonctions du vrai `js/veille.js`. Une copie divergerait, et un test qui teste
 * sa propre copie ne prouve rien.
 *
 * Deux familles de vérifications :
 *
 *   1. La fusion multi-appareils — les quatre façons de perdre du travail
 *      quand deux appareils modifient la même liste sans se voir. Le piège
 *      propre à cette page : elle a DEUX listes (pistes et groupes), et une
 *      fusion qui n'en traite qu'une perd l'autre en silence.
 *
 *   2. Le garde-fou Loi 25 — `normaliser` doit retirer tout champ nominatif
 *      qui arriverait d'un autre appareil ou d'une version future. C'est la
 *      promesse tenue par le code plutôt que par la discipline : si ce test
 *      tombe, la promesse est fausse.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

const ICI = GLib.path_get_dirname(new Error().fileName || '.');
const SRC = ICI + '/../js/veille.js';

const [ok, bytes] = GLib.file_get_contents(SRC);
if (!ok) { print('  ✗ js/veille.js introuvable'); System.exit(1); }
const source = new TextDecoder().decode(bytes);

function bloc(depuis) {
  let i = source.indexOf('{', depuis), profondeur = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') profondeur++;
    else if (source[i] === '}') { profondeur--; if (!profondeur) return i + 1; }
  }
  throw new Error('accolade non fermée à partir de ' + depuis);
}

function extraire(nom) {
  const marque = 'function ' + nom + '(';
  const debut = source.indexOf(marque);
  if (debut < 0) throw new Error('fonction introuvable : ' + nom);
  // Même précaution que dans fusion.js : indexOf prend la première occurrence
  // sans le dire. Deux déclarations du même nom, et le banc testerait l'une en
  // croyant tester l'autre.
  if (source.indexOf(marque, debut + 1) >= 0) {
    throw new Error('« ' + nom + ' » est déclarée plus d\'une fois dans veille.js.');
  }
  return source.slice(debut, bloc(debut));
}

function extraireConst(nom) {
  const marque = 'const ' + nom + ' = {';
  const debut = source.indexOf(marque);
  if (debut < 0) throw new Error('constante introuvable : ' + nom);
  return source.slice(debut, bloc(debut)) + ';';
}

const RETENTION = 90 * 24 * 3600 * 1000;
const prelude =
  'const RETENTION_TOMBSTONE = ' + RETENTION + ';\n' +
  'const maintenant = () => Date.now();\n' +
  extraireConst('TYPES') + '\n' +
  extraireConst('SOURCES') + '\n' +
  extraireConst('STATUTS') + '\n';

const contexte = new Function(
  prelude + extraire('VIDE') + '\n' + extraire('normaliser') + '\n' +
  extraire('elaguer') + '\n' + extraire('fusionner') +
  '\nreturn { VIDE, normaliser, elaguer, fusionner };'
)();
const { VIDE, normaliser, elaguer, fusionner } = contexte;

/* ── petit harnais ───────────────────────────────────────────── */
let reussis = 0, echoues = 0;
function verifier(nom, condition, detail) {
  if (condition) { reussis++; print('  ✓ ' + nom); }
  else { echoues++; print('  ✗ ' + nom + (detail ? ' — ' + detail : '')); }
}

const etat = (pistes, groupes, tombstones, updatedAt) => ({
  pistes: pistes || [], groupes: groupes || [],
  tombstones: tombstones || {}, updatedAt: updatedAt || 0,
});
const piste = (id, maj, extra) =>
  Object.assign({ id, maj, cree: maj, statut: 'repere', source: 'facebook',
                  type: 'pc_lent', ville: '', groupe: '', lien: '', note: '' }, extra || {});

print('');
print('Veille de prospection — ' + SRC);
print('');

/* ── 1. fusion multi-appareils ───────────────────────────────── */

{
  const a = etat([piste('p1', 100)]);
  const b = etat([piste('p2', 200)]);
  const f = fusionner(a, b);
  verifier('ajout croisé : les deux pistes survivent', f.pistes.length === 2,
           'obtenu ' + f.pistes.length);
}

{
  // Le piège propre à cette page : deux listes. Une fusion qui n'en traite
  // qu'une perd l'autre sans le dire.
  const a = etat([piste('p1', 100)], [{ id: 'g1', nom: 'Babillard', maj: 100 }]);
  const b = etat([], [{ id: 'g2', nom: 'Entraide', maj: 200 }]);
  const f = fusionner(a, b);
  verifier('les groupes sont fusionnés eux aussi', f.groupes.length === 2,
           'obtenu ' + f.groupes.length);
  verifier('fusionner les groupes ne perd pas les pistes', f.pistes.length === 1);
}

{
  const a = etat([piste('p1', 100, { statut: 'repere' })]);
  const b = etat([piste('p1', 300, { statut: 'rdv' })]);
  verifier('édition concurrente : le maj le plus récent gagne',
           fusionner(a, b).pistes[0].statut === 'rdv');
  verifier('édition concurrente : symétrique dans l\'ordre des arguments',
           fusionner(b, a).pistes[0].statut === 'rdv');
}

/*
 * À partir d'ici, des horodatages RÉALISTES et non des petits entiers : les
 * tombales passent par `elaguer`, qui compare à `Date.now() - 90 jours`. Avec
 * des valeurs comme 100 ou 500 — soit janvier 1970 — toute tombale est élaguée
 * et le test passerait ou tomberait pour une raison qui n'a rien à voir avec
 * ce qu'il prétend vérifier.
 */
const T = Date.now();
const HIER = T - 24 * 3600 * 1000;

{
  // A a supprimé p1 (tombale), B l'a encore. La tombale doit gagner.
  const a = etat([], [], { p1: T - 1000 });
  const b = etat([piste('p1', HIER)]);
  const f = fusionner(a, b);
  verifier('suppression : pas de résurrection par l\'autre appareil',
           f.pistes.length === 0, 'obtenu ' + f.pistes.length);
  verifier('suppression : la pierre tombale est conservée',
           f.tombstones.p1 === T - 1000, 'obtenu ' + f.tombstones.p1);
}

{
  // Recréée APRÈS la suppression : elle doit survivre.
  const a = etat([], [], { p1: T - 2000 });
  const b = etat([piste('p1', T - 500)]);
  verifier('recréation : un enregistrement plus récent que la tombale survit',
           fusionner(a, b).pistes.length === 1);
}

{
  const vieille = Date.now() - RETENTION - 60000;
  const recente = Date.now() - 60000;
  const f = elaguer({ vieux: vieille, neuf: recente });
  verifier('élagage : la tombale expirée est retirée', f.vieux === undefined);
  verifier('élagage : la tombale récente est gardée', f.neuf === recente);
}

{
  const a = etat([piste('p1', 100)], [{ id: 'g1', nom: 'X', maj: 100 }], { p9: Date.now() });
  const b = etat([piste('p2', 200)]);
  const un = fusionner(a, b);
  const deux = fusionner(un, fusionner(a, b));
  verifier('idempotence : fusionner deux fois donne le même état',
           JSON.stringify(un) === JSON.stringify(deux));
}

{
  const a = etat([piste('p1', 100)], [{ id: 'g1', nom: 'X', maj: 100 }]);
  verifier('un état vide n\'efface rien',
           fusionner(a, VIDE()).pistes.length === 1 && fusionner(a, VIDE()).groupes.length === 1);
  verifier('un état vide n\'efface rien (ordre inverse)',
           fusionner(VIDE(), a).pistes.length === 1 && fusionner(VIDE(), a).groupes.length === 1);
}

/* ── 2. garde-fou Loi 25 ─────────────────────────────────────── */

{
  // Le scénario réel : une version future, ou un appareil mal réglé, dépose une
  // piste avec le nom de la personne. La page promet de ne pas en conserver.
  const entrant = {
    pistes: [{ id: 'p1', maj: 100, cree: 100, statut: 'repere',
               nom: 'Une personne', profil: 'https://facebook.com/qqn',
               texte: 'le récit complet de la publication',
               lien: 'https://facebook.com/groups/1/posts/2' }],
    groupes: [], tombstones: {}, updatedAt: 100,
  };
  const n = normaliser(entrant);
  const p = n.pistes[0];
  verifier('Loi 25 : le nom est retiré à la lecture', p.nom === undefined);
  verifier('Loi 25 : le lien de profil est retiré', p.profil === undefined);
  verifier('Loi 25 : le texte recopié est retiré', p.texte === undefined);
  verifier('Loi 25 : le lien de la publication, lui, est conservé',
           p.lien === 'https://facebook.com/groups/1/posts/2');
}

{
  const n = normaliser({ pistes: [{ id: 'p1', maj: 1, statut: 'inventé',
                                    type: 'inventé', source: 'inventé' }] });
  const p = n.pistes[0];
  verifier('un statut inconnu retombe sur « repere »', p.statut === 'repere');
  verifier('un type inconnu retombe sur « autre »', p.type === 'autre');
  verifier('une source inconnue retombe sur « facebook »', p.source === 'facebook');
}

{
  verifier('une entrée sans id est écartée',
           normaliser({ pistes: [{ maj: 1 }, { id: 'ok', maj: 1 }] }).pistes.length === 1);
  verifier('un document illisible ne fait pas planter la normalisation',
           normaliser(null).pistes.length === 0 && normaliser('x').groupes.length === 0);
}

print('');
print('  ' + reussis + ' réussis, ' + echoues + ' échoués');
print('');
if (echoues) System.exit(1);
