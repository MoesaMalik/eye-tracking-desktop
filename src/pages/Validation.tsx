// src/pages/Validation.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
    startGazeStream,
    stopGazeStream,
    subscribeGazeStream,
    type GazeUpdate,
} from "../lib/tracker";
import {
    predictScreen,
    nearestTarget,
    GazeBuffer,
    type AffineModel,
    type CalibrationTarget,
} from "../lib/calibration-utils";
import {
    getCalibrationTargets,
    generateValidationSequence,
} from "../lib/calibration-targets";

type ValidationTrial = {
    trial_num: number;
    actual_target: CalibrationTarget;
    gaze_avg: { x: number; y: number } | null;
    predicted_screen: { x: number; y: number } | null;
    classified_target: CalibrationTarget | null;
    correct: boolean;
    valid: boolean; // NEW: track if trial had sufficient samples
    error_px: number | null;
    n_samples: number;
    duration_ms: number;
};

type ValidationState = "idle" | "ready" | "running" | "completed" | "error";
type BaselineComparison = {
    baseline: {
        accuracy: number | null;
        mean_error_px: number | null;
        median_error_px: number | null;
        worst_error_px: number | null;
        valid_count: number | null;
    };
    current: {
        accuracy: number | null;
        mean_error_px: number | null;
        median_error_px: number | null;
        worst_error_px: number | null;
        valid_count: number | null;
    };
    delta: {
        accuracy: number | null;
        mean_error_px: number | null;
        median_error_px: number | null;
        worst_error_px: number | null;
        valid_count: number | null;
    };
};

const TRIAL_DURATION_MS = 1500;
const SCORING_WINDOW_MS = 500;
const MIN_SAMPLES = 5;
const NUM_TRIALS = 20;

function invokeIpc(channel: string, payload?: unknown) {
    if (window.nativeApi?.invoke) return window.nativeApi.invoke(channel, payload);
    if (window.ipcRenderer?.invoke) return window.ipcRenderer.invoke(channel, payload);
    return Promise.resolve({ ok: false, error: "IPC not available" });
}

function formatSigned(val: number | null, digits = 1) {
    if (val === null || Number.isNaN(val)) return "-";
    const sign = val > 0 ? "+" : "";
    return `${sign}${val.toFixed(digits)}`;
}

