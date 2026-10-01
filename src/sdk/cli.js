// SDK CLI, bundled to dist/rpc.mjs (__PLUGIN_KEY__ baked in by the build). Also usable by hand:
//   node dist/rpc.mjs <action> ['<json envelope-params>']   → sdk-invoke { action, params }
//   node dist/rpc.mjs actions | ping                       → built-ins
//   node dist/rpc.mjs --method <rpc method> ['<json>']      → any Orca runtime RPC (debugging)
//   node dist/rpc.mjs --restart                             → disable + enable the plugin (fresh worker)
// The panel types the first form; its JSON is { params } (see sdk/panel.js).
// Prints the JSON result; exit 1 with the error on stderr.
import { createRuntime, OrcaRpc } from './runtime.js';
import { BUILTIN_ACTION, INVOKE_COMMAND } from './protocol.js';

const pluginKey = __PLUGIN_KEY__;
const runtime = createRuntime(OrcaRpc.shared);
const [first, ...rest] = process.argv.slice(2);
const parse = (json) => (json === undefined ? undefined : JSON.parse(json));
try {
  let result;
  if (first === '--method') result = await runtime.rpc.call(rest[0], parse(rest[1]));
  else if (first === '--restart') {
    await runtime.setPluginEnabled(pluginKey, false);
    await runtime.setPluginEnabled(pluginKey, true);
    result = await runtime.invoke(pluginKey, INVOKE_COMMAND, { action: BUILTIN_ACTION.ping }); // Orca forks workers on demand
  } else if (!first) throw new Error('usage: rpc.mjs <action> [json] | --method <m> [json] | --restart');
  else result = await runtime.invoke(pluginKey, INVOKE_COMMAND, { action: first, ...(parse(rest[0]) ?? {}) });
  console.log(JSON.stringify(result));
} catch (error) {
  // Worker errors cross IPC as their stack: the first line is the message.
  console.error(`${error.code ?? 'error'}: ${error.message.split('\n')[0]}`);
  process.exit(1);
}
