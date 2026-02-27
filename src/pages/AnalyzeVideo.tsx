import { useEffect, useMemo, useState } from "react";
import {
  getTrackerStatus,
  openTrackerOutput,
  pickTrackerVideo,
  startTracker,
  stopTracker,
  subscribeTrackerErrors,
  subscribeTrackerExit,
  subscribeTrackerLogs,
  type TrackerStatus,
} from "../lib/tracker";

function basename(filePath: string) {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function sanitizeStem(value: string) {
  return (
    value
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "video"
  );
}

function nowStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function invokeIpc(channel: string, payload?: unknown) {
  if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
  if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
  return Promise.resolve({ ok: false, error: "IPC not available" });
}

function toFinite(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function fmt(value: number | null | undefined, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

type TrackingFrame = Record<string, unknown> & {
  frame?: number;
  timestamp_sec?: number;
};

type CoordStats = {
  label: string;
  count: number;
  first: { x: number; y: number } | null;
  last: { x: number; y: number } | null;
  mean: { x: number; y: number } | null;
  min: { x: number; y: number } | null;
  max: { x: number; y: number } | null;
};

type CoordinateReport = {
  generatedAt: string;
  sessionId: string;
  sourceVideoPath: string;
  trackingFilename: string;
  totalFrames: number;
  validFramesWithAnyEye: number;
  summary: CoordStats[];
  rows: Array<{
    frame: number | null;
    timestamp_sec: number | null;
    left_x_from_start: number | null;
    left_y_from_start: number | null;
    right_x_from_start: number | null;
    right_y_from_start: number | null;
    gaze_x_from_start: number | null;
    gaze_y_from_start: number | null;
  }>;
};

function calcStats(frames: TrackingFrame[], label: string, xKey: string, yKey: string): CoordStats {
  let count = 0;
  let first: { x: number; y: number } | null = null;
  let last: { x: number; y: number } | null = null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let sumX = 0;
  let sumY = 0;

  for (const frame of frames) {
    const x = toFinite(frame[xKey]);
    const y = toFinite(frame[yKey]);
    if (x === null || y === null) continue;

    count += 1;
    if (!first) first = { x, y };
    last = { x, y };

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    sumX += x;
    sumY += y;
  }

  return {
    label,
    count,
    first,
    last,
    mean: count > 0 ? { x: sumX / count, y: sumY / count } : null,
    min: count > 0 ? { x: minX, y: minY } : null,
    max: count > 0 ? { x: maxX, y: maxY } : null,
  };
}

function getCoord(frame: TrackingFrame, fromStartKey: string, absoluteKey: string) {
  return toFinite(frame[fromStartKey]) ?? toFinite(frame[absoluteKey]);
}

export default function AnalyzeVideo() {
  const [status, setStatus] = useState<TrackerStatus>("idle");
  const [pid, setPid] = useState<number | undefined>(undefined);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastExit, setLastExit] = useState<number | null>(null);
  const [selectedVideoPath, setSelectedVideoPath] = useState<string>("");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [analyzedVideoPath, setAnalyzedVideoPath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportPath, setReportPath] = useState<string | null>(null);
  const [report, setReport] = useState<CoordinateReport | null>(null);

  useEffect(() => {
    const unStdout = subscribeTrackerLogs((line) => {
      setLogs((prev) => (prev.length > 800 ? [...prev.slice(-500), line] : [...prev, line]));
    });
    const unStderr = subscribeTrackerErrors((line) => {
      setLogs((prev) =>
        prev.length > 800 ? [...prev.slice(-500), `[err] ${line}`] : [...prev, `[err] ${line}`]
      );
    });
    const unExit = subscribeTrackerExit((code) => {
      setLastExit(code);
      setStatus("stopped");
      setPid(undefined);
      setBusy(false);
    });

    getTrackerStatus().then((s) => {
      setStatus(s.status);
      setPid(s.pid);
    });

    return () => {
      unStdout && unStdout();
      unStderr && unStderr();
      unExit && unExit();
    };
  }, []);

  const selectedVideoName = useMemo(
    () => (selectedVideoPath ? basename(selectedVideoPath) : ""),
    [selectedVideoPath]
  );

  async function onPickVideo() {
    setError(null);
    setCurrentSessionId(null);
    setAnalyzedVideoPath("");
    setReport(null);
    setReportError(null);
    setReportPath(null);

    const result = await pickTrackerVideo();
    if (!result.ok) {
      setError(result.message ?? "Failed to open file picker");
      return;
    }
    if (result.canceled || !result.path) return;
    setSelectedVideoPath(result.path);
  }

  async function onAnalyze() {
    if (!selectedVideoPath) return;

    const sessionId = `import_${sanitizeStem(basename(selectedVideoPath))}_${nowStamp()}`;
    const outDir = `recordings/${sessionId}`;

    setBusy(true);
    setLastExit(null);
    setError(null);
    setReport(null);
    setReportError(null);
    setReportPath(null);
    setCurrentSessionId(sessionId);
    setAnalyzedVideoPath(selectedVideoPath);
    setLogs((prev) => [...prev, `[info] Starting analysis for ${selectedVideoPath}`]);
    setLogs((prev) => [...prev, `[info] Session output: ${outDir}`]);

    const res = await startTracker({
      videoPath: selectedVideoPath,
      preview: false,
      outDir,
    });
    setBusy(false);

    if (res.ok) {
      const s = await getTrackerStatus();
      setStatus(s.status);
      setPid(s.pid);
    } else {
      setStatus("error");
      setLogs((prev) => [...prev, `Start failed: ${res.message}`]);
      setError(res.message);
    }
  }

  async function onStop() {
    setBusy(true);
    const res = await stopTracker();
    setBusy(false);

    if (res.ok) {
      const s = await getTrackerStatus();
      setStatus(s.status);
      setPid(s.pid);
    } else {
      setStatus("error");
      setLogs((prev) => [...prev, `Stop failed: ${res.message}`]);
      setError(res.message);
    }
  }

  async function onCreateReport() {
    if (!currentSessionId) return;

    setReportBusy(true);
    setReportError(null);
    setReportPath(null);

    const trackingRes = await invokeIpc("recordings:readTracking", { sessionId: currentSessionId });
    if (!trackingRes?.ok) {
      setReportBusy(false);
      setReportError(trackingRes?.error || "Failed to load tracking data for report.");
      return;
    }

    const framesPayload = Array.isArray(trackingRes.data)
      ? trackingRes.data
      : Array.isArray(trackingRes.data?.frames)
      ? trackingRes.data.frames
      : [];
    const frames = framesPayload as TrackingFrame[];
    const rows = frames.map((f) => ({
      frame: toFinite(f.frame) ?? null,
      timestamp_sec: toFinite(f.timestamp_sec) ?? null,
      left_x_from_start: getCoord(f, "left_center_x_from_start", "left_center_x"),
      left_y_from_start: getCoord(f, "left_center_y_from_start", "left_center_y"),
      right_x_from_start: getCoord(f, "right_center_x_from_start", "right_center_x"),
      right_y_from_start: getCoord(f, "right_center_y_from_start", "right_center_y"),
      gaze_x_from_start: getCoord(f, "gaze_x_from_start", "gaze_x"),
      gaze_y_from_start: getCoord(f, "gaze_y_from_start", "gaze_y"),
    }));
    const reportFrames: TrackingFrame[] = rows.map((row) => ({
      left_x_from_start: row.left_x_from_start,
      left_y_from_start: row.left_y_from_start,
      right_x_from_start: row.right_x_from_start,
      right_y_from_start: row.right_y_from_start,
      gaze_x_from_start: row.gaze_x_from_start,
      gaze_y_from_start: row.gaze_y_from_start,
    }));

    const validFramesWithAnyEye = reportFrames.filter((f) => {
      const lx = toFinite(f.left_x_from_start);
      const ly = toFinite(f.left_y_from_start);
      const rx = toFinite(f.right_x_from_start);
      const ry = toFinite(f.right_y_from_start);
      return (lx !== null && ly !== null) || (rx !== null && ry !== null);
    }).length;

    const reportData: CoordinateReport = {
      generatedAt: new Date().toISOString(),
      sessionId: currentSessionId,
      sourceVideoPath: analyzedVideoPath || selectedVideoPath,
      trackingFilename: trackingRes.filename ?? "unknown_tracking_file",
      totalFrames: frames.length,
      validFramesWithAnyEye,
      summary: [
        calcStats(
          reportFrames,
          "Left Eye (from start)",
          "left_x_from_start",
          "left_y_from_start"
        ),
        calcStats(
          reportFrames,
          "Right Eye (from start)",
          "right_x_from_start",
          "right_y_from_start"
        ),
        calcStats(
          reportFrames,
          "Gaze (from start)",
          "gaze_x_from_start",
          "gaze_y_from_start"
        ),
      ],
      rows,
    };

    const savePath = `recordings/${currentSessionId}/eye_coordinate_report.json`;
    const saveRes = await invokeIpc("session:write-json", {
      filePath: savePath,
      data: reportData,
    });

    setReportBusy(false);
    if (!saveRes?.ok) {
      setReportError(saveRes?.error || "Failed to save report.");
      return;
    }

    setReport(reportData);
    setReportPath(saveRes.path ?? savePath);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Analyze Recording (MP4)</h1>
        <p className="text-sm text-gray-600">
          Select an existing recording and run the Python tracker on it. Results are saved under the app&apos;s
          <code className="mx-1 rounded bg-gray-100 px-1 py-0.5">recordings/</code>
          folder.
        </p>
      </div>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={onPickVideo}
            disabled={busy || status === "running"}
          >
            Choose MP4
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={onAnalyze}
            disabled={busy || status === "running" || !selectedVideoPath}
          >
            {busy && status !== "running" ? "Starting…" : "Analyze"}
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={onStop}
            disabled={busy || status !== "running"}
          >
            {busy && status === "running" ? "Stopping…" : "Stop"}
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-white"
            onClick={() => openTrackerOutput()}
            type="button"
          >
            Open recordings folder
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={onCreateReport}
            disabled={reportBusy || busy || status === "running" || lastExit !== 0 || !currentSessionId}
            type="button"
          >
            {reportBusy ? "Creating report…" : "Create Coordinate Report"}
          </button>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded border bg-gray-50 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Selected file</div>
            <div className="mt-1 text-sm font-medium">{selectedVideoName || "No file selected"}</div>
            {selectedVideoPath && <div className="mt-1 text-xs text-gray-500 break-all">{selectedVideoPath}</div>}
          </div>
          <div className="rounded border bg-gray-50 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Tracker</div>
            <div className="mt-1 text-sm">
              Status:{" "}
              <b className={status === "running" ? "text-green-600" : status === "error" ? "text-red-600" : ""}>
                {status}
              </b>
            </div>
            <div className="text-sm text-gray-700">PID: {pid ?? "—"}</div>
            {lastExit !== null && <div className="text-sm text-gray-700">Last exit: {lastExit}</div>}
            {currentSessionId && <div className="text-xs text-gray-500 mt-1">Session: {currentSessionId}</div>}
          </div>
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {reportError && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{reportError}</div>
        )}
        {reportPath && (
          <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
            Report saved: <code>{reportPath}</code>
          </div>
        )}
      </div>

      {report && (
        <div className="rounded-lg border bg-white">
          <div className="px-3 py-2 border-b text-sm text-gray-600">Eye Coordinate Report</div>
          <div className="p-3 space-y-3">
            <div className="text-sm text-gray-700">
              Frames: <b>{report.totalFrames}</b> | Valid frames with eye data: <b>{report.validFramesWithAnyEye}</b>
            </div>
            <div className="overflow-auto">
              <table className="min-w-full text-xs border">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 border text-left">Stream</th>
                    <th className="px-2 py-1 border text-right">Samples</th>
                    <th className="px-2 py-1 border text-right">First X,Y</th>
                    <th className="px-2 py-1 border text-right">Last X,Y</th>
                    <th className="px-2 py-1 border text-right">Mean X,Y</th>
                    <th className="px-2 py-1 border text-right">Min X,Y</th>
                    <th className="px-2 py-1 border text-right">Max X,Y</th>
                  </tr>
                </thead>
                <tbody>
                  {report.summary.map((row) => (
                    <tr key={row.label}>
                      <td className="px-2 py-1 border">{row.label}</td>
                      <td className="px-2 py-1 border text-right">{row.count}</td>
                      <td className="px-2 py-1 border text-right">
                        {fmt(row.first?.x)},{fmt(row.first?.y)}
                      </td>
                      <td className="px-2 py-1 border text-right">
                        {fmt(row.last?.x)},{fmt(row.last?.y)}
                      </td>
                      <td className="px-2 py-1 border text-right">
                        {fmt(row.mean?.x)},{fmt(row.mean?.y)}
                      </td>
                      <td className="px-2 py-1 border text-right">
                        {fmt(row.min?.x)},{fmt(row.min?.y)}
                      </td>
                      <td className="px-2 py-1 border text-right">
                        {fmt(row.max?.x)},{fmt(row.max?.y)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-gray-500">
              Report includes per-frame zero-based coordinates in <code>eye_coordinate_report.json</code>.
            </div>
          </div>
        </div>
      )}

      {report && (
        <div className="rounded-lg border bg-white">
          <div className="px-3 py-2 border-b text-sm text-gray-600">Report Rows (all)</div>
          <div className="p-3 h-[420px] overflow-auto">
            <table className="min-w-full text-xs border">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 border text-right">Frame</th>
                  <th className="px-2 py-1 border text-right">Time(s)</th>
                  <th className="px-2 py-1 border text-right">Left X</th>
                  <th className="px-2 py-1 border text-right">Left Y</th>
                  <th className="px-2 py-1 border text-right">Right X</th>
                  <th className="px-2 py-1 border text-right">Right Y</th>
                  <th className="px-2 py-1 border text-right">Gaze X</th>
                  <th className="px-2 py-1 border text-right">Gaze Y</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, idx) => (
                  <tr key={`${row.frame ?? "na"}-${idx}`}>
                    <td className="px-2 py-1 border text-right">{fmt(row.frame, 0)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.timestamp_sec, 3)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.left_x_from_start)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.left_y_from_start)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.right_x_from_start)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.right_y_from_start)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.gaze_x_from_start)}</td>
                    <td className="px-2 py-1 border text-right">{fmt(row.gaze_y_from_start)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-white">
        <div className="px-3 py-2 border-b text-sm text-gray-600">Analysis Logs</div>
        <pre className="p-3 text-xs max-h-[420px] overflow-auto whitespace-pre-wrap break-words">
          {logs.join("\n")}
        </pre>
      </div>
    </div>
  );
}
