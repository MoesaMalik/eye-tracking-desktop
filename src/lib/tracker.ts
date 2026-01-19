// src/lib/tracker.ts (extending existing file)
export type TrackerStatus = "idle" | "running" | "stopped" | "error";

export type TrackerStartOptions = {
  cam?: number;
  outDir?: string;
  script?: string;
  preview?: boolean;
};

export type HeadPositionStatus = "NOT_DETECTED" | "ALIGNING" | "STABILIZING" | "READY";

export type HeadPositionUpdate = {
  type: "head_position";
  ts: number;
  status: HeadPositionStatus;
  instruction: string;
  progress: number;
  metrics: {
    center: [number, number] | null;
    size: number | null;
    yaw: number | null;
    pitch: number | null;
  };
};

export type HeadPositionStartOptions = {
  cam?: number;
  fps?: number;
  script?: string;
  jsonl?: boolean;
};

// NEW: Live gaze data type
export type GazeUpdate = {
  type: "gaze";
  timestamp: number;
  gaze_x: number | null;
  gaze_y: number | null;
  confidence: number;
};

export async function startTracker(
  opts: TrackerStartOptions = {}
): Promise<{ ok: boolean; message: string }> {
  if (window.tracker?.start) return window.tracker.start(opts);
  if (window.nativeApi?.invoke) return window.nativeApi.invoke("tracking:start", opts);
  return { ok: false, message: "IPC not available" };
}

export async function stopTracker(): Promise<{ ok: boolean; message: string }> {
  if (window.tracker?.stop) return window.tracker.stop();
  if (window.nativeApi?.invoke) return window.nativeApi.invoke("tracking:stop");
  return { ok: false, message: "IPC not available" };
}

export async function getTrackerStatus(): Promise<{ status: TrackerStatus; pid?: number }> {
  if (window.nativeApi?.invoke) {
    return window.nativeApi.invoke("tracking:status") as Promise<{ status: TrackerStatus; pid?: number }>;
  }
  return { status: "idle" };
}

export function subscribeTrackerLogs(listener: (line: string) => void): () => void {
  if (window.tracker?.onStdout) return window.tracker.onStdout(listener);
  return () => { };
}
export function subscribeTrackerErrors(listener: (line: string) => void): () => void {
  if (window.tracker?.onStderr) return window.tracker.onStderr(listener);
  return () => { };
}
export function subscribeTrackerExit(listener: (code: number) => void): () => void {
  if (window.tracker?.onExit) return window.tracker.onExit(listener);
  return () => { };
}

export async function openTrackerOutput(): Promise<{ ok: boolean; path: string }> {
  if (window.tracker?.openOutput) return window.tracker.openOutput();
  return { ok: false, path: "" };
}

export async function startHeadPosition(
  opts: HeadPositionStartOptions = {}
): Promise<{ ok: boolean; message: string }> {
  if (window.startHeadPosition) return window.startHeadPosition(opts);
  if (window.nativeApi?.invoke) return window.nativeApi.invoke("head_position:start", opts);
  return { ok: false, message: "IPC not available" };
}

export async function stopHeadPosition(): Promise<{ ok: boolean; message: string }> {
  if (window.stopHeadPosition) return window.stopHeadPosition();
  if (window.nativeApi?.invoke) return window.nativeApi.invoke("head_position:stop");
  return { ok: false, message: "IPC not available" };
}

export function subscribeHeadPosition(
  listener: (payload: HeadPositionUpdate) => void
): () => void {
  if (window.onHeadPositionUpdate) return window.onHeadPositionUpdate(listener);
  if (window.ipcRenderer?.on && window.ipcRenderer?.off) {
    const wrapped = (_event: unknown, payload: HeadPositionUpdate) => listener(payload);
    window.ipcRenderer.on("head_position:update", wrapped);
    return () => window.ipcRenderer?.off?.("head_position:update", wrapped);
  }
  return () => { };
}

// NEW: Subscribe to live gaze data
export function subscribeGazeData(
  listener: (payload: GazeUpdate) => void
): () => void {
  // Parse gaze data from tracker stdout
  return subscribeTrackerLogs((line) => {
    try {
      const data = JSON.parse(line);
      if (data.type === "gaze") {
        listener(data as GazeUpdate);
      }
    } catch {
      // Not JSON or not gaze data, ignore
    }
  });
}

// NEW: Start live gaze stream
export async function startGazeStream(
  opts: { cam?: number; fps?: number; script?: string } = {}
): Promise<{ ok: boolean; message: string }> {
  if (window.startGazeStream) return window.startGazeStream(opts);
  if (window.nativeApi?.invoke) return window.nativeApi.invoke("gaze_stream:start", opts);
  return { ok: false, message: "IPC not available" };
}

// NEW: Stop live gaze stream
export async function stopGazeStream(): Promise<{ ok: boolean; message: string }> {
  if (window.stopGazeStream) return window.stopGazeStream();
  if (window.nativeApi?.invoke) return window.nativeApi.invoke("gaze_stream:stop");
  return { ok: false, message: "IPC not available" };
}

// NEW: Subscribe to gaze stream updates
export function subscribeGazeStream(
  listener: (payload: GazeUpdate) => void
): () => void {
  if (window.onGazeUpdate) return window.onGazeUpdate(listener);
  if (window.ipcRenderer?.on && window.ipcRenderer?.off) {
    const wrapped = (_event: unknown, payload: GazeUpdate) => listener(payload);
    window.ipcRenderer.on("gaze_stream:update", wrapped);
    return () => window.ipcRenderer?.off?.("gaze_stream:update", wrapped);
  }
  return () => { };
}
