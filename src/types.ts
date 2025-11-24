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
};
