import { invoke } from "@tauri-apps/api/core";
import { Command, type Child } from "@tauri-apps/plugin-shell";
import { api, setApiToken } from "./api";

let backendProcess: Child | null = null;
let startPromise: Promise<string> | null = null;
let stopPromise: Promise<void> | null = null;
const BACKEND_READY_TIMEOUT_MS = 60_000;
const BACKEND_READY_INTERVAL_MS = 250;
const BACKEND_SHUTDOWN_TIMEOUT_MS = 900;

export function isTauriRuntime() {
  // `window` is absent in Node test environments and server-side tooling;
  // treat those, like any plain browser, as non-desktop.
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function ensureDesktopBackend(): Promise<string> {
  if (!isTauriRuntime()) {
    return "웹 개발 모드: 외부 backend 서버를 사용합니다.";
  }
  const token = await invoke<string>("api_token");
  setApiToken(token);
  if (backendProcess) {
    try {
      await waitForBackendReady();
      return "데스크톱 backend sidecar 실행 중";
    } catch (error) {
      // A sidecar can disappear without emitting the shell close event (for
      // example when the app is terminated while an analysis is running).
      // Do not keep a dead Child handle: clear it and recover by spawning a
      // fresh sidecar below. Version/auth conflicts remain fatal and are
      // surfaced by waitForBackendReady rather than silently replaced.
      if (isBackendVersionOrAuthConflict(error)) {
        throw error;
      }
      backendProcess = null;
      startPromise = null;
    }
  }
  if (startPromise) {
    return startPromise;
  }
  if (await isExistingBackendReady()) {
    return "기존 데스크톱 backend 재사용";
  }

  startPromise = startSidecar(token).catch((error) => {
    startPromise = null;
    throw error;
  });
  return startPromise;
}

async function startSidecar(token: string): Promise<string> {
  const appDataDir = await invoke<string>("app_data_dir");
  const parentPid = await invoke<number>("app_process_id");
  const command = Command.sidecar("binaries/story-guard-backend", [], {
    env: {
      STORY_GUARD_DATA_DIR: appDataDir,
      STORY_GUARD_BACKEND_PORT: "8765",
      STORY_GUARD_API_TOKEN: token,
      STORY_GUARD_PARENT_PID: String(parentPid),
    },
  });
  command.stdout.on("data", (line) => console.info(`[story-guard-backend] ${line}`));
  command.stderr.on("data", (line) => console.warn(`[story-guard-backend] ${line}`));
  command.on("close", () => {
    backendProcess = null;
    startPromise = null;
  });
  backendProcess = await command.spawn();
  await waitForBackendReady(BACKEND_READY_TIMEOUT_MS, BACKEND_READY_INTERVAL_MS, () => backendProcess !== null);
  const child = backendProcess;
  if (!child) {
    throw new Error("데스크톱 backend가 준비 직후 종료되었습니다. 다시 시작해 주세요.");
  }
  return `데스크톱 backend sidecar 시작: pid ${child.pid}`;
}

export async function stopDesktopBackend(): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }
  stopPromise = stopDesktopBackendOnce().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

async function stopDesktopBackendOnce(): Promise<void> {
  const child = backendProcess;
  backendProcess = null;
  startPromise = null;

  // Only the desktop app owns its sidecar. A browser build (public web demo
  // or `npm run dev` against a shared backend) must never ask the server to
  // exit; a hosted backend also refuses /shutdown in web mode.
  if (!isTauriRuntime()) {
    return;
  }
  await withTimeout(api.shutdown(), BACKEND_SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
  if (!child) {
    return;
  }
  await child.kill().catch((error) => {
    console.warn("[story-guard-backend] sidecar kill failed", error);
  });
}

async function isExistingBackendReady(): Promise<boolean> {
  try {
    await api.ready();
    return true;
  } catch (error) {
    if (isBackendVersionOrAuthConflict(error)) {
      throw new Error(
        "데스크톱 backend 버전 또는 인증이 맞지 않습니다. Story Guard 관련 프로세스를 완전히 종료한 뒤 다시 실행해 주세요.",
      );
    }
    return false;
  }
}

export async function waitForBackendReady(
  timeoutMs = BACKEND_READY_TIMEOUT_MS,
  intervalMs = BACKEND_READY_INTERVAL_MS,
  isProcessAlive: () => boolean = () => true,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      // A stalled fetch must not block the outer readiness deadline. This is
      // especially important during startup when a sidecar crashed before it
      // opened the port: the UI should reach its retry state predictably.
      const remainingMs = Math.max(1, deadline - Date.now());
      await withTimeout(api.ready(), Math.min(2_000, remainingMs));
      return;
    } catch (error) {
      lastError = error;
      if (!isProcessAlive()) {
        throw new Error("데스크톱 backend 프로세스가 시작 직후 종료되었습니다. 포트 충돌 또는 sidecar 오류를 확인해 주세요.");
      }
      if (
        isBackendVersionOrAuthConflict(error)
      ) {
        throw new Error(
          "데스크톱 backend 버전 또는 인증이 맞지 않습니다. Story Guard 관련 프로세스를 완전히 종료한 뒤 다시 실행해 주세요.",
        );
      }
      await delay(intervalMs);
    }
  }
  const message = lastError instanceof Error ? lastError.message : "응답 없음";
  throw new Error(`데스크톱 backend가 시작되지 않았습니다. 마지막 오류: ${message}`);
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error("backend shutdown timed out"));
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
