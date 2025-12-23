// src/pages/RunTest.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  const iso = new Date().toISOString();
  const stamp = iso.replace(/[:.]/g, "").replace(/-/g, "").replace("T", "_");
  return `sess-${stamp}`;
}

export default function RunTest() {
  // --- Patients ---
  const [params, setParams] = useSearchParams();
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
      .then((data) => setManifest(data))
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
    const timer = window.setInterval(() => {
      next();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [shouldAutoAdvance, slides.length, next]);

  async function startSession() {
    if (!patient || busy) return;
    setBusy(true);
    setError(null);
    clearSlideDelay();
    setSlidesReady(false);

    const res = await startTracker({ preview: false }).catch(() => ({ ok: false, message: "IPC error" }));
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
    setSessionId(newSessionId());
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
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={running || busy}
        >
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
          Tip: Use ← / → or buttons to change slides. Timing is recorded only while the session is running.
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
