// src/pages/RunTest.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { saveJSON } from "../lib/save";
import { usePatientStore } from "../store/patientStore";
import type { Patient, SessionSummary } from "../types";
import {
  getTrackerStatus,
  startTracker,
  stopTracker,
  openTrackerOutput,
  type TrackerStatus,
  startHeadPosition,
  stopHeadPosition,
  subscribeHeadPosition,
  type HeadPositionStatus,
} from "../lib/tracker";
import { ShimmerButton } from "../components/ui/shimmer-button";
import { AnimatedBadge } from "../components/ui/animated-badge";

const PROTOCOL_DURATIONS: Record<string, number> = {
  calibration: 400,
  saccades: 400,
  sentences: 4000,
  smooth_pursuits: 400,
};
const CENTER_MS = 800;
const TARGET_MS = 1500;

type Protocol = { label: string; slides: string[] };
type ProtocolManifest = Record<string, Protocol>;

type SlideMark = { slide: number; t: number }; // ms since session start
type CalibrationTarget = { filename: string; x: number; y: number; timestamp_ms: number };
type SlideFilenameMark = {
  filename: string;
  t_ms: number;
  slide_index: number;
  protocol_key: string;
};
type SessionExport = {
  id: string;
  startedAt: string;
  endedAt?: string;
  protocolKey: string;
  protocolLabel: string;
  totalSlides: number;
  marks: SlideMark[];
  durations: number[];
  appBuild?: string;
  patientCode?: string; // anonymous only
};

