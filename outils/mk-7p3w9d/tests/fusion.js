/*
 * Banc d'essai de la fusion multi-appareils.
 *
 *   gjs outils/mk-7p3w9d/tests/fusion.js
 *
 * Il n'y a pas de copie de la logique ici : le test EXTRAIT les fonctions du
 * vrai `js/app.js` et les exécute. Une copie divergerait, et un test qui teste
 * sa propre copie ne prouve rien.
 *
 * Ce qui est vérifié — les quatre façons dont deux appareils peuvent perdre
 * du travail : l'ajout croisé, l'édition concurrente, la résurrection d'un
 * enregistrement supprimé, et la suppression d'un enregistrement recréé.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

const ICI = GLib.path_get_dirname(new Error().fileName || '.');
const APP = ICI + '/../js/app.js';

const [ok, bytes] = GLib.file_get_contents(APP);
if (!ok) { print('  ✗ js/app.js introuvable'); System.exit(1); }
const source = new TextDecoder().decode(bytes);

/* Extraction des fonctions sous test, délimitées par leur déclaration et la
   déclaration suivante au niveau zéro. */
function extraire(nom) {
  const marque = 'function ' + nom + '(';
  const debut = source.indexOf(marque);
  if (debut < 0) throw new Error('fonction introuvable : ' + nom);
  // indexOf prend la PREMIÈRE occurrence, sans le dire. Si app.js déclarait un
  // jour deux fois le même nom, le banc testerait l'une en croyant tester
  // l'autre — et passerait au vert sur du code mort. Découvert en sabotant
  // app.js par ajout en fin de fichier : le banc n'a rien vu.
  if (source.indexOf(marque, debut + 1) >= 0) {
    throw new Error('« ' + nom + ' » est déclarée plus d\'une fois dans app.js : ' +
                    'le banc ne saurait pas laquelle il teste.');
  }
  let i = source.indexOf('{', debut), profondeur = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') profondeur++;
    else if (source[i] === '}') { profondeur--; if (!profondeur) return source.slice(debut, i + 1); }
  }
  throw new Error('accolade non fermée : ' + nom);
}

const RETENTION = 90 * 24 * 3600 * 1000;
const prelude = 'const RETENTION_TOMBSTONE = ' + RETENTION + ';\n' +
                'const maintenant = () => Date.now();\n';

const contexte = new Function(
  prelude + extraire('elaguer') + '\n' + extraire('fusionner') +
  '\nreturn { elaguer, fusionner };'
)();
const { fusionner, elaguer } = contexte;

/* ── petit harnais ───────────────────────────────────────────── */
let reussis = 0, echoues = 0;
function verifier(nom, condition, detail) {
  if (condition) { reussis++; print('  ✓ ' + nom); }
  else { echoues++; print('  ✗ ' + nom + (detail ? '\n      ' + detail : '')); }
}
/* Les horodatages doivent être RÉALISTES. Un `maj` de 300 (300 ms après 1970)
   se fait élaguer par la rétention de 90 jours, et le test échouerait pour une
   raison qui n'arrive jamais en production. T(n) situe donc les événements à
   quelques minutes d'intervalle, aujourd'hui. */
const T0 = Date.now() - 3600000;
const T = (n) => T0 + n * 60000;

const tache = (id, maj, extra) => Object.assign({ id, titre: 'T' + id, maj }, extra || {});
const etat = (taches, temps, tombstones) => ({
  taches: taches || [], temps: temps || [], tombstones: tombstones || {}, updatedAt: 0,
});
const ids = (l) => l.map((t) => t.id).sort().join(',');

print('\nFusion multi-appareils — ' + APP + '\n');

/* 1. Ajout croisé : chaque appareil a créé une tâche que l'autre ignore. */
{
  const r = fusionner(etat([tache('a', T(1))]), etat([tache('b', T(1))]));
  verifier('ajout croisé : les deux tâches survivent', ids(r.taches) === 'a,b', ids(r.taches));
}

/* 2. Édition concurrente : le plus récent gagne, sans perdre l'autre champ. */
{
  const r = fusionner(
    etat([tache('a', T(2), { titre: 'récent' })]),
    etat([tache('a', T(1), { titre: 'ancien' })]));
  verifier('édition concurrente : le maj le plus récent gagne',
    r.taches.length === 1 && r.taches[0].titre === 'récent',
    JSON.stringify(r.taches));
}
{
  // Symétrique : l'ordre des arguments ne doit rien changer.
  const r = fusionner(
    etat([tache('a', T(1), { titre: 'ancien' })]),
    etat([tache('a', T(2), { titre: 'récent' })]));
  verifier('édition concurrente : symétrique dans l\'ordre des arguments',
    r.taches.length === 1 && r.taches[0].titre === 'récent',
    JSON.stringify(r.taches));
}

/* 3. Suppression : l'appareil qui a encore l'enregistrement ne le ressuscite pas. */
{
  const r = fusionner(
    etat([], [], { a: T(3) }),         // appareil A l'a supprimée
    etat([tache('a', T(1))]));          // appareil B l'a encore
  verifier('suppression : pas de résurrection par l\'autre appareil',
    r.taches.length === 0, ids(r.taches));
  verifier('suppression : la pierre tombale est conservée', r.tombstones.a === T(3));
}

