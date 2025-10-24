import { useMemo, useState } from "react";
import { usePatientStore } from "../store/patientStore";
import type { Patient } from "../types";
import { Link, useNavigate } from "react-router-dom";

export default function Patients() {
  const addPatient = usePatientStore((s) => s.addPatient);
  const deletePatient = usePatientStore((s) => s.deletePatient);
  const patientsMap = usePatientStore((s) => s.patients); // raw map

  // Build a stable array only when map changes
  const patients = useMemo<Patient[]>(
    () => Object.values(patientsMap).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [patientsMap]
  );

  const navigate = useNavigate();

  const [initials, setInitials] = useState("");
  const [birthYear, setBirthYear] = useState<number | "">("");
  const [notes, setNotes] = useState("");

  function createPatient() {
    const by =
      typeof birthYear === "string" || birthYear === 0 ? undefined : Number(birthYear);

    const p = addPatient({
      initials: initials.trim() || undefined,
      birthYear: by,
      notes: notes.trim() || undefined,
    });

    // reset form
    setInitials("");
    setBirthYear("");
    setNotes("");

    // Immediately start a session for this patient
    navigate(`/run?patient=${p.id}`);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">Patients</h1>

      {/* Create form */}
      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="text-sm text-gray-600">
          Create a local patient record (anonymous code only is used in exports).
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Initials (optional)</label>
            <input
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase())}
              className="border rounded px-3 py-2"
              placeholder="AB"
              maxLength={4}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Birth year (optional)</label>
            <input
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value ? Number(e.target.value) : "")}
              className="border rounded px-3 py-2 w-28"
              placeholder="2003"
              type="number"
              min={1900}
              max={new Date().getFullYear()}
            />
          </div>
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-gray-600 mb-1">Notes (optional, never exported)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="border rounded px-3 py-2 w-full"
              placeholder="Glasses, low light…"
            />
          </div>
          <button className="px-3 py-2 rounded bg-gray-900 text-white" onClick={createPatient}>
            Add & Start Session
          </button>
        </div>
        <div className="text-xs text-gray-500">
          Exports contain only the anonymous <b>code</b> (e.g., P-7G2Q)—no initials, birth year, or notes.
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border bg-white">
        <div className="px-3 py-2 border-b text-sm text-gray-600">Records</div>
        <div className="divide-y">
          {patients.length === 0 && (
            <div className="p-4 text-sm text-gray-500">No patients yet.</div>
          )}
          {patients.map((p: Patient) => (
            <div key={p.id} className="p-3 flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="font-medium">
                  {p.code}{" "}
                  {p.initials ? <span className="text-gray-500 ml-2">({p.initials})</span> : null}
                </div>
                <div className="text-xs text-gray-500">
                  Created {new Date(p.createdAt).toLocaleString()}
                  {p.birthYear ? ` • BY ${p.birthYear}` : ""}
                </div>
                {p.notes ? <div className="text-xs text-gray-500">Notes: {p.notes}</div> : null}
              </div>
              <div className="flex items-center gap-2">
                <Link
                  to={`/run?patient=${p.id}`}
                  className="px-3 py-1.5 border rounded bg-white text-sm"
                  title="Start a test session"
                >
                  Start Session
                </Link>
                <button
                  className="px-3 py-1.5 border rounded bg-white text-sm"
                  onClick={() => deletePatient(p.id)}
                  title="Delete patient"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
