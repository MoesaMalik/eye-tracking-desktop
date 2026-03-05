/**
 * Excel Analysis IPC wrapper functions
 * Provides type-safe interface to Excel analysis backend
 */

function invokeIpc(channel: string, payload?: unknown) {
  if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
  if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
  return Promise.resolve({ ok: false, error: "IPC not available" });
}

export interface ExcelPickFileResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  message?: string;
}

export interface ExcelReadResult {
  ok: boolean;
  data?: {
    time: number[];
    signal: number[];
    max_time: number;
    sheet_names: string[];
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

export interface ExcelFitResult {
  ok: boolean;
  data?: {
    results: FitResult[];
    error?: string;
  };
  message?: string;
}

export interface ExcelSaveResult {
  ok: boolean;
  data?: {
    success: boolean;
    path: string;
    error?: string;
  };
  message?: string;
}

/**
 * Open file picker dialog to select Excel file
 */
export async function pickExcelFile(): Promise<ExcelPickFileResult> {
  try {
    const result = await invokeIpc("excel:pick-file");
    return result as ExcelPickFileResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read Excel file data
 */
export async function readExcelData(
  filePath: string,
  sheetNumber: number,
  timeColumn: number
): Promise<ExcelReadResult> {
  try {
    const result = await invokeIpc("excel:read", {
      filePath,
      sheetNumber,
      timeColumn,
    });
    return result as ExcelReadResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Perform exponential curve fitting on signal data
 */
export async function fitExcelData(params: {
  time: number[];
  signal: number[];
  mode: number;
  frameRate: number;
  beforeLim: number;
  afterLim: number;
}): Promise<ExcelFitResult> {
  try {
    const result = await invokeIpc("excel:fit", params);
    return result as ExcelFitResult;
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
export async function saveExcelResults(params: {
  results: FitResult[];
  filePath: string;
  filename: string;
}): Promise<ExcelSaveResult> {
  try {
    const result = await invokeIpc("excel:save", params);
    return result as ExcelSaveResult;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
