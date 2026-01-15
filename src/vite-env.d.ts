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

    calibration?: {
      emitTarget: (payload: {
        session_id: string;
        slide_index: number;
        x: number;
        y: number;
        slide: string;
        timestamp_ms: number;
      }) => Promise<{ ok: boolean }>;
      save: (sessionDir: string) => Promise<{ ok: boolean; path?: string; count?: number; error?: string }>;
      reset: () => Promise<{ ok: boolean }>;
    };
  }
}

export { };
