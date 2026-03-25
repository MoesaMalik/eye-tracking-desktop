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
import { ShimmerButton } from "../components/ui/shimmer-button";
import { AnimatedBadge } from "../components/ui/animated-badge";

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

    const files = Array.from(e.dataTransfer.files).filter((file) => {
      const fileName = file.name.toLowerCase();
      return fileName.endsWith(".mp4") || fileName.endsWith(".mkv");
    });

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
      const fileName = result.path.split(/[\\/]/).pop() || "video";
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
    <div className="space-y-6 animate-fade-in">
      {/* Page Header */}
      <div className="relative">
        <div className="absolute -top-2 -left-2 w-20 h-20 bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-full blur-2xl -z-10" />
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 via-blue-900 to-purple-900 bg-clip-text text-transparent">
            Process External Videos
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Batch process .mp4 and .mkv videos from external eye-tracking systems
          </p>
        </div>
      </div>

      {/* Queue Stats */}
      <div className="flex items-center gap-3">
        <AnimatedBadge variant="default">
          Queued: {queuedCount}
        </AnimatedBadge>
        <AnimatedBadge variant="success">
          Completed: {completedCount}
        </AnimatedBadge>
        <AnimatedBadge variant="error">
          Errors: {errorCount}
        </AnimatedBadge>
      </div>

      {/* Control Panel */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={autoProcess}
            onChange={(e) => setAutoProcess(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
          />
          Auto-process queue
        </label>
        <div className="ml-auto flex items-center gap-2">
          <ShimmerButton
            onClick={handleFilePicker}
            variant="primary"
          >
            Choose Files
          </ShimmerButton>
          <ShimmerButton
            onClick={clearCompleted}
            disabled={completedCount === 0}
            variant="secondary"
          >
            Clear Completed
          </ShimmerButton>
          {currentJob && (
            <ShimmerButton
              onClick={stopCurrentJob}
              variant="danger"
            >
              Stop Current
            </ShimmerButton>
          )}
        </div>
      </div>

      {/* Drag & Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-10 text-center transition-all duration-300 ${
          isDragging
            ? "border-blue-400 bg-gradient-to-r from-blue-50 to-purple-50 shadow-lg"
            : "border-gray-300 bg-gray-50/50 hover:bg-gray-50 hover:border-gray-400"
        }`}
      >
        <div className="flex flex-col items-center gap-4">
          {/* Upload Icon */}
          <svg
            className={`w-12 h-12 transition-colors duration-300 ${
              isDragging ? "text-blue-500" : "text-gray-400"
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>

          <div className="text-gray-600">
            <div className="text-lg font-medium mb-1">
              Drop .mp4 or .mkv files here
            </div>
            <div className="text-sm text-gray-500">
              Or click "Choose Files" to select videos
            </div>
          </div>
        </div>
      </div>

      {/* Job Queue */}
      <div className="space-y-3">
        {jobs.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-gray-100 p-12 text-center">
            <svg
              className="mx-auto w-16 h-16 text-gray-300 mb-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
            <div className="text-gray-500 font-medium">
              No videos in queue
            </div>
            <div className="text-sm text-gray-400 mt-1">
              Drop .mp4 or .mkv files above to get started
            </div>
          </div>
        )}

        {jobs.map((job) => (
          <div key={job.id} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden hover:shadow-md transition-all duration-300">
            {/* Job Header */}
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900">{job.name}</div>
                <div className="text-xs text-gray-500 truncate">{job.path}</div>
              </div>

              {/* Status Badge */}
              <AnimatedBadge
                variant={
                  job.status === "queued" ? "default" :
                  job.status === "processing" ? "info" :
                  job.status === "completed" ? "success" :
                  "error"
                }
                pulse={job.status === "processing"}
              >
                {job.status}
              </AnimatedBadge>

              {job.exitCode !== undefined && (
                <div className="text-xs text-gray-500 font-mono">
                  Exit: {job.exitCode}
                </div>
              )}

              {/* Remove Button */}
              <button
                onClick={() => removeJob(job.id)}
                disabled={job.id === currentJob}
                className="px-3 py-1.5 rounded-lg border-2 border-red-200 bg-white text-xs font-medium text-red-600 hover:bg-red-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Remove
              </button>
            </div>

            {/* Job Logs */}
            {(job.status === "processing" || job.status === "completed" || job.status === "error") && (
              <div className="p-4 bg-gray-50/50">
                <div className="text-xs font-medium text-gray-600 mb-2">Processing Logs:</div>
                <pre className="bg-gray-950 text-gray-300 font-mono text-xs rounded-lg p-3 max-h-40 overflow-auto whitespace-pre-wrap break-words">
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
