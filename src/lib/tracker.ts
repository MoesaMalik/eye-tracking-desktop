// src/lib/tracker.ts
export type TrackerStatus = "idle" | "running" | "stopped" | "error";

export async function startTracker(
  opts: { cam?: number; outDir?: string; script?: string } = {}
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
