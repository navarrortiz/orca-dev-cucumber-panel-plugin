import { HOST_METHOD, STORAGE_KEY } from '../shared/protocol.js';
import { createPanelChannel } from '../sdk/panel.js';
import { BUILTIN_ACTION } from '../sdk/protocol.js';

// Domain facade over `window.orca` (injected by Orca's panel shell, Orca ≥ 1.4.245). The rest of the
// panel talks in these verbs, never in raw method strings.
export function createOrcaClient(orca) {
  const channel = createPanelChannel({ orca });
  return {
    /** @returns {Promise<{branch: string, displayName: string, terminals: {id: string, title?: string}[]} | null>} */
    readContext: () => orca.host.call(HOST_METHOD.readContext, {}),
    /** Panels can't call terminal.sendText: the worker types it (SDK built-in `send-text`). */
    sendText: (terminalId, text, enter = false) => channel.send(BUILTIN_ACTION.sendText, { terminalId, text, enter }),
    /** Worker action (src/worker/actions.js); resolves to its return value. */
    send: channel.send,
    /** fn(worker snapshot) now and on every push. */
    onData: channel.subscribe,
    /** View state in the plugin's storage (needs storage:own). */
    loadUi: () => orca.storage.get(STORAGE_KEY.ui),
    saveUi: (ui) => orca.storage.set(STORAGE_KEY.ui, ui),
  };
}
