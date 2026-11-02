// SDK, panel side: send actions to the worker and follow its data.
//
//   const channel = createPanelChannel({ orca: window.orca });
//   const value = await channel.send('open-file', { path });   // the action's return value; throws on failure
//   channel.subscribe((snapshot) => render(snapshot));         // now (state request) + every worker push
//
// Orca ≥ 1.4.245 gives panels `window.orca.plugin.request(name, input)`, answered by the worker's
// `orca.panels.handle(name, …)`, and `orca.plugin.on(event, fn)` for its `orca.panels.post`. The SDK
// routes every action through one handler, INVOKE_COMMAND (the same name the CLI invokes).
import { BUILTIN_ACTION, INVOKE_COMMAND, PANEL_EVENT } from './protocol.js';

/** @param {{ orca: { plugin: { request: Function, on: Function } } }} options */
export function createPanelChannel({ orca }) {
  const send = (action, params = {}) => orca.plugin.request(INVOKE_COMMAND, { action, params });
  return {
    send,
    /**
     * fn(snapshot) with the current state, then on every push. Also starts the worker if needed.
     * A push that lands while the state request is in flight is newer: the answer is then dropped.
     * @returns {Promise<void>} rejects if the state request fails (pushes still arrive)
     */
    subscribe(fn) {
      let pushed = false;
      orca.plugin.on(PANEL_EVENT, (snapshot) => ((pushed = true), fn(snapshot)));
      return send(BUILTIN_ACTION.state).then((snapshot) => pushed || fn(snapshot));
    },
  };
}
