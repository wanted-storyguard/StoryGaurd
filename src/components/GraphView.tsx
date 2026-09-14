import { aggregateRelationshipPairs, appendDanglingGhosts, partitionRelationships, relationshipBackboneIds, relationshipPositions } from "../lib/relationshipLayout";
import { countConnectedComponents, countDanglingRelations, isDanglingRelation, relationshipComponents, relationPairKey, relationTypesConflict, timelinePairsByStatus } from "../lib/relationshipHealth";
import cytoscape, { Core } from "cytoscape";
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildOrganizationMembership, isMembershipRelation } from "../lib/graphMembership";
import type { GraphPosition } from "../lib/graphLayoutStorage";
import type { EntityNode, EntityType, GraphPayload, RelationEdge } from "../lib/types";

const ENTITY_COLORS: Record<string, { fill: string; border: string }> = {
  character: { fill: "#39796e", border: "#24635B" },
  place: { fill: "#5f9075", border: "#3f6f56" },
  organization: { fill: "#a85b68", border: "#813f4c" },
  item: { fill: "#b78343", border: "#8a602c" },
  event: { fill: "#988359", border: "#74643e" },
  rule: { fill: "#4d8b87", border: "#2f6865" },
  foreshadowing: { fill: "#6687bd", border: "#46679a" },
};

export const MEMBERSHIP_EDGE_STYLE = {
  opacity: 0.48,
  "text-opacity": 0,
  "line-style": "dotted",
  width: 2.1,
  "z-index": 6,
} as const;

