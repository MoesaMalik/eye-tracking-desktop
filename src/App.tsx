import { NavLink, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 bg-white border-b">
        <div className="mx-auto max-w-6xl px-4 h-12 flex items-center justify-between">
          <div className="font-semibold">Eye Tracking (Demo)</div>
          <nav className="flex gap-3">
            <NavLink
              to="/patients"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Patients
            </NavLink>
            <NavLink
              to="/run"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Run Test
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
