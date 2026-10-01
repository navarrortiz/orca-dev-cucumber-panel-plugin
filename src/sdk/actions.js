import { BUILTIN_ACTION } from './protocol.js';

/**
 * Action router: the worker side of `sdk-invoke`. Pure: no IPC, testable with fakes.
 *
 *   const route = createActionRouter({
 *     'open-file': { description: 'Open a file in Orca', run: async (params, ctx) => … },
 *   }, ctx);
 *   await route({ action: 'open-file', params: { … } });
 *
 * Params come from outside the process (any local process can call the socket): each `run`
 * validates its own params. Built-ins: `ping` → { pong: true, at }, `actions` → [{ name, description }].
 * @param {Record<string, { description?: string, run: (params: any, ctx: any) => any }>} actions
 */
export function createActionRouter(actions, ctx) {
  return async (envelope) => {
    const { action, params } = envelope ?? {};
    if (action === BUILTIN_ACTION.ping) return { pong: true, at: Date.now() };
    if (action === BUILTIN_ACTION.list) return Object.entries(actions).map(([name, a]) => ({ name, description: a.description ?? '' }));
    if (typeof action !== 'string' || !Object.hasOwn(actions, action)) throw new Error(`Acción desconocida: ${String(action)}`);
    return actions[action].run(params ?? {}, ctx);
  };
}

/** Throws unless `value` is a non-empty string. Tiny helper for action param checks. */
export function requireString(action, params, key) {
  const value = params?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${action}: "${key}" must be a non-empty string`);
  return value;
}

/** Throws unless `value` is an absolute POSIX or Windows path. */
export function requireAbsolute(action, params, key) {
  const value = requireString(action, params, key);
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) throw new Error(`${action}: "${key}" must be an absolute path`);
  return value;
}
