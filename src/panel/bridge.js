import { PANEL_MESSAGE } from '../shared/protocol.js';

// Transport only: request/response over postMessage to the host renderer.
// Knows nothing about which actions exist — see orca.js for that.
export function createBridge(win, { timeoutMs = 10_000 } = {}) {
  const pending = new Map();
  let seq = 0;

  win.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== win.parent || data?.type !== PANEL_MESSAGE.result) return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.value);
    else entry.reject(Object.assign(new Error(data.error ?? 'panel action failed'), { code: data.errorCode }));
  });

  return {
    call(action, params) {
      return new Promise((resolve, reject) => {
        const requestId = `r${++seq}`;
        // The host never answers some failures (e.g. panel torn down); don't leak the promise.
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(Object.assign(new Error(`${action} timed out`), { code: 'timeout' }));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        win.parent.postMessage({ type: PANEL_MESSAGE.request, requestId, action, params }, '*');
      });
    },
  };
}
