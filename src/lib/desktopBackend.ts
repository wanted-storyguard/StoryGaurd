import { api } from "./api";

// The web build talks to a backend that is already running (a hosted server,
// or `npm run backend` during development). There is no sidecar to spawn or
// stop: the desktop shell that did that lives on the desktop branch.
const BACKEND_READY_TIMEOUT_MS = 60_000;
const BACKEND_READY_INTERVAL_MS = 500;

export async function ensureBackend(): Promise<string> {
  await waitForBackendReady();
  return "웹 백엔드 연결됨";
}

export async function waitForBackendReady(
  timeoutMs = BACKEND_READY_TIMEOUT_MS,
  intervalMs = BACKEND_READY_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      // A stalled fetch must not block the outer readiness deadline.
      const remainingMs = Math.max(1, deadline - Date.now());
      await withTimeout(api.ready(), Math.min(2_000, remainingMs));
      return;
    } catch (error) {
      lastError = error;
      if (isBackendVersionOrAuthConflict(error)) {
        throw new Error(
          "백엔드 버전 또는 인증이 맞지 않습니다. 서버 주소(VITE_STORY_GUARD_API)와 배포 버전을 확인해 주세요.",
        );
      }
      await delay(intervalMs);
    }
  }
  const message = lastError instanceof Error ? lastError.message : "응답 없음";
  throw new Error(`백엔드에 연결하지 못했습니다. 마지막 오류: ${message}`);
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error("backend readiness check timed out"));
    }, timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function isBackendVersionOrAuthConflict(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("인증 토큰") || error.message.includes("Not Found"))
  );
}
