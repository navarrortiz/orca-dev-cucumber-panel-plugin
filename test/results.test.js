import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeReport, parseReport, reportPath } from '../src/worker/results.js';
import { refreshResults } from '../src/worker/handlers.js';
import { describeResult, errorContext, featureResult, highlightError, scenarioResult } from '../src/panel/lib/results.js';

const step = (status) => ({ result: { status } });
const REPORT = [
  {
    uri: 'features/login.feature',
    elements: [
      { type: 'background', name: '', steps: [step('passed')] },
      { type: 'scenario', name: 'Entra', steps: [step('passed'), step('passed')] },
      { type: 'scenario', name: 'Falla en hook', before: [{ result: { status: 'failed', error_message: 'Error: boom\n  at x' } }], steps: [step('skipped')] },
      { type: 'scenario', name: 'Outline', steps: [step('passed')] },
      { type: 'scenario', name: 'Outline', steps: [{ keyword: 'Dado ', name: 'algo', result: { status: 'undefined' } }] },
      { type: 'scenario', name: 'Dry', steps: [step('skipped')] },
    ],
  },
];

test('parseReport: passed/failed per scenario name, hooks count, outlines merge, skipped-only ignored', () => {
  assert.deepEqual(parseReport(REPORT), {
    'features/login.feature|Entra': { status: 'passed' },
    'features/login.feature|Falla en hook': { status: 'failed', error: '→ failed\nError: boom\n  at x' },
    'features/login.feature|Outline': { status: 'failed', error: 'Dado algo → undefined' },
  });
  assert.deepEqual(parseReport({ not: 'an array' }), {});
});

test('mergeReport keeps scenarios the run did not touch and reports changes', () => {
  const results = { '/p|features/a.feature|Old': { status: 'failed', at: 1 } };
  assert.equal(mergeReport(results, '/p', { 'features/a.feature|New': { status: 'passed' } }, 2), true);
  assert.equal(mergeReport(results, '/p', { 'features/a.feature|New': { status: 'passed' } }, 2), false);
  assert.deepEqual(results, { '/p|features/a.feature|Old': { status: 'failed', at: 1 }, '/p|features/a.feature|New': { status: 'passed', at: 2 } });
});

test('refreshResults reads each report, tolerates missing/half-written ones, persists on change', async () => {
  const written = [];
  const reports = { '/a': { text: JSON.stringify(REPORT), mtimeMs: 5 }, '/b': { text: '[{"uri":', mtimeMs: 6 } };
  const deps = { readReport: (p) => reports[p.root] ?? null, writeResults: async (r) => written.push(structuredClone(r)) };
  const results = {};
  assert.equal(await refreshResults(deps, [{ root: '/a' }, { root: '/b' }, { root: '/c' }], results), true);
  assert.equal(results['/a|features/login.feature|Entra'].status, 'passed');
  assert.equal(written.length, 1);
  assert.equal(await refreshResults(deps, [{ root: '/a' }], results), false);
  assert.equal(written.length, 1);
  assert.equal(reportPath({ root: '/a' }), '/a/reports/last-run.json');
  assert.equal(reportPath({ root: '/a', report: 'out/r.json' }), '/a/out/r.json');
});

test('panel: feature dot = failed if any known scenario failed, latest date wins, unknown when none ran', () => {
  const results = { '/p|f|A': { status: 'passed', at: 10 }, '/p|f|B': { status: 'failed', at: 3 } };
  assert.deepEqual(scenarioResult(results, '/p', 'f', 'A'), { status: 'passed', at: 10, errors: [] });
  assert.equal(scenarioResult(results, '/p', 'f', 'Z'), null);
  assert.deepEqual(featureResult(results, '/p', 'f', [{ name: 'A' }, { name: 'B' }, { name: 'Z' }]), { status: 'failed', at: 3, errors: [] });
  assert.deepEqual(featureResult(results, '/p', 'f', [{ name: 'A' }, { name: 'Z' }]), { status: 'passed', at: 10, errors: [] });
  assert.equal(featureResult(results, '/p', 'f', [{ name: 'Z' }]), null);
  assert.equal(describeResult({ status: 'failed', at: 1000 - 2 * 3600_000 }, 1000), 'Última ejecución: falló (hace 2 horas)');
  assert.equal(describeResult({ status: 'passed', at: 1000 }, 1000), 'Última ejecución: pasó (ahora mismo)');
  assert.equal(describeResult({ status: 'passed', at: 1000 - 86400_000 }, 1000), 'Última ejecución: pasó (ayer)');
  assert.equal(describeResult(null), '');
});

test('runningTargets: feature/scenario tokens of live cucumber-js command lines', async () => {
  const { runningTargets } = await import('../src/worker/results.js');
  const { watchRunning } = await import('../src/worker/handlers.js');
  const { isRunning } = await import('../src/panel/lib/results.js');
  const lines = [
    'node /x/cucumber-js --profile panel features/auth/login.feature:12',
    "sh -c cd /p && E2E=1 pnpm exec cucumber-js --profile panel 'features/auth/login.feature:12'",
    'node cucumber-js features/b.feature features',
    'vim features/c.feature',
  ];
  assert.deepEqual(runningTargets(lines), ['features/auth/login.feature:12', 'features/b.feature']);
  assert.equal(isRunning(['features/a.feature:12'], 'features/a.feature', [], 12), true);
  assert.equal(isRunning(['features/a.feature:12'], 'features/a.feature', [{ line: 12 }]), true);
  assert.equal(isRunning(['features/a.feature'], 'features/a.feature', [], 12), true); // whole feature running
  assert.equal(isRunning(['features/a.feature'], 'features/a.feature', []), true);
  const seen = [];
  let procs = lines;
  const stop = watchRunning({ listProcesses: async () => procs }, (t) => seen.push(t), 5);
  await new Promise((r) => setTimeout(r, 12));
  procs = [];
  await new Promise((r) => setTimeout(r, 12));
  stop();
  assert.deepEqual(seen, [['features/auth/login.feature:12', 'features/b.feature'], []]);
});

