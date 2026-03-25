import { useEffect, useState, useMemo, useRef } from "react";
import {
  listSessions,
  readSessionTracking,
  readSessionTransitions,
  detectStimuliAndFit,
  fitRecordingData,
  saveRecordingResults,
  getSessionVideoPath,
  readRawTrackingData,
  saveEventSelection,
  loadEventSelection,
  type FitResult,
  type SessionInfo,
  type StimuliInfo,
  type TransitionInfo,
} from "../lib/recording-analysis";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

const SIGNAL_TYPES = [
  { value: "gaze_xy", label: "Gaze XY (Magnitude)" },
  { value: "gaze_x", label: "Gaze X (Horizontal)" },
  { value: "gaze_y", label: "Gaze Y (Vertical)" },
  { value: "left_x", label: "Left Eye X" },
  { value: "left_y", label: "Left Eye Y" },
  { value: "right_x", label: "Right Eye X" },
  { value: "right_y", label: "Right Eye Y" },
];

const FILTER_LEVELS = [
  { value: "raw", label: "Raw (No Filter)" },
  { value: "low", label: "Low (Light Smoothing)" },
  { value: "med", label: "Medium (Balanced)" },
  { value: "high", label: "High (Heavy Smoothing)" },
];

export default function AnalyzeVideo() {
  // Session and data state
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [signalType, setSignalType] = useState<string>("gaze_xy");
  const [filterLevel, setFilterLevel] = useState<string>("raw"); // raw, low, med, high
  const [timeData, setTimeData] = useState<number[]>([]);
  const [signalData, setSignalData] = useState<number[]>([]);
  const [signalName, setSignalName] = useState<string>("");
  const [loadedFilePath, setLoadedFilePath] = useState<string>("");
  const [eventsFilePath, setEventsFilePath] = useState<string>("");
  const [trackingFrames, setTrackingFrames] = useState<any[]>([]); // Store full frame data for gaze lookup

  // Analysis parameters
  const [tMin, setTMin] = useState<number>(0);
  const [tMax, setTMax] = useState<number>(60);
  const [beforeLim, setBeforeLim] = useState<number>(0.5);
  const [afterLim, setAfterLim] = useState<number>(1.0);

  // Event detection state
  const [eventTimes, setEventTimes] = useState<number[]>([]);
  const [stimuliInfo, setStimuliInfo] = useState<StimuliInfo[]>([]);
  const [manualEventInput, setManualEventInput] = useState<string>("");
  const [jumpThreshold, setJumpThreshold] = useState<number>(50); // Threshold for detecting big jumps
  const [selectedEventIndices, setSelectedEventIndices] = useState<Set<number>>(new Set());

  // Results state
  const [fitResults, setFitResults] = useState<FitResult[]>([]);

  // Transition timeline state
  const [transitions, setTransitions] = useState<TransitionInfo[]>([]);

  // Video preview state
  const [videoPath, setVideoPath] = useState<string>("");
  const [showVideo, setShowVideo] = useState<boolean>(true);
  const [markerTime, setMarkerTime] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // UI state
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Load sessions on mount
  useEffect(() => {
    async function loadSessions() {
      const sessionList = await listSessions(50);
      setSessions(sessionList);
      if (sessionList.length > 0 && !selectedSessionId) {
        setSelectedSessionId(sessionList[0].sessionId);
      }
    }
    loadSessions();
  }, []);

  // Prepare chart data for main plot
  const mainChartData = useMemo(() => {
    if (!timeData.length || !signalData.length) return [];

    // Filter data to visible time range
    const data = timeData
      .map((t, i) => ({
        time: t,
        signal: signalData[i],
      }))
      .filter((d) => d.time >= tMin && d.time <= tMax);

    return data;
  }, [timeData, signalData, tMin, tMax]);

  // Calculate Y-axis range for main chart
  const yRange = useMemo(() => {
    if (!mainChartData.length) return { min: -100, max: 100 };
    const signals = mainChartData.map((d) => d.signal);
    return {
      min: Math.min(...signals),
      max: Math.max(...signals),
    };
  }, [mainChartData]);

  // Color palette for transition bands (stronger opacity)
  const TRANSITION_COLORS = [
    "rgba(59, 130, 246, 0.18)",   // blue
    "rgba(16, 185, 129, 0.18)",   // green
    "rgba(245, 158, 11, 0.18)",   // amber
    "rgba(139, 92, 246, 0.18)",   // purple
    "rgba(236, 72, 153, 0.18)",   // pink
    "rgba(6, 182, 212, 0.18)",    // cyan
    "rgba(239, 68, 68, 0.18)",    // red
    "rgba(34, 197, 94, 0.18)",    // emerald
  ];

  // Calculate average tau and d from selected events
  const selectedAverages = useMemo(() => {
    if (selectedEventIndices.size === 0 || fitResults.length === 0) {
      return { avgTau: null, avgD: null, count: 0 };
    }

    const selectedResults = Array.from(selectedEventIndices)
      .map((idx) => fitResults[idx])
      .filter((r) => r && !r.error && r.tau !== undefined && r.d !== undefined);

    if (selectedResults.length === 0) {
      return { avgTau: null, avgD: null, count: 0 };
    }

    const sumTau = selectedResults.reduce((sum, r) => sum + (r.tau || 0), 0);
    const sumD = selectedResults.reduce((sum, r) => sum + (r.d || 0), 0);

    return {
      avgTau: sumTau / selectedResults.length,
      avgD: sumD / selectedResults.length,
      count: selectedResults.length,
    };
  }, [selectedEventIndices, fitResults]);

  // Build a unique-name → color map for transition bands
  const transitionColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const uniqueNames = [...new Set(transitions.map((t) => t.name))];
    uniqueNames.forEach((name, i) => {
      map.set(name, TRANSITION_COLORS[i % TRANSITION_COLORS.length]);
    });
    return map;
  }, [transitions]);

  // Seek video to marker position and render eye ROIs
  useEffect(() => {
    if (markerTime !== null && videoRef.current && videoRef.current.readyState >= 2) {
      videoRef.current.currentTime = markerTime;
    }
  }, [markerTime]);

  // Render eye ROIs on canvas when video frame is ready
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || !showVideo || markerTime === null || trackingFrames.length === 0) {
      return;
    }

    const renderEyeROIs = () => {
      // Find the tracking frame closest to the current marker time
      const frame = trackingFrames.reduce((prev, curr) => {
        const prevDiff = Math.abs((prev.timestamp_sec || 0) - markerTime);
        const currDiff = Math.abs((curr.timestamp_sec || 0) - markerTime);
        return currDiff < prevDiff ? curr : prev;
      });

      // Check if we have ROI data
      if (!frame ||
          frame.left_roi_x0 === undefined ||
          frame.right_roi_x0 === undefined) {
        // If no ROI data, just show the full frame
        const ctx = canvas.getContext('2d');
        if (ctx && video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
        }
        return;
      }

      // Extract ROI coordinates
      const leftROI = {
        x0: frame.left_roi_x0,
        y0: frame.left_roi_y0,
        x1: frame.left_roi_x1,
        y1: frame.left_roi_y1,
      };
      const rightROI = {
        x0: frame.right_roi_x0,
        y0: frame.right_roi_y0,
        x1: frame.right_roi_x1,
        y1: frame.right_roi_y1,
      };

      // Calculate ROI dimensions
      const leftWidth = leftROI.x1 - leftROI.x0;
      const leftHeight = leftROI.y1 - leftROI.y0;
      const rightWidth = rightROI.x1 - rightROI.x0;
      const rightHeight = rightROI.y1 - rightROI.y0;

      // Set canvas size to fit both ROIs side by side
      const padding = 20;
      const maxHeight = Math.max(leftHeight, rightHeight);
      canvas.width = leftWidth + rightWidth + padding * 3;
      canvas.height = maxHeight + padding * 2;

      const ctx = canvas.getContext('2d');
      if (!ctx || video.videoWidth === 0 || video.videoHeight === 0) {
        return;
      }

      // Clear canvas
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw left eye ROI
      ctx.drawImage(
        video,
        leftROI.x0, leftROI.y0, leftWidth, leftHeight,
        padding, padding + (maxHeight - leftHeight) / 2, leftWidth, leftHeight
      );

      // Draw right eye ROI
      ctx.drawImage(
        video,
        rightROI.x0, rightROI.y0, rightWidth, rightHeight,
        leftWidth + padding * 2, padding + (maxHeight - rightHeight) / 2, rightWidth, rightHeight
      );

      // Add labels
      ctx.fillStyle = '#00ff00';
      ctx.font = '14px monospace';
      ctx.fillText('Left Eye', padding + 5, padding + 20);
      ctx.fillText('Right Eye', leftWidth + padding * 2 + 5, padding + 20);
    };

    // Render when video seeks to the new time
    const handleSeeked = () => {
      renderEyeROIs();
    };

    video.addEventListener('seeked', handleSeeked);

    // Also render immediately if video is already at the right time
    if (Math.abs(video.currentTime - markerTime) < 0.1) {
      renderEyeROIs();
    }

    return () => {
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [markerTime, showVideo, trackingFrames]);

  // Handle chart click to set marker
  const handleChartClick = (e: any) => {
    if (e && e.activeLabel !== undefined) {
      const clickedTime = parseFloat(e.activeLabel);
      if (!isNaN(clickedTime)) {
        setMarkerTime(clickedTime);
      }
    }
  };

  async function handleLoadData() {
    if (!selectedSessionId) {
      setError("No session selected");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    setFitResults([]);
    // Clear event lines - they will only appear after clicking "Fit Events"
    setEventTimes([]);
    setSelectedEventIndices(new Set());

    try {
      // Read XY coordinates and timestamps from tracking_data.json
      const result = await readSessionTracking(selectedSessionId, signalType, filterLevel);

      if (!result.ok) {
        setError(result.message ?? "Failed to read tracking data");
        setLoading(false);
        return;
      }

      if (result.data?.error) {
        setError(result.data.error);
        setLoading(false);
        return;
      }

      if (result.data) {
        setTimeData(result.data.time);
        setSignalData(result.data.signal);
        setSignalName(result.data.signal_name);
        setTMax(result.data.max_time);
        setLoadedFilePath(result.filePath || "unknown");
        setMessage(
          `Loaded ${result.data.num_valid} valid points from ${result.data.num_frames} frames`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleFitEvents() {
    if (!selectedSessionId) {
      setError("No session selected");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    setSelectedEventIndices(new Set());

    try {
      // Detect stimuli changes from tracking_data.json and fit exponential curves
      // Uses timestamp_sec for event times and current_frame for stimuli detection
      const result = await detectStimuliAndFit({
        sessionId: selectedSessionId,
        signalType,
        beforeLim,
        afterLim,
        filterLevel,
      });

      if (!result.ok) {
        setError(result.message ?? "Failed to detect stimuli changes");
        setLoading(false);
        return;
      }

      if (result.data?.error) {
        setError(result.data.error);
        setLoading(false);
        return;
      }

      if (result.data) {
        setEventTimes(result.data.event_times);
        setStimuliInfo(result.data.stimuli_info);
        setFitResults(result.data.fit_results);
        setEventsFilePath(result.filePath || "unknown");
        const successCount = result.data.fit_results.filter((r) => !r.error).length;
        const fileMatch = result.filePath === loadedFilePath;
        const debugInfo = result.data.debug_info;
        setMessage(
          `Detected ${result.data.num_events} visual stimuli changes, fitted ${successCount} successfully` +
          (fileMatch ? " ✓" : ` ⚠️ File mismatch!`) +
          (debugInfo ? ` | ${debugInfo.total_frames} frames, ${debugInfo.num_unique_stimuli} unique stimuli` : "")
        );

        // Load transitions (colored bands) after fitting events
        const transitionsResult = await readSessionTransitions(selectedSessionId);
        if (transitionsResult.ok && transitionsResult.data) {
          setTransitions(transitionsResult.data.transitions);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleManualFit() {
    if (!timeData.length || !signalData.length) {
      setError("No data loaded. Please load session data first.");
      return;
    }

    // Parse manual event times
    const manualEvents = manualEventInput
      .split(",")
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !isNaN(n));

    if (manualEvents.length === 0) {
      setError("No valid event times specified");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    setSelectedEventIndices(new Set());

    try {
      const result = await fitRecordingData({
        time: timeData,
        signal: signalData,
        eventTimes: manualEvents,
        beforeLim,
        afterLim,
      });

      if (!result.ok) {
        setError(result.message ?? "Failed to fit data");
        setLoading(false);
        return;
      }

      if (result.data?.error) {
        setError(result.data.error);
        setLoading(false);
        return;
      }

      if (result.data?.results) {
        setEventTimes(manualEvents);
        setFitResults(result.data.results);
        const successCount = result.data.results.filter((r) => !r.error).length;
        setMessage(`Manual fit complete: ${successCount}/${result.data.results.length} events fitted`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleAutoDetectEvents() {
    if (!timeData.length || !signalData.length) {
      setError("No data loaded. Please load session data first.");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    setSelectedEventIndices(new Set());

    try {
      // Calculate differences between consecutive signal points
      const diffs: number[] = [];
      for (let i = 1; i < signalData.length; i++) {
        const diff = Math.abs(signalData[i] - signalData[i - 1]);
        diffs.push(diff);
      }

      // Find indices where the difference exceeds the threshold
      const detectedEventIndices: number[] = [];
      for (let i = 0; i < diffs.length; i++) {
        if (diffs[i] > jumpThreshold) {
          // Check if this is too close to a previous event (avoid duplicates)
          const tooClose = detectedEventIndices.some((prevIdx) => {
            const timeDiff = Math.abs(timeData[i + 1] - timeData[prevIdx + 1]);
            return timeDiff < 0.2; // Minimum 200ms between events
          });
          if (!tooClose) {
            detectedEventIndices.push(i);
          }
        }
      }

      if (detectedEventIndices.length === 0) {
        setError(`No jumps detected above threshold ${jumpThreshold}. Try lowering the threshold.`);
        setLoading(false);
        return;
      }

      // Convert indices to event times
      const detectedEventTimes = detectedEventIndices.map((idx) => timeData[idx + 1]);

      // Fit the detected events
      const result = await fitRecordingData({
        time: timeData,
        signal: signalData,
        eventTimes: detectedEventTimes,
        beforeLim,
        afterLim,
      });

      if (!result.ok) {
        setError(result.message ?? "Failed to fit data");
        setLoading(false);
        return;
      }

      if (result.data?.error) {
        setError(result.data.error);
        setLoading(false);
        return;
      }

      if (result.data?.results) {
        setEventTimes(detectedEventTimes);
        setFitResults(result.data.results);
        const successCount = result.data.results.filter((r) => !r.error).length;
        setMessage(
          `Auto-detected ${detectedEventTimes.length} events (threshold: ${jumpThreshold}), fitted ${successCount} successfully`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!fitResults.length) {
      setError("No results to save. Please run analysis first.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await saveRecordingResults({
        results: fitResults,
        filePath: "recording_analysis_out.csv",
        sessionId: selectedSessionId,
      });

      if (!result.ok) {
        setError(result.message ?? "Failed to save results");
        setLoading(false);
        return;
      }

      if (result.data?.error) {
        setError(result.data.error);
        setLoading(false);
        return;
      }

      if (result.data?.success) {
        setMessage(`Results saved to: ${result.data.path}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleEventSelection(index: number) {
    setSelectedEventIndices((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  }

  function selectAllEvents() {
    setSelectedEventIndices(new Set(eventTimes.map((_, i) => i)));
  }

  function deselectAllEvents() {
    setSelectedEventIndices(new Set());
  }

  function deleteSelectedEvents() {
    if (selectedEventIndices.size === 0) {
      setError("No events selected for deletion");
      return;
    }

    // Filter out selected events
    const newEventTimes = eventTimes.filter((_, i) => !selectedEventIndices.has(i));
    const newFitResults = fitResults.filter((_, i) => !selectedEventIndices.has(i));

    setEventTimes(newEventTimes);
    setFitResults(newFitResults);
    setSelectedEventIndices(new Set());
    setMessage(`Deleted ${selectedEventIndices.size} event(s)`);
  }

  async function handleSaveSelection() {
    if (!selectedSessionId) {
      setError("No session selected");
      return;
    }

    if (selectedEventIndices.size === 0) {
      setError("No events selected to save");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await saveEventSelection({
        sessionId: selectedSessionId,
        eventTimes,
        selectedIndices: Array.from(selectedEventIndices),
      });

      if (!result.ok) {
        setError(result.message || "Failed to save selection");
        setLoading(false);
        return;
      }

      setMessage(`Saved ${selectedEventIndices.size} selected event(s) to ${result.path}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadSelection() {
    if (!selectedSessionId) {
      return;
    }

    try {
      const result = await loadEventSelection(selectedSessionId);

      if (!result.ok || !result.data) {
        // No saved selection found, that's okay
        return;
      }

      // Match saved event times with current event times to get indices
      const savedEventTimes = result.data.eventTimes;
      const savedIndices = new Set<number>();

      savedEventTimes.forEach((savedTime) => {
        const index = eventTimes.findIndex((time) => Math.abs(time - savedTime) < 0.001);
        if (index !== -1) {
          savedIndices.add(index);
        }
      });

      if (savedIndices.size > 0) {
        setSelectedEventIndices(savedIndices);
        setMessage(`Loaded ${savedIndices.size} saved event selection(s)`);
      }
    } catch (err) {
      console.error("Failed to load selection:", err);
      // Don't show error to user, just log it
    }
  }

  // Auto-load data when session or signal type changes
  // This also clears any previous event lines
  useEffect(() => {
    if (selectedSessionId) {
      handleLoadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, signalType, filterLevel]);

  // Auto-load saved selection when events are available
  useEffect(() => {
    if (eventTimes.length > 0 && selectedSessionId) {
      handleLoadSelection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventTimes.length, selectedSessionId]);

  // Load transitions only after "Fit Events" is clicked
  // Transitions are cleared when session or signal type changes
  useEffect(() => {
    // Clear transitions when session changes
    setTransitions([]);
  }, [selectedSessionId]);

  // Load video path and raw tracking data when session changes
  useEffect(() => {
    if (!selectedSessionId) {
      setVideoPath("");
      setTrackingFrames([]);
      return;
    }
    (async () => {
      // Load video path
      const videoResult = await getSessionVideoPath(selectedSessionId);
      if (videoResult.ok && videoResult.path) {
        // Convert file path to media:// protocol URL
        setVideoPath(`media://${videoResult.path}`);
      } else {
        setVideoPath("");
      }

      // Load raw tracking data for gaze lookup
      const trackingResult = await readRawTrackingData(selectedSessionId);
      if (trackingResult.ok && trackingResult.data?.frames) {
        setTrackingFrames(trackingResult.data.frames);
      } else {
        setTrackingFrames([]);
      }
    })();
  }, [selectedSessionId]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Decorative blur orb */}
      <div className="fixed top-20 right-20 w-96 h-96 bg-gradient-to-br from-blue-400/20 via-purple-400/20 to-pink-400/20 rounded-full blur-3xl pointer-events-none" />

      {/* Hidden video element for seeking */}
      {videoPath && (
        <video
          ref={videoRef}
          src={videoPath}
          className="hidden"
          muted
          playsInline
          preload="auto"
        />
      )}

      <div>
        <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 via-blue-900 to-purple-900 bg-clip-text text-transparent">
          Analyze Recording Data
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Load tracking data, detect stimulus changes, and fit exponential curves to eye movement responses
        </p>
      </div>

      {/* Session Selection and Controls */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50 disabled:opacity-50 min-w-[300px]"
            value={selectedSessionId}
            onChange={(e) => setSelectedSessionId(e.target.value)}
            disabled={loading}
          >
            <option value="">Select a session...</option>
            {sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {session.sessionId}
              </option>
            ))}
          </select>
          <button
            className="px-4 py-2 rounded-lg border-2 border-gray-200 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50"
            onClick={handleLoadData}
            disabled={loading || !selectedSessionId}
          >
            {loading ? "Loading..." : "Load Data"}
          </button>
          <button
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 text-white text-sm font-medium hover:from-blue-700 hover:to-purple-700 transition-all shadow-sm disabled:opacity-50"
            onClick={handleFitEvents}
            disabled={loading || !selectedSessionId}
          >
            {loading ? "Fitting..." : "Fit Events"}
          </button>
          <button
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-medium hover:from-emerald-700 hover:to-teal-700 transition-all shadow-sm disabled:opacity-50"
            onClick={handleSave}
            disabled={loading || !fitResults.length}
          >
            {loading ? "Saving..." : "Save to CSV"}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-gradient-to-r from-gray-50 to-white p-4">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">Selected Session</div>
            <div className="mt-1 text-sm font-medium">{selectedSessionId || "No session selected"}</div>
            {loadedFilePath && (
              <div className="mt-1 text-xs text-gray-500 font-mono break-all">
                Data: {loadedFilePath}
              </div>
            )}
            {eventsFilePath && eventsFilePath !== loadedFilePath && (
              <div className="mt-1 text-xs text-red-500 font-mono break-all">
                Events: {eventsFilePath} ⚠️ MISMATCH
              </div>
            )}
          </div>
          <div className="rounded-xl border border-gray-200 bg-gradient-to-r from-gray-50 to-white p-4">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">Data Info</div>
            <div className="mt-1 text-sm">
              Points: <b>{timeData.length}</b>
            </div>
            <div className="text-sm">
              Signal: <b>{signalName}</b>
            </div>
            <div className="text-sm">
              Events: <b>{eventTimes.length}</b>
            </div>
          </div>
        </div>

        {/* Parameter Controls */}
        <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="text-xs text-gray-600">Signal Type</label>
            <select
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              value={signalType}
              onChange={(e) => setSignalType(e.target.value)}
              disabled={loading}
            >
              {SIGNAL_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Filter Level</label>
            <select
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              value={filterLevel}
              onChange={(e) => setFilterLevel(e.target.value)}
              disabled={loading}
            >
              {FILTER_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">
              t<sub>min</sub> (s)
            </label>
            <input
              type="number"
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              value={tMin}
              onChange={(e) => setTMin(Number(e.target.value))}
              step={0.1}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">
              t<sub>max</sub> (s)
            </label>
            <input
              type="number"
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              value={tMax}
              onChange={(e) => setTMax(Number(e.target.value))}
              step={0.1}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Before Event (s)</label>
            <input
              type="number"
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              value={beforeLim}
              onChange={(e) => setBeforeLim(Number(e.target.value))}
              step={0.1}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">After Event (s)</label>
            <input
              type="number"
              className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              value={afterLim}
              onChange={(e) => setAfterLim(Number(e.target.value))}
              step={0.1}
            />
          </div>
        </div>

        {/* Auto-Detect Events */}
        <div className="border-t pt-3">
          <label className="text-xs text-gray-600 block mb-1">Auto-Detect Events (for imported videos without slide markers)</label>
          <div className="flex gap-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600">Jump Threshold:</label>
              <input
                type="number"
                className="w-24 border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
                value={jumpThreshold}
                onChange={(e) => setJumpThreshold(Number(e.target.value))}
                step={5}
                min={5}
                disabled={loading}
              />
            </div>
            <button
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-medium hover:from-orange-600 hover:to-amber-600 transition-all shadow-sm disabled:opacity-50"
              onClick={handleAutoDetectEvents}
              disabled={loading || !timeData.length}
            >
              Auto-Detect & Fit Events
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Detects large jumps in signal as event changes. Increase threshold if too many events detected.
          </p>
        </div>

        {/* Manual Event Input */}
        <div className="border-t pt-3">
          <label className="text-xs text-gray-600 block mb-1">Manual Event Times (comma-separated, in seconds)</label>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-white/50"
              placeholder="e.g., 1.5, 3.2, 5.8, 10.1"
              value={manualEventInput}
              onChange={(e) => setManualEventInput(e.target.value)}
              disabled={loading}
            />
            <button
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 text-white text-sm font-medium hover:from-purple-700 hover:to-pink-700 transition-all shadow-sm disabled:opacity-50"
              onClick={handleManualFit}
              disabled={loading || !timeData.length}
            >
              Fit Manual Events
            </button>
          </div>
        </div>

        {error && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {message && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>
        )}
      </div>

      {/* Main Chart */}
      {mainChartData.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
          <div className="text-sm font-medium mb-2">
            {signalName} Signal
            {eventTimes.length > 0 && (
              <span className="ml-2 text-xs text-gray-500">({eventTimes.length} detected events)</span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={mainChartData} onClick={handleChartClick}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                label={{ value: "Time (s)", position: "insideBottom", offset: -5 }}
                domain={[tMin, tMax]}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <YAxis
                label={{ value: "Signal", angle: -90, position: "insideLeft" }}
                domain={[yRange.min, yRange.max]}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <Tooltip formatter={(value: number) => value.toFixed(2)} />
              {transitions
                .filter((t) => t.endTime >= tMin && t.startTime <= tMax)
                .map((t, idx) => (
                  <ReferenceArea
                    key={`band-${idx}`}
                    x1={Math.max(t.startTime, tMin)}
                    x2={Math.min(t.endTime, tMax)}
                    fill={transitionColorMap.get(t.name) || "rgba(0,0,0,0.05)"}
                    fillOpacity={1}
                  />
                ))}
              <Line type="monotone" dataKey="signal" stroke="#2563eb" dot={false} strokeWidth={1.5} />
              {eventTimes.map((eventTime, idx) => (
                <ReferenceLine
                  key={`event-${idx}`}
                  x={eventTime}
                  stroke={selectedEventIndices.has(idx) ? "#f59e0b" : "#dc2626"}
                  strokeWidth={selectedEventIndices.has(idx) ? 3 : 2}
                  strokeDasharray="3 3"
                />
              ))}
              {markerTime !== null && (
                <ReferenceLine x={markerTime} stroke="#10b981" strokeWidth={3} label="Marker" />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Event Management */}
      {eventTimes.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Detected Events
              <span className="ml-2 text-xs text-gray-500 normal-case tracking-normal">
                ({eventTimes.length} total, {selectedEventIndices.size} selected)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAllEvents}
                className="px-3 py-1.5 rounded-lg border-2 border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 transition-all"
              >
                Select All
              </button>
              <button
                onClick={deselectAllEvents}
                className="px-3 py-1.5 rounded-lg border-2 border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 transition-all"
              >
                Deselect All
              </button>
              <button
                onClick={deleteSelectedEvents}
                disabled={selectedEventIndices.size === 0}
                className="px-3 py-1.5 rounded-lg border-2 border-red-200 bg-white text-xs font-medium text-red-600 hover:bg-red-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Delete Selected
              </button>
              <button
                onClick={handleSaveSelection}
                disabled={selectedEventIndices.size === 0 || loading}
                className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 text-white text-xs font-medium hover:from-blue-700 hover:to-purple-700 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Saving..." : "Save Selection"}
              </button>
            </div>
          </div>
          <div className="p-3 max-h-[300px] overflow-auto">
            <table className="min-w-full text-xs border">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 sticky top-0">
                <tr>
                  <th className="px-2 py-1 border text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    <input
                      type="checkbox"
                      checked={selectedEventIndices.size === eventTimes.length && eventTimes.length > 0}
                      onChange={(e) => e.target.checked ? selectAllEvents() : deselectAllEvents()}
                      className="rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </th>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">#</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Time (s)</th>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {eventTimes.map((eventTime, idx) => (
                  <tr
                    key={idx}
                    className={`transition-colors cursor-pointer ${
                      selectedEventIndices.has(idx) ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-blue-50/30'
                    }`}
                    onClick={() => toggleEventSelection(idx)}
                  >
                    <td className="px-2 py-1 border text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedEventIndices.has(idx)}
                        onChange={() => toggleEventSelection(idx)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-2 py-1 border">{idx + 1}</td>
                    <td className="px-2 py-1 border text-right font-mono">{eventTime.toFixed(3)}</td>
                    <td className="px-2 py-1 border text-left">
                      {fitResults[idx] ? (
                        fitResults[idx].error ? (
                          <span className="text-red-600 text-xs">{fitResults[idx].error}</span>
                        ) : (
                          <span className="text-green-600 text-xs">Fitted</span>
                        )
                      ) : (
                        <span className="text-gray-400 text-xs">Not fitted</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Video Player Section */}
      {mainChartData.length > 0 && videoPath && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">Eye ROI Preview</div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showVideo}
                onChange={(e) => setShowVideo(e.target.checked)}
                className="rounded"
              />
              Show Video
            </label>
          </div>

          {showVideo && (
            <div className="space-y-2">
              <div className="text-xs text-gray-600">
                {markerTime !== null ? (
                  <span>Showing eye ROIs at: {markerTime.toFixed(3)}s (Click on chart to change position)</span>
                ) : (
                  <span>Click on the chart above to select a timestamp</span>
                )}
              </div>
              <canvas
                ref={canvasRef}
                className="w-full h-auto rounded bg-black"
                style={{ maxHeight: 400 }}
              />
            </div>
          )}
        </div>
      )}

      {/* Stimuli Timeline */}
      {transitions.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Stimuli Timeline
              <span className="ml-2 text-xs text-gray-500 normal-case tracking-normal">({transitions.length} segments)</span>
            </div>
          </div>
          <div className="p-3 max-h-[350px] overflow-auto">
            <table className="min-w-full text-xs border">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 sticky top-0">
                <tr>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">#</th>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Stimulus</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Start Time (s)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">End Time (s)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Duration (s)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Frames</th>
                  <th className="px-2 py-1 border text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Color</th>
                </tr>
              </thead>
              <tbody>
                {transitions.map((t, idx) => (
                  <tr key={idx} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-2 py-1 border">{idx + 1}</td>
                    <td className="px-2 py-1 border text-left font-mono text-xs">{t.name}</td>
                    <td className="px-2 py-1 border text-right">{t.startTime.toFixed(3)}</td>
                    <td className="px-2 py-1 border text-right">{t.endTime.toFixed(3)}</td>
                    <td className="px-2 py-1 border text-right font-semibold">{t.duration.toFixed(3)}</td>
                    <td className="px-2 py-1 border text-right">{t.startFrame}–{t.endFrame}</td>
                    <td className="px-2 py-1 border text-center">
                      <span
                        className="inline-block w-4 h-4 rounded"
                        style={{ backgroundColor: (transitionColorMap.get(t.name) || "#eee").replace(/0\.10\)/, "0.4)") }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Visual Stimuli Changes (from Auto-Fit) */}
      {stimuliInfo.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">Visual Stimuli Changes (Detected)</div>
          </div>
          <div className="p-3 max-h-[300px] overflow-auto">
            <table className="min-w-full text-xs border">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 sticky top-0">
                <tr>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">#</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Frame</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Time (s)</th>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">From</th>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">To</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Slide Change</th>
                </tr>
              </thead>
              <tbody>
                {stimuliInfo.map((info, idx) => (
                  <tr key={idx} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-2 py-1 border">{idx + 1}</td>
                    <td className="px-2 py-1 border text-right">{info.frame}</td>
                    <td className="px-2 py-1 border text-right">{info.time.toFixed(3)}</td>
                    <td className="px-2 py-1 border text-left font-mono text-xs">{info.from_frame || info.from_filename}</td>
                    <td className="px-2 py-1 border text-left font-mono text-xs">{info.to_frame || info.to_filename}</td>
                    <td className="px-2 py-1 border text-right">
                      {info.from_slide} → {info.to_slide}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fitted Parameters Results */}
      {fitResults.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">Fitted Parameters</div>
          </div>
          <div className="p-3 max-h-[500px] overflow-auto">
            <table className="min-w-full text-xs border">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 sticky top-0">
                <tr>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">#</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Event Time (s)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">a (baseline)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">b (amplitude)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">τ (tau)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">d (delay)</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Fit Before</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Fit During</th>
                  <th className="px-2 py-1 border text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Fit After</th>
                  <th className="px-2 py-1 border text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {fitResults.map((result, idx) => (
                  <tr key={idx} className={result.error ? "bg-red-50" : "hover:bg-blue-50/30 transition-colors"}>
                    <td className="px-2 py-1 border">{idx + 1}</td>
                    <td className="px-2 py-1 border text-right">{result.event_time.toFixed(3)}</td>
                    <td className="px-2 py-1 border text-right">
                      {result.a !== undefined ? result.a.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-right">
                      {result.b !== undefined ? result.b.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-right">
                      {result.tau !== undefined ? result.tau.toFixed(4) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-right">
                      {result.d !== undefined ? result.d.toFixed(4) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-right">
                      {result.fit_before !== undefined ? result.fit_before.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-right">
                      {result.fit_during !== undefined ? result.fit_during.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-right">
                      {result.fit_after !== undefined ? result.fit_after.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 border text-left">
                      {result.error ? (
                        <span className="text-red-600">{result.error}</span>
                      ) : (
                        <span className="text-green-600">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail Plots with Fitted Curves */}
      {fitResults.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">Detail Views with Fitted Curves</div>
            {selectedEventIndices.size > 0 && selectedAverages.count > 0 && (
              <div className="flex items-center gap-4 text-xs">
                <div className="bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200 rounded-lg px-3 py-2">
                  <span className="text-gray-600">Average τ (selected):</span>{" "}
                  <span className="font-mono font-semibold text-blue-700">
                    {selectedAverages.avgTau?.toFixed(4)}
                  </span>
                  <span className="text-gray-500 ml-1">({selectedAverages.count} events)</span>
                </div>
                <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <span className="text-gray-600">Average d (selected):</span>{" "}
                  <span className="font-mono font-semibold text-emerald-700">
                    {selectedAverages.avgD?.toFixed(4)}
                  </span>
                  <span className="text-gray-500 ml-1">({selectedAverages.count} events)</span>
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {fitResults.slice(0, 24).map((result, idx) => {
              if (!result.t_fit || !result.s_original || !result.s_fitted) {
                return (
                  <div key={idx} className="border rounded-lg p-2 bg-gray-50">
                    <div className="text-xs text-center text-gray-500">Event {idx + 1}</div>
                    <div className="text-xs text-center text-red-500">{result.error || "No data"}</div>
                  </div>
                );
              }

              const chartData = result.t_fit.map((t, i) => ({
                time: t + result.event_time,
                original: result.s_original![i],
                fitted: result.s_fitted![i],
              }));

              return (
                <div key={idx} className="border rounded-lg p-2">
                  <div className="text-xs text-center mb-1">Event {idx + 1}</div>
                  <ResponsiveContainer width="100%" height={150}>
                    <LineChart data={chartData}>
                      <XAxis dataKey="time" tick={false} />
                      <YAxis hide />
                      <Line type="monotone" dataKey="original" stroke="#2563eb" dot={false} strokeWidth={1} />
                      <Line type="monotone" dataKey="fitted" stroke="#22c55e" dot={false} strokeWidth={2} />
                      <ReferenceLine x={result.event_time} stroke="#dc2626" strokeWidth={1} strokeDasharray="2 2" />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="text-xs text-center text-gray-500 mt-1">
                    τ={result.tau?.toFixed(3)} d={result.d?.toFixed(3)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
