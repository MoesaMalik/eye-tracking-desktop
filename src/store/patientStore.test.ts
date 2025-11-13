import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { usePatientStore } from "./patientStore";
import type { SessionSummary } from "../types";

const STORAGE_KEY = "eyeapp.patientStore.v1";

function resetStore() {
  usePatientStore.setState({ patients: {}, sessionsByPatient: {} });
  localStorage.clear();
}

describe("usePatientStore", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStore();
  });

  it("adds patients with generated metadata and persists them", () => {
    const { addPatient } = usePatientStore.getState();

    const patient = addPatient({
      initials: "AB",
      birthYear: 2000,
      notes: "glasses",
    });

    const stored = usePatientStore.getState().patients[patient.id];
    expect(stored).toBeDefined();
    expect(stored?.code).toMatch(/^P-[A-Z0-9]{4}$/);
    expect(stored?.initials).toBe("AB");
    expect(stored?.notes).toBe("glasses");

    const serialized = localStorage.getItem(STORAGE_KEY);
    expect(serialized).toBeTruthy();
    const persisted = JSON.parse(serialized!);
    expect(persisted.patients[patient.id].code).toBe(stored?.code);
  });

  it("deletes patients and their session history", () => {
    const { addPatient, addSessionSummary, deletePatient, listSessions } = usePatientStore.getState();
    const patient = addPatient({ initials: undefined, birthYear: undefined, notes: undefined });

    const summary: SessionSummary = {
      id: "sess-1",
      patientId: patient.id,
      protocolKey: "saccades",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    addSessionSummary(summary);
    expect(listSessions(patient.id)).toHaveLength(1);

    deletePatient(patient.id);

    expect(usePatientStore.getState().patients[patient.id]).toBeUndefined();
    expect(listSessions(patient.id)).toHaveLength(0);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(persisted.patients[patient.id]).toBeUndefined();
    expect(persisted.sessionsByPatient?.[patient.id]).toBeUndefined();
  });

  it("sorts patients chronologically and stores session summaries", () => {
    vi.useFakeTimers();
    const { addPatient, addSessionSummary, listPatients, listSessions } = usePatientStore.getState();

    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const early = addPatient({ initials: "A", birthYear: 1990, notes: undefined });

    vi.setSystemTime(new Date("2024-01-02T00:00:00.000Z"));
    const late = addPatient({ initials: "B", birthYear: 1995, notes: undefined });

    addSessionSummary({
      id: "sess-chron",
      patientId: late.id,
      protocolKey: "calibration",
      startedAt: "2024-01-02T00:00:00.000Z",
      endedAt: "2024-01-02T00:05:00.000Z",
    });

    const ordered = listPatients();
    expect(ordered.map((p) => p.id)).toEqual([early.id, late.id]);
    expect(listSessions(late.id)).toHaveLength(1);
  });
});
