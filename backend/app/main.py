from __future__ import annotations

import asyncio
import base64
import hmac
import logging
import os
import re
import threading
import time
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
os.environ.setdefault("CHROMA_TELEMETRY", "False")

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.chatgpt_routes import router as chatgpt_router, connection as chatgpt_connection
from backend.app.config import app_data_dir, chroma_path, database_path, models_path
from backend.app.database import Database
from backend.app.models import (
    AnalysisJob,
    AnalysisStatus,
    AppSettings,
    ContinuityIssue,
    DocumentDeleteResult,
    DocumentImport,
    DocumentReplace,
    DocumentUpload,
    DocumentUploadReplace,
    EnvironmentSetupProgress,
    EnvironmentSetupRequest,
    EnvironmentStatus,
    EvidenceChunk,
    GraphPayload,
    IssueStatus,
    LocalAiHealth,
    Project,
    ProjectCreate,
    ProjectDeleteResult,
    ProjectUpdate,
    StoryDocument,
    StorySetting,
    StorySettingCreate,
    StorySettingUpdate,
    ForeshadowingStatus,
    ForeshadowingStatusUpdate,
)
from backend.app.pipeline.analyzer import StoryAnalyzer
from backend.app.pipeline.gpt_analyzer import GptStoryAnalyzer, count_review_windows
from backend.app.chatgpt_routes import ManuscriptAnalysisRequest
from backend.app.repository import StoryRepository
from backend.app.services.environment_setup import EnvironmentSetupManager
from backend.app.services.local_ai import (
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_GENERATION_MODEL,
    LocalAiRuntime,
)
from backend.app.services.local_llm import LocalLlmExtractor
from backend.app.services.parser import SUPPORTED_FORMATS, UnsupportedDocumentFormat, read_document, split_chunks
from backend.app.services.rag import RagService


database = Database(database_path())
repository = StoryRepository(database)
local_ai = LocalAiRuntime(models_path())


def save_environment_settings(embedding_model: str, generation_model: str) -> None:
    repository.set_setting("embedding_model", embedding_model)
    repository.set_setting("generation_model", generation_model)


def load_environment_settings() -> AppSettings:
    generation_model = repository.get_setting("generation_model", DEFAULT_GENERATION_MODEL).strip()
    if (
        not generation_model
        or not generation_model.lower().endswith(".gguf")
    ):
        generation_model = DEFAULT_GENERATION_MODEL
    embedding_model = repository.get_setting("embedding_model", DEFAULT_EMBEDDING_MODEL).strip()
    if embedding_model not in {DEFAULT_EMBEDDING_MODEL, "embeddinggemma-300m"}:
        embedding_model = DEFAULT_EMBEDDING_MODEL
    return AppSettings(
        generation_model=generation_model,
        embedding_model=embedding_model or DEFAULT_EMBEDDING_MODEL,
    )


setup_manager = EnvironmentSetupManager(save_environment_settings, load_environment_settings)


def web_origins() -> list[str]:
    """Extra browser origins for a hosted web demo.

    ``STORY_GUARD_WEB_ORIGINS`` is a comma-separated list such as
    ``https://storyguard-demo.vercel.app``.  It is empty for the desktop app,
    so the loopback-only policy above stays unchanged there.
    """
    raw = os.getenv("STORY_GUARD_WEB_ORIGINS", "")
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


def web_mode_enabled() -> bool:
    """True when the backend serves the public web demo instead of a desktop sidecar."""
    return os.getenv("STORY_GUARD_WEB_MODE", "").strip().lower() in {"1", "true", "yes"}


def bind_host() -> str:
    """Desktop keeps loopback; a hosted server sets ``STORY_GUARD_BIND_HOST=0.0.0.0``."""
    return os.getenv("STORY_GUARD_BIND_HOST", "").strip() or "127.0.0.1"


