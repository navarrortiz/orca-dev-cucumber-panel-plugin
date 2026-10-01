// Presentation only: reads/writes the DOM, exposes user intents as callbacks.
// No host calls, no business rules.
import { featuresIn, folderTree, highlightSteps, referenceText } from './lib/format.js';
import { describeResult, featureResult, folderResult, errorContext, highlightError, isRunning, scenarioResult } from './lib/results.js';

export function createView(doc) {
  const el = (id) => doc.getElementById(id);
  const ui = {
    summary: el('summary'),
    refresh: el('refresh'),
    editProjects: el('edit-projects'),
    query: el('query'),
    list: el('list'),
    empty: el('empty'),
    status: el('status'),
    projectTpl: el('project-template'),
    featureTpl: el('feature-template'),
    folderTpl: el('folder-template'),
    scenarioTpl: el('scenario-template'),
    menu: el('terminal-menu'),
    menuLabel: el('terminal-menu-label'),
    menuItems: el('terminal-menu-items'),
    menuItem: el('menu-item-template'),
  };
  const handlers = { run: () => {}, stop: () => {}, more: () => {}, toggle: () => {}, report: () => {}, copy: () => {} };
  const clone = (tpl) => tpl.content.firstElementChild.cloneNode(true);
  /** Last-run dot on a row (CSS .passed/.failed) + its date in the tooltip. */
  function mark(row, result, running) {
    if (running) row.classList.add('running');
    if (!result) return;
    row.classList.add(result.status);
    row.title += ` · ${describeResult(result)}`;
  }

  // textContent only: names, tags and paths come from the user's .feature files.
  function wire(button, kind, payload, busy, tooltip) {
    button.disabled = busy;
    button.title = tooltip;
    // Pass a point, not the row: the next render replaces the row before the popup opens.
    // Mouse clicks open the popup at the pointer (like Orca's context menus); keyboard ones under the row.
    button.addEventListener('click', (event) => {
      const box = button.getBoundingClientRect();
      handlers[kind](payload, event.detail ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom });
    });
  }

  // Definition card: spans with textContent only (step text comes from the user's files).
  function renderSteps(pre, steps) {
    const lines = highlightSteps(steps).map(({ type, header, tokens }) => {
      const line = doc.createElement('span');
      line.className = `line ${type}${header ? ' header' : ''}`;
      line.append(...tokens.map(({ kind, text }) => {
        const span = doc.createElement('span');
        span.className = kind;
        span.textContent = text;
        return span;
      }));
      return line;
    });
    if (!lines.length) lines.push(Object.assign(doc.createElement('span'), { className: 'line empty', textContent: 'Sin pasos' }));
    pre.replaceChildren(...lines);
  }

  // Last run's failure(s) under the steps: step + status badge, message, stack folded in a native
  // <details>, and the report CTA. textContent only: this is cucumber output.
  function renderErrors(box, errors, payload, busy) {
    const span = (kind, text) => Object.assign(doc.createElement('span'), { className: `err-${kind}`, textContent: text });
    const blocks = errors.map((text) => {
      const block = doc.createElement('div');
      block.className = 'err';
      const lines = highlightError(text);
      const stack = lines.filter((l) => l.kind === 'stack');
      block.append(...lines.filter((l) => l.kind !== 'stack').map((l) => span(l.kind, l.text)));
      if (stack.length) {
        const details = doc.createElement('details');
        details.append(Object.assign(doc.createElement('summary'), { textContent: `Stack (${stack.length})` }), ...stack.map((l) => span('stack', l.text)));
        block.append(details);
      }
      return block;
    });
    const cta = doc.createElement('button');
    cta.className = 'err-report';
    cta.textContent = 'Ver en el reporte';
    wire(cta, 'report', payload, busy, 'Abre el reporte de cucumber en el navegador de Orca');
    const copy = doc.createElement('button');
    copy.className = 'err-report';
    copy.textContent = 'Copiar contexto';
    wire(copy, 'copy', payload, busy, 'Copia escenario, archivo:línea, paso, error y stack al portapapeles');
    box.replaceChildren(...blocks, cta, copy);
  }

  // Explicit ▷ next to the other row buttons (row click = expand/collapse); ■ while that target runs.
  function runButton(item, live, payload, busy) {
    const button = item.querySelector('.run');
    button.classList.toggle('running', live);
    button.setAttribute('aria-label', live ? 'Detener' : 'Ejecutar');
    wire(button, live ? 'stop' : 'run', payload, busy, `${live ? 'Detener' : 'Ejecutar'} ${payload.target}`);
  }

  function renderScenario(project, feature, scenario, busy, expanded, results, running) {
    const item = clone(ui.scenarioTpl);
    const row = item.querySelector('.row');
    const target = `${feature.file}:${scenario.line}`;
    const key = `${project.root}\0${target}`;
    const open = expanded.has(key);
    item.classList.toggle('open', open);
    const toggle = item.querySelector('.toggle');
    toggle.title = open ? 'Ocultar definición' : 'Ver definición';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.addEventListener('click', () => handlers.toggle(key));
    const result = scenarioResult(results, project.root, feature.file, scenario.name);
    const pre = item.querySelector('.gherkin');
    pre.hidden = !open;
    if (open) renderSteps(pre, scenario.steps ?? []); // only open cards: the list re-renders often
    const errors = item.querySelector('.errors');
    errors.hidden = !open || !result?.errors?.length;
    if (!errors.hidden) renderErrors(errors, result.errors, { root: project.root, label: scenario.name, text: errorContext(project.root, feature.file, scenario, result.errors) }, busy);
    // Failed: a ⚠ button that opens the card at the error (same card as the chevron).
    const seeError = item.querySelector('.see-error');
    seeError.hidden = !result?.errors?.length;
    seeError.addEventListener('click', () => open || handlers.toggle(key));
    wire(item.querySelector('.more'), 'more', { command: project.command, target, label: scenario.name, root: project.root, file: feature.file, commands: project.commands, text: referenceText(project.root, target, `${scenario.keyword ?? 'Scenario'}: ${scenario.name}`) }, busy, 'Más acciones');
    row.querySelector('.row-title').textContent = scenario.name;
    row.querySelector('.row-preview').textContent = scenario.tags.join(' ');
    const live = isRunning(running, feature.file, [], scenario.line);
    runButton(item, live, { command: project.command, target, label: scenario.name, root: project.root }, busy);
    row.title = target;
    row.setAttribute('aria-expanded', String(open));
    row.addEventListener('click', () => handlers.toggle(key));
    mark(row, result, live);
    return item;
  }

  function renderFeature(project, feature, busy, collapsed, expanded, results, running) {
    const item = clone(ui.featureTpl);
    const key = `${project.root}\0${feature.file}`;
    const isCollapsed = collapsed.has(key);
    item.classList.toggle('collapsed', isCollapsed);
    const row = item.querySelector('.row');
    row.querySelector('.row-title').textContent = feature.name;
    row.querySelector('.row-preview').textContent = feature.tags.join(' '); // path only in the tooltip
    const live = isRunning(running, feature.file, feature.scenarios);
    runButton(item, live, { command: project.command, target: feature.file, label: feature.name, root: project.root }, busy);
    row.title = feature.file;
    row.setAttribute('aria-expanded', String(!isCollapsed));
    row.addEventListener('click', () => handlers.toggle(key)); // not busy-gated: view-only
    mark(row, featureResult(results, project.root, feature.file, feature.scenarios), live);
    const toggle = item.querySelector('.toggle');
    toggle.title = isCollapsed ? 'Expandir escenarios' : 'Colapsar escenarios';
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.addEventListener('click', () => handlers.toggle(key)); // not busy-gated: view-only
    wire(item.querySelector('.more'), 'more', { command: project.command, target: feature.file, label: feature.name, root: project.root, file: feature.file, commands: project.commands, text: referenceText(project.root, feature.file, `Feature: ${feature.name}`) }, busy, 'Más acciones');
    item.querySelector('.scenarios').replaceChildren(...feature.scenarios.map((s) => renderScenario(project, feature, s, busy, expanded, results, running)));
    return item;
  }

  function renderProject(project, busy, collapsed, expanded, results, running, query) {
    const item = clone(ui.projectTpl);
    const count = project.features.reduce((n, f) => n + f.scenarios.length, 0);
    item.querySelector('.project-name').textContent = project.name;
    item.querySelector('.project-meta').textContent = project.error ?? `${project.features.length} features · ${count} escenarios`;
    item.querySelector('.project-meta').classList.toggle('error', Boolean(project.error));
    const runAll = item.querySelector('.run-all');
    runAll.hidden = Boolean(project.error);
    wire(runAll, 'run', { command: project.command, target: project.dir, label: `${project.name} (todo)`, root: project.root }, busy, `Ejecutar todo ${project.dir}`);
    const tree = folderTree(project.features, project.dir);
    item.querySelector('.features').replaceChildren(
      ...tree.folders.map((f) => renderFolder(project, f, 0, busy, collapsed, expanded, results, running, query)),
      ...tree.features.map((f) => renderFeature(project, f, busy, collapsed, expanded, results, running)),
    );
    return item;
  }

  // Collapsible folder section: top level = sticky band, nested ones indented by --d. Header click
  // toggles (navigation); running the whole folder is the explicit ▷. A search shows every match.
  function renderFolder(project, node, depth, busy, collapsed, expanded, results, running, query) {
    const item = clone(ui.folderTpl);
    const features = featuresIn(node);
    const key = `${project.root}\0${node.path}/`;
    const isCollapsed = !query && collapsed.has(key);
    item.classList.toggle('collapsed', isCollapsed);
    item.classList.toggle('nested', depth > 0);
    item.style.setProperty('--d', depth);
    const row = item.querySelector('.row');
    row.title = node.path;
    row.setAttribute('aria-expanded', String(!isCollapsed));
    row.querySelector('.row-title').textContent = node.name.split('/').join(' › ');
    const count = features.reduce((n, f) => n + f.scenarios.length, 0);
    const badge = row.querySelector('.folder-count');
    badge.textContent = `${features.length} · ${count}`;
    badge.title = `${features.length} ${features.length === 1 ? 'feature' : 'features'} · ${count} ${count === 1 ? 'escenario' : 'escenarios'}`;
    row.addEventListener('click', () => handlers.toggle(key));
    mark(row, folderResult(results, project.root, features), features.some((f) => isRunning(running, f.file, f.scenarios)));
    const payload = { command: project.command, target: node.path, label: node.path, root: project.root };
    wire(item.querySelector('.run-folder'), 'run', payload, busy, `Ejecutar ${node.path}`);
    wire(item.querySelector('.more'), 'more', { ...payload, commands: project.commands, text: referenceText(project.root, `${node.path}/`) }, busy, 'Más acciones');
    item.querySelector('.tree').replaceChildren(
      ...node.folders.map((child) => renderFolder(project, child, depth + 1, busy, collapsed, expanded, results, running, query)),
      ...node.features.map((f) => renderFeature(project, f, busy, collapsed, expanded, results, running)),
    );
    return item;
  }

  return {
    render({ summary, projects, visible, query, status, busy, collapsed, expanded, results, running }) {
      ui.summary.textContent = summary;
      ui.status.textContent = status;
      ui.refresh.disabled = ui.editProjects.disabled = busy;
      ui.list.replaceChildren(...visible.map((p) => renderProject(p, busy, collapsed, expanded, results, running, query)));
      ui.empty.textContent = visible.length ? '' : query ? 'Sin resultados' : projects.length ? '' : 'Aún no hay proyectos';
    },
    onRefresh: (fn) => ui.refresh.addEventListener('click', fn),
    onEditProjects: (fn) => ui.editProjects.addEventListener('click', fn),
    onQuery: (fn) => ui.query.addEventListener('input', () => fn(ui.query.value)),
    /** fn({ command, target, label, root }, point) */
    onRun: (fn) => (handlers.run = fn),
    /** fn({ target, label }, point): the ▷ of a running row turned into ■ */
    onStop: (fn) => (handlers.stop = fn),
    /** fn({ root, label }, point): "Ver reporte HTML" inside an error card */
    onReport: (fn) => (handlers.report = fn),
    onCopy: (fn) => (handlers.copy = fn),
    /** fn({ command, target, label, root, file }, point): the feature's ⋯ button */
    onMore: (fn) => (handlers.more = fn),
    /** fn(key): a feature's chevron (collapse scenarios) or a scenario's (show definition) */
    onToggle: (fn) => (handlers.toggle = fn),

    /** Popup at viewport `point` over [{ id, label, hint, icon }]; resolves the picked id, or null if dismissed. */
    choose(terminals, point, label) {
      return new Promise((resolve) => {
        ui.menuLabel.textContent = label;
        const close = (id) => {
          ui.menu.hidden = true;
          doc.removeEventListener('pointerdown', onOutside, true);
          doc.removeEventListener('keydown', onKey, true);
          resolve(id);
        };
        const onOutside = (event) => ui.menu.contains(event.target) || close(null);
        const onKey = (event) => event.key === 'Escape' && close(null);

        ui.menuItems.replaceChildren(
          ...terminals.map(({ id, label, hint, icon }) => {
            const item = ui.menuItem.content.firstElementChild.cloneNode(true);
            // Icon per agent: templates `icon-<kind>`; an unknown kind keeps the template's terminal icon.
            const svg = el(`icon-${icon}`)?.content.firstElementChild;
            if (svg) item.querySelector('svg').replaceWith(svg.cloneNode(true));
            item.querySelector('.menu-item-label').textContent = label;
            item.title = label; // full name on hover: the label is truncated to one line
            item.querySelector('.menu-item-hint').textContent = hint;
            item.addEventListener('click', () => close(id));
            return item;
          }),
        );
        ui.menu.hidden = false;
        // Keep it inside the panel: clamp right, flip above the point when it would overflow below.
        const win = doc.defaultView;
        const { width, height } = ui.menu.getBoundingClientRect();
        const x = Math.max(4, Math.min(point.x, win.innerWidth - width - 4));
        const y = point.y + height > win.innerHeight - 4 ? Math.max(4, point.y - height) : point.y;
        ui.menu.style.left = `${x + win.scrollX}px`;
        ui.menu.style.top = `${y + win.scrollY}px`;
        ui.menuItems.firstElementChild.focus();
        doc.addEventListener('pointerdown', onOutside, true);
        doc.addEventListener('keydown', onKey, true);
      });
    },
  };
}
