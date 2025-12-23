import { useEffect, useRef, useState } from "react";

type VideoFile = {
    name: string;
    path: string;
    createdAt: string;
};

type AnnotationData = {
    frame: number;
    lx: number;
    ly: number;
    rx: number;
    ry: number;
};

export default function Annotation() {
    const [videos, setVideos] = useState<VideoFile[]>([]);
    const [selectedVideo, setSelectedVideo] = useState<string>("");
    const [videoSrc, setVideoSrc] = useState<string>("");

    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    const [annotations, setAnnotations] = useState<Record<number, AnnotationData>>({});
    const [status, setStatus] = useState("");

    useEffect(() => {
        // @ts-ignore
        if (window.ipcRenderer) {
            // @ts-ignore
            window.ipcRenderer.invoke("annotation:list-videos").then((files: any[]) => {
                setVideos(files);
            });
        }
    }, []);

    useEffect(() => {
        if (selectedVideo) {
            // Use the media:// protocol to load the video
            const file = videos.find(v => v.path === selectedVideo);
            if (file) {
                setVideoSrc(`media://${file.path}`);
                setAnnotations({});
                setStatus("Loaded " + file.name);
            }
        }
    }, [selectedVideo, videos]);

    const togglePlay = () => {
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
            } else {
                videoRef.current.play();
            }
            setIsPlaying(!isPlaying);
        }
    };

    const onTimeUpdate = () => {
        if (videoRef.current) {
            setCurrentTime(videoRef.current.currentTime);
        }
    };

    const onLoadedMetadata = () => {
        if (videoRef.current) {
            setDuration(videoRef.current.duration);
        }
    };

    const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!videoRef.current || !canvasRef.current) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Simple logic: Left click for Left Eye, Right click (or Shift+Click) for Right Eye?
        // For now, let's just log the click. Ideally we need a mode switch.
        // Let's assume the user clicks Left Eye then Right Eye? 
        // Or maybe we just record a generic "point" and they have to be careful.

        // Better: Toggle buttons for "Mark Left" / "Mark Right"
        console.log("Clicked at", x, y);
    };

    // Frame stepping (approximate, assuming 30fps)
    const stepFrame = (frames: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime += frames * (1 / 30);
        }
    };

    const saveAnnotations = async () => {
        if (!selectedVideo) return;
        setStatus("Saving...");
        // @ts-ignore
        const res = await window.ipcRenderer.invoke("annotation:save", {
            videoPath: selectedVideo,
            data: annotations
        });
        if (res.ok) setStatus("Saved!");
        else setStatus("Error: " + res.error);
    };

    return (
        <div className="p-6 h-[calc(100vh-80px)] flex flex-col">
            <div className="flex justify-between items-center mb-4">
                <h1 className="text-xl font-semibold">Annotation Tool</h1>
                <div className="flex gap-2">
                    <select
                        className="border rounded px-2 py-1"
                        value={selectedVideo}
                        onChange={e => setSelectedVideo(e.target.value)}
                    >
                        <option value="">Select a recording...</option>
                        {videos.map(v => (
                            <option key={v.path} value={v.path}>{v.name}</option>
                        ))}
                    </select>
                    <button onClick={saveAnnotations} className="bg-blue-600 text-white px-4 py-1 rounded">
                        Save JSON
                    </button>
                </div>
            </div>

            <div className="flex-1 flex gap-4 min-h-0">
                {/* Main Video Area */}
                <div className="flex-1 bg-black relative flex items-center justify-center overflow-hidden rounded-lg border border-gray-800">
                    {videoSrc ? (
                        <>
                            <video
                                ref={videoRef}
                                src={videoSrc}
                                className="max-h-full max-w-full"
                                onTimeUpdate={onTimeUpdate}
                                onLoadedMetadata={onLoadedMetadata}
                                onClick={togglePlay}
                            />
                            {/* Overlay Canvas for drawing/clicking */}
                            <canvas
                                ref={canvasRef}
                                className="absolute inset-0 w-full h-full cursor-crosshair"
                                onClick={handleCanvasClick}
                            />
                        </>
                    ) : (
                        <div className="text-gray-500">Select a video to begin</div>
                    )}
                </div>

                {/* Sidebar Controls */}
                <div className="w-64 bg-white border rounded-lg p-4 flex flex-col gap-4">
                    <div className="text-sm font-medium text-gray-700">Controls</div>

                    <div className="flex gap-2 justify-center">
                        <button onClick={() => stepFrame(-1)} className="p-2 border rounded hover:bg-gray-50" title="-1 Frame">⏮</button>
                        <button onClick={togglePlay} className="p-2 border rounded hover:bg-gray-50 w-20">
                            {isPlaying ? "Pause" : "Play"}
                        </button>
                        <button onClick={() => stepFrame(1)} className="p-2 border rounded hover:bg-gray-50" title="+1 Frame">⏭</button>
                    </div>

                    <div className="text-xs text-gray-500 text-center">
                        {currentTime.toFixed(3)}s / {duration.toFixed(3)}s
                    </div>

                    <div className="border-t pt-4">
                        <div className="text-sm font-medium mb-2">Instructions</div>
                        <ul className="text-xs text-gray-600 space-y-1 list-disc pl-4">
                            <li>Select a video recording.</li>
                            <li>Pause at the desired frame.</li>
                            <li>Click on the center of the pupil.</li>
                            <li>Use arrow keys (implemented later) to step frames.</li>
                            <li>Save when finished.</li>
                        </ul>
                    </div>

                    <div className="mt-auto text-xs text-gray-400">
                        {status}
                    </div>
                </div>
            </div>
        </div>
    );
}
