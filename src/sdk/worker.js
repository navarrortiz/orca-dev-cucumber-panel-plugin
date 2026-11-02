// SDK, worker side: receives actions from the panel / CLI and pushes the panel's data.
//
//   const channel = createWorkerChannel({ ctx, runtime, actions, data: () => ({ results }) });
//   channel.start();   // in activate(), after registering your own commands
//   channel.sync();    // whenever data() changed
//   channel.stop();    // in deactivate()
//
// - Registers INVOKE_COMMAND as a command (CLI: plugins.invokeCommand) and as a panel request
//   handler (panel: orca.plugin.request, Orca ≥ 1.4.245) → createActionRouter(actions).
// - Snapshot = { titles (terminal.list, polled), …data() }: answered by the built-in `state` action
//   (panel load) and posted as PANEL_EVENT to every open panel when it changes. No panel reload.
import { createActionRouter } from './actions.js';
import { BUILTIN_ACTION, CARRIER_TITLE, INVOKE_COMMAND, PANEL_EVENT } from './protocol.js';

/**
 * @param {{ ctx: any, runtime: ReturnType<import('./runtime.js').createRuntime>,
 *   actions: Record<string, { description?: string, run: Function }>, carrierTitle?: string,
 *   pollMs?: number, onError?: (error: Error) => void, data?: () => object }} options
 *   `data()`: plugin data merged into the snapshot (call `channel.sync()` when it changes).
 */
export function createWorkerChannel({ ctx, runtime, actions, carrierTitle = CARRIER_TITLE, pollMs = 15000, onError, data }) {
  let titles = {};
  let posted = '';
  const snapshot = () => ({ ...data?.(), titles });
  const route = createActionRouter(
    { ...actions, [BUILTIN_ACTION.state]: { description: 'Snapshot de datos del panel', run: snapshot } },
    { runtime, host: ctx.host, log: ctx.log },
  );
  const invoke = async (envelope) => {
    try {
      return await route(envelope);
    } catch (error) {
      onError?.(error);
      throw error;
    }
  };
  ctx.commands.register(INVOKE_COMMAND, invoke);
  ctx.panels?.handle(INVOKE_COMMAND, invoke); // absent before Orca 1.4.245

  /** Posts the snapshot if it changed since the last post. @returns {boolean} posted */
  const push = () => {
    const value = snapshot();
    const json = JSON.stringify(value);
    if (json === posted) return false;
    posted = json;
    ctx.panels?.post(PANEL_EVENT, value);
    return true;
  };
  let timer;
  let lastError = '';
  const sync = () =>
    terminalTitles(runtime.terminals, carrierTitle).then(
      (fresh) => ((titles = fresh), (lastError = ''), push()),
      (error) => (error.message !== lastError && ctx.log(`sdk panel data: ${(lastError = error.message)}`), push()),
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

/** { handle: { title, agent? } } of every titled terminal, minus old carrier tabs. */
export async function terminalTitles(listTerminals, carrierTitle = CARRIER_TITLE) {
  return Object.fromEntries(
    (await listTerminals())
      .filter((t) => t.title && t.title !== carrierTitle)
      .sort((a, b) => a.handle.localeCompare(b.handle)) // terminal.list order varies between calls
      .map((t) => [t.handle, { title: stableTitle(t.title), ...(t.agentIdentity ? { agent: t.agentIdentity } : {}) }]),
  );
}

// Agents prefix their title with a status/spinner glyph (◑ ✳ ⠋…) that changes every few seconds:
// keep it out of the data or every poll posts a new snapshot.
const stableTitle = (title) => title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
