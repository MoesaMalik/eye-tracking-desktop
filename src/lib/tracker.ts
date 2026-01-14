// src/lib/tracker.ts
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
  return () => {};
}
export function subscribeTrackerErrors(listener: (line: string) => void): () => void {
  if (window.tracker?.onStderr) return window.tracker.onStderr(listener);
  return () => {};
}
export function subscribeTrackerExit(listener: (code: number) => void): () => void {
  if (window.tracker?.onExit) return window.tracker.onExit(listener);
  return () => {};
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
  return () => {};
}
