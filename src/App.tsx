// src/App.tsx
import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import Annotation from "./pages/Annotation";

const navItems = [
  { to: "/patients", label: "Patients" },
  { to: "/run", label: "Run Test" },
  { to: "/results", label: "Results" },
  { to: "/analyze-video", label: "Analyze" },
  { to: "/process-external", label: "Process External" },
];

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 flex flex-col">
      {/* Animated gradient background */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-gradient-to-br from-blue-400/20 to-purple-400/20 rounded-full blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-gradient-to-br from-emerald-400/20 to-teal-400/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <header className="sticky top-0 z-50 border-b border-gray-200/50 bg-white/80 backdrop-blur-xl shadow-sm">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
          {/* Logo section with gradient text */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg blur opacity-75 group-hover:opacity-100 transition-opacity" />
              <div className="relative w-9 h-9 rounded-lg bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shadow-lg">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="4" />
                  <circle cx="12" cy="12" r="1" fill="white" />
                </svg>
              </div>
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-lg bg-gradient-to-r from-gray-900 via-blue-900 to-purple-900 bg-clip-text text-transparent">
                Eye Tracking
              </span>
              <span className="text-xs text-gray-500">Research Platform</span>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex items-center gap-1.5">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `
                    relative px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300
                    ${
                      isActive
                        ? "text-white"
                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100/80"
                    }
                  `
                }
              >
                {({ isActive }) => (
                  <>
                    {item.label}
                    {isActive && (
                      <>
                        <span className="absolute inset-0 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 shadow-lg -z-10" />
                        <span className="absolute inset-0 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 opacity-50 blur -z-20" />
                      </>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-7xl w-full px-6 py-8">
        <Routes>
          <Route path="/" element={<Outlet />}>
            <Route path="annotation" element={<Annotation />} />
          </Route>
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