/* 4. Recréation après suppression : une tâche modifiée APRÈS la pierre
      tombale doit survivre — sinon toute réédition serait avalée. */
{
  const r = fusionner(
    etat([], [], { a: T(3) }),
    etat([tache('a', T(4))]));
  verifier('recréation : un enregistrement plus récent que la tombale survit',
    r.taches.length === 1, ids(r.taches));
}

/* 5. Le temps consigné suit exactement les mêmes règles. */
{
  const r = fusionner(
    etat([], [{ id: 'e1', minutes: 30, maj: T(1) }]),
    etat([], [{ id: 'e2', minutes: 45, maj: T(1) }]));
  verifier('temps : les deux entrées survivent',
    r.temps.length === 2 && r.temps.reduce((s, e) => s + e.minutes, 0) === 75);
}

/* 6. Élagage : une pierre tombale expirée disparaît, une récente reste. */
{
  const vieux = Date.now() - RETENTION - 86400000;
  const r = elaguer({ vieille: vieux, fraiche: Date.now() });
  verifier('élagage : la tombale expirée est retirée', r.vieille === undefined);
  verifier('élagage : la tombale récente est gardée', r.fraiche !== undefined);
}

/* 7. Idempotence : refusionner le résultat ne doit rien changer. */
{
  const a = etat([tache('a', T(1)), tache('b', T(2))], [], { c: T(3) });
  const b = etat([tache('b', T(1))]);
  const un = fusionner(a, b);
  const deux = fusionner(un, un);
  verifier('idempotence : fusionner deux fois donne le même état',
    JSON.stringify(un.taches) === JSON.stringify(deux.taches));
}

/* 8. Un état vide ne doit jamais vider l'autre — c'est le scénario qui a
      détruit des semaines de feuille de temps dans TimeCalculator. */
{
  const plein = etat([tache('a', T(1)), tache('b', T(1))], [{ id: 'e1', minutes: 60, maj: T(1) }]);
  const r = fusionner(plein, etat());
  verifier('un état vide n\'efface rien',
    r.taches.length === 2 && r.temps.length === 1);
  const r2 = fusionner(etat(), plein);
  verifier('un état vide n\'efface rien (ordre inverse)',
    r2.taches.length === 2 && r2.temps.length === 1);
}

/* 9. Réglages : ce n'est pas une liste, donc pas de fusion par enregistrement.
      Le côté le plus récemment enregistré gagne — mais un appareil qui n'a
      jamais eu de réglage ne doit pas effacer celui de l'autre en se
      synchronisant. Noms de mandats fictifs : le dépôt est public. */
{
  const avecReglage = { taches: [], temps: [], tombstones: {},
                        config: { mandatStme: 'Mandat A' }, updatedAt: T(2) };
  const sansReglage = { taches: [], temps: [], tombstones: {},
                        config: { mandatStme: '' }, updatedAt: T(5) };
  verifier('réglages : un appareil sans réglage n\'efface pas celui de l\'autre',
    fusionner(avecReglage, sansReglage).config.mandatStme === 'Mandat A',
    JSON.stringify(fusionner(avecReglage, sansReglage).config));

  const autreReglage = { taches: [], temps: [], tombstones: {},
                         config: { mandatStme: 'Mandat B' }, updatedAt: T(5) };
  verifier('réglages : entre deux réglages, le plus récent gagne',
    fusionner(avecReglage, autreReglage).config.mandatStme === 'Mandat B');
}

/* 10. Le début du plan suit les mêmes règles que le mandat suivi : un appareil
       sans la date ne l'efface pas, et entre deux dates le côté le plus
       récemment enregistré gagne. */
{
  const avecDate = { taches: [], temps: [], tombstones: {},
                     config: { mandatStme: 'Mandat A', debutPlan: '2026-06-01' }, updatedAt: T(2) };
  const sansDate = { taches: [], temps: [], tombstones: {},
                     config: { mandatStme: 'Mandat A', debutPlan: '' }, updatedAt: T(5) };
  verifier('réglages : un appareil sans date de début n\'efface pas celle de l\'autre',
    fusionner(avecDate, sansDate).config.debutPlan === '2026-06-01',
    JSON.stringify(fusionner(avecDate, sansDate).config));

  const autreDate = { taches: [], temps: [], tombstones: {},
                      config: { mandatStme: 'Mandat A', debutPlan: '2026-06-08' }, updatedAt: T(5) };
  verifier('réglages : entre deux dates de début, le plus récemment enregistré gagne',
    fusionner(avecDate, autreDate).config.debutPlan === '2026-06-08');
}

/* 11. Un état sans champ `config` du tout (document d'avant ce réglage) ne doit
       pas faire planter la fusion. */
{
  const ancien = { taches: [tache('a', T(1))], temps: [], tombstones: {}, updatedAt: T(1) };
  const neuf = { taches: [], temps: [], tombstones: {},
                 config: { mandatStme: 'Mandat A' }, updatedAt: T(2) };
  let r = null, plante = false;
  try { r = fusionner(ancien, neuf); } catch (e) { plante = true; }
  verifier('un document sans config ne fait pas planter la fusion',
    !plante && r.config.mandatStme === 'Mandat A' && r.taches.length === 1);
}

print('\n  ' + reussis + ' réussis, ' + echoues + ' échoués\n');
System.exit(echoues ? 1 : 0);
