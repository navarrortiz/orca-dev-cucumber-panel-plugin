import { fileURLToPath } from 'node:url';
import { COMMAND } from '../shared/protocol.js';
import { createDeps } from './orca.js';
import { debounce, editProjects, reloadFeatures, reportErrors } from './handlers.js';

let stopProjectsFile;
let stopFeatures;
let heartbeatTimer;

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
) {
  const deps = createDeps(ctx.host, projectsPath, panelPath);
  ctx.commands.register(COMMAND.editProjects, () => reportErrors(deps.notify, () => editProjects(deps)));
  ctx.commands.register(COMMAND.reloadFeatures, () => reportErrors(deps.notify, () => reloadFeatures(deps)));

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
    ctx.log(`watching ${projects.length} project(s)`);
    return projects;
  };
  stopProjectsFile = deps.watchProjectsFile(() => {
    rebuild();
    watchFeatures();
  });
  heartbeatTimer = setInterval(() => deps.heartbeat().catch(() => {}), HEARTBEAT_MS);
  // Orca only starts the worker on demand: catch up on edits made while it wasn't running.
  // Only when stale: rewriting dist/ reloads the plugin, so an unconditional build could loop.
  // Not awaited: commands must register before activate resolves, a build takes a second.
  watchFeatures()
    .then((projects) => deps.isPanelStale(projects))
    .then((stale) => stale && rebuild(), (error) => ctx.log(`stale check failed: ${error.message}`));
}

export function deactivate() {
  stopProjectsFile?.();
  stopFeatures?.();
  clearInterval(heartbeatTimer);
}
