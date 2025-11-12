// electron/preload.ts
import { ipcRenderer, contextBridge } from "electron";

// helper to subscribe & return unsubscribe
function subscribe<T extends any[]>(
  channel: string,
  handler: (...args: T) => void
) {
  const listener = (_e: Electron.IpcRendererEvent, ...rest: T) => handler(...rest);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* -------- Tracker-specific, typed bridge -------- */
contextBridge.exposeInMainWorld("tracker", {
  start: (opts: { cam?: number; outDir?: string; script?: string } = {}) =>
    ipcRenderer.invoke("tracking:start", opts),
  stop: () => ipcRenderer.invoke("tracking:stop"),
  onStdout: (cb: (line: string) => void) => subscribe("tracking:stdout", cb),
  onStderr: (cb: (line: string) => void) => subscribe("tracking:stderr", cb),
  onExit: (cb: (code: number) => void) => subscribe("tracking:exit", cb),
  openOutput: () => ipcRenderer.invoke("tracking:open-output"),
});

/* -------- Generic invoke fallback (used by lib/tracker.ts) -------- */
contextBridge.exposeInMainWorld("nativeApi", {
  invoke: (ch: string, ...args: any[]) => ipcRenderer.invoke(ch, ...args),
});

/* -------- Optional thin ipcRenderer exposure -------- */
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(channel: string, listener: (event: unknown, ...args: any[]) => void) {
    const wrapped = (event: Electron.IpcRendererEvent, ...args: any[]) =>
      listener(event, ...args);
    ipcRenderer.on(channel, wrapped);
    return wrapped;
  },
  off(channel: string, listener: (event: unknown, ...args: any[]) => void) {
    ipcRenderer.off(channel, listener as any);
  },
  send(channel: string, ...args: any[]) {
    ipcRenderer.send(channel, ...args);
  },
  invoke(channel: string, ...args: any[]) {
    return ipcRenderer.invoke(channel, ...args);
  },
});
