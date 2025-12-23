"use strict";
const electron = require("electron");
function subscribe(channel, handler) {
  const listener = (_e, ...rest) => handler(...rest);
  electron.ipcRenderer.on(channel, listener);
  return () => electron.ipcRenderer.removeListener(channel, listener);
}
electron.contextBridge.exposeInMainWorld("tracker", {
  start: (opts = {}) => electron.ipcRenderer.invoke("tracking:start", opts),
  stop: () => electron.ipcRenderer.invoke("tracking:stop"),
  onStdout: (cb) => subscribe("tracking:stdout", cb),
  onStderr: (cb) => subscribe("tracking:stderr", cb),
  onExit: (cb) => subscribe("tracking:exit", cb),
  openOutput: () => electron.ipcRenderer.invoke("tracking:open-output")
});
electron.contextBridge.exposeInMainWorld("nativeApi", {
  invoke: (ch, ...args) => electron.ipcRenderer.invoke(ch, ...args)
});
electron.contextBridge.exposeInMainWorld("ipcRenderer", {
  on(channel, listener) {
    const wrapped = (event, ...args) => listener(event, ...args);
    electron.ipcRenderer.on(channel, wrapped);
    return wrapped;
  },
  off(channel, listener) {
    electron.ipcRenderer.off(channel, listener);
  },
  send(channel, ...args) {
    electron.ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    return electron.ipcRenderer.invoke(channel, ...args);
  }
});
