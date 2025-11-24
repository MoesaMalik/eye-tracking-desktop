import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { saveJSON } from "../lib/save";
import type { RecordingFolder, FrameData, ManualMark, ComparisonResult } from "../types";

const DEFAULT_FPS = 30;

export default function CalibrateCurrent() {
    const [params] = useSearchParams();
    const initialSessionId = params.get("session");

    const [folders, setFolders] = useState<RecordingFolder[]>([]);
    const [selectedFolder, setSelectedFolder] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [videoSrc, setVideoSrc] = useState<string>("");
    const [trackingData, setTrackingData] = useState<FrameData[]>([]);
    const [manualMarks, setManualMarks] = useState<Record<number, ManualMark>>({});

    const [currentFrame, setCurrentFrame] = useState(0);

    const [selectedEye, setSelectedEye] = useState<"left" | "right">("left");
    const [comparison, setComparison] = useState<ComparisonResult[]>([]);
    const [avgError, setAvgError] = useState<{ l: number; r: number } | null>(null);

    const [zoomLevel, setZoomLevel] = useState(1); // 1 = 100%

    const [videoFPS, setVideoFPS] = useState<number>(DEFAULT_FPS);

    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Load folders on mount
    useEffect(() => {
        // @ts-ignore
        if (window.ipcRenderer) {
            // @ts-ignore
            window.ipcRenderer.invoke("recordings:list-folders").then((list: any[]) => {
                setFolders(list);
                if (initialSessionId) {
                    const found = list.find(f => f.name.includes(initialSessionId));
                    if (found) setSelectedFolder(found.path);
                }
            });
        }
    }, [initialSessionId]);

    // Load data when folder selected
    useEffect(() => {
        if (!selectedFolder) return;
        setLoading(true);
        setError(null);
        setVideoSrc("");
        setTrackingData([]);
        setManualMarks({});
        setComparison([]);
        setAvgError(null);
        setCurrentFrame(0);
        setZoomLevel(1);
        setVideoFPS(DEFAULT_FPS);

        // @ts-ignore
        window.ipcRenderer.invoke("session:load-data", selectedFolder).then((res: any) => {
            setLoading(false);
            if (!res.ok) {
                setError(res.error);
                return;
            }
            const absolutePath = res.videoPath.startsWith("/") ? res.videoPath : `/${res.videoPath}`;
            const safePath = encodeURI(absolutePath);
            // Keep the path in the URL pathname (media:///Users/...)
            setVideoSrc(`media://${safePath}`);

            // Parse tracking data
            let data = res.trackingData;
            // Handle new structure { frames: [...], detector_stats: ... }
            if (data && !Array.isArray(data) && data.frames && Array.isArray(data.frames)) {
                data = data.frames;
            }

            if (data && Array.isArray(data)) {
                setTrackingData(data);
            }
            // Manual corrections could be loaded here if needed in the future.
        }).catch((e: any) => {
            setLoading(false);
            setError(String(e));
        });
    }, [selectedFolder]);

    // Ensure video element reloads when source changes
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.load();
        }
    }, [videoSrc]);

    const syncCanvasSize = () => {
        const vid = videoRef.current;
        const cvs = canvasRef.current;
        if (!vid || !cvs) return false;
        if (!vid.videoWidth || !vid.videoHeight) return false;

        // Set canvas size to match video resolution (internal size)
        if (vid.videoWidth && (cvs.width !== vid.videoWidth || cvs.height !== vid.videoHeight)) {
            cvs.width = vid.videoWidth;
            cvs.height = vid.videoHeight;
        }
        return true;
    };

    const getAutoCoords = (frame: FrameData | Record<string, any> | undefined, eye: "left" | "right") => {
        if (!frame) return { x: undefined as number | undefined, y: undefined as number | undefined };
        const xKey = eye === "left" ? ["lx", "left_center_x"] : ["rx", "right_center_x"];
        const yKey = eye === "left" ? ["ly", "left_center_y"] : ["ry", "right_center_y"];
        const x = (frame as any)[xKey[0]] ?? (frame as any)[xKey[1]];
        const y = (frame as any)[yKey[0]] ?? (frame as any)[yKey[1]];
        return { x, y };
    };

    const drawOverlay = () => {
        const vid = videoRef.current;
        const cvs = canvasRef.current;
        if (!vid || !cvs) return;

        const ready = syncCanvasSize();
        if (!ready) return;

        const ctx = cvs.getContext("2d");
        if (!ctx) return;

        ctx.clearRect(0, 0, cvs.width, cvs.height);

        const frameIdx = currentFrame;
        const auto = trackingData[frameIdx] as any;

        if (auto) {
            // Helper to draw point
            const drawPoint = (x: number | undefined, y: number | undefined, color: string, radius: number) => {
                if (x !== undefined && y !== undefined && !isNaN(x) && !isNaN(y)) {
                    ctx.beginPath();
                    ctx.arc(x, y, radius, 0, 2 * Math.PI);
                    ctx.fillStyle = color;
                    ctx.fill();
                }
            };

            // 1. Rough MP Centers (Green)
            drawPoint(auto.left_mp_x, auto.left_mp_y, "lime", 3);
            drawPoint(auto.right_mp_x, auto.right_mp_y, "lime", 3);

            // 2. Extrema
            // Left Eye Extrema
            drawPoint(auto.left_lr_left_x, auto.left_lr_left_y, "orange", 3);
            drawPoint(auto.left_lr_right_x, auto.left_lr_right_y, "orange", 3);
            drawPoint(auto.left_tb_top_x, auto.left_tb_top_y, "magenta", 3);
            drawPoint(auto.left_tb_bottom_x, auto.left_tb_bottom_y, "magenta", 3);

            // Right Eye Extrema
            drawPoint(auto.right_lr_left_x, auto.right_lr_left_y, "orange", 3);
            drawPoint(auto.right_lr_right_x, auto.right_lr_right_y, "orange", 3);
            drawPoint(auto.right_tb_top_x, auto.right_tb_top_y, "magenta", 3);
            drawPoint(auto.right_tb_bottom_x, auto.right_tb_bottom_y, "magenta", 3);

            // 3. Final Centers (Yellow)
            const { x: lx, y: ly } = getAutoCoords(auto, "left");
            const { x: rx, y: ry } = getAutoCoords(auto, "right");

            drawPoint(lx, ly, "yellow", 5);
            drawPoint(rx, ry, "yellow", 5);
        }

        // User-marked
        const manual = manualMarks[frameIdx];
        if (manual) {
            // Common style for manual marks
            ctx.lineWidth = 2;
            ctx.strokeStyle = "white";

            // Left Eye (Cyan, large)
            if (manual.lx !== undefined && manual.ly !== undefined) {
                ctx.beginPath();
                ctx.arc(manual.lx, manual.ly, 8, 0, 2 * Math.PI);
                ctx.fillStyle = "cyan";
                ctx.fill();
                ctx.stroke(); // Add stroke for visibility
            }
            // Right Eye (Cyan, large)
            if (manual.rx !== undefined && manual.ry !== undefined) {
                ctx.beginPath();
                ctx.arc(manual.rx, manual.ry, 8, 0, 2 * Math.PI);
                ctx.fillStyle = "cyan";
                ctx.fill();
                ctx.stroke(); // Add stroke for visibility
            }
        }
    };

    // Video sync
    useEffect(() => {
        const vid = videoRef.current;
        if (!vid) return;

        const onLoaded = () => {
            syncCanvasSize();

            // Estimate FPS from trackingData length and video duration if possible
            let fps = DEFAULT_FPS;
            if (vid.duration && trackingData.length > 0) {
                const estimatedFPS = trackingData.length / vid.duration;
                if (isFinite(estimatedFPS) && estimatedFPS > 0) {
                    fps = estimatedFPS;
                }
            }
            setVideoFPS(fps);

            // Seek video to match currentFrame with this FPS estimate
            try {
                vid.currentTime = currentFrame / fps;
            } catch {
                // ignore
            }

            drawOverlay();
        };

        const onSeeked = () => {
            drawOverlay();
        };
        const onTime = () => {
            drawOverlay();
        };
        const onError = () => {
            const err = vid.error;
            const msg = err
                ? `Video error (code ${err.code})`
                : "Failed to load video";
            console.error("Video load error", err, { src: vid.src });
            setError(msg);
        };

        vid.addEventListener("loadedmetadata", onLoaded);
        vid.addEventListener("loadeddata", onLoaded);
        vid.addEventListener("canplay", onLoaded);
        vid.addEventListener("seeked", onSeeked);
        vid.addEventListener("timeupdate", onTime);
        vid.addEventListener("error", onError);

        return () => {
            vid.removeEventListener("loadedmetadata", onLoaded);
            vid.removeEventListener("loadeddata", onLoaded);
            vid.removeEventListener("canplay", onLoaded);
            vid.removeEventListener("seeked", onSeeked);
            vid.removeEventListener("timeupdate", onTime);
            vid.removeEventListener("error", onError);
        };
    }, [videoSrc, currentFrame, trackingData]);

    // Redraw overlays when data changes
    useEffect(() => {
        drawOverlay();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manualMarks, trackingData, selectedEye, currentFrame, videoSrc]);

    const seekToFrame = (f: number) => {
        const vid = videoRef.current;
        if (!vid) return;

        // Clamp
        const durationFrames = vid.duration ? Math.floor(vid.duration * videoFPS) : 0;
        const max = trackingData.length > 0 ? trackingData.length - 1 : Math.max(durationFrames - 1, 0);
        const target = Math.max(0, Math.min(f, max));

        setCurrentFrame(target);
        try {
            vid.currentTime = target / videoFPS;
        } catch {
            // If metadata isn't ready yet, we'll seek once it is.
        }
        if (vid.readyState >= 2) {
            drawOverlay();
        }
    };

    const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const cvs = canvasRef.current;
        if (!cvs) return;

        const rect = cvs.getBoundingClientRect();
        // The rect size is affected by zoom, but the internal resolution (width/height) is constant (video resolution).
        // scaleX/Y maps from displayed pixels to internal video pixels.
        const scaleX = cvs.width / rect.width;
        const scaleY = cvs.height / rect.height;

        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        setManualMarks(prev => {
            const existing = prev[currentFrame] || { frame: currentFrame };
            return {
                ...prev,
                [currentFrame]: {
                    ...existing,
                    [selectedEye === "left" ? "lx" : "rx"]: x,
                    [selectedEye === "left" ? "ly" : "ry"]: y
                }
            };
        });
    };

    const calculateError = () => {
        const results: ComparisonResult[] = [];
        let lSum = 0, lCount = 0;
        let rSum = 0, rCount = 0;

        let lSumPct = 0, lCountPct = 0;
        let rSumPct = 0, rCountPct = 0;

        Object.values(manualMarks).forEach(mark => {
            const auto = trackingData[mark.frame] as any;
            if (!auto) return;

            let l_err: number | null = null;
            let r_err: number | null = null;
            let l_err_pct: number | null = null;
            let r_err_pct: number | null = null;

            const { x: autoLx, y: autoLy } = getAutoCoords(auto, "left");
            const { x: autoRx, y: autoRy } = getAutoCoords(auto, "right");

            // ----- Left eye -----
            if (mark.lx !== undefined && mark.ly !== undefined && autoLx !== undefined && autoLy !== undefined) {
                const dx = mark.lx - autoLx;
                const dy = mark.ly - autoLy;
                l_err = Math.sqrt(dx * dx + dy * dy);

                const diam = auto.left_iris_diameter;
                if (diam && isFinite(diam) && diam > 0) {
                    l_err_pct = (l_err / diam) * 100;
                }

                lSum += l_err;
                lCount++;

                if (l_err_pct !== null) {
                    lSumPct += l_err_pct;
                    lCountPct++;
                }
            }

            // ----- Right eye -----
            if (mark.rx !== undefined && mark.ry !== undefined && autoRx !== undefined && autoRy !== undefined) {
                const dx = mark.rx - autoRx;
                const dy = mark.ry - autoRy;
                r_err = Math.sqrt(dx * dx + dy * dy);

                const diam = auto.right_iris_diameter;
                if (diam && isFinite(diam) && diam > 0) {
                    r_err_pct = (r_err / diam) * 100;
                }

                rSum += r_err;
                rCount++;

                if (r_err_pct !== null) {
                    rSumPct += r_err_pct;
                    rCountPct++;
                }
            }

            results.push({
                frame: mark.frame,
                l_error: l_err,
                r_error: r_err,
                l_error_pct: l_err_pct,
                r_error_pct: r_err_pct
            });
        });

        results.sort((a, b) => a.frame - b.frame);
        setComparison(results);
        setAvgError({
            l: lCount ? lSum / lCount : 0,
            r: rCount ? rSum / rCount : 0
        });

        // Optionally log iris-relative averages
        if (lCountPct || rCountPct) {
            console.log("Average Left Error (% iris diameter):", lCountPct ? lSumPct / lCountPct : 0);
            console.log("Average Right Error (% iris diameter):", rCountPct ? rSumPct / rCountPct : 0);
        }
    };

    const saveCorrections = async () => {
        if (!selectedFolder) return;
        // Save to manual_correction.json in the folder (download via browser for now)
        saveJSON("manual_correction.json", Object.values(manualMarks));
    };

    return (
        <div className="p-6 h-[calc(100vh-80px)] flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-semibold">Calibrate Recordings</h1>
                <div className="flex gap-2">
                    <select
                        className="border rounded px-3 py-2 bg-white"
                        value={selectedFolder}
                        onChange={e => setSelectedFolder(e.target.value)}
                    >
                        <option value="">Select recording folder...</option>
                        {folders.map(f => (
                            <option key={f.path} value={f.path}>{f.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {error && <div className="bg-red-50 text-red-700 p-3 rounded border border-red-200">{error}</div>}
            {loading && <div className="bg-blue-50 text-blue-700 p-3 rounded border border-blue-200">Loading...</div>}

            <div className="flex-1 flex gap-4 min-h-0">
                {/* Main Canvas Area */}
                <div className="flex-1 bg-black relative overflow-hidden rounded-lg border border-gray-800 flex flex-col">
                    {/* Zoom Controls Overlay */}
                    <div className="absolute top-4 right-4 z-10 flex gap-2 bg-black/50 p-2 rounded backdrop-blur-sm">
                        <button
                            className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50"
                            onClick={() => setZoomLevel(Math.max(0.5, zoomLevel - 0.5))}
                            disabled={zoomLevel <= 0.5}
                        >
                            -
                        </button>
                        <span className="text-white px-2 py-1 min-w-[3rem] text-center">
                            {Math.round(zoomLevel * 100)}%
                        </span>
                        <button
                            className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50"
                            onClick={() => setZoomLevel(Math.min(5, zoomLevel + 0.5))}
                            disabled={zoomLevel >= 5}
                        >
                            +
                        </button>
                        <button
                            className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 text-xs ml-2"
                            onClick={() => setZoomLevel(1)}
                        >
                            Reset
                        </button>
                    </div>

                    <div
                        ref={containerRef}
                        className="flex-1 overflow-auto relative flex items-center justify-center bg-gray-900"
                    >
                        {videoSrc ? (
                            <div
                                style={{
                                    width: `${zoomLevel * 100}%`,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0 // Prevent shrinking in flex container
                                }}
                            >
                                <div className="relative w-full">
                                    <video
                                        ref={videoRef}
                                        src={videoSrc}
                                        className="w-full h-auto block"
                                    />
                                    <canvas
                                        ref={canvasRef}
                                        className="absolute inset-0 w-full h-full cursor-crosshair z-10"
                                        onClick={handleCanvasClick}
                                    />
                                </div>
                            </div>
                        ) : (
                            <div className="text-gray-500">No video loaded</div>
                        )}
                    </div>
                </div>

                {/* Sidebar */}
                <div className="w-80 bg-white border rounded-lg p-4 flex flex-col gap-4 overflow-y-auto">
                    <div className="space-y-2">
                        <h3 className="font-medium text-gray-900">Navigation</h3>
                        <div className="flex items-center gap-2">
                            <button onClick={() => seekToFrame(currentFrame - 1)} className="px-3 py-1 border rounded hover:bg-gray-50">◀</button>
                            <input
                                type="number"
                                className="w-20 border rounded px-2 py-1 text-center"
                                value={currentFrame}
                                onChange={e => seekToFrame(parseInt(e.target.value) || 0)}
                            />
                            <button onClick={() => seekToFrame(currentFrame + 1)} className="px-3 py-1 border rounded hover:bg-gray-50">▶</button>
                        </div>
                        <div className="text-xs text-gray-500 text-center">
                            Frame {currentFrame} / {trackingData.length}
                        </div>
                        <div className="text-xs text-gray-500 text-center">
                            FPS (estimated): {videoFPS.toFixed(2)}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <h3 className="font-medium text-gray-900">Selection Mode</h3>
                        <div className="flex gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="eye"
                                    checked={selectedEye === "left"}
                                    onChange={() => setSelectedEye("left")}
                                />
                                Left Eye
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="eye"
                                    checked={selectedEye === "right"}
                                    onChange={() => setSelectedEye("right")}
                                />
                                Right Eye
                            </label>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <h3 className="font-medium text-gray-900">Actions</h3>
                        <button
                            onClick={calculateError}
                            className="w-full px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                        >
                            Calibrate & Compare
                        </button>
                        <button
                            onClick={saveCorrections}
                            className="w-full px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
                        >
                            Save Corrections
                        </button>
                    </div>

                    {avgError && (
                        <div className="p-3 bg-gray-50 rounded border text-sm space-y-1">
                            <div className="font-medium">Average Error (px):</div>
                            <div>Left: {avgError.l.toFixed(2)}</div>
                            <div>Right: {avgError.r.toFixed(2)}</div>
                        </div>
                    )}

                    {comparison.length > 0 && (
                        <div className="flex-1 overflow-auto border rounded">
                            <table className="w-full text-xs text-left">
                                <thead className="bg-gray-100 sticky top-0">
                                    <tr>
                                        <th className="p-2 text-left">Frame</th>
                                        <th className="p-2 text-left">L Err (px)</th>
                                        <th className="p-2 text-left">R Err (px)</th>
                                        <th className="p-2">L Err (% iris)</th>
                                        <th className="p-2">R Err (% iris)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {comparison.map(c => (
                                        <tr
                                            key={c.frame}
                                            className="border-t hover:bg-gray-50 cursor-pointer"
                                            onClick={() => seekToFrame(c.frame)}
                                        >
                                            <td className="p-2">{c.frame}</td>
                                            <td className="p-2">{c.l_error ? c.l_error.toFixed(1) : "-"}</td>
                                            <td className="p-2">{c.r_error ? c.r_error.toFixed(1) : "-"}</td>
                                            <td className="p-2">
                                                {c.l_error_pct != null ? c.l_error_pct.toFixed(1) + "%" : "-"}
                                            </td>
                                            <td className="p-2">
                                                {c.r_error_pct != null ? c.r_error_pct.toFixed(1) + "%" : "-"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
