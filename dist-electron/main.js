import { ipcMain, shell, app, protocol, BrowserWindow, nativeImage, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
let win = null;
let trackerProc = null;
let lastExitCode = null;
function commandExists(cmd) {
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(checker, [cmd], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}
function resolvePython() {
  const root = process.env.APP_ROOT;
  const winCandidates = [
    path.join(root, ".venv", "Scripts", "python.exe"),
    "py",
    "python",
    "python3"
  ];
  const posixCandidates = [
    path.join(root, ".venv", "bin", "python"),
    path.join(root, ".venv", "bin", "python3"),
    "python3",
    "python"
  ];
  const candidates = process.platform === "win32" ? winCandidates : posixCandidates;
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
    } else if (commandExists(candidate)) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
}
function createWindow() {
  const iconPath = path.join(
    process.env.VITE_PUBLIC,
    process.platform === "win32" ? "icon.ico" : "icon.png"
  );
  const icon = nativeImage.createFromPath(iconPath);
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Eye Tracking (Demo)",
    icon,
    autoHideMenuBar: true,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs")
    }
  });
  Menu.setApplicationMenu(null);
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
  win.once("ready-to-show", () => win == null ? void 0 : win.show());
  win.on("closed", () => win = null);
}
function trackerStatus() {
  if (trackerProc && !trackerProc.killed) return { status: "running", pid: trackerProc.pid };
  return { status: "stopped", pid: void 0 };
}
ipcMain.handle("tracking:status", () => {
  return trackerStatus();
});
ipcMain.handle(
  "tracking:start",
  async (_e, opts = {}) => {
    if (trackerProc && !trackerProc.killed) {
      return { ok: true, message: "already running" };
    }
    const python = resolvePython();
    const scriptPath = opts.script ? path.isAbsolute(opts.script) ? opts.script : path.join(process.env.APP_ROOT, opts.script) : path.join(process.env.APP_ROOT, "tracker", "main.py");
    const cwd = process.env.APP_ROOT;
    const args = [scriptPath];
    if (opts.preview === false) {
      args.push("--no-preview");
    }
    if (opts.outDir) {
      args.push("--output-dir", opts.outDir);
    }
    try {
      trackerProc = spawn(python, args, {
        cwd,
        env: {
          ...process.env,
          // make sure Python prints unbuffered so logs stream live
          PYTHONUNBUFFERED: "1"
        }
      });
      lastExitCode = null;
      trackerProc.stdout.on("data", (buf) => {
        win == null ? void 0 : win.webContents.send("tracking:stdout", buf.toString());
      });
      trackerProc.stderr.on("data", (buf) => {
        win == null ? void 0 : win.webContents.send("tracking:stderr", buf.toString());
      });
      trackerProc.on("close", (code) => {
        lastExitCode = typeof code === "number" ? code : null;
        win == null ? void 0 : win.webContents.send("tracking:exit", lastExitCode ?? -1);
      });
      return { ok: true, message: "started" };
    } catch (err) {
      trackerProc = null;
      return { ok: false, message: String((err == null ? void 0 : err.message) ?? err) };
    }
  }
);
ipcMain.handle("tracking:stop", async () => {
  if (!trackerProc || trackerProc.killed) {
    return { ok: true, message: "not running" };
  }
  try {
    trackerProc.kill();
    trackerProc = null;
    return { ok: true, message: "stopped" };
  } catch (err) {
    return { ok: false, message: String((err == null ? void 0 : err.message) ?? err) };
  }
});
ipcMain.handle("tracking:open-output", async () => {
  const outDir = path.join(process.env.APP_ROOT, "output");
  try {
    await shell.openPath(outDir);
    return { ok: true, path: outDir };
  } catch {
    return { ok: false, path: outDir };
  }
});
ipcMain.handle("annotation:list-videos", async () => {
  const recDir = path.join(process.env.APP_ROOT, "recordings");
  if (!fs.existsSync(recDir)) return [];
  const files = fs.readdirSync(recDir).filter((f) => f.endsWith(".mp4"));
  return files.map((f) => ({
    name: f,
    path: path.join(recDir, f),
    createdAt: fs.statSync(path.join(recDir, f)).birthtime
  })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
});
ipcMain.handle("annotation:save", async (_e, { videoPath, data }) => {
  const jsonPath = videoPath.replace(".mp4", "_annotation.json");
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("recordings:list-folders", async () => {
  const recDir = path.join(process.env.APP_ROOT, "recordings");
  if (!fs.existsSync(recDir)) return [];
  const items = fs.readdirSync(recDir);
  const folders = items.filter((item) => {
    const itemPath = path.join(recDir, item);
    return fs.statSync(itemPath).isDirectory();
  });
  return folders.map((name) => ({
    name,
    path: path.join(recDir, name),
    createdAt: fs.statSync(path.join(recDir, name)).birthtime
  })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
});
ipcMain.handle("session:load-data", async (_e, folderPath) => {
  if (!fs.existsSync(folderPath)) return { ok: false, error: "Folder not found" };
  const files = fs.readdirSync(folderPath);
  const videoFile = files.find((f) => f.endsWith(".mp4") && !f.includes("_tracked"));
  const trackingFile = files.find((f) => f.endsWith("_tracking_data.json"));
  if (!videoFile) return { ok: false, error: "No video file found" };
  const videoPath = path.join(folderPath, videoFile);
  const trackingPath = trackingFile ? path.join(folderPath, trackingFile) : null;
  let trackingData = null;
  if (trackingPath) {
    try {
      trackingData = JSON.parse(fs.readFileSync(trackingPath, "utf-8"));
    } catch (e) {
      console.error("Failed to parse tracking data", e);
    }
  }
  return {
    ok: true,
    videoPath,
    trackingData
  };
});
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    if (!app.isPackaged) {
      process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
    }
    protocol.registerFileProtocol("media", (request, callback) => {
      const url = request.url.replace("media://", "");
      try {
        return callback(decodeURIComponent(url));
      } catch (error) {
        console.error(error);
        return callback(404);
      }
    });
    createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
export {
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
};
