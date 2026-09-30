import { HOST_METHOD } from '../shared/protocol.js';

// Domain facade over the panel bridge. The rest of the panel talks in these
// verbs, never in raw action strings.
export function createOrcaClient(bridge) {
  return {
    /** @returns {Promise<{branch: string, displayName: string, terminals: {id: string}[]} | null>} */
    readContext: () => bridge.call(HOST_METHOD.readContext),
    sendText: (terminalId, text, enter = false) => bridge.call(HOST_METHOD.sendText, { terminalId, text, enter }),
  };
}
