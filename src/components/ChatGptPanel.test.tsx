import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatGptPanel, WebDemoQuotaNotice, estimateReviewWindows, formatDurationRange, formatMemoryGigabytes } from "./ChatGptPanel";

describe("ChatGPT connection", () => {
  it("distinguishes connection verification from existing local analysis", () => {
    const html = renderToStaticMarkup(<ChatGptPanel />);
    expect(html).toContain("ChatGPT 연결");
    expect(html).toContain("설정 충돌 후보와 관계 지도를 함께");
    expect(html).not.toContain("실제 모델 응답");
  });
});

import { ReasoningEffortSelect } from "./ChatGptPanel";

it("shows only model-supported efforts and marks its default", () => {
  const html = renderToStaticMarkup(<ReasoningEffortSelect model={{ id: "a", name: "A", default_effort: "medium", efforts: [
    { value: "low", description: "Fast" }, { value: "medium", description: "Balanced" },
  ] }} value="medium" disabled={false} onChange={() => {}} />);
  expect(html).toContain("낮음 · Low");
  expect(html).toContain("보통 · Medium (기본)");
  expect(html).not.toContain("높음 · High");
});

it("disables effort selection when capability data is missing", () => {
  const html = renderToStaticMarkup(<ReasoningEffortSelect value="" disabled={false} onChange={() => {}} />);
  expect(html).toContain("disabled");
  expect(html).toContain("모델 기본값");
});

it("estimates long manuscripts per episode instead of hiding request volume", () => {
  expect(estimateReviewWindows(Array.from({ length: 100 }, () => 6200), 620000)).toBe(200);
  expect(estimateReviewWindows([], 620000)).toBe(120);
});

it("formats GPT estimate ranges with one clear approximation label", () => {
  expect(formatDurationRange(900, 3600)).toBe("약 15분~60분");
});

it("formats measured embedding memory in the same decimal unit used by the docs", () => {
  expect(formatMemoryGigabytes(2275)).toBe("2.27GB");
  expect(formatMemoryGigabytes(0)).toBe("확인 필요");
});

it("shows the effective daily web demo quota and sample bounds", () => {
  const html = renderToStaticMarkup(<WebDemoQuotaNotice quota={{
    enabled: true,
    limit: 3,
    used: 1,
    remaining: 2,
    ip_limit: 9,
    ip_remaining: 8,
    total_limit: 200,
    total_remaining: 150,
    resets_at: "2026-09-17T00:00:00Z",
    max_chapters: 2,
    max_review_windows: 4,
  }} />);
  expect(html).toContain("오늘 남은 분석 2/3회");
  expect(html).toContain("최대 2개 회차·4개 검토 구간");
});
