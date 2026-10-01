// SDK, worker side: receives actions from the panel / CLI and keeps the panel's data fresh.
//
//   const channel = createWorkerChannel({ ctx, runtime, panelPath, actions, carrierTitle: 'My plugin (rpc)' });
//   channel.start();   // in activate(), after registering your own commands
//   channel.stop();    // in deactivate()
//
// - Registers INVOKE_COMMAND (declare it in contributes.commands) → createActionRouter(actions).
// - Keeps one hidden "carrier" terminal per focused worktree: the panel can only type into terminals
//   of the ACTIVE worktree (host check), and can't create any. Titles + carrier ids are patched into
//   the panel HTML (PANEL_DATA_ID); a change makes Orca reload the panel (dev plugin path).
// - A carrier is reused for every request: replacing it would change its id = panel reload per click.
import { readFile, writeFile } from 'node:fs/promises';
import { createActionRouter } from './actions.js';
import { INVOKE_COMMAND, PANEL_DATA_ID } from './protocol.js';

const HOST_READ_CONTEXT = 'workspace.readContext'; // plugin host API (needs workspace:read)

/**
 * @param {{ ctx: any, runtime: ReturnType<import('./runtime.js').createRuntime>, panelPath: string,
 *   actions: Record<string, { description?: string, run: Function }>, carrierTitle: string,
 *   pollMs?: number, onError?: (error: Error) => void, data?: () => object }} options
 *   `data()`: extra plugin data merged into the panel data on every sync (call `channel.sync()` when it changes).
 */
export function createWorkerChannel({ ctx, runtime, panelPath, actions, carrierTitle, pollMs = 15000, onError, data }) {
  const deps = {
    listTerminals: runtime.terminals,
    activeWorktreeId: (terminals) => activeWorktreeId(ctx.host, runtime, terminals),
    createCarrier: (worktreeId) => runtime.createTerminal({ worktreeId, title: carrierTitle, focus: false }),
    closeTerminal: runtime.closeTerminal,
    patchPanelData: (panelData) => patchPanelData(panelPath, { ...data?.(), ...panelData }),
    carrierTitle,
  };
  const route = createActionRouter(actions, { runtime, host: ctx.host, log: ctx.log });
  ctx.commands.register(INVOKE_COMMAND, async (envelope) => {
    try {
      return await route(envelope);
    } catch (error) {
      onError?.(error);
      throw error;
    }
  });

  let timer;
  let lastError = '';
  const sync = () =>
    syncPanelData(deps).then(
      () => (lastError = ''),
      (error) => error.message !== lastError && ctx.log(`sdk panel data: ${(lastError = error.message)}`),
    );
  return {
    start() {
      timer = setInterval(sync, pollMs);
      return sync();
    },
    stop: () => clearInterval(timer),
    sync,
  };
}

/**
 * Orca worktree id the user has focused, or null. The host API only gives its terminal ids and
 * displayName/branch: map a terminal through terminal.list, else match displayName + branch.
 */
export async function activeWorktreeId(host, runtime, terminals) {
  const context = await host.call(HOST_READ_CONTEXT, {});
  if (!context) return null;
  const ids = new Set(context.terminals.map((t) => t.id));
  const byTerminal = terminals.find((t) => ids.has(t.handle))?.worktreeId;
  if (byTerminal) return byTerminal;
  const branch = (b) => (b ?? '').replace(/^refs\/heads\//, ''); // readContext and worktree.list both may prefix it
  const named = (await runtime.worktrees()).filter((w) => w.displayName === context.displayName && branch(w.branch) === branch(context.branch));
  return named.length === 1 ? named[0].id : null;
}

/**
 * One poll: carriers rebuilt from terminal.list by title (adopts a previous worker's — Orca doesn't
 * always call deactivate —, forgets closed ones, closes duplicates per worktree), creates one in the
 * focused worktree if missing, patches { titles, carriers } into the panel.
 * @returns {Promise<boolean>} panel file rewritten (⇒ Orca reloads the panel)
 */
export async function syncPanelData(deps) {
  const { listTerminals, activeWorktreeId, createCarrier, closeTerminal, patchPanelData, carrierTitle } = deps;
  const terminals = await listTerminals();
  const carriers = {};
  for (const t of terminals.filter((t) => t.title === carrierTitle)) {
    if (carriers[t.worktreeId]) await closeTerminal(t.handle).catch(() => {});
    else carriers[t.worktreeId] = t.handle;
  }
  const active = await activeWorktreeId(terminals);
  if (active && !carriers[active]) carriers[active] = await createCarrier(active);
  const ids = new Set(Object.values(carriers));
  const titles = Object.fromEntries(
    terminals
      .filter((t) => t.title && !ids.has(t.handle))
      .sort((a, b) => a.handle.localeCompare(b.handle)) // terminal.list order varies between calls
      .map((t) => [t.handle, { title: stableTitle(t.title), ...(t.agentIdentity ? { agent: t.agentIdentity } : {}) }]),
  );
  return patchPanelData({ titles, carriers: [...ids].sort() });
}

// Agents prefix their title with a status/spinner glyph (◑ ✳ ⠋…) that changes every few seconds:
// keep it out of the data or every poll rewrites the panel (= reload, visible flicker).
const stableTitle = (title) => title.replace(/^[^\p{L}\p{N}]+/u, '').trim();

/**
 * Worker → panel: rewrite the JSON inside the panel's `<script id="panel-data">`. Only when it
 * differs, and never on a file without the placeholder (mid-rebuild or old build).
 * @returns {Promise<boolean>} written
 */
export async function patchPanelData(panelPath, data) {
  const html = await readFile(panelPath, 'utf8').catch(() => '');
  const re = new RegExp(`(<script id="${PANEL_DATA_ID}" type="application/json">)([^<]*)(</script>)`);
  const match = html.match(re);
  if (!match) return false;
  const json = JSON.stringify(data).replaceAll('<', '\\u003c'); // no `</script>` inside inline JSON
  if (match[2] === json) return false;
  await writeFile(panelPath, html.replace(re, () => `${match[1]}${json}${match[3]}`));
  return true;
}
