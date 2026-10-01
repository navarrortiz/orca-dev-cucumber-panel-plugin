import { LIMITS, NEW_TERMINAL, TARGET, TERMINAL_ICON } from '../../shared/protocol.js';
import { shellQuote } from '../../shared/shell.js';

export { shellQuote };

// Pure functions: no DOM, no bridge. Everything here is unit-tested.

/** "worktree · branch"; skips the branch when empty (a non-git folder has none). */
export function describeContext(context) {
  if (!context) return 'Sin worktree enfocado';
  return [context.displayName, context.branch].filter(Boolean).join(' · ');
}

/**
 * Case-insensitive match. A feature matching by name, file or tag keeps all its scenarios;
 * otherwise only the matching scenarios stay. Empty query keeps everything.
 */
export function filterProjects(projects, query) {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  const hit = (...parts) => parts.flat().some((part) => part.toLowerCase().includes(q));
  return projects
    .map((project) => ({
      ...project,
      features: project.features.flatMap((feature) => {
        if (hit(feature.name, feature.file, feature.tags)) return [feature];
        const scenarios = feature.scenarios.filter((s) => hit(s.name, s.tags));
        return scenarios.length ? [{ ...feature, scenarios }] : [];
      }),
    }))
    .filter((project) => project.features.length);
}

/**
 * Features → folder tree by path, like the file explorer: { name, path, folders, features }.
 * `path` is relative to the project root (a valid cucumber target). Single-child folder chains
 * collapse into one node ("admin-app/autenticacion/login-feature"), like VS Code compact folders.
 */
