/// <reference types="vitest" />
/// <reference types="vite/client" />

declare global {
  interface Window {
    ipcRenderer?: {
      on: (
        channel: string,
        listener: (event: unknown, ...args: any[]) => void
      ) => any;
      off: (
        channel: string,
        listener: (event: unknown, ...args: any[]) => void
      ) => void;
      send: (channel: string, ...args: any[]) => void;
      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };

    tracker?: {
      start: (opts?: {
        cam?: number;
        outDir?: string;
        script?: string;
        preview?: boolean;
        videoPath?: string;
      }) => Promise<{ ok: boolean; message: string }>;
      stop: () => Promise<{ ok: boolean; message: string }>;
      onStdout?: (cb: (line: string) => void) => () => void;
      onStderr?: (cb: (line: string) => void) => () => void;
      onExit?: (cb: (code: number) => void) => () => void;
      openOutput?: () => Promise<{ ok: boolean; path: string }>;
    };

    nativeApi?: {
      invoke: (ch: string, ...args: any[]) => Promise<any>;
    };

    startHeadPosition?: (opts?: {
      cam?: number;
      fps?: number;
      script?: string;
      jsonl?: boolean;
    }) => Promise<{ ok: boolean; message: string }>;
    stopHeadPosition?: () => Promise<{ ok: boolean; message: string }>;
    onHeadPositionUpdate?: (cb: (payload: any) => void) => () => void;

    // Gaze stream functions
    startGazeStream?: (opts?: { cam?: number; fps?: number; script?: string }) => Promise<{ ok: boolean; message: string }>;
    stopGazeStream?: () => Promise<{ ok: boolean; message: string }>;
    onGazeUpdate?: (cb: (payload: any) => void) => () => void;
  }
}

export { };
