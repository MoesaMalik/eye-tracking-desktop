import { useMemo, useState } from "react";
import { usePatientStore } from "../store/patientStore";
import type { Patient } from "../types";
import { Link, useNavigate } from "react-router-dom";
import { GradientCard } from "../components/ui/gradient-card";
import { ShimmerButton } from "../components/ui/shimmer-button";

export default function Patients() {
  const addPatient = usePatientStore((s) => s.addPatient);
  const deletePatient = usePatientStore((s) => s.deletePatient);
  const patientsMap = usePatientStore((s) => s.patients);
  const sessionsByPatient = usePatientStore((s) => s.sessionsByPatient);

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

    setInitials("");
    setBirthYear("");
    setNotes("");

    navigate(`/run?patient=${p.id}`);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page Header */}
      <div className="relative">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 via-blue-900 to-purple-900 bg-clip-text text-transparent">
          Patients
        </h1>
        <p className="text-sm text-gray-500 mt-2">Manage patient records and start testing sessions.</p>
        <div className="absolute -top-2 -left-2 w-20 h-20 bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-full blur-2xl -z-10" />
      </div>

      {/* Create Form */}
      <GradientCard gradient="blue" className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center shadow-lg">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">New Patient</h2>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Initials</label>
            <input
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase())}
              className="border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 backdrop-blur"
              placeholder="AB"
              maxLength={4}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Birth Year</label>
            <input
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value ? Number(e.target.value) : "")}
              className="border-2 border-gray-200 rounded-lg px-3 py-2.5 w-32 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 backdrop-blur"
              placeholder="2003"
              type="number"
              min={1900}
              max={new Date().getFullYear()}
            />
          </div>
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Notes</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="border-2 border-gray-200 rounded-lg px-3 py-2.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 backdrop-blur"
              placeholder="Glasses, low light..."
            />
          </div>
          <ShimmerButton
            onClick={createPatient}
            variant="primary"
            className="whitespace-nowrap"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add & Start Baseline
          </ShimmerButton>
        </div>

        <p className="text-xs text-gray-500 mt-4 bg-blue-50/50 rounded-lg px-3 py-2 border border-blue-100">
          <svg className="w-3.5 h-3.5 inline mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Exports contain only the anonymous <b>code</b> (e.g., P-7G2Q). No personal data is exported.
        </p>
      </GradientCard>

      {/* Records List */}
      <GradientCard gradient="subtle" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-900">Records</h2>
            <span className="ml-auto text-xs font-medium text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
              {patients.length} {patients.length === 1 ? 'patient' : 'patients'}
            </span>
          </div>
        </div>

        <div className="divide-y divide-gray-100">
          {patients.length === 0 && (
            <div className="p-12 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <p className="text-sm text-gray-500">No patients yet.</p>
              <p className="text-xs text-gray-400 mt-1">Create one above to get started.</p>
            </div>
          )}
          {patients.map((p: Patient, index) => {
            const sessions = (sessionsByPatient[p.id] ?? []).slice().sort((a, b) =>
              a.startedAt.localeCompare(b.startedAt)
            );
            const baseline = sessions[0];
            const rerunCount = Math.max(0, sessions.length - 1);

            return (
              <div
                key={p.id}
                className="px-6 py-4 flex items-center justify-between gap-4 hover:bg-gradient-to-r hover:from-blue-50/30 hover:to-purple-50/30 transition-all duration-300 group animate-slide-in"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center shadow-lg group-hover:shadow-xl transition-shadow flex-shrink-0">
                    <span className="text-white font-bold text-lg">{p.code.slice(-2)}</span>
                  </div>

                  <div className="space-y-1 min-w-0">
                    <div className="font-semibold text-gray-900 flex items-center gap-2">
                      {p.code}
                      {p.initials && (
                        <span className="text-sm text-gray-400 font-normal">({p.initials})</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      Created {new Date(p.createdAt).toLocaleString()}
                      {p.birthYear && <span className="ml-2">• Birth year {p.birthYear}</span>}
                    </div>
                    {p.notes && (
                      <div className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded inline-block">
                        {p.notes}
                      </div>
                    )}
                    <div className="text-xs text-gray-600 flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Baseline: {baseline ? new Date(baseline.startedAt).toLocaleString() : "not recorded"}
                      {rerunCount > 0 && <span className="ml-1">• {rerunCount} reruns</span>}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <Link
                    to={`/run?patient=${p.id}`}
                    className="px-4 py-2 rounded-lg border-2 border-gray-200 bg-white text-sm font-medium text-gray-700 hover:bg-gradient-to-r hover:from-blue-50 hover:to-purple-50 hover:border-blue-300 transition-all duration-300 hover:shadow-md"
                  >
                    {sessionsByPatient[p.id]?.length ? "Rerun Test" : "Start Baseline"}
                  </Link>
                  {sessionsByPatient[p.id]?.length && sessionsByPatient[p.id].length > 1 && (
                    <Link
                      to={`/results?patient=${p.id}`}
                      className="px-4 py-2 rounded-lg border-2 border-blue-200 bg-gradient-to-r from-blue-50 to-purple-50 text-sm font-medium text-blue-700 hover:from-blue-100 hover:to-purple-100 transition-all duration-300 hover:shadow-md"
                    >
                      Compare
                    </Link>
                  )}
                  <button
                    className="px-4 py-2 rounded-lg border-2 border-red-200 bg-white text-sm font-medium text-red-600 hover:bg-red-50 hover:border-red-300 transition-all duration-300 hover:shadow-md"
                    onClick={() => deletePatient(p.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </GradientCard>
    </div>
  );
}
