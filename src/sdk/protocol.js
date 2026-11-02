// Orca plugin messaging SDK — wire constants. Plugin-agnostic: nothing here knows about Cucumber.
// Panel → worker rides on the plugin API (plugin.request / panels.handle, Orca ≥ 1.4.245); CLI →
// worker and worker → Orca on the runtime RPC (what the `orca` CLI speaks).
// EXPERIMENTAL, re-verify on upgrade (AGENTS.md "Messaging SDK").

// The one worker command every SDK plugin declares in contributes.commands (no `action`), also the
// panel request name (orca.panels.handle). args: { action, params? } → the action's return value.
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

// Worker → panel push (orca.panels.post → orca.plugin.on): the full snapshot { titles, …plugin data }.
export const PANEL_EVENT = 'sdk-data';

// Built-in actions every channel answers. send-text: { terminalId, text, enter? } → { accepted }
// (panels can't call terminal.sendText since Orca 1.4.245); state: {} → the current PANEL_EVENT snapshot.
export const BUILTIN_ACTION = { ping: 'ping', list: 'actions', sendText: 'send-text', state: 'state' };

// Title of the "carrier" terminals older SDK versions kept per worktree (the panel typed RPC lines
// into them). No longer created; still left out of terminal titles/pickers until users close them.
export const CARRIER_TITLE = 'Orca plugins (rpc)';
