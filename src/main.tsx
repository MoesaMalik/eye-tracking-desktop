// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import Patients from "./pages/Patients";
import RunTest from "./pages/RunTest";
import Recorder from "./pages/Recorder"; // your recorder page (logs / start/stop UI)
import CalibrateCurrent from "./pages/CalibrateCurrent";
import CalibrationResults from "./pages/CalibrationResults";
import Validation from "./pages/Validation";
import Results from "./pages/Results";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Navigate to="patients" replace />} />
          <Route path="patients" element={<Patients />} />
          <Route path="run" element={<RunTest />} />
          <Route path="results" element={<Results />} />
          <Route path="calibrate" element={<CalibrateCurrent />} />
          <Route path="recorder" element={<Recorder />} />
          <Route path="calibration-results" element={<CalibrationResults />} />
          <Route path="validation" element={<Validation />} />
          <Route path="*" element={<Navigate to="patients" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>
);
