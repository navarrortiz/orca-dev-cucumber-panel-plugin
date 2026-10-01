// Orca plugin messaging SDK — wire constants. Plugin-agnostic: nothing here knows about Cucumber.
// Everything rides on Orca's runtime RPC (what the `orca` CLI speaks), not on the plugin API.
// Discovered in Orca 1.4.216; EXPERIMENTAL, re-verify on upgrade (AGENTS.md "Messaging SDK").

// The one worker command every SDK plugin declares in contributes.commands (no `action`).
// args: { action, params?, carrier? } → the action's return value.
export const INVOKE_COMMAND = 'sdk-invoke';

// Runtime RPC methods the SDK uses. Params per method: out/cli/handlers/*.js in the Orca bundle.
export const RPC_METHOD = {
  invokeCommand: 'plugins.invokeCommand', // { pluginKey, commandId, args } → worker handler's return value
  setPluginEnabled: 'plugins.setEnabled', // { pluginKey, enabled } → restarts the worker when toggled
  filesOpen: 'files.open', // { worktree, relativePath } → { opened }
  worktreeList: 'worktree.list', // {} → { worktrees: [{ id, path, displayName, branch, … }] }
  terminalList: 'terminal.list', // {} → { terminals: [{ handle, title, agentIdentity?, worktreeId, … }] } (all worktrees)
  terminalCreate: 'terminal.create', // { worktree: 'id:…'|'path:…', command?, title?, focus?, presentation? } → { terminal: { handle } }
  terminalClose: 'terminal.close', // { terminal: handle } → kills the PTY
  browserTabCreate: 'browser.tabCreate', // { url (http(s) only), worktree? } → { browserPageId }: new tab in Orca's embedded browser.
  // (browser.openUrl needs that worktree's browser pane already open: browser_host_unavailable otherwise.)
};

// <script id="panel-data" type="application/json"> in the panel HTML, patched by the worker (the
// only worker → panel channel): { titles: { [terminalId]: { title, agent? } }, carriers: [terminalId] }
export const PANEL_DATA_ID = 'panel-data';

// Built-in actions every channel answers.
export const BUILTIN_ACTION = { ping: 'ping', list: 'actions' };
