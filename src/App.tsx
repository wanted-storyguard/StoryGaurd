import { ProjectMutationScope } from "./lib/projectMutationScope";
import { DocumentPicker } from "./components/DocumentPicker";
import { ThemePicker } from "./components/ThemePicker";
import { WorkbenchNav, ProjectsPage, ManuscriptsPage, ReviewPage, GraphDetails, PAGES, type Page } from "./components/Workbench";
import { lazy, Suspense, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { api } from "./lib/api";
import { analysisJobAfterError, analysisRetryRequest, belongsToNewAnalysis } from "./lib/analysisProgress";
import { ensureDesktopBackend, isTauriRuntime } from "./lib/desktopBackend";
import { clearGraphPositions } from "./lib/graphLayoutStorage";
import { isMembershipRelation } from "./lib/graphMembership";
import { isDanglingRelation, isRelationshipHealthIssue, temporalIssuePairs } from "./lib/relationshipHealth";
import { ENTITY_TYPE_LABELS } from "./lib/labels";
import type {
  EntityNode,
  EntityRelationshipDetail,
  EntityType,
  EnvironmentSetupProgress,
  EnvironmentStatus,
  EvidenceChunk,
  GraphPayload,
  IssueStatus,
  AnalysisJob,
  AppSettings,
  LocalAiHealth,
  Project,
  RelationEdge,
  StoryDocument,
  StorySetting,
  ForeshadowingStatus,
} from "./lib/types";
const GraphView = lazy(() => import("./components/GraphView").then(({ GraphView: view }) => ({ default: view })));
import { Inspector } from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import { ChatGptPanel } from "./components/ChatGptPanel";
import { SetupPanel } from "./components/SetupPanel";
import { StartupLoader, type StartupStatus } from "./components/StartupLoader";
import { friendlyStartupError } from "./lib/startupError";
import { AnalysisProgressPanel } from "./components/AnalysisProgressPanel";
import { sortImportPaths } from "./lib/importPaths";
import { startupRoute } from "./lib/startupRoute";

const EMPTY_GRAPH: GraphPayload = {
  entities: [],
  relations: [],
  issues: [],
  changes: [],
  range: {
    start_chapter: null,
    end_chapter: null,
    document_ids: [],
    document_count: 0,
    continuity_ready: true,
    message: "분석된 원고가 없습니다.",
  },
  health: {
    connected_entity_count: 0,
    component_count: 0,
    isolated_entity_count: 0,
    unsupported_relation_count: 0,
    generic_relation_count: 0,
    conflicting_pair_count: 0,
    changed_relation_count: 0,
    explicit_break_count: 0,
    gap_relation_count: 0,
    dangling_relation_count: 0,
    message: "분석된 원고가 없습니다.",
  },
  timeline: [],
};

const DEFAULT_SETTINGS: AppSettings = {
  generation_model: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  embedding_model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
};

const ENTITY_TYPES: EntityType[] = [
  "character",
  "place",
  "organization",
  "item",
  "event",
  "rule",
  "foreshadowing",
];

function formatManuscriptChars(documents: StoryDocument[]) {
  const chars = documents.reduce((total, document) => total + document.content.length, 0);
  if (chars >= 10000) return `${(chars / 10000).toFixed(1)}만 자`;
  return `${chars.toLocaleString('ko-KR')}자`;
}

type RelationScope = "core" | "all";
type ChapterRange = { startChapter: number | null; endChapter: number | null };
const SELECTED_PROJECT_STORAGE_KEY = "storyGuard.selectedProjectId";
const INITIAL_STARTUP_STATUS: StartupStatus = {
  visible: true,
  mode: "loading",
  message: "백엔드 시작 중",
  detail: "로컬 API와 앱 데이터 폴더를 확인하고 있습니다.",
  progress: 12,
};

function makePendingAnalysisJob(projectId: number): AnalysisJob {
  const timestamp = new Date().toISOString();
  return {
    id: 0,
    project_id: projectId,
    status: "running",
    current_step: "prepare",
    progress: 5,
    message: "분석 요청을 보냈습니다.",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function makeFailedAnalysisJob(projectId: number, message: string): AnalysisJob {
  const timestamp = new Date().toISOString();
  return {
    id: 0,
    project_id: projectId,
    status: "failed",
    current_step: "failed",
    progress: 100,
    message,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function isAnalysisRunning(job: AnalysisJob | null) {
  return job?.status === "running";
}

function strongestRelationPerPair(relations: GraphPayload["relations"]) {
  const bestByPair = new Map<string, GraphPayload["relations"][number]>();
  for (const relation of [...relations].sort(
    (left, right) =>
      (right.strength ?? right.confidence ?? 0) - (left.strength ?? left.confidence ?? 0),
  )) {
    const pairKey = [relation.source_entity_id, relation.target_entity_id].sort((a, b) => a - b).join("-");
    if (!bestByPair.has(pairKey)) {
      bestByPair.set(pairKey, relation);
    }
  }
  return [...bestByPair.values()].sort(
    (left, right) =>
      (right.strength ?? right.confidence ?? 0) - (left.strength ?? left.confidence ?? 0),
  );
}

function relationScore(relation: RelationEdge) {
  return relation.strength ?? relation.confidence ?? 0;
}

function isCoreRelation(relation: RelationEdge) {
  return !relation.is_weak && relation.type !== "co_occurs" && relation.confidence >= 0.68;
}

function relationName(relation: RelationEdge) {
  return relation.display_label || (relation.type === "co_occurs" ? "동시 등장" : relation.type);
}

function aggregateOrganizationRelations(graph: GraphPayload, scope: RelationScope): RelationEdge[] {
  const entitiesById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const organizationIds = new Set(
    graph.entities.filter((entity) => entity.type === "organization").map((entity) => entity.id),
  );
  if (organizationIds.size < 2) {
    return [];
  }

  const ownerOrganizationByEntityId = new Map<number, number>();
  for (const organizationId of organizationIds) {
    ownerOrganizationByEntityId.set(organizationId, organizationId);
  }

  for (const relation of graph.relations) {
    if (!isMembershipRelation(relation)) {
      continue;
    }
    const source = entitiesById.get(relation.source_entity_id);
    const target = entitiesById.get(relation.target_entity_id);
    if (!source || !target) {
      continue;
    }
    if (source.type === "organization" && target.type !== "organization") {
      ownerOrganizationByEntityId.set(target.id, source.id);
    }
    if (target.type === "organization" && source.type !== "organization") {
      ownerOrganizationByEntityId.set(source.id, target.id);
    }
  }

  const aggregateByPair = new Map<
    string,
    {
      sourceId: number;
      targetId: number;
      count: number;
      confidence: number;
      strength: number;
      isRecent: boolean;
      evidenceChunkIds: Set<number>;
    }
  >();

  for (const relation of graph.relations) {
    if (scope === "core" && !isCoreRelation(relation) && !isMembershipRelation(relation)) {
      continue;
    }
    const sourceOrganizationId = ownerOrganizationByEntityId.get(relation.source_entity_id);
    const targetOrganizationId = ownerOrganizationByEntityId.get(relation.target_entity_id);
    if (
      !sourceOrganizationId ||
      !targetOrganizationId ||
      sourceOrganizationId === targetOrganizationId
    ) {
      continue;
    }
    const [leftId, rightId] = [sourceOrganizationId, targetOrganizationId].sort((left, right) => left - right);
    const key = `${leftId}-${rightId}`;
    const current =
      aggregateByPair.get(key) ??
      {
        sourceId: leftId,
        targetId: rightId,
        count: 0,
        confidence: 0,
        strength: 0,
        isRecent: false,
        evidenceChunkIds: new Set<number>(),
      };
    current.count += 1;
    current.confidence = Math.max(current.confidence, relation.confidence ?? 0.55);
    current.strength = Math.max(current.strength, relationScore(relation));
    current.isRecent ||= relation.is_recent;
    for (const chunkId of relation.evidence_chunk_ids) {
      current.evidenceChunkIds.add(chunkId);
    }
    aggregateByPair.set(key, current);
  }

  let virtualId = -1;
  return [...aggregateByPair.values()].map((aggregate) => ({
    id: virtualId--,
    project_id: graph.entities[0]?.project_id ?? 0,
    source_entity_id: aggregate.sourceId,
    target_entity_id: aggregate.targetId,
    type: "조직 간접 관계",
    confidence: Math.min(0.95, Math.max(0.7, aggregate.confidence)),
    evidence_chunk_ids: [...aggregate.evidenceChunkIds].slice(0, 8),
    strength: Math.min(0.96, 0.48 + Math.log2(aggregate.count + 1) * 0.14 + aggregate.strength * 0.22),
    is_weak: false,
    is_recent: aggregate.isRecent,
    display_label: `하위 관계 ${aggregate.count}개`,
  }));
}

function buildRelationshipExplanation(
  entity: EntityNode,
  other: EntityNode,
  relation: RelationEdge,
  direction: EntityRelationshipDetail["direction"],
) {
  const sourceName = direction === "outgoing" ? entity.name : other.name;
  const targetName = direction === "outgoing" ? other.name : entity.name;
  if (relation.origin === "gpt") {
    return `${sourceName} → ${targetName}: ${relationName(relation)}. AI 추출 후보 · 원문 근거 ${relation.evidence_chunk_ids.length}개. 현재 상태인지는 원문 시점을 확인해 주세요.`;
  }
  const confidence = Math.round((relation.confidence ?? 0) * 100);
  const strength = Math.round(relationScore(relation) * 100);
  const recency = relation.is_recent ? "최근 원고에서도 유지" : "이전 원고 근거 중심";
  const evidenceCount = relation.evidence_chunk_ids.length;
  const evidence = evidenceCount > 0 ? `, 근거 chunk ${evidenceCount}개` : "";
  return `${sourceName} -> ${targetName}: ${relationName(relation)}. 신뢰도 ${confidence}%, 관계 강도 ${strength}%. ${recency}${evidence}.`;
}

export default function App() {
  // First launches get the guided introduction. Returning writers go straight
  // to their shelf while the sidecar warms up, so the startup overlay never
  // briefly shows a misleading "시작하기" screen over existing work.
  const [page, setPage] = useState<Page>(() =>
    startupRoute(Boolean(window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY))),
  );
  const [selectedRelationId, setSelectedRelationId] = useState<number | null>(null);
  const [graphSearch, setGraphSearch] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectTitleDraft, setProjectTitleDraft] = useState("");
  const [editingProjectTitle, setEditingProjectTitle] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [documentPathModalOpen, setDocumentPathModalOpen] = useState(false);
  const [sourceRequest, setSourceRequest] = useState<{documentId:number;quote?:string}>();
  const [replacementDocument, setReplacementDocument] = useState<StoryDocument | null>(null);
  const [reviewHistory, setReviewHistory] = useState<import("./lib/types").ReviewHistory[]>([]);
  const [documentPathDraft, setDocumentPathDraft] = useState("");
  const [documentPathError, setDocumentPathError] = useState("");
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [storySettings, setStorySettings] = useState<StorySetting[]>([]);
  const [foreshadowingStatuses, setForeshadowingStatuses] = useState<ForeshadowingStatus[]>([]);
  const [projectDataError, setProjectDataError] = useState(false);
  const [projectDataLoading, setProjectDataLoading] = useState(false);
  const [snapshotProjectId, setSnapshotProjectId] = useState<number | null>(null);
  const dataOwnerRef = useRef<number | null>(null);
  const mutationScope = useRef(new ProjectMutationScope());
  const projectDataErrorRef = useRef(false);
  const [chapterRange, setChapterRange] = useState<ChapterRange>({
    startChapter: null,
    endChapter: null,
  });
  const [analysisRange, setAnalysisRange] = useState<ChapterRange>({
    startChapter: null,
    endChapter: null,
  });
  const [loadedChapterRange, setLoadedChapterRange] = useState<ChapterRange>({ startChapter: null, endChapter: null });
  const [graph, setGraph] = useState<GraphPayload>(EMPTY_GRAPH);
  const [selectedEntity, setSelectedEntity] = useState<EntityNode | null>(null);
  const [relationScope, setRelationScope] = useState<RelationScope>("core");
  const [healthOnly, setHealthOnly] = useState(false);
  const [visibleTypes, setVisibleTypes] = useState<Set<EntityType>>(
    () => new Set(ENTITY_TYPES),
  );
  const [evidenceByIssueId, setEvidenceByIssueId] = useState<Record<number, EvidenceChunk[]>>({});
  const [localAi, setLocalAi] = useState<LocalAiHealth | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [setupStatus, setSetupStatus] = useState<EnvironmentStatus | null>(null);
  const [setupProgress, setSetupProgress] = useState<EnvironmentSetupProgress | null>(null);
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob | null>(null);
  const [lastAnalysisRequest, setLastAnalysisRequest] = useState<{ model?: string; effort?: string; force?: boolean; range?: ChapterRange } | null>(null);
  const retryRequest = analysisJob ? analysisRetryRequest(analysisJob, lastAnalysisRequest) : null;
  const [loading, setLoading] = useState(false);
  const [activeAnalysisProject, setActiveAnalysisProject] = useState<Project | null>(null);
  const activeAnalysisRef = useRef<{project: Project; jobId: number; awaitingResponse: boolean} | null>(null);
  const chapterRangeRef = useRef(chapterRange);
  chapterRangeRef.current = chapterRange;
  const analysisRangeRef = useRef(analysisRange);
  analysisRangeRef.current = analysisRange;
  const analysisBusy = activeAnalysisProject !== null || analysisJob?.status === 'running';
  const workspaceBusy = loading || analysisBusy;
  const [notice, setNotice] = useState("백엔드 연결을 확인하는 중입니다.");
  const [startupStatus, setStartupStatus] = useState<StartupStatus>(INITIAL_STARTUP_STATUS);
  const dataRequestIdRef = useRef(0);
  const analysisRequestBaselineRef = useRef<{ projectId: number; jobId: number } | null>(null);
  const startupActiveRef = useRef(true);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const modalWasOpenRef = useRef(false);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const initialRefreshCompletedRef = useRef(false);
  const userNavigationRef = useRef(false);

  // Each section owns its own scrolling. Reset the outer workspace when the
  // writer navigates so a review page cannot reopen halfway down a previous
  // long manuscript or leave its header clipped at the top edge.
  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [page]);

  useEffect(() => {
    const modalOpen = projectModalOpen || documentPathModalOpen;
    if (!modalOpen) {
      if (modalWasOpenRef.current) {
        modalWasOpenRef.current = false;
        modalTriggerRef.current?.focus();
        modalTriggerRef.current = null;
      }
      return;
    }
    modalWasOpenRef.current = true;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProjectModalOpen(false);
        setDocumentPathModalOpen(false);
        setReplacementDocument(null);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [projectModalOpen, documentPathModalOpen]);

  const openIssues = useMemo(
    () => graph.issues.filter((issue) => issue.status !== "ignored"),
    [graph.issues],
  );

  const chapterOptions = useMemo(
    () =>
      documents.map((document) => ({
        value: document.chapter_index,
        label: `${document.chapter_index + 1}화 · ${document.title}`,
      })),
    [documents],
  );

  const graphRangeLabel = useMemo(() => {
    if (documents.length === 0) {
      return "원고 없음";
    }
    if (loadedChapterRange.startChapter === null && loadedChapterRange.endChapter === null) {
      return `전체 누적 · ${documents.length}편`;
    }
    const startLabel = loadedChapterRange.startChapter === null ? 1 : loadedChapterRange.startChapter + 1;
    const endLabel = loadedChapterRange.endChapter === null ? documents.length : loadedChapterRange.endChapter + 1;
    return `${startLabel}화-${endLabel}화`;
  }, [loadedChapterRange.endChapter, loadedChapterRange.startChapter, documents.length]);

  const filteredGraph = useMemo(() => {
    const entities = graph.entities.filter((entity) => visibleTypes.has(entity.type));
    const visibleIds = new Set(entities.map((entity) => entity.id));
    const directRelations = graph.relations
      .filter(
        (relation) =>
          visibleIds.has(relation.source_entity_id) && visibleIds.has(relation.target_entity_id),
      )
      .filter(
        (relation) =>
          relationScope === "all" || isCoreRelation(relation) || isMembershipRelation(relation),
      );
    const organizationOnly =
      entities.length > 0 && [...visibleTypes].every((type) => type === "organization");
    const organizationRelations = organizationOnly ? aggregateOrganizationRelations(graph, relationScope) : [];
    // Preserve relations whose endpoint was not extracted. They cannot be
    // drawn safely, but diagnostic modes must expose them in the broken-link
    // list instead of silently deleting the evidence.
    const danglingRelations = graph.relations.filter((relation) => isDanglingRelation(relation, visibleIds));
    const relations = [...directRelations, ...organizationRelations, ...(relationScope === "all" || healthOnly ? danglingRelations : [])].filter(
      (relation) =>
        !isDanglingRelation(relation, visibleIds) || (relationScope === "all" || healthOnly),
    );
    // Keep time-dependent claims between the same entities. Collapsing a pair
    // hides the very contradiction a writer is trying to inspect.
    const scopedRelations =
      relationScope === "core"
        ? relations
            .filter((relation) => isCoreRelation(relation) || isMembershipRelation(relation) || relation.is_recent)
            .sort((left, right) => relationScore(right) - relationScore(left))
            .slice(0, 64)
        : relations;
    // Diagnostic mode must inspect the complete extraction result. Applying
    // the core-confidence slice first could hide precisely the weak or
    // changed relation the writer needs to review.
    const healthCandidates = healthOnly ? relations : scopedRelations;
    const temporalPairs = temporalIssuePairs(graph);
    const healthRelations = healthOnly
      ? healthCandidates.filter((relation) =>
          isDanglingRelation(relation, visibleIds) ||
          isRelationshipHealthIssue(relation, temporalPairs),
        )
      : scopedRelations;
    let scopedEntities = entities;
    if (healthOnly) {
      const connectedIds = new Set<number>();
      for (const relation of healthRelations) {
        connectedIds.add(relation.source_entity_id);
        connectedIds.add(relation.target_entity_id);
      }
      // Keep entities that are genuinely isolated in the diagnostic view. A
      // missing edge is itself a useful signal, and hiding the node would
      // make the health counter appear falsely clean.
      const relationEndpoints = new Set<number>(scopedRelations.flatMap((relation) => [relation.source_entity_id, relation.target_entity_id]));
      scopedEntities = entities.filter((entity) => connectedIds.has(entity.id) || !relationEndpoints.has(entity.id));
    } else if (relationScope === "core" && scopedRelations.length > 0) {
      const connectedIds = new Set<number>();
      for (const relation of scopedRelations) {
        connectedIds.add(relation.source_entity_id);
        connectedIds.add(relation.target_entity_id);
      }
      scopedEntities = entities.filter((entity) => connectedIds.has(entity.id));
    }
    return {
      ...graph,
      entities: scopedEntities,
      relations: healthRelations,
    };
  }, [graph, healthOnly, relationScope, visibleTypes]);

  const searchedGraph = useMemo(() => {
    const query = graphSearch.trim().toLocaleLowerCase();
    if (!query) return filteredGraph;
    const matches = new Set(filteredGraph.entities.filter(e => [e.name, ...e.aliases].some(name => name.toLocaleLowerCase().includes(query))).map(e => e.id));
    const relations = filteredGraph.relations.filter(r => matches.has(r.source_entity_id) || matches.has(r.target_entity_id));
    const ids = new Set([...matches, ...relations.flatMap(r => [r.source_entity_id, r.target_entity_id])]);
    return {...filteredGraph, entities: filteredGraph.entities.filter(e => ids.has(e.id)), relations};
  }, [filteredGraph, graphSearch]);

  const selectedRelationshipDetails = useMemo<EntityRelationshipDetail[]>(() => {
    if (!selectedEntity) {
      return [];
    }
    const entitiesById = new Map(filteredGraph.entities.map((entity) => [entity.id, entity]));
    return filteredGraph.relations
      .filter(
        (relation) =>
          relation.source_entity_id === selectedEntity.id ||
          relation.target_entity_id === selectedEntity.id,
      )
      .map((relation) => {
        const direction = relation.source_entity_id === selectedEntity.id ? "outgoing" : "incoming";
        const otherEntityId =
          direction === "outgoing" ? relation.target_entity_id : relation.source_entity_id;
        const other = entitiesById.get(otherEntityId);
        if (!other) {
          return null;
        }
        return {
          relation,
          other,
          direction,
          explanation: buildRelationshipExplanation(selectedEntity, other, relation, direction),
        };
      })
      .filter((detail): detail is EntityRelationshipDetail => detail !== null)
      .sort((left, right) => relationScore(right.relation) - relationScore(left.relation))
      .slice(0, 12);
  }, [filteredGraph, selectedEntity]);

  const refreshLocalAi = useCallback(async () => {
    try {
      setLocalAi(await api.localAiHealth());
    } catch (error) {
      setLocalAi({
        ok: false,
        runtime: "story-guard-local",
        message: error instanceof Error ? error.message : "Local AI 상태 확인 실패",
        models: [],
        model_dir: "",
      });
    }
  }, []);

  const prepareProjectData = useCallback((projectId: number | null) => {
    if (dataOwnerRef.current === projectId) return;
    dataOwnerRef.current = projectId;
    mutationScope.current.activate(projectId);
    // Invalidate late responses before switching the visible project.
    dataRequestIdRef.current += 1;
    setSnapshotProjectId(null);
    setLoadedChapterRange({ startChapter: null, endChapter: null });
    setDocuments([]);
    setStorySettings([]);
    setForeshadowingStatuses([]);
    setReviewHistory([]);
    setEvidenceByIssueId({});
    setGraph(EMPTY_GRAPH);
    setSourceRequest(undefined);
    setSelectedEntity(null);
    setSelectedRelationId(null);
    setGraphSearch("");
    setHealthOnly(false);
    setAnalysisJob(null);
    setLastAnalysisRequest(null);
    setDocumentPathModalOpen(false);
    setReplacementDocument(null);
    setDocumentPathError("");
    setNotice("");
    projectDataErrorRef.current = false;
    setProjectDataError(false);
    setProjectDataLoading(projectId !== null);
  }, []);

  const refreshProjectData = useCallback(async (project: Project | null, range = chapterRange) => {
    prepareProjectData(project?.id ?? null);
    const requestId = dataRequestIdRef.current + 1;
    dataRequestIdRef.current = requestId;
    if (!project) {
      setDocuments([]);
      setStorySettings([]);
      setForeshadowingStatuses([]);
      setGraph(EMPTY_GRAPH);
      setProjectDataError(false);
      setProjectDataLoading(false);
      return;
    }
    setProjectDataLoading(true);
    try {
      const [nextDocuments, nextSettings, nextForeshadowingStatuses, nextGraph, history] = await Promise.all([
        api.listDocuments(project.id), api.listStorySettings(project.id),
        api.listForeshadowingStatuses(project.id), api.graph(project.id, range), api.reviewHistory(project.id),
      ]);
      if (dataRequestIdRef.current !== requestId) return;
      // Publish one consistent snapshot only after all reads have succeeded.
      setDocuments(nextDocuments);
      setStorySettings(nextSettings);
      setForeshadowingStatuses(nextForeshadowingStatuses);
      setGraph(nextGraph);
      setReviewHistory(history);
      setSnapshotProjectId(project.id);
      setLoadedChapterRange(range);
      if (projectDataErrorRef.current) setNotice("작품 데이터를 다시 불러왔습니다.");
      projectDataErrorRef.current = false;
      setProjectDataError(false);
      return true;
    } catch (error) {
      if (dataRequestIdRef.current === requestId) {
        projectDataErrorRef.current = true;
        setProjectDataError(true);
        setNotice(`작품 데이터를 불러오지 못했습니다. 저장된 원고와 분석 결과는 변경되지 않았습니다. ${friendlyStartupError(error)}`);
      }
      return false;
    } finally {
      if (dataRequestIdRef.current === requestId) setProjectDataLoading(false);
    }
  }, [chapterRange, prepareProjectData]);

  async function createStorySetting(title: string, content: string, certainty: StorySetting["certainty"]): Promise<boolean> {
    if (!selectedProject) return false;
    const write = mutationScope.current.begin(selectedProject.id, 'setting:new');
    if (!write) return false;
    try {
      const created = await api.createStorySetting(selectedProject.id, {title, content, certainty});
      if (write.isCurrent()) {
        setStorySettings(items => [...items.filter(item => item.id !== created.id), created]);
        setNotice("설정 메모를 저장했습니다.");
      }
      return true;
    } catch (error) {
      if (write.isCurrent()) setNotice(error instanceof Error ? error.message : "설정 메모 저장 실패");
      return false;
    } finally { write.finish(); }
  }
  async function updateStorySetting(setting: StorySetting): Promise<boolean> {
    if (!selectedProject) return false;
    const write = mutationScope.current.begin(selectedProject.id, `setting:${setting.id}`);
    if (!write) return false;
    try {
      const updated = await api.updateStorySetting(setting.id, {title: setting.title, content: setting.content, certainty: setting.certainty});
      if (write.isCurrent()) {
        setStorySettings(items => items.map(item => item.id === updated.id ? updated : item));
        setNotice("설정 메모를 갱신했습니다.");
      }
      return true;
    } catch (error) {
      if (write.isCurrent()) setNotice(error instanceof Error ? error.message : "설정 메모 갱신 실패");
      return false;
    } finally { write.finish(); }
  }
  async function deleteStorySetting(setting: StorySetting) {
    if (!selectedProject || !window.confirm(`'${setting.title}' 설정 메모를 삭제할까요?`)) return;
    const write = mutationScope.current.begin(selectedProject.id, `setting:${setting.id}`);
    if (!write) return;
    try {
      await api.deleteStorySetting(setting.id);
      if (write.isCurrent()) {
        setStorySettings(items => items.filter(item => item.id !== setting.id));
        setNotice("설정 메모를 삭제했습니다.");
      }
    } catch (error) {
      if (write.isCurrent()) setNotice(error instanceof Error ? error.message : "설정 메모 삭제 실패");
    } finally { write.finish(); }
  }

  async function updateForeshadowingStatus(entityId: number, status: ForeshadowingStatus["status"]) {
    if (!selectedProject) return;
    const write = mutationScope.current.begin(selectedProject.id, `foreshadowing:${entityId}`);
    if (!write) return;
    try {
      const updated = await api.updateForeshadowingStatus(selectedProject.id, entityId, status);
      if (write.isCurrent()) {
        setForeshadowingStatuses(items => [...items.filter(item => item.entity_id !== entityId), updated]);
        setNotice("떡밥 상태를 저장했습니다.");
      }
    } catch (error) {
      if (write.isCurrent()) setNotice(error instanceof Error ? error.message : "떡밥 상태 저장 실패");
    } finally { write.finish(); }
  }

  const refreshProjects = useCallback(async (preferredProjectId?: number | null) => {
    const nextProjects = await api.listProjects();
    const storedProjectId = Number(window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) ?? 0);
    const targetProjectId =
      preferredProjectId === undefined ? selectedProject?.id ?? storedProjectId : preferredProjectId;
    const nextSelected =
      nextProjects.find((project) => project.id === targetProjectId) ?? nextProjects[0] ?? null;
    setProjects(nextProjects);
    setSelectedProject(nextSelected);
    if (nextSelected) {
      window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, String(nextSelected.id));
    } else {
      window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
    }
    return nextSelected;
  }, [selectedProject?.id]);

  const refreshSettings = useCallback(async () => {
    setSettings(await api.settings());
  }, []);

  const refreshSetup = useCallback(async () => {
    const [status, progress] = await Promise.all([api.setupStatus(), api.setupProgress()]);
    setSetupStatus(status);
    setSetupProgress(progress);
    return status;
  }, []);

  const updateStartup = useCallback((message: string, detail: string, progress: number) => {
    if (!startupActiveRef.current) {
      return;
    }
    setStartupStatus({
      visible: true,
      mode: "loading",
      message,
      detail,
      progress,
    });
  }, []);

  const completeStartup = useCallback(() => {
    if (!startupActiveRef.current) {
      return;
    }
    startupActiveRef.current = false;
    setStartupStatus((status) => ({
      ...status,
      visible: false,
      progress: 100,
      message: "준비 완료",
      detail: "작업실을 열었습니다.",
    }));
  }, []);

  const failStartup = useCallback((message: string) => {
    if (!startupActiveRef.current) {
      return;
    }
    setStartupStatus({
      visible: true,
      mode: "error",
      message: "초기 로딩 실패",
      detail: message,
      progress: 100,
    });
  }, []);

  const refreshAll = useCallback(async () => {
    const showStartup = startupActiveRef.current;
    try {
      if (showStartup) {
        updateStartup("백엔드 시작 중", "로컬 API와 앱 데이터 폴더를 확인하고 있습니다.", 18);
      }
      const backendMessage = await ensureDesktopBackend();
      setNotice(backendMessage);
      if (showStartup) {
        updateStartup("Local AI 확인 중", "로컬 LLM 런타임과 모델 파일을 확인하고 있습니다.", 52);
      }
      // Project data is required to open the workspace, but Local AI/setup
      // checks are advisory. A slow or unavailable model runtime must not
      // hold the entire app on the startup screen or hide existing projects.
      // Attach rejection handlers immediately so every request settles.
      const [projectsResult, localAiResult, settingsResult, setupResult] = await Promise.allSettled([
        refreshProjects(), refreshLocalAi(), refreshSettings(), refreshSetup(),
      ]);
      if (projectsResult.status === "rejected") {
        throw projectsResult.reason;
      }
      const nextSelectedProject = projectsResult.value;
      const optionalFailures = [localAiResult, settingsResult, setupResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (optionalFailures.length) {
        setNotice("작품은 열었지만 일부 준비 상태를 확인하지 못했습니다. 앱 설정에서 다시 확인할 수 있습니다.");
      }
      if (showStartup) {
        updateStartup("작품 데이터 불러오는 중", "최근 작품, 원고, 그래프 데이터를 준비하고 있습니다.", 74);
      }
      const projectLoaded = await refreshProjectData(nextSelectedProject);
      // Returning writers should land on their work shelf, while a first
      // launch with no project keeps the guided welcome screen.
      // Do not overwrite a page the writer opened while startup data was
      // still loading. This is especially important when opening a project
      // card immediately after launch.
      if (!userNavigationRef.current) {
        setPage(nextSelectedProject ? "projects" : "welcome");
      }
      if (projectLoaded !== false) setNotice("준비 완료");
      if (showStartup) {
        completeStartup();
      }
    } catch (error) {
      const message = friendlyStartupError(error);
      setNotice(message);
      if (showStartup) {
        failStartup(message);
      }
    }
  }, [
    completeStartup,
    failStartup,
    refreshLocalAi,
    refreshProjectData,
    refreshProjects,
    refreshSettings,
    refreshSetup,
    updateStartup,
  ]);

  useEffect(() => {
    if (initialRefreshCompletedRef.current) {
      return;
    }
    initialRefreshCompletedRef.current = true;
    void refreshAll();
  }, [refreshAll]);

  // Finder에서 원고를 작업 영역으로 직접 끌어다 놓으면 여러 파일을
  // 순서대로 가져옵니다. 분석 중이거나 작품이 없을 때는 무시합니다.
  useEffect(() => {
    if (!isTauriRuntime() || !selectedProject) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow().onDragDropEvent(async (event) => {
      if (disposed || event.payload.type !== "drop" || workspaceBusy) return;
      const paths = sortImportPaths(event.payload.paths.filter((path) => /\.(txt|md|docx)$/i.test(path)));
      if (!paths.length) return;
      let imported = 0;
      let failed = 0;
      const failedNames: string[] = [];
      for (const path of paths) {
        if (disposed || workspaceBusy) break;
        if (await importDocumentPath(path, null)) imported += 1;
        else { failed += 1; failedNames.push(path.split(/[\\/]/).pop() || path); }
      }
      if (!disposed && imported) {
        setNotice(failed
          ? `원고 ${imported}편을 가져왔고 ${failed}편은 실패했습니다 (${failedNames.slice(0, 3).join(', ')}${failed > 3 ? ' 외' : ''}). 실패한 파일을 확인한 뒤 다시 시도해 주세요.`
          : `원고 ${imported}편을 가져왔습니다. 분석 화면에서 전체 회차를 확인하세요.`);
      } else if (!disposed && failed) {
        setNotice(`원고 ${failed}편을 가져오지 못했습니다 (${failedNames.slice(0, 3).join(', ')}${failed > 3 ? ' 외' : ''}). 파일 형식과 경로를 확인한 뒤 다시 시도해 주세요.`);
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => { disposed = true; unlisten?.(); };
  }, [selectedProject?.id, workspaceBusy]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    void refreshProjectData(selectedProject, chapterRange);
  }, [chapterRange, refreshProjectData, selectedProject]);

  useEffect(() => {
    setProjectTitleDraft(selectedProject?.title ?? "");
    setEditingProjectTitle(false);
  }, [selectedProject?.id, selectedProject?.title]);

  useEffect(() => {
    if (
      selectedEntity &&
      !filteredGraph.entities.some((entity) => entity.id === selectedEntity.id)
    ) {
      setSelectedEntity(null);
    }
  }, [filteredGraph.entities, selectedEntity]);

  useEffect(() => {
    if (!setupProgress?.running) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void api.setupProgress().then(async (progress) => {
        setSetupProgress(progress);
        if (!progress.running) {
          await Promise.all([refreshSetup(), refreshLocalAi(), refreshSettings()]);
        }
      });
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [refreshLocalAi, refreshSettings, refreshSetup, setupProgress?.running]);

  useEffect(() => {
    if (!selectedProject && !activeAnalysisProject) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastLoadedJob = '';
    const selectedId = selectedProject?.id;
    const targets = [...new Set([selectedId, activeAnalysisProject?.id].filter((id): id is number => id !== undefined))];
    const poll = async () => {
      let keepPolling = false;
      for (const projectId of targets) {
        if (cancelled) return;
        try {
          const nextJob = await api.analysisStatus(projectId);
          if (cancelled) return;
          if (nextJob.project_id !== projectId || !belongsToNewAnalysis(nextJob, analysisRequestBaselineRef.current)) {
            keepPolling ||= activeAnalysisRef.current?.project.id === projectId;
            continue;
          }
          keepPolling ||= nextJob.status === 'running';
          if (projectId === selectedId && dataOwnerRef.current === projectId) {
            setAnalysisJob(nextJob);
            const completedKey = `${projectId}:${nextJob.id}:${nextJob.status}`;
            if (['completed', 'partial'].includes(nextJob.status) && lastLoadedJob !== completedKey && selectedProject) {
              lastLoadedJob = completedKey;
              await refreshProjectData(selectedProject, chapterRangeRef.current);
              if (cancelled) return;
            }
          }
          const active = activeAnalysisRef.current;
          if (active?.project.id === projectId && !active.awaitingResponse && nextJob.status !== 'running') {
            if (selectedId === projectId && dataOwnerRef.current === projectId && !projectDataErrorRef.current) setNotice(nextJob.message);
            activeAnalysisRef.current = null;
            analysisRequestBaselineRef.current = null;
            setActiveAnalysisProject(null);
          }
        } catch {
          // Continue serial checks without interpreting a missed read as job failure.
          keepPolling = true;
        }
      }
      if (!cancelled && (keepPolling || activeAnalysisRef.current)) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedProject?.id, activeAnalysisProject?.id, refreshProjectData]);

  useEffect(() => {
    const issueIds = graph.issues.map((issue) => issue.id);
    if (issueIds.length === 0) {
      setEvidenceByIssueId({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      issueIds.map(async (issueId) => {
        try {
          return [issueId, await api.issueEvidence(issueId)] as const;
        } catch {
          return [issueId, []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) {
        setEvidenceByIssueId(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [graph.issues]);

  function toggleEntityType(type: EntityType) {
    setVisibleTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  function selectAllChapters() {
    setChapterRange({ startChapter: null, endChapter: null });
  }

  function updateRangeStart(value: string) {
    const startChapter = value === "all" ? null : Number(value);
    setChapterRange((current) => ({
      startChapter,
      endChapter:
        startChapter !== null && current.endChapter !== null && current.endChapter < startChapter
          ? startChapter
          : current.endChapter,
    }));
  }

  function updateRangeEnd(value: string) {
    const endChapter = value === "all" ? null : Number(value);
    setChapterRange((current) => ({
      startChapter:
        endChapter !== null && current.startChapter !== null && current.startChapter > endChapter
          ? endChapter
          : current.startChapter,
      endChapter,
    }));
  }

  function selectProject(project: Project) {
    prepareProjectData(project.id);
    setSourceRequest(undefined);
    userNavigationRef.current = true;
    window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, String(project.id));
    setSelectedProject(project);
    setSelectedEntity(null);
    setChapterRange({ startChapter: null, endChapter: null });
    setAnalysisRange({ startChapter: null, endChapter: null });
    // The selection effect owns this read; do not also fetch the old chapter range.
  }

  function createProject() {
    modalTriggerRef.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    setNewProjectTitle("");
    setProjectModalOpen(true);
  }

  async function submitNewProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newProjectTitle.trim();
    if (!title) {
      setNotice("작품 제목을 입력해 주세요.");
      return;
    }
    try {
      const project = await api.createProject(title);
      setProjects((current) => [project, ...current]);
      selectProject(project);
      setProjectModalOpen(false);
      setNewProjectTitle("");
      setNotice(`작품 생성: ${project.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "작품 생성 실패");
    }
  }

  async function saveProjectTitle(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedProject) {
      return;
    }
    const title = projectTitleDraft.trim();
    if (!title) {
      setNotice("작품 제목을 입력해 주세요.");
      return;
    }
    if (title === selectedProject.title) {
      setEditingProjectTitle(false);
      return;
    }
    try {
      const updated = await api.updateProjectTitle(selectedProject.id, title);
      setSelectedProject(updated);
      setProjects((current) =>
        current.map((project) => (project.id === updated.id ? updated : project)),
      );
      setEditingProjectTitle(false);
      setNotice(`작품 제목 저장: ${updated.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "작품 제목 저장 실패");
    }
  }

  async function deleteSelectedProject() {
    if (!selectedProject) {
      return;
    }
    const confirmed = window.confirm(
      `'${selectedProject.title}' 작품을 삭제할까요?\n이 작품의 원고, 청크, 엔티티, 관계, 이슈가 모두 삭제됩니다.`,
    );
    if (!confirmed) {
      return;
    }
    const deletedProject = selectedProject;
    setLoading(true);
    try {
      await api.deleteProject(deletedProject.id);
      clearGraphPositions(deletedProject.id);
      window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      prepareProjectData(null);
      setSelectedProject(null);
      setChapterRange({ startChapter: null, endChapter: null });
      setSelectedEntity(null);
      setAnalysisJob(null);
      const nextSelectedProject = await refreshProjects(null);
      await refreshProjectData(nextSelectedProject);
      setNotice(`작품 삭제: ${deletedProject.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "작품 삭제 실패");
    } finally {
      setLoading(false);
    }
  }

  async function importDocumentPath(path: string, replacement = replacementDocument, refreshAfter = true) {
    if (!selectedProject || workspaceBusy || (replacement && replacement.project_id !== selectedProject.id)) {
      return false;
    }
    const filePath = path.trim();
    if (!filePath) {
      setDocumentPathError("원고 파일 경로를 입력해 주세요.");
      return false;
    }
    const project = selectedProject;
    const write = mutationScope.current.begin(project.id, 'documents');
    if (!write) return false;
    setDocumentPathError("");
    setNotice(replacement ? "수정 원고를 저장하고 있습니다." : "원고를 가져오고 있습니다.");
    setLoading(true);
    try {
      const document = replacement
        ? await api.replaceDocument(replacement.id, filePath)
        : await api.importDocument(project.id, filePath);
      const changed = !replacement || replacement.content_hash !== document.content_hash;
      // A return visit may have loaded the old draft while the write was still
      // pending. Re-read it, but never give an old project ownership of a new view.
      if (dataOwnerRef.current === project.id) {
        if (changed) {
          setGraph(EMPTY_GRAPH);
          setSelectedEntity(null);
          setAnalysisJob(null);
        }
        const loaded = refreshAfter ? await refreshProjectData(project, chapterRangeRef.current) : true;
        if (loaded === true && dataOwnerRef.current === project.id) {
          // The project shelf carries denormalized document/analyzed counts.
          // Refresh it after every successful write so returning to "내 작품"
          // cannot show a stale `0편` (or an old pending count) for a project
          // whose manuscript list was just updated.
          if (refreshAfter || replacement) await refreshProjects(project.id);
          setNotice(changed
            ? `원고 ${replacement ? "교체" : "추가"}: ${document.title} · 이전 검토는 이력에서 확인할 수 있습니다. 현재 원고로 다시 분석해 주세요.`
            : "원고 내용이 같습니다. 기존 분석 결과와 작가 판단을 유지했습니다.");
        }
      }
      return write.isCurrent();
    } catch (error) {
      if (write.isCurrent()) {
        const message = error instanceof Error ? error.message : "원고 저장 응답을 확인하지 못했습니다. 원고 목록을 확인한 뒤 다시 시도해 주세요.";
        setDocumentPathError(message);
        setNotice(message);
      }
      return false;
    } finally {
      write.finish();
      setLoading(false);
    }
  }

  async function importDocument() {
    if (!selectedProject || workspaceBusy) {
      return;
    }
    setReplacementDocument(null);
    setDocumentPathError("");
    if (isTauriRuntime()) {
      await chooseDocumentFile(null);
      return;
    }
    setDocumentPathDraft("");
    modalTriggerRef.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    setDocumentPathModalOpen(true);
  }

  async function replaceDocument(document: StoryDocument) {
    if (!selectedProject || workspaceBusy || document.project_id !== selectedProject.id) return;
    setDocumentPathError("");
    if (isTauriRuntime()) {
      await chooseDocumentFile(document);
      return;
    }
    setReplacementDocument(document);
    setDocumentPathDraft("");
    modalTriggerRef.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    setDocumentPathModalOpen(true);
  }

  async function chooseDocumentFile(replacement: StoryDocument | null) {
    if (!selectedProject) return;
    const picker = mutationScope.current.begin(selectedProject.id, 'document-picker');
    if (!picker) return;
    try {
      // 여러 회차를 한 번에 선택할 수 있게 해 초기 업로드 비용을 줄입니다.
      // 수정본 교체는 대상 문서가 하나이므로 단일 선택을 유지합니다.
      const selected = await open({multiple: replacement ? false : true, filters: [{name: "원고", extensions: ["txt", "md", "docx"]}]});
      if (!picker.isCurrent() || selected === null) return;
      const paths = sortImportPaths((Array.isArray(selected) ? selected : [selected]).filter((path): path is string => typeof path === "string"));
      if (replacement) {
        if (paths[0]) await importDocumentPath(paths[0], replacement);
        return;
      }
      let imported = 0;
      let failed = 0;
      const failedNames: string[] = [];
      for (const path of paths) {
        if (!picker.isCurrent()) break;
        if (await importDocumentPath(path, null, false)) imported += 1;
        else { failed += 1; failedNames.push(path.split(/[\\/]/).pop() || path); }
      }
      if (picker.isCurrent() && imported > 0 && dataOwnerRef.current === selectedProject.id) {
        await refreshProjectData(selectedProject, chapterRangeRef.current);
        await refreshProjects(selectedProject.id);
      }
      if (picker.isCurrent() && (imported || failed)) {
        setNotice(failed
          ? `원고 ${imported}편을 가져왔고 ${failed}편은 실패했습니다 (${failedNames.slice(0, 3).join(', ')}${failed > 3 ? ' 외' : ''}). 실패한 파일을 확인한 뒤 다시 시도해 주세요.`
          : `원고 ${imported}편을 가져왔습니다. 분석 화면에서 전체 회차를 확인하세요.`);
      }
    } catch (error) {
      if (picker.isCurrent()) setNotice(error instanceof Error ? error.message : "파일 선택 창을 열지 못했습니다.");
    } finally { picker.finish(); }
  }

  async function submitDocumentPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const imported = await importDocumentPath(documentPathDraft);
    if (imported) {
      setDocumentPathModalOpen(false);
      setDocumentPathDraft("");
      setReplacementDocument(null);
    }
  }

  async function deleteDocument(document: StoryDocument) {
    if (!selectedProject || workspaceBusy || document.project_id !== selectedProject.id) {
      return;
    }
    const confirmed = window.confirm(`'${document.title}' 원고를 삭제할까요? 이전 검토는 이력에 보관되며 재분석이 필요합니다.`);
    if (!confirmed) {
      return;
    }
    const project = selectedProject;
    const write = mutationScope.current.begin(project.id, 'documents');
    if (!write) return;
    setNotice("원고를 삭제하고 있습니다.");
    setLoading(true);
    try {
      await api.deleteDocument(document.id);
      if (dataOwnerRef.current === project.id) {
        setGraph(EMPTY_GRAPH);
        setSelectedEntity(null);
        setAnalysisJob(null);
        const loaded = await refreshProjectData(project, chapterRangeRef.current);
        if (loaded === true && dataOwnerRef.current === project.id) setNotice(`원고 삭제: ${document.title} · 이전 검토는 이력에서 확인할 수 있습니다.`);
      }
    } catch (error) {
      if (write.isCurrent()) setNotice(error instanceof Error ? error.message : "원고 삭제 응답을 확인하지 못했습니다.");
    } finally {
      write.finish();
      setLoading(false);
    }
  }

  async function analyze(model?: string, effort?: string, force = false, range: ChapterRange = analysisRangeRef.current) {
    if (!selectedProject || workspaceBusy || activeAnalysisRef.current) return;
    const project = selectedProject;
    const visit = mutationScope.current.begin(project.id, 'analysis');
    if (!visit) return;
    const run = {project, jobId: Infinity, awaitingResponse: true};
    activeAnalysisRef.current = run;
    setActiveAnalysisProject(project);
    setLastAnalysisRequest({ model, effort, force, range });
    analysisRequestBaselineRef.current = { projectId: project.id, jobId: Infinity };
    setAnalysisJob(makePendingAnalysisJob(project.id));
    setNotice("작품 분석을 시작합니다.");
    let latestJob: AnalysisJob | null = null;
    try {
      const previousJob = await api.analysisStatus(project.id).catch(() => null);
      run.jobId = previousJob?.id ?? 0;
      analysisRequestBaselineRef.current = { projectId: project.id, jobId: run.jobId };
      let result = await (model ? api.analyzeProjectGpt(project.id, model, effort, force, 20, range) : api.analyzeProject(project.id));
      latestJob = await api.analysisStatus(project.id).catch(() => null);
      // Long GPT reviews are bounded to 20 windows per request. Continue a
      // few clean batches automatically for short manuscripts, then return
      // control to the writer so a 300-episode import cannot keep the app
      // busy for hours without an explicit continuation.
      let automaticBatches = 1;
      const MAX_AUTOMATIC_BATCHES = 3;
      while (model && automaticBatches < MAX_AUTOMATIC_BATCHES && latestJob?.status === 'partial'
        && latestJob.message.includes('나머지를 이어갑니다')
        && !(latestJob.window_details ?? []).some(window => ['failed', 'interrupted'].includes(window.status))) {
        result = await api.analyzeProjectGpt(project.id, model, effort, false, 20, range);
        latestJob = await api.analysisStatus(project.id).catch(() => null);
        automaticBatches += 1;
      }
      if (visit.isCurrent()) {
        if (latestJob?.project_id === project.id) setAnalysisJob(latestJob);
        const loaded = await refreshProjectData(project, chapterRangeRef.current);
        if (visit.isCurrent() && loaded !== false) setNotice(
          latestJob?.status === "partial" ? latestJob.message : `분석 완료: 엔티티 ${result.entity_count}개, 관계 ${result.relation_count}개, 이슈 ${result.issue_count}개${model ? ` · GPT 새 요청 ${result.request_count ?? 0}회 / 재사용 ${result.cached_count ?? 0}회` : ""}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "분석 요청 응답을 확인하지 못했습니다.";
      latestJob = analysisJobAfterError(await api.analysisStatus(project.id).catch(() => null), {projectId: project.id, jobId: run.jobId});
      if (visit.isCurrent()) {
        setAnalysisJob(latestJob ?? makeFailedAnalysisJob(project.id, message));
        setNotice(latestJob?.status === 'running' ? '요청 연결이 끊겼지만 분석은 진행 중입니다. 상태를 계속 확인합니다.' : message);
      }
    } finally {
      visit.finish();
      run.awaitingResponse = false;
      // An interrupted request can leave a live server job; keep the busy state until its status ends.
      if (activeAnalysisRef.current === run && latestJob?.status !== 'running') {
        activeAnalysisRef.current = null;
        analysisRequestBaselineRef.current = null;
        setActiveAnalysisProject(null);
      }
    }
  }

  async function cancelAnalysis() {
    if (!selectedProject || !analysisJob || analysisJob.status !== 'running') return;
    try {
      const cancelled = await api.cancelAnalysis(selectedProject.id);
      setAnalysisJob(cancelled);
      setNotice('분석을 중단했습니다. 완료된 구간과 기존 결과는 보존됩니다.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '분석 중단에 실패했습니다. 상태를 다시 확인해 주세요.');
    }
  }

  async function updateIssueStatus(issueId: number, status: IssueStatus): Promise<boolean> {
    if (!selectedProject) return false;
    const write = mutationScope.current.begin(selectedProject.id, `issue:${issueId}`);
    if (!write) return false;
    try {
      const updated = await api.updateIssueStatus(issueId, status);
      if (write.isCurrent()) {
        setGraph((current) => ({
          ...current,
          issues: current.issues.map((issue) => (issue.id === issueId ? updated : issue)),
        }));
        setNotice("작가 판단을 저장했습니다.");
      }
      return true;
    } catch (error) {
      if (write.isCurrent()) setNotice(error instanceof Error ? error.message : "이슈 상태 변경 실패");
      return false;
    } finally { write.finish(); }
  }

  async function updateGenerationModel(model: string) {
    try {
      const updated = await api.updateSettings({
        ...settings,
        generation_model: model,
      });
      setSettings(updated);
      setNotice(`생성 모델 저장: ${updated.generation_model}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "설정 저장 실패");
    }
  }

  async function startEnvironmentSetup(embeddingModel: string) {
    try {
      setNotice("로컬 AI 모델을 준비합니다.");
      const progress = await api.runSetup({
        install_runtime: false,
        prepare_embedding_model: true,
        prepare_generation_model: false,
        embedding_model: embeddingModel,
        generation_model:
          settings.generation_model ||
          setupStatus?.generation_model ||
          "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      });
      setSetupProgress(progress);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "환경 설정 시작 실패");
    }
  }

  async function refreshEnvironmentSetup() {
    try {
      await Promise.all([refreshSetup(), refreshLocalAi(), refreshSettings()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "환경 상태 확인 실패");
    }
  }

  function retryStartup() {
    startupActiveRef.current = true;
    setStartupStatus(INITIAL_STARTUP_STATUS);
    void refreshAll();
  }

  const projectPage = !['welcome', 'projects', 'setup', 'settings'].includes(page);
  const projectDataBlocked = selectedProject !== null && snapshotProjectId !== selectedProject.id;

  return (
    <div className={`app-shell workbench page-${page}`}>
      <WorkbenchNav page={page} onPage={setPage} project={selectedProject} projects={projects} onProject={selectProject}/>
      <main ref={workspaceRef} className="workspace">
        <header className="workspace-header">
          <div className="title-area">
            <h1 className="page-title">{page === 'graph' ? '이야기 사이의 연결을 따라' : PAGES[page][0]}</h1><p className="page-description">{page === 'graph' ? '인물과 장소, 사건을 잇는 실마리에서 이야기의 빈틈을 살펴보세요.' : PAGES[page][1]}</p>
            {editingProjectTitle && selectedProject && !['welcome','projects','setup','settings'].includes(page) ? (
              <form className="project-title-editor" onSubmit={saveProjectTitle}>
                <input
                  autoFocus
                  value={projectTitleDraft}
                  maxLength={120}
                  onChange={(event) => setProjectTitleDraft(event.target.value)}
                  aria-label="작품 제목"
                />
                <button type="submit" title="작품 제목 저장">
                  <Check size={16} />
                </button>
                <button
                  type="button"
                  title="취소"
                  onClick={() => {
                    setProjectTitleDraft(selectedProject.title);
                    setEditingProjectTitle(false);
                  }}
                >
                  <X size={16} />
                </button>
              </form>
            ) : (
              <div className={`project-title-row ${['welcome','projects','setup','settings'].includes(page) ? 'context-hidden' : ''}`}>
                <h2>{selectedProject?.title ?? "작품 없음"}</h2>
                {selectedProject && (
                  <>
                    <button
                      className="icon-button"
                      type="button"
                      title="작품 제목 편집"
                      onClick={() => setEditingProjectTitle(true)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      title="작품 삭제"
                      onClick={deleteSelectedProject}
                      disabled={workspaceBusy}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="status-strip">
            {!['welcome','projects','setup','settings'].includes(page) && <button type="button" onClick={() => setPage(page === "graph" ? "analysis" : "graph")}>{page === "graph" ? "새 분석" : "관계 지도"}</button>}
            {!['welcome','projects','setup','settings'].includes(page) && !projectDataBlocked && <span role={projectDataError ? "alert" : undefined}>{projectDataLoading ? '작품 데이터를 새로 확인하는 중입니다.' : notice}</span>}
            {!['welcome','projects','setup','settings'].includes(page) && !projectDataBlocked && projectDataError && <button type="button" disabled={projectDataLoading} onClick={() => void refreshProjectData(selectedProject)}>다시 시도</button>}
            {!['welcome','projects','setup','settings'].includes(page) && !projectDataBlocked && <><strong>대상 {filteredGraph.entities.length}개</strong><strong>관계 {filteredGraph.relations.length}/{graph.relations.length}개</strong></>}
          </div>
        </header>
        {activeAnalysisProject && activeAnalysisProject.id !== selectedProject?.id && <aside className="background-analysis" role="status"><span><strong>{activeAnalysisProject.title}</strong> 작품을 분석 중입니다. 다른 작품은 읽을 수 있으며 새 분석은 완료 후 시작할 수 있습니다.</span><button onClick={() => {selectProject(activeAnalysisProject); setPage('analysis');}}>진행 상황 보기</button></aside>}
        {projectPage && projectDataBlocked && <section className="project-load-state" aria-busy={projectDataLoading}>
          <div className="surface">
            <h2>{projectDataLoading ? '작품을 불러오는 중입니다' : '작품을 불러오지 못했습니다'}</h2>
            <p>{selectedProject?.title}</p>
            <p role={projectDataLoading ? 'status' : 'alert'}>{projectDataLoading ? '원고·설정·검토 결과를 함께 준비하고 있습니다.' : notice}</p>
            {!projectDataLoading && <button className="primary" onClick={() => void refreshProjectData(selectedProject)}>다시 시도</button>}
            <button onClick={() => setPage('projects')}>내 작품으로 이동</button>
          </div>
        </section>}
        <section hidden={page !== 'projects'}><ProjectsPage projects={projects} onCreate={createProject} onOpen={project=>{selectProject(project);setPage('manuscripts');}}/></section>
        <section hidden={page !== 'manuscripts' || projectDataBlocked}><ManuscriptsPage key={selectedProject?.id ?? "no-project"} active={page==='manuscripts'} sourceRequest={sourceRequest} documents={documents} settings={storySettings} onCreateSetting={createStorySetting} onUpdateSetting={updateStorySetting} onDeleteSetting={deleteStorySetting} onImport={importDocument} onDelete={deleteDocument} onReplace={replaceDocument} onAnalyze={()=>setPage('analysis')} loading={workspaceBusy}/></section>
        <section hidden={page !== 'review' || projectDataBlocked}><ReviewPage key={selectedProject?.id ?? "review-no-project"} history={reviewHistory} graph={graph} documents={documents} evidence={evidenceByIssueId} onStatus={updateIssueStatus} onOpenDocument={(documentId,quote) => {setSourceRequest({documentId,quote});setPage('manuscripts');}} onGraph={(relationId) => {const relation = relationId == null ? undefined : graph.relations.find(item => item.id === relationId); setSelectedRelationId(relationId ?? null); setSelectedEntity(relation ? graph.entities.find(entity => entity.id === relation.source_entity_id) ?? null : null); setPage('graph');}} onAnalysis={()=>setPage(documents.length ? 'analysis' : 'manuscripts')}/></section>
        <section hidden={page !== 'welcome'} className="welcome-page surface"><span className="eyebrow">작가의 판단을 돕는 도구</span><h2>이야기에 몰입하세요.<br/>설정의 연결은 함께 살펴볼게요.</h2><p>원고를 가져오면 인물과 설정의 관계를 정리하고,<br/>다시 확인할 부분을 원문 근거와 함께 보여드립니다.</p><div className="welcome-steps"><div>01<br/><strong>원고 가져오기</strong></div><div>02<br/><strong>내 AI로 분석하기</strong></div><div>03<br/><strong>근거 읽고 판단하기</strong></div></div><button className="primary" onClick={()=>setPage('setup')}>시작하기 →</button><p className="muted">원고는 로컬에 저장됩니다. 분석 시 동의한 원문은 외부 GPT로 전송됩니다.</p></section>
        <section hidden={page !== 'foreshadowing' || projectDataBlocked} className="page-content"><div className="surface"><h2>추출된 떡밥 후보</h2><p className="muted">AI는 등장 단서를 후보로 제시합니다. 마지막 언급 이후 공백만으로 미회수라고 단정하지 않고, 작가가 상태를 결정합니다.</p>{graph.entities.filter(e=>e.type==='foreshadowing').map(e=>{const current=foreshadowingStatuses.find(item=>item.entity_id===e.id)?.status??'unreviewed';return <div className="source-card foreshadowing-card" key={e.id}><div><h3>{e.name}</h3><span className={`setting-certainty ${current}`}>{{unreviewed:'검토 전',in_progress:'진행 중',resolved:'회수 확인',intentional:'의도적 미회수'}[current]}</span></div><p>{e.summary}</p><p className="muted">등장 회차 {e.document_ids.map(id=>documents.find(d=>d.id===id)?.chapter_index).filter((v):v is number=>v!==undefined).sort((a,b)=>a-b).map(ch=>`${ch+1}화`).join(' · ')||'확인 중'}</p><div className="foreshadowing-actions"><select aria-label={`${e.name} 상태`} value={current} onChange={event=>void updateForeshadowingStatus(e.id,event.target.value as ForeshadowingStatus['status'])}><option value="unreviewed">검토 전</option><option value="in_progress">진행 중</option><option value="resolved">회수 확인</option><option value="intentional">의도적 미회수</option></select><button onClick={()=>{setSelectedEntity(e);setPage('graph');}}>관계 지도에서 확인</button></div></div>})}{!graph.entities.some(e=>e.type==='foreshadowing')&&<div className="blank-state"><p>{graph.entities.length ? '현재 분석 결과에 떡밥 유형 후보가 없습니다. 원문에서 단서를 찾으려면 다시 분석해 보세요.' : '원고를 가져온 뒤 분석을 시작하면 떡밥 후보가 여기에 표시됩니다.'}</p><button className="primary" onClick={()=>setPage(graph.entities.length ? 'analysis' : 'manuscripts')}>{graph.entities.length ? '분석 설정으로 이동' : '원고 가져오기'}</button></div>}</div></section>
        <section hidden={!['analysis','settings','setup'].includes(page) || (page === 'analysis' && projectDataBlocked)} className="analysis-layout">
        {page === 'settings' && <section className="surface appearance-settings"><h2>화면·접근성</h2><p className="muted">오래 읽어도 편안한 화면을 선택하세요.</p><ThemePicker detailed/></section>}
          <div className="surface analysis-target">
            {page === 'analysis' ? <><h2>분석 대상</h2><div className="soft-card"><strong>{selectedProject?.title ?? '작품을 선택하세요'}</strong><p>전체 원고 · {documents.length}편 · {formatManuscriptChars(documents)}</p><p className="muted">원고 전체를 로컬에서 색인한 뒤, 선택한 회차 범위를 여러 구간으로 묶어 순서대로 검토합니다. 첫 실행은 검색 색인 시간이 필요하고, 이미 검증된 구간은 재시도 때 재사용합니다.</p></div><p className="muted analysis-list-hint">회차를 누르면 원고가 열립니다. 분석 회차 범위는 오른쪽 GPT 분석 패널에서 선택합니다.</p><DocumentPicker key={selectedProject?.id ?? 'analysis-no-project'} documents={documents} onSelect={documentId=>{setSourceRequest({documentId});setPage('manuscripts');}}/><button onClick={()=>setPage('manuscripts')}>{documents.length ? '원고·설정 관리' : '원고 가져오기'}</button><hr/><h3>이번 분석에서 확인할 내용</h3><p>설정 충돌 후보와 인물·아이템·규칙의 관계를 원문 근거와 함께 정리합니다.</p></> : page === 'setup' ? <><h2>준비 순서</h2><div className="soft-card"><strong>1. 내 GPT 연결</strong><p>작품 분석에 사용할 계정을 연결합니다.</p><strong>2. 원고 검색 모델 준비</strong><p>Qwen 또는 EmbeddingGemma 중 하나를 선택합니다.</p><strong>3. 내 작품으로 이동</strong><p>준비가 끝나면 원고를 가져오고 분석을 시작합니다.</p></div><button className="primary" onClick={()=>setPage('projects')}>내 작품으로 이동</button></> : <><h2>저장·분석 환경</h2><div className="soft-card"><strong>원고는 이 기기에 저장됩니다.</strong><p>GPT 분석을 실행할 때 동의한 원문과 검색 근거만 외부 GPT로 전송됩니다.</p></div><button onClick={()=>setPage('manuscripts')}>원고·설정 열기</button></>}
          </div>
          {page === 'analysis' && <div className="surface analysis-readiness"><strong>원고 검색 준비</strong><p className="muted">{setupStatus?.embedding_model ?? 'Qwen3-Embedding-0.6B-Q8_0.gguf'} · {setupStatus?.embedding_model_ready ? '검색 모델 준비 완료' : '검색 모델 준비 필요'}</p><p className="muted">원고를 수정하면 검색 자료와 분석 결과가 최신 상태가 아니게 됩니다. 다시 분석하면 현재 원문 기준으로 갱신됩니다.</p></div>}
          <div className="analysis-options">
        <ChatGptPanel projectId={selectedProject?.id} projectTitle={selectedProject?.title} hasDocuments={documents.length > 0} documentCount={documents.length} manuscriptChars={documents.reduce((total, document) => total + document.content.length, 0)} documentCharCounts={documents.map(document => document.content.length)} chapters={documents.map(document => ({ chapterIndex: document.chapter_index, title: document.title }))} analysisRange={analysisRange} onAnalysisRangeChange={setAnalysisRange} analyzing={workspaceBusy} onAnalyze={analyze} showAnalysis={page === 'analysis'} compact={page === 'analysis' || page === 'settings'} />
        {(page === "setup" || page === "settings") && (
          <SetupPanel
            status={setupStatus}
            progress={setupProgress}
            onStart={startEnvironmentSetup}
            onRefresh={refreshEnvironmentSetup}
          />
        )}
        {page === 'analysis' && analysisJob?.project_id === selectedProject?.id && analysisJob && analysisJob.status !== "idle" && (
          <AnalysisProgressPanel
            job={analysisJob}
            onRetry={!workspaceBusy && retryRequest ? () => void analyze(retryRequest.model, retryRequest.effort, false, retryRequest.range ?? analysisRangeRef.current) : undefined}
            onCancel={workspaceBusy ? () => void cancelAnalysis() : undefined}
          />
        )}
          {page === 'settings' && <details className="surface" open><summary>고급 · 로컬 생성 모델</summary><p>개인 GPT 분석에는 로컬 생성 모델이 필요하지 않습니다. 로컬 모델을 사용하는 경우에만 선택하세요.</p><select aria-label="로컬 생성 모델" value={settings.generation_model} onChange={e=>updateGenerationModel(e.target.value)}>{[...new Set([settings.generation_model,...(localAi?.models??[])])].map(m=><option key={m}>{m}</option>)}</select></details>}
          </div>
        </section>
        <section hidden={page !== 'graph' || projectDataBlocked} className="graph-page">
        <div className="graph-search"><input type="search" aria-label="인물·아이템·설정 검색" placeholder="이름이나 설정으로 실마리 찾기" value={graphSearch} onChange={e=>setGraphSearch(e.target.value)}/><span className="graph-type-legend">{ENTITY_TYPES.map(type=><span key={type} data-entity-type={type}><i aria-hidden="true"/>{ENTITY_TYPE_LABELS[type]}</span>)}</span></div>
        <div className="range-controls" aria-label="회차 분석 범위">
          <div>
            <span className="label">표시 회차</span>
            <strong>{graphRangeLabel}</strong>
            {(chapterRange.startChapter !== loadedChapterRange.startChapter || chapterRange.endChapter !== loadedChapterRange.endChapter) && <span role="status">{projectDataLoading ? '선택한 회차를 불러오는 중' : '조회 실패 · 이전 범위 표시 중'}</span>}
          </div>
          <button
            type="button"
            className={chapterRange.startChapter === null && chapterRange.endChapter === null ? "active" : ""}
            onClick={selectAllChapters}
            disabled={documents.length === 0}
          >
            전체 누적
          </button>
          <label>
            시작
            <select
              value={chapterRange.startChapter ?? "all"}
              onChange={(event) => updateRangeStart(event.target.value)}
              disabled={documents.length === 0}
            >
              <option value="all">1화</option>
              {chapterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            끝
            <select
              value={chapterRange.endChapter ?? "all"}
              onChange={(event) => updateRangeEnd(event.target.value)}
              disabled={documents.length === 0}
            >
              <option value="all">마지막</option>
              {chapterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <span className={graph.range.continuity_ready ? "range-message ready" : "range-message"}>
            {graph.range.message}
          </span>
        </div>
        <div className="graph-controls">
          <div className="relation-scope" aria-label="관계 표시 범위">
            <button
              type="button"
              className={relationScope === "core" ? "active" : ""}
              onClick={() => setRelationScope("core")}
            >
              핵심 관계
            </button>
            <button
              type="button"
              className={relationScope === "all" ? "active" : ""}
              onClick={() => setRelationScope("all")}
            >
              전체 관계
            </button>
            <button type="button" className={healthOnly ? "active health-filter" : "health-filter"} onClick={() => setHealthOnly(value => !value)}>
              점검 필요
            </button>
          </div>
          {ENTITY_TYPES.map((type) => (
            <button
              key={type}
              aria-pressed={visibleTypes.has(type)}
              className={visibleTypes.has(type) ? `active entity-${type}` : ""}
              onClick={() => toggleEntityType(type)}
            >
              {ENTITY_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
        <div className="graph-body"><Suspense fallback={<div className="graph-loading" role="status">관계 지도를 준비하는 중…</div>}><GraphView
          projectId={selectedProject?.id ?? null}
          graph={searchedGraph}
          visible={page === 'graph'}
          selectedRelationId={selectedRelationId}
          selectedEntityId={selectedEntity?.id ?? null}
          onSelectEntity={setSelectedEntity}
          onSelectRelation={setSelectedRelationId}
        /></Suspense>
        <GraphDetails onOpenDocument={(documentId,quote) => {setSourceRequest({documentId,quote});setPage("manuscripts");}} documents={documents} graph={searchedGraph} entity={selectedEntity} relationId={selectedRelationId} onRelation={setSelectedRelationId} onReview={()=>setPage('review')}/>
        </div></section>
      </main>
      <StartupLoader status={startupStatus} onRetry={retryStartup} />
      {projectModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setProjectModalOpen(false)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title-heading"
            onSubmit={submitNewProject}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div>
              <span className="label">새 작품</span>
              <h2 id="new-project-title-heading">작품 이름 설정</h2>
            </div>
            <label htmlFor="new-project-title">작품 제목</label>
            <input
              id="new-project-title"
              autoFocus
              maxLength={120}
              value={newProjectTitle}
              placeholder="예: 유리왕관의 항로"
              onChange={(event) => setNewProjectTitle(event.target.value)}
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setProjectModalOpen(false)}>
                취소
              </button>
              <button type="submit">생성</button>
            </div>
          </form>
        </div>
      )}
      {documentPathModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setDocumentPathModalOpen(false)}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-path-heading"
            onSubmit={submitDocumentPath}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div>
              <span className="label">{replacementDocument ? "원고 교체" : "원고 추가"}</span>
              <h2 id="document-path-heading">{replacementDocument ? `${replacementDocument.chapter_index + 1}화 수정본 선택` : "파일 경로 입력"}</h2>
              {replacementDocument && <p>회차와 제목을 유지합니다. 내용이 바뀌면 이전 검토와 원문 근거를 이력에 보관하며, 같은 내용이면 기존 분석을 유지합니다.</p>}
            </div>
            <label htmlFor="document-path">원고 파일 경로</label>
            <input
              id="document-path"
              autoFocus
              value={documentPathDraft}
              disabled={workspaceBusy}
              aria-invalid={Boolean(documentPathError)}
              aria-describedby={documentPathError ? "document-path-error" : undefined}
              placeholder="/Users/name/Documents/story.md"
              onChange={(event) => setDocumentPathDraft(event.target.value)}
            />
            {documentPathError && <p id="document-path-error" className="form-error" role="alert">{documentPathError}</p>}
            {loading && <p role="status">원고를 저장하고 있습니다. 이 창을 닫아도 저장은 계속됩니다.</p>}
            <div className="modal-actions">
              <button type="button" onClick={() => setDocumentPathModalOpen(false)}>
                {loading ? "닫기" : "취소"}
              </button>
              <button type="submit" disabled={workspaceBusy}>{loading ? "저장 중…" : replacementDocument ? "수정본으로 교체" : "추가"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
