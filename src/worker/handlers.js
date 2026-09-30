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
