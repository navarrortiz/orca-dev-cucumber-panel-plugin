import { LIMITS, TARGET } from '../../shared/protocol.js';

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

/** POSIX shell quoting, only when needed so the terminal shows readable commands. */
export function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `npx cucumber-js {target}` + `features/a.feature:12` → the line typed into the terminal. */
export function toCommand(template, target) {
  return template.replaceAll(TARGET, shellQuote(target));
}

/**
 * The plugin API gives only terminal ids, in pane-layout order, with no focus flag or tab title.
 * Best label available: position + a short id so two picks can be told apart.
 */
export function describeTerminals(terminals) {
  return terminals.map(({ id }, i) => ({ id, label: `Terminal ${i + 1}`, hint: id.replace(/^term_/, '').slice(0, 8) }));
}

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
