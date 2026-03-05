/**
 * Recording Analysis IPC wrapper functions
 * Provides type-safe interface to recording analysis backend
 */

function invokeIpc(channel: string, payload?: unknown) {
  if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
  if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
  return Promise.resolve({ ok: false, error: "IPC not available" });
}

export interface RecordingReadResult {
  ok: boolean;
  data?: {
    time: number[];
    signal: number[];
    signal_name: string;
    max_time: number;
    num_frames: number;
    num_valid: number;
    error?: string;
  };
  message?: string;
}

export interface FitResult {
  index: number;
  event_time: number;
  a?: number;
  b?: number;
  tau?: number;
  d?: number;
  fit_before?: number;
  fit_during?: number;
  fit_after?: number;
  t_fit?: number[];
  s_original?: number[];
  s_fitted?: number[];
  error?: string;
}

export interface RecordingDetectResult {
  ok: boolean;
  data?: {
    event_times: number[];
    num_events: number;
    fit_results: FitResult[];
    error?: string;
  };
  message?: string;
}

export interface RecordingFitResult {
  ok: boolean;
  data?: {
    results: FitResult[];
    error?: string;
  };
  message?: string;
}

export interface RecordingSaveResult {
  ok: boolean;
  data?: {
    success: boolean;
    path: string;
    error?: string;
  };
  message?: string;
}

export interface SessionInfo {
  sessionId: string;
  mtimeMs: number;
  hasCalibration: boolean;
}

/**
 * List available recording sessions
 */
export async function listSessions(limit = 20): Promise<SessionInfo[]> {
  try {
    const result = await invokeIpc("recordings:listSessions", { limit });
    return (result as SessionInfo[]) || [];
  } catch (error) {
    console.error("Failed to list sessions:", error);
    return [];
  }
}

/**
 * Read tracking data from a session
 */
export async function readSessionTracking(
  sessionId: string,
  signalType: string = "gaze_x"
): Promise<RecordingReadResult> {
  try {
    const result = await invokeIpc("recording:read", {
      sessionId,
      signalType,
    });

    return result as RecordingReadResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read tracking data from a file path
 */
export async function readRecordingData(
  filePath: string,
  signalType: string = "gaze_x"
): Promise<RecordingReadResult> {
  try {
    const result = await invokeIpc("recording:read", {
      filePath,
      signalType,
    });
    return result as RecordingReadResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Auto-detect events and fit parameters
 */
export async function detectAndFitEvents(params: {
  time: number[];
  signal: number[];
  beforeLim: number;
  afterLim: number;
  thresholdFactor?: number;
  minDistance?: number;
}): Promise<RecordingDetectResult> {
  try {
    const result = await invokeIpc("recording:detect-events", params);
    return result as RecordingDetectResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fit parameters to manually specified events
 */
export async function fitRecordingData(params: {
  time: number[];
  signal: number[];
  eventTimes: number[];
  beforeLim: number;
  afterLim: number;
}): Promise<RecordingFitResult> {
  try {
    const result = await invokeIpc("recording:fit", params);
    return result as RecordingFitResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Save fitted parameters to CSV file
 */
export async function saveRecordingResults(params: {
  results: FitResult[];
  filePath: string;
  sessionId: string;
}): Promise<RecordingSaveResult> {
  try {
    const result = await invokeIpc("recording:save", params);
    return result as RecordingSaveResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the absolute path to a recording file
 */
export function getRecordingPath(sessionId: string, filename: string = "recording_tracking_data.json"): string {
  // This will be resolved on the main process side
  return `recordings/${sessionId}/${filename}`;
}
