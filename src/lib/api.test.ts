import { afterEach, describe, expect, it, vi } from "vitest";

import { api, setApiToken } from "./api";

describe("api client", () => {
  afterEach(() => {
    setApiToken("");
    vi.unstubAllGlobals();
  });

  it("uses the local backend by default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.health()).resolves.toEqual({ status: "ok" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/health",
      expect.objectContaining({
        headers: expect.not.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("throws backend detail messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Local AI 연결 실패" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(api.health()).rejects.toThrow("Local AI 연결 실패");
  });

  it("adds the desktop api token when configured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchMock);
    setApiToken("desktop-token");

    await expect(api.ready()).resolves.toEqual({ status: "ok" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/health/ready",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Story-Guard-Token": "desktop-token",
        }),
      }),
    );
  });

  it("updates project titles with PATCH", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 7,
            title: "유리 종루의 밤",
            root_path: null,
            created_at: "2026-06-20 00:00:00",
            updated_at: "2026-06-20 00:00:00",
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.updateProjectTitle(7, "유리 종루의 밤")).resolves.toMatchObject({
      id: 7,
      title: "유리 종루의 밤",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/projects/7",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "유리 종루의 밤" }),
      }),
    );
  });

  it("deletes documents with DELETE", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            project_id: 3,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteDocument(42)).resolves.toEqual({ project_id: 3 });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/documents/42",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  it("deletes projects with DELETE", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            project_id: 7,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteProject(7)).resolves.toEqual({ project_id: 7 });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/projects/7",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  it("loads the latest project analysis status", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 12,
            project_id: 7,
            status: "running",
            current_step: "extract",
            progress: 42,
            message: "LLM이 원고를 분석 중입니다.",
            created_at: "2026-06-20 00:00:00",
            updated_at: "2026-06-20 00:00:01",
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.analysisStatus(7)).resolves.toMatchObject({
      status: "running",
      current_step: "extract",
      progress: 42,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/projects/7/analysis/status",
      expect.objectContaining({
        headers: expect.not.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("cancels project analysis with POST", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 13,
            project_id: 7,
            status: "cancelled",
            current_step: "cancelled",
            progress: 100,
            message: "분석이 취소되어 생성 중이던 내용이 삭제되었습니다.",
            created_at: "2026-06-20 00:00:00",
            updated_at: "2026-06-20 00:00:01",
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.cancelAnalysis(7)).resolves.toMatchObject({
      status: "cancelled",
      current_step: "cancelled",
      progress: 100,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/projects/7/analysis/cancel",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});

describe("ChatGPT endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("starts device authentication without collecting passwords", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ phase: "pending", user_code: "TEST-CODE" })));
    vi.stubGlobal("fetch", fetchMock);
    await api.chatGptLogin();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/chatgpt/login", expect.objectContaining({ method: "POST" }));
  });
  it("passes only the explicitly selected model to the sample check", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "sample" })));
    vi.stubGlobal("fetch", fetchMock);
    await api.chatGptCheck("available-model", "high");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/chatgpt/check", expect.objectContaining({ body: JSON.stringify({ model: "available-model", effort: "high" }) }));
  });
});

it("passes the chosen model, effort and manuscript consent to GPT analysis", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issue_count: 1 })));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await api.analyzeProjectGpt(42, "chosen-model", "high");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/projects/42/analyze/gpt",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "chosen-model", effort: "high", consent: true, force: false }) }));
  } finally { vi.unstubAllGlobals(); }
});

it("passes the bounded batch limit for long manuscript analysis", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issue_count: 0 })));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await api.analyzeProjectGpt(42, "chosen-model", "medium", false, 20);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/projects/42/analyze/gpt",
      expect.objectContaining({ body: JSON.stringify({ model: "chosen-model", effort: "medium", consent: true, force: false, batch_limit: 20 }) }));
  } finally { vi.unstubAllGlobals(); }
});

it("passes an explicitly selected chapter range to GPT analysis", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issue_count: 0 })));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await api.analyzeProjectGpt(42, "chosen-model", "medium", false, 20, { startChapter: 10, endChapter: 19 });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/projects/42/analyze/gpt",
      expect.objectContaining({ body: JSON.stringify({ model: "chosen-model", effort: "medium", consent: true, force: false, batch_limit: 20, start_chapter: 10, end_chapter: 19 }) }));
  } finally { vi.unstubAllGlobals(); }
});

it("loads source text for the selected relationship", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify([])));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await api.relationEvidence(42);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/relations/42/evidence", expect.anything());
  } finally { vi.unstubAllGlobals(); }
});
