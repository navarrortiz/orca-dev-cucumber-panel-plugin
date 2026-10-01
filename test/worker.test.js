import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFileSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseFeature, scanProject, validateProjects } from '../src/worker/features.js';
import { debounce, editProjects, reloadFeatures, reportErrors } from '../src/worker/handlers.js';
import activate, { deactivate } from '../src/worker/main.js';
import { orcaCliCandidates } from '../src/worker/orca.js';

const FEATURE = `# language: es
@tenant @citas
Característica: Reagendar una cita
  Como doctor

  Antecedentes:
    Dado que inició sesión

  @smoke
  Escenario: Reagendar desde la agenda
    Dado algo

  Esquema del escenario: Reagendar desde <origen>
    Cuando pide reagendar
    @slow
    Ejemplos:
      | origen |
`;

test('parseFeature reads Spanish titles, 1-based lines and own tags', () => {
  assert.deepEqual(parseFeature(FEATURE), {
    name: 'Reagendar una cita',
    line: 3,
    tags: ['@tenant', '@citas'],
    scenarios: [
      { keyword: 'Escenario', name: 'Reagendar desde la agenda', line: 10, tags: ['@smoke'], steps: ['Dado algo'] },
      { keyword: 'Esquema del escenario', name: 'Reagendar desde <origen>', line: 13, tags: [], steps: ['Cuando pide reagendar', 'Ejemplos:', '| origen |'] },
    ],
  });
});

test('parseFeature reads English keywords and ignores files without a feature', () => {
  const parsed = parseFeature('Feature: Login\n  Scenario Outline: bad <user>\n  Example: good');
  assert.deepEqual(parsed.scenarios.map((s) => [s.name, s.line]), [['bad <user>', 2], ['good', 3]]);
  assert.equal(parseFeature('# nothing here'), null);
});

test('validateProjects requires name, absolute root and a {target} command', () => {
  assert.deepEqual(validateProjects([{ name: 'a', root: '/x', command: 'npx cucumber-js {target}' }]), []);
  assert.deepEqual(validateProjects([{ name: '', root: 'rel', command: 'npx cucumber-js' }]), [
    '[0].name must be a non-empty string',
    '[0].root must be an absolute path',
    '[0].command must contain {target}',
  ]);
  assert.deepEqual(validateProjects([{ name: 'a', root: '/x', command: 'x {target}', commands: { Headed: 'x' } }]), ['[0].commands["Headed"] must contain {target}']);
  assert.deepEqual(validateProjects({}), ['must be an array of { name, root, command, features? }']);
});

test('scanProject lists features recursively with root-relative paths, and reports a missing folder', async () => {
  const root = await promisify(mkdtemp)(join(tmpdir(), 'cucumber-panel-'));
  await promisify(mkdir)(join(root, 'features/citas'), { recursive: true });
  await promisify(writeFile)(join(root, 'features/citas/reagendar.feature'), FEATURE);
  await promisify(writeFile)(join(root, 'features/citas/steps.ts'), '');
  const project = { name: 'p', root, command: 'x {target}' };
  const scanned = await scanProject(project);
  assert.deepEqual(scanned.features.map((f) => f.file), ['features/citas/reagendar.feature']);
  assert.equal(scanned.dir, 'features');
  const missing = await scanProject({ ...project, features: 'nope' });
  assert.match(missing.error, /^No existe .*nope$/);
  assert.deepEqual(missing.features, []);
});


test('editProjects creates the file if missing before opening it', async () => {
  const calls = [];
  await editProjects({ ensureProjects: async () => calls.push('ensure'), openInEditor: async () => calls.push('open') });
  assert.deepEqual(calls, ['ensure', 'open']);
});

test('reloadFeatures rebuilds', async () => {
  let built = 0;
  assert.deepEqual(await reloadFeatures({ rebuild: async () => built++ }), { reloaded: true });
  assert.equal(built, 1);
});

test('reportErrors notifies and rethrows', async () => {
  const notes = [];
  const notify = async (title, body) => void notes.push(body);
  await assert.rejects(reportErrors(notify, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(notes, ['boom']);
});

test('activate registers every worker command in the manifest', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'));
  const commands = new Map();
  await activate({ commands: { register: (id, fn) => commands.set(id, fn) }, host: { call: async () => {} }, log: () => {} }, '/tmp/cucumber-panel-test-none.json', '/tmp/cucumber-panel-test-none.html', { call: async () => { throw new Error('no Orca in tests'); } });
  deactivate();
  const declared = manifest.contributes.commands.filter((c) => !c.action).map((c) => c.id);
  assert.ok(commands.has('sdk-invoke'), 'the messaging SDK registers its entry command');
  assert.deepEqual([...commands.keys()].sort(), declared.sort());
});

test('debounce collapses a burst of calls into one', async () => {
  let calls = 0;
  const fn = debounce(() => calls++, 10);
  fn(); fn(); fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
});

test('orcaCliCandidates finds the CLI bundled with Orca on each platform', () => {
  assert.deepEqual(orcaCliCandidates('win32', 'C:\\Program Files\\Orca\\Orca.exe'), ['orca', 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe']);
  assert.deepEqual(orcaCliCandidates('darwin', '/Applications/Orca.app/Contents/MacOS/Orca'), ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca']);
  assert.deepEqual(orcaCliCandidates('linux', '/opt/orca/orca-ide'), ['orca', '/opt/orca/resources/bin/orca-ide']);
});