test('runningPids + stopRun: pids per target, kill only those of the target', async () => {
  const { runningPids } = await import('../src/worker/results.js');
  const { stopRun } = await import('../src/worker/handlers.js');
  const procs = [' 11 node pnpm exec cucumber-js --profile panel features/a.feature:5', '12 node cucumber.js --profile panel features/a.feature:5', '13 node cucumber.js features/b.feature'];
  assert.deepEqual(runningPids(procs), { 'features/a.feature:5': [11, 12], 'features/b.feature': [13] });
  const killed = [];
  const deps = { listProcesses: async () => procs, kill: (pids) => killed.push(pids) };
  assert.deepEqual(await stopRun(deps, 'features/a.feature:5'), { killed: 2 });
  assert.deepEqual(await stopRun(deps, 'features/zzz.feature'), { killed: 0 });
  assert.deepEqual(await stopRun(deps, 'features/b.feature:9'), { killed: 1 }); // falls back to the feature run
  assert.deepEqual(killed, [[11, 12], [13]]);
});

test('runningPids ignores lines that only mention "cucumber" inside another word (the plugin path, the stop command itself)', async () => {
  const { runningPids } = await import('../src/worker/results.js');
  assert.deepEqual(runningPids(['7 node /x/orca-cucumber-panel-plugin/dist/rpc.mjs stop-run {"params":{"target":"features/a.feature:5"}}', '8 bash -c grep "cucumber" features/a.feature:5']), {});
  assert.deepEqual(runningPids(['9 node ./node_modules/@cucumber/cucumber/bin/cucumber.js --profile panel features/a.feature:5']), { 'features/a.feature:5': [9] });
});

test('outline scenarios: results of the filled-in example names combine under the <placeholder> name', () => {
  const results = {
    '/p|f|El drawer en estado ABIERTA ofrece acciones': { status: 'passed', at: 5 },
    '/p|f|El drawer en estado CERRADA ofrece acciones': { status: 'failed', at: 2, error: 'boom' },
    '/p|f|Otro (x)': { status: 'passed', at: 9 },
  };
  assert.deepEqual(scenarioResult(results, '/p', 'f', 'El drawer en estado <codigo> ofrece acciones'), { status: 'failed', at: 2, errors: ['El drawer en estado CERRADA ofrece acciones\nboom'] });
  assert.equal(scenarioResult(results, '/p', 'f', 'El drawer en estado <codigo> cierra'), null);
  assert.deepEqual(scenarioResult(results, '/p', 'f', 'Otro (<v>)'), { status: 'passed', at: 9, errors: [] });
  assert.equal(featureResult(results, '/p', 'f', [{ name: 'El drawer en estado <codigo> ofrece acciones' }]).status, 'failed');
});

test('openReport serves the HTML report over loopback and opens it in the Orca browser of the project worktree', async () => {
  const { openReport } = await import('../src/worker/handlers.js');
  const opened = [];
  const runtime = { openUrl: async (url) => opened.push(url) };
  assert.deepEqual(await openReport({ serveReport: async ({ root }) => `http://127.0.0.1:1/report?root=${root}` }, runtime, '/p'), { url: 'http://127.0.0.1:1/report?root=/p' });
  assert.deepEqual(opened, ['http://127.0.0.1:1/report?root=/p']);
});

test('highlightError tags example name, failing step + status, message, stack and cause', () => {
  const text = 'En estado X\nCuando abre la cita → failed\nError: waitForSelector: Timeout\n    at RPCClient.receive (/x.js:1)\n    at y (/y.js:2)\nCaused by: [object Object]';
  assert.deepEqual(highlightError(text), [
    { kind: 'name', text: 'En estado X' },
    { kind: 'step', text: 'Cuando abre la cita' },
    { kind: 'status', text: 'failed' },
    { kind: 'message', text: 'Error: waitForSelector: Timeout' },
    { kind: 'stack', text: 'at RPCClient.receive (/x.js:1)' },
    { kind: 'stack', text: 'at y (/y.js:2)' },
    { kind: 'cause', text: 'Caused by: [object Object]' },
  ]);
  assert.deepEqual(highlightError('Dado algo → undefined'), [{ kind: 'step', text: 'Dado algo' }, { kind: 'status', text: 'undefined' }]);
});

test('errorContext: scenario, absolute file:line, errors as stored', () => {
  assert.equal(
    errorContext('/p/', 'f.feature', { keyword: 'Escenario', name: 'N', line: 3 }, ['Cuando x → failed\nError: boom\n    at y']),
    'Escenario fallido: N\nArchivo: /p/f.feature:3\n\nCuando x → failed\nError: boom\n    at y',
  );
});
