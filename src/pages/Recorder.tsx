// src/pages/Recorder.tsx
import { useEffect, useState } from "react";
import {
  getTrackerStatus,
  startTracker,
  stopTracker,
  subscribeTrackerLogs,
  subscribeTrackerErrors,
  subscribeTrackerExit,
  type TrackerStatus,
} from "../lib/tracker";

export default function Recorder() {
  const [status, setStatus] = useState<TrackerStatus>("idle");
  const [pid, setPid] = useState<number | undefined>(undefined);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastExit, setLastExit] = useState<number | null>(null);

  // wire up log streams + initial status
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

  async function onStart() {
    setBusy(true);
    setLastExit(null);
    const res = await startTracker();
    setBusy(false);

    if (res.ok) {
      setStatus("running");
      const s = await getTrackerStatus();
      setPid(s.pid);
    } else {
      setStatus("error");
      setLogs((p) => [...p, `Start failed: ${res.message}`]);
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
      setLogs((p) => [...p, `Stop failed: ${res.message}`]);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Tracker (Python)</h1>

      <div className="rounded-lg border bg-white p-4 flex flex-wrap items-center gap-3">
        <div className="text-sm">
          <span className="text-gray-600">Status:</span>{" "}
          <b className={status === "running" ? "text-green-600" : status === "error" ? "text-red-600" : ""}>
            {status}
          </b>
        </div>
        <div className="text-sm">
          <span className="text-gray-600">PID:</span> <b>{pid ?? "—"}</b>
        </div>
        {lastExit !== null && (
          <div className="text-sm">
            <span className="text-gray-600">Last exit code:</span> <b>{lastExit}</b>
          </div>
        )}

        <div className="ml-auto flex gap-2">
          <button
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={onStart}
            disabled={busy || status === "running"}
          >
            {busy && status !== "running" ? "Starting…" : "Start"}
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={onStop}
            disabled={busy || status !== "running"}
          >
            {busy && status === "running" ? "Stopping…" : "Stop"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-white">
        <div className="px-3 py-2 border-b text-sm text-gray-600">Tracker Logs</div>
        <pre className="p-3 text-xs max-h-[360px] overflow-auto whitespace-pre-wrap break-words">
          {logs.join("\n")}
        </pre>
      </div>
    </div>
  );
}
