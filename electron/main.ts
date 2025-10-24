// electron/main.ts
import { app, BrowserWindow, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the plugin-provided envs (these are set by vite-plugin-electron)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname, "..");

// Use explicit names (same as your current file)
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

// In dev, public assets are under /public; in prod they’re in /dist
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null = null;

function createWindow() {
  // App icon for titlebar/taskbar
  const iconPath = path.join(
    process.env.VITE_PUBLIC!,
    process.platform === "win32" ? "icon.ico" : "icon.png"
  );
  const icon = nativeImage.createFromPath(iconPath);

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,                    // show when ready for nicer UX
    title: "Eye Tracking Desktop",  // window title
    icon,
    autoHideMenuBar: true,          // hide menu (Alt shows it). Remove entirely below.
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      // If you later enable Node in renderer, review Electron security guidance.
      // nodeIntegration: false,
      // contextIsolation: true,
    },
  });

  // Remove the app menu entirely (so Alt won't bring it back)
  Menu.setApplicationMenu(null);

  // Dev vs Prod loading
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    // Optional: open devtools
    // win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  // Only show when the first paint is ready
  win.once("ready-to-show", () => {
    win?.show();
  });

  // Example of main→renderer message (keep if you use it)
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  win.on("closed", () => {
    win = null;
  });
}

// Single-instance lock (avoid two app windows on double-click)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Focus the existing window
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Suppress dev security warnings in console (dev only)
    if (!app.isPackaged) {
      process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
    }
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Quit when all windows closed (except macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
