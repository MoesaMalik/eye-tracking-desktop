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
electron.contextBridge.exposeInMainWorld(
  "startHeadPosition",
  (opts = {}) => electron.ipcRenderer.invoke("head_position:start", opts)
);
electron.contextBridge.exposeInMainWorld(
  "stopHeadPosition",
  () => electron.ipcRenderer.invoke("head_position:stop")
);
electron.contextBridge.exposeInMainWorld(
  "onHeadPositionUpdate",
  (cb) => subscribe("head_position:update", cb)
);
electron.contextBridge.exposeInMainWorld(
  "startGazeStream",
  (opts = {}) => electron.ipcRenderer.invoke("gaze_stream:start", opts)
);
electron.contextBridge.exposeInMainWorld(
  "stopGazeStream",
  () => electron.ipcRenderer.invoke("gaze_stream:stop")
);
electron.contextBridge.exposeInMainWorld(
  "onGazeUpdate",
  (cb) => subscribe("gaze_stream:update", cb)
);
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
