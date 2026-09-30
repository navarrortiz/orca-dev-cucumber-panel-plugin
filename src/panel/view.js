// Presentation only: reads/writes the DOM, exposes user intents as callbacks.
// No host calls, no business rules.
export function createView(doc) {
  const el = (id) => doc.getElementById(id);
  const ui = {
    summary: el('summary'),
    refresh: el('refresh'),
    query: el('query'),
    list: el('list'),
    empty: el('empty'),
    status: el('status'),
    projectTpl: el('project-template'),
    featureTpl: el('feature-template'),
    scenarioTpl: el('scenario-template'),
    menu: el('terminal-menu'),
    menuItems: el('terminal-menu-items'),
    menuItem: el('menu-item-template'),
  };
  let runHandler = () => {};
  const clone = (tpl) => tpl.content.firstElementChild.cloneNode(true);

  // textContent only: names, tags and paths come from the user's .feature files.
  function wireRun(button, run, busy, tooltip) {
    button.disabled = busy;
    button.title = tooltip;
    // Pass a point, not the row: the next render replaces the row before the popup opens.
    // Mouse clicks open the popup at the pointer (like Orca's context menus); keyboard ones under the row.
    button.addEventListener('click', (event) => {
      const box = button.getBoundingClientRect();
      runHandler(run, event.detail ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom });
    });
  }

  function renderScenario(project, feature, scenario, busy) {
    const item = clone(ui.scenarioTpl);
    const row = item.querySelector('.row');
    const target = `${feature.file}:${scenario.line}`;
    row.querySelector('.row-title').textContent = scenario.name;
    row.querySelector('.row-preview').textContent = scenario.tags.join(' ');
    wireRun(row, { command: project.command, target, label: scenario.name }, busy, `Ejecutar ${target}`);
    return item;
  }

  function renderFeature(project, feature, busy) {
    const item = clone(ui.featureTpl);
    const row = item.querySelector('.row');
    row.querySelector('.row-title').textContent = feature.name;
    row.querySelector('.row-preview').textContent = feature.file;
    wireRun(row, { command: project.command, target: feature.file, label: feature.name }, busy, `Ejecutar ${feature.file}`);
    item.querySelector('.scenarios').replaceChildren(...feature.scenarios.map((s) => renderScenario(project, feature, s, busy)));
    return item;
  }

  function renderProject(project, busy) {
    const item = clone(ui.projectTpl);
    const count = project.features.reduce((n, f) => n + f.scenarios.length, 0);
    item.querySelector('.project-name').textContent = project.name;
    item.querySelector('.project-meta').textContent = project.error ?? `${project.features.length} features · ${count} escenarios`;
    item.querySelector('.project-meta').classList.toggle('error', Boolean(project.error));
    const runAll = item.querySelector('.run-all');
    runAll.hidden = Boolean(project.error);
    wireRun(runAll, { command: project.command, target: project.dir, label: `${project.name} (todo)` }, busy, `Ejecutar todo ${project.dir}`);
    item.querySelector('.features').replaceChildren(...project.features.map((f) => renderFeature(project, f, busy)));
    return item;
  }

  return {
    render({ summary, projects, visible, query, status, busy }) {
      ui.summary.textContent = summary;
      ui.status.textContent = status;
      ui.refresh.disabled = busy;
      ui.list.replaceChildren(...visible.map((p) => renderProject(p, busy)));
      ui.empty.textContent = visible.length ? '' : query ? 'Sin resultados' : projects.length ? '' : 'Aún no hay proyectos';
    },
    onRefresh: (fn) => ui.refresh.addEventListener('click', fn),
    onQuery: (fn) => ui.query.addEventListener('input', () => fn(ui.query.value)),
    /** fn({ command, target, label }, point) */
    onRun: (fn) => (runHandler = fn),

    /** Popup at viewport `point`; resolves the picked terminal id, or null if dismissed. */
    chooseTerminal(terminals, point) {
      return new Promise((resolve) => {
        const close = (id) => {
          ui.menu.hidden = true;
          doc.removeEventListener('pointerdown', onOutside, true);
          doc.removeEventListener('keydown', onKey, true);
          resolve(id);
        };
        const onOutside = (event) => ui.menu.contains(event.target) || close(null);
        const onKey = (event) => event.key === 'Escape' && close(null);

        ui.menuItems.replaceChildren(
          ...terminals.map(({ id, label, hint }) => {
            const item = ui.menuItem.content.firstElementChild.cloneNode(true);
            item.querySelector('.menu-item-label').textContent = label;
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
