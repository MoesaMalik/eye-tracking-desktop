import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTrackerStatus,
  openTrackerOutput,
  startTracker,
  stopTracker,
  subscribeTrackerErrors,
  subscribeTrackerExit,
  subscribeTrackerLogs,
} from "./tracker";

describe("tracker IPC helpers", () => {
  beforeEach(() => {
    delete (window as any).tracker;
    delete (window as any).nativeApi;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).tracker;
    delete (window as any).nativeApi;
  });

  it("prefers the tracker bridge when starting or stopping", async () => {
    const startMock = vi.fn().mockResolvedValue({ ok: true, message: "started" });
    const stopMock = vi.fn().mockResolvedValue({ ok: true, message: "stopped" });
    (window as any).tracker = {
      start: startMock,
      stop: stopMock,
      onStdout: undefined,
      onStderr: undefined,
      onExit: undefined,
      openOutput: undefined,
    };

    const startResult = await startTracker({ cam: 1 });
    expect(startMock).toHaveBeenCalledWith({ cam: 1 });
    expect(startResult).toEqual({ ok: true, message: "started" });

    const stopResult = await stopTracker();
    expect(stopMock).toHaveBeenCalled();
    expect(stopResult).toEqual({ ok: true, message: "stopped" });
  });

  it("falls back to nativeApi.invoke when the preload bridge is absent", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "running", pid: 321 });
    (window as any).nativeApi = { invoke };

    await startTracker();
    expect(invoke).toHaveBeenCalledWith("tracking:start", {});

    await stopTracker();
    expect(invoke).toHaveBeenCalledWith("tracking:stop");

    const status = await getTrackerStatus();
    expect(invoke).toHaveBeenCalledWith("tracking:status");
    expect(status).toEqual({ status: "running", pid: 321 });
  });

  it("provides safe fallbacks when no IPC APIs are present", async () => {
    expect(await getTrackerStatus()).toEqual({ status: "idle" });
    expect(await openTrackerOutput()).toEqual({ ok: false, path: "" });

    const unsubLogs = subscribeTrackerLogs(() => {});
    const unsubErr = subscribeTrackerErrors(() => {});
    const unsubExit = subscribeTrackerExit(() => {});
    expect(() => unsubLogs()).not.toThrow();
    expect(() => unsubErr()).not.toThrow();
    expect(() => unsubExit()).not.toThrow();
  });

  it("wires up tracker log subscriptions and returns their unsubscribe handles", () => {
    const stdoutUnsub = vi.fn();
    const stderrUnsub = vi.fn();
    const exitUnsub = vi.fn();
    (window as any).tracker = {
      start: vi.fn(),
      stop: vi.fn(),
      onStdout: vi.fn().mockReturnValue(stdoutUnsub),
      onStderr: vi.fn().mockReturnValue(stderrUnsub),
      onExit: vi.fn().mockReturnValue(exitUnsub),
      openOutput: vi.fn(),
    };

    const logsListener = vi.fn();
    const errorsListener = vi.fn();
    const exitListener = vi.fn();

    const detachLogs = subscribeTrackerLogs(logsListener);
    const detachErrors = subscribeTrackerErrors(errorsListener);
    const detachExit = subscribeTrackerExit(exitListener);

    expect(window.tracker?.onStdout).toHaveBeenCalledWith(logsListener);
    expect(window.tracker?.onStderr).toHaveBeenCalledWith(errorsListener);
    expect(window.tracker?.onExit).toHaveBeenCalledWith(exitListener);

    detachLogs();
    detachErrors();
    detachExit();
    expect(stdoutUnsub).toHaveBeenCalled();
    expect(stderrUnsub).toHaveBeenCalled();
    expect(exitUnsub).toHaveBeenCalled();
  });

  it("proxies openTrackerOutput via the bridge when available", async () => {
    const openOutput = vi.fn().mockResolvedValue({ ok: true, path: "output" });
    (window as any).tracker = {
      start: vi.fn(),
      stop: vi.fn(),
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      onExit: vi.fn(),
      openOutput,
    };

    const result = await openTrackerOutput();
    expect(openOutput).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, path: "output" });
  });
});
