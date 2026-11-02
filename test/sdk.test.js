import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createActionRouter, requireAbsolute } from '../src/sdk/actions.js';
import { createPanelChannel } from '../src/sdk/panel.js';
import { createRuntime, OrcaRpc, userDataPath } from '../src/sdk/runtime.js';
import { createWorkerChannel } from '../src/sdk/worker.js';
import { actions } from '../src/worker/actions.js';


/** Fake runtime RPC: answers from a table of handlers, records every call. */
function fakeRpc(handlers) {
  const calls = [];
  return { calls, call: async (method, params) => (calls.push([method, params]), handlers[method]?.(params) ?? {}) };
}

// ---- actions router -------------------------------------------------------------------------

test('router: built-ins, dispatch with ctx, unknown action', async () => {
  const route = createActionRouter({ echo: { description: 'd', run: async (p, ctx) => ({ p, ctx }) } }, 'CTX');
  assert.equal((await route({ action: 'ping' })).pong, true);
  assert.deepEqual(await route({ action: 'actions' }), [{ name: 'echo', description: 'd' }]);
  assert.deepEqual(await route({ action: 'echo', params: { a: 1 } }), { p: { a: 1 }, ctx: 'CTX' });
  await assert.rejects(route({ action: 'toString' }), /desconocida/); // no prototype lookups
  await assert.rejects(route(null), /desconocida/);
  assert.throws(() => requireAbsolute('x', { root: 'rel' }, 'root'), /absolute/);
});

// ---- runtime --------------------------------------------------------------------------------

test('runtime.worktreeOf picks the deepest worktree; openFile sends a worktree-relative path', async () => {
  const rpc = fakeRpc({ 'worktree.list': () => ({ worktrees: [{ id: 'w1', path: '/repo' }, { id: 'w2', path: '/repo/pkg' }, { id: 'w3', path: '/repo/pk' }] }) });
  const runtime = createRuntime(rpc);
  assert.equal((await runtime.worktreeOf('/repo/pkg/sub')).id, 'w2');
  await assert.rejects(runtime.worktreeOf('/else'), /Ningún worktree/);
  await runtime.openFile('/repo/pkg/features/a b.feature');
  assert.deepEqual(rpc.calls.at(-1), ['files.open', { worktree: 'id:w2', relativePath: 'features/a b.feature' }]);
});

test('userDataPath mirrors the CLI resolution per platform', () => {
  assert.equal(userDataPath('linux', {}, '/h'), '/h/.config/orca');
  assert.equal(userDataPath('linux', { XDG_CONFIG_HOME: '/c' }, '/h'), '/c/orca');
  assert.equal(userDataPath('darwin', {}, '/h'), '/h/Library/Application Support/orca');
  assert.equal(userDataPath('linux', { ORCA_USER_DATA_PATH: '/dev-orca' }, '/h'), '/dev-orca');
});

test('OrcaRpc speaks the runtime socket protocol: auth token, keepalives, results and errors', async () => {
  const dir = await promisify(mkdtemp)(join(tmpdir(), 'orca-rpc-'));
  const endpoint = join(dir, 'o.sock');
  const seen = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (line) => {
      const req = JSON.parse(line);
      seen.push(req);
      socket.write('{"_keepalive":true}\n');
      if (req.authToken !== 'tok') return socket.end(JSON.stringify({ id: req.id, ok: false, error: { code: 'unauthorized', message: 'bad token' } }) + '\n');
      if (req.method === 'boom') return socket.end(JSON.stringify({ id: req.id, ok: false, error: { code: 'runtime_error', message: 'nope' } }) + '\n');
      socket.end(JSON.stringify({ id: req.id, ok: true, result: { echo: req.params } }) + '\n');
    });
  });
  await new Promise((r) => server.listen(endpoint, r));
  const metadataPath = join(dir, 'orca-runtime.json');
  await promisify(writeFile)(metadataPath, JSON.stringify({ transports: [{ kind: 'websocket', endpoint: 'ws://x' }, { kind: 'unix', endpoint }], authToken: 'tok' }));
  const rpc = new OrcaRpc({ metadataPath, timeoutMs: 2000 });
  assert.deepEqual(await rpc.call('plugins.invokeCommand', { a: 1 }), { echo: { a: 1 } });
  assert.equal(seen[0].method, 'plugins.invokeCommand');
  assert.equal(seen[0].authToken, 'tok');
  await assert.rejects(rpc.call('boom'), { code: 'runtime_error', message: 'boom: nope' });
  await promisify(writeFile)(metadataPath, JSON.stringify({ transports: [{ kind: 'unix', endpoint }], authToken: 'stale' }));
  await assert.rejects(rpc.call('x'), { code: 'unauthorized' }); // metadata re-read per call
  server.close();
  await assert.rejects(new OrcaRpc({ metadataPath: join(dir, 'missing.json') }).call('x'), { code: 'ENOENT' });
});

test('OrcaRpc.shared is a singleton pointing at this platform\'s userData', () => {
  assert.equal(OrcaRpc.shared, OrcaRpc.shared);
  assert.equal(OrcaRpc.shared.metadataPath, join(userDataPath(), 'orca-runtime.json'));
});


// ---- worker channel -------------------------------------------------------------------------

