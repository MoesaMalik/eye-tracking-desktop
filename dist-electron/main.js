import { app as o, BrowserWindow as s, nativeImage as d, Menu as p } from "electron";
import n from "node:path";
import { fileURLToPath as m } from "node:url";
const r = n.dirname(m(import.meta.url));
process.env.APP_ROOT = n.join(r, "..");
const i = process.env.VITE_DEV_SERVER_URL, h = n.join(process.env.APP_ROOT, "dist-electron"), c = n.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = i ? n.join(process.env.APP_ROOT, "public") : c;
let e = null;
function t() {
  const a = n.join(
    process.env.VITE_PUBLIC,
    process.platform === "win32" ? "icon.ico" : "icon.png"
  ), l = d.createFromPath(a);
  e = new s({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: !1,
    // show when ready for nicer UX
    title: "Eye Tracking Desktop",
    // window title
    icon: l,
    autoHideMenuBar: !0,
    // hide menu (Alt shows it). Remove entirely below.
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: n.join(r, "preload.mjs")
      // If you later enable Node in renderer, review Electron security guidance.
      // nodeIntegration: false,
      // contextIsolation: true,
    }
  }), p.setApplicationMenu(null), i ? e.loadURL(i) : e.loadFile(n.join(c, "index.html")), e.once("ready-to-show", () => {
    e == null || e.show();
  }), e.webContents.on("did-finish-load", () => {
    e == null || e.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), e.on("closed", () => {
    e = null;
  });
}
const R = o.requestSingleInstanceLock();
R ? (o.on("second-instance", () => {
  e && (e.isMinimized() && e.restore(), e.focus());
}), o.whenReady().then(() => {
  o.isPackaged || (process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"), t(), o.on("activate", () => {
    s.getAllWindows().length === 0 && t();
  });
})) : o.quit();
o.on("window-all-closed", () => {
  process.platform !== "darwin" && o.quit();
});
export {
  h as MAIN_DIST,
  c as RENDERER_DIST,
  i as VITE_DEV_SERVER_URL
};
