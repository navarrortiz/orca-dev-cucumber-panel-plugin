import assert from 'node:assert/strict';
import { mkdtemp, readFileSync, writeFile } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createActionRouter, requireAbsolute } from '../src/sdk/actions.js';
import { createPanelChannel, readPanelData, toCliCommand } from '../src/sdk/panel.js';
import { createRuntime, OrcaRpc, userDataPath } from '../src/sdk/runtime.js';
import { createWorkerChannel } from '../src/sdk/worker.js';
import { actions } from '../src/worker/actions.js';

const tmp = () => promisify(mkdtemp)(join(tmpdir(), 'orca-sdk-'));

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

test('syncPanelData keeps one carrier in the active worktree and patches titles (minus carriers)', async () => {
  const dir = await tmp();
  const panelPath = join(dir, 'panel.html');
  const page = '<body><script id="panel-data" type="application/json">{}</script><ul></ul></body>';
  await promisify(writeFile)(panelPath, page);
  let terminals = [{ handle: 'term_a', title: 'Shell', worktreeId: 'w1' }, { handle: 'term_b', title: '', worktreeId: 'w2' }, { handle: 'term_c', title: '◑ a </script>', agentIdentity: 'claude', worktreeId: 'w2' }];
  let focused = { displayName: 'w1', branch: 'main', terminals: [{ id: 'term_a' }] };
  const created = [];
  const closed = [];
  const rpc = fakeRpc({
    'terminal.list': () => ({ terminals }),
    'worktree.list': () => ({ worktrees: [{ id: 'w3', displayName: 'empty', branch: 'refs/heads/dev' }] }),
    'terminal.create': (params) => (created.push(params), { terminal: { handle: `car${created.length}` } }),
    'terminal.close': (params) => (closed.push(params.terminal), {}),
  });
  const commands = new Map();
  const ctx = { commands: { register: (id, fn) => commands.set(id, fn) }, host: { call: async () => focused }, log: () => {} };
  const channel = createWorkerChannel({ ctx, runtime: createRuntime(rpc), panelPath, actions: {}, carrierTitle: 'X (rpc)', data: () => ({ results: { k: 1 } }) });
  assert.ok(commands.has('sdk-invoke'));
  await channel.start();
  channel.stop();
  assert.deepEqual(created, [{ worktree: 'id:w1', title: 'X (rpc)', focus: false }]);
  assert.equal(readFileSync(panelPath, 'utf8'), page.replace('{}', '{"results":{"k":1},"titles":{"term_a":{"title":"Shell"},"term_c":{"title":"a \\u003c/script>","agent":"claude"}},"carriers":["car1"]}'));
  terminals = [...terminals, { handle: 'car1', title: 'X (rpc)', worktreeId: 'w1' }];
  await channel.sync();
  assert.equal(created.length, 1); // carrier alive: nothing created
  // Focus a worktree without terminals: matched by displayName + branch (both may carry refs/heads/).
  focused = { displayName: 'empty', branch: 'refs/heads/dev', terminals: [] };
  await channel.sync();
  assert.deepEqual(created.at(-1), { worktree: 'id:w3', title: 'X (rpc)', focus: false });
  // New worker: adopts existing carriers, closes a duplicate in the same worktree.
  terminals = [...terminals, { handle: 'car9', title: 'X (rpc)', worktreeId: 'w1' }];
  focused = null;
  await channel.sync();
  assert.deepEqual(closed, ['car9']);
});

// ---- panel channel --------------------------------------------------------------------------

test('panel channel sends to the focused worktree carrier, or reports no-carrier', async () => {
  const doc = { getElementById: () => ({ textContent: '{"titles":{},"carriers":["car1"]}' }) };
  const data = readPanelData(doc);
  const sent = [];
  let context = { terminals: [{ id: 't1' }, { id: 'car1' }] };
  const orca = { readContext: async () => context, sendText: async (...args) => (sent.push(args), { accepted: true }) };
  const channel = createPanelChannel({ orca, cliPath: '/p/rpc.mjs', data });
  assert.deepEqual(await channel.send('open-file', { root: '/r' }), { sent: true });
  assert.deepEqual(sent, [['car1', `node /p/rpc.mjs open-file '{"params":{"root":"/r"}}'`, true]]);
  context = { terminals: [{ id: 't1' }] };
  assert.deepEqual(await channel.send('open-file', {}), { sent: false, reason: 'no-carrier' });
  assert.equal(toCliCommand('/p/rpc.mjs', 'a', { params: { c: "x 'y'" } }), `node /p/rpc.mjs a '{"params":{"c":"x '\\''y'\\''"}}'`);
  assert.deepEqual(readPanelData({ getElementById: () => null }), { titles: {}, carriers: [] });
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
  assert.deepEqual(rpc.calls.at(-1), ['terminal.create', { worktree: 'id:w2', command: "cd '/repo/pkg e2e/sub' && npx cucumber-js a.feature", title: 'T', focus: true, presentation: 'focused' }]);
  await assert.rejects(route({ action: 'run-in-terminal', params: { root: '/p' } }), /"command"/);
});
