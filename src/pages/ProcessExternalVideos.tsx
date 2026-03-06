// src/pages/ProcessExternalVideos.tsx
import { useState, useEffect, useRef } from "react";
import {
  startTracker,
  stopTracker,
  getTrackerStatus,
  subscribeTrackerLogs,
  subscribeTrackerErrors,
  subscribeTrackerExit,
  pickTrackerVideo,
  type TrackerStatus,
} from "../lib/tracker";

type VideoJob = {
  id: string;
  path: string;
  name: string;
  status: "queued" | "processing" | "completed" | "error";
  logs: string[];
  exitCode?: number;
};

export default function ProcessExternalVideos() {
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [currentJob, setCurrentJob] = useState<string | null>(null);
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatus>("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [autoProcess, setAutoProcess] = useState(true);
  const processingRef = useRef(false);

  // Subscribe to tracker events
  useEffect(() => {
    const unStdout = subscribeTrackerLogs((line) => {
      if (currentJob) {
        setJobs((prev) =>
          prev.map((job) =>
            job.id === currentJob
              ? { ...job, logs: [...job.logs, line].slice(-500) }
              : job
          )
        );
      }
    });

    const unStderr = subscribeTrackerErrors((line) => {
      if (currentJob) {
        setJobs((prev) =>
          prev.map((job) =>
            job.id === currentJob
              ? { ...job, logs: [...job.logs, `[err] ${line}`].slice(-500) }
              : job
          )
        );
      }
    });

    const unExit = subscribeTrackerExit((code) => {
      if (currentJob) {
        setJobs((prev) =>
          prev.map((job) =>
            job.id === currentJob
              ? {
                  ...job,
                  status: code === 0 ? "completed" : "error",
                  exitCode: code,
                }
              : job
          )
        );
        setCurrentJob(null);
        setTrackerStatus("stopped");
        processingRef.current = false;
      }
    });

    return () => {
      unStdout();
      unStderr();
      unExit();
    };
  }, [currentJob]);

  // Auto-process queue
  useEffect(() => {
    if (!autoProcess || processingRef.current || trackerStatus === "running") return;

    const nextJob = jobs.find((job) => job.status === "queued");
    if (nextJob) {
      processJob(nextJob.id);
    }
  }, [jobs, autoProcess, trackerStatus]);

  // Check initial tracker status
  useEffect(() => {
    getTrackerStatus().then((s) => setTrackerStatus(s.status));
  }, []);

  async function processJob(jobId: string) {
    const job = jobs.find((j) => j.id === jobId);
    if (!job || processingRef.current) return;

    processingRef.current = true;
    setCurrentJob(jobId);
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, status: "processing" as const } : j))
    );

    const res = await startTracker({
      videoPath: job.path,
      preview: false,
    });

    if (res.ok) {
      setTrackerStatus("running");
      const status = await getTrackerStatus();
      setTrackerStatus(status.status);
    } else {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: "error" as const, logs: [...j.logs, `Failed to start: ${res.message}`] }
            : j
        )
      );
      setCurrentJob(null);
      processingRef.current = false;
    }
  }

  async function stopCurrentJob() {
    if (currentJob) {
      await stopTracker();
      setJobs((prev) =>
        prev.map((j) =>
          j.id === currentJob ? { ...j, status: "error" as const, logs: [...j.logs, "Stopped by user"] } : j
        )
      );
      setCurrentJob(null);
      setTrackerStatus("stopped");
      processingRef.current = false;
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter((file) =>
      file.name.toLowerCase().endsWith(".mp4")
    );

    addVideoFiles(files);
  }

  function addVideoFiles(files: File[]) {
    const newJobs: VideoJob[] = files.map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      path: file.path || (file as any).path, // Electron provides file.path
      name: file.name,
      status: "queued" as const,
      logs: [],
    }));

    setJobs((prev) => [...prev, ...newJobs]);
  }

  async function handleFilePicker() {
    const result = await pickTrackerVideo();
    if (result.ok && !result.canceled && result.path) {
      const fileName = result.path.split(/[\\/]/).pop() || "video.mp4";
      const newJob: VideoJob = {
        id: `${Date.now()}-${Math.random()}`,
        path: result.path,
        name: fileName,
        status: "queued",
        logs: [],
      };
      setJobs((prev) => [...prev, newJob]);
    }
  }

  function clearCompleted() {
    setJobs((prev) => prev.filter((job) => job.status !== "completed"));
  }

  function removeJob(jobId: string) {
    if (currentJob === jobId) {
      stopCurrentJob();
    }
    setJobs((prev) => prev.filter((job) => job.id !== jobId));
  }

  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Process External Videos</h1>
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Queued: {queuedCount}</span>
          <span>•</span>
          <span>Completed: {completedCount}</span>
          <span>•</span>
          <span>Errors: {errorCount}</span>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoProcess}
            onChange={(e) => setAutoProcess(e.target.checked)}
            className="rounded"
          />
          Auto-process queue
        </label>
        <button
          onClick={handleFilePicker}
          className="ml-auto px-3 py-1.5 rounded border bg-white hover:bg-gray-50"
        >
          Choose Files
        </button>
        <button
          onClick={clearCompleted}
          disabled={completedCount === 0}
          className="px-3 py-1.5 rounded border bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          Clear Completed
        </button>
        {currentJob && (
          <button
            onClick={stopCurrentJob}
            className="px-3 py-1.5 rounded border border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
          >
            Stop Current
          </button>
        )}
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-gray-50"
        }`}
      >
        <div className="text-gray-600">
          <div className="text-lg font-medium mb-2">
            Drop .mp4 files here
          </div>
          <div className="text-sm">
            Or click "Choose Files" to select videos
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {jobs.length === 0 && (
          <div className="rounded-lg border bg-white p-8 text-center text-gray-500">
            No videos in queue. Drop .mp4 files above to get started.
          </div>
        )}

        {jobs.map((job) => (
          <div key={job.id} className="rounded-lg border bg-white overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center gap-3">
              <div className="flex-1">
                <div className="font-medium text-sm">{job.name}</div>
                <div className="text-xs text-gray-500 truncate">{job.path}</div>
              </div>
              <div
                className={`px-2 py-1 rounded text-xs font-medium ${
                  job.status === "queued"
                    ? "bg-gray-100 text-gray-700"
                    : job.status === "processing"
                    ? "bg-blue-100 text-blue-700"
                    : job.status === "completed"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {job.status}
              </div>
              {job.exitCode !== undefined && (
                <div className="text-xs text-gray-500">Exit: {job.exitCode}</div>
              )}
              <button
                onClick={() => removeJob(job.id)}
                disabled={job.id === currentJob}
                className="text-xs px-2 py-1 rounded border hover:bg-gray-50 disabled:opacity-50"
              >
                Remove
              </button>
            </div>

            {(job.status === "processing" || job.status === "completed" || job.status === "error") && (
              <div className="p-3 bg-gray-50">
                <div className="text-xs text-gray-600 mb-1">Processing Logs:</div>
                <pre className="text-xs max-h-40 overflow-auto whitespace-pre-wrap break-words bg-white border rounded p-2">
                  {job.logs.length > 0 ? job.logs.join("\n") : "No logs yet..."}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
