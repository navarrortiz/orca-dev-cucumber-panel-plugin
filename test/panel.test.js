import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridge } from '../src/panel/bridge.js';
import { describeContext, describeTerminals, featuresIn, filterProjects, folderTree, shellQuote, terminalIcon, toCommand, highlightSteps, itemMenu, referenceText, validateSend } from '../src/panel/lib/format.js';
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

test('itemMenu appends projects.json commands, the template as id', () => {
  const menu = itemMenu({ Headed: 'H=1 x {target}' });
  assert.deepEqual(menu.map((m) => m.id), ['run', 'H=1 x {target}', 'send', 'open', 'report']);
  assert.deepEqual(menu[1], { id: 'H=1 x {target}', label: 'Headed…', hint: '', icon: 'eye' });
  assert.deepEqual(itemMenu().map((m) => m.id), ['run', 'send', 'open', 'report']);
  assert.deepEqual(itemMenu({}, false).map((m) => m.id), ['run', 'send', 'report']); // folder: nothing to open
});

test('referenceText: absolute path, optional title', () => {
  assert.equal(referenceText('/p/', 'f.feature:3', 'Escenario: N'), '/p/f.feature:3 (Escenario: N)');
  assert.equal(referenceText('/p', 'features/a/'), '/p/features/a/');
});

test('toCommand fills {target}, quoting only when the shell needs it', () => {
  assert.equal(toCommand('npx cucumber-js {target}', 'features/a b.feature:12'), "npx cucumber-js 'features/a b.feature:12'");
  assert.equal(toCommand('npx cucumber-js {target}', 'features/a.feature:12'), 'npx cucumber-js features/a.feature:12');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('describeTerminals uses the patched title and agent icon, else position + terminal icon, plus the new-terminal option', () => {
  assert.deepEqual(describeTerminals([{ id: 'term_141cc39f-5a2f' }, { id: 'x' }], { x: { title: '✳ Readme', agent: 'claude' } }), [
    { id: 'term_141cc39f-5a2f', label: 'Terminal 1', hint: '141cc39f', icon: 'terminal' },
    { id: 'x', label: 'Readme', hint: 'x', icon: 'claude' },
    { id: '__new__', label: 'Terminal nueva', hint: 'rpc', icon: 'new' },
  ]);
  assert.equal(describeTerminals([{ id: 'x' }])[0].label, 'Terminal 1');
  assert.equal(describeTerminals([{ id: 'x' }], { x: { title: '✳ ◐ Nueva <terminal>' } })[0].label, 'Nueva <terminal>');
  assert.equal(describeTerminals([{ id: 'x' }], { x: { title: '✳' } })[0].label, 'Terminal 1');
  assert.equal(terminalIcon('codex'), 'codex');
  assert.equal(terminalIcon('cursor'), 'bot');
  assert.equal(terminalIcon(undefined), 'terminal');
});



test('highlightSteps tokenizes steps, params, strings, Examples tables and doc strings', () => {
  const kinds = (row) => row.tokens.map((t) => `${t.kind}:${t.text}`);
  const [step, examples, head, body, open, doc] = highlightSteps(['Dado que abre "agenda" de <rol>', 'Ejemplos:', '| rol |', '| doctor |', '"""', 'texto']);
  assert.deepEqual(kinds(step), ['keyword:Dado', 'text: que abre ', 'string:"agenda"', 'text: de ', 'param:<rol>']);
  assert.deepEqual([examples.type, kinds(examples)], ['section', ['keyword:Ejemplos:']]);
  assert.deepEqual([head.header, body.header], [true, false]);
  assert.deepEqual(kinds(body), ['pipe:|', 'text: doctor ', 'pipe:|']);
  assert.deepEqual([open.type, doc.type, kinds(doc)], ['doc', 'doc', ['string:texto']]);
  assert.deepEqual(kinds(highlightSteps(['Yuca crece'])[0]), ['text:Yuca crece']); // "Y" only as a whole word
});

test('folderTree groups features by folder and compacts single-child chains', () => {
  const f = (file) => ({ file });
  const tree = folderTree(
    [f('features/admin-app/autenticacion/login-feature/login.feature'), f('features/tenant-app/citas/a/x.feature'), f('features/tenant-app/citas/b/y.feature'), f('features/top.feature')],
    './features/',
  );
  assert.deepEqual(tree.features.map((x) => x.file), ['features/top.feature']);
  assert.deepEqual(tree.folders.map((x) => [x.name, x.path]), [
    ['admin-app/autenticacion/login-feature', 'features/admin-app/autenticacion/login-feature'],
    ['tenant-app/citas', 'features/tenant-app/citas'],
  ]);
  assert.deepEqual(tree.folders[1].folders.map((x) => x.name), ['a', 'b']);
  assert.equal(featuresIn(tree).length, 4);
});
