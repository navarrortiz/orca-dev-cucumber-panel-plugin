import { execFile } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path, { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { HOST_METHOD, LIMITS } from '../shared/protocol.js';
import { featuresDir } from './features.js';

const run = promisify(execFile);

const CLI_NAME = { win32: 'orca.exe', darwin: 'orca', linux: 'orca-ide' };

/**
 * `orca` on PATH first; otherwise the CLI Orca ships in its own resources/bin (the worker runs on
 * Orca's binary, so execPath locates it). Paths from Orca 1.4.216 (main bundle, CLI install logic).
 */
export function orcaCliCandidates(platform = process.platform, execPath = process.execPath, resourcesPath = process.resourcesPath) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const resources = resourcesPath ?? p.join(p.dirname(execPath), platform === 'darwin' ? '../Resources' : 'resources');
  return ['orca', p.join(resources, 'bin', CLI_NAME[platform] ?? 'orca')];
}

/**
 * First run on a fresh clone: create projects.json from the example projects.default.json.
 * Never overwrites; no default either = start empty. Also used by scripts/build.mjs.
 */
export async function seedProjects(projectsPath) {
  const defaults = join(dirname(projectsPath), 'projects.default.json');
  await copyFile(defaults, projectsPath, constants.COPYFILE_EXCL).catch(async (error) => {
    if (error.code === 'EEXIST') return;
    if (error.code !== 'ENOENT') throw error;
    await writeFile(projectsPath, '[]\n', { flag: 'wx' }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
  });
}

// Worker deps: host API + projects.json + the feature folders. Handlers depend on this shape only.
export function createDeps(host, projectsPath, panelPath) {
  // The worker runs as Electron-as-Node; the orca CLI is the same binary and must not inherit that flag.
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  const root = dirname(projectsPath);
  const args = ['file', 'open', projectsPath, '--worktree', `path:${root}`];

  return {
    notify: (title, body) =>
      host.call(HOST_METHOD.notify, { title: title.slice(0, LIMITS.notifyTitleMax), body: body.slice(0, LIMITS.notifyBodyMax) }),
    ensureProjects: () => seedProjects(projectsPath),
    /** Current projects, or [] while the file is missing or half-saved: only used to pick what to watch. */
    readProjects: () => readFile(projectsPath, 'utf8').then((text) => [JSON.parse(text)].flat().filter((p) => p?.root), () => []),
    // Same build as `pnpm build`; process.execPath is Electron here, so run it as Node.
    rebuild: () =>
      run(process.execPath, [join(root, 'scripts/build.mjs')], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 60_000,
      }).catch((error) => {
        throw new Error(error.stderr?.trim() || error.message);
      }),
    /**
     * projects.json or anything under a feature folder changed after the panel was last built.
     * Folders count too: deleting a feature only touches its folder's mtime.
     * ponytail: stats every entry under the feature folders; fine for hundreds of files.
     */
    async isPanelStale(projects) {
      const mtime = (file) => stat(file).then((s) => s.mtimeMs, () => 0);
      const entries = await Promise.all(
        projects.map((p) => readdir(featuresDir(p), { recursive: true }).then((names) => [featuresDir(p), ...names.map((n) => join(featuresDir(p), n))], () => [])),
      );
      const [panel, ...sources] = await Promise.all([panelPath, projectsPath, ...entries.flat()].map(mtime));
      return Math.max(...sources) > panel;
    },
    // Any host call counts as worker activity for Orca's idle reaper.
    heartbeat: () => host.call(HOST_METHOD.readContext, {}),
    // Watch folders, not files: editors that save via rename would orphan a file watcher.
    watchProjectsFile(onChange) {
      const watcher = watch(root, (_event, file) => file === basename(projectsPath) && onChange());
      return () => watcher.close();
    },
    /** Recursive watch of every feature folder; missing folders are skipped (the panel reports them). */
    watchFeatures(projects, onChange) {
      const watchers = projects.flatMap((project) => {
        try {
          return [watch(featuresDir(project), { recursive: true }, (_event, file) => file?.endsWith('.feature') && onChange())];
        } catch {
          return [];
        }
      });
      return () => watchers.forEach((w) => w.close());
    },
    async openInEditor() {
      let lastError;
      for (const cli of orcaCliCandidates()) {
        try {
          return await run(cli, args, { env, timeout: 15_000 });
        } catch (error) {
          lastError = error;
          if (error.code !== 'ENOENT') break; // CLI found but failed: don't mask the real error
        }
      }
      throw new Error(`No se pudo abrir ${projectsPath}: ${lastError.stderr?.trim() || lastError.message}`);
    },
  };
}
