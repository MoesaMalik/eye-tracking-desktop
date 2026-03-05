import { useEffect, useState, useMemo } from "react";
import {
  listSessions,
  readSessionTracking,
  detectAndFitEvents,
  fitRecordingData,
  saveRecordingResults,
  getRecordingPath,
  type FitResult,
  type SessionInfo,
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
} from "recharts";

const SIGNAL_TYPES = [
  { value: "gaze_x", label: "Gaze X (Horizontal)" },
  { value: "gaze_y", label: "Gaze Y (Vertical)" },
  { value: "left_x", label: "Left Eye X" },
  { value: "left_y", label: "Left Eye Y" },
  { value: "right_x", label: "Right Eye X" },
  { value: "right_y", label: "Right Eye Y" },
];

export default function AnalyzeVideo() {
  // Session and data state
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [signalType, setSignalType] = useState<string>("gaze_x");
  const [timeData, setTimeData] = useState<number[]>([]);
  const [signalData, setSignalData] = useState<number[]>([]);
  const [signalName, setSignalName] = useState<string>("");

  // Analysis parameters
  const [tMin, setTMin] = useState<number>(0);
  const [tMax, setTMax] = useState<number>(60);
  const [beforeLim, setBeforeLim] = useState<number>(0.5);
  const [afterLim, setAfterLim] = useState<number>(1.0);
  const [thresholdFactor, setThresholdFactor] = useState<number>(2.0);
  const [minDistance, setMinDistance] = useState<number>(30);

  // Event detection state
  const [eventTimes, setEventTimes] = useState<number[]>([]);
  const [manualEventInput, setManualEventInput] = useState<string>("");

  // Results state
  const [fitResults, setFitResults] = useState<FitResult[]>([]);

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

  async function handleLoadData() {
    if (!selectedSessionId) {
      setError("No session selected");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    setFitResults([]);
    setEventTimes([]);

    try {
      const result = await readSessionTracking(selectedSessionId, signalType);

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

  async function handleDetectEvents() {
    if (!timeData.length || !signalData.length) {
      setError("No data loaded. Please load session data first.");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const result = await detectAndFitEvents({
        time: timeData,
        signal: signalData,
        beforeLim,
        afterLim,
        thresholdFactor,
        minDistance,
      });

      if (!result.ok) {
        setError(result.message ?? "Failed to detect events");
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
        setFitResults(result.data.fit_results);
        const successCount = result.data.fit_results.filter((r) => !r.error).length;
        setMessage(
          `Detected ${result.data.num_events} events, fitted ${successCount} successfully`
        );
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

  // Auto-load data when session or signal type changes
  useEffect(() => {
    if (selectedSessionId) {
      handleLoadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, signalType]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Analyze Recording Data</h1>
        <p className="text-sm text-gray-600">
          Load tracking data from recorded sessions, detect eye movement events, fit exponential curves, and extract
          parameters.
        </p>
      </div>

      {/* Session Selection and Controls */}
      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50 min-w-[300px]"
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
            className="px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            onClick={handleLoadData}
            disabled={loading || !selectedSessionId}
          >
            {loading ? "Loading..." : "Load Data"}
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-blue-500 text-white disabled:opacity-50"
            onClick={handleDetectEvents}
            disabled={loading || !timeData.length}
          >
            {loading ? "Detecting..." : "Auto-Detect Events"}
          </button>
          <button
            className="px-3 py-1.5 rounded border bg-green-500 text-white disabled:opacity-50"
            onClick={handleSave}
            disabled={loading || !fitResults.length}
          >
            {loading ? "Saving..." : "Save to CSV"}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded border bg-gray-50 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Selected Session</div>
            <div className="mt-1 text-sm font-medium">{selectedSessionId || "No session selected"}</div>
            {selectedSessionId && (
              <div className="mt-1 text-xs text-gray-500">{getRecordingPath(selectedSessionId)}</div>
            )}
          </div>
          <div className="rounded border bg-gray-50 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500">Data Info</div>
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
              className="w-full px-2 py-1 text-sm border rounded"
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
            <label className="text-xs text-gray-600">
              t<sub>min</sub> (s)
            </label>
            <input
              type="number"
              className="w-full px-2 py-1 text-sm border rounded"
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
              className="w-full px-2 py-1 text-sm border rounded"
              value={tMax}
              onChange={(e) => setTMax(Number(e.target.value))}
              step={0.1}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Before Event (s)</label>
            <input
              type="number"
              className="w-full px-2 py-1 text-sm border rounded"
              value={beforeLim}
              onChange={(e) => setBeforeLim(Number(e.target.value))}
              step={0.1}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">After Event (s)</label>
            <input
              type="number"
              className="w-full px-2 py-1 text-sm border rounded"
              value={afterLim}
              onChange={(e) => setAfterLim(Number(e.target.value))}
              step={0.1}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Threshold</label>
            <input
              type="number"
              className="w-full px-2 py-1 text-sm border rounded"
              value={thresholdFactor}
              onChange={(e) => setThresholdFactor(Number(e.target.value))}
              step={0.1}
            />
          </div>
        </div>

        {/* Manual Event Input */}
        <div className="border-t pt-3">
          <label className="text-xs text-gray-600 block mb-1">Manual Event Times (comma-separated, in seconds)</label>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 px-2 py-1 text-sm border rounded"
              placeholder="e.g., 1.5, 3.2, 5.8, 10.1"
              value={manualEventInput}
              onChange={(e) => setManualEventInput(e.target.value)}
              disabled={loading}
            />
            <button
              className="px-3 py-1 rounded border bg-purple-500 text-white disabled:opacity-50"
              onClick={handleManualFit}
              disabled={loading || !timeData.length}
            >
              Fit Manual Events
            </button>
          </div>
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {message && (
          <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>
        )}
      </div>

      {/* Main Chart */}
      {mainChartData.length > 0 && (
        <div className="rounded-lg border bg-white p-4">
          <div className="text-sm font-medium mb-2">
            {signalName} Signal
            {eventTimes.length > 0 && (
              <span className="ml-2 text-xs text-gray-500">({eventTimes.length} detected events)</span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={mainChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                label={{ value: "Time (s)", position: "insideBottom", offset: -5 }}
                domain={[tMin, tMax]}
              />
              <YAxis label={{ value: "Signal", angle: -90, position: "insideLeft" }} domain={[yRange.min, yRange.max]} />
              <Tooltip />
              <Line type="monotone" dataKey="signal" stroke="#2563eb" dot={false} strokeWidth={1} />
              {eventTimes.map((eventTime, idx) => (
                <ReferenceLine key={idx} x={eventTime} stroke="#dc2626" strokeWidth={2} strokeDasharray="3 3" />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Fitted Parameters Results */}
      {fitResults.length > 0 && (
        <div className="rounded-lg border bg-white">
          <div className="px-3 py-2 border-b text-sm font-medium">Fitted Parameters</div>
          <div className="p-3 max-h-[500px] overflow-auto">
            <table className="min-w-full text-xs border">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-2 py-1 border text-left">#</th>
                  <th className="px-2 py-1 border text-right">Event Time (s)</th>
                  <th className="px-2 py-1 border text-right">a (baseline)</th>
                  <th className="px-2 py-1 border text-right">b (amplitude)</th>
                  <th className="px-2 py-1 border text-right">τ (tau)</th>
                  <th className="px-2 py-1 border text-right">d (delay)</th>
                  <th className="px-2 py-1 border text-right">Fit Before</th>
                  <th className="px-2 py-1 border text-right">Fit During</th>
                  <th className="px-2 py-1 border text-right">Fit After</th>
                  <th className="px-2 py-1 border text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {fitResults.map((result) => (
                  <tr key={result.index} className={result.error ? "bg-red-50" : ""}>
                    <td className="px-2 py-1 border">{result.index}</td>
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
        <div className="rounded-lg border bg-white p-4">
          <div className="text-sm font-medium mb-3">Detail Views with Fitted Curves</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {fitResults.slice(0, 24).map((result, idx) => {
              if (!result.t_fit || !result.s_original || !result.s_fitted) {
                return (
                  <div key={idx} className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-center text-gray-500">Event {idx}</div>
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
                <div key={idx} className="border rounded p-2">
                  <div className="text-xs text-center mb-1">Event {idx}</div>
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
