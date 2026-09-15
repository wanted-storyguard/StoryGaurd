import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ChatGptModel, ChatGptStatus } from "../lib/types";

export function estimateReviewWindows(documentCharCounts: number[], manuscriptChars: number): number {
  return Math.max(1, documentCharCounts.length
    ? documentCharCounts.reduce((total, chars) => total + Math.max(1, Math.ceil(chars / 5200)), 0)
    : Math.ceil(manuscriptChars / 5200));
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `약 ${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `약 ${minutes}분 ${rest}초` : `약 ${minutes}분`;
}

export function formatDurationRange(minSeconds: number, maxSeconds: number) {
  const min = formatDuration(minSeconds).replace(/^약\s*/, "");
  const max = formatDuration(maxSeconds).replace(/^약\s*/, "");
  return `약 ${min}~${max}`;
}

export function formatMemoryGigabytes(megabytes: number) {
  if (!Number.isFinite(megabytes) || megabytes <= 0) return "확인 필요";
  return `${(megabytes / 1000).toFixed(2)}GB`;
}

export function ChatGptPanel({ projectId, projectTitle, hasDocuments = false, documentCount = 0, manuscriptChars = 0, documentCharCounts = [], analyzing = false, onAnalyze, showAnalysis = true, compact = false, chapters = [], analysisRange = { startChapter: null, endChapter: null }, onAnalysisRangeChange }: {
  projectId?: number; projectTitle?: string; hasDocuments?: boolean; analyzing?: boolean;
  documentCount?: number; manuscriptChars?: number; documentCharCounts?: number[];
  showAnalysis?: boolean;
  compact?: boolean;
  chapters?: { chapterIndex: number; title: string }[];
  analysisRange?: { startChapter: number | null; endChapter: number | null };
  onAnalysisRangeChange?: (range: { startChapter: number | null; endChapter: number | null }) => void;
  onAnalyze?: (model: string, effort?: string, force?: boolean, range?: { startChapter: number | null; endChapter: number | null }) => Promise<void>;
} = {}) {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [initialStatusChecking, setInitialStatusChecking] = useState(true);
  const initialCheckActive = useRef(true);
  const [models, setModels] = useState<ChatGptModel[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const selectedModel = models.find(value => value.id === model);
  const options = selectedModel?.efforts ?? [];
  const selectedEffort = options.some(option => option.value === effort) ? effort
    : options.some(option => option.value === selectedModel?.default_effort) ? selectedModel!.default_effort! : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [reuseResults, setReuseResults] = useState(true);
  const [manuscriptConsent, setManuscriptConsent] = useState(false);
  const [serverEstimate, setServerEstimate] = useState<{ documentCount: number; manuscriptChars: number; reviewWindows: number; embeddingModel?: string; embeddingEstimateSeconds?: number; embeddingMemoryEstimateMb?: number; gptEstimateSeconds?: number; gptEstimateMinSeconds?: number; gptEstimateMaxSeconds?: number; mode?: string; batchSize?: number; batchCount?: number; planMessage?: string } | null>(null);
  const estimatedReviewWindows = serverEstimate?.reviewWindows ?? estimateReviewWindows(documentCharCounts, manuscriptChars);
  const estimatedDocumentCount = serverEstimate?.documentCount ?? documentCount;
  const estimatedManuscriptChars = serverEstimate?.manuscriptChars ?? manuscriptChars;
  useEffect(() => { setManuscriptConsent(false); }, [projectId]);
  useEffect(() => {
    let disposed = false;
    setServerEstimate(null);
    if (!projectId || !hasDocuments) return () => { disposed = true; };
    api.analysisPlan(projectId, analysisRange).then(value => {
      if (!disposed) setServerEstimate({ documentCount: value.document_count, manuscriptChars: value.manuscript_chars, reviewWindows: value.review_window_count, embeddingModel: value.embedding_model, embeddingEstimateSeconds: value.embedding_estimate_seconds, embeddingMemoryEstimateMb: value.embedding_memory_estimate_mb, gptEstimateSeconds: value.gpt_estimate_seconds, gptEstimateMinSeconds: value.gpt_estimate_min_seconds, gptEstimateMaxSeconds: value.gpt_estimate_max_seconds, mode: value.mode, batchSize: value.recommended_batch_size, batchCount: value.batch_count, planMessage: value.message });
    }).catch(() => { /* props-based estimate remains available while the sidecar starts */ });
    return () => { disposed = true; };
  }, [projectId, hasDocuments, documentCount, manuscriptChars, analysisRange.startChapter, analysisRange.endChapter]);
  const [consent, setConsent] = useState(false);
  const rangeLabel = analysisRange.startChapter === null && analysisRange.endChapter === null
    ? "작품 전체"
    : `${(analysisRange.startChapter ?? analysisRange.endChapter ?? 0) + 1}화–${(analysisRange.endChapter ?? analysisRange.startChapter ?? 0) + 1}화`;

  function updateRange(startValue: string, endValue: string) {
    if (startValue === "all" || endValue === "all") {
      onAnalysisRangeChange?.({ startChapter: null, endChapter: null });
      return;
    }
    const start = startValue === "all" ? null : Number(startValue);
    const end = endValue === "all" ? null : Number(endValue);
    if (start !== null && end !== null && start > end) {
      onAnalysisRangeChange?.({ startChapter: start, endChapter: start });
      return;
    }
    onAnalysisRangeChange?.({ startChapter: start, endChapter: end });
  }

  useEffect(() => {
    // Each setup owns a new check, including React StrictMode's setup-cleanup-setup.
    initialCheckActive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // A packaged macOS sidecar can take 20–30 seconds to bind while the
    // local runtime warms up. Keep the initial status check in a pending
    // state for that window instead of telling a returning writer that their
    // saved connection disappeared. The final attempt still has a bound
    // limit, so a genuinely unavailable backend reaches the actionable
    // manual check state.
    const delays = [500, 1000, 2000, 3500, 5000, 8000, 10000, 12000];
    const check = async () => {
      if (!initialCheckActive.current) return;
      try {
        const value = await api.chatGptStatus();
        if (disposed || !initialCheckActive.current) return;
        // The sidecar can briefly answer `unavailable` while it is starting.
        // Keep that race out of the first paint and retry before surfacing it.
        if (value.phase === "unavailable" && attempt < delays.length - 1) {
          attempt += 1;
          timer = setTimeout(check, delays[attempt]);
          return;
        }
        setStatus(value.phase === "unavailable" ? null : value);
        setError(value.phase === "unavailable"
          ? "연결 상태를 자동으로 확인하지 못했습니다. ‘상태 확인’을 눌러 다시 시도해 주세요."
          : "");
        setInitialStatusChecking(false);
        initialCheckActive.current = false;
      } catch {
        if (disposed || !initialCheckActive.current) return;
        if (attempt < delays.length - 1) {
          attempt += 1;
          timer = setTimeout(check, delays[attempt]);
          return;
        }
        setInitialStatusChecking(false);
        initialCheckActive.current = false;
        setError("연결 상태를 자동으로 확인하지 못했습니다. ‘상태 확인’을 눌러 다시 시도해 주세요.");
      }
    };
    // Give the desktop sidecar a moment to bind before the first request.
    timer = setTimeout(check, delays[0]);
    return () => { disposed = true; initialCheckActive.current = false; if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (status?.phase !== "pending") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.chatGptStatus();
        if (!disposed) { setStatus(next); setError(""); }
        if (!disposed && next.phase === "pending") timer = setTimeout(poll, 2500);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    };
    timer = setTimeout(poll, 2500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [status?.phase]);

  useEffect(() => {
    let disposed = false;
    if (status?.phase !== "connected") { setModels([]); setModel(""); setResult(""); return; }
    api.chatGptModels().then(values => {
      if (disposed) return;
      setModels(values);
      setModel(current => values.some(value => value.id === current) ? current : values[0]?.id ?? "");
    }).catch(e => { if (!disposed) setError(String(e.message)); });
    return () => { disposed = true; };
  }, [status?.phase]);

  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const apiKeyMode = status?.method === "api_key";
  const usageOwner = apiKeyMode ? "서버에 설정된 OpenAI API 키의 사용량" : "내 계정의 사용 한도";
  return <section className={`setup-panel chatgpt-panel${compact ? " chatgpt-panel-compact" : ""}`} aria-label={apiKeyMode ? "OpenAI API 연결" : "ChatGPT 계정 연결"}>
    <div className="setup-heading">
      <div><span className="label">{apiKeyMode ? "OpenAI API 키 · 서버 연결" : "ChatGPT 계정 · Codex 연결"}</span>
        <h3>{status?.phase === "connected" ? `연결됨${status.plan ? ` · ${status.plan}` : ""}` : status === null && initialStatusChecking ? "연결 상태 확인 중…" : apiKeyMode ? "서버 API 키로 AI 연결" : "내 계정으로 AI 연결"}</h3>
      </div>
      <div className="setup-actions">
        <button disabled={busy} onClick={() => act(async () => { initialCheckActive.current = false; setStatus(await api.chatGptStatus()); setInitialStatusChecking(false); })}>상태 확인</button>
        {apiKeyMode ? null : status?.phase === "connected"
          ? <button disabled={busy} onClick={() => act(async () => { setStatus(await api.chatGptLogout()); })}>연결 해제</button>
          : status?.phase === "pending"
            ? <button disabled={busy} onClick={() => act(async () => { setStatus(await api.chatGptCancel()); })}>인증 취소</button>
            : <button disabled={busy || status === null} onClick={() => act(async () => { setStatus(await api.chatGptLogin()); })}>{busy ? "연결 중…" : "ChatGPT 연결"}</button>}
      </div>
    </div>
    {apiKeyMode && status?.phase !== "connected" && <p role="status">서버에 OPENAI_API_KEY가 설정되면 자동으로 연결됩니다. 로그인 절차는 없습니다.</p>}
    {!compact && <p>GPT 작품 분석은 로컬 검색으로 찾은 원문을 검토하고 설정 충돌 후보와 관계 지도를 함께 만듭니다. 관계는 AI가 추출한 후보이며 원문 근거로 확인할 수 있습니다.</p>}
    {status?.phase === "pending" && <div className="chatgpt-code">
      <p>아래 코드를 OpenAI 인증 페이지에 입력해 주세요. 인증을 마치면 자동으로 연결됩니다.</p>
      <strong aria-label="기기 인증 코드">{status.user_code}</strong>
      <span>{status.verification_url}</span>
      <button disabled={busy} onClick={() => act(async () => { await api.chatGptOpenVerification(); })}>인증 페이지 열기</button>
    </div>}
    {status?.phase === "expired" && <p role="status">인증 대기 시간이 지났습니다. 다시 연결해 주세요.</p>}
    {status?.phase === "connected" && <div className="chatgpt-check">
      <label>사용 가능한 모델 <select aria-label="ChatGPT 모델" value={model} disabled={busy || !models.length} onChange={e => { setModel(e.target.value); setEffort(""); setResult(""); }}>
        {models.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
      </select></label>
      <ReasoningEffortSelect model={selectedModel} value={selectedEffort} disabled={busy} onChange={value => { setEffort(value); setResult(""); }} />
      <p>추론 강도가 높을수록 더 오래 검토할 수 있으며 응답 시간이 늘어날 수 있습니다.</p>
      {!models.length && <p>모델 목록을 불러오지 못했다면 상태 확인 후 다시 연결해 주세요.</p>}
      {showAnalysis && <div>
        <strong>{projectTitle ? `분석할 작품 · ${projectTitle}` : "작품을 먼저 선택해 주세요"}</strong>
        <p>현재 GPT 분석은 <strong>{rangeLabel}</strong>을 검토합니다. 원고 구간마다 관련 근거를 검색해 OpenAI로 전송합니다. 원고가 길수록 요청 횟수와 계정 사용량이 늘어납니다. 결과는 작가가 검토할 후보입니다.</p>
        {hasDocuments && <>
          {chapters.length > 1 && <div className="analysis-range-picker" role="group" aria-label="GPT 분석 회차 범위">
            <span className="analysis-range-label">분석 회차</span>
            <label>시작 <select aria-label="분석 시작 회차" value={analysisRange.startChapter ?? "all"} disabled={busy || analyzing} onChange={event => updateRange(event.target.value, analysisRange.endChapter === null ? event.target.value : String(analysisRange.endChapter))}>
              <option value="all">전체</option>
              {chapters.map(chapter => <option key={chapter.chapterIndex} value={chapter.chapterIndex}>{chapter.chapterIndex + 1}화 · {chapter.title}</option>)}
            </select></label>
            <span aria-hidden="true">→</span>
            <label>끝 <select aria-label="분석 종료 회차" value={analysisRange.endChapter ?? "all"} disabled={busy || analyzing} onChange={event => updateRange(analysisRange.startChapter === null ? event.target.value : String(analysisRange.startChapter), event.target.value)}>
              <option value="all">전체</option>
              {chapters.map(chapter => <option key={chapter.chapterIndex} value={chapter.chapterIndex}>{chapter.chapterIndex + 1}화</option>)}
            </select></label>
            <small>긴 원고는 범위를 나눠 분석하면 실패 구간을 격리하고 완료된 결과를 보존할 수 있습니다.</small>
          </div>}
          <p className="analysis-estimate" role="status">현재 {estimatedDocumentCount}편 · {estimatedManuscriptChars.toLocaleString("ko-KR")}자 · 예상 검토 구간 약 {estimatedReviewWindows}개. 실제 청크 기준으로 계산하며 회차별로 나누어 검토하고 기존 검증 구간은 재사용합니다.</p>
          {serverEstimate?.embeddingEstimateSeconds ? <p className="analysis-estimate" role="note">로컬 임베딩 준비 예상 {formatDuration(serverEstimate.embeddingEstimateSeconds)} · {serverEstimate.embeddingModel ?? "선택한 임베딩 모델"}. 장치 성능에 따라 달라지며, 첫 색인 후에는 변경된 청크만 처리합니다.</p> : null}
          {serverEstimate?.embeddingMemoryEstimateMb ? <p className="analysis-estimate analysis-estimate-warning" role="note">임베딩 실행 메모리 참고치 약 {formatMemoryGigabytes(serverEstimate.embeddingMemoryEstimateMb)} (검증한 Mac 기준). 실제 사용량은 운영체제·모델·장치에 따라 달라집니다.</p> : null}
          {serverEstimate?.gptEstimateSeconds ? <p className="analysis-estimate" role="note">GPT 검토 예상 {serverEstimate.gptEstimateMinSeconds ? formatDurationRange(serverEstimate.gptEstimateMinSeconds, serverEstimate.gptEstimateMaxSeconds ?? serverEstimate.gptEstimateSeconds) : formatDuration(serverEstimate.gptEstimateSeconds)} · 구간당 15~60초를 적용한 안내용 범위입니다. 실제 시간은 선택한 모델·네트워크·계정 상태에 따라 달라집니다.</p> : null}
          {serverEstimate?.mode && <p className="analysis-estimate analysis-plan" role="note">권장 방식: {serverEstimate.mode === "full" ? "전체 분석" : serverEstimate.mode === "segmented" ? `분할 분석 (${serverEstimate.batchSize}개 구간씩)` : `단계 분석 (${serverEstimate.batchSize}개 구간씩)`}. {serverEstimate.batchCount ? `총 ${serverEstimate.batchCount}개 묶음. ` : ""}{serverEstimate.planMessage}</p>}
          {estimatedReviewWindows >= 100 && <p className="analysis-estimate analysis-estimate-warning" role="note">장편 원고입니다. 이번 실행은 최대 {serverEstimate?.batchSize ?? 20}개 구간만 처리하고 완료분을 체크포인트에 보존합니다{serverEstimate?.batchCount ? ` (전체 ${serverEstimate.batchCount}개 묶음)` : ""}. 전체 검증이 끝난 뒤 그래프에 게시하며, 앱을 닫아도 다음 실행에서 남은 묶음을 이어갑니다.</p>}
        </>}
        <label><input type="checkbox" checked={manuscriptConsent} disabled={busy || analyzing || !hasDocuments} onChange={e => setManuscriptConsent(e.target.checked)} /> 선택한 작품의 원문을 OpenAI에 전송하고 {usageOwner}을 사용하는 데 동의합니다.</label>
        <label><input type="checkbox" checked={reuseResults} disabled={busy || analyzing} onChange={e => setReuseResults(e.target.checked)} /> 동일한 원문·검색 근거·모델·추론 강도의 검증된 결과 재사용 (추가 GPT 요청 절약)</label>
        <button disabled={busy || analyzing || !model || !hasDocuments || !manuscriptConsent || !onAnalyze} onClick={() => act(async () => { await onAnalyze?.(model, selectedEffort || undefined, !reuseResults, analysisRange); })}>{analyzing ? "작품 분석 중…" : "이 작품 GPT 분석"}</button>
      </div>}
      {showAnalysis && !compact && !apiKeyMode && <><label><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /> 가상 원고 4문장을 OpenAI에 전송하고 내 계정의 사용 한도를 사용하는 데 동의합니다.</label>
      <button disabled={busy || !model || !consent} onClick={() => act(async () => { setResult(""); setResult((await api.chatGptCheck(model, selectedEffort || undefined)).text); })}>{busy ? "확인 중…" : "샘플로 연결 검증"}</button></>}
    </div>}
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    {result && <div className="chatgpt-result" role="status"><strong>실제 모델 응답</strong><p>{result}</p></div>}
  </section>;
}

const EFFORT_LABELS: Record<string, string> = {
  none: "없음 · None", minimal: "최소 · Minimal", low: "낮음 · Low",
  medium: "보통 · Medium", high: "높음 · High", xhigh: "매우 높음 · XHigh",
  max: "최대 · Max", ultra: "최상 · Ultra",
};

export function ReasoningEffortSelect({ model, value, disabled, onChange }: {
  model?: ChatGptModel; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const options = model?.efforts ?? [];
  return <label>추론 강도 <select aria-label="추론 강도" value={value} disabled={disabled || !options.length} onChange={event => onChange(event.target.value)}>
    {!value && <option value="">모델 기본값</option>}
    {options.map(option => <option key={option.value} value={option.value} title={option.description}>
      {EFFORT_LABELS[option.value] ?? option.value}{option.value === model?.default_effort ? " (기본)" : ""}
    </option>)}
  </select></label>;
}