export function folderTree(features, dir) {
  const base = dir.replace(/^\.\//, '').replace(/\/$/, '');
  const root = { name: '', path: base, folders: [], features: [] };
  for (const feature of features) {
    const rel = feature.file.startsWith(`${base}/`) ? feature.file.slice(base.length + 1) : feature.file;
    let node = root;
    for (const name of rel.split('/').slice(0, -1)) {
      const path = `${node.path}/${name}`;
      let child = node.folders.find((f) => f.path === path);
      if (!child) node.folders.push((child = { name, path, folders: [], features: [] }));
      node = child;
    }
    node.features.push(feature);
  }
  const compact = (node) => {
    while (node.folders.length === 1 && !node.features.length && node.name) {
      const [only] = node.folders;
      node = { ...only, name: `${node.name}/${only.name}` };
    }
    return { ...node, folders: node.folders.map(compact) };
  };
  return compact(root);
}

/** Every feature under a folder node, nested ones included. */
export const featuresIn = (node) => [...node.features, ...node.folders.flatMap(featuresIn)];

/** `npx cucumber-js {target}` + `features/a.feature:12` → the line typed into the terminal. */
export function toCommand(template, target) {
  return template.replaceAll(TARGET, shellQuote(target));
}

/** Icon kind for a terminal: its agent (own icon or generic bot), else a plain terminal. */
export function terminalIcon(agent) {
  if (!agent) return TERMINAL_ICON.terminal;
  return TERMINAL_ICON.known.includes(agent) ? agent : TERMINAL_ICON.bot;
}

/**
 * The plugin API gives only terminal ids, in pane-layout order, with no focus flag or tab title.
 * `titles` ({ id: { title, agent? } }) is what the worker patched into panel.html from `terminal.list`;
 * a terminal it hasn't seen yet falls back to its position. Hint: short id so two picks can be told apart.
 * Last entry: "Terminal nueva" (NEW_TERMINAL), served by the worker through dist/rpc.mjs.
 */
/** Agent TUIs prefix their tab title with a status glyph (✳ ◐ ⠂…): drop anything before the first letter/digit. */
export const cleanTitle = (title = '') => title.replace(/^[^\p{L}\p{N}]+/u, '').trim();

export function describeTerminals(terminals, titles = {}) {
  return [
    ...terminals.map(({ id }, i) => ({ id, label: cleanTitle(titles[id]?.title) || `Terminal ${i + 1}`, hint: id.replace(/^term_/, '').slice(0, 8), icon: terminalIcon(titles[id]?.agent) })),
    { id: NEW_TERMINAL, label: 'Terminal nueva', hint: 'rpc', icon: TERMINAL_ICON.new },
  ];
}


const STEP = /^(Given|When|Then|And|But|\*|Dadas?|Dados?|Cuando|Entonces|Y|E|Pero)(?=\s)/;
const EXAMPLES = /^(Examples|Scenarios|Ejemplos|Escenarios):/;
// `<param>` and "quoted" inside a step or cell.
const inline = (text) =>
  text.split(/(<[^>\s]+>|"[^"]*")/).filter(Boolean).map((part) => ({ kind: part.startsWith('<') ? 'param' : part.startsWith('"') ? 'string' : 'text', text: part }));

/**
 * Scenario body (parser's trimmed lines) → [{ type: 'step'|'section'|'table'|'doc', header?, tokens: [{ kind, text }] }]
 * for the definition card. Kinds: keyword, param, string, text, pipe. The first table row after
 * Examples is its header. ponytail: regex tokenizer, en + es keywords like the parser.
 */
export function highlightSteps(lines) {
  let doc = false;
  let header = false;
  return lines.map((line) => {
    if (line.startsWith('"""') || line.startsWith('```')) {
      doc = !doc;
      return { type: 'doc', tokens: [{ kind: 'pipe', text: line }] };
    }
    if (doc) return { type: 'doc', tokens: [{ kind: 'string', text: line }] };
    const examples = EXAMPLES.exec(line);
    if (examples) {
      header = true;
      return { type: 'section', tokens: [{ kind: 'keyword', text: examples[0] }, ...inline(line.slice(examples[0].length))] };
    }
    if (line.startsWith('|')) {
      const row = { type: 'table', header, tokens: line.split(/(\|)/).filter(Boolean).flatMap((part) => (part === '|' ? [{ kind: 'pipe', text: part }] : inline(part))) };
      header = false;
      return row;
    }
    const step = STEP.exec(line);
    return { type: 'step', tokens: step ? [{ kind: 'keyword', text: step[0] }, ...inline(line.slice(step[0].length))] : inline(line) };
  });
}

/** Feature and scenario ⋯ menu (the popup's label names which), in view.choose's shape; icons = `icon-<icon>`. */
export const ITEM_MENU = [
  { id: 'run', label: 'Ejecutar…', hint: '', icon: 'run' },
  { id: 'open', label: 'Abrir en editor', hint: '', icon: 'edit' },
  { id: 'report', label: 'Ver reporte HTML', hint: 'navegador de Orca', icon: 'html' },
];

/**
 * One-line reference for an agent chat: absolute path (`file`, `file:line` or `folder/`), plus the
 * title when there is one. Absolute because the chat's cwd may not be the project root.
 */
export const referenceText = (root, path, title) => `${root.replace(/\/+$/, '')}/${path}${title ? ` (${title})` : ''}`;

/** "Ejecutar…", one "Label…" per projects.json `commands` entry (id = its template, run like "Ejecutar…"), "Referenciar en chat…", "Abrir" (files, not folders). */
// ponytail: every custom command gets the eye icon (made for "navegador visible"); add an `icon` per command if others show up.
export const itemMenu = (commands = {}, openable = true) => [
  ...ITEM_MENU.slice(0, 1),
  ...Object.entries(commands).map(([label, command]) => ({ id: command, label: `${label}…`, hint: '', icon: 'eye' })),
  SEND_ITEM,
  ...ITEM_MENU.slice(1).filter((item) => openable || item.id !== 'open'),
];
const SEND_ITEM = { id: 'send', label: 'Referenciar en chat…', hint: 'ruta, sin Enter', icon: 'terminal' };

/** @returns {string | null} error message, or null when the input is sendable */
export function validateSend({ terminalId, text }) {
  if (!terminalId) return 'No hay terminal en el worktree activo';
  if (!text.trim()) return 'Comando vacío';
  if (text.length > LIMITS.textMax) return `Supera ${LIMITS.textMax} caracteres`;
  return null;
}

export function describeError(error) {
  return error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
}