# Desktop-only surfaces that must never be reachable from a public web demo:
# process control, local model setup, ChatGPT device login, and server-path
# file import.  Read-only project browsing stays available.
WEB_MODE_BLOCKED_PREFIXES = (
    "/shutdown",
    "/setup",
    "/documents/import",
    "/documents/replace",
    "/health/local-ai",
    # ChatGPT device login is desktop-only; the web server connects with an
    # API key, so only status/models stay reachable and the sample check is
    # closed because it spends tokens without any limit.
    "/chatgpt/login",
    "/chatgpt/cancel",
    "/chatgpt/logout",
    "/chatgpt/open-verification",
    "/chatgpt/check",
)
WEB_MODE_READ_METHODS = {"GET", "HEAD", "OPTIONS"}
WEB_GPT_ANALYZE_PATH = re.compile(r"^/projects/\d+/(analyze/gpt|analysis/cancel)$")


def web_gpt_analyze_enabled() -> bool:
    """Public GPT analysis is opt-in; it spends the operator's API budget."""
    return os.getenv("STORY_GUARD_WEB_ALLOW_GPT_ANALYZE", "").strip().lower() in {"1", "true", "yes"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw.isdigit() else default


class DailyRequestMeter:
    """Per-day request counts, overall and per client, kept in memory.

    Good enough for a short public demo: the process restart resets it and a
    hard spend limit on the OpenAI project remains the backstop.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        self._day = time.strftime("%Y-%m-%d")
        self._total = 0
        self._by_client: dict[str, int] = defaultdict(int)

    def take(self, client: str, per_client_limit: int, daily_limit: int) -> str | None:
        """Consume one request; return a refusal message or None when allowed."""
        with self._lock:
            today = time.strftime("%Y-%m-%d")
            if today != self._day:
                self.reset()
            if self._total >= daily_limit:
                return "오늘 공개 데모의 GPT 분석 한도에 도달했습니다. 내일 다시 시도해 주세요."
            if self._by_client[client] >= per_client_limit:
                return "이 접속에서 실행할 수 있는 GPT 분석 횟수를 모두 사용했습니다."
            self._total += 1
            self._by_client[client] += 1
            return None


web_gpt_meter = DailyRequestMeter()


def request_client_id(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def web_mode_allows(method: str, path: str) -> bool:
    """Decide whether a request may pass the public web demo guard.

    Reads are allowed except for desktop-only prefixes.  Writes are denied
    unless the path matches ``STORY_GUARD_WEB_WRITE_PATHS`` (a regular
    expression), which the demo's own rate-limited endpoints will use.
    """
    if method == "OPTIONS":
        return True
    if any(path == prefix or path.startswith(prefix + "/") or path.startswith(prefix) for prefix in WEB_MODE_BLOCKED_PREFIXES):
        return False
    if method in WEB_MODE_READ_METHODS:
        return True
    pattern = os.getenv("STORY_GUARD_WEB_WRITE_PATHS", "").strip()
    if not pattern:
        return False
    try:
        return re.fullmatch(pattern, path) is not None
    except re.error:
        logging.getLogger(__name__).error("STORY_GUARD_WEB_WRITE_PATHS 정규식이 잘못되었습니다: %r", pattern)
        return False


app = FastAPI(title="Story Guard API", version="0.1.0")

# Importing several chapters in quick succession should produce one derived
# index build.  Starting a sync for every file reloads the local embedding
# runtime repeatedly and makes bulk imports look hung on laptop hardware.
_index_tasks: dict[int, asyncio.Task] = {}
_index_generations: dict[int, int] = defaultdict(int)


def schedule_project_index(project_id: int, embedding_model: str) -> None:
    """Coalesce bursty document imports into one debounced index sync."""
    _index_generations[project_id] += 1
    task = _index_tasks.get(project_id)
    if task is None or task.done():
        _index_tasks[project_id] = asyncio.create_task(
            _run_scheduled_project_index(project_id, embedding_model)
        )


async def _run_scheduled_project_index(project_id: int, embedding_model: str) -> None:
    task = asyncio.current_task()
    seen_generation = -1
    try:
        while True:
            # Allow a multi-file Finder drop/API burst to settle before the
            # expensive model is loaded.  The analysis endpoint still calls
            # sync_project synchronously, so this remains only a warm cache.
            await asyncio.sleep(0.35)
            seen_generation = _index_generations[project_id]
            request_rag = RagService(
                chroma_path(), embedding_model=embedding_model, repository=repository
            )
            await asyncio.to_thread(request_rag.sync_project, project_id)
            if seen_generation == _index_generations[project_id]:
                return
    except Exception:
        logging.getLogger(__name__).exception("원고 검색 인덱스 준비 실패: project=%s", project_id)
    finally:
        if _index_tasks.get(project_id) is task:
            _index_tasks.pop(project_id, None)
app.include_router(chatgpt_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # Keep an alternate local Vite port available for isolated UI smoke
        # tests without weakening the API to arbitrary web origins.
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://tauri.localhost",
        "tauri://localhost",
        *web_origins(),
    ],
    # Vite may select any free localhost port during a parallel smoke test.
    # Keep the exception limited to loopback origins rather than allowing
    # arbitrary web sites to call the local API.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_local_api_token(request: Request, call_next):
    expected_token = os.getenv("STORY_GUARD_API_TOKEN", "").strip()
    if not expected_token or request.method == "OPTIONS" or request.url.path == "/health":
        return await call_next(request)

    header_token = request.headers.get("x-story-guard-token", "").strip()
    authorization = request.headers.get("authorization", "").strip()
    bearer_token = authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else ""
    if hmac.compare_digest(header_token, expected_token) or hmac.compare_digest(
        bearer_token,
        expected_token,
    ):
        return await call_next(request)

    return JSONResponse(status_code=401, content={"detail": "로컬 API 인증 토큰이 필요합니다."})


@app.middleware("http")
async def public_web_demo_guard(request: Request, call_next):
    if web_mode_enabled():
        path = request.url.path
        if request.method == "POST" and WEB_GPT_ANALYZE_PATH.match(path):
            if not web_gpt_analyze_enabled():
                return JSONResponse(
                    status_code=403,
                    content={"detail": "공개 웹 데모에서는 GPT 분석을 열어 두지 않았습니다. 미리 분석된 결과를 확인해 주세요."},
                )
            if path.endswith("/analyze/gpt"):
                refusal = web_gpt_meter.take(
                    request_client_id(request),
                    _env_int("STORY_GUARD_WEB_GPT_RUNS_PER_CLIENT", 3),
                    _env_int("STORY_GUARD_WEB_GPT_RUNS_PER_DAY", 200),
                )
                if refusal:
                    return JSONResponse(status_code=429, content={"detail": refusal})
        elif not web_mode_allows(request.method, path):
            return JSONResponse(
                status_code=403,
                content={"detail": "공개 웹 데모에서는 사용할 수 없는 기능입니다. 데스크톱 앱에서 제공합니다."},
            )
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
def authenticated_health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/shutdown")
def shutdown(background_tasks: BackgroundTasks) -> dict[str, str]:
    background_tasks.add_task(shutdown_process)
    return {"status": "stopping"}


def shutdown_process() -> None:
    time.sleep(0.2)
    chatgpt_connection.transport.close()
    os._exit(0)


def start_parent_process_monitor() -> None:
    parent_pid = os.getenv("STORY_GUARD_PARENT_PID", "").strip()
    if not parent_pid:
        return
    try:
        pid = int(parent_pid)
    except ValueError:
        return
    monitor = threading.Thread(target=monitor_parent_process, args=(pid,), daemon=True)
    monitor.start()


def monitor_parent_process(parent_pid: int) -> None:
    while True:
        time.sleep(1.0)
        if not process_exists(parent_pid):
            os._exit(0)


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@app.get("/settings", response_model=AppSettings)
def get_settings() -> AppSettings:
    return load_environment_settings()


@app.put("/settings", response_model=AppSettings)
def update_settings(payload: AppSettings) -> AppSettings:
    repository.set_setting("generation_model", payload.generation_model.strip() or DEFAULT_GENERATION_MODEL)
    repository.set_setting("embedding_model", payload.embedding_model.strip() or DEFAULT_EMBEDDING_MODEL)
    return get_settings()


@app.get("/health/local-ai", response_model=LocalAiHealth)
def local_ai_health() -> LocalAiHealth:
    return local_ai.health()


@app.get("/setup/status", response_model=EnvironmentStatus)
def setup_status() -> EnvironmentStatus:
    return setup_manager.status()


@app.get("/setup/progress", response_model=EnvironmentSetupProgress)
def setup_progress() -> EnvironmentSetupProgress:
    return setup_manager.progress()


@app.post("/setup/run", response_model=EnvironmentSetupProgress)
def run_setup(payload: EnvironmentSetupRequest) -> EnvironmentSetupProgress:
    return setup_manager.start(payload)


@app.post("/projects", response_model=Project)
def create_project(payload: ProjectCreate) -> Project:
    return repository.create_project(payload.title)


@app.get("/projects", response_model=list[Project])
def list_projects() -> list[Project]:
    return repository.list_projects()


@app.patch("/projects/{project_id}", response_model=Project)
def update_project(project_id: int, payload: ProjectUpdate) -> Project:
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="작품 제목을 입력해 주세요.")
    try:
        return repository.update_project_title(project_id, title)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="작품을 찾을 수 없습니다.") from error


@app.delete("/projects/{project_id}", response_model=ProjectDeleteResult)
def delete_project(project_id: int) -> ProjectDeleteResult:
    try:
        deleted_project_id = repository.delete_project(project_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="작품을 찾을 수 없습니다.") from error
    try:
        RagService(chroma_path()).delete_project_index(project_id)
    except Exception:
        pass
    return ProjectDeleteResult(project_id=deleted_project_id)


UPLOAD_MAX_BYTES = 5 * 1024 * 1024


def _import_document_from_path(project_id: int, path: Path) -> StoryDocument:
    try:
        content, file_format, content_hash = read_document(path)
    except UnsupportedDocumentFormat as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.") from error
    except UnicodeDecodeError as error:
        raise HTTPException(status_code=400, detail="UTF-8 텍스트 파일만 읽을 수 있습니다. 메모장에서 'UTF-8'로 다시 저장해 주세요.") from error

    existing_documents = repository.list_documents(project_id)
    next_chapter_index = (
        max((document.chapter_index for document in existing_documents), default=-1) + 1
    )
    document = repository.add_document(
        project_id=project_id,
        path=path,
        title=path.stem,
        file_format=file_format,
        content_hash=content_hash,
        content=content,
        chapter_index=next_chapter_index,
        preserve_analysis=True,
    )
    settings = get_settings()
    request_rag = RagService(chroma_path(), embedding_model=settings.embedding_model, repository=repository)
    rag_chunks = request_rag.split_text(content, document.id, project_id)
    chunks = [chunk.text for chunk in rag_chunks] or split_chunks(content)
    repository.replace_chunks(project_id, document.id, chunks)
    # Keep the last published graph visible while the new chapter is indexed
    # and reviewed. The next successful analysis transaction replaces derived
    # results atomically; importing a draft must not make the workspace look
    # empty or discard the author's previous decisions.
    if chunks:
        schedule_project_index(project_id, settings.embedding_model)
    return document


def _replace_document_from_path(document_id: int, path: Path) -> StoryDocument:
    try:
        content, file_format, content_hash = read_document(path)
        if not content.strip():
            raise HTTPException(status_code=400, detail="빈 원고로 교체할 수 없습니다.")
        rag = RagService(chroma_path(), embedding_model=get_settings().embedding_model, repository=repository)
        # Preserve the owning project on rebuilt chunks.  Passing a sentinel
        # project id here makes the replaced document invisible to
        # list_chunks(project_id) and therefore to retrieval/incremental
        # analysis after an author edits an existing episode.
        with repository.database.connect() as connection:
            row = connection.execute("SELECT project_id FROM documents WHERE id=?", (document_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="원고를 찾을 수 없습니다.")
        project_id = int(row["project_id"])
        chunks = [chunk.text for chunk in rag.split_text(content, document_id, project_id)]
        document = repository.replace_document(document_id, path, file_format, content_hash, content, chunks)
    except (FileNotFoundError, KeyError) as error:
        raise HTTPException(status_code=404, detail="원고 또는 파일을 찾을 수 없습니다.") from error
    except UnsupportedDocumentFormat as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except UnicodeDecodeError as error:
        raise HTTPException(status_code=400, detail="UTF-8 텍스트 파일만 읽을 수 있습니다. 메모장에서 'UTF-8'로 다시 저장해 주세요.") from error
    schedule_project_index(document.project_id, get_settings().embedding_model)
    # Retrieval synchronizes the derived index before serving any results.
    return document


def _store_upload(project_id: int, filename: str, content_base64: str) -> Path:
    """Write browser-uploaded bytes under the data folder and return the path.

    The browser cannot hand the server a path, so the file is kept next to the
    database; the rest of the import flow is identical to a path import.
    """
    name = Path(filename.replace("\\", "/")).name.strip()
    if not name or name.startswith("."):
        raise HTTPException(status_code=400, detail="파일 이름을 확인해 주세요.")
    if Path(name).suffix.lower() not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail="txt, md, docx 파일만 올릴 수 있습니다.")
    try:
        data = base64.b64decode(content_base64, validate=True)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="파일 내용을 해석하지 못했습니다.") from error
    if not data:
        raise HTTPException(status_code=400, detail="빈 파일은 올릴 수 없습니다.")
    if len(data) > UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="파일이 너무 큽니다 (최대 5MB).")
    target_dir = app_data_dir() / "uploads" / str(project_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / name
    target.write_bytes(data)
    return target


@app.post("/documents/import", response_model=StoryDocument)
async def import_document(payload: DocumentImport) -> StoryDocument:
    return _import_document_from_path(payload.project_id, Path(payload.path))


@app.post("/documents/upload", response_model=StoryDocument)
async def upload_document(payload: DocumentUpload) -> StoryDocument:
    path = _store_upload(payload.project_id, payload.filename, payload.content_base64)
    return _import_document_from_path(payload.project_id, path)


@app.put("/documents/{document_id}", response_model=StoryDocument)
async def replace_document(document_id: int, payload: DocumentReplace) -> StoryDocument:
    return _replace_document_from_path(document_id, Path(payload.path))


@app.put("/documents/{document_id}/upload", response_model=StoryDocument)
async def replace_document_upload(document_id: int, payload: DocumentUploadReplace) -> StoryDocument:
    with repository.database.connect() as connection:
        row = connection.execute("SELECT project_id FROM documents WHERE id=?", (document_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="원고를 찾을 수 없습니다.")
    path = _store_upload(int(row["project_id"]), payload.filename, payload.content_base64)
    return _replace_document_from_path(document_id, path)


@app.get("/projects/{project_id}/review-history")
def review_history(project_id: int):
    return repository.review_history(project_id)


@app.get("/projects/{project_id}/documents", response_model=list[StoryDocument])
def list_documents(project_id: int) -> list[StoryDocument]:
    return repository.list_documents(project_id)


@app.get("/projects/{project_id}/settings", response_model=list[StorySetting])
def list_story_settings(project_id: int) -> list[StorySetting]:
    return repository.list_story_settings(project_id)


@app.post("/projects/{project_id}/settings", response_model=StorySetting)
def create_story_setting(project_id: int, payload: StorySettingCreate) -> StorySetting:
    try:
        return repository.add_story_setting(project_id, payload.title, payload.content, payload.certainty)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="작품을 찾을 수 없습니다.") from error


@app.patch("/settings/{setting_id}", response_model=StorySetting)
def update_story_setting(setting_id: int, payload: StorySettingUpdate) -> StorySetting:
    try:
        return repository.update_story_setting(setting_id, payload.title, payload.content, payload.certainty)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="설정 메모를 찾을 수 없습니다.") from error


@app.delete("/settings/{setting_id}", response_model=dict[str, int])
def delete_story_setting(setting_id: int) -> dict[str, int]:
    try:
        project_id = repository.delete_story_setting(setting_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="설정 메모를 찾을 수 없습니다.") from error
    return {"project_id": project_id}


@app.get("/projects/{project_id}/foreshadowing/status", response_model=list[ForeshadowingStatus])
def list_foreshadowing_statuses(project_id: int) -> list[ForeshadowingStatus]:
    return repository.list_foreshadowing_statuses(project_id)


@app.patch("/projects/{project_id}/foreshadowing/{entity_id}", response_model=ForeshadowingStatus)
def set_foreshadowing_status(project_id: int, entity_id: int, payload: ForeshadowingStatusUpdate) -> ForeshadowingStatus:
    try:
        return repository.set_foreshadowing_status(project_id, entity_id, payload.status)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="떡밥 후보를 찾을 수 없습니다.") from error


@app.delete("/documents/{document_id}", response_model=DocumentDeleteResult)
def delete_document(document_id: int) -> DocumentDeleteResult:
    try:
        project_id = repository.delete_document(document_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="원고를 찾을 수 없습니다.") from error
    return DocumentDeleteResult(project_id=project_id)


@app.post("/projects/{project_id}/analyze")
def analyze_project(project_id: int) -> dict[str, int]:
    settings = get_settings()
    analyzer = StoryAnalyzer(
        repository,
        RagService(chroma_path(), embedding_model=settings.embedding_model, repository=repository),
        LocalLlmExtractor(model=settings.generation_model, model_dir=models_path()),
    )
    try:
        result = analyzer.analyze_project(project_id)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {
        "entity_count": result.entity_count,
        "relation_count": result.relation_count,
        "issue_count": result.issue_count,
    }


@app.post("/projects/{project_id}/analyze/gpt")
def analyze_project_gpt(project_id: int, payload: ManuscriptAnalysisRequest):
    if not payload.consent:
        raise HTTPException(status_code=400, detail="원문 전송 동의가 필요합니다.")
    settings = get_settings()
    analyzer = GptStoryAnalyzer(repository,
        RagService(chroma_path(), embedding_model=settings.embedding_model, repository=repository), chatgpt_connection)
    try:
        return analyzer.analyze(project_id, payload.model, payload.effort, force=payload.force,
                                batch_limit=payload.batch_limit,
                                start_chapter=payload.start_chapter, end_chapter=payload.end_chapter)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/projects/{project_id}/analysis/status", response_model=AnalysisJob)
def analysis_status(project_id: int) -> AnalysisJob:
    job = repository.latest_analysis_job(project_id)
    if job is not None:
        return job
    return AnalysisJob(
        id=0,
        project_id=project_id,
        status=AnalysisStatus.idle,
        current_step="idle",
        progress=0,
        message="분석 대기 중입니다.",
        created_at="",
        updated_at="",
    )


@app.get("/projects/{project_id}/analysis/estimate")
def analysis_estimate(
    project_id: int,
    start_chapter: int | None = None,
    end_chapter: int | None = None,
) -> dict[str, int | None]:
    """Estimate bounded GPT work using the same chunks as the analyzer.

    Chapter bounds are zero-based, matching the graph endpoint and GPT
    analysis request. Invalid ranges are rejected before any work is queued.
    """
    if start_chapter is not None and end_chapter is not None and start_chapter > end_chapter:
        raise HTTPException(status_code=422, detail="분석 회차 범위가 올바르지 않습니다.")
    documents = repository.list_documents(project_id)
    if start_chapter is not None or end_chapter is not None:
        documents = [document for document in documents if
                     (start_chapter is None or document.chapter_index >= start_chapter) and
                     (end_chapter is None or document.chapter_index <= end_chapter)]
    document_ids = {document.id for document in documents}
    rows = [row for row in repository.list_chunks(project_id) if row["document_id"] in document_ids]
    return {
        "document_count": len(documents),
        # Report the canonical manuscript size. Chunk overlap is useful for
        # retrieval but must not inflate the amount of source text shown to
        # the writer or used in workload estimates.
        "manuscript_chars": sum(len(document.content) for document in documents),
        "chunk_count": len(rows),
        "review_window_count": count_review_windows(documents, rows),
        "start_chapter": start_chapter,
        "end_chapter": end_chapter,
    }


def recommend_analysis_plan(review_windows: int) -> tuple[str, int, str]:
    if review_windows <= 20:
        return "full", review_windows or 1, "전체 범위를 한 번에 검토해도 되는 규모입니다."
    if review_windows <= 100:
        return "segmented", 20, "회차 묶음으로 나누어 검토하면 진행 상황과 재시도를 관리하기 쉽습니다."
    return "staged", 20, "장편 규모입니다. 20개 구간씩 단계적으로 검토하고 완료분을 먼저 확인하세요."


def analysis_batch_count(review_windows: int, batch_size: int) -> int:
    if review_windows <= 0:
        return 0
    return (review_windows + batch_size - 1) // batch_size


@app.get("/projects/{project_id}/analysis/plan")
def analysis_plan(
    project_id: int,
    start_chapter: int | None = None,
    end_chapter: int | None = None,
) -> dict[str, int | str | None]:
    """Recommend a safe review mode from the measured workload."""
    estimate = analysis_estimate(project_id, start_chapter, end_chapter)
    windows = int(estimate["review_window_count"])
    mode, batch_size, message = recommend_analysis_plan(windows)
    # Measured local-throughput hints: EmbeddingGemma ~7 chunks/s and Qwen
    # llama.cpp ~1.4 chunks/s on the validation laptop. Keep this explicitly
    # approximate; the progress panel remains authoritative once indexing starts.
    chunks = int(estimate["chunk_count"])
    embedding_model = get_settings().embedding_model
    chunks_per_second = 7.0 if embedding_model == "embeddinggemma-300m" else 1.4
    embedding_memory_mb = 1659 if embedding_model == "embeddinggemma-300m" else 2275
    embedding_seconds = int(round(chunks / chunks_per_second)) if chunks else 0
    # Provider/network latency varies; this middle projection is guidance
    # only. Live job progress remains authoritative.
    gpt_seconds = windows * 30
    gpt_min_seconds = windows * 15
    gpt_max_seconds = windows * 60
    return {**estimate, "mode": mode, "recommended_batch_size": batch_size,
            "embedding_model": embedding_model,
            "embedding_estimate_seconds": embedding_seconds,
            "embedding_memory_estimate_mb": embedding_memory_mb,
            "gpt_estimate_seconds": gpt_seconds,
            "gpt_estimate_min_seconds": gpt_min_seconds,
            "gpt_estimate_max_seconds": gpt_max_seconds,
            "batch_count": analysis_batch_count(windows, batch_size), "message": message}


@app.post("/projects/{project_id}/analysis/cancel", response_model=AnalysisJob)
def cancel_analysis(project_id: int) -> AnalysisJob:
    job = repository.latest_analysis_job(project_id)
    if job and job.status != AnalysisStatus.running:
        return job
    return repository.cancel_analysis(project_id, preserve_results=bool(job and job.current_step.startswith("gpt_")))


@app.get("/projects/{project_id}/graph", response_model=GraphPayload)
def project_graph(
    project_id: int,
    start_chapter: int | None = None,
    end_chapter: int | None = None,
) -> GraphPayload:
    return repository.graph(project_id, start_chapter=start_chapter, end_chapter=end_chapter)


@app.patch("/issues/{issue_id}/status", response_model=ContinuityIssue)
def update_issue_status(issue_id: int, payload: dict[str, IssueStatus]) -> ContinuityIssue:
    status = payload.get("status")
    if status not in {"open", "accepted", "ignored", "deferred"}:
        raise HTTPException(status_code=400, detail="지원하지 않는 이슈 상태입니다.")
    try:
        return repository.update_issue_status(issue_id, status)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="이슈를 찾을 수 없습니다.") from error


@app.get("/issues/{issue_id}/evidence", response_model=list[EvidenceChunk])
def issue_evidence(issue_id: int) -> list[EvidenceChunk]:
    with database.connect() as connection:
        row = connection.execute("SELECT evidence_chunk_ids FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="이슈를 찾을 수 없습니다.")
    import json

    chunk_ids = json.loads(row["evidence_chunk_ids"] or "[]")
    return [EvidenceChunk(**chunk) for chunk in repository.get_chunks(chunk_ids)]


@app.get("/relations/{relation_id}/evidence", response_model=list[EvidenceChunk])
def relation_evidence(relation_id: int) -> list[EvidenceChunk]:
    import json
    with repository.database.connect() as connection:
        row = connection.execute("SELECT project_id,evidence_chunk_ids FROM relations WHERE id=?", (relation_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="관계를 찾을 수 없습니다.")
    return [EvidenceChunk(**chunk) for chunk in repository.get_chunks(json.loads(row['evidence_chunk_ids']))
            if chunk['project_id'] == row['project_id']]


def main() -> None:
    import uvicorn

    start_parent_process_monitor()
    repository.mark_running_jobs_interrupted()
    port = int(os.getenv("STORY_GUARD_BACKEND_PORT", "8765"))
    uvicorn.run("backend.app.main:app", host=bind_host(), port=port, reload=False)


if __name__ == "__main__":
    main()