test('worker channel: sdk-invoke as command and panel handler; snapshot answered and posted on change', async () => {
  let terminals = [{ handle: 'term_a', title: 'Shell' }, { handle: 'term_b', title: '' }, { handle: 'term_c', title: '◑ a', agentIdentity: 'claude' }, { handle: 'car1', title: 'X (rpc)' }];
  const rpc = fakeRpc({ 'terminal.list': () => ({ terminals }) });
  const commands = new Map();
  const handlers = new Map();
  const posts = [];
  const hostCalls = [];
  const ctx = {
    commands: { register: (id, fn) => commands.set(id, fn) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: (...args) => posts.push(args) },
    host: { call: async (...args) => (hostCalls.push(args), { accepted: true }) },
    log: () => {},
  };
  let results = { k: 1 };
  const channel = createWorkerChannel({ ctx, runtime: createRuntime(rpc), actions: {}, carrierTitle: 'X (rpc)', data: () => ({ results }) });
  assert.ok(commands.has('sdk-invoke'));
  await channel.start();
  channel.stop();
  const first = { results: { k: 1 }, titles: { term_a: { title: 'Shell' }, term_c: { title: 'a', agent: 'claude' } } };
  assert.deepEqual(posts, [['sdk-data', first]]);
  const invoke = handlers.get('sdk-invoke');
  const panel = { panel: { id: 'p1', surface: 'panel', contributionId: 'features' } };
  assert.deepEqual(await invoke({ action: 'state' }, panel), first);
  // Nothing changed (spinner glyph only) → no post; data changed → one post.
  terminals = terminals.map((t) => (t.handle === 'term_c' ? { ...t, title: '◐ a' } : t));
  await channel.sync();
  assert.equal(posts.length, 1);
  results = { k: 2 };
  await channel.sync();
  assert.deepEqual(posts.at(-1), ['sdk-data', { ...first, results: { k: 2 } }]);
  // Panel request → built-in send-text → worker-only host call.
  assert.deepEqual(await invoke({ action: 'send-text', params: { terminalId: 't1', text: 'ls', enter: true } }, panel), { accepted: true });
  assert.deepEqual(hostCalls, [['terminal.sendText', { terminalId: 't1', text: 'ls', enter: true }]]);
  await assert.rejects(invoke({ action: 'send-text', params: { text: 'ls' } }, panel), /terminalId/);
});

// ---- panel channel --------------------------------------------------------------------------

test('panel channel: send = plugin.request; subscribe = state now, then pushes (a push beats an older answer)', async () => {
  let listener;
  let answer;
  const requests = [];
  const orca = {
    plugin: {
      on: (event, fn) => (assert.equal(event, 'sdk-data'), (listener = fn)),
      request: (...args) => (requests.push(args), new Promise((resolve) => (answer = resolve))),
    },
  };
  const channel = createPanelChannel({ orca });
  const seen = [];
  const done = channel.subscribe((s) => seen.push(s));
  assert.deepEqual(requests, [['sdk-invoke', { action: 'state', params: {} }]]);
  listener({ v: 2 });
  answer({ v: 1 });
  await done;
  assert.deepEqual(seen, [{ v: 2 }]);
  channel.send('open-file', { root: '/r' });
  assert.deepEqual(requests.at(-1), ['sdk-invoke', { action: 'open-file', params: { root: '/r' } }]);
});

// ---- this plugin's actions ------------------------------------------------------------------

test('open-file validates and opens root/file in its worktree', async () => {
  const rpc = fakeRpc({ 'worktree.list': () => ({ worktrees: [{ id: 'w1', path: '/repo' }] }) });
  const route = createActionRouter(actions, { runtime: createRuntime(rpc) });
  assert.deepEqual(await route({ action: 'open-file', params: { root: '/repo/pkg', file: 'features/a.feature' } }), { opened: true });
  assert.deepEqual(rpc.calls.at(-1), ['files.open', { worktree: 'id:w1', relativePath: 'pkg/features/a.feature' }]);
  await assert.rejects(route({ action: 'open-file', params: { root: '/repo/pkg', file: '../secret' } }), /inside root/);
  await assert.rejects(route({ action: 'open-file', params: { root: 'rel', file: 'a' } }), /absolute/);
});

test('run-in-terminal opens a focused terminal in the worktree, cd-ing into root', async () => {
  const rpc = fakeRpc({
    'worktree.list': () => ({ worktrees: [{ id: 'w2', path: '/repo/pkg e2e' }] }),
    'terminal.create': () => ({ terminal: { handle: 'term_1' } }),
  });
  const route = createActionRouter(actions, { runtime: createRuntime(rpc) });
  assert.deepEqual(await route({ action: 'run-in-terminal', params: { root: '/repo/pkg e2e/sub', command: 'npx cucumber-js a.feature', title: 'T' } }), { terminalId: 'term_1' });
  assert.deepEqual(rpc.calls.at(-1), ['terminal.create', { worktree: 'id:w2', command: "cd '/repo/pkg e2e/sub' && npx cucumber-js a.feature && orca terminal close --terminal \"$ORCA_TERMINAL_HANDLE\"", title: 'T', focus: true, presentation: 'focused' }]);
  await assert.rejects(route({ action: 'run-in-terminal', params: { root: '/p' } }), /"command"/);
});
