import { createOrcaClient } from './orca.js';
import { createView } from './view.js';
import { CARRIER_TITLE } from '../sdk/protocol.js';
import { ACTION, NEW_TERMINAL } from '../shared/protocol.js';
import { describeContext, describeError, describeTerminals, itemMenu, filterProjects, toCommand, validateSend } from './lib/format.js';

// Composition root + controller: owns state, turns view intents into host calls.
const orca = createOrcaClient(window.orca);
const view = createView(document);

// __PROJECTS__ is scanned from projects.json at build time (scripts/build.mjs):
// [{ name, root, command, commands?, dir, error?, features: [{ file, name, line, tags, scenarios: [{ name, line, tags }] }] }]
const projects = __PROJECTS__;
let state = { summary: 'Cargando…', query: '', projects, visible: projects, status: '', busy: false, folded: new Set(), collapsed: new Set(), expanded: new Set(), results: {}, running: [], titles: {} };
const setState = (patch) => view.render((state = { ...state, ...patch }));
setState({});

// Worker data (terminal titles, last run results, running targets; AGENTS.md "Messaging SDK"): the
// current snapshot now, then every change pushed by the worker. No panel reload.
orca.onData(({ titles = {}, results = {}, running = [] }) => setState({ titles, results, running })).catch((error) => setState({ status: describeError(error) }));

// View state in the plugin's storage: survives the reloads a rebuild causes and worker restarts.
// Saving waits for the restore, or the empty first render would overwrite it.
const viewState = () => JSON.stringify({ query: state.query, folded: [...state.folded], collapsed: [...state.collapsed], expanded: [...state.expanded], scrollY: Math.round(window.scrollY) });
let savedUi = null;
orca.loadUi().then(
  (ui) => {
    if (ui && typeof ui === 'object') {
      const query = typeof ui.query === 'string' ? ui.query : '';
      setState({ query, visible: filterProjects(projects, query), folded: new Set(ui.folded), collapsed: new Set(ui.collapsed), expanded: new Set(ui.expanded) });
      window.scrollTo(0, Number(ui.scrollY) || 0);
    }
    savedUi = viewState();
  },
  () => (savedUi = viewState()),
);
// Debounced, only on change, silent on failure: the next change retries.
let saveTimer;
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const json = viewState();
    if (savedUi === null || json === savedUi) return;
    orca.saveUi(JSON.parse(json)).then(() => (savedUi = json), () => {});
  }, 1000);
}
window.addEventListener('scroll', saveUi, { passive: true });

async function run(task) {
  setState({ busy: true });
  try {
    setState({ status: (await task()) ?? '' });
  } catch (error) {
    setState({ status: describeError(error) });
  } finally {
    setState({ busy: false });
  }
}

const refresh = () =>
  run(async () => {
    setState({ summary: describeContext(await orca.readContext()) });
  });

// Rescan through the worker: it rebuilds dist/ and Orca reloads the panel only if a file changed.
view.onRefresh(() =>
  run(async () => {
    setState({ summary: describeContext(await orca.readContext()) });
    await orca.send(ACTION.reloadFeatures);
    return 'Reescaneando features… (sin cambios = sin recarga)';
  }),
);
view.onEditProjects(() => run(() => sendAction(ACTION.editProjects, {}, 'Abriendo projects.json…')));
// Feature keys (root\0file) and folder keys (root\0dir/) → collapsed (default open); scenario keys (root\0file:line) → expanded (default closed).
view.onToggle((key) => {
  const name = /:\d+$/.test(key) ? 'expanded' : 'collapsed';
  const set = new Set(state[name]);
  set.has(key) ? set.delete(key) : set.add(key);
  setState({ [name]: set });
  saveUi();
});
// One flag per project instead of every key: "Colapsar todo" stays one entry however many folders.
// Fold also closes the scenario definitions; unfold leaves them as they are.
view.onFold((root, fold) => {
  const folded = new Set(state.folded);
  fold ? folded.add(root) : folded.delete(root);
  const others = (set) => new Set([...set].filter((key) => !key.startsWith(`${root}\0`)));
  setState({ folded, collapsed: others(state.collapsed), expanded: fold ? others(state.expanded) : state.expanded });
  saveUi();
});
view.onQuery((query) => {
  setState({ query, visible: filterProjects(projects, query) });
  saveUi();
});

