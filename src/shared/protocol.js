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

// Worker commands; ids must match contributes.commands in orca-plugin.json.
export const COMMAND = {
  editProjects: 'edit-projects',
  reloadFeatures: 'reload-features',
};

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
