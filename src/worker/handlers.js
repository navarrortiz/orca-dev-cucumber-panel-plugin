import { mergeReport, parseReport, runningPids, runningTargets } from './results.js';

// Business logic of the worker. Takes plain deps (fs + editor + notify), returns
// plain values — no ctx, no IPC, so it runs under node:test with fakes.

export async function editProjects({ ensureProjects, openInEditor }) {
  await ensureProjects();
  await openInEditor();
  return { opened: true };
}

/** Rebuilds dist/ so the panel picks up new, renamed or deleted features. */
export async function reloadFeatures({ rebuild }) {
  await rebuild();
  return { reloaded: true };
}

/** Editors fire several fs events per save; run fn once they settle. */
export function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** Commands have no UI of their own: surface failures as a notification, then rethrow. */
export async function reportErrors(notify, task) {
  try {
    return await task();
  } catch (error) {
    await notify('Cucumber Features', String(error?.message ?? error)).catch(() => {});
    throw error;
  }
}

/**
 * Re-read the cucumber reports of `projects` (all, or one that just changed) into the results
 * store (results.json next to projects.json) and persist it. @returns {Promise<boolean>} changed
 */
export async function refreshResults({ readReport, readResults, writeResults }, projects, results) {
  let changed = false;
  for (const project of projects) {
    const report = await readReport(project);
    if (!report) continue;
    try {
      changed = mergeReport(results, project.root, parseReport(JSON.parse(report.text)), report.mtimeMs) || changed;
    } catch {
      /* half-written file: the next fs event re-reads it */
    }
  }
  if (changed) await writeResults(results);
  return changed;
}

/** Poll: cucumber-js runs alive now. Calls onChange(targets) only when the set changed. */
export function watchRunning({ listProcesses }, onChange, ms = 2000) {
  let last = '[]';
  const tick = () =>
    listProcesses().then((lines) => {
      const targets = runningTargets(lines);
      const key = JSON.stringify(targets);
      if (key !== last) onChange(targets, (last = key));
    });
  const timer = setInterval(tick, ms);
  tick();
  return () => clearInterval(timer);
}

/** Kill every live cucumber-js process whose command line names `target`. @returns {Promise<{ killed: number }>} */
export async function stopRun({ listProcesses, kill }, target) {
  const byTarget = runningPids(await listProcesses());
  // A scenario spinning because its whole feature runs: stop the feature run.
  const pids = byTarget[target] ?? byTarget[target.replace(/:\d+$/, '')] ?? [];
  if (pids.length) kill(pids);
  return { killed: pids.length };
}

/** Serve the project's cucumber HTML report and open it in Orca's embedded browser. */
export async function openReport({ serveReport }, runtime, root) {
  const url = await serveReport({ root });
  await runtime.openUrl(url);
  return { url };
}
