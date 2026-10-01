# Cucumber Features — Orca plugin

[Orca](https://github.com/stablyai/orca) plugin (`tony.cucumber-features`): a right-sidebar
**panel** that lists the Cucumber features and scenarios of the projects in `projects.json` and
runs one (feature, `file:line` scenario or whole folder) in a terminal of the focused worktree.
Split into testable layers. Scaffolded from `orca-saved-prompts-panel-plugin`.

> Everything about the Orca API below was discovered by reading the Orca **1.4.216** app bundle
> (`resources/app.asar` → `out/shared/plugins/*.js`, `out/main/plugin-host-entry.js`). Orca marks
> the whole plugin system **EXPERIMENTAL** ("no compatibility promises until pluginApi v1
> freezes"). Re-verify after upgrading Orca — see [Rediscovering the API](#rediscovering-the-api).
> Items marked **(unverified)** were inferred, not observed.

## Quick start

```bash
pnpm install        # esbuild is the only dependency
pnpm test           # node:test, no framework
pnpm build          # → dist/  (the installable plugin)
pnpm check          # test + build
pnpm reload-worker  # restart the plugin worker (Orca keeps the old one alive, see Messaging SDK)
```

**Install (new users):** clone the repo, `pnpm install && pnpm build`, then Orca → Settings →
Plugins → add `<repo>/dist` as a **dev plugin path** and accept the consent. The panel appears as a
`bug` icon in the right sidebar. The first build creates your personal `projects.json` from the
example `projects.default.json`.

Why a dev path and not "Install plugin → Local folder": installed copies are content-hashed and
re-verified on every panel load (`failed integrity verification`), so their baked feature list could
never change. Only dev paths skip the hash.

A local-path install *copies* the folder into
`~/.config/orca/plugins/<publisher>.<id>/<contentHash>/` — no live reload. For development use a
**dev plugin path** instead: add this repo's `dist/` once in Settings → Plugins (dev paths,
setting `devPluginPaths`). Orca loads it in place, overrides the installed copy with the same
key, and watches it. Then `pnpm dev` rebuilds `dist/` on every change in `src/` or the
manifest, and Orca reloads by itself. Consent is still yours: if capabilities or the worker
change, approve the new fingerprint in Settings.

## Layout

```
orca-plugin.json        manifest (source of truth; copied to dist/)
projects.default.json   example project (versioned); copied to projects.json on first run
projects.json           your projects [{name, root, features?, command}] (gitignored). The build scans
                        <root>/<features>/**/*.feature and bakes the list into the panel (it has no fs).
                        The worker watches projects.json + every features folder and rebuilds dist/.
                        Orca starts workers only on a command and reaps them after 5 min idle, so
                        the worker heartbeats every 4 min and catches up on stale builds at start.
                        `command` must contain {target} → `file`, `file:line` or the features folder,
                        relative to `root`; it is typed in the terminal with Enter.
                        Optional `commands: { "Label": "<template with {target}>" }` adds a "Label…" entry
                        to every feature/scenario ⋯ menu (e.g. headed: `E2E_HEADLESS=false … {target}`).
                        Optional `report` (default `reports/last-run.json`): cucumber JSON output, see
                        "Last run dots".
results.json            last pass/fail per scenario, merged from the reports (gitignored; worker-owned)
src/shared/protocol.js  plugin wire strings: panel messages, host methods, commands, ACTION names,
                        carrier title, limits, {target}
src/shared/shell.js     shellQuote, shared by panel, worker and SDK
src/sdk/                messaging SDK, plugin-agnostic (see "Messaging SDK"):
  protocol.js           INVOKE_COMMAND (`sdk-invoke`), RPC_METHOD, PANEL_DATA_ID, built-in actions
  runtime.js            OrcaRpc (socket client, singleton) + createRuntime (typed verbs)
  actions.js            createActionRouter + param validators
  worker.js             createWorkerChannel: sdk-invoke, carrier terminals, panel-data patching
  panel.js              createPanelChannel/readPanelData: send an action from the panel, no popup
  cli.js                → dist/rpc.mjs: `node rpc.mjs <action> '<json>'`, --method, --restart
src/panel/              one folder per panel; folder name = entry name ("panel.html" ← src/panel/)
  index.html            markup with <!-- @inline-styles --> / <!-- @inline-script --> placeholders
  styles.css            uses Orca design tokens only
  main.js               composition root + controller (state, intents → host calls)
  view.js               DOM only: render(state), expose intents as callbacks
  orca.js               domain facade (readContext/sendText) over the bridge
  bridge.js             postMessage request/response transport (timeouts, errors)
  lib/                  pure functions — no DOM, no bridge (filter, shell quoting, command, Gherkin
                        highlighting for the scenario definition card, last-run dots)
src/worker/
  main.js               activate(ctx): palette commands (edit-projects, reload-features), watchers,
                        SDK worker channel, results sync
  results.js            cucumber JSON report → { "<uri>|<scenario>": passed|failed }, merge into results
  actions.js            SDK actions of this plugin: open-file, run-in-terminal
  handlers.js           logic: open projects.json, rebuild; tested with fakes
  features.js           Gherkin parser (en + es keywords: titles, tags, scenario steps), projects.json
                        validation, folder scan.
                        Also imported by scripts/build.mjs
  orca.js               deps: host notify, fs watchers, stale check, `orca file open` via the CLI
                        (projects.json)
scripts/build.mjs       scan projects + esbuild bundle + inline into single-file panels + manifest check
test/                   node:test — pure logic, bridge, parser, worker handlers, SDK (fake socket +
                        fake RPC, never the real Orca), manifest↔code contract
```

### Cucumber gotcha: `paths` is additive

cucumber-js merges `paths` from the config profile with the paths given on the CLI
(`ADDITIVE_ARRAYS` in `@cucumber/cucumber/lib/configuration/merge_configurations.js`). If the
project's profile sets `paths`, `cucumber-js features/a.feature:12` still runs the whole suite.
Point `command` at a profile without `paths`, e.g. `cucumber-js --profile panel {target}` with:

```js
const { paths, ...noPaths } = common;
export const panel = { ...noPaths, format: ['progress-bar'] };
```

### Last run dots (pass/fail per scenario)

The dot next to a feature/scenario is the result of its last run, wherever it ran (panel, another
terminal, CI): the source is cucumber's own JSON formatter. Setup per project: add
`json:reports/last-run.json` (or the `report` path of `projects.json`) to the `format` of every
profile that should count. Flow: the worker watches the report's folder → `refreshResults`
(`handlers.js`) parses it (`results.js`: failed if any step/hook is failed/ambiguous/undefined/pending,
passed if the rest passed, skipped-only = unknown; outline examples share a name, failed wins) and
**merges** it into `results.json` next to `projects.json` (cucumber overwrites the report on every
run, even a single scenario) → `channel.sync()` patches `{ results }` into the panel data (one panel
reload per finished run) → `lib/results.js` picks the dot: scenario = its own result; feature = red if
any known scenario failed, green if every known one passed, none if none ran. Keyed by
`root|file|scenario name`, not line, so editing a .feature keeps the dots. Date in the row tooltip.
A failed scenario stores the first failing step/hook + its `error_message` (≤ 1500 chars); the
panel shows it at the bottom of the scenario card (⚠ button on the row opens it; outline examples
are prefixed with their filled-in name). Caveats: results only flow while the worker lives (it catches up at start); a Ctrl+C'd run writes no
report; the SDK's `data: () => object` option is what carries `results` next to titles/carriers.

**Running spinner / ■ stop:** `watchRunning` (`handlers.js`) polls `ps -eo pid=,args=` every 2 s;
`runningTargets` keeps the `*.feature[:line]` tokens of lines mentioning `cucumber-js` (any terminal,
not only the panel's) and publishes them as `running` in the panel data when the set changes. A
running row shows a spinner instead of the dot and its ▷ becomes ■ → `stop-run`. Not on Windows
(no `ps`). A whole-folder run (`… cucumber-js features`) has no `.feature` token and shows nothing.

### Dependency rule

```
main.js (controller) ──► view.js        (presentation)
        │           └──► lib/*          (pure logic)
        └──► orca.js (facade) ──► bridge.js (transport) ──► shared/protocol.js
```

Worker: `main.js` → `handlers.js` → `orca.js` → `ctx.host`, and `main.js` → `sdk/worker.js` →
`actions.js` → `sdk/runtime.js` (runtime socket). Panel: `main.js` → `sdk/panel.js` → `orca.js`.
`src/sdk/` imports only `shared/shell.js` and itself: no plugin code, so it can be copied as is.

- Arrows point one way. `view` never imports `orca`/`bridge`; `lib` imports nothing but
  `shared`; `bridge` knows nothing about which actions exist.
- Only `main.js` touches `window`/`document` globals — everything else receives them
  (`createBridge(win)`, `createView(doc)`), which is what makes the tests possible.
- Worker mirrors it: `main.js` (wiring) → `handlers.js` (logic) → `orca.js` (facade) → `ctx.host`.

## Orca plugin API (pluginApi 1, Orca 1.4.x)

### Manifest — `orca-plugin.json`

| Field | Rule |
|---|---|
| `manifestVersion` | literal `1` |
| `id`, `publisher` | kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars. Identity = `<publisher>.<id>` |
| `name` | 1–256 chars |
| `version` | semver |
| `engines.orca` | only `">=x.y.z"` form; host refuses to load below it |
| `pluginApi` | literal `1` |
| `main` | optional relative path to the Node worker entry (ESM, see below) |
| `icon`, `description`, `author`, `repository` | optional |
| `contributes` | **strict** object — unknown keys fail validation |
| `capabilities` | array of `{ "kind": … }`, ≤ 32 |

Paths must be relative, inside the plugin root, portable (no `..`, no Windows-reserved names
or characters). Reserved identities: publisher `stablyai` / `orca-*` ids can't be installed from a
local path.

### Contributions (`contributes`)

| Key | Limit | What it does |
|---|---|---|
| `panels` `{id, title, icon?, entry}` | 64 | Right-sidebar tab. `icon` = one of a **closed** set (renderer map in `App-*.js`, matched lowercase without dashes): `activity bar-chart-3 bell blocks book bot bug calendar cloud code database file-text flag folder gauge globe hammer layers lightbulb package plug puzzle rocket star terminal wrench zap`. Anything else silently renders as `plug`; the build rejects it. `entry` = HTML file. |
| `commands` `{id, title, context?, action?}` | 256 | Command-palette entry. `context`: `global` \| `worktree`. With `action` it's a declarative alias of a built-in action; without it, the **worker** must handle it (→ `main` required). |
| `keybindings` `{command, key, when?}` | 256 | Shortcut for a contributed command, e.g. `"Mod+Alt+T"`. `when` must equal the command's `context`. No duplicate chords across platforms. |
| `events` `{on}` | 3 | Allow-list of events. Requires `main` **and** the `events:subscribe` capability. |
| `languagePacks` `{locale, path}` | 16 | Translations for Orca's UI (BCP-47-ish locale). |
| `agents` `{path}` | 64 | Agent profiles. |
| `vmRecipes` `{path}` | 64 | Per-workspace environment recipes. |

Built-in actions usable as `commands[].action` (closed list):
`worktree.history.back`, `worktree.history.forward`, `sidebar.left.toggle`,
`sidebar.sleepingWorkspaces.toggle`, `floatingWorkspace.maximize`, `tab.rename`,
`workspace.rename`, `workspace.openBoard`, `view.tasks`, `sidebar.right.toggle`,
`sidebar.explorer.toggle`, `sidebar.search.toggle`, `sidebar.sourceControl.toggle`,
`sidebar.checks.toggle`, `sidebar.ports.toggle`.

**There is no theme / CSS / icon-theme contribution** in 1.4.216 even though the official
marketplace lists theme plugins.

### Capabilities and consent

| Capability | Grants |
|---|---|
| `workspace:read` | name, branch, terminal list of the **focused** worktree |
| `terminal:send` | type text into a **specific** terminal id |
| `notifications:show` | desktop notifications labeled with the plugin name |
| `storage` | per-plugin JSON key/value store |
| `secrets` | per-plugin encrypted vault |
| `events:subscribe` | worktree created/removed, agent status changed |
| `settings:own` | read/write the plugin's own settings |

Closed set: a typo fails validation. The user consents to a fingerprint of
**capabilities + whether `main` exists + (for keybindings/agents/vmRecipes) the content hash**.
Adding a capability, adding a worker, or changing instructional content ⇒ re-consent.
Request the minimum: every capability is shown verbatim in the consent dialog.

### Host API

| Method | Capability | Panel | Worker | Params → result |
|---|---|:-:|:-:|---|
| `workspace.readContext` | workspace:read | ✅ | ✅ | `{}` → `{branch, displayName, terminals:[{id}]} \| null` (≤ 50 terminals) |
| `terminal.sendText` | terminal:send | ✅ | ✅ | `{terminalId, text ≤ 4096, enter=false}` → `{accepted}` |
| `notifications.show` | notifications:show | ✅ | ✅ | `{title ≤ 120, body? ≤ 1000}` → `{delivered}` |
| `storage.get/set/delete/keys` | storage | ❌ | ✅ | `{key, value?}` → `{value}` / `{ok}` / `{keys}` |
| `secrets.get/set/delete` | secrets | ❌ | ✅ | `{key, value? ≤ 64 KB string}` → `{value \| null}` / `{ok}` |
| `settings.get/set` | settings:own | ❌ | ✅ | `{}` → `{settings}` / `{key, value}` → `{ok}` |
| `events.subscribe` | events:subscribe | ❌ | ✅ | `{events:[…]}` → `{subscribed}` |

Storage caps: value ≤ 256 KB, total ≤ 5 MB, ≤ 1024 keys; keys 1–256 chars, not
`__proto__`/`prototype`/`constructor`. Host re-validates params and results with zod and
re-checks the capability on every call.

### Panel runtime

- Rendered as `srcdoc` in `<iframe sandbox="allow-scripts">` → **opaque origin**.
- Orca prepends a shell (`buildPluginPanelShellHtml`): doctype, `<html class="light|dark">`, a
  CSP meta, a `:root{…}` block with design tokens, and a script that blocks navigation, makes
  `window.open` return `null`, cancels **every** `<a href>` click and form submit, and answers
  the watchdog ping. Your HTML is appended after `</head>` → start your file at `<body>`.
- CSP: `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`.
  ⇒ **No external `.js`/`.css`/images/fonts, no `fetch`/WebSocket.** Hence the build inlines
  everything into one HTML file. Images/fonts only as `data:` URIs.
- Design tokens available as CSS vars: `--background --foreground --card --card-foreground
  --popover --popover-foreground --primary --primary-foreground --secondary
  --secondary-foreground --muted --muted-foreground --accent --accent-foreground --destructive
  --destructive-foreground --border --input --ring --radius`. Nothing else is public.
- Bridge protocol (see `src/panel/bridge.js`):
  - request → `window.parent.postMessage({type:'orca-panel-action', requestId ≤128, action, params}, '*')`
  - reply ← `{type:'orca-panel-action-result', requestId, ok:true, value}` or
    `{…, ok:false, errorCode, error}`. Codes seen: `invalid_request`, `rate_limited`,
    `action_failed`, `panel_forbidden`, plus capability denials.
- Budgets per plugin (shared by all its panels): message ≤ 64 KB, **30 messages / 10 s**.
- Watchdog: ping every 10 s, 5 s to pong (the shell does it). A busy-looping panel is shown as
  errored — keep the main thread free.
- `localStorage`/cookies are unusable in an opaque origin **(unverified, standard web behavior)**.
  Panel has no persistence of its own; persist via the worker.
- **No host-provided panel ↔ worker channel exists.** The panel can't call worker commands or read
  storage through the bridge. The workaround this repo uses is in [Messaging SDK](#messaging-sdk-panel--worker--cli).

### Worker runtime

- `child_process.fork` of Orca's `plugin-host-entry.js`, which `import()`s your `main` by file URL
  ⇒ ship ESM (`.mjs`, or `.js` with a `package.json` `"type":"module"` next to it).
- Contract:

  ```js
  export default async function activate(ctx) {}   // required, called once
  export function deactivate() {}                  // optional, awaited on shutdown
  // ctx = {
  //   commands: { register(commandId, handler(args) => value) },
  //   events:   { on(eventName, handler(payload)) },
  //   host:     { call(method, params) => Promise },   // rejects with err.code
  //   grantedCapabilities: string[],
  //   log(message),                                    // ≤ 8192 chars, shows in plugin logs
  // }
  ```
- Only commands registered **before `activate` resolves** are reported to the host as ready.
- `events.on` alone receives nothing: call `host.call('events.subscribe', {events})`.
- An uncaught exception / unhandled rejection sends `fatal` and exits the worker. Errors thrown
  inside event handlers are only logged. Command results cross IPC → structured-clone data only.
- Logs: `ctx.log` → Orca's plugin logs (IPC `plugins:getLogs`, surfaced in Settings — exact UI
  location **unverified**).

### Events (payloads)

| Event | Payload |
|---|---|
| `worktree.created` | `{worktreeId, path, branch}` |
| `worktree.removed` | `{worktreeId, path}` |
| `agent.status.changed` | `{worktreeId \| null, paneKey, state, receivedAt, mainAgent?: {state, outcome?, stateStartedAt}}` |

### Distribution

Install sources: `local-path` (copied + hashed), `git` (HTTPS/SSH URL + ref), `marketplace` (a
git repo with a marketplace index, like `github.com/stablyai/orca-plugins`). Orca also honours a
remote **kill list** that can disable a plugin by key.

## Messaging SDK: panel ↔ worker ↔ CLI

Discovered 2026-09-30 by reading `out/cli/runtime/transport.js`, `metadata.js` and
`out/shared/rpc-contract/rpc-params-catalog.generated.js`. Verified live on 1.4.216. Nothing here is
part of the plugin API: it's the **runtime RPC** the `orca` CLI itself uses, so it is as stable as the
CLI, not as the pluginApi. Re-verify after upgrading.

`src/sdk/` packages it as a small, plugin-agnostic SDK: an **action** is a named worker function
that the panel, a shell, or any local process can call with JSON params. One manifest command
(`sdk-invoke`) routes them all, so adding an action never touches the manifest or the consent.

### Channel map (1.4.216)

| Route | How | Notes |
|---|---|---|
| any local process → worker | `plugins.invokeCommand` → `sdk-invoke { action, params }`, sync result | `node dist/rpc.mjs <action> '{"params":{…}}'` |
| worker → Orca | `createRuntime()` verbs / `OrcaRpc.shared.call(...)` | No CLI on PATH needed, no capability needed |
| panel → worker | `createPanelChannel().send(action, params)`: `terminal.sendText` types the `rpc.mjs` line into the worker's **carrier** terminal | Only egress of the sandbox. Fire-and-forget (the panel can't read terminals). Needs `node` on PATH |
| worker → panel | rewrite `dist/panel.html`: full rebuild (features) or `patchPanelData` on the `<script id="panel-data">` placeholder (`{ titles, carriers }`) | No push; every write reloads the panel (search box resets), so the build and `patchPanelData` only write on real changes |
| panel ↔ socket/ws/http directly | — | CSP `connect-src 'none'`, `img-src data:` |

`plugins.panelAction` also exists but needs the session token Orca issues to its own panel host.

### The runtime RPC socket

Orca writes `<userData>/orca-runtime.json` (`~/.config/orca` on Linux, `~/Library/Application
Support/orca` on macOS, `%APPDATA%\orca` on Windows, or `$ORCA_USER_DATA_PATH`):

```json
{ "runtimeId": "…", "pid": 12295,
  "transports": [{ "kind": "unix", "endpoint": "/home/me/.config/orca/o-12295-ab3e.sock" }, { "kind": "websocket", "endpoint": "ws://0.0.0.0:6768" }],
  "authToken": "…" }
```

Protocol: newline-delimited JSON on the unix socket / named pipe, one request per connection.

```
→ { "id": "<uuid>", "authToken": "<from the file>", "method": "terminal.create", "params": { … } }
← { "id": "<uuid>", "ok": true, "result": { … }, "_meta": { "runtimeId": "…" } }
← { "id": "<uuid>", "ok": false, "error": { "code": "selector_not_found", "message": "…" } }
← { "_keepalive": true }                                  (ignore)
```

Every CLI subcommand is one method (`terminal.list/create/send/read/rename/close`, `worktree.list`,
`orchestration.*`, `plugins.list/setEnabled/invokeCommand`, …): read `out/cli/handlers/*.js` for
params. `src/sdk/runtime.js` (`OrcaRpc.shared.call(method, params)`) implements the client with
`node:net` only; `dist/rpc.mjs --method <m> '<json>'` calls any method from a shell.

The file is re-read on every call (Orca rewrites socket + token on restart). The token is plaintext
in userData: any local process already has this power, the plugin adds none.

### `plugins.invokeCommand`: the only way into a worker with a payload

```
plugins.invokeCommand { pluginKey: "tony.cucumber-features", commandId: "sdk-invoke", args: <any JSON> }
→ result = whatever the worker's registered handler returned (handler(args) in ctx.commands.register)
```

The command must be declared in `contributes.commands` (no `action`); unknown ids fail with
`plugin … does not contribute command …`. Worker errors come back as `runtime_error` with the
worker-side stack as message (the CLI prints its first line).

### SDK API

**Worker** (`src/sdk/worker.js`, `runtime.js`, `actions.js`):

```js
import { createRuntime, OrcaRpc } from '../sdk/runtime.js';
import { createWorkerChannel } from '../sdk/worker.js';
import { requireAbsolute } from '../sdk/actions.js';

const actions = {
  'open-file': {
    description: 'Open { path } in Orca',
    run: async (params, { runtime, host, log }) => runtime.openFile(requireAbsolute('open-file', params, 'path')),
  },
};
const channel = createWorkerChannel({ ctx, runtime: createRuntime(OrcaRpc.shared), panelPath, actions,
  carrierTitle: 'My plugin (rpc)', onError: (e) => notify(e.message) });
channel.start();   // activate(); channel.stop() in deactivate()
```

- `createWorkerChannel` registers `sdk-invoke`; call it **before `activate` resolves**.
- `run(params, ctx)`: params come from any local process ⇒ validate (`requireString`,
  `requireAbsolute`). Return structured-clone data. A throw reaches the caller and `onError`.
- Built-in actions: `ping` → `{ pong, at }`, `actions` → `[{ name, description }]`.
- `createRuntime(rpc)` verbs: `worktrees()`, `worktreeOf(dir)` (deepest containing `dir`),
  `terminals()`, `createTerminal({ worktreeId, command?, title, focus = true })`,
  `closeTerminal(handle)`, `openFile(absolutePath)`, `invoke(pluginKey, commandId, args)`,
  `setPluginEnabled(pluginKey, enabled)`; `runtime.rpc.call(method, params)` for anything else.
- `OrcaRpc({ metadataPath, timeoutMs })` / `OrcaRpc.shared`: errors are `RpcError` with `code`
  (`runtime_unavailable`, `runtime_timeout`, or Orca's: `selector_not_found`, `runtime_error`, …).

**Panel** (`src/sdk/panel.js`):

```js
import { createPanelChannel, readPanelData } from '../sdk/panel.js';
const data = readPanelData(document);                 // { titles, carriers } patched by the worker
const channel = createPanelChannel({ orca, cliPath: __RPC_PATH__, data });
const r = await channel.send('open-file', { path }); // { sent: true } | { sent: false, reason: 'no-carrier' | 'rejected' }
if (!r.sent) /* ask for a terminal and type channel.command('open-file', { path }) there */;
```

`channel.isCarrier(id)` filters carriers out of terminal pickers. The panel needs `<script
id="panel-data" type="application/json">{}</script>` in its HTML and `__RPC_PATH__` defined by the
build (absolute path of `dist/rpc.mjs`).

**CLI** (`src/sdk/cli.js` → `dist/rpc.mjs`, `__PLUGIN_KEY__` baked in):

```bash
node dist/rpc.mjs actions                       # list actions
node dist/rpc.mjs ping
node dist/rpc.mjs open-file '{"params":{"root":"/abs/project","file":"features/a.feature"}}'
node dist/rpc.mjs --method terminal.list '{}'   # any runtime RPC
node dist/rpc.mjs --restart                     # disable + enable the plugin = fresh worker (pnpm reload-worker)
```

### This plugin's actions (`src/worker/actions.js`)

| Action | Params | Result | Used by |
|---|---|---|---|
| `open-file` | `{ root, file }` (file relative to root, no `..`) | `{ opened }` | feature `⋯` → "Abrir en editor" |
| `run-in-terminal` | `{ root, command, title? }` | `{ terminalId }` | ▷ (always), popup → "Terminal nueva" |
| `edit-projects` | `{}` | `{ opened }` | header ⚙ button (same as the palette command; wired in `main.js`) |
| `reload-features` | `{}` | `{ reloaded }` | header refresh button (wired in `main.js`: needs the worker's rebuild) |
| `open-report` | `{ root }` | `{ url }` | ⋯ → "Ver reporte HTML": the worker serves `<root>/<html>` (default `reports/cucumber-report.html`) from a loopback `node:http` server (Orca's browser refuses `file://`) and opens it with `browser.tabCreate` |
| `stop-run` | `{ target }` (`file` or `file:line`) | `{ killed }` | ■ on a running row: SIGTERM (then SIGKILL after 3 s) every live `cucumber-js` whose command line names the target |

`run-in-terminal` resolves the deepest Orca worktree containing `root` (`path:<subdir>` is **not**
a valid selector, `id:<worktree.id>` is) and runs `terminal.create { worktree, command: "cd <root>
&& <command>", title, focus: true, presentation: 'focused' }`. `open-file` calls `files.open {
worktree: id:…, relativePath }` (relative to the worktree). Typing `orca file open <path>` instead
broke: the CLI wants `--path` and resolves against the terminal's cwd, maybe another worktree.

### Carrier terminals (how the panel sends without a popup)

The panel can't create terminals, only type into one, and the host's `terminal.sendText` (panel
**and** worker) **only accepts terminals of the active worktree** (`terminal is outside the active
worktree`). So the worker channel keeps one background shell titled `carrierTitle` (`Cucumber
(rpc)`, `focus: false`) **per worktree the user focuses** and publishes their ids in the panel data.
The panel channel uses the one listed in its `readContext`. Every 15 s poll (`syncPanelData`):

- Carriers are rebuilt from `terminal.list` by title: adopts a previous worker's (Orca doesn't
  reliably call `deactivate`), forgets closed ones, closes duplicates in one worktree.
- Active worktree (`activeWorktreeId`: a readContext terminal id mapped through `terminal.list`,
  else displayName + branch against `worktree.list`; both may carry `refs/heads/`) without a
  carrier → create one.
- A carrier is reused for every action. An earlier version replaced it after each use (fresh
  shell), but the new id changed the panel data ⇒ one panel reload per click.
- No carrier in the focused worktree yet (worker not running, worktree focused < 15 s ago):
  `send` returns `no-carrier`; this panel then asks for a terminal and types the line there.

Side effect: every worktree you focus while the worker runs gets a `Cucumber (rpc)` tab.
Tests must never reach the real socket: `activate(ctx, projectsPath, panelPath, rpc)` and every
SDK factory take the RPC; an earlier version leaked carrier tabs into real worktrees on every
`pnpm test`.

### Terminal titles in the popup

`workspace.readContext` gives terminal ids only. The worker polls `terminal.list` (all worktrees,
`{ handle, title, agentIdentity? }`) every 15 s and, when the `{ id: { title, agent? } }` map changed (leading status glyphs such as `◑ ✳` stripped and entries sorted by handle, else spinner frames and `terminal.list` order reload the panel),
patches it into the `panel-data` placeholder (`patchPanelData`; `<` escaped as `\u003c`). The panel
reads it at load (`describeTerminals(terminals, titles)`), falling back to `Terminal N`, and picks
the popup icon from the agent (`terminalIcon`: own mark for claude/codex/gemini, `bot` for any other
identity, `terminal` for a shell). `agentIdentity` is Orca's own detection and is best effort: a
session it didn't recognise shows as a plain terminal. Caveats: the worker only
exists after the first command (palette, or any SDK action) — until then the popup shows
positions; every title change reloads the panel. The build carries the current placeholder JSON
over and writes only files whose content changed, so a rescan with nothing new reloads nothing.

### Worker reload gotcha

Orca reloads a dev-path **panel** on every `dist/` change, but a running **worker** keeps its old
code: our 4-min heartbeat prevents the 5-min idle reap, so worker-only edits never take effect
until Orca restarts. `pnpm reload-worker` (`rpc.mjs --restart`) toggles `plugins.setEnabled`
off/on (kills the worker) and pings `sdk-invoke` so Orca forks the new one right away (a
re-enabled plugin stays `idle` until its first command). `plugins.refresh` is IPC-only
(`method_not_found` over RPC).

### Reusing the SDK in another plugin

1. Copy `src/sdk/` and `src/shared/shell.js`.
2. Manifest: `{ "id": "sdk-invoke", "title": "<Plugin>: SDK (interno)", "context": "global" }`
   under `contributes.commands`, plus `main`, and `workspace:read` + `terminal:send` capabilities.
3. Build: bundle `src/sdk/cli.js` to `dist/rpc.mjs` with `define: { __PLUGIN_KEY__ }`, and define
   `__RPC_PATH__` (absolute path of it) for the panel. See `scripts/build.mjs`.
4. Panel HTML: `<script id="panel-data" type="application/json">{}</script>`.
5. Worker: `createWorkerChannel({ … })` + `start()`; panel: `createPanelChannel({ … })`.

`orca-saved-prompts-panel-plugin` uses this same SDK (copied as is): port SDK changes there too.

## What a plugin can NOT do (1.4.216)

- Restyle Orca, inject components into its chrome, or add themes/icon themes.
- Touch files, git, network, or processes through the API; read terminal **output**; target
  "the active terminal".
- Call built-in actions outside the alias list; talk panel ↔ worker through the plugin API
  (see [Messaging SDK](#messaging-sdk-panel--worker--cli) for the runtime-RPC workaround).
- Load anything external into a panel (CSP) or navigate it.

Note: the worker is plain Node, so it *can* use `node:fs`, `fetch`, etc. directly — the capability
system only governs the host API. Orca makes the user consent to "trusted Node worker" for exactly
this reason. Don't abuse it; keep side effects obvious and documented.

## Best practices for this repo

- **One place per wire string.** Every action/event/message type lives in
  `src/shared/protocol.js`. Grep for a literal like `'terminal.sendText'` outside it = bug.
- **Layers stay pure.** Put a rule in `lib/` (panel) or `handlers.js` (worker) and unit-test it;
  `view.js` only renders and forwards intents; controllers only orchestrate.
- **Inject globals.** Pass `window`, `document`, `ctx.host` in; never reach for them inside a
  module other than the composition root.
- **Never `innerHTML` host data.** Terminal ids, branch names and paths come from outside — use
  `textContent`, `new Option()`, `replaceChildren()`.
- **Fail fast on host limits** (`LIMITS` in protocol.js) before spending the 30-msg budget, and
  keep bridge timeouts — the host doesn't always answer.
- **Honest UI.** `readContext()` returning `null` means "no focused worktree", not an error; a
  rejected call is an error — render them differently. Report `accepted`/`delivered: false`.
- **Least privilege.** Every capability added is a new consent prompt and more attack surface.
- **Keep the manifest ↔ code contract tested** (`test/worker.test.js` checks every worker
  command in the manifest is registered by `activate`).
- **Mark shortcuts** with `// ponytail:` and state their ceiling (see `checkManifest` in the build).

### Recipes

- **New panel**: add `{id, title, icon, entry: "foo.html"}` to `contributes.panels`, create
  `src/foo/{index.html,styles.css,main.js}` (copy `src/panel/`). The build picks it up.
- **New action (panel / CLI → worker)**: add `{ description, run(params, { runtime }) }` to
  `src/worker/actions.js` under a name in `ACTION` (protocol.js), validate params, test it in
  `test/sdk.test.js` with `fakeRpc`. No manifest change. Call it from the panel with
  `sendAction(ACTION.x, params, point, done)` or from a shell with `node dist/rpc.mjs x '{"params":…}'`.
- **New worker command** (command palette): add to `contributes.commands` (no `action`), register
  it in `src/worker/main.js`, logic in `handlers.js`, test it.
- **Alias a built-in action**: `contributes.commands` entry with `action` from the list above —
  no worker needed. Add a `keybindings` entry to bind it.
- **New host method**: add it to `HOST_METHOD`, expose a verb in the relevant `orca.js` facade,
  add the capability to the manifest.

## Validate against Orca's real schema

`scripts/build.mjs` only runs a fast subset. For the authoritative check, extract the running
Orca bundle once and use its own parser:

```bash
APP=$(dirname "$(readlink -f /proc/$(pgrep -o -x orca-ide)/exe)")/resources   # Linux AppImage
npx -y @electron/asar extract "$APP/app.asar" /tmp/orca-asar
NODE_PATH="$APP/node_modules" node -e "
  const m = require('/tmp/orca-asar/out/shared/plugins/plugin-manifest.js');
  const r = m.parsePluginManifest(require('$PWD/dist/orca-plugin.json'));
  console.log(r.ok ? 'VALID' : r.error)"
```

## Rediscovering the API

After an Orca upgrade, re-extract the asar and read, in this order:

1. `out/shared/plugins/plugin-manifest.js` (+ `plugin-content-pack-contributions.js`,
   `plugin-manifest-contribution-validation.js`) — manifest schema and cross-field rules.
2. `plugin-capabilities.js`, `plugin-host-api.js` — capabilities and host methods (`panel:` flag).
3. `plugin-panel-shell.js`, `plugin-panel-bridge.js` — panel CSP, tokens, bridge protocol, budgets.
4. `out/main/plugin-host-entry.js`, `plugin-host-protocol.js`, `plugin-events.js` — worker contract.
5. `plugin-command-actions.js` — built-in action aliases.
6. `out/cli/runtime/{transport,metadata}.js`, `out/shared/runtime-rpc-envelope.js`,
   `out/shared/rpc-contract/rpc-params-catalog.generated.js` (method list) and
   `out/cli/handlers/*.js` (params per method) — the runtime RPC used by `src/sdk/runtime.js`.

Then update `src/shared/protocol.js`, this file, and the bundled checks in `scripts/build.mjs`.
