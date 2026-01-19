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
let headPositionProc: ChildProcessWithoutNullStreams | null = null;
let headPositionBuffer = "";

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

function safePathSegment(value: string) {
  if (!value || value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new Error("Invalid path segment");
  }
  return value;
}

function parseSessionTimestamp(name: string) {
  const match = /_(\d{8})_(\d{6})$/.exec(name);
  if (!match) return 0;
  const [yyyy, mm, dd] = [match[1].slice(0, 4), match[1].slice(4, 6), match[1].slice(6, 8)];
  const [hh, mi, ss] = [match[2].slice(0, 2), match[2].slice(2, 4), match[2].slice(4, 6)];
  const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
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
  win.on("closed", () => {
    win = null;
    stopHeadPositionProcess();
  });
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

/* -------------------- Head Position IPC -------------------- */

function stopHeadPositionProcess() {
  if (headPositionProc && !headPositionProc.killed) {
    try {
      headPositionProc.kill();
    } catch {
      // ignore
    }
  }
  headPositionProc = null;
  headPositionBuffer = "";
}

function handleHeadPositionStdout(chunk: Buffer) {
  headPositionBuffer += chunk.toString();
  const lines = headPositionBuffer.split(/\r?\n/);
  headPositionBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const payload = JSON.parse(trimmed);
      if (payload?.type === "head_position") {
        win?.webContents.send("head_position:update", payload);
      }
    } catch {
      // ignore parse errors
    }
  }
}

ipcMain.handle(
  "head_position:start",
  async (_e, opts: { cam?: number; fps?: number; script?: string; jsonl?: boolean } = {}) => {
    if (headPositionProc && !headPositionProc.killed) {
      return { ok: true, message: "already running" };
    }

    const python = resolvePython();
    const scriptPath = opts.script
      ? path.isAbsolute(opts.script)
        ? opts.script
        : path.join(process.env.APP_ROOT!, opts.script)
      : path.join(process.env.APP_ROOT!, "tracker", "live_head_position.py");

    const args = [scriptPath];
    if (typeof opts.cam === "number") {
      args.push("--cam", String(opts.cam));
    }
    if (typeof opts.fps === "number") {
      args.push("--fps", String(opts.fps));
    }
    if (opts.jsonl === false) {
      args.push("--no-jsonl");
    }

    try {
      headPositionProc = spawn(python, args, {
        cwd: process.env.APP_ROOT!,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      });

      headPositionProc.stdout.on("data", handleHeadPositionStdout);
      headPositionProc.stderr.on("data", (buf) => {
        const msg = buf.toString();
        if (msg.trim()) {
          console.warn("[head_position]", msg.trim());
        }
      });
      headPositionProc.on("close", () => {
        headPositionProc = null;
        headPositionBuffer = "";
      });

      return { ok: true, message: "started" };
    } catch (err: any) {
      headPositionProc = null;
      return { ok: false, message: String(err?.message ?? err) };
    }
  }
);

ipcMain.handle("head_position:stop", async () => {
  stopHeadPositionProcess();
  return { ok: true, message: "stopped" };
});

/* -------------------- Live Gaze Stream IPC -------------------- */

let gazeStreamProc: ChildProcessWithoutNullStreams | null = null;
let gazeStreamBuffer = "";

function stopGazeStreamProcess() {
  if (gazeStreamProc && !gazeStreamProc.killed) {
    try {
      gazeStreamProc.kill();
    } catch {
      // ignore
    }
  }
  gazeStreamProc = null;
  gazeStreamBuffer = "";
}

function handleGazeStreamStdout(chunk: Buffer) {
  gazeStreamBuffer += chunk.toString();
  const lines = gazeStreamBuffer.split(/\r?\n/);
  gazeStreamBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const payload = JSON.parse(trimmed);
      if (payload?.type === "gaze" || payload?.type === "ready") {
        win?.webContents.send("gaze_stream:update", payload);
      }
    } catch {
      // ignore parse errors
    }
  }
}

