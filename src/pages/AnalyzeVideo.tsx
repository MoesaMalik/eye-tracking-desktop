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

export default function AnalyzeVideo() {
  const [status, setStatus] = useState<TrackerStatus>("idle");
  const [pid, setPid] = useState<number | undefined>(undefined);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastExit, setLastExit] = useState<number | null>(null);
  const [selectedVideoPath, setSelectedVideoPath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unStdout = subscribeTrackerLogs((line) => {
      setLogs((prev) => (prev.length > 800 ? [...prev.slice(-500), line] : [...prev, line]));
    });
    const unStderr = subscribeTrackerErrors((line) => {
      setLogs((prev) => (prev.length > 800 ? [...prev.slice(-500), `[err] ${line}`] : [...prev, `[err] ${line}`]));
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
    setBusy(true);
    setLastExit(null);
    setError(null);
    setLogs((prev) => [...prev, `[info] Starting analysis for ${selectedVideoPath}`]);

    const res = await startTracker({
      videoPath: selectedVideoPath,
      preview: false,
    });
    setBusy(false);

    if (res.ok) {
      const s = await getTrackerStatus();
      setStatus(s.status);
      setPid(s.pid);
    } else {
      setStatus("error");
      setBusy(false);
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
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded border bg-gray-50 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Selected file</div>
            <div className="mt-1 text-sm font-medium">{selectedVideoName || "No file selected"}</div>
            {selectedVideoPath && (
              <div className="mt-1 text-xs text-gray-500 break-all">{selectedVideoPath}</div>
            )}
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
          </div>
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      </div>

      <div className="rounded-lg border bg-white">
        <div className="px-3 py-2 border-b text-sm text-gray-600">Analysis Logs</div>
        <pre className="p-3 text-xs max-h-[420px] overflow-auto whitespace-pre-wrap break-words">
          {logs.join("\n")}
        </pre>
      </div>
    </div>
  );
}
