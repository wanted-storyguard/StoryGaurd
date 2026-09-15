import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import { ensureBackend, waitForBackendReady } from "./desktopBackend";

describe("web backend readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries the readiness check until the backend answers", async () => {
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

  it("reports a clear timeout when the backend never becomes ready", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockRejectedValue(new Error("connection refused"));

    const ready = waitForBackendReady(50, 25);
    const expectation = expect(ready).rejects.toThrow("백엔드에 연결하지 못했습니다");
    await vi.advanceTimersByTimeAsync(75);

    await expectation;
  });

  it("does not wait forever when the readiness request itself hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockReturnValue(new Promise(() => undefined));

    const ready = waitForBackendReady(100, 25);
    const expectation = expect(ready).rejects.toThrow("백엔드에 연결하지 못했습니다");
    await vi.advanceTimersByTimeAsync(125);

    await expectation;
  });

  it("fails fast when the backend rejects the token or serves an older API", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ready").mockRejectedValue(new Error("로컬 API 인증 토큰이 필요합니다."));
    await expect(waitForBackendReady(1_000, 25)).rejects.toThrow("백엔드 버전 또는 인증이 맞지 않습니다");

    vi.spyOn(api, "ready").mockRejectedValue(new Error("Not Found"));
    await expect(waitForBackendReady(1_000, 25)).rejects.toThrow("백엔드 버전 또는 인증이 맞지 않습니다");
  });

  it("never asks the backend to shut down", async () => {
    vi.spyOn(api, "ready").mockResolvedValue({ status: "ok" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureBackend()).resolves.toBe("웹 백엔드 연결됨");

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
