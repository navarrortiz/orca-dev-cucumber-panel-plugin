import { createBridge } from './bridge.js';
import { createOrcaClient } from './orca.js';
import { createView } from './view.js';
import { createPanelChannel, readPanelData } from '../sdk/panel.js';
import { ACTION, NEW_TERMINAL } from '../shared/protocol.js';
import { describeContext, describeError, describeTerminals, itemMenu, filterProjects, toCommand, validateSend } from './lib/format.js';

// Composition root + controller: owns state, turns view intents into host calls.
const orca = createOrcaClient(createBridge(window));
const view = createView(document);

// __PROJECTS__ is scanned from projects.json at build time (scripts/build.mjs):
// [{ name, root, command, commands?, dir, error?, features: [{ file, name, line, tags, scenarios: [{ name, line, tags }] }] }]
const projects = __PROJECTS__;
// Messaging SDK (AGENTS.md "Messaging SDK"): __RPC_PATH__ = absolute path of dist/rpc.mjs (build-time);
// the data (terminal titles + carrier ids + last run results) is what the worker patched into this file.
const data = readPanelData(document);
const channel = createPanelChannel({ orca, cliPath: __RPC_PATH__, data });

let state = { summary: 'Cargando…', query: '', projects, visible: projects, status: '', busy: false, collapsed: new Set(), expanded: new Set(), results: data.results ?? {}, running: data.running ?? [] };
const setState = (patch) => view.render((state = { ...state, ...patch }));

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
// No carrier yet → say so instead of a popup: a refresh button that asks for a terminal is odd.
view.onRefresh(() =>
  run(async () => {
    setState({ summary: describeContext(await orca.readContext()) });
    const { sent, reason } = await channel.send(ACTION.reloadFeatures, {});
    if (sent) return 'Reescaneando features… (sin cambios = sin recarga)';
    return reason === 'rejected' ? 'La terminal portadora rechazó la petición' : 'El worker aún no está listo; reintenta en unos segundos';
  }),
);
view.onEditProjects(() =>
  run(async () => {
    const { sent, reason } = await channel.send(ACTION.editProjects, {});
    if (sent) return 'Abriendo projects.json…';
    return reason === 'rejected' ? 'La terminal portadora rechazó la petición' : 'El worker aún no está listo; reintenta en unos segundos';
  }),
);
// Feature keys (root\0file) and folder keys (root\0dir/) → collapsed (default open); scenario keys (root\0file:line) → expanded (default closed).
view.onToggle((key) => {
  const name = /:\d+$/.test(key) ? 'expanded' : 'collapsed';
  const set = new Set(state[name]);
  set.has(key) ? set.delete(key) : set.add(key);
  setState({ [name]: set });
});
view.onQuery((query) => setState({ query, visible: filterProjects(projects, query) }));

// Runs right away (Enter): the terminal shows the output; the plugin API can't read it back.
// Orca can't tell a plugin which terminal is focused: ⋯ → "Ejecutar…" always asks (the popup also
// offers "Terminal nueva", served by the worker).
async function chooseTerminal(point, withNew) {
  // Read fresh on every click: the focused worktree and its terminals change under us.
  const context = await orca.readContext();
  setState({ summary: describeContext(context) });
  const terminals = describeTerminals((context?.terminals ?? []).filter((t) => !channel.isCarrier(t.id)), data.titles);
  return view.choose(withNew ? terminals : terminals.filter((t) => t.id !== NEW_TERMINAL), point, 'Enviar a:');
}

async function typeInto(terminalId, text, done, enter = true) {
  const invalid = validateSend({ terminalId, text });
  if (invalid) return invalid;
  const { accepted } = await orca.sendText(terminalId, text, enter);
  return accepted ? done : 'La terminal rechazó el comando';
}

/**
 * Worker action through the SDK, no popup. No carrier in the focused worktree yet (worker not
 * running, or worktree focused < 15 s ago): ask for a terminal to carry it instead — never an agent
 * TUI, it would read the line as a prompt.
 */
async function sendAction(action, params, point, done) {
  const result = await channel.send(action, params);
  if (result.sent) return done;
  if (result.reason === 'rejected') return 'La terminal portadora rechazó la petición';
  const terminalId = await chooseTerminal(point, false);
  return terminalId === null ? '' : typeInto(terminalId, channel.command(action, params), done);
}

async function runIn(terminalId, { command, target, label, root }, point) {
  const text = toCommand(command, target);
  if (terminalId === null) return ''; // popup dismissed
  if (terminalId !== NEW_TERMINAL) return typeInto(terminalId, text, `Ejecutando: ${label}`);
  return sendAction(ACTION.runInTerminal, { root, command: text, title: label }, point, `Ejecutando: ${label} (terminal nueva)`);
}

// ▷ (row buttons, folders, run-all) always opens a new terminal; picking an existing one is ⋯ → "Ejecutar…".
view.onRun((payload, point) => run(() => runIn(NEW_TERMINAL, payload, point)));

// ■ on a running row: the worker SIGTERMs the cucumber-js processes of that target, wherever they run.
view.onStop(({ target, label }, point) => run(() => sendAction(ACTION.stopRun, { target }, point, `Deteniendo: ${label}`)));

// Sandboxed srcdoc iframe: the async Clipboard API may be blocked by permissions policy, so fall back to execCommand.
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

view.onReport(({ root }, point) => run(() => sendAction(ACTION.openReport, { root }, point, 'Abriendo el reporte HTML')));

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
    if (picked === 'open') return sendAction(ACTION.openFile, { root: payload.root, file: payload.file }, point, `Abriendo: ${payload.file}`);
    if (picked === 'report') return sendAction(ACTION.openReport, { root: payload.root }, point, 'Abriendo el reporte HTML');
    if (picked === 'run') return runIn(await chooseTerminal(point, true), payload, point);
    if (picked) return runIn(await chooseTerminal(point, true), { ...payload, command: picked }, point); // projects.json `commands`
    return '';
  }),
);

refresh();

// Panels get no worktree-changed event, so poll quietly: no busy state, no status reset, and no
// re-render unless the summary changed (re-rendering rebuilds the rows under the cursor).
// ponytail: 3 s poll ≈ 3 of the 30 messages / 10 s budget; switch to an event if Orca adds one.
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
