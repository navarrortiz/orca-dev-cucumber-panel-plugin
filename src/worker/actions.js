// Actions this plugin exposes through the messaging SDK (src/sdk). Reached from the panel (no
// popup, via the carrier terminal) or by hand: `node dist/rpc.mjs <action> '{"params":{…}}'`.
// Params come from outside the process: validate everything.
import { join, sep } from 'node:path';
import { requireAbsolute, requireString } from '../sdk/actions.js';
import { ACTION } from '../shared/protocol.js';
import { shellQuote } from '../shared/shell.js';

export const actions = {
  [ACTION.openFile]: {
    description: 'Abre { root, file } en el editor de Orca (file relativo a root, sin "..")',
    async run(params, { runtime }) {
      const root = requireAbsolute(ACTION.openFile, params, 'root');
      const file = requireString(ACTION.openFile, params, 'file');
      if (file.startsWith('/') || file.split(/[\\/]/).includes('..')) throw new Error(`${ACTION.openFile}: "file" must be a path inside root`);
      await runtime.openFile(join(root, file).split(sep).join('/'));
      return { opened: true };
    },
  },
  [ACTION.runInTerminal]: {
    description: 'Terminal nueva y enfocada en el worktree de { root }, ejecutando { command } desde root; { title? }',
    async run(params, { runtime }) {
      const root = requireAbsolute(ACTION.runInTerminal, params, 'root');
      const command = requireString(ACTION.runInTerminal, params, 'command');
      const title = typeof params.title === 'string' && params.title.trim() ? params.title.slice(0, 80) : 'Cucumber';
      const worktree = await runtime.worktreeOf(root);
      // The terminal starts at the worktree root; the project may live in a subfolder.
      const terminalId = await runtime.createTerminal({ worktreeId: worktree.id, command: `cd ${shellQuote(root)} && ${command}`, title });
      return { terminalId };
    },
  },
};
