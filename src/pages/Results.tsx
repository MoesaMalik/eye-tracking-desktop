import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { usePatientStore } from "../store/patientStore";
import type { Patient, SessionSummary } from "../types";
import { ShimmerButton } from "../components/ui/shimmer-button";

type SlideRow = {
  key: string;
  label: string;
  baselineCount: number;
  rerunCount: number;
  baselineMean: { x: number; y: number };
  rerunMean: { x: number; y: number };
  distance: number;
  baselineGST: number | null;
  rerunGST: number | null;
  baselineJitter: number | null;
  rerunJitter: number | null;
  diffPct?: number;
  pctScreenDiag: number;
  screenW: number;
  screenH: number;
  screenDiag: number;
};

function invokeIpc(channel: string, payload?: unknown) {
  if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
  if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
  return Promise.resolve({ ok: false, error: "IPC not available" });
}

type ScreenSize = {
  width: number;
  height: number;
};

function resolveScreenSize(): ScreenSize {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  const width = window.innerWidth || window.screen?.width || 0;
  const height = window.innerHeight || window.screen?.height || 0;
  return { width, height };
}

function formatPct(value: number, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}

export default function Results() {
  const [params, setParams] = useSearchParams();
  const patientParam = params.get("patient") ?? "";
  const patientsMap = usePatientStore((s) => s.patients);
  const sessionsByPatient = usePatientStore((s) => s.sessionsByPatient);

  const patients = useMemo<Patient[]>(
    () => Object.values(patientsMap).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [patientsMap]
  );

  const [selectedPatientId, setSelectedPatientId] = useState<string>(patientParam || "");
  const [baselineId, setBaselineId] = useState<string>("");
  const [rerunId, setRerunId] = useState<string>("");
  const [rows, setRows] = useState<SlideRow[]>([]);
  const [missingBaseline, setMissingBaseline] = useState<string[]>([]);
  const [missingRerun, setMissingRerun] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessions = useMemo<SessionSummary[]>(() => {
    if (!selectedPatientId) return [];
    const list = sessionsByPatient[selectedPatientId] ?? [];
    return [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }, [selectedPatientId, sessionsByPatient]);

  const baselineSession = useMemo(
    () => sessions.find((s) => s.id === baselineId) ?? null,
    [sessions, baselineId]
  );
  const rerunSessions = useMemo(
    () => (baselineId ? sessions.filter((s) => s.id !== baselineId) : []),
    [sessions, baselineId]
  );

  useEffect(() => {
    if (patientParam && patientParam !== selectedPatientId && patientsMap[patientParam]) {
      setSelectedPatientId(patientParam);
      return;
    }
    if (!selectedPatientId && patients.length > 0) {
      setSelectedPatientId(patientParam || patients[0].id);
      return;
    }
    if (selectedPatientId && !patientsMap[selectedPatientId] && patients.length > 0) {
      setSelectedPatientId(patients[0].id);
    }
  }, [patients, patientsMap, selectedPatientId, patientParam]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (baselineId) setBaselineId("");
      if (rerunId) setRerunId("");
    } else if (!baselineId || !sessions.find((s) => s.id === baselineId)) {
      setBaselineId(sessions[0].id);
    }
  }, [sessions, baselineId, rerunId]);

  useEffect(() => {
    if (!baselineId) {
      if (rerunId) setRerunId("");
    } else if (rerunSessions.length === 0) {
      if (rerunId) setRerunId("");
    } else if (!rerunId || rerunId === baselineId || !rerunSessions.find((s) => s.id === rerunId)) {
      setRerunId(rerunSessions[rerunSessions.length - 1].id);
    }
    setRows([]);
    setMissingBaseline([]);
    setMissingRerun([]);
    setError(null);
  }, [baselineId, rerunSessions, rerunId]);

  async function runComparison() {
    if (!baselineId || !rerunId) {
      setError("Select a baseline and rerun session.");
      return;
    }
    setLoading(true);
    setError(null);
    setRows([]);
    setMissingBaseline([]);
    setMissingRerun([]);

    const screen = resolveScreenSize();
    if (import.meta.env.DEV) {
      const diag = Math.hypot(screen.width, screen.height);
      const testDist = 33;
      const pct = diag > 0 ? (testDist / diag) * 100 : 0;
      console.log(
        `[Results] pctScreenDiag sanity: dist=${testDist} screen=${screen.width}x${screen.height} pct=${pct.toFixed(2)}%`
      );
    }

    // Load calibration reports instead of tracking data
    const [baseRes, rerunRes] = await Promise.all([
      invokeIpc("recordings:readCalibrationReport", { sessionId: baselineId }),
      invokeIpc("recordings:readCalibrationReport", { sessionId: rerunId }),
    ]);

    if (!baseRes?.ok || !rerunRes?.ok) {
      setError(baseRes?.error || rerunRes?.error || "Failed to load calibration report data.");
      setLoading(false);
      return;
    }

    // Extract per_target data from calibration reports
    const baseTargets = baseRes.data?.per_target || [];
    const rerunTargets = rerunRes.data?.per_target || [];

    // Build comparison rows from calibration report data
    const targetMap = new Map<string, any>();
    const screenDiag = Math.hypot(screen.width, screen.height);

    // Index baseline targets by filename
    for (const target of baseTargets) {
      if (!target.filename) continue;
      targetMap.set(target.filename, { baseline: target, rerun: null });
    }

    // Match rerun targets
    for (const target of rerunTargets) {
      if (!target.filename) continue;
      const existing = targetMap.get(target.filename);
      if (existing) {
        existing.rerun = target;
      } else {
        targetMap.set(target.filename, { baseline: null, rerun: target });
      }
    }

    const comparisonRows: SlideRow[] = [];
    const missing: string[] = [];

    for (const [filename, { baseline, rerun }] of targetMap.entries()) {
      if (!baseline || !rerun) {
        missing.push(filename);
        continue;
      }

      // Use eye_avg_x and eye_avg_y from calibration report
      const baseMeanX = baseline.eye_avg_x ?? 0;
      const baseMeanY = baseline.eye_avg_y ?? 0;
      const runMeanX = rerun.eye_avg_x ?? 0;
      const runMeanY = rerun.eye_avg_y ?? 0;

      const distance = Math.hypot(baseMeanX - runMeanX, baseMeanY - runMeanY);
      const pctScreenDiag = screenDiag > 0 ? (distance / screenDiag) * 100 : 0;

      comparisonRows.push({
        key: filename,
        label: filename,
        baselineCount: baseline.valid_frames_used ?? 0,
        rerunCount: rerun.valid_frames_used ?? 0,
        baselineMean: { x: baseMeanX, y: baseMeanY },
        rerunMean: { x: runMeanX, y: runMeanY },
        distance,
        baselineGST: baseline.gaze_settling_time_ms ?? null,
        rerunGST: rerun.gaze_settling_time_ms ?? null,
        baselineJitter: baseline.jitter_rms_px ?? null,
        rerunJitter: rerun.jitter_rms_px ?? null,
        pctScreenDiag,
        screenW: screen.width,
        screenH: screen.height,
        screenDiag,
      });
    }

    comparisonRows.sort((a, b) => a.label.localeCompare(b.label));

    setRows(comparisonRows);
    setMissingBaseline(missing.filter((f: string) => !rerunTargets.find((t: any) => t.filename === f)));
    setMissingRerun(missing.filter((f: string) => !baseTargets.find((t: any) => t.filename === f)));
    setLoading(false);
  }

  const selectedPatient = patientsMap[selectedPatientId];
  const hasSessions = sessions.length > 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page Header */}
      <div className="relative">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 via-blue-900 to-purple-900 bg-clip-text text-transparent">
          Results
        </h1>
        <p className="text-sm text-gray-500 mt-2">
          Compare baseline and rerun sessions to track patient progress.
        </p>
        <div className="absolute -top-2 -left-2 w-20 h-20 bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-full blur-2xl -z-10" />
      </div>

      {/* Patient Selection */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="px-5 py-3 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <h2 className="text-sm font-semibold text-gray-900">Patient Selection</h2>
        </div>
        <div className="p-5 flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[240px]">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 block">
              Patient
            </label>
            <select
              className="border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 w-full"
              value={selectedPatientId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedPatientId(id);
                setParams(id ? { patient: id } : {});
              }}
            >
              <option value="">Select patient...</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} {p.initials ? `(${p.initials})` : ""}
                </option>
              ))}
            </select>
          </div>
          {selectedPatient && (
            <>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-400 mb-1">Selected Patient</div>
                <div className="font-semibold text-gray-900">{selectedPatient.code}</div>
                {selectedPatient.initials && (
                  <div className="text-xs text-gray-500">{selectedPatient.initials}</div>
                )}
              </div>
              <ShimmerButton
                onClick={() => window.location.href = `/run?patient=${selectedPatient.id}`}
                variant="primary"
                className="ml-auto"
              >
                {hasSessions ? "Rerun Test" : "Start Baseline"}
              </ShimmerButton>
            </>
          )}
        </div>
      </div>

      {/* Session Comparison */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="px-5 py-3 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <h2 className="text-sm font-semibold text-gray-900">Session Comparison</h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            {/* Baseline Session */}
            <div>
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 block">
                Baseline Session
              </label>
              <select
                className="border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 w-full"
                value={baselineId}
                onChange={(e) => setBaselineId(e.target.value)}
                disabled={sessions.length === 0}
              >
                <option value="">
                  {sessions.length === 0 ? "No sessions yet" : "Select baseline..."}
                </option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} ({new Date(s.startedAt).toLocaleString()})
                  </option>
                ))}
              </select>
              {baselineSession && (
                <div className="text-xs text-gray-400 mt-2">
                  Started {new Date(baselineSession.startedAt).toLocaleString()}
                </div>
              )}
            </div>

            {/* Rerun Session */}
            <div>
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 block">
                Rerun Session
              </label>
              <select
                className="border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 w-full"
                value={rerunId}
                onChange={(e) => setRerunId(e.target.value)}
                disabled={!baselineId || rerunSessions.length === 0}
              >
                <option value="">
                  {rerunSessions.length === 0 ? "No reruns yet" : "Select rerun..."}
                </option>
                {rerunSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} ({new Date(s.startedAt).toLocaleString()})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <ShimmerButton
            onClick={runComparison}
            disabled={!baselineId || !rerunId || loading}
            variant="primary"
            className="w-full md:w-auto"
          >
            {loading ? "Comparing..." : "Compare Sessions"}
          </ShimmerButton>

          <div className="text-xs text-gray-400 bg-blue-50/30 rounded-lg px-4 py-3 border border-blue-100/50">
            <svg className="w-3.5 h-3.5 inline mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <strong>Gaze Settling Time (GST)</strong> measures how long (in milliseconds) from the first frame until gaze motion stays below a stability threshold for 5 consecutive steps.
            <strong className="ml-2">Jitter (px)</strong> is the RMS deviation of gaze from the mean position during calibration, indicating fixation stability.
            <strong className="ml-2">% Screen (diag)</strong> uses the window size captured when you click Compare.
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Comparison Results Table */}
      {rows.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
            <h2 className="text-sm font-semibold text-gray-900">Slide Comparison</h2>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Slide
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Baseline mean (x,y)
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Rerun mean (x,y)
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Distance
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                    title="Baseline gaze settling time (ms from first frame until gaze motion stays below threshold for 5 consecutive steps)"
                  >
                    Baseline GST (ms)
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                    title="Rerun gaze settling time (ms from first frame until gaze motion stays below threshold for 5 consecutive steps)"
                  >
                    Rerun GST (ms)
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                    title="Baseline jitter RMS (px) - root mean square deviation from mean gaze position"
                  >
                    Baseline Jitter (px)
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                    title="Rerun jitter RMS (px) - root mean square deviation from mean gaze position"
                  >
                    Rerun Jitter (px)
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                    title="% Screen (diag) = mean shift as a percent of screen diagonal"
                  >
                    % Screen (diag)
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Frames
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <tr key={row.key} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-4 py-3">{row.label}</td>
                    <td className="px-4 py-3">
                      {Math.round(row.baselineMean.x)}, {Math.round(row.baselineMean.y)}
                    </td>
                    <td className="px-4 py-3">
                      {Math.round(row.rerunMean.x)}, {Math.round(row.rerunMean.y)}
                    </td>
                    <td className="px-4 py-3">{row.distance.toFixed(1)}</td>
                    <td className="px-4 py-3">
                      {row.baselineGST !== null
                        ? row.baselineGST.toFixed(0)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {row.rerunGST !== null
                        ? row.rerunGST.toFixed(0)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {row.baselineJitter !== null
                        ? row.baselineJitter.toFixed(1)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {row.rerunJitter !== null
                        ? row.rerunJitter.toFixed(1)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">{formatPct(row.pctScreenDiag, 2)}</td>
                    <td className="px-4 py-3">
                      {row.baselineCount} / {row.rerunCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Missing Slides Warning */}
      {(missingBaseline.length > 0 || missingRerun.length > 0) && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5 space-y-3">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">Missing Slides</h3>
          {missingBaseline.length > 0 && (
            <div className="text-sm">
              <span className="font-medium text-gray-700">Baseline:</span>{" "}
              <span className="text-gray-600">{missingBaseline.join(", ")}</span>
            </div>
          )}
          {missingRerun.length > 0 && (
            <div className="text-sm">
              <span className="font-medium text-gray-700">Rerun:</span>{" "}
              <span className="text-gray-600">{missingRerun.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      {/* No Reruns Message */}
      {baselineSession && rerunSessions.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-sm text-gray-600">No reruns yet.</p>
          <p className="text-xs text-gray-400 mt-1">Run another test to compare against the baseline.</p>
        </div>
      )}
    </div>
  );
}
