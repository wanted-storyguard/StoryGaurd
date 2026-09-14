import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import { ensureDesktopBackend, stopDesktopBackend, waitForBackendReady } from "./desktopBackend";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sidecar: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: {
    sidecar: tauriMocks.sidecar,
  },
}));

describe("desktop backend readiness", () => {
  afterEach(async () => {
    vi.useRealTimers();
    // Never let cleanup reach a real backend on 127.0.0.1:8765: a developer
    // running the suite next to a live sidecar/dev server would stop it.
    if (!vi.isMockFunction(api.shutdown)) {
      vi.spyOn(api, "shutdown").mockResolvedValue({ status: "stopping" });
    }
    await stopDesktopBackend();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    tauriMocks.invoke.mockReset();
    tauriMocks.sidecar.mockReset();
  });

  it("retries authenticated readiness checks until the sidecar is ready", async () => {
    vi.useFakeTimers();
    const readyMock = vi
      .spyOn(api, "ready")
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ status: "ok" });

    const ready = waitForBackendReady(1_000, 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(ready).resolves.toBeUndefined();
    expect(readyMock).toHaveBeenCalledTimes(2);
  });

  it("reports a clear timeout when the sidecar never becomes ready", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockRejectedValue(new Error("connection refused"));

    const ready = waitForBackendReady(50, 25);
    const expectation = expect(ready).rejects.toThrow("데스크톱 backend가 시작되지 않았습니다");
    await vi.advanceTimersByTimeAsync(75);

    await expectation;
  });

  it("fails immediately when the spawned sidecar has already exited", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockRejectedValue(new Error("connection refused"));

    await expect(waitForBackendReady(60_000, 250, () => false)).rejects.toThrow(
      "backend 프로세스가 시작 직후 종료되었습니다",
    );
  });

  it("does not wait forever when the readiness request itself hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockReturnValue(new Promise(() => undefined));

    const ready = waitForBackendReady(100, 25);
    const expectation = expect(ready).rejects.toThrow("데스크톱 backend가 시작되지 않았습니다");
    await vi.advanceTimersByTimeAsync(125);

    await expectation;
  });

  it("fails fast when another backend is using a different token", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockRejectedValue(new Error("로컬 API 인증 토큰이 필요합니다."));

    await expect(waitForBackendReady(1_000, 25)).rejects.toThrow("데스크톱 backend 버전 또는 인증이 맞지 않습니다");
  });

  it("fails fast when an older backend is already bound to the port", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockRejectedValue(new Error("Not Found"));

    await expect(waitForBackendReady(1_000, 25)).rejects.toThrow("데스크톱 backend 버전 또는 인증이 맞지 않습니다");
  });

  it("reuses an authenticated backend that is already listening", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    tauriMocks.invoke.mockResolvedValue("desktop-token");
    vi.spyOn(api, "ready").mockResolvedValue({ status: "ok" });

    await expect(ensureDesktopBackend()).resolves.toBe("기존 데스크톱 backend 재사용");

    expect(tauriMocks.sidecar).not.toHaveBeenCalled();
  });

  it("shuts down the API and kills the spawned sidecar", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    tauriMocks.invoke.mockImplementation(async (command: string) =>
      command === "api_token" ? "desktop-token" : command === "app_process_id" ? 4321 : "/tmp/story-guard",
    );
    const child = {
      pid: 1234,
      kill: vi.fn(async () => undefined),
    };
    const command = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      spawn: vi.fn(async () => child),
    };
    tauriMocks.sidecar.mockReturnValue(command);
    vi.spyOn(api, "ready")
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue({ status: "ok" });
    const shutdown = vi.spyOn(api, "shutdown").mockResolvedValue({ status: "stopping" });

    await expect(ensureDesktopBackend()).resolves.toContain("pid 1234");
    await stopDesktopBackend();

    expect(tauriMocks.sidecar).toHaveBeenCalledWith(
      "binaries/story-guard-backend",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          STORY_GUARD_PARENT_PID: "4321",
        }),
      }),
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not wait forever for backend shutdown before closing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    tauriMocks.invoke.mockImplementation(async (command: string) =>
      command === "api_token" ? "desktop-token" : command === "app_process_id" ? 4321 : "/tmp/story-guard",
    );
    const child = {
      pid: 1234,
      kill: vi.fn(async () => undefined),
    };
    const command = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      spawn: vi.fn(async () => child),
    };
    tauriMocks.sidecar.mockReturnValue(command);
    vi.spyOn(api, "ready")
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue({ status: "ok" });
    const shutdown = vi.spyOn(api, "shutdown").mockReturnValue(new Promise(() => undefined));

    await ensureDesktopBackend();
    const stopped = stopDesktopBackend();
    await vi.advanceTimersByTimeAsync(1_200);

    await expect(stopped).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    shutdown.mockResolvedValue({ status: "stopping" });
  });
});
