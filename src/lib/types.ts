export type EntityType =
  | "character"
  | "place"
  | "organization"
  | "item"
  | "event"
  | "rule"
  | "foreshadowing";

export type IssueStatus = "open" | "accepted" | "ignored" | "deferred";

export interface Project {
  id: number;
  title: string;
  root_path: string | null;
  created_at: string;
  updated_at: string;
  document_count?: number;
  pending_document_count?: number;
  open_issue_count?: number;
  last_analyzed_at?: string | null;
}

export interface StoryDocument {
  id: number;
  project_id: number;
  path: string;
  title: string;
  format: string;
  chapter_index: number;
  content_hash: string;
  content: string;
  created_at: string;
  analysis_status: "pending" | "analyzed" | "stale";
  analyzed_at: string | null;
  analysis_entity_count: number;
  analysis_relation_count: number;
  analysis_claim_count: number;
}

export interface StorySetting {
  id: number;
  project_id: number;
  title: string;
  content: string;
  certainty: "confirmed" | "draft";
  updated_at: string;
}

export type ForeshadowingStatusValue = "unreviewed" | "in_progress" | "resolved" | "intentional";
export interface ForeshadowingStatus { entity_id: number; project_id: number; status: ForeshadowingStatusValue; updated_at: string; }

export interface DocumentDeleteResult {
  project_id: number;
}

export interface ProjectDeleteResult {
  project_id: number;
}

export interface EntityNode {
  id: number;
  project_id: number;
  type: EntityType;
  name: string;
  aliases: string[];
  summary: string;
  first_seen_document_id: number | null;
  mention_count: number;
  document_ids: number[];
  document_count: number;
  last_seen_document_id: number | null;
  appearance_state: "new" | "active" | "fading" | "dormant";
  visual_weight: number;
}

export interface RelationClaim {
  explanation: string;
  basis: "explicit" | "inferred";
  quotes: {chunk_id: number; quote: string; document_id: number; chapter_index: number}[];
}

export interface RelationEdge {
  claims?: RelationClaim[];
  origin?: "local" | "gpt";
  id: number;
  project_id: number;
  source_entity_id: number;
  target_entity_id: number;
  type: string;
  confidence: number;
  evidence_chunk_ids: number[];
  strength: number;
  is_weak: boolean;
  is_recent: boolean;
  display_label: string;
}

export interface ContinuityIssue {
  id: number;
  project_id: number;
  severity: "low" | "medium" | "high";
  category:
    | "timeline"
    | "character_state"
    | "world_rule"
    | "relationship"
    | "unresolved_foreshadowing"
    | "contradiction";
  title: string;
  description: string;
  evidence_chunk_ids: number[];
  status: IssueStatus;
}

export interface EvidenceChunk {
  id: number;
  document_id: number;
  project_id: number;
  chunk_index: number;
  text: string;
  start_offset: number;
  end_offset: number;
}

export interface RelationChange {
  id: number;
  project_id: number;
  source_entity_id: number;
  target_entity_id: number;
  source_name: string;
  target_name: string;
  previous_type: string;
  current_type: string;
  previous_document_id: number;
  current_document_id: number;
  description: string;
  evidence_chunk_ids: number[];
}

export interface RelationTimelineEvent {
  source_entity_id: number;
  target_entity_id: number;
  source_name: string;
  target_name: string;
  relation_type: string;
  chapter_index: number;
  document_id: number;
  evidence_chunk_ids: number[];
  status: "observed" | "changed" | "gap" | "explicit_break";
  gap_before?: boolean;
}

export interface GraphRange {
  start_chapter: number | null;
  end_chapter: number | null;
  document_ids: number[];
  document_count: number;
  continuity_ready: boolean;
  message: string;
}

export interface GraphHealth {
  connected_entity_count: number;
  component_count: number;
  isolated_entity_count: number;
  unsupported_relation_count: number;
  generic_relation_count: number;
  conflicting_pair_count: number;
  changed_relation_count: number;
  explicit_break_count: number;
  gap_relation_count: number;
  dangling_relation_count: number;
  message: string;
}

