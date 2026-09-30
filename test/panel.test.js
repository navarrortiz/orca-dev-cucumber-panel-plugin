import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridge } from '../src/panel/bridge.js';
import { describeContext, describeTerminals, filterProjects, shellQuote, toCommand, validateSend } from '../src/panel/lib/format.js';
import { PANEL_MESSAGE } from '../src/shared/protocol.js';

function fakeWindow() {
  const listeners = [];
  const parent = { sent: [], postMessage: (msg) => parent.sent.push(msg) };
  return {
    parent,
    addEventListener: (_type, fn) => listeners.push(fn),
    reply: (data, source = parent) => listeners.forEach((fn) => fn({ source, data })),
  };
}

test('bridge resolves with the value of the matching result', async () => {
  const win = fakeWindow();
  const promise = createBridge(win).call('workspace.readContext');
  const { requestId, type } = win.parent.sent[0];
  assert.equal(type, PANEL_MESSAGE.request);
  win.reply({ type: PANEL_MESSAGE.result, requestId, ok: true, value: 42 });
  assert.equal(await promise, 42);
});

test('bridge rejects with the host error code', async () => {
  const win = fakeWindow();
  const promise = createBridge(win).call('terminal.sendText');
  win.reply({ type: PANEL_MESSAGE.result, requestId: win.parent.sent[0].requestId, ok: false, errorCode: 'rate_limited', error: 'slow down' });
  await assert.rejects(promise, { code: 'rate_limited', message: 'slow down' });
});

test('bridge ignores results from anything but the parent window', async () => {
  const win = fakeWindow();
  const promise = createBridge(win, { timeoutMs: 20 }).call('x');
  win.reply({ type: PANEL_MESSAGE.result, requestId: win.parent.sent[0].requestId, ok: true, value: 1 }, {});
  await assert.rejects(promise, { code: 'timeout' });
});

test('validateSend rejects a missing terminal and oversized text', () => {
  assert.equal(validateSend({ terminalId: '', text: 'ls' }), 'No hay terminal en el worktree activo');
  assert.equal(validateSend({ terminalId: 't1', text: ' ' }), 'Comando vacío');
  assert.match(validateSend({ terminalId: 't1', text: 'x'.repeat(4097) }), /4096/);
  assert.equal(validateSend({ terminalId: 't1', text: 'ls' }), null);
});

test('describeContext skips empty parts and distinguishes no worktree', () => {
  assert.equal(describeContext(null), 'Sin worktree enfocado');
  assert.equal(describeContext({ displayName: 'app', branch: 'main', terminals: [] }), 'app · main');
  assert.equal(describeContext({ displayName: 'app', branch: '', terminals: [] }), 'app');
});

test('filterProjects keeps a matching feature whole, else only matching scenarios', () => {
  const login = { file: 'features/login.feature', name: 'Login', tags: ['@auth'], scenarios: [{ name: 'ok', line: 3, tags: [] }] };
  const cart = { file: 'features/cart.feature', name: 'Cart', tags: [], scenarios: [{ name: 'add item', line: 4, tags: ['@smoke'] }, { name: 'remove', line: 9, tags: [] }] };
  const projects = [{ name: 'app', features: [login, cart] }, { name: 'empty', features: [], error: 'No existe' }];
  assert.equal(filterProjects(projects, '  '), projects);
  assert.deepEqual(filterProjects(projects, '@AUTH'), [{ name: 'app', features: [login] }]);
  assert.deepEqual(filterProjects(projects, 'smoke'), [{ name: 'app', features: [{ ...cart, scenarios: [cart.scenarios[0]] }] }]);
  assert.deepEqual(filterProjects(projects, 'nada'), []);
});

test('toCommand fills {target}, quoting only when the shell needs it', () => {
  assert.equal(toCommand('npx cucumber-js {target}', 'features/a b.feature:12'), "npx cucumber-js 'features/a b.feature:12'");
  assert.equal(toCommand('npx cucumber-js {target}', 'features/a.feature:12'), 'npx cucumber-js features/a.feature:12');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('describeTerminals labels by position with a short id hint', () => {
  assert.deepEqual(describeTerminals([{ id: 'term_141cc39f-5a2f' }, { id: 'x' }]), [
    { id: 'term_141cc39f-5a2f', label: 'Terminal 1', hint: '141cc39f' },
    { id: 'x', label: 'Terminal 2', hint: 'x' },
  ]);
});
