import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { TARGET } from '../shared/protocol.js';

// Shared by scripts/build.mjs (bakes the result into the panel) and the worker (knows what to watch).

// ponytail: English + Spanish keywords only; use @cucumber/gherkin if another language shows up.
const FEATURE = /^(?:Feature|Business Need|Ability|Característica|Caracteristica|Funcionalidad|Necesidad del negocio|Requisito):\s*(.*)$/;
const SCENARIO = /^(?:Scenario Outline|Scenario Template|Scenario|Example|Esquema del escenario|Escenario|Ejemplo):\s*(.*)$/;

/**
 * Feature and scenario titles with their 1-based line (what `cucumber-js file:line` expects)
 * and own tags. Background/Rule/Examples are skipped. No `Feature:` line → null.
 */
export function parseFeature(text) {
  let feature = null;
  let tags = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) {
      tags.push(...line.split(' #')[0].split(/\s+/).filter((t) => t.startsWith('@')));
      continue;
    }
    const f = !feature && FEATURE.exec(line);
    const s = feature && SCENARIO.exec(line);
    if (f) feature = { name: f[1].trim(), line: i + 1, tags, scenarios: [] };
    else if (s) feature.scenarios.push({ name: s[1].trim(), line: i + 1, tags });
    tags = []; // tags belong to the very next keyword line (Examples, Rule… included)
  }
  return feature;
}

/** projects.json = [{ name, root, features?, command }]. @returns {string[]} errors */
export function validateProjects(list) {
  if (!Array.isArray(list)) return ['must be an array of { name, root, command, features? }'];
  return list.flatMap((p, i) => [
    ...(typeof p?.name === 'string' && p.name.trim() ? [] : [`[${i}].name must be a non-empty string`]),
    ...(typeof p?.root === 'string' && isAbsolute(p.root) ? [] : [`[${i}].root must be an absolute path`]),
    ...(typeof p?.command === 'string' && p.command.includes(TARGET) ? [] : [`[${i}].command must contain ${TARGET}`]),
    ...(p?.features === undefined || typeof p.features === 'string' ? [] : [`[${i}].features must be a relative folder`]),
  ]);
}

export const featuresDir = ({ root, features = 'features' }) => join(root, features);

/**
 * Every *.feature under the project's features folder, paths relative to `root` (the command's cwd).
 * A missing folder is reported on the project, not thrown: the panel says so instead of vanishing.
 */
export async function scanProject(project) {
  const { name, command, features = 'features' } = project;
  const dir = featuresDir(project);
  try {
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.feature')).sort();
    const parsed = await Promise.all(
      files.map(async (f) => {
        const feature = parseFeature(await readFile(join(dir, f), 'utf8'));
        return feature && { file: join(features, f).split(sep).join('/'), ...feature };
      }),
    );
    return { name, command, dir: features, features: parsed.filter(Boolean) };
  } catch (error) {
    return { name, command, dir: features, features: [], error: error.code === 'ENOENT' ? `No existe ${dir}` : error.message };
  }
}
