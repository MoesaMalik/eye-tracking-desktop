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
  startHeadPosition,
  stopHeadPosition,
  subscribeHeadPosition,
  type HeadPositionStatus,
} from "../lib/tracker";

export default function Recorder() {
  const [status, setStatus] = useState<TrackerStatus>("idle");
  const [pid, setPid] = useState<number | undefined>(undefined);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastExit, setLastExit] = useState<number | null>(null);
  const [headStatus, setHeadStatus] = useState<HeadPositionStatus>("NOT_DETECTED");
  const [headInstruction, setHeadInstruction] = useState<string>("Face not detected");
  const [headProgress, setHeadProgress] = useState<number>(0);

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

  useEffect(() => {
    const unsubscribe = subscribeHeadPosition((payload) => {
      setHeadStatus(payload.status);
      setHeadInstruction(payload.instruction ?? "");
      setHeadProgress(payload.progress ?? 0);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (status === "running") {
      stopHeadPosition().catch(() => {});
      return;
    }
    startHeadPosition({ fps: 20 }).catch(() => {});
  }, [status]);

  useEffect(() => {
    return () => {
      stopHeadPosition().catch(() => {});
    };
  }, []);

  async function onStart() {
    if (headStatus !== "READY") return;
    setBusy(true);
    setLastExit(null);
    await stopHeadPosition().catch(() => {});
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

  const headBadge =
    headStatus === "READY"
      ? "bg-green-100 text-green-800 border-green-300"
      : headStatus === "STABILIZING"
        ? "bg-amber-100 text-amber-800 border-amber-300"
        : headStatus === "ALIGNING"
          ? "bg-blue-100 text-blue-800 border-blue-300"
          : "bg-red-100 text-red-800 border-red-300";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Tracker (Python)</h1>

      <div className="rounded-lg border bg-white p-3 flex flex-wrap items-center gap-3">
        <span className={`text-xs px-2 py-0.5 border rounded ${headBadge}`}>
          Head: {headStatus}
        </span>
        <div className="text-sm text-gray-700">{headInstruction || "Align your head"}</div>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-40 h-2 bg-gray-200 rounded">
            <div
              className="h-2 bg-gray-900 rounded"
              style={{ width: `${Math.round(headProgress * 100)}%` }}
            />
          </div>
          <span className="text-xs text-gray-500">{Math.round(headProgress * 100)}%</span>
        </div>
      </div>

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
            disabled={busy || status === "running" || headStatus !== "READY"}
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
