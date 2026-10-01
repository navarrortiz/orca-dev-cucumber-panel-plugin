// SDK: Orca runtime RPC client (`OrcaRpc`) + typed verbs (`createRuntime`). The socket the `orca` CLI talks to. Lets the worker (or any local
// process) call runtime methods the plugin host API lacks — including `plugins.invokeCommand`,
// the only way found (Orca 1.4.216) to push a message with a payload into a plugin worker.
//
// Wire: newline-delimited JSON over the unix socket / named pipe listed in
// <userData>/orca-runtime.json; every request carries that file's authToken.
//   → { id, authToken, method, params }
//   ← { id, ok: true, result } | { id, ok: false, error: { code, message } } | { _keepalive: true }
// Mirrors out/cli/runtime/transport.js + metadata.js of the Orca bundle. No CLI dependency, no
// `orca` on PATH needed. One socket per call (the CLI does the same).
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { RPC_METHOD } from './protocol.js';

const METADATA_FILE = 'orca-runtime.json';

/** Same resolution as the CLI: ORCA_USER_DATA_PATH beats the per-platform Electron userData dir. */
export function userDataPath(platform = process.platform, env = process.env, home = homedir()) {
  if (env.ORCA_USER_DATA_PATH) return env.ORCA_USER_DATA_PATH;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'orca');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'orca');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca');
}

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class OrcaRpc {
  /** @param {{ metadataPath?: string, timeoutMs?: number }} [options] */
  constructor({ metadataPath = join(userDataPath(), METADATA_FILE), timeoutMs = 15_000 } = {}) {
    this.metadataPath = metadataPath;
    this.timeoutMs = timeoutMs;
  }

  /** Re-read per call: Orca rewrites the file (new socket + token) on every restart. */
  async metadata() {
    const meta = JSON.parse(await readFile(this.metadataPath, 'utf8'));
    const transport = (meta.transports ?? [meta.transport]).find((t) => t?.kind === 'unix' || t?.kind === 'named-pipe');
    if (!transport) throw new RpcError('runtime_unavailable', `No local transport in ${this.metadataPath}`);
    return { endpoint: transport.endpoint, authToken: meta.authToken };
  }

  /** @returns {Promise<any>} the `result` of the reply; rejects with RpcError(code) */
  async call(method, params) {
    const { endpoint, authToken } = await this.metadata();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = createConnection(endpoint);
      let buffer = '';
      const finish = (fn, value) => {
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new RpcError('runtime_timeout', `${method}: no reply in ${this.timeoutMs} ms`)), this.timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, authToken, method, params })}\n`));
      socket.on('error', (error) => finish(reject, new RpcError('runtime_unavailable', `${endpoint}: ${error.message}`)));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame._keepalive || frame.id !== id) continue;
          return frame.ok ? finish(resolve, frame.result) : finish(reject, new RpcError(frame.error?.code ?? 'runtime_error', `${method}: ${frame.error?.message ?? 'RPC failed'}`));
        }
      });
      socket.on('close', () => finish(reject, new RpcError('runtime_unavailable', `${method}: connection closed without a reply`)));
    });
  }

  /** Process-wide instance; construct your own only to point at another Orca (tests, dev builds). */
  static get shared() {
    return (this._shared ??= new OrcaRpc());
  }
}

/**
 * Typed verbs over the runtime RPC, the ones the SDK and its plugins use. Everything else:
 * `rpc.call(method, params)` (see RPC_METHOD and the Orca CLI handlers).
 * @param {{ call: (method: string, params?: any) => Promise<any> }} [rpc]
 */
export function createRuntime(rpc = OrcaRpc.shared) {
  const worktrees = () => rpc.call(RPC_METHOD.worktreeList, {}).then(({ worktrees = [] }) => worktrees);
  const runtime = {
    rpc,
    worktrees,
    /** Deepest Orca worktree containing `dir` (a `path:` selector must be the worktree's own path). */
    async worktreeOf(dir) {
      const inside = (w) => dir === w.path || dir.startsWith(w.path.replace(/[\\/]?$/, sep));
      const worktree = (await worktrees()).filter(inside).sort((a, b) => b.path.length - a.path.length)[0];
      if (!worktree) throw new Error(`Ningún worktree de Orca contiene ${dir}`);
      return worktree;
    },
    /** Every live terminal, all worktrees: [{ handle, title, agentIdentity?, worktreeId, … }]. */
    terminals: () => rpc.call(RPC_METHOD.terminalList, {}).then(({ terminals = [] }) => terminals),
    /** @returns {Promise<string>} new terminal handle */
    createTerminal: ({ worktreeId, command, title, focus = true }) =>
      rpc
        .call(RPC_METHOD.terminalCreate, { worktree: `id:${worktreeId}`, ...(command ? { command } : {}), title, focus, ...(focus ? { presentation: 'focused' } : {}) })
        .then((r) => r.terminal.handle),
    closeTerminal: (handle) => rpc.call(RPC_METHOD.terminalClose, { terminal: handle }),
    /** Opens an absolute path in Orca's editor, in the worktree that contains it. */
    /** New tab in Orca's embedded browser (global: shown wherever the user is). http(s) only: file:// is refused. */
    openUrl: (url) => rpc.call(RPC_METHOD.browserTabCreate, { url }),
    async openFile(absolutePath) {
      const worktree = await runtime.worktreeOf(absolutePath);
      const relativePath = relative(worktree.path, absolutePath).split(sep).join('/');
      return rpc.call(RPC_METHOD.filesOpen, { worktree: `id:${worktree.id}`, relativePath });
    },
    invoke: (pluginKey, commandId, args) => rpc.call(RPC_METHOD.invokeCommand, { pluginKey, commandId, args }),
    setPluginEnabled: (pluginKey, enabled) => rpc.call(RPC_METHOD.setPluginEnabled, { pluginKey, enabled }),
  };
  return runtime;
}
