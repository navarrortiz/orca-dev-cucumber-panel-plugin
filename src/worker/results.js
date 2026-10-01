// Last known result per scenario, from cucumber-js JSON reports (`--format json:<file>`): the
// run may come from the panel, another terminal or CI, cucumber writes the same file either way.
// Pure: fs lives in orca.js, wiring in main.js.
import { join } from 'node:path';

export const DEFAULT_REPORT = 'reports/last-run.json';
export const reportPath = ({ root, report = DEFAULT_REPORT }) => join(root, report);
export const DEFAULT_HTML = 'reports/cucumber-report.html';
export const htmlReportPath = ({ root, html = DEFAULT_HTML }) => join(root, html);

/** Key of a scenario in the results map: by name, not line, so editing the .feature keeps the dot. */
export const resultKey = (root, file, name) => `${root}|${file}|${name}`;

const FAILED = new Set(['failed', 'ambiguous', 'undefined', 'pending']);

/**
 * Cucumber JSON → { "<uri>|<scenario name>": { status: 'passed' | 'failed', error? } }; error = the
 * first failing step/hook and its message (≤ ERROR_MAX chars), shown in the panel's scenario card.
 * Scenarios with only skipped steps (dry run, skipped hooks) are unknown.
 */
export const ERROR_MAX = 1500;
export function parseReport(json) {
  const out = {};
  for (const feature of Array.isArray(json) ? json : []) {
    for (const el of feature.elements ?? []) {
      if (el.type !== 'scenario') continue;
      const steps = [...(el.before ?? []), ...(el.steps ?? []), ...(el.after ?? [])];
      const failing = steps.find((s) => FAILED.has(s.result?.status));
      const status = failing ? 'failed' : steps.some((s) => s.result?.status === 'passed') ? 'passed' : null;
      if (!status) continue;
      const key = `${feature.uri}|${el.name}`;
      if (out[key]?.status === 'failed') continue;
      const error = failing && `${failing.keyword ?? ''}${failing.name ?? ''} → ${failing.result.status}\n${failing.result.error_message ?? ''}`.trim().slice(0, ERROR_MAX);
      out[key] = error ? { status, error } : { status };
    }
  }
  return out;
}

/** Merge one report into the store: only the scenarios it ran change. @returns {boolean} changed */
export function mergeReport(results, root, parsed, at) {
  let changed = false;
  for (const [key, { status, error }] of Object.entries(parsed)) {
    const full = `${root}|${key}`;
    if (results[full]?.at === at && results[full].status === status) continue;
    results[full] = error ? { status, at, error } : { status, at };
    changed = true;
  }
  return changed;
}

/**
 * Targets of the cucumber-js processes alive right now, from `ps -eo pid=,args=` lines: unique
 * `features/x.feature` / `features/x.feature:12` tokens. Any terminal counts (the panel's or not).
 * ponytail: no cwd, so two projects sharing a relative path light up together; read /proc/<pid>/cwd if it matters.
 */
export function runningTargets(processes) {
  return Object.keys(runningPids(processes)).sort();
}

// The binary as a whole token (`cucumber-js`, `cucumber.js`, `.../bin/cucumber`): a plain
// "cucumber" would match this plugin's own path (orca-cucumber-panel-plugin/dist/rpc.mjs) and kill
// the carrier shell, or any shell whose command line mentions a feature and the word.
const CUCUMBER_BIN = /(?:^|[\s/])cucumber(?:-js|\.js)?(?=\s|$)/;

/** { target: [pid, …] } of live cucumber-js processes; `processes` = `ps -eo pid=,args=` lines. */
export function runningPids(processes) {
  const out = {};
  for (const line of processes) {
    if (!CUCUMBER_BIN.test(line)) continue;
    const pid = Number(line.match(/^\s*(\d+)\s/)?.[1]);
    for (const m of line.matchAll(/(?:^|[\s'"=])((?:[\w.-]+\/)*[\w.-]+\.feature(?::\d+)?)(?=$|[\s'"])/g)) {
      (out[m[1]] ??= []);
      if (pid) out[m[1]].push(pid);
    }
  }
  return out;
}
