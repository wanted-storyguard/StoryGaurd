import type {
  AnalysisJob,
  AnalysisEstimate,
  AnalysisPlan,
  ChatGptStatus,
  ChatGptModel,
  AppSettings,
  ContinuityIssue,
  DocumentDeleteResult,
  EvidenceChunk,
  GraphPayload,
  IssueStatus,
  Project,
  ProjectDeleteResult,
  StoryDocument,
  StorySetting,
  ForeshadowingStatus,
  WebDemoQuota,
} from "./types";

const API_BASE = import.meta.env.VITE_STORY_GUARD_API ?? "http://127.0.0.1:8765";
let apiToken = "";

export function setApiToken(token: string) {
  apiToken = token.trim();
}

type RequestFailure = 'network' | 'timeout' | 'http' | 'invalid_response' | 'cancelled';
export class ApiRequestError extends Error {
  constructor(message: string, readonly path: string, readonly method: string,
    readonly attempts: number, readonly kind: RequestFailure, readonly status?: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit, readPolicy = { attempts: 3, timeoutMs: 10_000 }): Promise<T> {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const readOnly = method === 'GET';
  const maxAttempts = readOnly ? readPolicy.attempts : 1;
  const headers = {
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(apiToken ? { "X-Story-Guard-Token": apiToken } : {}),
    ...(init?.headers ?? {}),
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timedOut = false;
    if (init?.signal?.aborted) cancel();
    init?.signal?.addEventListener('abort', cancel, { once: true });
    const timer = readOnly ? setTimeout(() => { timedOut = true; controller.abort(); }, readPolicy.timeoutMs) : undefined;
    let failure: ApiRequestError;
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        credentials: "include",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ detail: response.statusText }));
        throw new ApiRequestError(body.detail ?? response.statusText, path, method, attempt, 'http', response.status);
      }
      return await response.json() as T;
    } catch (error) {
      const kind: RequestFailure = init?.signal?.aborted ? 'cancelled' : timedOut ? 'timeout'
        : error instanceof SyntaxError ? 'invalid_response' : 'network';
      failure = error instanceof ApiRequestError ? error : new ApiRequestError(
        kind === 'timeout' ? '로컬 API 응답 시간이 초과되었습니다.'
          : kind === 'cancelled' ? '요청이 취소되었습니다.'
          : kind === 'invalid_response' ? '로컬 API 응답 형식을 읽지 못했습니다.'
          : '로컬 API에 연결하지 못했습니다.', path, method, attempt, kind);
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', cancel);
    }
    const retry = readOnly && attempt < maxAttempts && (failure.kind === 'network' || failure.kind === 'timeout');
    // Only request metadata is logged: no tokens, manuscripts or response bodies.
    console.warn('[story-guard-api]', JSON.stringify({ method, path, attempt, kind: failure.kind, status: failure.status, retry }));
    if (!retry) throw failure;
    await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 250 : 750));
  }
  throw new Error('API request exhausted');
}