ipcMain.handle(
  "gaze_stream:start",
  async (_e, opts: { cam?: number; fps?: number; script?: string } = {}) => {
    if (gazeStreamProc && !gazeStreamProc.killed) {
      return { ok: true, message: "already running" };
    }

    const python = resolvePython();
    const scriptPath = opts.script
      ? path.isAbsolute(opts.script)
        ? opts.script
        : path.join(process.env.APP_ROOT!, opts.script)
      : path.join(process.env.APP_ROOT!, "tracker", "live_gaze_stream.py");

    const args = [scriptPath];
    if (typeof opts.cam === "number") {
      args.push("--cam", String(opts.cam));
    }
    if (typeof opts.fps === "number") {
      args.push("--fps", String(opts.fps));
    }

    try {
      gazeStreamProc = spawn(python, args, {
        cwd: process.env.APP_ROOT!,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      });

      gazeStreamProc.stdout.on("data", handleGazeStreamStdout);
      gazeStreamProc.stderr.on("data", (buf) => {
        const msg = buf.toString();
        if (msg.trim()) {
          console.warn("[gaze_stream]", msg.trim());
        }
      });
      gazeStreamProc.on("close", () => {
        gazeStreamProc = null;
        gazeStreamBuffer = "";
      });

      return { ok: true, message: "started" };
    } catch (err: any) {
      gazeStreamProc = null;
      return { ok: false, message: String(err?.message ?? err) };
    }
  }
);

ipcMain.handle("gaze_stream:stop", async () => {
  stopGazeStreamProcess();
  return { ok: true, message: "stopped" };
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

ipcMain.handle("recordings:listSessions", async (_e, { limit = 20 }: { limit?: number } = {}) => {
  const recDir = path.join(process.env.APP_ROOT!, "recordings");
  if (!fs.existsSync(recDir)) return [];
  const items = fs.readdirSync(recDir);
  const dirs = items.filter((item) => {
    const itemPath = path.join(recDir, item);
    return fs.statSync(itemPath).isDirectory();
  });
  const sessions = dirs.map((name) => {
    const dirPath = path.join(recDir, name);
    const stat = fs.statSync(dirPath);
    const mtimeMs = stat.mtimeMs;
    const sortKey = mtimeMs || parseSessionTimestamp(name);
    const reportPath = path.join(dirPath, "calibration_report.json");
    const pairsPath = path.join(dirPath, "calibration_pairs.json");
    const hasCalibration = fs.existsSync(reportPath) && fs.existsSync(pairsPath);
    return { sessionId: name, mtimeMs, sortKey, hasCalibration };
  });
  return sessions
    .sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0))
    .slice(0, limit)
    .map(({ sortKey: _sortKey, ...rest }) => rest);
});

ipcMain.handle(
  "recordings:readJson",
  async (_e, { sessionId, filename }: { sessionId: string; filename: string }) => {
    try {
      const recDir = path.join(process.env.APP_ROOT!, "recordings");
      const safeSession = safePathSegment(sessionId);
      const safeFile = safePathSegment(filename);
      const filePath = path.join(recDir, safeSession, safeFile);
      const resolved = path.resolve(filePath);
      const resolvedRoot = path.resolve(recDir);
      if (!resolved.startsWith(resolvedRoot + path.sep)) {
        return { ok: false, error: "Invalid path" };
      }
      if (!fs.existsSync(resolved)) {
        return { ok: false, error: "File not found" };
      }
      const raw = fs.readFileSync(resolved, "utf-8");
      const data = JSON.parse(raw);
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
);

ipcMain.handle("calibration:run", async (_e, { sessionId }: { sessionId: string }) => {
  try {
    const recDir = path.join(process.env.APP_ROOT!, "recordings");
    const safeSession = safePathSegment(sessionId);
    const sessionPath = path.join(recDir, safeSession);
    if (!fs.existsSync(sessionPath)) {
      return { ok: false, error: "Session folder not found" };
    }

    const python = resolvePython();
    const scriptPath = path.join(process.env.APP_ROOT!, "tracker", "calibration_fit.py");

    return await new Promise((resolve) => {
      const proc = spawn(python, [scriptPath, sessionPath], {
        cwd: process.env.APP_ROOT!,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (buf) => {
        stdout += buf.toString();
      });
      proc.stderr.on("data", (buf) => {
        stderr += buf.toString();
      });
      proc.on("close", (code) => {
        resolve({
          ok: code === 0,
          code,
          stdout,
          stderr,
        });
      });
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
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

ipcMain.handle("session:write-json", async (_e, { filePath, data }: { filePath: string; data: unknown }) => {
  try {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.env.APP_ROOT!, filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, JSON.stringify(data, null, 2));
    return { ok: true, path: resolvedPath };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
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

  app.on("before-quit", () => {
    stopHeadPositionProcess();
    stopGazeStreamProcess();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
