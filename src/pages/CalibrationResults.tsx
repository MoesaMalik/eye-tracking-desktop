import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";

type SessionEntry = {
  sessionId: string;
  mtimeMs?: number;
  hasCalibration?: boolean;
};

type CalibrationPair = {
  target: {
    filename: string;
    x: number;
    y: number;
    timestamp_ms: number;
  };
  gaze_avg: {
    x: number | null;
    y: number | null;
  };
  n_frames: number;
  valid: boolean;
};

type CalibrationPairsPayload = {
  pairs: CalibrationPair[];
};

type CalibrationReportPayload = {
  num_targets?: number;
  valid_pairs?: number;
  mean_error_px?: number | null;
  median_error_px?: number | null;
  rmse_px?: number | null;
  per_target?: Array<{
    filename: string;
    x: number;
    y: number;
    n_frames: number;
    valid: boolean;
    error_px?: number;
  }>;
};

type CalibrationModelPayload = {
  coeffs?: {
    sx?: number[];
    sy?: number[];
  };
};

function invokeIpc(channel: string, payload?: any) {
  if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
  if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
  return Promise.resolve({ ok: false, error: "IPC not available" });
}

function formatTime(ms?: number) {
  if (!ms) return "Unknown";
  return new Date(ms).toLocaleString();
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(digits);
}