export interface GraphPayload {
  entities: EntityNode[];
  relations: RelationEdge[];
  issues: ContinuityIssue[];
  changes: RelationChange[];
  range: GraphRange;
  health?: GraphHealth;
  timeline?: RelationTimelineEvent[];
}

export type AnalysisStatus = "idle" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type AnalysisEstimate = {
  document_count: number;
  manuscript_chars: number;
  chunk_count: number;
  review_window_count: number;
  start_chapter?: number | null;
  end_chapter?: number | null;
};
export type AnalysisPlan = AnalysisEstimate & {
  mode: "full" | "segmented" | "staged";
  recommended_batch_size: number;
  batch_count: number;
  embedding_model?: string;
  embedding_estimate_seconds?: number;
  embedding_memory_estimate_mb?: number;
  gpt_estimate_seconds?: number;
  gpt_estimate_min_seconds?: number;
  gpt_estimate_max_seconds?: number;
  message: string;
};

export interface AnalysisJob {
  id: number;
  project_id: number;
  status: AnalysisStatus;
  current_step: string;
  progress: number;
  message: string;
  created_at: string;
  updated_at: string;
  review_context?: { model?: string; effort?: string | null; start_chapter?: number | null; end_chapter?: number | null };
  window_details?: Array<{
    index: number; chunk_id: number; document: string; status: string; stage: string;
    attempts: number; elapsed_seconds: number; error: string; reused?: boolean; error_code?: string;
    parts?: Array<{ path: string; chunk_ids: number[]; status: string; error: string;
      error_code?: string | null; stage?: string; attempts?: number; elapsed_seconds?: number; reused?: boolean }>;
  }>;
}

export interface EntityRelationshipDetail {
  relation: RelationEdge;
  other: EntityNode;
  direction: "outgoing" | "incoming";
  explanation: string;
}

export interface LocalAiHealth {
  ok: boolean;
  runtime: string;
  message: string;
  models: string[];
  model_dir: string;
}

export interface AppSettings {
  generation_model: string;
  embedding_model: string;
}

export interface EnvironmentStatus {
  platform: string;
  runtime_installed: boolean;
  runtime_running: boolean;
  model_dir: string;
  embedding_model: string;
  generation_model: string;
  embedding_model_ready: boolean;
  generation_model_ready: boolean;
  models: string[];
  ready: boolean;
  can_auto_install: boolean;
  install_method: string;
  message: string;
}

export interface EnvironmentSetupRequest {
  install_runtime: boolean;
  prepare_embedding_model: boolean;
  prepare_generation_model: boolean;
  embedding_model: string;
  generation_model: string;
}

export interface EnvironmentSetupProgress {
  running: boolean;
  stage: string;
  message: string;
  logs: string[];
  error: string | null;
}

export interface ChatGptStatus {
  phase: "disconnected" | "pending" | "connected" | "expired" | "failed" | "unavailable";
  user_code: string | null;
  verification_url: string | null;
  plan: string | null;
  error: string | null;
  /** "api_key" when the server connects with its own OpenAI key; absent or "chatgpt" for the desktop device login. */
  method?: "chatgpt" | "api_key";
}
export interface ChatGptModel {
  id: string;
  name: string;
  default_effort: string | null;
  efforts: { value: string; description: string }[];
}

export interface WebDemoQuota {
  enabled: boolean;
  limit: number;
  used: number;
  remaining: number;
  ip_limit: number;
  ip_remaining: number;
  total_limit: number;
  total_remaining: number;
  resets_at: string;
  max_chapters: number;
  max_review_windows: number;
}

export interface ReviewHistory {
 id: number; title: string; description: string; status: IssueStatus;
 outcome: 'pending' | 'redetected' | 'not_redetected'; created_at: string;
 evidence: (EvidenceChunk & {title: string; chapter_index: number})[];
}