function newSessionId() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `sample_video_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// Helper for IPC calls
function invokeIpc(channel: string, payload?: any) {
  if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
  if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
  return Promise.resolve({ ok: false, error: "IPC not available" });
}

export default function RunTest() {
  // --- Patients ---
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const patientIdParam = params.get("patient") ?? "";

  const patientsMap = usePatientStore((s) => s.patients);
  const addSessionSummary = usePatientStore((s) => s.addSessionSummary);
  const sessionsByPatient = usePatientStore((s) => s.sessionsByPatient);

  const patients = useMemo<Patient[]>(
    () => Object.values(patientsMap).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [patientsMap]
  );
  const patient: Patient | undefined = patientsMap[patientIdParam];
  const [pickerId, setPickerId] = useState<string>("");
  const patientSessions = useMemo<SessionSummary[]>(
    () =>
      (patientIdParam && sessionsByPatient[patientIdParam]
        ? [...sessionsByPatient[patientIdParam]]
        : []
      ).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [patientIdParam, sessionsByPatient]
  );
  const baselineSession = patientSessions[0];

  // --- Protocols ---
  const [manifest, setManifest] = useState<ProtocolManifest>({});
  const [key, setKey] = useState<string>("calibration");
  const [mode, setMode] = useState<'all' | 'single'>('single');

  // --- Slides / Session ---
  const [idx, setIdx] = useState<number>(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startedAtIso, setStartedAtIso] = useState<string | null>(null);
  const [endedAtIso, setEndedAtIso] = useState<string | null>(null);
  const [marks, setMarks] = useState<SlideMark[]>([]);
  const t0 = useRef<number>(performance.now());
  const [lastEnded, setLastEnded] = useState<SessionExport | null>(null);
  const [slidesReady, setSlidesReady] = useState<boolean>(false);

  // --- Tracker ---
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatus>("idle");
  const [trackerPid, setTrackerPid] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const slideDelayTimer = useRef<number | null>(null);
  const advanceTimer = useRef<number | null>(null);
  const calibrationTargetsRef = useRef<CalibrationTarget[]>([]);
  const calibrationCreatedAtRef = useRef<number | null>(null);
  const slideMarksRef = useRef<SlideFilenameMark[]>([]);
  const slideMarksCreatedAtRef = useRef<number | null>(null);
  const lastLoggedSlideRef = useRef<string | null>(null);
  const [headStatus, setHeadStatus] = useState<HeadPositionStatus>("NOT_DETECTED");
  const [headInstruction, setHeadInstruction] = useState<string>("Face not detected");
  const [headProgress, setHeadProgress] = useState<number>(0);
  const [headCheckActive, setHeadCheckActive] = useState<boolean>(false);

  const clearSlideDelay = useCallback(() => {
    if (slideDelayTimer.current !== null) {
      window.clearTimeout(slideDelayTimer.current);
      slideDelayTimer.current = null;
    }
  }, []);

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }, []);

  // load protocols
  useEffect(() => {
    fetch("/protocols.json")
      .then((r) => r.json())
      .then((data) => {
        setManifest(data);
        // Default to first protocol if available
        const keys = Object.keys(data);
        if (data.calibration) {
          setKey("calibration");
        } else if (keys.length > 0) {
          setKey(keys[0]);
        }
      })
      .catch((e) => {
        console.error("Failed to load protocols.json", e);
        setError("Failed to load protocols.json");
      });
  }, []);

  // initial tracker status
  useEffect(() => {
    getTrackerStatus()
      .then((s) => {
        setTrackerStatus(s.status);
        setTrackerPid(s.pid);
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeHeadPosition((payload) => {
      console.log("[head] update received:", payload.status, payload.instruction);
      setHeadStatus(payload.status);
      setHeadInstruction(payload.instruction ?? "");
      setHeadProgress(payload.progress ?? 0);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Removed automatic head position startup - now manual via button

  // Cleanup: stop head position on unmount
  useEffect(() => {
    return () => {
      console.log("[head] stop requested (cleanup)");
      stopHeadPosition().catch(() => { });
      setHeadCheckActive(false);
    };
  }, []);

  const slides = useMemo(() => manifest[key]?.slides ?? [], [manifest, key]);
  const current = slides[idx];

  const running = !!sessionId && !endedAtIso;
  const ended = !!endedAtIso;
  const slidesActive = running && trackerStatus === "running";
  const shouldAutoAdvance = slidesActive && slidesReady;

  const getFilename = useCallback((src: string) => src.split("/").pop() ?? src, []);

  const getSlideDurationMs = useCallback(
    (slideSrc?: string) => {
      const fallback = PROTOCOL_DURATIONS[key] ?? 400;
      if (!slideSrc) return fallback;
      if (key !== "calibration") return fallback;
      const filename = getFilename(slideSrc);
      return filename === "center.png" ? CENTER_MS : TARGET_MS;
    },
    [key, getFilename]
  );

  const next = useCallback(() => {
    setIdx((i) => {
      const ni = Math.min(i + 1, slides.length - 1);
      if (running && ni !== i) {
        setMarks((prev) => [...prev, { slide: ni, t: performance.now() - t0.current }]);
      }
      return ni;
    });
  }, [running, slides.length]);
  const prev = useCallback(() => {
    setIdx((i) => {
      const ni = Math.max(i - 1, 0);
      if (running && ni !== i) {
        setMarks((prev) => [...prev, { slide: ni, t: performance.now() - t0.current }]);
      }
      return ni;
    });
  }, [running]);

  // keyboard nav — attach once
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  // reset when protocol changes (if not running)
  useEffect(() => {
    if (running) return;
    setIdx(0);
    setMarks([]);
    t0.current = performance.now();
  }, [key, running]);

  const enterFullscreen = useCallback(async () => {
    const el = stageRef.current;
    if (!el) return;
    const anyEl = el as any;
    const req =
      anyEl.requestFullscreen ||
      anyEl.webkitRequestFullscreen ||
      anyEl.mozRequestFullScreen ||
      anyEl.msRequestFullscreen;
    if (req) {
      try {
        await req.call(anyEl);
      } catch {
        // ignore errors entering fullscreen
      }
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    const doc: any = document;
    if (
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement
    ) {
      const exit =
        doc.exitFullscreen ||
        doc.webkitExitFullscreen ||
        doc.mozCancelFullScreen ||
        doc.msExitFullscreen;
      if (exit) {
        try {
          await exit.call(doc);
        } catch {
          // ignore errors exiting fullscreen
        }
      }
    }
  }, []);

  const writeSessionJson = useCallback(async (filePath: string, data: unknown) => {
    if (window.nativeApi?.invoke) {
      return window.nativeApi.invoke("session:write-json", { filePath, data });
    }
    if (window.ipcRenderer?.invoke) {
      return window.ipcRenderer.invoke("session:write-json", { filePath, data });
    }
    return { ok: false, error: "IPC not available" };
  }, []);

  useEffect(() => {
    if (!running) {
      exitFullscreen();
      clearSlideDelay();
      clearAdvanceTimer();
      setSlidesReady(false);
    }
  }, [running, exitFullscreen, clearSlideDelay, clearAdvanceTimer]);

  useEffect(() => {
    return () => {
      exitFullscreen();
      clearSlideDelay();
      clearAdvanceTimer();
    };
  }, [exitFullscreen, clearSlideDelay, clearAdvanceTimer]);

  useEffect(() => {
    if (!shouldAutoAdvance || slides.length === 0) {
      clearAdvanceTimer();
      return;
    }
    if (!current) return;

    clearAdvanceTimer();

    if (idx === 0) {
      console.log("[RunTest] active protocol", key);
      console.log("[RunTest] slide order", slides);
    }

    const duration = getSlideDurationMs(current);
    console.log("[RunTest] slide dwell (ms)", duration, "slide", current);

    if (idx >= slides.length - 1) return;

    advanceTimer.current = window.setTimeout(() => {
      setIdx((i) => {
        const nextIdx = Math.min(i + 1, slides.length - 1);
        if (running && nextIdx !== i) {
          setMarks((prev) => [...prev, { slide: nextIdx, t: performance.now() - t0.current }]);
        }
        return nextIdx;
      });
    }, duration);

    return () => {
      clearAdvanceTimer();
    };
  }, [
    shouldAutoAdvance,
    slides.length,
    current,
    idx,
    key,
    running,
    slides,
    getSlideDurationMs,
    clearAdvanceTimer,
  ]);

  useEffect(() => {
    if (!current) return;
    if (!running || !sessionId) return;
    if (lastLoggedSlideRef.current === current) return;
    lastLoggedSlideRef.current = current;

    const filename = getFilename(current);
    const nowMs = Math.max(0, Math.round(performance.now() - t0.current));
    if (!slideMarksCreatedAtRef.current) {
      slideMarksCreatedAtRef.current = Date.now();
    }

    slideMarksRef.current.push({
      filename,
      t_ms: nowMs,
      slide_index: idx,
      protocol_key: key,
    });

    const slidePayload = {
      session_id: sessionId,
      created_at_ms: slideMarksCreatedAtRef.current,
      marks: slideMarksRef.current,
    };
    void writeSessionJson(`recordings/${sessionId}/slide_marks.json`, slidePayload);

    if (key !== "calibration") return;
    if (filename === "center.png") return;

    const match = /^(\d+)-(\d+)\.png$/.exec(filename);
    if (!match) return;

    const entry: CalibrationTarget = {
      filename,
      x: Number.parseInt(match[1], 10),
      y: Number.parseInt(match[2], 10),
      timestamp_ms: Date.now(),
    };

    calibrationTargetsRef.current.push(entry);
    if (!calibrationCreatedAtRef.current) {
      calibrationCreatedAtRef.current = Date.now();
    }

    const payload = {
      session_id: sessionId,
      created_at_ms: calibrationCreatedAtRef.current,
      targets: calibrationTargetsRef.current,
    };
    void writeSessionJson(`recordings/${sessionId}/calibration_targets.json`, payload);
  }, [current, running, sessionId, key, getFilename, writeSessionJson, idx]);

  // Handle protocol switching / auto-stop
  useEffect(() => {
    if (!shouldAutoAdvance) return;
    if (idx >= slides.length - 1) {
      // We are at the last slide.
      // Wait for the duration of the last slide then move to next protocol or stop.
      const duration = getSlideDurationMs(current);
      const timer = setTimeout(() => {
        if (mode === 'single') {
          // Single mode: stop after this protocol
          endSession();
        } else {
          // All mode: try to go to next protocol
          const keys = Object.keys(manifest);
          const currentKeyIdx = keys.indexOf(key);
          if (currentKeyIdx < keys.length - 1) {
            // Move to next protocol
            const nextKey = keys[currentKeyIdx + 1];
            setKey(nextKey);
            setIdx(0); // Reset index for the new protocol
          } else {
            // All protocols done
            endSession();
          }
        }
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [idx, slides.length, shouldAutoAdvance, key, manifest, mode, current, getSlideDurationMs]);

  // Redirect after session ends
  useEffect(() => {
    if (lastEnded && !running && !sessionId) {
      navigate(`/results`);
    }
  }, [lastEnded, running, sessionId, navigate]);

  async function startHeadCheck() {
    if (headCheckActive || busy) return;
    console.log("[head] start requested");
    setHeadCheckActive(true);
    setError(null);
    try {
      const res = await startHeadPosition({ fps: 20 });
      if (!res.ok) {
        setError(`Head check failed: ${res.message}`);
        setHeadCheckActive(false);
      }
    } catch (err) {
      setError("Head check failed to start");
      setHeadCheckActive(false);
    }
  }

  async function stopHeadCheck() {
    if (!headCheckActive) return;
    console.log("[head] stop requested (manual)");
    await stopHeadPosition().catch(() => { });
    setHeadCheckActive(false);
    setHeadStatus("NOT_DETECTED");
    setHeadInstruction("Face not detected");
    setHeadProgress(0);
  }

  async function startSession() {

    if (!patient || busy || headStatus !== "READY") {
      if (headStatus !== "READY") {
        setError("Align your head to continue.");
      }
      return;
    }
    setBusy(true);
    setError(null);
    clearSlideDelay();
    clearAdvanceTimer();
    setSlidesReady(false);

    // If mode is ALL, ensure we start from the first protocol
    if (mode === 'all') {
      const keys = Object.keys(manifest);
      if (keys.length > 0 && key !== keys[0]) {
        setKey(keys[0]);
        // We need to wait for key to update? 
        // Actually, setKey is async-ish but we are inside startSession.
        // The effect [key] resets idx/marks.
        // But we are about to setSessionId which makes running=true.
        // If we change key here, the effect `reset when protocol changes` might fire?
        // "if (running) return" in that effect prevents reset if running.
        // So we should setKey first, then start?
        // But we can't await state update.
        // Ideally we setKey, and let the user click start again? 
        // Or we assume the user selected "ALL" which sets key to first one immediately.
        // In the onChange handler we setKey to first one. So key should be correct already.
      }
    }

    const sid = newSessionId();
    calibrationTargetsRef.current = [];
    calibrationCreatedAtRef.current = Date.now();
    slideMarksRef.current = [];
    slideMarksCreatedAtRef.current = Date.now();
    lastLoggedSlideRef.current = null;
    // const outDir = `recordings/${sid}`; // Unused variable removed
    // Relative to app root, or absolute?
    // IPC `tracking:start` uses `process.env.APP_ROOT` to resolve script, but for `outDir`?
    // The prompt says "All recordings should be saved in this structure: recordings/sample_video_..."
    // So we should pass the full path or relative path.
    // Let's pass a relative path and let the backend handle it or pass absolute.
    // Backend `tracking:start` logic I added: `args.push("--output-dir", opts.outDir);`
    // Python script likely expects a path.
    // Let's use an absolute path to be safe, but I don't have `APP_ROOT` here.
    // I can pass `recordings/${sid}` and let the backend resolve it?
    // Or I can just pass the folder name and let the backend join it with `recordings`?
    // The prompt says "Update tracking:start handler: Accept and pass outDir parameter".
    // It doesn't say the backend resolves it relative to `recordings`.
    // So I should probably pass the full path or relative to CWD.
    // If I pass `recordings/${sid}`, and CWD is APP_ROOT, it should work.

    console.log("[head] stop requested (session starting)");
    await stopHeadPosition().catch(() => { });
    setHeadCheckActive(false);
    const res = await startTracker({ preview: false, outDir: `recordings/${sid}` }).catch(() => ({ ok: false, message: "IPC error" }));
    if (!res.ok) {
      setError(`Could not start tracker: ${res.message}`);
      setBusy(false);
      await startHeadPosition({ fps: 20 }).catch(() => { });
      return;
    }

    const readStatus = async () =>
      getTrackerStatus().catch(() => ({ status: "error" as TrackerStatus, pid: undefined }));

    let trackerInfo = await readStatus();
    if (trackerInfo.status !== "running") {
      const timeoutMs = 5000;
      const intervalMs = 200;
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        trackerInfo = await readStatus();
        if (trackerInfo.status === "running") break;
      }
    }

    setTrackerStatus(trackerInfo.status);
    setTrackerPid(trackerInfo.pid);
    if (trackerInfo.status !== "running") {
      setError("Tracker failed to start (camera not ready).");
      setBusy(false);
      await startHeadPosition({ fps: 20 }).catch(() => { });
      return;
    }

    setLastEnded(null);
    setEndedAtIso(null);
    setSessionId(sid); // Use the pre-generated ID
    setStartedAtIso(new Date().toISOString());
    t0.current = performance.now();
    setMarks([{ slide: 0, t: 0 }]);
    setIdx(0);
    void enterFullscreen();
    slideDelayTimer.current = window.setTimeout(() => {
      setSlidesReady(true);
    }, 2000);

    setBusy(false);
  }

  async function endSession() {
    if (!sessionId || !startedAtIso || ended || busy) return;
    setBusy(true);
    clearSlideDelay();
    clearAdvanceTimer();
    setSlidesReady(false);

    const stopRes = await stopTracker().catch(() => ({ ok: false, message: "IPC error" }));
    if (!stopRes.ok) setError(`Tracker stop: ${stopRes.message}`);

    const s = await getTrackerStatus().catch(() => ({ status: "error" as TrackerStatus, pid: undefined }));
    setTrackerStatus(s.status);
    setTrackerPid(s.pid);

    const endedIso = new Date().toISOString();
    setEndedAtIso(endedIso);

    const label = manifest[key]?.label ?? key;

    const durs: number[] = [];
    for (let i = 0; i < marks.length; i++) {
      const tStart = marks[i].t;
      const tEnd = i < marks.length - 1 ? marks[i + 1].t : performance.now() - t0.current;
      durs.push(Math.max(0, Math.round(tEnd - tStart)));
    }

    const exportObj: SessionExport = {
      id: sessionId,
      startedAt: startedAtIso,
      endedAt: endedIso,
      protocolKey: key,
      protocolLabel: label,
      totalSlides: slides.length,
      marks: [...marks],
      durations: durs,
      patientCode: patient?.code,
      appBuild: "0.1.0-desktop",
    };
    setLastEnded(exportObj);

    if (patient) {
      const summary: SessionSummary = {
        id: sessionId,
        patientId: patient.id,
        protocolKey: key,
        startedAt: startedAtIso,
        endedAt: endedIso,
      };
      addSessionSummary(summary);
    }

    // Auto-run calibration if we have targets
    if (calibrationTargetsRef.current.length > 0) {
      console.log('[calibration] auto-running calibration fit...');
      const calRes = await invokeIpc('calibration:run', { sessionId }).catch((err) => {
        console.error('[calibration] auto-run failed:', err);
        return { ok: false, error: String(err) };
      });

      if (calRes.ok) {
        console.log('[calibration] auto-run complete');
      } else {
        console.warn('[calibration] auto-run error:', calRes.error);
      }
    }

    setBusy(false);
  }

  function exportJSON() {
    if (!lastEnded) return;
    const code = lastEnded.patientCode ? `${lastEnded.patientCode}_` : "";
    const filename = `${code}${lastEnded.id}_${lastEnded.protocolKey}.json`;
    saveJSON(filename, lastEnded);
  }

  function clearSession() {
    setSessionId(null);
    setStartedAtIso(null);
    setEndedAtIso(null);
    setMarks([]);
    setIdx(0);
    setLastEnded(null);
    clearSlideDelay();
    clearAdvanceTimer();
    setSlidesReady(false);
    calibrationTargetsRef.current = [];
    calibrationCreatedAtRef.current = null;
    slideMarksRef.current = [];
    slideMarksCreatedAtRef.current = null;
    lastLoggedSlideRef.current = null;
  }

  function attachPickedPatient() {
    if (!pickerId) return;
    setParams({ patient: pickerId });
  }

  const trackerBadgeVariant =
    trackerStatus === "running"
      ? "success"
      : trackerStatus === "error"
        ? "error"
        : trackerStatus === "stopped"
          ? "warning"
          : "default";

  const headBadgeVariant =
    headStatus === "READY"
      ? "success"
      : headStatus === "STABILIZING"
        ? "warning"
        : headStatus === "ALIGNING"
          ? "info"
          : "error";

  const stageClassName = running
    ? "fixed inset-0 bg-black flex items-center justify-center z-50"
    : "w-full h-[480px] bg-gray-950 flex items-center justify-center rounded-b-xl";

  const slideImageClassName = running
    ? "w-screen h-screen object-contain select-none"
    : "max-h-[460px] max-w-full object-contain select-none";

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="relative">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 via-blue-900 to-purple-900 bg-clip-text text-transparent">
            Run Test
          </h1>
          <p className="text-sm text-gray-500 mt-1">Configure and run eye-tracking test sessions.</p>
          <div className="absolute -top-2 -left-2 w-20 h-20 bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-full blur-2xl -z-10" />
        </div>
        <div className="flex items-center gap-2">
          <AnimatedBadge variant={trackerBadgeVariant} pulse={trackerStatus === "running"}>
            Tracker: {trackerStatus}
            {typeof trackerPid === "number" ? ` (${trackerPid})` : ""}
          </AnimatedBadge>
          <AnimatedBadge variant={headBadgeVariant} pulse={headStatus === "READY"}>
            Head: {headStatus}
          </AnimatedBadge>
          {busy && <span className="text-xs text-gray-400 animate-pulse">Working...</span>}
        </div>
      </div>

      {/* Head positioning */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[200px]">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Head Position</div>
          <div className="text-sm text-gray-700">{headInstruction || "Click 'Start Head Check' to begin"}</div>
        </div>
        <div className="flex items-center gap-3">
          {headCheckActive && (
            <>
              <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-2 bg-gray-900 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(headProgress * 100)}%` }}
                />
              </div>
              <span className="text-xs font-medium text-gray-500 tabular-nums w-8">{Math.round(headProgress * 100)}%</span>
            </>
          )}
          {!running && (
            <ShimmerButton
              onClick={headCheckActive ? stopHeadCheck : startHeadCheck}
              disabled={busy}
              variant="primary"
            >
              {headCheckActive ? "Stop Check" : "Start Head Check"}
            </ShimmerButton>
          )}
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-100 px-4 py-3 rounded-xl">
          {error}
        </div>
      )}

      {/* Patient + Protocol controls in a grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Patient card */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Patient</div>
          {patient ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-900">
                  {patient.code}
                  {patient.initials ? <span className="text-gray-400 ml-1.5 font-normal">({patient.initials})</span> : null}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  Baseline: {baselineSession ? new Date(baselineSession.startedAt).toLocaleString() : "not recorded"}
                  {patientSessions.length > 1 ? ` | Reruns: ${patientSessions.length - 1}` : ""}
                </div>
              </div>
              <Link to="/patients" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Change
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                value={pickerId}
                onChange={(e) => setPickerId(e.target.value)}
              >
                <option value="">Select patient...</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} {p.initials ? `(${p.initials})` : ""}
                  </option>
                ))}
              </select>
              <button
                className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                onClick={attachPickedPatient}
                disabled={!pickerId}
              >
                Use
              </button>
              <Link to="/patients" className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                New
              </Link>
            </div>
          )}
        </div>

        {/* Protocol card */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Protocol</div>
          <div className="flex items-center gap-3">
            <select
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
              value={mode === 'all' ? 'ALL' : key}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'ALL') {
                  setMode('all');
                  const keys = Object.keys(manifest);
                  if (keys.length > 0) setKey(keys[0]);
                } else {
                  setMode('single');
                  setKey(val);
                }
              }}
              disabled={running || busy}
            >
              <option value="ALL">Run All Tests</option>
              {Object.entries(manifest).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label} ({v.slides.length})
                </option>
              ))}
            </select>

            {!sessionId ? (
              <ShimmerButton
                onClick={startSession}
                disabled={!patient || slides.length === 0 || busy || headStatus !== "READY"}
                variant="primary"
                className="whitespace-nowrap"
                title={
                  !patient
                    ? "Pick a patient first"
                    : headStatus !== "READY"
                      ? "Align your head before starting"
                      : ""
                }
              >
                {patient ? (baselineSession ? "Rerun Test" : "Start Baseline") : "Start Session"}
              </ShimmerButton>
            ) : running ? (
              <ShimmerButton
                onClick={endSession}
                disabled={busy}
                variant="danger"
              >
                End Session
              </ShimmerButton>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  onClick={exportJSON}
                  disabled={!lastEnded || busy}
                >
                  Export
                </button>
                <button
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  onClick={clearSession}
                  disabled={busy}
                >
                  Clear
                </button>
                <button
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  onClick={() => openTrackerOutput()}
                >
                  Open Folder
                </button>
              </div>
            )}
          </div>
          {sessionId && (
            <div className="text-xs text-gray-400 mt-2">
              Session: <span className="font-medium text-gray-600">{sessionId}</span>
            </div>
          )}
        </div>
      </div>

      {/* Stage */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
        <div className={running ? "hidden" : "px-4 py-2.5 border-b border-gray-100 flex items-center justify-between"}>
          <span className="text-sm font-medium text-gray-700">
            {manifest[key]?.label ?? "—"} — Slide {slides.length ? idx + 1 : "—"} of {slides.length || "—"}
          </span>
          <div className="flex items-center gap-2">
            <button
              className="px-2.5 py-1 rounded-md border border-gray-200 text-xs font-medium text-gray-500 hover:bg-gray-50 transition-colors disabled:opacity-40"
              onClick={prev}
              disabled={idx <= 0}
            >
              Prev
            </button>
            <button
              className="px-2.5 py-1 rounded-md border border-gray-200 text-xs font-medium text-gray-500 hover:bg-gray-50 transition-colors disabled:opacity-40"
              onClick={next}
              disabled={idx >= slides.length - 1}
            >
              Next
            </button>
          </div>
        </div>
        <div ref={stageRef} className={stageClassName}>
          {current ? (
            <img
              src={current}
              alt="Protocol slide"
              className={slideImageClassName}
              draggable={false}
            />
          ) : (
            <div className="text-white/50 text-sm">No slides found.</div>
          )}
        </div>
      </div>

      {/* Session info */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Session Info</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Started</div>
            <div className="font-medium text-gray-700">{startedAtIso ? new Date(startedAtIso).toLocaleTimeString() : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Ended</div>
            <div className="font-medium text-gray-700">{endedAtIso ? new Date(endedAtIso).toLocaleTimeString() : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Slide Changes</div>
            <div className="font-medium text-gray-700">{marks.length}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Timing</div>
            <div className="text-xs text-gray-500">Center 800ms, target 1500ms</div>
          </div>
        </div>
      </div>
    </div>
  );
}
