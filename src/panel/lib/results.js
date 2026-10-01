// Last run dots. `results` = { "<root>|<file>|<scenario name>": { status: 'passed'|'failed', at } },
// patched into the panel by the worker (src/worker/results.js). Pure.

const latest = (list) => list.reduce((a, b) => (b.at > a.at ? b : a));
/** failed if any failed (latest failure's date, its errors), else passed (latest date), null if empty. */
function combine(list) {
  if (!list.length) return null;
  const failed = list.filter((r) => r.status === 'failed');
  const errors = failed.flatMap((r) => (r.error ? [r.error] : []));
  return failed.length ? { status: 'failed', at: latest(failed).at, errors } : { status: 'passed', at: latest(list).at, errors };
}
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @returns {{ status: 'passed'|'failed', at: number, errors: string[] } | null}
 * Outlines: cucumber reports each example under the name with `<placeholders>` filled in, so a
 * name with `<…>` is matched as a pattern and its examples combined.
 */
export function scenarioResult(results, root, file, name) {
  const exact = results[`${root}|${file}|${name}`];
  if (exact || !name.includes('<')) return exact ? combine([exact]) : null;
  const prefix = `${root}|${file}|`;
  const re = new RegExp(`^${name.split(/<[^>]*>/).map(escape).join('.*')}$`);
  // Each example's error is prefixed with its filled-in name, so the card tells them apart.
  return combine(
    Object.entries(results)
      .filter(([k]) => k.startsWith(prefix) && re.test(k.slice(prefix.length)))
      .map(([k, r]) => (r.error ? { ...r, error: `${k.slice(prefix.length)}\n${r.error}` } : r)),
  );
}

/** failed if any known scenario failed, passed if every known one passed, null if none ran yet. */
export function featureResult(results, root, file, scenarios) {
  return combine(scenarios.map((s) => scenarioResult(results, root, file, s.name)).filter(Boolean));
}

/** Folder dot: same rule as a feature, over every scenario of its features. */
export function folderResult(results, root, features) {
  return combine(features.flatMap((f) => f.scenarios.map((s) => scenarioResult(results, root, f.file, s.name))).filter(Boolean));
}

/** Tooltip suffix: "Última ejecución: falló (hace 2 horas)". Intl.RelativeTimeFormat, no lib. */
export function describeResult(result, now = Date.now(), locale = 'es') {
  if (!result) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const diff = (result.at - now) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const [unit, size] = units.find(([, size]) => Math.abs(diff) >= size) ?? ['second', 1];
  const ago = Math.abs(diff) < 45 ? 'ahora mismo' : rtf.format(Math.round(diff / size), unit);
  return `Última ejecución: ${result.status === 'failed' ? 'falló' : 'pasó'} (${ago})`;
}

/**
 * `running` = targets of live cucumber-js runs (`file` or `file:line`). A feature spins if it or any
 * of its scenarios runs; a scenario spins if it runs or its whole feature does.
 */
export function isRunning(running, file, scenarios, line) {
  if (running.includes(file)) return true;
  if (line) return running.includes(`${file}:${line}`);
  return scenarios.some((s) => running.includes(`${file}:${s.line}`));
}

/**
 * One stored error → lines tagged for display: `name` (outline example, before the step line),
 * `step` (the failing step, `status` split off after " → "), `message`, `stack` ("    at …"),
 * `cause` ("Caused by…"). Pure; the view maps kinds to CSS classes.
 */
export function highlightError(text) {
  const out = [];
  let seenStep = false;
  for (const line of text.split('\n')) {
    if (!seenStep) {
      const m = line.match(/^(.*) → (\w+)$/);
      if (m) {
        out.push({ kind: 'step', text: m[1] }, { kind: 'status', text: m[2] });
        seenStep = true;
      } else out.push({ kind: 'name', text: line });
    } else if (/^\s+at\s/.test(line)) out.push({ kind: 'stack', text: line.trim() });
    else if (/^Caused by/i.test(line)) out.push({ kind: 'cause', text: line });
    else if (line.trim()) out.push({ kind: 'message', text: line });
  }
  return out;
}

/**
 * Failure context for the clipboard (paste into an agent chat): scenario, absolute file:line, then
 * each stored error as is (step → status, message, stack; outline examples prefixed with their name).
 */
export function errorContext(root, file, { keyword = 'Scenario', name, line }, errors) {
  return [`${keyword} fallido: ${name}`, `Archivo: ${root.replace(/\/+$/, '')}/${file}:${line}`, '', errors.join('\n\n')].join('\n');
}
