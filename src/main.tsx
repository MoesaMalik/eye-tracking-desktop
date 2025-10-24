import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import Patients from "./pages/Patients";
import RunTest from "./pages/RunTest";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        {/* App = layout shell that contains <Outlet/> */}
        <Route path="/" element={<App />}>
          {/* default: send to patients */}
          <Route index element={<Navigate to="patients" replace />} />
          <Route path="patients" element={<Patients />} />
          <Route path="run" element={<RunTest />} />
          {/* catch-all */}
          <Route path="*" element={<Navigate to="patients" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>
);