const ENTITY_TYPE_ORDER: EntityType[] = [
  "character",
  "place",
  "organization",
  "item",
  "event",
  "rule",
  "foreshadowing",
];
interface GraphViewProps {
  projectId: number | null;
  graph: GraphPayload;
  /** Hidden routes stay mounted in the workbench. Delay Cytoscape creation
   * until the graph page is visible so the first fit uses real dimensions. */
  visible?: boolean;
  selectedEntityId: number | null;
  selectedRelationId?: number | null;
  onSelectEntity: (entity: EntityNode | null) => void;
  onSelectRelation?: (id: number | null) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mixHex(from: string, to: string, amount: number) {
  const parse = (value: string) => {
    const normalized = value.replace("#", "");
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
};

  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const channel = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return `#${[channel(r1, r2), channel(g1, g2), channel(b1, b2)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Convert a WebKit trackpad pinch wheel delta into a bounded zoom multiplier. */
export function trackpadZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY * 0.0025);
}

export function graphPanOffset(start: { x: number; y: number }, delta: { x: number; y: number }, viewport: { width: number; height: number }, content: { width: number; height: number }, scale: number) {
  const safeScale = clamp(Number.isFinite(scale) && scale > 0 ? scale : 1, 0.55, 2.8);
  const next = {
    x: start.x - delta.x * content.width / Math.max(1, viewport.width) / safeScale,
    y: start.y - delta.y * content.height / Math.max(1, viewport.height) / safeScale,
  };
  // Keep at least one viewport of map content reachable in every direction.
  // Without a bound, a long drag can move the SVG entirely off-canvas and
  // leave the writer with a blank map and no obvious way back except reload.
  const maxX = Math.max(0, (content.width - viewport.width / safeScale) / 2);
  const maxY = Math.max(0, (content.height - viewport.height / safeScale) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, next.x)),
    y: Math.min(maxY, Math.max(-maxY, next.y)),
  };
}

export function entityVisual(entity: EntityNode, degree: number, clusterSize: number) {
  const palette = ENTITY_COLORS[entity.type] ?? { fill: "#7a8494", border: "#596272" };
  const weight = clamp(
    entity.type === "organization" ? Math.max(entity.visual_weight ?? 0.5, 0.72) : (entity.visual_weight ?? 0.5),
    0.22,
    1,
  );
  const livelyFill = mixHex("#efe6d8", palette.fill, weight);
  const fill =
    entity.appearance_state === "dormant"
      ? mixHex(livelyFill, "#d6cdc0", 0.62)
      : entity.appearance_state === "new"
        ? mixHex(livelyFill, "#c78635", 0.24)
        : entity.appearance_state === "fading"
          ? mixHex(livelyFill, "#b7aa9b", 0.35)
          : livelyFill;
  const border =
    entity.appearance_state === "new"
      ? "#a95f1d"
      : entity.appearance_state === "dormant"
        ? "#8b8278"
        : palette.border;
  return {
    fill,
    border,
    opacity: entity.appearance_state === "dormant" ? 0.5 : entity.appearance_state === "fading" ? 0.72 : 1,
    size:
      30 +
      weight * 24 +
      Math.min(degree * 1.6, 10) +
      (entity.type === "organization" ? 14 + Math.min(clusterSize * 3.8, 34) : 0),
    weight,
  };
}

export type GraphHealthLevel = "good" | "warn" | "danger";

export function graphHealthLevel(health: {
  explicit_break_count: number;
  conflicting_pair_count: number;
  dangling_relation_count: number;
  isolated_entity_count: number;
  unsupported_relation_count: number;
  generic_relation_count: number;
  changed_relation_count: number;
  gap_relation_count: number;
  component_count: number;
}): GraphHealthLevel {
  if (health.explicit_break_count || health.conflicting_pair_count || health.dangling_relation_count) return "danger";
  if (health.isolated_entity_count || health.unsupported_relation_count || health.generic_relation_count || health.changed_relation_count || health.gap_relation_count || health.component_count > 1) return "warn";
  return "good";
}

/** Keep timeline chips actionable: a count only includes pairs represented by
 * a drawable relation in the current graph payload. */
export function countVisibleTimelinePairs(graph: GraphPayload, status: "changed" | "gap" | "explicit_break") {
  const visiblePairs = new Set(graph.relations.map((relation) => relationPairKey(relation.source_entity_id, relation.target_entity_id)));
  return [...timelinePairsByStatus(graph, status)].filter((pair) => visiblePairs.has(pair)).length;
}

function relationTone(label: string) {
  const normalized = label.toLowerCase();
  if (/적대|대립|배신|의심|충돌|enemy|hostile|oppos|conflict|betray|rival/.test(normalized)) {
    return "#a45353";
  }
  if (/동맹|친구|협력|보호|구함|ally|friend|protect|support|trust/.test(normalized)) {
    return "#54785d";
  }
  if (/소속|조직|대표|관할|산하|휘하|본부|거점|member|leader|works|belongs|contains|affiliated|under/.test(normalized)) {
    return "#626b90";
  }
  if (/소유|아이템|사용|가지|열쇠|own|has|uses|item|possess/.test(normalized)) {
    return "#98713f";
  }
  if (/장소|발견|열림|있|located|visits|appears|at |in /.test(normalized)) {
    return "#4f817d";
  }
  if (/규칙|룰|rule|세계/.test(normalized)) {
    return "#4d8b87";
  }
  if (/떡밥|복선|foreshadow/.test(normalized)) {
    return "#6687bd";
  }
  return "#8790a0";
}

function sortedEntities(
  entities: EntityNode[],
  degreeByEntityId: Map<number, number>,
) {
  return [...entities].sort((left, right) => {
    const typeDelta = ENTITY_TYPE_ORDER.indexOf(left.type) - ENTITY_TYPE_ORDER.indexOf(right.type);
    if (typeDelta !== 0) {
      return typeDelta;
    }
    const degreeDelta = (degreeByEntityId.get(right.id) ?? 0) - (degreeByEntityId.get(left.id) ?? 0);
    if (degreeDelta !== 0) {
      return degreeDelta;
    }
    return left.name.localeCompare(right.name, "ko");
  });
}

export function buildObsidianPositions(
  graph: GraphPayload,
  entitiesById: Map<number, EntityNode>,
  membershipByOrganizationId: Map<number, Set<number>>,
  parentOrganizationByEntityId: Map<number, number>,
  degreeByEntityId: Map<number, number>,
) {
  const positions = new Map<number, GraphPosition>();
  const assignedEntityIds = new Set<number>();
  const organizations = sortedEntities(
    graph.entities.filter((entity) => entity.type === "organization"),
    degreeByEntityId,
  ).sort(
    (left, right) =>
      (membershipByOrganizationId.get(right.id)?.size ?? 0) -
        (membershipByOrganizationId.get(left.id)?.size ?? 0) ||
      (degreeByEntityId.get(right.id) ?? 0) - (degreeByEntityId.get(left.id) ?? 0),
  );

  const organizationDomains = organizations.map((organization) => {
    const memberIds = membershipByOrganizationId.get(organization.id) ?? new Set();
    const memberEntities = sortedEntities(
      [...memberIds]
        .map((entityId) => entitiesById.get(entityId))
        .filter((entity): entity is EntityNode => Boolean(entity)),
      degreeByEntityId,
    );
    const columnCount = clamp(Math.ceil(Math.sqrt(Math.max(memberEntities.length, 1) * 1.28)), 2, 5);
    const rowCount = Math.max(1, Math.ceil(memberEntities.length / columnCount));
    return {
      organization,
      memberEntities,
      columnCount,
      rowCount,
      width: Math.max(500, columnCount * 168 + 210),
      height: Math.max(340, rowCount * 124 + 210),
    };
  });

  const domainsPerRow = organizations.length <= 1 ? 1 : 2;
  const rowGap = 260;
  const columnGap = 260;
  let cursorY = 0;

  for (let rowStart = 0; rowStart < organizationDomains.length; rowStart += domainsPerRow) {
    const rowDomains = organizationDomains.slice(rowStart, rowStart + domainsPerRow);
    const rowWidth =
      rowDomains.reduce((sum, domain) => sum + domain.width, 0) +
      Math.max(0, rowDomains.length - 1) * columnGap;
    const rowHeight = Math.max(...rowDomains.map((domain) => domain.height), 0);
    let cursorX = -rowWidth / 2;

    for (const domain of rowDomains) {
      const { organization, memberEntities, columnCount } = domain;
      const hasMembers = memberEntities.length > 0;
      const center = {
        x: cursorX + domain.width / 2,
        y: cursorY + domain.height / 2,
      };
      cursorX += domain.width + columnGap;

      if (!hasMembers || parentOrganizationByEntityId.has(organization.id)) {
        positions.set(organization.id, center);
      }
      assignedEntityIds.add(organization.id);

      const cellWidth = 168;
      const cellHeight = 124;
      const gridWidth = (columnCount - 1) * cellWidth;
      const gridHeight = (Math.max(1, Math.ceil(memberEntities.length / columnCount)) - 1) * cellHeight;
      const arcLift = Math.min(58, Math.max(0, memberEntities.length - 2) * 7);

      memberEntities.forEach((member, memberIndex) => {
        const column = memberIndex % columnCount;
        const row = Math.floor(memberIndex / columnCount);
        const rowOffset =
          columnCount > 2 && row % 2 === 1 ? Math.min(44, cellWidth / 4) : 0;
        const normalizedColumn =
          columnCount === 1 ? 0 : (column - (columnCount - 1) / 2) / ((columnCount - 1) / 2);
        const arcY = Math.abs(normalizedColumn) * arcLift;
        positions.set(member.id, {
          x: center.x - gridWidth / 2 + column * cellWidth + rowOffset,
          y: center.y - gridHeight / 2 + row * cellHeight + arcY,
        });
        assignedEntityIds.add(member.id);
      });
    }

    cursorY += rowHeight + rowGap;
  }

  const organizationAreaHeight =
    organizationDomains.length > 0 ? cursorY - rowGap : 0;
  const organizationCenterOffset = organizationAreaHeight > 0 ? organizationAreaHeight / 2 : 0;
  for (const [entityId, position] of positions) {
    positions.set(entityId, {
      x: position.x,
      y: position.y - organizationCenterOffset,
    });
  }

  organizations.forEach((organization) => {
    assignedEntityIds.add(organization.id);
  });

  const standaloneOrganizations = organizations.filter(
    (organization) => (membershipByOrganizationId.get(organization.id)?.size ?? 0) === 0,
  );
  standaloneOrganizations.forEach((organization, index) => {
    if (!positions.has(organization.id)) {
      positions.set(organization.id, {
        x: (index - (standaloneOrganizations.length - 1) / 2) * 260,
        y: organizationDomains.length > 0 ? organizationAreaHeight / 2 + 160 : -80,
      });
    }
  });

  /*
   * Unassigned nodes are kept below organization domains by type lanes. They are intentionally
   * far from the organization rows so cross-links stay readable instead of stacking at center.
   */
  const looseEntities = sortedEntities(
    graph.entities.filter((entity) => !assignedEntityIds.has(entity.id)),
    degreeByEntityId,
  );
  const entitiesByType = new Map<EntityType, EntityNode[]>();
  for (const entity of looseEntities) {
    entitiesByType.set(entity.type, [...(entitiesByType.get(entity.type) ?? []), entity]);
  }
  const activeTypes = ENTITY_TYPE_ORDER.filter((type) => entitiesByType.has(type));
  const laneGap = 260;
  const startY = organizationDomains.length > 0 ? organizationAreaHeight / 2 + 300 : -150;
  activeTypes.forEach((type, laneIndex) => {
    const laneEntities = entitiesByType.get(type) ?? [];
    const laneX = (laneIndex - (activeTypes.length - 1) / 2) * laneGap;
    laneEntities.forEach((entity, index) => {
      positions.set(entity.id, {
        x: laneX + (index % 2 === 0 ? -34 : 34),
        y: startY + Math.floor(index / 2) * 118,
      });
    });
  });

  return positions;
}

const TYPE_NAMES: Record<EntityType,string> = {character:'인물',place:'장소',organization:'조직',item:'아이템',event:'사건',rule:'규칙',foreshadowing:'떡밥'};

export function GraphView({ projectId, graph, visible = true, selectedEntityId, selectedRelationId, onSelectEntity, onSelectRelation }: GraphViewProps) {
  const containerRef=useRef<HTMLDivElement>(null);
  const cyRef=useRef<Core|null>(null);
  const callbacks=useRef({onSelectEntity,onSelectRelation});callbacks.current={onSelectEntity,onSelectRelation};
  const [zoom,setZoom]=useState(100);
  const [pan,setPan]=useState({x:0,y:0});
  const panGesture=useRef<{startX:number;startY:number;startPan:{x:number;y:number};active:boolean;dragged:boolean}|null>(null);
  const [mapFocus,setMapFocus]=useState(false);
  useEffect(()=>{
    if(!mapFocus)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setMapFocus(false);};
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[mapFocus]);
  const [renderError,setRenderError]=useState('');
  const [focusId,setFocusId]=useState<number|null>(null);
  const [focusComponentAnchorId,setFocusComponentAnchorId]=useState<number|null>(null);
  const [candidatesOpen,setCandidatesOpen]=useState(false);
  const [danglingOpen,setDanglingOpen]=useState(false);
  const [issuesOnly,setIssuesOnly]=useState(false);
  const [revision,setRevision]=useState(0);
  const {network,unlinked}=useMemo(()=>partitionRelationships(graph),[graph]);
  const focused=focusId!==null && network.entities.some(e=>e.id===focusId);
  const networkComponents = useMemo(() => relationshipComponents(network), [network]);
  const focusedComponent = useMemo(
    () => focusComponentAnchorId === null
      ? null
      : networkComponents.find((component) => component.anchorId === focusComponentAnchorId) ?? null,
    [networkComponents, focusComponentAnchorId],
  );
  const shown=useMemo(()=>{
    if (focusedComponent) {
      const ids = new Set(focusedComponent.entityIds);
      return {
        ...network,
        entities: network.entities.filter((entity) => ids.has(entity.id)),
        relations: network.relations.filter((relation) => ids.has(relation.source_entity_id) && ids.has(relation.target_entity_id)),
      };
    }
    if(!focused) return network;
    const relations=network.relations.filter(r=>r.source_entity_id===focusId||r.target_entity_id===focusId);
    const ids=new Set(relations.flatMap(r=>[r.source_entity_id,r.target_entity_id]));
    return {...network,entities:network.entities.filter(e=>ids.has(e.id)),relations};
  },[network,focused,focusId,focusedComponent]);
  const health = useMemo(() => {
    // `graph` contains isolated and dangling candidates that are intentionally
    // kept outside the drawable network. In a focused view the canvas is the
    // source of truth, so scope every chip to that reduced view instead of
    // carrying warnings from a different component into the current map.
    const healthGraph = focused || focusedComponent ? shown : graph;
    const entityIds = new Set(healthGraph.entities.map(entity => entity.id));
    const relationEndpoints = new Set(
      healthGraph.relations.flatMap(relation => [relation.source_entity_id, relation.target_entity_id])
        .filter(entityId => entityIds.has(entityId)),
    );
    const byPair = new Map<string, Set<string>>();
    healthGraph.relations.forEach(r => {
      const key = [r.source_entity_id, r.target_entity_id].sort((a,b)=>a-b).join(":");
      const types = byPair.get(key) ?? new Set<string>();
      types.add(r.type); byPair.set(key, types);
    });
    return {
      connected_entity_count: relationEndpoints.size,
      component_count: countConnectedComponents(healthGraph),
      isolated_entity_count: healthGraph.entities.filter(e => !relationEndpoints.has(e.id)).length,
      unsupported_relation_count: healthGraph.relations.filter(r => !r.evidence_chunk_ids.length && !r.claims?.length).length,
      generic_relation_count: healthGraph.relations.filter(r => ["관계", "관련", "co_occurs", "동시 등장"].includes(r.type)).length,
      conflicting_pair_count: [...byPair.values()].filter(relationTypesConflict).length,
      changed_relation_count: countVisibleTimelinePairs(healthGraph, "changed"),
      explicit_break_count: countVisibleTimelinePairs(healthGraph, "explicit_break"),
      gap_relation_count: countVisibleTimelinePairs(healthGraph, "gap"),
      dangling_relation_count: focused || focusedComponent ? 0 : countDanglingRelations(graph),
      message: `${healthGraph.entities.length}개 대상 · ${healthGraph.relations.length}개 관계 후보를 현재 표시 범위에서 확인합니다.${graph.health?.message ? ` ${graph.health.message}` : ""}`,
    };
  }, [graph, shown, focused, focusedComponent]);
  const healthLevel = graphHealthLevel(health);
  const components = useMemo(() => relationshipComponents(shown), [shown]);
  const canvasGraph = useMemo(() => {
    if (focused || focusedComponent) return shown;
    return appendDanglingGhosts(graph, shown);
  }, [focused, focusedComponent, graph, shown]);
  const positions=useMemo(()=>relationshipPositions(canvasGraph),[canvasGraph,revision]);
  const selected=graph.entities.find(e=>e.id===selectedEntityId);
  const conflictingPairs = useMemo(() => {
    const byPair = new Map<string, Set<string>>();
    // Scope the visual warning to the same filtered range as the canvas. A
    // conflict found in a later chapter must not paint an earlier-only view
    // red when the current range contains just one side of the relationship.
    for (const relation of shown.relations) {
      const key = [relation.source_entity_id, relation.target_entity_id].sort((a,b)=>a-b).join(":");
      const values = byPair.get(key) ?? new Set<string>();
      values.add(relation.type);
      byPair.set(key, values);
    }
    return new Set([...byPair.entries()].filter(([, types]) => relationTypesConflict(types)).map(([key]) => key));
  }, [shown.relations]);
  const explicitBreakPairs = useMemo(() => {
    const visiblePairs = new Set(shown.relations.map((relation) => relationPairKey(relation.source_entity_id, relation.target_entity_id)));
    return new Set(
      (graph.timeline ?? [])
        .filter(item => item.status === "explicit_break")
        .map(item => [item.source_entity_id, item.target_entity_id].sort((a, b) => a - b).join(":"))
        .filter((pair) => visiblePairs.has(pair)),
    );
  }, [graph.timeline, shown.relations]);
  const visibleTimelinePairs = useMemo(
    () => new Set(shown.relations.map((relation) => relationPairKey(relation.source_entity_id, relation.target_entity_id))),
    [shown.relations],
  );
  const changedPairs = useMemo(() => new Set(
    (graph.timeline ?? [])
      .filter(item => item.status === "changed")
      .map(item => [item.source_entity_id, item.target_entity_id].sort((a, b) => a - b).join(":"))
      .filter((pair) => visibleTimelinePairs.has(pair)),
  ), [graph.timeline, visibleTimelinePairs]);
  // Keep the canvas diagnostic state in lockstep with the health summary.
  // `timelinePairsByStatus` also infers a reviewable middle gap when the same
  // pair reappears in non-adjacent chapters, so the writer sees that signal on
  // the map instead of only in the metric chip.
  const gapPairs = useMemo(() => {
    const inferred = timelinePairsByStatus(graph, "gap");
    return new Set([...inferred].filter((pair) => visibleTimelinePairs.has(pair)));
  }, [graph, visibleTimelinePairs]);
  const danglingRelations = useMemo(() => {
    const ids = new Set(graph.entities.map(entity => entity.id));
    return graph.relations.filter(relation => isDanglingRelation(relation, ids));
  }, [graph.entities, graph.relations]);
  const actionableDanglingRelations = focused || focusedComponent ? [] : danglingRelations;
  const issueRelations = useMemo(() => {
    const byPair = (pairs: Set<string>) => shown.relations.find((relation) => pairs.has(relationPairKey(relation.source_entity_id, relation.target_entity_id)));
    return {
      unsupported: shown.relations.find((relation) => !relation.evidence_chunk_ids.length && !relation.claims?.length),
      generic: shown.relations.find((relation) => ["관계", "관련", "co_occurs", "동시 등장"].includes(relation.type)),
      conflict: byPair(conflictingPairs),
      changed: byPair(changedPairs),
      gap: byPair(gapPairs),
      explicitBreak: byPair(explicitBreakPairs),
      dangling: actionableDanglingRelations[0],
    };
  }, [shown.relations, conflictingPairs, changedPairs, gapPairs, explicitBreakPairs, actionableDanglingRelations]);
  const issueRelationIds = useMemo(() => {
    const isIssue = (relation: RelationEdge) => {
      const pair = relationPairKey(relation.source_entity_id, relation.target_entity_id);
      return relation.is_weak ||
        !relation.evidence_chunk_ids.length && !relation.claims?.length ||
        ["관계", "관련", "co_occurs", "동시 등장"].includes(relation.type) ||
        conflictingPairs.has(pair) || changedPairs.has(pair) || gapPairs.has(pair) || explicitBreakPairs.has(pair);
    };
    return new Set(network.relations.filter(isIssue).map((relation) => relation.id));
  }, [network.relations, conflictingPairs, changedPairs, gapPairs, explicitBreakPairs]);
  const entityName = useCallback((id: number) => graph.entities.find(entity => entity.id === id)?.name ?? `알 수 없는 대상 #${id}`, [graph.entities]);
  const focusIssueRelation = useCallback((relation?: RelationEdge) => {
    if (!relation) return;
    const source = graph.entities.find((entity) => entity.id === relation.source_entity_id) ?? null;
    callbacks.current.onSelectEntity(source);
    callbacks.current.onSelectRelation?.(relation.id);
  }, [graph.entities]);
  // A scope, type, search, or chapter change produces a new graph payload.
  // Clear the previous local focus in that case; otherwise switching back to
  // “전체 관계” can keep rendering the component selected in the old scope.
  useEffect(()=>{
    setFocusId(null);
    setFocusComponentAnchorId(null);
    setCandidatesOpen(false);
    setDanglingOpen(false);
  },[projectId, graph]);

  useEffect(()=>{
    if(!visible || !containerRef.current || !canvasGraph.entities.length) return;
    let cy:Core|null=null;
    let observer:ResizeObserver|null=null;
    let settleTimer: number | undefined;
    const fit=()=>{
      if(!cy || cy.destroyed())return;
      // Leave a visible breathing room around the outermost cards. A tight
      // fit makes the first/last node look clipped when the native window is
      // resized between the initial layout pass and the ResizeObserver pass.
      const fitPadding = Math.max(20, Math.min(56, Math.min(cy.width(), cy.height()) * .09));
      cy.resize();cy.fit(cy.elements(), fitPadding);
      // Cytoscape's fit can make a sparse layered map unreadably small. Keep a
      // readable floor for normal-sized manuscripts while allowing very large
      // graphs to zoom out further.
      // Fit is authoritative: forcing a large floor can clip the first/last
      // node in a short but wide graph. Keep only a conservative floor for
      // very large maps so the complete network remains inside the viewport.
      const readableFloor = shown.entities.length > 36 ? 0.22 : 0.30;
      if(cy.zoom()>1.15)cy.zoom(1.15);
      if(cy.zoom()<readableFloor)cy.zoom(readableFloor);
      cy.center();
    };
    try {
      setRenderError('');
      const pairs=new Map<string,number[]>();
      for(const r of canvasGraph.relations){const key=relationPairKey(r.source_entity_id,r.target_entity_id);pairs.set(key,[...(pairs.get(key)??[]),r.id]);}
      const relationById = new Map(canvasGraph.relations.map(relation => [relation.id, relation]));
      const relationLabelScore = (relation: RelationEdge) =>
        (relation.evidence_chunk_ids.length ? 4 : 0) +
        (relation.claims?.length ? 3 : 0) +
        (relation.is_weak ? 0 : 2) +
        (relation.type === '관계' || relation.type === '관련' ? 0 : 1) +
        relation.confidence;
      const labelIssueScore = (relation: RelationEdge) => {
        const pair = relationPairKey(relation.source_entity_id, relation.target_entity_id);
        const dangling = isDanglingRelation(relation, new Set(canvasGraph.entities.map(entity => entity.id)));
        return (dangling ? 80 : 0) +
          (explicitBreakPairs.has(pair) || conflictingPairs.has(pair) ? 60 : 0) +
          (gapPairs.has(pair) || changedPairs.has(pair) ? 40 : 0) +
          ((!relation.evidence_chunk_ids.length && !relation.claims?.length) ? 20 : 0) +
          (relation.is_weak ? 10 : 0) +
          (['관계', '관련', 'co_occurs', '동시 등장'].includes(relation.type) ? 10 : 0);
      };
      const labelRelationIds = new Set<number>();
      for (const ids of pairs.values()) {
        const representative = [...ids]
          .map(id => relationById.get(id))
          .filter((relation): relation is RelationEdge => Boolean(relation))
          .sort((left, right) => labelIssueScore(right) - labelIssueScore(left) || relationLabelScore(right) - relationLabelScore(left) || left.id - right.id)[0];
        if (representative) labelRelationIds.add(representative.id);
      }
      const labelLimit = canvasGraph.entities.length > 12 ? 14 : 24;
      const trimmedLabelIds = new Set(
        [...labelRelationIds]
          .map(id => relationById.get(id)!)
          .sort((left, right) => labelIssueScore(right) - labelIssueScore(left) || relationLabelScore(right) - relationLabelScore(left) || left.id - right.id)
          .slice(0, labelLimit)
          .map(relation => relation.id),
      );
      // Draw one semantic edge per entity pair. The extractor can produce
      // several claims for the same pair (for example 협력 + 충돌 across
      // chapters); drawing all of them makes the overview look like a hairball.
      // Keep every relation in the payload and evidence rail, but aggregate
      // the canvas edge into a representative with a count badge.
      const representativeRelations = aggregateRelationshipPairs(canvasGraph.relations)
        .map(({ pairKey, members }) => {
          const representative = [...members].sort((left, right) => relationLabelScore(right) - relationLabelScore(left) || left.id - right.id)[0];
          return representative ? { pairKey, members, representative } : null;
        })
        .filter((entry): entry is { pairKey: string; members: RelationEdge[]; representative: RelationEdge } => Boolean(entry));
      const backboneIds = relationshipBackboneIds(canvasGraph.entities, canvasGraph.relations);
      const degreeByEntityId = new Map<number, number>();
      for (const relation of canvasGraph.relations) {
        if (relation.source_entity_id !== relation.target_entity_id) {
          degreeByEntityId.set(relation.source_entity_id, (degreeByEntityId.get(relation.source_entity_id) ?? 0) + 1);
          degreeByEntityId.set(relation.target_entity_id, (degreeByEntityId.get(relation.target_entity_id) ?? 0) + 1);
        }
      }
      // A saved layout may belong to a narrower filter (for example 핵심
      // 관계) and therefore contain only part of the nodes in 전체 관계.
      // Mixing those stale coordinates with new nodes can push the complete
      // map outside the viewport. Reuse persisted coordinates only when they
      // cover the whole current graph; otherwise use the deterministic layout.
      const savedPositions = positions.size === canvasGraph.entities.length ? positions : new Map<number, GraphPosition>();
      const fallbackPositions = new Map<number, GraphPosition>();
      canvasGraph.entities.forEach((entity, index) => {
        const position = savedPositions.get(entity.id);
        fallbackPositions.set(entity.id, position && Number.isFinite(position.x) && Number.isFinite(position.y)
          ? position
          : { x: (index % 6) * 220, y: Math.floor(index / 6) * 170 });
      });
      cy=cytoscape({container:containerRef.current,minZoom:.12,maxZoom:2.5,userZoomingEnabled:true,
        layout:{name:'preset'},
        elements:[...canvasGraph.entities.map(e=>{const visual=entityVisual(e, degreeByEntityId.get(e.id) ?? 0, canvasGraph.entities.length); const danglingNode=e.name.startsWith('미확인 대상 #'); return {data:{id:`n${e.id}`,entityId:e.id,dangling:danglingNode?1:0,
          // Keep the canvas label to the entity name. Type is encoded by the
          // shape and legend; repeating it in every node made dense graphs
          // wrap into two lines and hid the relationship labels.
          label:e.name,color:visual.border,fill:visual.fill,opacity:visual.opacity,width:visual.size + (e.type === 'character' ? 20 : 0),height:e.type === 'character' ? visual.size + 20 : 88,kind:e.type,degree:degreeByEntityId.get(e.id) ?? 0},position:fallbackPositions.get(e.id)};}),
          ...representativeRelations.map(({pairKey, members, representative:r})=>{
            const relationTypes = new Set(members.map(member => member.type));
            const directions = new Set(members.map(member => `${member.source_entity_id}>${member.target_entity_id}`));
            const bidirectional = directions.size > 1;
            const weak = members.every(member => member.is_weak);
            const conflict = conflictingPairs.has(pairKey);
            const broken = explicitBreakPairs.has(pairKey);
            const changed = changedPairs.has(pairKey);
            const gap = gapPairs.has(pairKey);
            const backbone = backboneIds.has(r.id);
            const label = trimmedLabelIds.has(r.id)
              ? `${r.type==='관계'?'유형 미분류':(r.display_label||r.type)}${members.length > 1 ? ` · ${members.length}개` : ''}`
              : (members.length > 1 ? `관계 후보 ${members.length}개` : '');
            return {data:{id:`r${r.id}`,relationId:r.id,source:`n${r.source_entity_id}`,target:`n${r.target_entity_id}`,
              label,arrow:relationTypes.has('관계') && relationTypes.size === 1?'none':'triangle',
              // A small deterministic bow keeps unrelated cross-links from
              // collapsing into one straight stroke in dense networks.
              curve:(((r.id * 37) % 5) - 2) * 26,
              color:broken?'#AD443B':conflict?'#AD443B':changed?'#8A5A20':gap?'#B58A4D':(weak?'#A2ABA5':relationTone(r.type)),weak:weak?1:0,generic:relationTypes.size === 1 && (relationTypes.has('관계')||relationTypes.has('관련')||relationTypes.has('co_occurs')),conflict:conflict?1:0,broken:broken?1:0,changed:changed?1:0,gap:gap?1:0,bidirectional:bidirectional?1:0,
              dangling:members.some(member => isDanglingRelation(member, new Set(canvasGraph.entities.map(entity => entity.id))))?1:0,backbone:backbone?1:0,candidateCount:members.length,relationIds:members.map(member => member.id)}};
          })],
        style:[
          {selector:'node',style:{shape:'round-rectangle',width:('data(width)' as unknown) as number,height:('data(height)' as unknown) as number,'background-color':'data(fill)','background-opacity':('data(opacity)' as unknown) as number,'border-color':'data(color)','border-width':1.5,label:'data(label)',color:'#252A27','font-family':'Pretendard, sans-serif','font-size':16,'font-weight':600,'text-wrap':'wrap','text-max-width':'140px','text-valign':'center','text-halign':'center','line-height':1.5,'overlay-opacity':0}},
          {selector:'node[kind="character"]',style:{shape:'ellipse','border-width':2}},
          // Shape carries the entity type so a dense map can be scanned
          // without relying on color or opening every inspector card.
          {selector:'node[kind="item"]',style:{shape:'round-rectangle','border-width':1.8}},
          {selector:'node[kind="rule"]',style:{shape:'rectangle','border-width':1.8}},
          {selector:'node[kind="event"]',style:{shape:'diamond','border-width':1.8}},
          {selector:'node[kind="foreshadowing"]',style:{shape:'hexagon','border-width':1.8}},
          {selector:'node[dangling=1]',style:{'border-color':'#AD443B','border-style':'dashed','background-color':'#FFF0EE','color':'#AD443B','font-size':13,'font-weight':700,'text-max-width':'120px'}},
          {selector:'edge',style:{label:'data(label)',width:1.8,'line-color':'data(color)','target-arrow-color':'data(color)','target-arrow-shape':'triangle','arrow-scale':.85,'curve-style':'unbundled-bezier','control-point-distances':'data(curve)','control-point-weights':.5,'font-family':'Pretendard, sans-serif','font-size':13,color:'#465650','text-wrap':'wrap','text-max-width':'112px','text-background-color':'#FFFDF8','text-background-opacity':.96,'text-background-padding':'5px','text-border-color':'#DADFD8','text-border-width':1,'text-border-opacity':.6,'text-margin-y':-5,'overlay-opacity':0}},
          {selector:'edge[backbone=1]',style:{width:2.8,'line-color':'data(color)','target-arrow-color':'data(color)','font-weight':600,'z-index':4}},
          {selector:'edge[arrow="none"]',style:{'target-arrow-shape':'none'}},
          {selector:'edge[weak=1]',style:{'line-style':'dashed'}},
          {selector:'edge[generic=1]',style:{'line-style':'dotted','line-color':'#B58A4D','target-arrow-color':'#B58A4D',color:'#8A5A20'}},
          {selector:'edge[conflict=1]',style:{width:3,'line-color':'#AD443B','target-arrow-color':'#AD443B','line-style':'dashed','font-weight':700}},
          {selector:'edge[broken=1]',style:{width:3.2,'line-color':'#AD443B','target-arrow-color':'#AD443B','line-style':'solid','font-weight':700,'z-index':21}},
          {selector:'edge[dangling=1]',style:{width:2.8,'line-color':'#AD443B','target-arrow-color':'#AD443B','line-style':'dashed','font-weight':700,'z-index':19}},
          {selector:'edge[changed=1]',style:{width:2.6,'line-color':'#8A5A20','target-arrow-color':'#8A5A20','line-style':'dashed','font-weight':600}},
          {selector:'edge[gap=1]',style:{width:2.4,'line-color':'#B58A4D','target-arrow-color':'#B58A4D','line-style':'dotted','font-weight':600}},
          {selector:'edge[candidateCount > 1]',style:{'text-background-color':'#F6EADB','text-border-color':'#D5B67F','text-border-opacity':.9}},
          {selector:'edge[bidirectional=1]',style:{'source-arrow-shape':'triangle','source-arrow-color':'data(color)','arrow-scale':.75}},
          {selector:'.muted',style:{opacity:.18,'text-opacity':.2}},
          {selector:'node:selected',style:{'border-width':3,'border-color':'#24635B','underlay-color':'#24635B','underlay-opacity':.1,'underlay-padding':8}},
          {selector:'edge:selected',style:{width:3,'line-color':'#24635B','target-arrow-color':'#24635B','font-weight':700,'z-index':20}},
        ]});
      cyRef.current=cy;
      // Cytoscape is kept as a hidden interaction/indexing engine. Its fit
      // zoom is in rendered pixels and is not the same scale as the SVG
      // viewBox, so do not let its zoom events collapse the visible map to a
      // 30% thumbnail.
      cy.on('tap','node',event=>{callbacks.current.onSelectRelation?.(null);const entity=canvasGraph.entities.find(e=>e.id===event.target.data('entityId'));callbacks.current.onSelectEntity(entity?.name.startsWith('미확인 대상 #')?null:entity??null);});
      cy.on('tap','edge',event=>{callbacks.current.onSelectEntity(null);callbacks.current.onSelectRelation?.(event.target.data('relationId'));});
      cy.on('tap',event=>{if(event.target===cy){callbacks.current.onSelectEntity(null);callbacks.current.onSelectRelation?.(null);}});
      // Filter changes create a new composition. Never restore the old 36% grid viewport.
      fit();
      requestAnimationFrame(fit);
      settleTimer = window.setTimeout(fit, 120);
      observer=new ResizeObserver(fit);observer.observe(containerRef.current);
    }catch(error){setRenderError(error instanceof Error?error.message:'관계 지도를 표시하지 못했습니다.');}
    return ()=>{observer?.disconnect();if(settleTimer!==undefined)window.clearTimeout(settleTimer);cy?.destroy();if(cyRef.current===cy)cyRef.current=null;};
  },[canvasGraph,shown,positions,projectId,visible]);
  useEffect(()=>{
    const cy=cyRef.current;if(!cy)return;
    cy.elements().removeClass('muted diagnostic-muted');cy.elements().unselect();
    if (issuesOnly) {
      const issueEdges = cy.edges().filter((edge) =>
        Number(edge.data('weak')) === 1 ||
        Number(edge.data('generic')) === 1 ||
        Number(edge.data('conflict')) === 1 ||
        Number(edge.data('broken')) === 1 ||
        Number(edge.data('changed')) === 1 ||
        Number(edge.data('gap')) === 1 ||
        Number(edge.data('dangling')) === 1,
      );
      cy.edges().difference(issueEdges).addClass('diagnostic-muted');
      cy.nodes().filter((node) => node.connectedEdges().intersection(issueEdges).empty()).addClass('diagnostic-muted');
    }
    if(selectedRelationId!=null){
      const edge=cy.getElementById(`r${selectedRelationId}`);
      const representative=edge.nonempty() ? edge : cy.edges().filter((candidate) => ((candidate.data('relationIds') as number[] | undefined) ?? []).includes(selectedRelationId));
      if(representative.nonempty()){
        representative.select();
        const neighbourhood = representative.union(representative.connectedNodes());
        cy.elements().difference(neighbourhood).addClass('muted');
        // Selecting a health metric must reveal the actual problematic edge,
        // even when the full map was fitted to a large manuscript.
        cy.animate({
          center: { eles: neighbourhood },
          zoom: Math.max(cy.zoom(), 0.72),
        }, { duration: 220 });
        return;
      }
    }
    if(selectedEntityId===null)return;
    const node=cy.getElementById(`n${selectedEntityId}`);if(node.empty())return;
    if (focusedComponent) {
      // A component overview is an inspection mode: keep every member at
      // full opacity so the writer can read the whole structure at once.
      node.select();
      return;
    }
    node.select();const neighbours=node.closedNeighborhood();cy.elements().difference(neighbours).addClass('muted');
  },[selectedEntityId,selectedRelationId,shown,focusedComponent,issuesOnly]);
  // The native macOS WebView has a reproducible case where Cytoscape creates
  // its canvas but does not paint it after a hidden-route mount. Keep the
  // Cytoscape instance for its mature hit testing/selection model, while the
  // visible map is rendered from the same data through a deterministic SVG.
  // This also gives us a renderer that is inspectable and reliable in a
  // packaged desktop build instead of depending on a GPU canvas repaint.
  const svgRelations = useMemo(() => {
    const seen = new Set<string>();
    return aggregateRelationshipPairs(canvasGraph.relations).flatMap(({ pairKey, members }) => {
      if (seen.has(pairKey)) return [];
      seen.add(pairKey);
      const representative = [...members].sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0) || left.id - right.id)[0];
      return representative ? [{ pairKey, members, representative }] : [];
    });
  }, [canvasGraph.relations]);
  const svgMetrics = useMemo(() => {
    const values = [...positions.values()].filter(position => Number.isFinite(position.x) && Number.isFinite(position.y));
    if (!values.length) return { minX: -400, maxX: 400, minY: -240, maxY: 240, centerX: 0, centerY: 0, width: 800, height: 480 };
    const minX = Math.min(...values.map(position => position.x)) - 100;
    const maxX = Math.max(...values.map(position => position.x)) + 100;
    const minY = Math.min(...values.map(position => position.y)) - 60;
    const maxY = Math.max(...values.map(position => position.y)) + 100;
    return { minX, maxX, minY, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, width: Math.max(600, maxX - minX), height: Math.max(280, maxY - minY) };
  }, [positions]);
  const svgViewBox = useMemo(() => {
    const scale = clamp(zoom / 100, 0.55, 2.8);
    return `${svgMetrics.centerX - svgMetrics.width / (2 * scale) + pan.x} ${svgMetrics.centerY - svgMetrics.height / (2 * scale) + pan.y} ${svgMetrics.width / scale} ${svgMetrics.height / scale}`;
  }, [svgMetrics, zoom, pan]);
  const fit=()=>{const cy=cyRef.current;if(cy){const fitPadding=Math.max(20,Math.min(56,Math.min(cy.width(),cy.height())*.09));cy.fit(cy.elements(),fitPadding);const readableFloor=shown.entities.length>36?.22:.24;if(cy.zoom()>1.15)cy.zoom(1.15);if(cy.zoom()<readableFloor)cy.zoom(readableFloor);cy.center();}setZoom(100);setPan({x:0,y:0});};
  const changeZoom=(factor:number)=>{const cy=cyRef.current;if(cy)cy.zoom({level:Math.min(2.5,Math.max(.12,cy.zoom()*factor)),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});setZoom(value=>Math.round(clamp(value*factor,55,280)));};
  // macOS trackpad pinch gestures arrive in WebKit as a wheel event with a
  // modifier key. The visible map is an SVG (Cytoscape is intentionally a
  // hidden hit-testing engine), so the browser's native zoom would otherwise
  // be applied to the whole page while the SVG stayed unchanged. Two-finger
  // scrolling over the map is handled as panning so the fixed graph viewport
  // never leaks the gesture into page scrolling.
  const handleTrackpadZoom=(event: React.WheelEvent<HTMLDivElement>)=>{
    if(event.ctrlKey || event.metaKey){
      event.preventDefault();
      const factor=trackpadZoomFactor(event.deltaY);
      if(Number.isFinite(factor) && factor > 0) changeZoom(factor);
      return;
    }
    if(!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY) || (event.deltaX===0 && event.deltaY===0))return;
    event.preventDefault();
    const rect=event.currentTarget.getBoundingClientRect();
    // Wheel events can arrive faster than React commits state. Use a
    // functional update so consecutive two-finger deltas accumulate instead
    // of each event reading the same stale pan value.
    setPan(currentPan => graphPanOffset(currentPan,{x:event.deltaX,y:event.deltaY},{width:rect.width,height:rect.height},svgMetrics,zoom/100));
  };
  const handlePointerDown=(event: React.PointerEvent<HTMLDivElement>)=>{
    if(event.button!==0)return;
    panGesture.current={startX:event.clientX,startY:event.clientY,startPan:pan,active:true,dragged:false};
  };
  const handlePointerMove=(event: React.PointerEvent<HTMLDivElement>)=>{
    const gesture=panGesture.current;if(!gesture?.active)return;
    const delta={x:event.clientX-gesture.startX,y:event.clientY-gesture.startY};
    if(Math.hypot(delta.x,delta.y)>4){
      gesture.dragged=true;
      // Capture an actual drag, not a simple click on a node or relation.
      if(!event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.setPointerCapture(event.pointerId);
    }
    if(!gesture.dragged)return;
    const rect=event.currentTarget.getBoundingClientRect();
    setPan(graphPanOffset(gesture.startPan,delta,{width:rect.width,height:rect.height},svgMetrics,zoom/100));
  };
  const handlePointerUp=(event: React.PointerEvent<HTMLDivElement>)=>{
    if(!panGesture.current?.active)return;
    panGesture.current.active=false;
    // `lostpointercapture` may have already released this pointer. Guard the
    // explicit release so a trailing pointerup cannot throw and interrupt
    // the next graph gesture.
    if(event.currentTarget.hasPointerCapture?.(event.pointerId)){
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const consumeMapDrag=()=>{
    if(!panGesture.current?.dragged)return false;
    panGesture.current.dragged=false;
    return true;
  };
  return <div className={`graph-stage relationship-stage${mapFocus?" map-focus-active":""}`}>
    <details className={`graph-health-disclosure ${healthLevel}`}>
      <summary>관계 점검 · {healthLevel === 'good' ? '안정' : healthLevel === 'danger' ? '주의 필요' : '확인 필요'}<span>{[
        health.isolated_entity_count && `고립 후보 ${health.isolated_entity_count}`,
        health.conflicting_pair_count && `충돌 ${health.conflicting_pair_count}`,
        health.changed_relation_count && `변화 ${health.changed_relation_count}`,
        health.gap_relation_count && `중간 공백 ${health.gap_relation_count}`,
        health.explicit_break_count && `명시적 단절 ${health.explicit_break_count}`,
        health.dangling_relation_count && `끊긴 끝점 ${health.dangling_relation_count}`,
        health.unsupported_relation_count && `근거 부족 ${health.unsupported_relation_count}`,
        health.generic_relation_count && `미분류 ${health.generic_relation_count}`,
      ].filter(Boolean).join(' · ') || '점검 항목 보기'}</span></summary>
    <div className="graph-health" role="status" aria-live="polite" aria-label="관계 건강도">
      <div><strong>관계 건강도 <span className={`health-state ${healthLevel}`}>{healthLevel === "danger" ? "주의 필요" : healthLevel === "warn" ? "확인 필요" : "안정"}</span></strong><span>{health.message}</span></div>
      <div className="graph-health-metrics">
        <span className="health-good">연결 대상 {health.connected_entity_count}</span>
        <span className={health.component_count > 1 ? "health-warn" : "health-good"}>분리된 망 {health.component_count}</span>
        <span className={health.isolated_entity_count ? "health-warn" : "health-good"}>고립 후보 {health.isolated_entity_count}</span>
        <button type="button" disabled={!issueRelations.unsupported} className={health.unsupported_relation_count ? "health-warn" : "health-good"} onClick={() => focusIssueRelation(issueRelations.unsupported)}>근거 부족 {health.unsupported_relation_count}</button>
        <button type="button" disabled={!issueRelations.generic} className={health.generic_relation_count ? "health-warn" : "health-good"} onClick={() => focusIssueRelation(issueRelations.generic)}>미분류 관계 {health.generic_relation_count}</button>
        <button type="button" disabled={!issueRelations.conflict} className={health.conflicting_pair_count ? "health-danger" : "health-good"} onClick={() => focusIssueRelation(issueRelations.conflict)}>충돌 {health.conflicting_pair_count}</button>
        <button type="button" disabled={!issueRelations.changed} className={health.changed_relation_count ? "health-warn" : "health-good"} onClick={() => focusIssueRelation(issueRelations.changed)}>변화 {health.changed_relation_count}</button>
        <button type="button" disabled={!issueRelations.gap} className={health.gap_relation_count ? "health-warn" : "health-good"} onClick={() => focusIssueRelation(issueRelations.gap)}>중간 공백 {health.gap_relation_count}</button>
        <button type="button" disabled={!issueRelations.explicitBreak} className={health.explicit_break_count ? "health-danger" : "health-good"} onClick={() => focusIssueRelation(issueRelations.explicitBreak)}>명시적 단절 {health.explicit_break_count}</button>
        <button type="button" disabled={!issueRelations.dangling} className={health.dangling_relation_count ? "health-danger" : "health-good"} onClick={() => focusIssueRelation(issueRelations.dangling)}>끊긴 끝점 {health.dangling_relation_count}</button>
      </div>
    </div>
    </details>
    {components.length > 1 && <div className="network-components" aria-label="분리된 관계망 선택">
      <span className="network-components-label">분리된 관계망</span>
      {components.map((component, index) => {
        const anchor = component.anchorId;
        const anchorEntity = graph.entities.find((entity) => entity.id === anchor);
        const componentIssueCount = component.relationIds.filter((relationId) => issueRelationIds.has(relationId)).length;
        const active = focusedComponent?.anchorId === anchor;
        return <button type="button" key={`${anchor}-${index}`} className={active ? "active" : undefined} aria-pressed={active} onClick={() => {
          setFocusId(null);
          setFocusComponentAnchorId(anchor);
          callbacks.current.onSelectRelation?.(null);
          callbacks.current.onSelectEntity(anchorEntity ?? null);
        }}>
          <strong>망 {index + 1}</strong>
          <span>{component.entityIds.length}개 대상 · {component.relationIds.length}개 관계{componentIssueCount > 0 ? ` · 문제 ${componentIssueCount}` : ""}</span>
        </button>;
      })}
    </div>}
    <div className="network-heading"><div><span className="network-eyebrow">STORY CONNECTIONS</span><strong>{focusedComponent?`망 ${networkComponents.findIndex((component) => component.anchorId === focusComponentAnchorId) + 1} 전체` : focused?`${network.entities.find(e=>e.id===focusId)?.name}의 주변 관계`:'이야기의 연결'}</strong><span>{shown.entities.length}개 대상 · {shown.relations.length}개 관계 후보</span></div>
      <div className="network-heading-actions">
        <button className="map-focus-toggle" aria-pressed={mapFocus} onClick={()=>setMapFocus(value=>!value)}>{mapFocus?'필터와 제목 다시 보기':'지도 넓게 보기'}</button>
        <button className={issuesOnly ? 'active' : ''} aria-pressed={issuesOnly} onClick={()=>setIssuesOnly(value=>!value)}>{issuesOnly ? '전체 관계 보기' : '문제 관계만 강조'}</button>
        {(focused || focusedComponent)?<button onClick={()=>{setFocusId(null);setFocusComponentAnchorId(null);callbacks.current.onSelectEntity(null);callbacks.current.onSelectRelation?.(null);}}>관계망 전체로</button>:<button disabled={!selected || !network.entities.some(e=>e.id===selected.id)} onClick={()=>{setFocusComponentAnchorId(null);setFocusId(selectedEntityId);}}>선택 대상 주변만</button>}
      </div>
    </div>
    <details className="network-help"><summary>지도 읽는 법 · 관계선 범례</summary>
    <div className="network-source">{shown.relations.some(r=>r.origin==='gpt')?'GPT 추출 포함':'로컬 추출'} · 원문으로 확인할 후보입니다. 선을 누르면 아래에서 근거를 읽을 수 있습니다. 이름 옆의 색과 유형 문구로 대상을 구분합니다.{shown.relations.some(r=>r.type==='관계')&&' ‘유형 미분류’는 관계 의미가 분석되지 않은 연결입니다.'}{health.conflicting_pair_count>0&&' ‘충돌 후보’는 양립하기 어려운 술어가 함께 추출된 상태이며 시간 순서·예외는 원문에서 확인합니다.'}{shown.relations.length>14&&' 전체 후보는 아래 관계 목록에서 확인할 수 있습니다.'}</div>
    <div className="network-legend" aria-label="관계선 범례">
      <span><i className="legend-line confirmed"/>근거 확인</span>
      <span><i className="legend-line backbone"/>주요 연결</span>
      <span><i className="legend-line review"/>확인 필요</span>
      <span><i className="legend-line changed"/>회차 변화</span>
      <span><i className="legend-line gap"/>중간 공백 후보</span>
      <span><i className="legend-line broken"/>명시적 단절</span>
      <span><i className="legend-line conflict"/>충돌 후보</span>
      <span><i className="legend-line dangling"/>끊긴 끝점</span>
    </div>
    </details>
    <div className="network-viewport" onWheel={handleTrackpadZoom} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onLostPointerCapture={handlePointerUp} aria-label="관계 지도. 드래그로 이동하고 트랙패드 핀치 또는 확대·축소 버튼으로 크기를 조절할 수 있습니다.">
      <svg className="network-svg" role="group" aria-label="인물과 설정의 관계망" viewBox={svgViewBox} preserveAspectRatio="xMidYMid meet">
        <defs><marker id="story-guard-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--sg-edge)"/></marker></defs>
        <g className="network-svg-edges">
          {svgRelations.map(({ pairKey, members, representative: relation }) => {
            const source = positions.get(relation.source_entity_id); const target = positions.get(relation.target_entity_id);
            if (!source || !target) return null;
            const selected = members.some(member => member.id === selectedRelationId);
            const issue = issueRelationIds.has(relation.id) || members.some(member => issueRelationIds.has(member.id));
            const color = explicitBreakPairs.has(pairKey) || conflictingPairs.has(pairKey) ? 'var(--sg-danger)' : changedPairs.has(pairKey) || gapPairs.has(pairKey) ? 'var(--sg-warning)' : 'var(--sg-edge)';
            const marker = relation.type === '관계' || relation.type === '관련' ? undefined : 'url(#story-guard-arrow)';
            const dx = target.x - source.x; const dy = target.y - source.y; const length = Math.max(1, Math.hypot(dx, dy));
            const nx = -dy / length; const ny = dx / length; const curve = (((relation.id * 37) % 5) - 2) * 18;
            const cx = (source.x + target.x) / 2 + nx * curve; const cy = (source.y + target.y) / 2 + ny * curve;
            const selectRelation = () => { onSelectEntity(null); onSelectRelation?.(relation.id); };
            return <g key={`svg-edge-${pairKey}`} role="button" tabIndex={0} aria-label={`${entityName(relation.source_entity_id)} → ${entityName(relation.target_entity_id)} · ${relation.display_label || relation.type}`} aria-pressed={selected} className={selected ? 'svg-edge selected' : issue ? 'svg-edge issue' : 'svg-edge'} onClick={() => { if(consumeMapDrag())return; selectRelation(); }} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectRelation();}}}>
              <path className="edge-hit-area" d={`M ${source.x} ${source.y} Q ${cx} ${cy} ${target.x} ${target.y}`} fill="none" stroke="transparent" strokeWidth={18}/>
              <path className="edge-line" d={`M ${source.x} ${source.y} Q ${cx} ${cy} ${target.x} ${target.y}`} fill="none" stroke={selected ? 'var(--sg-accent)' : color} strokeWidth={selected ? 2.8 : issue ? 2 : 1.4} strokeDasharray={relation.is_weak ? '8 6' : undefined} markerEnd={marker}/>
              {(relation.display_label || relation.type) && <text x={cx} y={cy - 8} textAnchor="middle" className="svg-edge-label">{members.length > 1 ? `${relation.display_label || relation.type} · ${members.length}` : (relation.display_label || relation.type)}</text>}
            </g>;
          })}
        </g>
        <g className="network-svg-nodes">
          {canvasGraph.entities.map(entity => {
            const position = positions.get(entity.id); if (!position) return null;
            const degree = canvasGraph.relations.filter(relation => relation.source_entity_id === entity.id || relation.target_entity_id === entity.id).length;
            const visual = entityVisual(entity, degree, canvasGraph.entities.length); const selected = entity.id === selectedEntityId; const dangling = entity.name.startsWith('미확인 대상 #');
            const radius = Math.max(8, Math.min(18, visual.size * .2));
            const lines = entity.name.match(/.{1,10}/g) ?? [entity.name];
            const selectEntity = () => { onSelectRelation?.(null); onSelectEntity(dangling ? null : entity); };
            return <g key={`svg-node-${entity.id}`} role="button" tabIndex={0} aria-label={`${TYPE_NAMES[entity.type]} · ${entity.name}`} aria-pressed={selected} data-entity-type={entity.type} className={`svg-node ${selected ? 'selected' : ''} ${dangling ? 'dangling' : ''}`} transform={`translate(${position.x} ${position.y})`} onClick={() => { if(consumeMapDrag())return; selectEntity(); }} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectEntity();}}}>
              <title>{TYPE_NAMES[entity.type]} · {entity.name}</title>
              <rect className="node-hit-area" x={-70} y={-26} width={140} height={100} rx={20} fill="transparent"/>
              <circle className="node-focus-ring" r={radius+8} fill="none" stroke="currentColor" strokeWidth={5}/>
              <circle className="node-dot" r={radius} fill="currentColor" fillOpacity={visual.opacity}/>
              <text y={radius+25} textAnchor="middle" className="svg-node-label">{lines.slice(0, 2).map((line, index) => <tspan key={index} x="0" dy={index===0?0:21}>{line}{index===1&&lines.length>2?'…':''}</tspan>)}</text>
              <text y={radius+25+Math.min(lines.length,2)*21} textAnchor="middle" className="svg-node-type">{TYPE_NAMES[entity.type]}</text>
            </g>;
          })}
        </g>
      </svg>
      <div ref={containerRef} className="network-canvas" aria-hidden="true"/>
      {healthLevel !== "good" && (danglingRelations.length > 0 || unlinked.length > 0) && <div className={`network-alert ${healthLevel}`} role="status">
        <strong>{healthLevel === "danger" ? "확인이 필요한 연결이 있습니다" : "관계망을 점검해 보세요"}</strong>
        <span>{[
          health.conflicting_pair_count && `충돌 ${health.conflicting_pair_count}`,
          health.explicit_break_count && `명시적 단절 ${health.explicit_break_count}`,
          health.dangling_relation_count && `끊긴 끝점 ${health.dangling_relation_count}`,
          health.gap_relation_count && `중간 공백 ${health.gap_relation_count}`,
          health.isolated_entity_count && `고립 후보 ${health.isolated_entity_count}`,
          health.unsupported_relation_count && `근거 부족 ${health.unsupported_relation_count}`,
          health.generic_relation_count && `미분류 관계 ${health.generic_relation_count}`,
          health.changed_relation_count && `변화 ${health.changed_relation_count}`,
        ].filter(Boolean).join(" · ")}</span>
        {danglingRelations.length > 0 && <button type="button" onClick={() => setDanglingOpen(true)}>끊긴 관계 보기</button>}
        {unlinked.length > 0 && <button type="button" onClick={() => setCandidatesOpen(true)}>고립 후보 보기</button>}
      </div>}
      {!shown.entities.length&&<div className="network-empty"><strong>아직 연결된 관계가 없습니다</strong><p>현재 범위의 후보는 아래에서 확인할 수 있습니다.<br/>분석 결과에 관계가 있어야 연결선이 표시됩니다.</p></div>}
      {renderError&&<div className="network-empty" role="alert"><strong>관계 지도를 불러오지 못했습니다</strong><p>{renderError}</p><button onClick={()=>setRevision(v=>v+1)}>다시 시도</button></div>}
      <div className="network-tools"><button aria-label="축소" onClick={()=>changeZoom(.8)}><ZoomOut size={18}/></button><span>{zoom}%</span><button aria-label="확대" onClick={()=>changeZoom(1.25)}><ZoomIn size={18}/></button><button onClick={fit}><Maximize2 size={17}/> 화면에 맞춤</button><button title="자동 배치 다시 실행" aria-label="자동 배치 다시 실행" onClick={()=>setRevision(v=>v+1)}><RotateCcw size={17}/></button></div>
    </div>
    <div className="network-access"><label>대상 탐색<select aria-label="관계 대상 선택" value={selectedEntityId??''} onChange={e=>{callbacks.current.onSelectRelation?.(null);onSelectEntity(graph.entities.find(n=>n.id===Number(e.target.value))??null);}}><option value="">인물·설정 선택</option>{graph.entities.map(e=><option key={e.id} value={e.id}>{TYPE_NAMES[e.type]} · {e.name}</option>)}</select></label>
    {danglingRelations.length>0&&<button className="dangling-toggle" aria-expanded={danglingOpen} onClick={()=>setDanglingOpen(v=>!v)}>끊긴 관계 {danglingRelations.length}개 {danglingOpen?'접기':'보기'}</button>}
    {unlinked.length>0&&<button aria-expanded={candidatesOpen} onClick={()=>setCandidatesOpen(v=>!v)}>고립 후보 {unlinked.length}개 {candidatesOpen?'접기':'보기'}</button>}</div>
    {danglingOpen&&<div className="unlinked-candidates dangling-candidates"><p>끝점이 현재 작품 엔티티에 없습니다. 그래프 선으로 숨기지 않고 원인 확인 목록에 남겼습니다.</p><div>{danglingRelations.map(relation=><button className="dangling-row" key={relation.id} onClick={()=>{callbacks.current.onSelectEntity(null);callbacks.current.onSelectRelation?.(relation.id);}}><strong>{entityName(relation.source_entity_id)} → {entityName(relation.target_entity_id)}</strong><small>{relation.display_label || relation.type} · 원문 근거 {relation.evidence_chunk_ids.length ? '있음' : '없음'}</small></button>)}</div></div>}
    {candidatesOpen&&<div className="unlinked-candidates"><p>현재 필터에서 연결이 없는 추출 후보입니다. 이름·분류의 정확성은 원문 확인이 필요합니다.</p><div>{unlinked.map(e=><button key={e.id} className={e.id===selectedEntityId?'selected':''} onClick={()=>{callbacks.current.onSelectRelation?.(null);onSelectEntity(e);}}><small>{TYPE_NAMES[e.type]}</small>{e.name}</button>)}</div></div>}
  </div>;
}
