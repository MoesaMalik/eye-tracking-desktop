export type Patient = {
  id: string;           // internal ID
  code: string;         // anonymous code shown in UI & exports (e.g., P-7G2Q)
  initials?: string;    // optional; never exported
  birthYear?: number;   // optional; never exported
  notes?: string;       // optional; never exported
  createdAt: string;    // ISO
};

export type SessionSummary = {
  id: string;           // session id
  patientId: string;    // FK to Patient.id
  protocolKey: string;
  startedAt: string;
  endedAt?: string;
};

export type RecordingFolder = {
  name: string;
  path: string;
  createdAt: string;
};

export type FrameData = {
  frame: number;
  timestamp: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
};

export type ManualMark = {
  frame: number;
  lx?: number;
  ly?: number;
  rx?: number;
  ry?: number;
};

export type ComparisonResult = {
  frame: number;
  l_error: number | null;
  r_error: number | null;
  l_error_pct?: number | null; // left error as % of iris diameter
  r_error_pct?: number | null; // right error as % of iris diameter
};

/**
 * Calibration target event payload.
 * Emitted when a calibration TARGET slide becomes visible.
 */
export type CalibrationTarget = {
  session_id: string;    // Session identifier for tracing across sessions
  slide_index: number;   // Target index (0-11) for grouping during model fitting
  x: number;             // Target X coordinate (pixels, screen space)
  y: number;             // Target Y coordinate (pixels, screen space)
  slide: string;         // Slide path e.g. "/assets/protocols/calibration/704-540.png"
  timestamp_ms: number;  // Milliseconds since epoch
};

/**
 * Extended slide metadata for calibration protocol.
 * Used internally to track which slides are CENTER vs TARGET.
 */
export type CalibrationSlideInfo = {
  path: string;          // Slide file path
  isCenter: boolean;     // true = center.png, false = target slide
  targetX?: number;      // Target X coord (only for targets)
  targetY?: number;      // Target Y coord (only for targets)
  targetIndex?: number;  // Target index 0-11 (only for targets)
};