export default function CalibrationResults() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selectedSession, setSelectedSession] = useState<string>("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingFiles, setMissingFiles] = useState<string[]>([]);

  const [report, setReport] = useState<CalibrationReportPayload | null>(null);
  const [pairsPayload, setPairsPayload] = useState<CalibrationPairsPayload | null>(null);
  const [model, setModel] = useState<CalibrationModelPayload | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [runOutput, setRunOutput] = useState<string>("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setLoadingSessions(true);
    invokeIpc("recordings:listSessions", { limit: 20 })
      .then((res: any) => {
        if (Array.isArray(res)) {
          setSessions(res);
          return;
        }
        setError(res?.error || "Failed to load sessions.");
      })
      .catch((e: any) => {
        setError(String(e));
      })
      .finally(() => setLoadingSessions(false));
  }, []);

  useEffect(() => {
    if (!selectedSession && sessions.length > 0) {
      const firstWithResults = sessions.find((s) => s.hasCalibration);
      setSelectedSession(firstWithResults?.sessionId ?? sessions[0].sessionId);
    }
  }, [sessions, selectedSession]);

  useEffect(() => {
    if (!selectedSession) return;
    setLoadingData(true);
    setError(null);
    setMissingFiles([]);
    setReport(null);
    setPairsPayload(null);
    setModel(null);
    setRunStatus("idle");
    setRunOutput("");

    const required = ["calibration_report.json", "calibration_pairs.json"];

    Promise.all([
      invokeIpc("recordings:readJson", {
        sessionId: selectedSession,
        filename: "calibration_report.json",
      }),
      invokeIpc("recordings:readJson", {
        sessionId: selectedSession,
        filename: "calibration_pairs.json",
      }),
      invokeIpc("recordings:readJson", {
        sessionId: selectedSession,
        filename: "calibration_model.json",
      }),
    ])
      .then(([reportRes, pairsRes, modelRes]) => {
        const missing: string[] = [];
        if (!reportRes?.ok) missing.push(required[0]);
        if (!pairsRes?.ok) missing.push(required[1]);
        setMissingFiles(missing);

        if (reportRes?.ok) setReport(reportRes.data);
        if (pairsRes?.ok) setPairsPayload(pairsRes.data);
        if (modelRes?.ok) setModel(modelRes.data);
        if (reportRes?.ok || pairsRes?.ok) {
          console.log("[CalibrationResults] loaded", {
            sessionId: selectedSession,
            pairs: pairsRes?.data?.pairs?.length ?? 0,
            valid: reportRes?.data?.valid_pairs ?? 0,
          });
        }
      })
      .catch((e: any) => {
        setError(String(e));
      })
      .finally(() => setLoadingData(false));
  }, [selectedSession, reloadToken]);

  const pairs = pairsPayload?.pairs ?? [];
  const validPairs = useMemo(
    () =>
      pairs.filter(
        (p) => p.valid && p.gaze_avg?.x !== null && p.gaze_avg?.y !== null
      ),
    [pairs]
  );

  const hasModel =
    !!model?.coeffs?.sx &&
    !!model?.coeffs?.sy &&
    model.coeffs.sx.length === 3 &&
    model.coeffs.sy.length === 3;

  const predict = (gx: number, gy: number) => {
    const sx = model!.coeffs!.sx!;
    const sy = model!.coeffs!.sy!;
    return {
      x: sx[0] * gx + sx[1] * gy + sx[2],
      y: sy[0] * gx + sy[1] * gy + sy[2],
    };
  };

  const errorRows = useMemo(() => {
    if (report?.per_target && report.per_target.length > 0) {
      return report.per_target
        .filter((t) => t.valid && typeof t.error_px === "number")
        .map((t) => ({ name: t.filename, error: t.error_px ?? 0 }));
    }
    if (!hasModel) return [];
    return validPairs.map((p) => {
      const pred = predict(p.gaze_avg.x!, p.gaze_avg.y!);
      const dx = pred.x - p.target.x;
      const dy = pred.y - p.target.y;
      return { name: p.target.filename, error: Math.hypot(dx, dy) };
    });
  }, [report, validPairs, hasModel]);

  const errorValues = errorRows.map((r) => r.error);
  const minError = errorValues.length ? Math.min(...errorValues) : null;
  const maxError = errorValues.length ? Math.max(...errorValues) : null;

  const summary = {
    validTargets: report?.valid_pairs ?? validPairs.length,
    meanError: report?.mean_error_px ?? null,
    medianError: report?.median_error_px ?? null,
    rmse: report?.rmse_px ?? null,
  };

  const maxX = Math.max(0, ...pairs.map((p) => p.target.x || 0));
  const maxY = Math.max(0, ...pairs.map((p) => p.target.y || 0));

  const scatterTargets = validPairs.map((p) => ({
    x: p.target.x,
    y: p.target.y,
    name: p.target.filename,
  }));

  const scatterPredicted = hasModel
    ? validPairs.map((p) => {
        const pred = predict(p.gaze_avg.x!, p.gaze_avg.y!);
        return { x: pred.x, y: pred.y, name: p.target.filename };
      })
    : [];

  const tableRows = pairs.map((p) => {
    const pred = hasModel && p.valid && p.gaze_avg.x !== null && p.gaze_avg.y !== null
      ? predict(p.gaze_avg.x, p.gaze_avg.y)
      : null;
    const error =
      pred && p.valid
        ? Math.hypot(pred.x - p.target.x, pred.y - p.target.y)
        : null;
    return {
      filename: p.target.filename,
      targetX: p.target.x,
      targetY: p.target.y,
      gazeX: p.gaze_avg.x,
      gazeY: p.gaze_avg.y,
      predX: pred?.x ?? null,
      predY: pred?.y ?? null,
      error,
      nFrames: p.n_frames,
      valid: p.valid,
    };
  });

  const runCalibration = async () => {
    if (!selectedSession) return;
    setRunStatus("running");
    setRunOutput("");
    const res = await invokeIpc("calibration:run", { sessionId: selectedSession });
    if (!res?.ok) {
      setRunStatus("error");
      setRunOutput(res?.stderr || res?.error || "Calibration failed.");
      return;
    }
    setRunStatus("done");
    setRunOutput(res?.stdout || "Calibration finished.");
    const refreshed = await invokeIpc("recordings:listSessions", { limit: 20 });
    if (Array.isArray(refreshed)) setSessions(refreshed);
    setReloadToken((value) => value + 1);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Calibration Results</h1>
        <p className="text-sm text-gray-600">
          Review calibration outputs for recent sessions.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        <div className="rounded-lg border bg-white p-3 space-y-3">
          <div className="text-sm font-semibold">Recent Sessions</div>
          {loadingSessions ? (
            <div className="text-sm text-gray-500">Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div className="text-sm text-gray-500">No sessions found.</div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => {
                const selected = session.sessionId === selectedSession;
                return (
                  <button
                    key={session.sessionId}
                    className={`w-full text-left px-3 py-2 rounded border ${
                      selected ? "bg-gray-900 text-white border-gray-900" : "bg-white"
                    } ${!session.hasCalibration ? "opacity-70" : ""}`}
                    onClick={() => setSelectedSession(session.sessionId)}
                  >
                    <div className="text-sm font-medium">{session.sessionId}</div>
                    <div className={`text-xs ${selected ? "text-gray-200" : "text-gray-500"}`}>
                      {formatTime(session.mtimeMs)}
                    </div>
                    {!session.hasCalibration && (
                      <div className={`text-xs ${selected ? "text-gray-200" : "text-amber-700"}`}>
                        No calibration results
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {!selectedSession ? (
            <div className="rounded-lg border bg-white p-4 text-sm text-gray-600">
              Select a session to view calibration results.
            </div>
          ) : loadingData ? (
            <div className="rounded-lg border bg-white p-4 text-sm text-gray-600">
              Loading calibration data...
            </div>
          ) : missingFiles.length > 0 ? (
            <div className="rounded-lg border bg-white p-4 text-sm text-gray-600">
              <div className="font-medium text-gray-900">
                No calibration outputs found. Run calibration for this session.
              </div>
              <div className="mt-1 text-xs text-gray-500">
                Missing: {missingFiles.join(", ")}
              </div>
              <button
                className="mt-3 px-3 py-1.5 rounded border bg-white text-sm"
                onClick={runCalibration}
                disabled={runStatus === "running"}
              >
                {runStatus === "running" ? "Running calibration..." : "Run calibration now"}
              </button>
              {runOutput && (
                <pre className="mt-3 text-xs bg-gray-50 border rounded p-2 whitespace-pre-wrap">
                  {runOutput}
                </pre>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  Session: <span className="font-medium">{selectedSession}</span>
                </div>
                <button
                  className="px-3 py-1.5 rounded border bg-white text-sm"
                  onClick={runCalibration}
                  disabled={runStatus === "running"}
                >
                  {runStatus === "running" ? "Running calibration..." : "Run calibration now"}
                </button>
              </div>
              {runOutput && (
                <pre className="text-xs bg-gray-50 border rounded p-2 whitespace-pre-wrap">
                  {runOutput}
                </pre>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="rounded border bg-white p-3">
                  <div className="text-xs text-gray-500">Valid targets</div>
                  <div className="text-lg font-semibold">{summary.validTargets}</div>
                </div>
                <div className="rounded border bg-white p-3">
                  <div className="text-xs text-gray-500">Mean error (px)</div>
                  <div className="text-lg font-semibold">{formatNumber(summary.meanError)}</div>
                </div>
                <div className="rounded border bg-white p-3">
                  <div className="text-xs text-gray-500">Median error (px)</div>
                  <div className="text-lg font-semibold">{formatNumber(summary.medianError)}</div>
                </div>
                <div className="rounded border bg-white p-3">
                  <div className="text-xs text-gray-500">RMSE (px)</div>
                  <div className="text-lg font-semibold">{formatNumber(summary.rmse)}</div>
                </div>
                <div className="rounded border bg-white p-3">
                  <div className="text-xs text-gray-500">Min / Max (px)</div>
                  <div className="text-lg font-semibold">
                    {formatNumber(minError)} / {formatNumber(maxError)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div className="rounded-lg border bg-white p-3">
                  <div className="text-sm font-semibold mb-2">Predicted vs Actual</div>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          type="number"
                          dataKey="x"
                          domain={[0, maxX || 1000]}
                          name="X"
                        />
                        <YAxis
                          type="number"
                          dataKey="y"
                          domain={[0, maxY || 1000]}
                          reversed
                          name="Y"
                        />
                        <Tooltip cursor={{ strokeDasharray: "3 3" }} />
                        <Scatter name="Target" data={scatterTargets} fill="#111827" />
                        {hasModel && (
                          <Scatter name="Predicted" data={scatterPredicted} fill="#2563eb" />
                        )}
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                  {!hasModel && (
                    <div className="text-xs text-gray-500 mt-2">
                      Model not found; predicted points hidden.
                    </div>
                  )}
                </div>

                <div className="rounded-lg border bg-white p-3">
                  <div className="text-sm font-semibold mb-2">Error per target</div>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={errorRows}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={false} />
                        <YAxis />
                        <Tooltip />
                        <Bar dataKey="error" fill="#f97316" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-white overflow-hidden">
                <div className="px-3 py-2 border-b text-sm font-semibold">
                  Target detail table
                </div>
                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="text-left px-3 py-2">Filename</th>
                        <th className="text-left px-3 py-2">Target (x, y)</th>
                        <th className="text-left px-3 py-2">Avg gaze (gx, gy)</th>
                        <th className="text-left px-3 py-2">Predicted (x, y)</th>
                        <th className="text-left px-3 py-2">Error (px)</th>
                        <th className="text-left px-3 py-2">Frames</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((row) => (
                        <tr key={row.filename} className="border-t">
                          <td className="px-3 py-2">{row.filename}</td>
                          <td className="px-3 py-2">
                            {row.targetX}, {row.targetY}
                          </td>
                          <td className="px-3 py-2">
                            {formatNumber(row.gazeX, 2)}, {formatNumber(row.gazeY, 2)}
                          </td>
                          <td className="px-3 py-2">
                            {formatNumber(row.predX, 2)}, {formatNumber(row.predY, 2)}
                          </td>
                          <td className="px-3 py-2">
                            {row.valid ? formatNumber(row.error, 2) : "-"}
                          </td>
                          <td className="px-3 py-2">{row.nFrames}</td>
                        </tr>
                      ))}
                      {tableRows.length === 0 && (
                        <tr>
                          <td className="px-3 py-3 text-sm text-gray-500" colSpan={6}>
                            No calibration pairs found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
