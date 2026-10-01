// SDK, panel side: send an action to the worker from the sandboxed panel, without a popup.
//
//   const channel = createPanelChannel({ orca, cliPath: __SDK_CLI__, data: readPanelData(document) });
//   const r = await channel.send('open-file', { path });   // { sent: true } | { sent: false, reason }
//
// The panel's only way out is terminal.sendText, and the host only accepts terminals of the focused
// worktree. So it types `node <cli> <action> '<json>'` into the worker's carrier terminal of that
// worktree; the CLI calls plugins.invokeCommand → worker. Fire-and-forget: the reply lands in the
// carrier (the panel can't read terminals); results come back, if at all, as panel data.
import { shellQuote } from '../shared/shell.js';
import { PANEL_DATA_ID } from './protocol.js';

/** Data the worker patched into the page: { titles, carriers }; empty until the worker ran once. */
export function readPanelData(doc) {
  const { titles = {}, carriers = [], ...rest } = JSON.parse(doc.getElementById(PANEL_DATA_ID)?.textContent || '{}');
  return { titles, carriers, ...rest }; // rest = whatever the worker's `data()` adds
}

/** The line typed into a terminal. Pure. */
export function toCliCommand(cliPath, action, envelopeParams) {
  return `node ${shellQuote(cliPath)} ${shellQuote(action)} ${shellQuote(JSON.stringify(envelopeParams))}`;
}

/**
 * @param {{ orca: { readContext: () => Promise<any>, sendText: (id: string, text: string, enter?: boolean) => Promise<{accepted: boolean}> },
 *   cliPath: string, data: { carriers: string[] } }} options
 */
export function createPanelChannel({ orca, cliPath, data }) {
  const isCarrier = (id) => data.carriers.includes(id);
  return {
    isCarrier,
    /** Carrier of the focused worktree, or null (worker not running / worktree focused < 1 poll ago). */
    async carrier() {
      const context = await orca.readContext();
      return context?.terminals.find((t) => isCarrier(t.id))?.id ?? null;
    },
    /** Line to type by hand into `terminalId` (fallback when there's no carrier). */
    command: (action, params) => toCliCommand(cliPath, action, { params }),
    /** @returns {Promise<{ sent: true } | { sent: false, reason: 'no-carrier' | 'rejected' }>} */
    async send(action, params) {
      const carrier = await this.carrier();
      if (!carrier) return { sent: false, reason: 'no-carrier' };
      const { accepted } = await orca.sendText(carrier, this.command(action, params), true);
      return accepted ? { sent: true } : { sent: false, reason: 'rejected' };
    },
  };
}