// Runs right away (Enter): the terminal shows the output; the plugin API can't read it back.
// Orca can't tell a plugin which terminal is focused: ⋯ → "Ejecutar…" always asks (the popup also
// offers "Terminal nueva", served by the worker).
async function chooseTerminal(point, withNew) {
  // Read fresh on every click: the focused worktree and its terminals change under us.
  const context = await orca.readContext();
  setState({ summary: describeContext(context) });
  const terminals = describeTerminals((context?.terminals ?? []).filter((t) => t.title !== CARRIER_TITLE), state.titles);
  return view.choose(withNew ? terminals : terminals.filter((t) => t.id !== NEW_TERMINAL), point, 'Enviar a:');
}

async function typeInto(terminalId, text, done, enter = true) {
  const invalid = validateSend({ terminalId, text });
  if (invalid) return invalid;
  const { accepted } = await orca.sendText(terminalId, text, enter);
  return accepted ? done : 'La terminal rechazó el comando';
}

/** Worker action through the SDK (orca.plugin.request; Orca starts the worker if needed). */
async function sendAction(action, params, done) {
  await orca.send(action, params);
  return done;
}

async function runIn(terminalId, { command, target, label, root }) {
  const text = toCommand(command, target);
  if (terminalId === null) return ''; // popup dismissed
  if (terminalId !== NEW_TERMINAL) return typeInto(terminalId, text, `Ejecutando: ${label}`);
  return sendAction(ACTION.runInTerminal, { root, command: text, title: label }, `Ejecutando: ${label} (terminal nueva)`);
}

// ▷ (row buttons, folders, run-all) always opens a new terminal; picking an existing one is ⋯ → "Ejecutar…".
view.onRun((payload) => run(() => runIn(NEW_TERMINAL, payload)));

// ■ on a running row: the worker SIGTERMs the cucumber-js processes of that target, wherever they run.
view.onStop(({ target, label }) => run(() => sendAction(ACTION.stopRun, { target }, `Deteniendo: ${label}`)));

// Sandboxed plugin frame: the async Clipboard API may be blocked by permissions policy, so fall back to execCommand.
view.onCopy(({ text, label }) =>
  run(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) return 'No se pudo copiar al portapapeles';
    }
    return `Contexto copiado: ${label}`;
  }),
);

view.onReport(({ root }) => run(() => sendAction(ACTION.openReport, { root }, 'Abriendo el reporte HTML')));

// Folder / feature / scenario ⋯ menu (target = folder, file or file:line; folders have no file to open). files.open takes no line: opens at the top. The worker opens files through files.open, in the right worktree whatever the cwd.
view.onMore((payload, point) =>
  run(async () => {
    const picked = await view.choose(itemMenu(payload.commands, Boolean(payload.file)), point, payload.label);
    if (picked === 'send') {
      // Bracketed paste: shells and agent TUIs take the lines as one paste instead of running each; no Enter.
      // ponytail: an app without bracketed-paste mode shows the escape codes; plain text if that bites.
      const terminalId = await chooseTerminal(point, false);
      return terminalId === null ? '' : typeInto(terminalId, `\x1b[200~${payload.text}\x1b[201~`, `Referencia enviada: ${payload.label}`, false);
    }
    if (picked === 'open') return sendAction(ACTION.openFile, { root: payload.root, file: payload.file }, `Abriendo: ${payload.file}`);
    if (picked === 'report') return sendAction(ACTION.openReport, { root: payload.root }, 'Abriendo el reporte HTML');
    // Folder → its path; feature → its file; scenario (target file:line) → its file + name.
    if (picked === 'evidence') return sendAction(ACTION.openEvidence, { root: payload.root, path: payload.file ?? payload.target, ...(/:\d+$/.test(payload.target) && { scenario: payload.label }) }, `Evidencias: ${payload.label}`);
    if (picked === 'run') return runIn(await chooseTerminal(point, true), payload);
    if (picked) return runIn(await chooseTerminal(point, true), { ...payload, command: picked }); // projects.json `commands`
    return '';
  }),
);

refresh();

// Poll quietly: no busy state, no status reset, and no
// re-render unless the summary changed (re-rendering rebuilds the rows under the cursor).
// ponytail: 3 s poll ≈ 3 of the 120 messages / 10 s budget; orca.on("workspace.changed") could replace it.
const syncSummary = () =>
  orca.readContext().then(
    (context) => {
      const summary = describeContext(context);
      if (summary !== state.summary) setState({ summary });
    },
    () => {}, // transient failures: the next tick retries
  );
setInterval(() => document.hidden || state.busy || syncSummary(), 3000);
window.addEventListener('focus', syncSummary);
