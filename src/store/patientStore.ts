import { create } from "zustand";
import type { Patient, SessionSummary } from "../types";

type PatientState = {
  patients: Record<string, Patient>;
  sessionsByPatient: Record<string, SessionSummary[]>;

  addPatient: (
    p: Omit<Patient, "id" | "createdAt" | "code"> & { initials?: string }
  ) => Patient;
  deletePatient: (id: string) => void;
  listPatients: () => Patient[];

  addSessionSummary: (s: SessionSummary) => void;
  listSessions: (patientId: string) => SessionSummary[];
};

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function newPatientCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit 0/1/I/O
  let s = "P-";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

const storageKey = "eyeapp.patientStore.v1";

function load() {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function save(data: unknown) {
  localStorage.setItem(storageKey, JSON.stringify(data));
}

export const usePatientStore = create<PatientState>((set, get) => {
  const persisted = load();
  const initialPatients: Record<string, Patient> = persisted?.patients ?? {};
  const initialSessions: Record<string, SessionSummary[]> = persisted?.sessionsByPatient ?? {};

  const persist = () => {
    const st = get();
    save({
      patients: st.patients,
      sessionsByPatient: st.sessionsByPatient,
    });
  };

  return {
    patients: initialPatients,
    sessionsByPatient: initialSessions,

    addPatient: ({ initials, birthYear, notes }) => {
      const id = newId();
      const code = newPatientCode();
      const now = new Date().toISOString();
      const p: Patient = { id, code, initials, birthYear, notes, createdAt: now };
      set((s) => ({ patients: { ...s.patients, [id]: p } }));
      persist();
      return p;
    },

    deletePatient: (id: string) => {
      set((s) => {
        const { [id]: _, ...rest } = s.patients;
        const { [id]: __, ...restSess } = s.sessionsByPatient;
        return { patients: rest, sessionsByPatient: restSess };
      });
      persist();
    },

    listPatients: () =>
      Object.values(get().patients).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),

    addSessionSummary: (s: SessionSummary) => {
      set((state) => {
        const arr = state.sessionsByPatient[s.patientId] ?? [];
        return {
          sessionsByPatient: {
            ...state.sessionsByPatient,
            [s.patientId]: [...arr, s],
          },
        };
      });
      persist();
    },

    listSessions: (patientId: string) => get().sessionsByPatient[patientId] ?? [],
  };
});
