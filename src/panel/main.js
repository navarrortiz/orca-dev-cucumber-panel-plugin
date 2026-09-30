import { createBridge } from './bridge.js';
import { createOrcaClient } from './orca.js';
import { createView } from './view.js';
import { describeContext, describeError, describeTerminals, filterProjects, toCommand, validateSend } from './lib/format.js';

// Composition root + controller: owns state, turns view intents into host calls.
const orca = createOrcaClient(createBridge(window));
const view = createView(document);

// __PROJECTS__ is scanned from projects.json at build time (scripts/build.mjs):
// [{ name, command, dir, error?, features: [{ file, name, line, tags, scenarios: [{ name, line, tags }] }] }]
const projects = __PROJECTS__;

let state = { summary: 'Cargando…', query: '', projects, visible: projects, status: '', busy: false };
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

view.onRefresh(refresh);
view.onQuery((query) => setState({ query, visible: filterProjects(projects, query) }));

// Runs right away (Enter): the terminal shows the output; the plugin API can't read it back.
// Orca can't tell a plugin which terminal is focused: ask when there's more than one.
view.onRun(({ command, target, label }, point) =>
  run(async () => {
    // Read fresh on every click: the focused worktree and its terminals change under us.
    const context = await orca.readContext();
    setState({ summary: describeContext(context) });
    const terminals = describeTerminals(context?.terminals ?? []);
    const terminalId = terminals.length > 1 ? await view.chooseTerminal(terminals, point) : terminals[0]?.id ?? '';
    if (terminalId === null) return ''; // popup dismissed
    const send = { terminalId, text: toCommand(command, target) };
    const invalid = validateSend(send);
    if (invalid) return invalid;
    const { accepted } = await orca.sendText(send.terminalId, send.text, true);
    return accepted ? `Ejecutando: ${label}` : 'La terminal rechazó el comando';
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