export const api = {
  chatGptStatus: () => request<ChatGptStatus>("/chatgpt/status"),
  chatGptLogin: () => request<ChatGptStatus>("/chatgpt/login", { method: "POST" }),
  chatGptCancel: () => request<ChatGptStatus>("/chatgpt/cancel", { method: "POST" }),
  chatGptLogout: () => request<ChatGptStatus>("/chatgpt/logout", { method: "POST" }),
  chatGptOpenVerification: () => request<{ opened: boolean }>("/chatgpt/open-verification", { method: "POST" }),
  chatGptModels: () => request<ChatGptModel[]>("/chatgpt/models"),
  chatGptCheck: (model: string, effort?: string) => request<{ model: string; text: string }>("/chatgpt/check", {
    method: "POST", body: JSON.stringify({ model, ...(effort ? { effort } : {}) }),
  }),
  health: () => request<{ status: string }>("/health"),
  ready: () => request<{ status: string }>("/health/ready", undefined, { attempts: 1, timeoutMs: 2_000 }),
  webDemoQuota: () => request<WebDemoQuota>("/web-demo/quota"),
  settings: () => request<AppSettings>("/settings"),
  updateSettings: (settings: AppSettings) =>
    request<AppSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  listProjects: () => request<Project[]>("/projects"),
  createProject: (title: string) =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  updateProjectTitle: (projectId: number, title: string) =>
    request<Project>(`/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteProject: (projectId: number) =>
    request<ProjectDeleteResult>(`/projects/${projectId}`, {
      method: "DELETE",
    }),
  importDocument: (projectId: number, path: string) =>
    request<StoryDocument>("/documents/import", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, path }),
    }),
  replaceDocument: (documentId: number, path: string) =>
    request<StoryDocument>(`/documents/${documentId}`, {method: 'PUT', body: JSON.stringify({path})}),
  // Browser uploads send the file bytes (base64) instead of a server path.
  uploadDocument: (projectId: number, filename: string, contentBase64: string) =>
    request<StoryDocument>("/documents/upload", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, filename, content_base64: contentBase64 }),
    }),
  replaceDocumentUpload: (documentId: number, filename: string, contentBase64: string) =>
    request<StoryDocument>(`/documents/${documentId}/upload`, {
      method: "PUT",
      body: JSON.stringify({ filename, content_base64: contentBase64 }),
    }),
  reviewHistory: (projectId: number) => request<import('./types').ReviewHistory[]>(`/projects/${projectId}/review-history`),
  deleteDocument: (documentId: number) =>
    request<DocumentDeleteResult>(`/documents/${documentId}`, {
      method: "DELETE",
    }),
  listDocuments: (projectId: number) =>
    request<StoryDocument[]>(`/projects/${projectId}/documents`),
  listStorySettings: (projectId: number) =>
    request<StorySetting[]>(`/projects/${projectId}/settings`),
  createStorySetting: (projectId: number, payload: Pick<StorySetting, "title" | "content" | "certainty">) =>
    request<StorySetting>(`/projects/${projectId}/settings`, {method: "POST", body: JSON.stringify(payload)}),
  updateStorySetting: (settingId: number, payload: Pick<StorySetting, "title" | "content" | "certainty">) =>
    request<StorySetting>(`/settings/${settingId}`, {method: "PATCH", body: JSON.stringify(payload)}),
  deleteStorySetting: (settingId: number) =>
    request<{project_id: number}>(`/settings/${settingId}`, {method: "DELETE"}),
  listForeshadowingStatuses: (projectId: number) =>
    request<ForeshadowingStatus[]>(`/projects/${projectId}/foreshadowing/status`),
  updateForeshadowingStatus: (projectId: number, entityId: number, status: ForeshadowingStatus["status"]) =>
    request<ForeshadowingStatus>(`/projects/${projectId}/foreshadowing/${entityId}`, {method: "PATCH", body: JSON.stringify({status})}),
  analyzeProject: (projectId: number) =>
    request<{ entity_count: number; relation_count: number; issue_count: number; request_count?: number; cached_count?: number }>(
      `/projects/${projectId}/analyze`,
      { method: "POST" },
    ),
  analyzeProjectGpt: (projectId: number, model: string, effort?: string, force = false, batchLimit?: number,
    range?: { startChapter?: number | null; endChapter?: number | null }) =>
    request<{ entity_count: number; relation_count: number; issue_count: number; request_count?: number; cached_count?: number; failed_window_count?: number; batch_limited?: boolean; demo_limited?: boolean; failed_windows?: Array<{ index: number; chunk_id: number; error: string; error_code?: string | null; stage?: string; attempts?: number; elapsed_seconds?: number }> }>(
      `/projects/${projectId}/analyze/gpt`,
      { method: "POST", body: JSON.stringify({ model, effort, consent: true, force, batch_limit: batchLimit,
        ...(range?.startChapter !== null && range?.startChapter !== undefined ? { start_chapter: range.startChapter } : {}),
        ...(range?.endChapter !== null && range?.endChapter !== undefined ? { end_chapter: range.endChapter } : {}),
      }) },
    ),
  analysisStatus: (projectId: number) =>
    request<AnalysisJob>(`/projects/${projectId}/analysis/status`),
  analysisEstimate: (projectId: number, range?: { startChapter?: number | null; endChapter?: number | null }) => {
    const params = new URLSearchParams();
    if (range?.startChapter !== null && range?.startChapter !== undefined) params.set("start_chapter", String(range.startChapter));
    if (range?.endChapter !== null && range?.endChapter !== undefined) params.set("end_chapter", String(range.endChapter));
    const query = params.toString();
    return request<AnalysisEstimate>(`/projects/${projectId}/analysis/estimate${query ? `?${query}` : ""}`);
  },
  analysisPlan: (projectId: number, range?: { startChapter?: number | null; endChapter?: number | null }) => {
    const params = new URLSearchParams();
    if (range?.startChapter !== null && range?.startChapter !== undefined) params.set("start_chapter", String(range.startChapter));
    if (range?.endChapter !== null && range?.endChapter !== undefined) params.set("end_chapter", String(range.endChapter));
    const query = params.toString();
    return request<AnalysisPlan>(`/projects/${projectId}/analysis/plan${query ? `?${query}` : ""}`);
  },
  cancelAnalysis: (projectId: number) =>
    request<AnalysisJob>(`/projects/${projectId}/analysis/cancel`, {
      method: "POST",
    }),
  graph: (projectId: number, range?: { startChapter: number | null; endChapter: number | null }) => {
    const params = new URLSearchParams();
    if (range?.startChapter !== null && range?.startChapter !== undefined) {
      params.set("start_chapter", String(range.startChapter));
    }
    if (range?.endChapter !== null && range?.endChapter !== undefined) {
      params.set("end_chapter", String(range.endChapter));
    }
    const query = params.toString();
    return request<GraphPayload>(`/projects/${projectId}/graph${query ? `?${query}` : ""}`);
  },
  updateIssueStatus: (issueId: number, status: IssueStatus) =>
    request<ContinuityIssue>(`/issues/${issueId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  relationEvidence: (relationId: number) => request<EvidenceChunk[]>(`/relations/${relationId}/evidence`),
  issueEvidence: (issueId: number) => request<EvidenceChunk[]>(`/issues/${issueId}/evidence`),
};
