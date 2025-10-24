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
