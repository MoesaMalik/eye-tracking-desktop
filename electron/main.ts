// electron/main.ts
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  protocol,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const RENDERER_DIST = path.join(process.env.APP_ROOT!, "dist");

// public assets during dev, or dist assets in prod
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT!, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null = null;
let trackerProc: ChildProcessWithoutNullStreams | null = null;
let lastExitCode: number | null = null;

// Calibration target storage for active session
type CalibrationTarget = {
  session_id: string;
  slide_index: number;
  x: number;
  y: number;
  slide: string;
  timestamp_ms: number;
};
let calibrationTargets: CalibrationTarget[] = [];

function commandExists(cmd: string) {
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(checker, [cmd], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

function resolvePython(): string {
  const root = process.env.APP_ROOT!;
  const winCandidates = [
    path.join(root, ".venv", "Scripts", "python.exe"),
    "py",
    "python",
    "python3",
  ];
  const posixCandidates = [
    path.join(root, ".venv", "bin", "python"),
    path.join(root, ".venv", "bin", "python3"),
    "python3",
    "python",
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
    process.env.VITE_PUBLIC!,
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
      preload: path.join(__dirname, "preload.mjs"),
    },
  });

  // remove OS menu entirely
  Menu.setApplicationMenu(null);

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => (win = null));
}

/* -------------------- Tracker IPC -------------------- */

function trackerStatus() {
  if (trackerProc && !trackerProc.killed) return { status: "running" as const, pid: trackerProc.pid };
  // if we reached here, not running
  return { status: "stopped" as const, pid: undefined };
}

ipcMain.handle("tracking:status", () => {
  return trackerStatus();
});

ipcMain.handle(
  "tracking:start",
  async (_e, opts: { cam?: number; outDir?: string; script?: string; preview?: boolean } = {}) => {
    if (trackerProc && !trackerProc.killed) {
      return { ok: true, message: "already running" };
    }

    const python = resolvePython();
    const scriptPath = opts.script
      ? path.isAbsolute(opts.script)
        ? opts.script
        : path.join(process.env.APP_ROOT!, opts.script)
      : path.join(process.env.APP_ROOT!, "tracker", "main.py");

    const cwd = process.env.APP_ROOT!;
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
          PYTHONUNBUFFERED: "1",
        },
      });

      lastExitCode = null;

      trackerProc.stdout.on("data", (buf) => {
        win?.webContents.send("tracking:stdout", buf.toString());
      });
      trackerProc.stderr.on("data", (buf) => {
        win?.webContents.send("tracking:stderr", buf.toString());
      });
      trackerProc.on("close", (code) => {
        lastExitCode = typeof code === "number" ? code : null;
        trackerProc = null;
        win?.webContents.send("tracking:exit", lastExitCode ?? -1);
      });

      return { ok: true, message: "started" };
    } catch (err: any) {
      trackerProc = null;
      return { ok: false, message: String(err?.message ?? err) };
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
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
});

ipcMain.handle("tracking:open-output", async () => {
  const outDir = path.join(process.env.APP_ROOT!, "output");
  try {
    await shell.openPath(outDir);
    return { ok: true, path: outDir };
  } catch {
    return { ok: false, path: outDir };
  }
});


/* -------------------- Calibration IPC -------------------- */

/**
 * Receives calibration target events from the renderer.
 * Called when a TARGET slide (not CENTER) becomes visible.
 */
ipcMain.handle("calibration:target", async (_e, payload: CalibrationTarget) => {
  calibrationTargets.push(payload);
  console.log(`[calibration] target #${calibrationTargets.length}: (${payload.x}, ${payload.y}) slide_index=${payload.slide_index}`);
  return { ok: true };
});

/**
 * Saves accumulated calibration targets to a JSON file in the session folder.
 * Called when a calibration session ends.
 */
ipcMain.handle("calibration:save", async (_e, sessionDir: string) => {
  const fullPath = path.isAbsolute(sessionDir)
    ? sessionDir
    : path.join(process.env.APP_ROOT!, sessionDir);

  const outPath = path.join(fullPath, "calibration_targets.json");
  try {
    // Ensure directory exists
    fs.mkdirSync(fullPath, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(calibrationTargets, null, 2));
    console.log(`[calibration] saved ${calibrationTargets.length} targets to ${outPath}`);
    const count = calibrationTargets.length;
    calibrationTargets = []; // Reset for next session
    return { ok: true, path: outPath, count };
  } catch (err: any) {
    console.error("[calibration] save error:", err);
    return { ok: false, error: String(err?.message ?? err) };
  }
});

/**
 * Resets calibration target storage. Called at session start.
 */
ipcMain.handle("calibration:reset", async () => {
  calibrationTargets = [];
  console.log("[calibration] reset");
  return { ok: true };
});


/* -------------------- Annotation IPC -------------------- */

ipcMain.handle("annotation:list-videos", async () => {
  const recDir = path.join(process.env.APP_ROOT!, "recordings");
  if (!fs.existsSync(recDir)) return [];

  const files = fs.readdirSync(recDir).filter(f => f.endsWith(".mp4"));
  // Return full paths so the frontend can use them with media:// protocol
  return files.map(f => ({
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
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

/* -------------------- Recordings IPC -------------------- */

ipcMain.handle("recordings:list-folders", async () => {
  const recDir = path.join(process.env.APP_ROOT!, "recordings");
  if (!fs.existsSync(recDir)) return [];
  const items = fs.readdirSync(recDir);
  const folders = items.filter(item => {
    const itemPath = path.join(recDir, item);
    return fs.statSync(itemPath).isDirectory();
  });
  return folders.map(name => ({
    name,
    path: path.join(recDir, name),
    createdAt: fs.statSync(path.join(recDir, name)).birthtime
  })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
});

ipcMain.handle("session:load-data", async (_e, folderPath: string) => {
  if (!fs.existsSync(folderPath)) return { ok: false, error: "Folder not found" };

  const files = fs.readdirSync(folderPath);
  // Filter out _tracked.mp4 files when finding video
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

/* -------------------- App lifecycle -------------------- */

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
      try {
        const u = new URL(request.url);
        // If hostname is present (e.g., media://users/...), stitch it back into the path
        let filePath = decodeURIComponent(u.pathname);
        if (u.hostname && u.hostname !== "localhost") {
          filePath = `/${u.hostname}${filePath}`;
        }
        if (process.platform === "win32") {
          filePath = filePath.replace(/^\/([A-Za-z]:)/, "$1");
        }
        filePath = path.normalize(filePath);
        const exists = fs.existsSync(filePath);
        console.log("[media] load", filePath, "exists:", exists);
        return callback({ path: filePath });
      } catch (error) {
        console.error("[media] failed to resolve", error);
        // @ts-ignore
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
