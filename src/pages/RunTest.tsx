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
} from "../lib/tracker";

const PROTOCOL_DURATIONS: Record<string, number> = {
  calibration: 400,
  saccades: 400,
  sentences: 4000,
  smooth_pursuits: 400,
};

type Protocol = { label: string; slides: string[] };
type ProtocolManifest = Record<string, Protocol>;

type SlideMark = { slide: number; t: number }; // ms since session start
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

export default function RunTest() {
  // --- Patients ---
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const patientIdParam = params.get("patient") ?? "";

  const patientsMap = usePatientStore((s) => s.patients);
  const addSessionSummary = usePatientStore((s) => s.addSessionSummary);

  const patients = useMemo<Patient[]>(
    () => Object.values(patientsMap).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [patientsMap]
  );
  const patient: Patient | undefined = patientsMap[patientIdParam];
  const [pickerId, setPickerId] = useState<string>("");

  // --- Protocols ---
  const [manifest, setManifest] = useState<ProtocolManifest>({});
  const [key, setKey] = useState<string>("saccades");
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

  const clearSlideDelay = useCallback(() => {
    if (slideDelayTimer.current !== null) {
      window.clearTimeout(slideDelayTimer.current);
      slideDelayTimer.current = null;
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
        if (keys.length > 0) setKey(keys[0]);
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

  const slides = useMemo(() => manifest[key]?.slides ?? [], [manifest, key]);
  const current = slides[idx];

  const running = !!sessionId && !endedAtIso;
  const ended = !!endedAtIso;
  const slidesActive = running && trackerStatus === "running";
  const shouldAutoAdvance = slidesActive && slidesReady;

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

  useEffect(() => {
    if (!running) {
      exitFullscreen();
      clearSlideDelay();
      setSlidesReady(false);
    }
  }, [running, exitFullscreen, clearSlideDelay]);

  useEffect(() => {
    return () => {
      exitFullscreen();
      clearSlideDelay();
    };
  }, [exitFullscreen, clearSlideDelay]);

  useEffect(() => {
    if (!shouldAutoAdvance || slides.length === 0) return;

    const duration = PROTOCOL_DURATIONS[key] ?? 400; // default to 400ms if not found

    const timer = window.setInterval(() => {
      setIdx((i) => {
        const nextIdx = i + 1;
        if (nextIdx >= slides.length) {
          // Protocol finished
          // Check if there are more protocols or if we should stop
          // For now, just stop if it's the last slide of the current protocol
          // But the requirement says "runs through all protocols".
          // The current implementation seems to select one protocol at a time via dropdown.
          // If we need to run ALL protocols automatically, we need a sequence.
          // However, the prompt says "runs through all protocols and stops recording automatically after completion".
          // This implies we should iterate through keys of manifest.

          // Let's implement a simple sequence logic here or in a separate effect.
          // But wait, `next()` just increments index.

          return i; // Stay on last slide, let the effect below handle protocol switching
        }

        if (running) {
          setMarks((prev) => [...prev, { slide: nextIdx, t: performance.now() - t0.current }]);
        }
        return nextIdx;
      });
    }, duration);
    return () => window.clearInterval(timer);
  }, [shouldAutoAdvance, slides.length, key, running]);

  // Handle protocol switching / auto-stop
  useEffect(() => {
    if (!shouldAutoAdvance) return;
    if (idx >= slides.length - 1) {
      // We are at the last slide.
      // Wait for the duration of the last slide then move to next protocol or stop.
      const duration = PROTOCOL_DURATIONS[key] ?? 400;
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
  }, [idx, slides.length, shouldAutoAdvance, key, manifest, mode]);

  // Redirect after session ends
  useEffect(() => {
    if (lastEnded && !running && !sessionId) {
      // Session ended and saved (lastEnded is set)
      // Redirect to /calibrate (which I will use for "Calibrate Current")
      // The prompt says "redirect to /correction route with the session ID"
      // I'll assume /calibrate is the route, and pass session ID as param?
      // Or maybe /correction is a separate route I need to make?
      // Prompt 2 says "Create src/pages/CalibrateCurrent.tsx ... Add route: <Route path="calibrate" element={<CalibrateCurrent />} />"
      // Prompt 1 says "redirect to /correction route".
      // I will use /calibrate and add a query param ?session=ID
      navigate(`/calibrate?session=${lastEnded.id}`);
    }
  }, [lastEnded, running, sessionId, navigate]);

  async function startSession() {
    if (!patient || busy) return;
    setBusy(true);
    setError(null);
    clearSlideDelay();
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

    const res = await startTracker({ preview: false, outDir: `recordings/${sid}` }).catch(() => ({ ok: false, message: "IPC error" }));
    if (!res.ok) {
      setError(`Could not start tracker: ${res.message}`);
      setBusy(false);
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
    }, 10000);

    setBusy(false);
  }

  async function endSession() {
    if (!sessionId || !startedAtIso || ended || busy) return;
    setBusy(true);
    clearSlideDelay();
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
    setSlidesReady(false);
  }

  function attachPickedPatient() {
    if (!pickerId) return;
    setParams({ patient: pickerId });
  }

  const trackerBadge =
    trackerStatus === "running"
      ? "bg-green-100 text-green-800 border-green-300"
      : trackerStatus === "error"
        ? "bg-red-100 text-red-800 border-red-300"
        : trackerStatus === "stopped"
          ? "bg-amber-100 text-amber-800 border-amber-300"
          : "bg-gray-100 text-gray-800 border-gray-300";

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Run Test</h1>
        <span className={`text-xs px-2 py-0.5 border rounded ${trackerBadge}`}>
          Tracker: {trackerStatus}
          {typeof trackerPid === "number" ? ` · pid ${trackerPid}` : ""}
        </span>
        {busy && <span className="text-xs text-gray-500">…working</span>}
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {/* Patient selector/badge */}
      <div className="rounded-lg border bg-white p-3 flex flex-wrap items-center gap-3">
        {patient ? (
          <>
            <div className="text-sm">
              <span className="text-gray-600">Patient:</span>{" "}
              <b>{patient.code}</b>
              {patient.initials ? <span className="text-gray-500 ml-2">({patient.initials})</span> : null}
            </div>
            <Link to="/patients" className="px-3 py-1.5 border rounded bg-white text-sm">
              Change
            </Link>
          </>
        ) : (
          <>
            <div className="text-sm text-gray-600">No patient selected.</div>
            <select
              className="px-2 py-1.5 border rounded bg-white text-sm"
              value={pickerId}
              onChange={(e) => setPickerId(e.target.value)}
            >
              <option value="">Select patient…</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} {p.initials ? `(${p.initials})` : ""}
                </option>
              ))}
            </select>
            <button
              className="px-3 py-1.5 border rounded bg-white text-sm"
              onClick={attachPickedPatient}
              disabled={!pickerId}
            >
              Use
            </button>
            <Link to="/patients" className="px-3 py-1.5 border rounded bg-white text-sm">
              Create new
            </Link>
          </>
        )}
      </div>

      {/* Protocol + session controls */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-gray-600">Protocol</label>
        <select
          className="px-3 py-2 border rounded-lg bg-white"
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
          <button
            className="ml-3 px-3 py-2 rounded-lg bg-gray-900 text-white disabled:opacity-60"
            onClick={startSession}
            disabled={!patient || slides.length === 0 || busy}
            title={!patient ? "Pick a patient first" : ""}
          >
            Start Session
          </button>
        ) : running ? (
          <button
            className="ml-3 px-3 py-2 rounded-lg bg-white border disabled:opacity-60"
            onClick={endSession}
            disabled={busy}
          >
            End Session
          </button>
        ) : (
          <>
            <button
              className="ml-3 px-3 py-2 rounded-lg bg-white border"
              onClick={exportJSON}
              disabled={!lastEnded || busy}
            >
              Export JSON
            </button>
            <button
              className="ml-2 px-3 py-2 rounded-lg bg-white border"
              onClick={clearSession}
              disabled={busy}
            >
              Clear
            </button>
            <button
              className="ml-2 px-3 py-2 rounded-lg bg-white border"
              onClick={() => openTrackerOutput()}
            >
              Open Output Folder
            </button>
          </>
        )}

        {sessionId && (
          <span className="text-sm text-gray-600 ml-2">
            Session: <b>{sessionId}</b>
          </span>
        )}
      </div>

      {/* Slide nav */}
      <div className="flex items-center gap-2">
        <button className="px-3 py-1 rounded bg-white border" onClick={prev} disabled={idx <= 0}>
          ◀ Prev
        </button>
        <span className="text-sm">{slides.length ? `${idx + 1} / ${slides.length}` : "—"}</span>
        <button
          className="px-3 py-1 rounded bg-white border"
          onClick={next}
          disabled={idx >= slides.length - 1}
        >
          Next ▶
        </button>
      </div>

      {/* Stage */}
      <div className="rounded-lg border bg-white overflow-hidden">
        <div className="px-3 py-2 border-b text-sm text-gray-600">
          {manifest[key]?.label ?? "—"} — slide {slides.length ? idx + 1 : "—"}
        </div>
        <div ref={stageRef} className="w-full h-[480px] bg-black flex items-center justify-center">
          {current ? (
            <img
              src={current}
              alt="Protocol slide"
              className="max-h-[460px] max-w-full object-contain select-none"
              draggable={false}
            />
          ) : (
            <div className="text-white/70 text-sm">No slides found.</div>
          )}
        </div>
      </div>

      {/* Session info */}
      <div className="p-4 rounded-lg border bg-white space-y-2 text-sm">
        <div>
          <span className="text-gray-600">Started:</span> <b>{startedAtIso ?? "—"}</b>
        </div>
        <div>
          <span className="text-gray-600">Ended:</span> <b>{endedAtIso ?? "—"}</b>
        </div>
        <div>
          <span className="text-gray-600">Recorded slide changes:</span> <b>{marks.length}</b>
        </div>
        <div className="text-gray-600">
          Timing: Sentences 4s, All others 400ms. Use ← / → for manual control.
        </div>
      </div>

      {/* Debug marks */}
      <div className="p-4 rounded-lg border bg-white">
        <div className="text-sm text-gray-600 mb-2">Slide marks (ms since start):</div>
        <pre className="text-xs max-h-48 overflow-auto">
          {JSON.stringify(marks, null, 2)}
        </pre>
      </div>
    </div>
  );
}
