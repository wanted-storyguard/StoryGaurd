from __future__ import annotations

from enum import Enum
from typing import Literal

import json
from pydantic import BaseModel, Field, field_validator


EntityType = Literal[
    "character",
    "place",
    "organization",
    "item",
    "event",
    "rule",
    "foreshadowing",
]

IssueCategory = Literal[
    "timeline",
    "character_state",
    "world_rule",
    "relationship",
    "unresolved_foreshadowing",
    "contradiction",
]

IssueStatus = Literal["open", "accepted", "ignored", "deferred"]


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class ProjectUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class Project(BaseModel):
    id: int
    title: str
    root_path: str | None = None
    created_at: str
    updated_at: str
    document_count: int = 0
    pending_document_count: int = 0
    open_issue_count: int = 0
    last_analyzed_at: str | None = None


class DocumentImport(BaseModel):
    project_id: int
    path: str


class DocumentReplace(BaseModel):
    path: str


class DocumentUpload(BaseModel):
    """A manuscript sent from the browser: bytes, not a server path."""

    project_id: int
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=1)


class DocumentUploadReplace(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=1)


class DocumentDeleteResult(BaseModel):
    project_id: int


class ProjectDeleteResult(BaseModel):
    project_id: int


class StoryDocument(BaseModel):
    id: int
    project_id: int
    path: str
    title: str
    format: str
    chapter_index: int
    content_hash: str
    content: str
    created_at: str
    analysis_status: Literal["pending", "analyzed", "stale"] = "pending"
    analyzed_at: str | None = None
    analysis_entity_count: int = 0
    analysis_relation_count: int = 0
    analysis_claim_count: int = 0


class StorySettingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=20_000)
    certainty: Literal["confirmed", "draft"] = "draft"


class StorySettingUpdate(StorySettingCreate):
    pass


class StorySetting(BaseModel):
    id: int
    project_id: int
    title: str
    content: str
    certainty: Literal["confirmed", "draft"]
    updated_at: str


class ForeshadowingStatusUpdate(BaseModel):
    status: Literal["unreviewed", "in_progress", "resolved", "intentional"]


class ForeshadowingStatus(BaseModel):
    entity_id: int
    project_id: int
    status: Literal["unreviewed", "in_progress", "resolved", "intentional"]
    updated_at: str


class EntityNode(BaseModel):
    id: int
    project_id: int
    type: EntityType
    name: str
    aliases: list[str] = []
    summary: str
    first_seen_document_id: int | None = None
    mention_count: int = 0
    document_ids: list[int] = []
    document_count: int = 0
    last_seen_document_id: int | None = None
    appearance_state: Literal["new", "active", "fading", "dormant"] = "active"
    visual_weight: float = 0.5


class RelationQuote(BaseModel):
    chunk_id: int
    quote: str
    document_id: int
    chapter_index: int


class RelationClaim(BaseModel):
    explanation: str
    basis: Literal["explicit", "inferred"]
    quotes: list[RelationQuote]


class RelationEdge(BaseModel):
    claims: list[RelationClaim] = []
    origin: Literal["local", "gpt"] = "local"
    id: int
    project_id: int
    source_entity_id: int
    target_entity_id: int
    type: str
    confidence: float = 0.7
    evidence_chunk_ids: list[int] = []
    strength: float = 0.5
    is_weak: bool = False
    is_recent: bool = True
    display_label: str = ""


class ContinuityIssue(BaseModel):
    id: int
    project_id: int
    severity: Literal["low", "medium", "high"]
    category: IssueCategory
    title: str
    description: str
    evidence_chunk_ids: list[int] = []
    status: IssueStatus = "open"


class EvidenceChunk(BaseModel):
    id: int
    document_id: int
    project_id: int
    chunk_index: int
    text: str
    start_offset: int = 0
    end_offset: int = 0


class RelationChange(BaseModel):
    id: int
    project_id: int
    source_entity_id: int
    target_entity_id: int
    source_name: str
    target_name: str
    previous_type: str
    current_type: str
    previous_document_id: int
    current_document_id: int
    description: str
    evidence_chunk_ids: list[int] = []


class RelationTimelineEvent(BaseModel):
    source_entity_id: int
    target_entity_id: int
    source_name: str
    target_name: str
    relation_type: str
    chapter_index: int
    document_id: int
    evidence_chunk_ids: list[int] = []
    status: Literal["observed", "changed", "gap", "explicit_break"] = "observed"
    gap_before: bool = False


class GraphRange(BaseModel):
    start_chapter: int | None = None
    end_chapter: int | None = None
    document_ids: list[int] = []
    document_count: int = 0
    continuity_ready: bool = False
    message: str = ""


class GraphHealth(BaseModel):
    connected_entity_count: int = 0
    component_count: int = 0
    isolated_entity_count: int = 0
    unsupported_relation_count: int = 0
    generic_relation_count: int = 0
    conflicting_pair_count: int = 0
    changed_relation_count: int = 0
    explicit_break_count: int = 0
    gap_relation_count: int = 0
    dangling_relation_count: int = 0
    message: str = ""


class GraphPayload(BaseModel):
    entities: list[EntityNode]
    relations: list[RelationEdge]
    issues: list[ContinuityIssue]
    changes: list[RelationChange] = []
    range: GraphRange = Field(default_factory=GraphRange)
    health: GraphHealth = Field(default_factory=GraphHealth)
    timeline: list[RelationTimelineEvent] = []


class AnalysisStatus(str, Enum):
    idle = "idle"
    running = "running"
    completed = "completed"
    partial = "partial"
    failed = "failed"
    cancelled = "cancelled"


class AnalysisJob(BaseModel):
    id: int
    project_id: int
    status: AnalysisStatus
    current_step: str = "queued"
    progress: int = 0
    message: str
    created_at: str
    updated_at: str
    window_details: list[dict] = Field(default_factory=list)
    review_context: dict = Field(default_factory=dict)

    @field_validator('window_details', 'review_context', mode='before')
    @classmethod
    def decode_json(cls, value):
        return json.loads(value) if isinstance(value, str) else value


class LocalAiHealth(BaseModel):
    ok: bool
    runtime: str
    message: str
    models: list[str] = []
    model_dir: str = ""


class AppSettings(BaseModel):
    generation_model: str = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
    embedding_model: str = "Qwen3-Embedding-0.6B-Q8_0.gguf"


class EnvironmentStatus(BaseModel):
    platform: str
    runtime_installed: bool
    runtime_running: bool
    model_dir: str
    embedding_model: str
    generation_model: str
    embedding_model_ready: bool
    generation_model_ready: bool
    models: list[str] = []
    ready: bool
    can_auto_install: bool
    install_method: str
    message: str


class EnvironmentSetupRequest(BaseModel):
    install_runtime: bool = False
    prepare_embedding_model: bool = True
    prepare_generation_model: bool = True
    embedding_model: str = "Qwen3-Embedding-0.6B-Q8_0.gguf"
    generation_model: str = "qwen2.5-1.5b-instruct-q4_k_m.gguf"


class EnvironmentSetupProgress(BaseModel):
    running: bool
    stage: str
    message: str
    logs: list[str] = []
    error: str | None = None
