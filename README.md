# Cucumber Features — Orca plugin

A right-sidebar panel for [Orca](https://github.com/stablyai/orca) that lists the Cucumber
features and scenarios of your projects and runs them in a terminal of the focused worktree.

- **Panel** (`bug` icon): search by feature, scenario, file or `@tag`; click a feature to run the
  file, a scenario to run `file:line`, or ▶ next to a project to run all of it.
- **Command palette**: `Cucumber: Editar proyectos` opens `projects.json` in Orca's editor,
  `Cucumber: Recargar features` rescans the feature folders.
- Output and results stay in the terminal: Orca's plugin API can't read terminal output.

> Orca's plugin system is **experimental** (pluginApi 1, tested on Orca 1.4.216). Things may break
> after an Orca upgrade.

## Requirements

- Orca ≥ 1.4.0
- Node.js ≥ 20.1 (recursive `readdir`/`--watch-path`)
- pnpm

## Development install

1. Clone and build:

   ```bash
   git clone <this repo> orca-cucumber-panel-plugin
   cd orca-cucumber-panel-plugin
   pnpm install
   pnpm build          # → dist/ (the installable plugin)
   ```

   The first build creates your personal `projects.json` (gitignored) from `projects.default.json`.

2. Edit `projects.json` (see below) and run `pnpm build` again.

3. In Orca: **Settings → Plugins → dev plugin paths**, add the absolute path to this repo's
   `dist/` folder and accept the consent dialog (workspace read, terminal send, notifications,
   trusted Node worker).

4. Open the right sidebar — the panel shows up under the `bug` icon.

5. Live reload while developing the plugin itself:

   ```bash
   pnpm dev            # rebuilds dist/ on changes to src/, orca-plugin.json or projects.json
   ```

   Orca watches dev paths and reloads the plugin by itself. If you change capabilities or the
   worker, Orca asks you to approve the new fingerprint in Settings.

Use a **dev plugin path**, not *Install plugin → Local folder*: local installs are copied and
integrity-hashed, so the baked feature list could never be refreshed.

## `projects.json`

```json
[
  {
    "name": "My app e2e",
    "root": "/abs/path/to/the/package/with/cucumber",
    "features": "features",
    "command": "pnpm --filter my-e2e-package exec cucumber-js --profile panel {target}"
  }
]
```

| Field | Meaning |
|---|---|
| `name` | Group title in the panel |
| `root` | Absolute path; features are scanned here and paths are relative to it |
| `features` | Optional, folder under `root` (default `features`) |
| `command` | Typed into the terminal with Enter. `{target}` becomes `file`, `file:line` or the features folder |

The command runs in the terminal's current directory (usually the worktree root), so write it to
work from there — e.g. `pnpm --filter <pkg> exec …` or `cd <dir> && …`.

**Gotcha:** cucumber-js *adds* the profile's `paths` to the CLI ones, so a profile with
`paths: ['features/**/*.feature']` runs the whole suite no matter which scenario you click. Use a
profile without `paths`:

```js
// cucumber.mjs
const { paths, ...noPaths } = common;
export const panel = { ...noPaths, format: ['progress-bar'] };
```

## Refreshing the list

The panel is sandboxed and can't read files, so the list is baked in at build time. The worker
watches `projects.json` and the feature folders and rebuilds automatically — but Orca only starts
the worker after you run one of its palette commands. After restarting Orca, run
`Cucumber: Recargar features` once.

## Scripts

| Command | What it does |
|---|---|
| `pnpm test` | Unit tests (`node:test`, no framework) |
| `pnpm build` | Scan projects and bundle `src/` into single-file panel + worker in `dist/` |
| `pnpm dev` | `build` in watch mode |
| `pnpm check` | `test` + `build` |

## Project layout & internals

See [AGENTS.md](AGENTS.md) for the architecture, layering rules and everything discovered about
the Orca plugin API.