export default function Validation() {
    const [params] = useSearchParams();
    const sessionId = params.get("session") || "";

    const [state, setState] = useState<ValidationState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [model, setModel] = useState<AffineModel | null>(null);
    const [targets] = useState<CalibrationTarget[]>(() => getCalibrationTargets());
    const [sequence, setSequence] = useState<CalibrationTarget[]>([]);
    const [trials, setTrials] = useState<ValidationTrial[]>([]);
    const [baselineReport, setBaselineReport] = useState<any | null>(null);
    const [baselineComparison, setBaselineComparison] = useState<BaselineComparison | null>(null);
    const [usingBaselineSequence, setUsingBaselineSequence] = useState(false);
    const [currentTrialNum, setCurrentTrialNum] = useState(0);
    const [_liveGaze, setLiveGaze] = useState<{ x: number; y: number } | null>(null);
    const [livePredicted, setLivePredicted] = useState<{ x: number; y: number } | null>(null);
    const [liveClassified, setLiveClassified] = useState<CalibrationTarget | null>(null);

    const gazeBuffer = useRef<GazeBuffer>(new GazeBuffer());
    const trialStartTime = useRef<number>(0);
    const trialTimer = useRef<number | null>(null);
    const unsubscribeGaze = useRef<(() => void) | null>(null);

    // Load calibration model
    useEffect(() => {
        if (!sessionId) return;

        invokeIpc("recordings:readJson", {
            sessionId,
            filename: "calibration_model.json",
        }).then((res: { ok: boolean; data?: AffineModel; error?: string }) => {
            if (res.ok && res.data) {
                setModel(res.data);
                setState("idle");
            } else {
                setError(res.error || "Failed to load calibration model");
                setState("error");
            }
        });

        invokeIpc("recordings:readJson", {
            sessionId,
            filename: "validation_baseline.json",
        }).then((res: { ok: boolean; data?: any }) => {
            if (res.ok && res.data) {
                setBaselineReport(res.data);
            }
        });
    }, [sessionId]);

    // Subscribe to gaze stream
    useEffect(() => {
        if (state !== "ready" && state !== "running") return;

        const unsub = subscribeGazeStream((payload: GazeUpdate) => {
            if (payload.type === "gaze" && payload.gaze_x !== null && payload.gaze_y !== null) {
                const t = payload.timestamp;
                gazeBuffer.current.add(payload.gaze_x, payload.gaze_y, t);

                // Update live gaze display
                setLiveGaze({ x: payload.gaze_x, y: payload.gaze_y });

                // Predict and classify
                if (model) {
                    const pred = predictScreen(model, payload.gaze_x, payload.gaze_y);
                    setLivePredicted(pred);

                    const { best } = nearestTarget(pred, targets);
                    setLiveClassified(best);
                }
            }
        });

        unsubscribeGaze.current = unsub;
        return () => unsub();
    }, [state, model, targets]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (trialTimer.current) window.clearTimeout(trialTimer.current);
            if (unsubscribeGaze.current) unsubscribeGaze.current();
            stopGazeStream().catch(() => { });
        };
    }, []);

    const startValidation = useCallback(async () => {
        if (!model) {
            setError("Model not loaded");
            return;
        }

        setState("ready");
        setError(null);
        setTrials([]);
        setCurrentTrialNum(0);
        setBaselineComparison(null);

        const baselineSeq =
            baselineReport?.trials?.length === NUM_TRIALS
                ? baselineReport.trials.map((t: ValidationTrial) => t.actual_target)
                : null;

        // Use baseline sequence if available to compare runs
        const seq = baselineSeq ?? generateValidationSequence(NUM_TRIALS, targets);
        setSequence(seq);
        setUsingBaselineSequence(!!baselineSeq);

        // Start gaze stream
        const res = await startGazeStream({ fps: 30 });
        if (!res.ok) {
            setError(`Failed to start gaze stream: ${res.message}`);
            setState("error");
            return;
        }

        // Wait a moment for stream to initialize
        setTimeout(() => {
            setState("running");
            runTrial(0, seq);
        }, 1000);
    }, [model, targets, baselineReport]);

    const runTrial = useCallback(
        (trialNum: number, seq: CalibrationTarget[]) => {
            if (trialNum >= NUM_TRIALS) {
                // All trials completed
                finishValidation();
                return;
            }

            const target = seq[trialNum];
            setCurrentTrialNum(trialNum);

            // FIX 3: Clear state at trial start to prevent flashing
            setLivePredicted(null);
            setLiveClassified(null);

            gazeBuffer.current.clear();
            trialStartTime.current = Date.now();

            // Schedule scoring after TRIAL_DURATION_MS
            trialTimer.current = window.setTimeout(() => {
                scoreTrial(trialNum, target, seq);
            }, TRIAL_DURATION_MS);
        },
        []
    );

    const scoreTrial = useCallback(
        (trialNum: number, target: CalibrationTarget, seq: CalibrationTarget[]) => {
            const trialEndTime = Date.now();
            const duration_ms = trialEndTime - trialStartTime.current;

            // FIX 2.3: Use precise end time for scoring window
            const avg = gazeBuffer.current.getAverageAt(trialEndTime, SCORING_WINDOW_MS, MIN_SAMPLES);

            let trial: ValidationTrial;

            if (avg && model) {
                // Valid trial with sufficient samples
                const predicted = predictScreen(model, avg.gx, avg.gy);
                const { best, dist } = nearestTarget(predicted, targets);

                // FIX 2.1: Use canonical ID comparison (raw_x-raw_y)
                const actualId = `${target.raw_x}-${target.raw_y}`;
                const classifiedId = `${best.raw_x}-${best.raw_y}`;
                const correct = actualId === classifiedId;

                // STEP 1: Debug log for verification
                console.log("[validation-score]", {
                    trialNum: trialNum + 1,
                    actual: {
                        filename: target.filename,
                        id: actualId,
                        raw: { x: target.raw_x, y: target.raw_y }
                    },
                    avg: { gx: avg.gx, gy: avg.gy, n: avg.n },
                    predictedRaw: predicted,
                    classified: {
                        filename: best.filename,
                        id: classifiedId,
                        raw: { x: best.raw_x, y: best.raw_y },
                        distPx: dist
                    },
                    correct
                });

                trial = {
                    trial_num: trialNum + 1,
                    actual_target: target,
                    gaze_avg: { x: avg.gx, y: avg.gy },
                    predicted_screen: predicted,
                    classified_target: best,
                    correct,
                    valid: true, // FIX 2.4: Mark as valid
                    error_px: dist,
                    n_samples: avg.n,
                    duration_ms,
                };
            } else {
                // FIX 2.4: Invalid trial (insufficient samples)
                console.log("[validation-score]", {
                    trialNum: trialNum + 1,
                    actual: {
                        filename: target.filename,
                        id: `${target.raw_x}-${target.raw_y}`,
                        raw: { x: target.raw_x, y: target.raw_y }
                    },
                    avg: null,
                    reason: "insufficient samples",
                    n_samples: avg?.n || 0
                });

                trial = {
                    trial_num: trialNum + 1,
                    actual_target: target,
                    gaze_avg: null,
                    predicted_screen: null,
                    classified_target: null,
                    correct: false,
                    valid: false, // FIX 2.4: Mark as invalid
                    error_px: null,
                    n_samples: avg?.n || 0,
                    duration_ms,
                };
            }

            setTrials((prev) => [...prev, trial]);

            // Move to next trial
            setTimeout(() => {
                runTrial(trialNum + 1, seq);
            }, 200);
        },
        [model, targets, runTrial]
    );

    const finishValidation = useCallback(async () => {
        setState("completed");
        await stopGazeStream();

        // Save validation report - FIX 2.4: Use valid trials only
        if (sessionId && trials.length > 0) {
            const validTrials = trials.filter((t) => t.valid);
            const correctTrials = validTrials.filter((t) => t.correct);
            const errorValues = validTrials
                .filter((t) => t.error_px !== null)
                .map((t) => t.error_px!);

            const meanError =
                errorValues.length > 0
                    ? errorValues.reduce((sum, e) => sum + e, 0) / errorValues.length
                    : null;
            const medianError =
                errorValues.length > 0
                    ? errorValues.sort((a, b) => a - b)[Math.floor(errorValues.length / 2)]
                    : null;
            const worstError = errorValues.length > 0 ? Math.max(...errorValues) : null;
            const worstTrialNum =
                worstError !== null
                    ? trials.find((t) => t.error_px === worstError)?.trial_num
                    : null;

            const currentSummary = {
                accuracy: validTrials.length > 0 ? correctTrials.length / validTrials.length : 0,
                mean_error_px: meanError,
                median_error_px: medianError,
                worst_error_px: worstError,
                valid_count: validTrials.length,
            };

            let baselineStats: BaselineComparison | null = null;
            if (baselineReport && usingBaselineSequence) {
                const baselineSummary = baselineReport.summary || {};
                const baselineAccuracy =
                    typeof baselineSummary.accuracy === "number"
                        ? baselineSummary.accuracy
                        : null;
                const baselineMean =
                    typeof baselineSummary.mean_error_px === "number"
                        ? baselineSummary.mean_error_px
                        : null;
                const baselineMedian =
                    typeof baselineSummary.median_error_px === "number"
                        ? baselineSummary.median_error_px
                        : null;
                const baselineWorst =
                    typeof baselineSummary.worst_error_px === "number"
                        ? baselineSummary.worst_error_px
                        : null;
                const baselineValid =
                    typeof baselineSummary.valid_count === "number"
                        ? baselineSummary.valid_count
                        : null;

                baselineStats = {
                    baseline: {
                        accuracy: baselineAccuracy,
                        mean_error_px: baselineMean,
                        median_error_px: baselineMedian,
                        worst_error_px: baselineWorst,
                        valid_count: baselineValid,
                    },
                    current: currentSummary,
                    delta: {
                        accuracy:
                            baselineAccuracy === null ? null : currentSummary.accuracy - baselineAccuracy,
                        mean_error_px:
                            baselineMean === null || currentSummary.mean_error_px === null
                                ? null
                                : currentSummary.mean_error_px - baselineMean,
                        median_error_px:
                            baselineMedian === null || currentSummary.median_error_px === null
                                ? null
                                : currentSummary.median_error_px - baselineMedian,
                        worst_error_px:
                            baselineWorst === null || currentSummary.worst_error_px === null
                                ? null
                                : currentSummary.worst_error_px - baselineWorst,
                        valid_count:
                            baselineValid === null ? null : currentSummary.valid_count - baselineValid,
                    },
                };
                setBaselineComparison(baselineStats);
            }

            const report = {
                session_id: sessionId,
                model_file: "calibration_model.json",
                timestamp: new Date().toISOString(),
                num_trials: NUM_TRIALS,
                trials,
                summary: {
                    accuracy: currentSummary.accuracy,
                    correct_count: correctTrials.length,
                    valid_count: currentSummary.valid_count,
                    mean_error_px: currentSummary.mean_error_px,
                    median_error_px: currentSummary.median_error_px,
                    worst_error_px: currentSummary.worst_error_px,
                    worst_trial_num: worstTrialNum,
                },
                baseline: baselineReport
                    ? { file: "validation_baseline.json", timestamp: baselineReport.timestamp }
                    : { file: "validation_baseline.json", created: true },
                baseline_comparison: baselineStats,
            };

            await invokeIpc("session:write-json", {
                filePath: `recordings/${sessionId}/validation_report.json`,
                data: report,
            });

            if (!baselineReport) {
                await invokeIpc("session:write-json", {
                    filePath: `recordings/${sessionId}/validation_baseline.json`,
                    data: report,
                });
                setBaselineReport(report);
            }
        }
    }, [sessionId, trials, baselineReport, usingBaselineSequence]);

    const reset = useCallback(() => {
        setState("idle");
        setTrials([]);
        setCurrentTrialNum(0);
        setSequence([]);
        setLiveGaze(null);
        setLivePredicted(null);
        setLiveClassified(null);
        setBaselineComparison(null);
        setUsingBaselineSequence(false);
    }, []);

    // Current trial target
    const currentTarget = sequence[currentTrialNum];

    // Summary stats (running) - FIX 2.4: Use valid trials only
    const validTrialsSoFar = trials.filter((t) => t.valid);
    const correctSoFar = validTrialsSoFar.filter((t) => t.correct).length;
    const accuracySoFar = validTrialsSoFar.length > 0 ? correctSoFar / validTrialsSoFar.length : 0;

    const errorsSoFar = trials.filter((t) => t.error_px !== null).map((t) => t.error_px!);
    const meanErrorSoFar =
        errorsSoFar.length > 0
            ? errorsSoFar.reduce((sum, e) => sum + e, 0) / errorsSoFar.length
            : null;

    // Final summary - FIX 2.4: Use valid trials only
    const summary = useMemo(() => {
        if (state !== "completed") return null;

        const validTrials = trials.filter((t) => t.valid);
        const correctTrials = validTrials.filter((t) => t.correct);
        const errorValues = validTrials.filter((t) => t.error_px !== null).map((t) => t.error_px!);

        const meanError =
            errorValues.length > 0
                ? errorValues.reduce((sum, e) => sum + e, 0) / errorValues.length
                : null;
        const medianError =
            errorValues.length > 0
                ? errorValues.sort((a, b) => a - b)[Math.floor(errorValues.length / 2)]
                : null;
        const worstError = errorValues.length > 0 ? Math.max(...errorValues) : null;

        return {
            accuracy: validTrials.length > 0 ? correctTrials.length / validTrials.length : 0,
            correct_count: correctTrials.length,
            valid_count: validTrials.length,
            mean_error_px: meanError,
            median_error_px: medianError,
            worst_error_px: worstError,
        };
    }, [state, trials]);

    if (!sessionId) {
        return (
            <div className="space-y-4">
                <h1 className="text-xl font-semibold">Validation</h1>
                <div className="rounded-lg border bg-white p-4 text-sm text-gray-600">
                    No session ID provided. Please navigate from Calibration Results.
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-semibold">Calibration Validation</h1>
                <Link
                    to={`/calibration-results?session=${sessionId}`}
                    className="px-3 py-1.5 border rounded bg-white text-sm"
                >
                    ← Back to Results
                </Link>
            </div>

            <div className="rounded-lg border bg-white p-3">
                <div className="text-sm text-gray-600">
                    Session: <span className="font-medium">{sessionId}</span>
                </div>
            </div>

            {error && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </div>
            )}

            {state === "idle" && model && (
                <div className="space-y-3">
                    <div className="rounded-lg border bg-white p-4">
                        <div className="text-sm text-gray-600">
                            This validation will show 20 random calibration targets. Your gaze will be
                            tracked in real-time, predicted using the calibration model, and classified.
                        </div>
                        <div className="mt-3 text-xs text-gray-500">
                            • Each target displays for {TRIAL_DURATION_MS}ms
                            <br />
                            • Gaze averaged over last {SCORING_WINDOW_MS}ms
                            <br />• Minimum {MIN_SAMPLES} samples required per trial
                        </div>
                        {baselineReport && (
                            <div className="mt-3 text-xs text-gray-500">
                                Baseline found ({baselineReport.timestamp}); next run will compare
                                against it.
                            </div>
                        )}
                    </div>

                    <button
                        className="px-4 py-2 rounded-lg bg-gray-900 text-white"
                        onClick={startValidation}
                    >
                        {baselineReport ? "Start Validation (compare)" : "Start Validation (baseline)"}
                    </button>
                </div>
            )}

            {(state === "ready" || state === "running") && (
                <div className="space-y-4">
                    {/* Progress */}
                    <div className="rounded-lg border bg-white p-3">
                        <div className="flex items-center justify-between mb-2">
                            <div className="text-lg font-semibold">
                                Trial {currentTrialNum + 1} / {NUM_TRIALS}
                            </div>
                            <div className="text-sm text-gray-600">
                                Accuracy: {(accuracySoFar * 100).toFixed(1)}% ({correctSoFar}/
                                {trials.length})
                            </div>
                        </div>
                        <div className="w-full h-2 bg-gray-200 rounded">
                            <div
                                className="h-2 bg-gray-900 rounded"
                                style={{ width: `${((currentTrialNum + 1) / NUM_TRIALS) * 100}%` }}
                            />
                        </div>
                    </div>

                    {/* Full-screen target display */}
                    {state === "running" && currentTarget && (
                        <div className="fixed inset-0 bg-black z-50 flex items-center justify-center">
                            <img
                                src={`/assets/protocols/calibration/${currentTarget.filename}`}
                                alt="Calibration target"
                                className="w-screen h-screen object-contain select-none"
                            />

                            {/* Live feedback overlay */}
                            <div className="absolute top-4 left-4 right-4 flex justify-between items-start">
                                <div className="bg-black/70 text-white px-4 py-2 rounded text-sm space-y-1">
                                    <div>Trial {currentTrialNum + 1} / {NUM_TRIALS}</div>
                                    <div className="text-xs text-gray-300">
                                        Expected: {currentTarget.filename}
                                    </div>
                                    {liveClassified && (
                                        <div className="text-xs text-gray-300">
                                            Predicted: {liveClassified.filename}
                                        </div>
                                    )}
                                </div>

                                <div className="bg-black/70 text-white px-4 py-2 rounded text-sm">
                                    Accuracy: {(accuracySoFar * 100).toFixed(1)}%
                                    {meanErrorSoFar !== null && (
                                        <div className="text-xs text-gray-300">
                                            Avg Error: {meanErrorSoFar.toFixed(1)}px
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Visual feedback: actual vs predicted */}
                            {livePredicted && (
                                <>
                                    {/* Actual target dot */}
                                    <div
                                        className="absolute w-4 h-4 rounded-full bg-green-500 border-2 border-white"
                                        style={{
                                            left: `${currentTarget.raw_x}px`,
                                            top: `${currentTarget.raw_y}px`,
                                            transform: "translate(-50%, -50%)",
                                        }}
                                    />
                                    {/* Predicted dot */}
                                    <div
                                        className="absolute w-4 h-4 rounded-full bg-blue-500 border-2 border-white"
                                        style={{
                                            left: `${livePredicted.x}px`,
                                            top: `${livePredicted.y}px`,
                                            transform: "translate(-50%, -50%)",
                                        }}
                                    />
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            {state === "completed" && summary && (
                <div className="space-y-4">
                    {/* Summary cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                        <div className="rounded border bg-white p-3">
                            <div className="text-xs text-gray-500">Accuracy</div>
                            <div className="text-2xl font-semibold">
                                {(summary.accuracy * 100).toFixed(1)}%
                            </div>
                            <div className="text-xs text-gray-500">
                                {summary.correct_count}/{summary.valid_count} valid
                            </div>
                        </div>
                        <div className="rounded border bg-white p-3">
                            <div className="text-xs text-gray-500">Mean error</div>
                            <div className="text-2xl font-semibold">
                                {summary.mean_error_px?.toFixed(1) || "-"}
                            </div>
                            <div className="text-xs text-gray-500">pixels</div>
                        </div>
                        <div className="rounded border bg-white p-3">
                            <div className="text-xs text-gray-500">Median error</div>
                            <div className="text-2xl font-semibold">
                                {summary.median_error_px?.toFixed(1) || "-"}
                            </div>
                            <div className="text-xs text-gray-500">pixels</div>
                        </div>
                        <div className="rounded border bg-white p-3">
                            <div className="text-xs text-gray-500">Worst error</div>
                            <div className="text-2xl font-semibold">
                                {summary.worst_error_px?.toFixed(1) || "-"}
                            </div>
                            <div className="text-xs text-gray-500">pixels</div>
                        </div>
                        <div className="rounded border bg-white p-3">
                            <button
                                className="w-full px-3 py-2 rounded border bg-white text-sm hover:bg-gray-50"
                                onClick={reset}
                            >
                                Run Again
                            </button>
                        </div>
                    </div>

                    {baselineComparison && (
                        <div className="rounded-lg border bg-white overflow-hidden">
                            <div className="px-3 py-2 border-b text-sm font-semibold">
                                Baseline comparison (current vs baseline)
                            </div>
                            <div className="overflow-auto">
                                <table className="min-w-full text-sm">
                                    <thead className="bg-gray-50 text-gray-600">
                                        <tr>
                                            <th className="text-left px-3 py-2">Metric</th>
                                            <th className="text-left px-3 py-2">Baseline</th>
                                            <th className="text-left px-3 py-2">Current</th>
                                            <th className="text-left px-3 py-2">Δ</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr className="border-t">
                                            <td className="px-3 py-2">Accuracy</td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.baseline.accuracy !== null
                                                    ? `${(baselineComparison.baseline.accuracy * 100).toFixed(1)}%`
                                                    : "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.current.accuracy !== null
                                                    ? `${(baselineComparison.current.accuracy * 100).toFixed(1)}%`
                                                    : "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.delta.accuracy !== null
                                                    ? `${formatSigned(
                                                        baselineComparison.delta.accuracy * 100,
                                                        1
                                                    )}%`
                                                    : "-"}
                                            </td>
                                        </tr>
                                        <tr className="border-t">
                                            <td className="px-3 py-2">Mean error (px)</td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.baseline.mean_error_px?.toFixed(1) ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.current.mean_error_px?.toFixed(1) ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {formatSigned(baselineComparison.delta.mean_error_px, 1)}
                                            </td>
                                        </tr>
                                        <tr className="border-t">
                                            <td className="px-3 py-2">Median error (px)</td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.baseline.median_error_px?.toFixed(1) ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.current.median_error_px?.toFixed(1) ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {formatSigned(baselineComparison.delta.median_error_px, 1)}
                                            </td>
                                        </tr>
                                        <tr className="border-t">
                                            <td className="px-3 py-2">Worst error (px)</td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.baseline.worst_error_px?.toFixed(1) ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.current.worst_error_px?.toFixed(1) ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {formatSigned(baselineComparison.delta.worst_error_px, 1)}
                                            </td>
                                        </tr>
                                        <tr className="border-t">
                                            <td className="px-3 py-2">Valid trials</td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.baseline.valid_count ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {baselineComparison.current.valid_count ?? "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {formatSigned(
                                                    baselineComparison.delta.valid_count,
                                                    0
                                                )}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Trial-by-trial table */}
                    <div className="rounded-lg border bg-white overflow-hidden">
                        <div className="px-3 py-2 border-b text-sm font-semibold">
                            Trial Details
                        </div>
                        <div className="overflow-auto max-h-96">
                            <table className="min-w-full text-sm">
                                <thead className="bg-gray-50 text-gray-600">
                                    <tr>
                                        <th className="text-left px-3 py-2">Trial</th>
                                        <th className="text-left px-3 py-2">Actual</th>
                                        <th className="text-left px-3 py-2">Predicted</th>
                                        <th className="text-left px-3 py-2">Correct</th>
                                        <th className="text-left px-3 py-2">Error (px)</th>
                                        <th className="text-left px-3 py-2">Samples</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {trials.map((trial) => (
                                        <tr key={trial.trial_num} className="border-t">
                                            <td className="px-3 py-2">{trial.trial_num}</td>
                                            <td className="px-3 py-2">{trial.actual_target.filename}</td>
                                            <td className="px-3 py-2">
                                                {trial.valid ? (
                                                    trial.classified_target?.filename || "-"
                                                ) : (
                                                    <span className="text-gray-400 text-xs">invalid</span>
                                                )}
                                            </td>
                                            <td className="px-3 py-2">
                                                {trial.valid ? (
                                                    trial.correct ? (
                                                        <span className="text-green-700">✓</span>
                                                    ) : (
                                                        <span className="text-red-700">✗</span>
                                                    )
                                                ) : (
                                                    <span className="text-gray-400">-</span>
                                                )}
                                            </td>
                                            <td className="px-3 py-2">
                                                {trial.error_px !== null ? trial.error_px.toFixed(1) : "-"}
                                            </td>
                                            <td className="px-3 py-2">
                                                {trial.n_samples}
                                                {!trial.valid && (
                                                    <span className="text-xs text-gray-400 ml-1">(min {MIN_SAMPLES})</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
