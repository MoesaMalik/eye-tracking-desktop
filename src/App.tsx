// src/App.tsx
import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import Annotation from "./pages/Annotation";

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
            <NavLink
              to="/results"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Results
            </NavLink>
            <NavLink
              to="/calibrate"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Calibrate
            </NavLink>
            <NavLink
              to="/calibration-results"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Calibration Results
            </NavLink>
            <NavLink
              to="/recorder"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Recorder
            </NavLink>
            <NavLink
              to="/analyze-video"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? "bg-gray-900 text-white" : "border bg-white"}`
              }
            >
              Analyze Recording
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Outlet />}>
            {/* Existing routes are handled by parent layout or separate config? 
                 Wait, App.tsx has <Outlet /> but no Routes definition? 
                 Ah, main.tsx usually handles the router. Let me check main.tsx.
                 App.tsx seems to be the Layout actually, based on the code.
                 Let's check main.tsx first before editing App.tsx blindly.
             */}
            <Route path="annotation" element={<Annotation />} />
          </Route>
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
