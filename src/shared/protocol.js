// Orca plugin wire contract (pluginApi 1, Orca 1.4.x). Single source for every
// string the host matches on — never inline these elsewhere.

export const PANEL_MESSAGE = {
  request: 'orca-panel-action',
  result: 'orca-panel-action-result',
};

// Host API methods (panel + worker). Worker-only methods (storage, secrets,
// settings, events) are listed in AGENTS.md.
export const HOST_METHOD = {
  readContext: 'workspace.readContext', // workspace:read
  sendText: 'terminal.sendText', // terminal:send
  notify: 'notifications.show', // notifications:show
};

// Worker commands; ids must match contributes.commands in orca-plugin.json (plus the SDK's
// `sdk-invoke`, src/sdk/protocol.js INVOKE_COMMAND).
export const COMMAND = {
  editProjects: 'edit-projects',
  reloadFeatures: 'reload-features',
};

// Actions served through the SDK (src/worker/actions.js). Not manifest commands.
export const ACTION = {
  openFile: 'open-file', // { root, file } → { opened }
  runInTerminal: 'run-in-terminal', // { root, command, title? } → { terminalId }
  editProjects: 'edit-projects', // {} → { opened }: creates projects.json if missing and opens it in Orca
  reloadFeatures: 'reload-features', // {} → { reloaded }: rescan .feature files, rebuild only if changed
  openReport: 'open-report', // { root } → { url }: serves the project's cucumber HTML report and opens it in Orca's browser
  stopRun: 'stop-run', // { target } → { killed }: SIGTERM every live cucumber-js process on that file[:line]
};

// Title of this plugin's carrier terminals (sdk/worker.js): one hidden shell per focused worktree.
export const CARRIER_TITLE = 'Cucumber (rpc)';

// Pseudo terminal id used by the panel for "run in a new terminal" (never a real host id).
export const NEW_TERMINAL = '__new__';

// Popup icons (templates `icon-<kind>` in index.html). Agent kinds = Orca's agentIdentity values
// (`claude`, `codex`, `gemini`, `cursor`, `opencode`, `copilot`, `droid`, `kimi`, `amp`); `bot` = any other agent.
export const TERMINAL_ICON = { terminal: 'terminal', bot: 'bot', new: 'new', known: ['claude', 'codex', 'gemini'] };

// Placeholder in projects.json `command`, replaced by `file` or `file:line`.
export const TARGET = '{target}';

// Host-enforced limits worth failing fast on client-side.
export const LIMITS = {
  textMax: 4096, // terminal.sendText text
  notifyTitleMax: 120,
  notifyBodyMax: 1000,
  panelMessageBytes: 64 * 1024,
  panelRate: { maxMessages: 30, perMs: 10_000 }, // per plugin, all panels share it
};
