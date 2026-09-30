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
src/shared/protocol.js  every wire string: message types, host methods, limits, {target}
src/panel/              one folder per panel; folder name = entry name ("panel.html" ← src/panel/)
  index.html            markup with <!-- @inline-styles --> / <!-- @inline-script --> placeholders
  styles.css            uses Orca design tokens only
  main.js               composition root + controller (state, intents → host calls)
  view.js               DOM only: render(state), expose intents as callbacks
  orca.js               domain facade (readContext/sendText) over the bridge
  bridge.js             postMessage request/response transport (timeouts, errors)
  lib/                  pure functions — no DOM, no bridge (filter, shell quoting, command)
src/worker/
  main.js               activate(ctx): palette commands (edit-projects, reload-features) + watchers
  handlers.js           logic: open projects.json, rebuild; tested with fakes
  features.js           Gherkin title parser (en + es keywords), projects.json validation, folder scan.
                        Also imported by scripts/build.mjs
  orca.js               deps: host notify, fs watchers, stale check, `orca file open` via the CLI
scripts/build.mjs       scan projects + esbuild bundle + inline into single-file panels + manifest check
test/                   node:test — pure logic, bridge, parser, worker handlers, manifest↔code contract
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

### Dependency rule

```
main.js (controller) ──► view.js        (presentation)
        │           └──► lib/*          (pure logic)
        └──► orca.js (facade) ──► bridge.js (transport) ──► shared/protocol.js
```

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
- **No panel ↔ worker channel exists.** The panel can't call worker commands or read storage.

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

## What a plugin can NOT do (1.4.216)

- Restyle Orca, inject components into its chrome, or add themes/icon themes.
- Touch files, git, network, or processes through the API; read terminal **output**; target
  "the active terminal".
- Call built-in actions outside the alias list; talk panel ↔ worker.
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
- **New worker command**: add to `contributes.commands` (no `action`), register it in
  `src/worker/main.js`, logic in `handlers.js`, test it.
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

Then update `src/shared/protocol.js`, this file, and the bundled checks in `scripts/build.mjs`.
