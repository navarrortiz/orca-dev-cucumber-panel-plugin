import { fileURLToPath } from 'node:url';
import { createRuntime, OrcaRpc } from '../sdk/runtime.js';
import { requireAbsolute, requireString } from '../sdk/actions.js';
import { createWorkerChannel } from '../sdk/worker.js';
import { ACTION, CARRIER_TITLE, COMMAND } from '../shared/protocol.js';
import { actions } from './actions.js';
import { createDeps } from './orca.js';
import { debounce, editProjects, openReport, refreshResults, reloadFeatures, reportErrors, stopRun, watchRunning } from './handlers.js';

let stopProjectsFile;
let stopFeatures;
let stopReports;
let stopRunning;
let heartbeatTimer;
let channel;
let deps;

// Orca reaps a worker after 5 min without IPC activity (idleReapMs, Orca 1.4.216), which would
// kill the watchers. ponytail: ping every 4 min; drop it if Orca adds long-lived workers.
const HEARTBEAT_MS = 4 * 60_000;

// Worker entry: Orca forks a Node process, imports this module and calls the
// default export once with ctx = { commands, events, host, grantedCapabilities, log }.
// Keep this file wiring-only; logic lives in handlers.js.
// __PROJECTS_PATH__ = absolute path of the repo's projects.json, inlined by scripts/build.mjs.
// panel.html sits next to this bundle in dist/.
export default async function activate(
  ctx,
  projectsPath = __PROJECTS_PATH__,
  panelPath = fileURLToPath(new URL('panel.html', import.meta.url)),
  rpc = OrcaRpc.shared,
) {
  deps = createDeps(ctx.host, projectsPath, panelPath);
  ctx.commands.register(COMMAND.editProjects, () => reportErrors(deps.notify, () => editProjects(deps)));
  ctx.commands.register(COMMAND.reloadFeatures, () => reportErrors(deps.notify, () => reloadFeatures(deps)));
  // Messaging SDK: registers `sdk-invoke` (panel / CLI → actions.js) and keeps the carrier terminals
  // + terminal titles patched into panel.html (AGENTS.md "Messaging SDK").
  // ponytail: 15 s poll, one RPC each; switch to an event if Orca ever emits terminal changes.
  // Last results per scenario (results.json), shown as a dot in the panel; see results.js.
  const results = await deps.readResults();
  let running = []; // targets of live cucumber-js processes → spinner in the panel
  channel = createWorkerChannel({
    ctx,
    runtime: createRuntime(rpc),
    panelPath,
    data: () => ({ results, running }),
    // Needs this worker's rebuild: wired here, not in actions.js.
    actions: {
      ...actions,
      [ACTION.editProjects]: { description: 'Abre projects.json en Orca (lo crea si falta)', run: () => editProjects(deps) },
      [ACTION.reloadFeatures]: { description: 'Reescanea los .feature; el panel solo se recarga si algo cambió', run: () => reloadFeatures(deps) },
      [ACTION.openReport]: { description: 'Abre el reporte HTML de cucumber de { root } en el navegador de Orca', run: (params, { runtime }) => openReport(deps, runtime, requireAbsolute(ACTION.openReport, params, 'root')) },
      [ACTION.stopRun]: { description: 'Detiene (SIGTERM) los cucumber-js vivos de { target } (file o file:line)', run: (params) => stopRun(deps, requireString(ACTION.stopRun, params, 'target')) },
    },
    carrierTitle: CARRIER_TITLE,
    onError: (error) => deps.notify('Cucumber Features', String(error.message)).catch(() => {}),
  });

  // The panel bakes the feature list in at build time: rebuild dist/ on every change and Orca
  // (dev plugin path) reloads the panel. Never let a failed build reject: that kills the worker.
  const rebuild = debounce(
    () => reportErrors(deps.notify, deps.rebuild).catch((error) => ctx.log(`rebuild failed: ${error.message}`)),
    300,
  );
  // projects.json decides which folders to watch: re-arm the feature watchers when it changes.
  const watchFeatures = async () => {
    const projects = await deps.readProjects();
    stopFeatures?.();
    stopFeatures = deps.watchFeatures(projects, rebuild);
    stopReports?.();
    stopReports = deps.watchReports(projects, (project) => syncResults([project]));
    ctx.log(`watching ${projects.length} project(s)`);
    return projects;
  };
  // A finished run rewrote a report: merge it and push the dots to the panel (one reload per run).
  const syncResults = (projects) =>
    refreshResults(deps, projects, results)
      .then((changed) => changed && channel.sync())
      .catch((error) => ctx.log(`results: ${error.message}`));
  // ponytail: `ps` every 2 s; the panel only reloads when a run starts or ends.
  stopRunning = watchRunning(deps, (targets) => {
    running = targets;
    channel.sync();
  });
  stopProjectsFile = deps.watchProjectsFile(() => {
    rebuild();
    watchFeatures();
  });
  heartbeatTimer = setInterval(() => deps.heartbeat().catch(() => {}), HEARTBEAT_MS);
  // Only while the worker lives: Orca starts it on the first command.
  channel.start();
  // Orca only starts the worker on demand: catch up on edits made while it wasn't running.
  // Only when stale: rewriting dist/ reloads the plugin, so an unconditional build could loop.
  // Not awaited: commands must register before activate resolves, a build takes a second.
  watchFeatures()
    .then((projects) => (syncResults(projects), deps.isPanelStale(projects)))
    .then((stale) => stale && rebuild(), (error) => ctx.log(`stale check failed: ${error.message}`));
}

export function deactivate() {
  stopProjectsFile?.();
  stopFeatures?.();
  stopReports?.();
  stopRunning?.();
  deps?.stopServer();
  clearInterval(heartbeatTimer);
  channel?.stop();
}
