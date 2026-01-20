import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { usePatientStore } from "../store/patientStore";
import type { Patient, SessionSummary } from "../types";

type TrackingFrame = {
  filename?: string;
  protocol_key?: string;
  slide_index?: number;
  gaze_x?: number | null;
  gaze_y?: number | null;
  gaze_x_raw?: number | null;
  gaze_y_raw?: number | null;
  left_center_x?: number | null;
  left_center_y?: number | null;
  right_center_x?: number | null;
  right_center_y?: number | null;
  is_blink?: boolean;
};

type CalibrationTarget = {
  filename: string;
  x: number;
  y: number;
  n_frames: number;
  valid_frames_used: number;
  eye_avg_x: number;
  eye_avg_y: number;
  left_avg_x?: number;
  left_avg_y?: number;
  right_avg_x?: number;
  right_avg_y?: number;
  valid: boolean;
  error_px?: number;
};

type SlideAccumulator = {
  key: string;
  filename: string;
  protocol: string | null;
  index: number | null;
  count: number;
  sumX: number;
  sumY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type SlideRow = {
  key: string;
  label: string;
  baselineCount: number;
  rerunCount: number;
  baselineMean: { x: number; y: number };
  rerunMean: { x: number; y: number };
  distance: number;
  diffPct: number;
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

function toFrames(payload: any): TrackingFrame[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as TrackingFrame[];
  if (Array.isArray(payload.frames)) return payload.frames as TrackingFrame[];
  return [];
}

function getGazePoint(frame: TrackingFrame) {
  // Calculate eye_avg_x and eye_avg_y exactly like calibration_report.json
  // eye_avg_x = (left_center_x + right_center_x) / 2.0
  // eye_avg_y = (left_center_y + right_center_y) / 2.0

  const leftX = typeof frame.left_center_x === "number" ? frame.left_center_x : null;
  const leftY = typeof frame.left_center_y === "number" ? frame.left_center_y : null;
  const rightX = typeof frame.right_center_x === "number" ? frame.right_center_x : null;
  const rightY = typeof frame.right_center_y === "number" ? frame.right_center_y : null;

  let x: number | null = null;
  let y: number | null = null;

  // Use binocular average if both eyes available
  if (leftX !== null && rightX !== null && leftY !== null && rightY !== null) {
    x = (leftX + rightX) / 2.0;
    y = (leftY + rightY) / 2.0;
  } else if (leftX !== null && leftY !== null) {
    // Use left eye only
    x = leftX;
    y = leftY;
  } else if (rightX !== null && rightY !== null) {
    // Use right eye only
    x = rightX;
    y = rightY;
  }

  if (x === null || y === null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function slideKey(frame: TrackingFrame) {
  if (!frame.filename) return null;
  const protocol = frame.protocol_key ?? "";
  const index = typeof frame.slide_index === "number" ? frame.slide_index : "";
  return `${protocol}::${frame.filename}::${index}`;
}

function slideLabel(acc: SlideAccumulator) {
  let label = acc.filename;
  if (acc.protocol) label = `${acc.protocol} / ${acc.filename}`;
  if (typeof acc.index === "number") label += ` (slide ${acc.index + 1})`;
  return label;
}

function collectSlides(frames: TrackingFrame[]) {
  const map = new Map<string, SlideAccumulator>();
  // Track frame counts per slide to skip first 5 frames
  const frameCountPerSlide = new Map<string, number>();

  for (const frame of frames) {
    if (!frame.filename) continue;
    const key = slideKey(frame);
    if (!key) continue;

    // Skip frames where person is blinking
    if (frame.is_blink === true) continue;

    // Track frame order for this slide
    const frameCount = (frameCountPerSlide.get(key) ?? 0) + 1;
    frameCountPerSlide.set(key, frameCount);

    // Skip first 5 frames for each slide
    if (frameCount <= 5) continue;

    const gaze = getGazePoint(frame);
    if (!gaze) continue;
    const protocol = frame.protocol_key ?? null;
    const index = typeof frame.slide_index === "number" ? frame.slide_index : null;

    let acc = map.get(key);
    if (!acc) {
      acc = {
        key,
        filename: frame.filename,
        protocol,
        index,
        count: 0,
        sumX: 0,
        sumY: 0,
        minX: gaze.x,
        maxX: gaze.x,
        minY: gaze.y,
        maxY: gaze.y,
      };
      map.set(key, acc);
    }

    acc.count += 1;
    acc.sumX += gaze.x;
    acc.sumY += gaze.y;
    acc.minX = Math.min(acc.minX, gaze.x);
    acc.maxX = Math.max(acc.maxX, gaze.x);
    acc.minY = Math.min(acc.minY, gaze.y);
    acc.maxY = Math.max(acc.maxY, gaze.y);
  }
  return map;
}

type ScreenSize = {
  width: number;
  height: number;
};

function compareSlides(
  baseline: Map<string, SlideAccumulator>,
  rerun: Map<string, SlideAccumulator>,
  screen: ScreenSize
) {
  const rows: SlideRow[] = [];
  const missingBaseline: string[] = [];
  const missingRerun: string[] = [];
  const keys = new Set([...baseline.keys(), ...rerun.keys()]);
  const screenW = Math.max(0, screen.width);
  const screenH = Math.max(0, screen.height);
  const screenDiag = Math.hypot(screenW, screenH);

  for (const key of keys) {
    const base = baseline.get(key);
    const run = rerun.get(key);
    if (!base && run) {
      missingBaseline.push(slideLabel(run));
      continue;
    }
    if (!run && base) {
      missingRerun.push(slideLabel(base));
      continue;
    }
    if (!base || !run) continue;
    if (base.count === 0 || run.count === 0) continue;

    const baseMeanX = base.sumX / base.count;
    const baseMeanY = base.sumY / base.count;
    const runMeanX = run.sumX / run.count;
    const runMeanY = run.sumY / run.count;
    const distance = Math.hypot(baseMeanX - runMeanX, baseMeanY - runMeanY);
    const minX = Math.min(base.minX, run.minX);
    const maxX = Math.max(base.maxX, run.maxX);
    const minY = Math.min(base.minY, run.minY);
    const maxY = Math.max(base.maxY, run.maxY);
    const scale = Math.hypot(maxX - minX, maxY - minY);
    const diffPct = scale > 0 ? Math.min(100, (distance / scale) * 100) : (distance === 0 ? 0 : 100);
    const pctScreenDiag = screenDiag > 0 ? (distance / screenDiag) * 100 : 0;

    rows.push({
      key,
      label: slideLabel(base),
      baselineCount: base.count,
      rerunCount: run.count,
      baselineMean: { x: baseMeanX, y: baseMeanY },
      rerunMean: { x: runMeanX, y: runMeanY },
      distance,
      diffPct,
      pctScreenDiag,
      screenW,
      screenH,
      screenDiag,
    });
  }

  rows.sort((a, b) => a.label.localeCompare(b.label));
  return { rows, missingBaseline, missingRerun };
}

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
        diffPct: 0, // Not relevant for calibration targets
        pctScreenDiag,
        screenW: screen.width,
        screenH: screen.height,
        screenDiag,
      });
    }

    comparisonRows.sort((a, b) => a.label.localeCompare(b.label));

    setRows(comparisonRows);
    setMissingBaseline(missing.filter(f => !rerunTargets.find(t => t.filename === f)));
    setMissingRerun(missing.filter(f => !baseTargets.find(t => t.filename === f)));
    setLoading(false);
  }

  const selectedPatient = patientsMap[selectedPatientId];
  const hasSessions = sessions.length > 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Results</h1>
        {selectedPatient ? (
          <span className="text-sm text-gray-600">
            Patient: <b>{selectedPatient.code}</b>
          </span>
        ) : null}
      </div>

      <div className="rounded-lg border bg-white p-3 flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600">Patient</label>
        <select
          className="px-3 py-2 border rounded-lg bg-white"
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
        {selectedPatient ? (
          <Link to={`/run?patient=${selectedPatient.id}`} className="ml-auto px-3 py-2 rounded bg-gray-900 text-white text-sm">
            {hasSessions ? "Rerun Test" : "Start Baseline"}
          </Link>
        ) : null}
      </div>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-gray-600">Baseline session</label>
          <select
            className="px-3 py-2 border rounded-lg bg-white"
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
          {baselineSession ? (
            <div className="text-xs text-gray-500">
              Started {new Date(baselineSession.startedAt).toLocaleString()}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-gray-600">Rerun session</label>
          <select
            className="px-3 py-2 border rounded-lg bg-white"
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
          <button
            className="px-3 py-2 rounded bg-gray-900 text-white text-sm disabled:opacity-60"
            onClick={runComparison}
            disabled={!baselineId || !rerunId || loading}
          >
            {loading ? "Comparing..." : "Compare"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          Difference percent uses the distance between mean gaze points, normalized by the combined gaze spread per slide.
          % Screen (diag) uses the window size captured when you click Compare.
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border bg-white overflow-hidden">
          <div className="px-3 py-2 border-b text-sm text-gray-600">Slide comparison</div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left">Slide</th>
                  <th className="px-3 py-2 text-left">Baseline mean (x,y)</th>
                  <th className="px-3 py-2 text-left">Rerun mean (x,y)</th>
                  <th className="px-3 py-2 text-left">Distance</th>
                  <th
                    className="px-3 py-2 text-left"
                    title="Difference % = mean shift divided by within-slide gaze spread (scale)"
                  >
                    Shift/Spread %
                  </th>
                  <th
                    className="px-3 py-2 text-left"
                    title="% Screen (diag) = mean shift as a percent of screen diagonal"
                  >
                    % Screen (diag)
                  </th>
                  <th className="px-3 py-2 text-left">Frames</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t">
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2">
                      {Math.round(row.baselineMean.x)}, {Math.round(row.baselineMean.y)}
                    </td>
                    <td className="px-3 py-2">
                      {Math.round(row.rerunMean.x)}, {Math.round(row.rerunMean.y)}
                    </td>
                    <td className="px-3 py-2">{row.distance.toFixed(1)}</td>
                    <td className="px-3 py-2">{row.diffPct.toFixed(1)}%</td>
                    <td className="px-3 py-2">{formatPct(row.pctScreenDiag, 2)}</td>
                    <td className="px-3 py-2">
                      {row.baselineCount} / {row.rerunCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(missingBaseline.length > 0 || missingRerun.length > 0) && (
        <div className="rounded-lg border bg-white p-4 space-y-2 text-sm">
          {missingBaseline.length > 0 && (
            <div>
              <span className="text-gray-600">Slides missing in baseline:</span>{" "}
              {missingBaseline.join(", ")}
            </div>
          )}
          {missingRerun.length > 0 && (
            <div>
              <span className="text-gray-600">Slides missing in rerun:</span>{" "}
              {missingRerun.join(", ")}
            </div>
          )}
        </div>
      )}

      {baselineSession && rerunSessions.length === 0 && (
        <div className="text-sm text-gray-600">
          No reruns yet. Run another test to compare against the baseline.
        </div>
      )}
    </div>
  );
}
