import { JudgmentActions } from "./JudgmentActions";
import { SourceText } from "./SourceText";
import { DocumentPicker } from "./DocumentPicker";
import { StorySettingForm } from "./StorySettingForm";
import { RelationStory } from "./RelationStory";
import { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, ScanLine, Network, Bookmark, Settings, Sparkles, ArrowRight } from 'lucide-react';
import type { Project, StoryDocument, StorySetting, GraphPayload, EvidenceChunk, IssueStatus, RelationEdge, EntityNode } from '../lib/types';
import { RelationEvidence } from './Inspector';
import { relationPairKey, relationTypesConflict, timelinePairsByStatus } from '../lib/relationshipHealth';
import { groupRelationshipEdges } from '../lib/relationshipGrouping';
export type Page = 'welcome' | 'setup' | 'projects' | 'manuscripts' | 'analysis' | 'review' | 'graph' | 'foreshadowing' | 'settings';
export const PAGES: Record<Page, [string,string]> = {
 welcome:['Story Guard','이야기의 흐름을 지키는, 작가의 두 번째 시선'], setup:['AI 연결·준비','서버의 GPT 연결을 확인하고 예시 작품을 살펴보세요.'],
 projects:['내 작품','이야기를 이어서 살펴보세요.'], manuscripts:['원고·설정','가져온 원고와 작품의 설정을 확인하세요.'], analysis:['분석','분석할 작품과 모델을 확인하세요.'],
 review:['검토 결과','AI가 제안한 검토 후보입니다. 원문을 읽고 직접 판단해 주세요.'], graph:['관계 지도','작품 속 인물, 아이템, 규칙, 사건의 관계를 한눈에 확인하세요.'],
 foreshadowing:['떡밥 후보','현재는 AI가 찾은 단서 후보만 보여줍니다.'], settings:['앱 설정','GPT 연결 상태와 분석 설정을 확인하세요.'],
};
const MENU = [['manuscripts',FileText],['analysis',ScanLine],['review',BookOpen],['graph',Network],['foreshadowing',Bookmark]] as const;
export function WorkbenchNav({page,onPage,project,projects,onProject}: {page:Page;onPage:(page:Page)=>void;project:Project|null;projects:Project[];onProject:(p:Project)=>void}) {
 return <aside className="workbench-nav"><button className="wordmark" onClick={()=>onPage('welcome')}>STORY GUARD</button>
 <label className="project-switch">현재 작품<select value={project?.id ?? ''} onChange={e=>{const p=projects.find(p=>p.id===Number(e.target.value));if(p)onProject(p);}}><option value="" disabled>작품 선택</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
 <nav aria-label="작품 메뉴">{MENU.map(([key,Icon])=><button key={key} aria-label={PAGES[key][0]} title={PAGES[key][0]} aria-current={page===key?'page':undefined} onClick={()=>onPage(key)}><Icon size={21}/>{PAGES[key][0]}</button>)}</nav>
 <nav className="nav-bottom" aria-label="앱 메뉴"><button aria-label="내 작품" title="내 작품" aria-current={page==='projects'?'page':undefined} onClick={()=>onPage('projects')}><BookOpen size={21}/>내 작품</button><button aria-label="앱 설정" title="앱 설정" aria-current={page==='settings'||page==='setup'?'page':undefined} onClick={()=>onPage('settings')}><Settings size={21}/>앱 설정</button></nav><small>원고는 이 기기에 저장됩니다.</small></aside>;
}
export function ProjectsPage({projects,onOpen,onCreate,readOnlyDemo=false}: {projects:Project[];onOpen:(p:Project)=>void;onCreate:()=>void;readOnlyDemo?:boolean}) {
 return <div className="page-content"><div className="section-heading"><div><h2>{readOnlyDemo ? '준비된 샘플' : '최근 작품'} <span className="count">{projects.length}</span></h2>{readOnlyDemo && <p className="muted">공개 데모에서는 준비된 샘플만 열 수 있습니다.</p>}</div>{!readOnlyDemo&&<button className="primary" onClick={onCreate}>+ 새 작품 만들기</button>}</div><div className="project-grid">{projects.map(p=><button className="project-card" key={p.id} onClick={()=>onOpen(p)}><BookOpen size={32}/><h2>{p.title}</h2><p>{p.document_count ?? 0}편 · {p.pending_document_count ? `재분석 필요 ${p.pending_document_count}편` : p.last_analyzed_at ? `최근 분석 ${formatProjectDate(p.last_analyzed_at)}` : '아직 분석하지 않음'}</p>{(p.open_issue_count ?? 0) > 0 && <span className="project-issue-count">확인 대기 {p.open_issue_count}개</span>}<span>작품 열기 <ArrowRight size={16}/></span></button>)}</div>{!projects.length&&<div className="blank-state">{readOnlyDemo ? '서버에 공개 샘플이 아직 준비되지 않았습니다.' : '첫 작품을 만들어 원고를 가져오세요.'}</div>}</div>;
}

function formatProjectDate(value: string) {
 const timestamp = Date.parse(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'));
 if (!Number.isFinite(timestamp)) return '최근 분석 완료';
 return new Intl.DateTimeFormat('ko-KR', {month:'numeric', day:'numeric'}).format(new Date(timestamp));
}
function SettingCard({setting,onUpdate,onDelete,readOnly=false}:{setting:StorySetting;onUpdate:(setting:StorySetting)=>Promise<boolean>;onDelete:(setting:StorySetting)=>void;readOnly?:boolean}) {
 const [editing,setEditing]=useState(false);
 if(editing&&!readOnly) return <article className="setting-card setting-edit"><StorySettingForm initial={setting} onCancel={()=>setEditing(false)} onSave={async values=>{const saved=await onUpdate({...setting,...values});if(saved)setEditing(false);return saved;}}/></article>;
 return <article className="setting-card"><div><strong>{setting.title}</strong><span className={`setting-certainty ${setting.certainty}`}>{setting.certainty==='confirmed'?'확정 설정':'구상 메모'}</span></div><p>{setting.content}</p>{!readOnly&&<div><button type="button" onClick={()=>setEditing(true)}>편집</button><button type="button" onClick={()=>onDelete(setting)}>삭제</button></div>}</article>;
}
export interface SourceNavigation { documentId: number; quote?: string; }
export function ManuscriptsPage({documents,settings,onImport,onDelete,onReplace,onAnalyze,onCreateSetting,onUpdateSetting,onDeleteSetting,loading,preferredDocumentId,sourceRequest,active=true,readOnlyDemo=false}: {documents:StoryDocument[];settings:StorySetting[];onImport:()=>void;onDelete:(d:StoryDocument)=>void;onReplace:(d:StoryDocument)=>void;onAnalyze:()=>void;onCreateSetting:(title:string,content:string,certainty:StorySetting['certainty'])=>Promise<boolean>;onUpdateSetting:(setting:StorySetting)=>Promise<boolean>;onDeleteSetting:(setting:StorySetting)=>void;loading:boolean;preferredDocumentId?:number;sourceRequest?:SourceNavigation;active?:boolean;readOnlyDemo?:boolean}) {
 const [selection,setSelection]=useState<SourceNavigation>();
 const readerRef=useRef<HTMLElement>(null);
 const listRef=useRef<HTMLElement>(null);
 const consumedRequest=useRef<SourceNavigation>();
 useEffect(()=>{if(preferredDocumentId!==undefined)setSelection({documentId:preferredDocumentId});},[preferredDocumentId]);
 useEffect(()=>{
  if(active && sourceRequest && consumedRequest.current!==sourceRequest && documents.some(d=>d.id===sourceRequest.documentId)){
   consumedRequest.current=sourceRequest;setSelection(sourceRequest);
  }
 },[sourceRequest,active,documents]);
 const doc=documents.find(d=>d.id===selection?.documentId)??documents[0];
 useEffect(()=>{
  if(!active || !selection || doc?.id!==selection.documentId)return;
  const frame=requestAnimationFrame(()=>{
   const reader=readerRef.current;
   const target=reader?.querySelector<HTMLElement>('.source-highlight')??reader?.querySelector<HTMLElement>('h2');
   target?.focus({preventScroll:true});
   target?.scrollIntoView({block:'center',behavior:'auto'});
  });
  return ()=>cancelAnimationFrame(frame);
 },[selection,active,doc?.id]);
 return <div className="manuscript-layout">
  <section className="surface" ref={listRef}>
   <div className="section-heading"><div><h2>원고 <span className="count">{documents.length}</span></h2>{readOnlyDemo&&<p className="muted">준비된 샘플 · 읽기 전용</p>}</div><div className="section-actions">{!readOnlyDemo&&<button onClick={onImport} disabled={loading}>+ 여러 원고 가져오기</button>}{documents.length > 0 && <button className="primary" onClick={onAnalyze}>분석 설정으로 이동</button>}</div></div>
   <DocumentPicker documents={documents} selectedId={doc?.id} revealKey={consumedRequest.current} onSelect={documentId=>setSelection({documentId})}/>

   <hr/><div className="section-heading setting-heading"><div><h3>설정 메모</h3><p className="muted">확정 설정만 충돌 판정의 기준으로 사용합니다. 구상 메모는 참고 후보로 남깁니다.</p></div></div>
   {!readOnlyDemo&&<StorySettingForm disabled={loading} onSave={({title,content,certainty})=>onCreateSetting(title,content,certainty)}/>}

   {settings.map(setting=><SettingCard key={setting.id} setting={setting} onUpdate={onUpdateSetting} onDelete={onDeleteSetting} readOnly={readOnlyDemo}/>) }
  </section>
  <section className="surface manuscript-reader" ref={readerRef}>{doc?<><div className="section-heading"><div><span className="eyebrow">{readOnlyDemo?'준비된 샘플':'가져온 원고'} · 읽기 전용</span><h2 tabIndex={-1}>{doc.chapter_index+1}화 · {doc.title}</h2></div><div><button onClick={()=>{listRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();}}>원고 목록으로</button>{!readOnlyDemo&&<> <button onClick={()=>onReplace(doc)} disabled={loading}>수정본으로 교체</button> <button onClick={()=>onDelete(doc)} disabled={loading}>원고 삭제</button></>}</div></div><SourceText text={doc.content} quote={selection?.documentId===doc.id?selection.quote:undefined}/></>:<div className="blank-state"><FileText size={40}/><h2>{readOnlyDemo?'샘플 원고가 없습니다.':'원고를 가져오세요'}</h2>{!readOnlyDemo&&<><p>TXT, Markdown, DOCX 파일을 읽을 수 있습니다.</p><button onClick={onImport}>파일 가져오기</button></>}</div>}</section>
 </div>;
}
function ReviewEmptyState({showReviewed,openCount,reviewedCount,documents,onSwitch,onAnalysis}:{showReviewed:boolean;openCount:number;reviewedCount:number;documents:StoryDocument[];onSwitch:()=>void;onAnalysis:()=>void}) {
 const pending=documents.filter(doc=>doc.analysis_status!=='analyzed').length;
 let title:string, description:string, action:string;
 let onAction=onAnalysis;
 if(showReviewed && openCount>0){
  title='아직 판단을 남긴 후보가 없습니다.';
  description=`확인 대기 후보 ${openCount}개가 있습니다. 원문 근거를 읽고 판단을 남기면 이곳에 모입니다.`;
  action='확인 대기 후보 보기';onAction=onSwitch;
 }else if(!showReviewed && reviewedCount>0){
  title='확인 대기 후보를 모두 검토했습니다.';
  description=`작가 판단에 ${reviewedCount}개 후보가 있습니다. 판단 보류도 포함되며, 문제 해결을 뜻하지는 않습니다.`;
  action='작가 판단 보기';onAction=onSwitch;
 }else if(!documents.length){
  title='아직 가져온 원고가 없습니다.';description='원고를 가져오고 분석하면 검토 후보와 원문 근거를 확인할 수 있습니다.';action='원고·설정으로 이동';
 }else if(pending){
  title='분석이 필요한 원고가 있습니다.';description=`전체 ${documents.length}편 중 ${pending}편이 신규 또는 수정된 원고입니다. 분석 화면에서 진행 상태와 실패 내역을 확인하세요.`;action='분석 설정으로 이동';
 }else{
  title='현재 저장된 검토 후보가 없습니다.';description='후보가 없다고 설정 오류가 없다는 뜻은 아닙니다. 분석 화면에서 완료 여부와 실패 내역을 먼저 확인하세요.';action='분석 상태 확인';
 }
 return <div className="blank-state"><BookOpen size={32}/><h3>{title}</h3><p>{description}</p><button className="primary" onClick={onAction}>{action}</button></div>;
}

export function ReviewPage({graph,evidence,documents,onStatus,onGraph,onOpenDocument,onAnalysis,history,readOnlyDemo=false}: {history:import("../lib/types").ReviewHistory[];graph:GraphPayload;evidence:Record<number,EvidenceChunk[]>;documents:StoryDocument[];onStatus:(id:number,s:IssueStatus)=>Promise<boolean> | void;onGraph:(relationId?:number)=>void;onOpenDocument:(id:number,quote?:string)=>void;onAnalysis:()=>void;readOnlyDemo?:boolean}) {
 const [id,setId]=useState<number>();const [showReviewed,setShowReviewed]=useState(false);
 const issues=graph.issues.filter(i=>showReviewed?i.status!=='open':i.status==='open');const selected=issues.find(i=>i.id===id)??issues[0];
 const focusRelation = selected && (evidence[selected.id] ?? []).length ? graph.relations.find(r => r.evidence_chunk_ids.some(chunkId => (evidence[selected.id] ?? []).some(chunk => chunk.id === chunkId))) : undefined;
 return <>
  <details className="revision-history surface"><summary>이전 검토 이력 · {history.length}개</summary><p className="muted">미재검출은 문제가 해소되었다는 확정이 아닙니다. 원문 근거가 달라진 후보는 새 후보로 표시하며, 동일 원문 근거가 다시 검출되면 이전 작가 판단을 유지합니다.</p>{history.map(item=><article className="source-card" key={item.id}><span className="badge">{{pending:'재분석 대기',redetected:'동일 근거 재검출',not_redetected:'이번 분석에서 미재검출'}[item.outcome]}</span><h3>{item.title}</h3><p>당시 판단: {{open:'확인 대기',accepted:'문제 있음',ignored:'문제 아님',deferred:'판단 보류'}[item.status]}</p><p>{item.description}</p><details><summary>수정 전 원문 근거</summary>{item.evidence.map(c=><blockquote key={c.id}><small>{c.chapter_index+1}화 · {c.title}</small><p>{c.text}</p><button className="text-action" onClick={()=>onOpenDocument(c.document_id,c.text)}>이 회차 원고 열기</button></blockquote>)}</details></article>)}</details>
  <div className="review-tabs"><button className={!showReviewed?'selected':''} onClick={()=>setShowReviewed(false)}>확인 대기 <b>{graph.issues.filter(i=>i.status==='open').length}</b></button><button className={showReviewed?'selected':''} onClick={()=>setShowReviewed(true)}>작가 판단 <b>{graph.issues.filter(i=>i.status!=='open').length}</b></button></div>
  <div className={`review-layout${issues.length ? "" : " review-empty"}`}><section className="surface candidate-list"><h2>검토 후보</h2>{issues.map(i=><button key={i.id} className={selected?.id===i.id?'selected':''} onClick={()=>setId(i.id)}><strong>{i.title}</strong><small>{i.description}</small></button>)}{!issues.length&&<ReviewEmptyState showReviewed={showReviewed} openCount={graph.issues.filter(i=>i.status==='open').length} reviewedCount={graph.issues.filter(i=>i.status!=='open').length} documents={documents} onSwitch={()=>setShowReviewed(!showReviewed)} onAnalysis={onAnalysis}/>}</section>
  <section className="surface review-detail">{selected?<><span className="badge">AI 검토 후보</span><h2>{selected.title}</h2><p>{selected.description}</p><div className="soft-card"><h3>판단 전에 확인해 주세요</h3><p>원문의 시점과 사용 조건, 다른 회차에서 설명된 예외가 있는지 확인해 주세요. AI의 후보가 곧 설정 오류를 의미하지는 않습니다.</p></div><button className="link-card" onClick={()=>onGraph(focusRelation?.id)}><Network size={20}/>관계 지도에서 보기 <ArrowRight size={18}/></button>{readOnlyDemo?<p className="muted">공개 샘플에서는 작가 판단을 저장하지 않습니다.</p>:<JudgmentActions key={selected.id} issue={selected} onSave={onStatus}/>}</>:null}</section>
  <aside className="surface evidence-column"><h2>원문 근거</h2>{selected&&(evidence[selected.id]??[]).map(c=>{const doc=documents.find(d=>d.id===c.document_id);return <div className="source-card" key={c.id}><h3><FileText size={18}/>{doc?`${doc.chapter_index+1}화 · ${doc.title}`:'원문'}</h3><blockquote>{c.text}</blockquote><button className="text-action" onClick={()=>onOpenDocument(c.document_id,c.text)}>이 회차 원고 열기</button><button className="text-action" onClick={()=>onGraph(focusRelation?.id)}>이 근거의 관계 보기</button></div>;})}{selected&&!(evidence[selected.id]?.length)&&<p>원문 근거를 불러오는 중입니다.</p>}</aside></div>
 </>;
}
export function GraphDetails({graph,entity,relationId,onRelation,onReview,onOpenDocument,documents=[]}: {graph:GraphPayload;entity:EntityNode|null;relationId:number|null;onRelation:(id:number)=>void;onReview:()=>void;onOpenDocument:(id:number,quote?:string)=>void;documents?:StoryDocument[]}) {
 const edges=entity?graph.relations.filter(r=>r.source_entity_id===entity.id||r.target_entity_id===entity.id):graph.relations;
 const groupedEdges = groupRelationshipEdges(edges);
 const issuePairs = new Set((graph.timeline ?? [])
  .filter(item => item.status === 'explicit_break' || item.status === 'changed' || item.status === 'gap' || item.gap_before)
  .map(item => relationPairKey(item.source_entity_id, item.target_entity_id)));
 const groupedEdgesForDisplay = [...groupedEdges].sort((left, right) => {
  const priority = (candidate: RelationEdge) => {
   const pair = relationPairKey(candidate.source_entity_id, candidate.target_entity_id);
   const relationTypes = new Set(graph.relations.filter(item => relationPairKey(item.source_entity_id, item.target_entity_id) === pair).map(item => item.type));
   return (relationTypesConflict(relationTypes) ? 100 : 0) + (issuePairs.has(pair) ? 40 : 0) + (!candidate.evidence_chunk_ids.length && !candidate.claims?.length ? 20 : 0) + (candidate.is_weak ? 10 : 0);
  };
  return priority(right.representative) - priority(left.representative) || right.evidenceCount - left.evidenceCount || left.representative.id - right.representative.id;
 });
 const edge=edges.find(r=>r.id===relationId); const names=new Map(graph.entities.map(e=>[e.id,e.name])); const entityName=(id:number)=>names.get(id) ?? `알 수 없는 대상 #${id}`;
 const pairEdges = edge ? graph.relations.filter(r => new Set([r.source_entity_id, r.target_entity_id]).size === 2 && [r.source_entity_id, r.target_entity_id].every(id => [edge.source_entity_id, edge.target_entity_id].includes(id))) : [];
 const edgePairTypes = edge ? new Set(graph.relations.filter(r=>new Set([r.source_entity_id,r.target_entity_id]).size===2 && [r.source_entity_id,r.target_entity_id].every(id=>[edge.source_entity_id,edge.target_entity_id].includes(id))).map(r=>r.type)) : new Set<string>();
 const edgeStatus = edge ? (relationTypesConflict(edgePairTypes) ? '충돌 후보' : edge.type==='관계' || edge.type==='관련' ? '유형 미분류' : !edge.evidence_chunk_ids.length && !edge.claims?.length ? '근거 부족' : edge.claims?.some(c=>c.basis==='inferred') ? '추론 관계' : '근거 확인') : '';
 const edgeTimeline = edge ? (graph.timeline ?? []).filter(item => { const pair=[item.source_entity_id,item.target_entity_id].sort((a,b)=>a-b).join(':'); const edgePair=[edge.source_entity_id,edge.target_entity_id].sort((a,b)=>a-b).join(':'); return pair===edgePair; }) : [];
 const timelineHasGap = edge ? timelinePairsByStatus(graph, 'gap').has(relationPairKey(edge.source_entity_id, edge.target_entity_id)) : false;
 return <aside className="surface graph-details" tabIndex={0} aria-label="관계 설명과 원문 근거, 스크롤 가능"><span className="network-eyebrow">EVIDENCE & CONTEXT</span><h2>{entity?entity.name:edge?'관계의 근거':'관계 탐색'}</h2>
 {entity&&<><span className="badge">추출 후보 · 연결 {edges.length}개</span>{entity.summary&&<p>{entity.summary}</p>}<p className="muted">{entity.document_count}개 회차에서 언급됨</p>{!edges.length&&<div className="soft-card"><h3>연결이 확인되지 않은 후보</h3><p>현재 표시 범위에 관계가 없습니다. 잘못 추출된 이름이나 분류일 수도 있으므로 원문을 확인하세요.</p>{entity.document_ids.map(id=><button className="text-action" key={id} onClick={()=>onOpenDocument(id)}>{documents.find(d=>d.id===id)?.title??'원문'} 열기</button>)}</div>}</>}
 {!edge&&edges.length>0&&<><p className="muted">{entity?'확인할 관계를 선택하세요.':'선을 선택하면 관계의 의미와 원문이 이곳에 표시됩니다.'} 같은 대상·같은 의미의 후보는 묶어서 표시합니다.</p><div className="relationship-list">{groupedEdgesForDisplay.map(({representative:r,count,evidenceCount,claimCount,origins})=><button key={r.id} onClick={()=>onRelation(r.id)}><span>{entityName(r.source_entity_id)} → {entityName(r.target_entity_id)}</span><strong>{r.type==='관계'?'유형 미분류':(r.display_label||r.type)}{count>1&&<em className="relation-count">후보 {count}개</em>}</strong><span className="relationship-summary">{r.claims?.[0]?.explanation || '관계 설명을 원문 근거에서 확인하세요.'}</span><small>{origins.size>1?'로컬·GPT':' ' + (r.origin==='gpt'?'GPT':'로컬')} 추출 · 근거 {evidenceCount}개{claimCount?` · 주장 ${claimCount}개`:''}</small></button>)}</div></>}
 {edge&&<><button className="text-action" onClick={()=>onRelation(-1)}>← 관계 목록</button><div className="soft-card"><span className="badge">{edge.origin==='gpt'?'GPT':'로컬'} 추출 후보</span><span className={`relation-status ${edgeStatus==='충돌 후보'?'danger':edgeStatus==='근거 확인'?'good':'warn'}`}>{edgeStatus}</span><h3>{entityName(edge.source_entity_id)} → {entityName(edge.target_entity_id)}</h3><p className="relation-predicate">{edge.type==='관계'?'유형 미분류':edge.type}</p><span className="muted">원문 근거 {edge.evidence_chunk_ids.length}개 구간 · 같은 쌍 후보 {pairEdges.length}개</span></div>{pairEdges.length>1&&<div className="relation-timeline relation-candidates"><h3>같은 대상의 다른 관계 후보</h3><p className="muted">한 쌍에 여러 시점·모델의 주장이 있습니다. 각각의 근거를 비교해 작가가 판단하세요.</p>{pairEdges.map(candidate=><button className={candidate.id===edge.id?'selected':''} key={candidate.id} onClick={()=>onRelation(candidate.id)}><strong>{candidate.type==='관계'?'유형 미분류':(candidate.display_label||candidate.type)}</strong><span>{candidate.origin==='gpt'?'GPT':'로컬'} · 근거 {candidate.evidence_chunk_ids.length}개{candidate.claims?.length?` · 주장 ${candidate.claims.length}개`:''}</span></button>)}</div>}{edgeTimeline.length>0&&<div className="relation-timeline"><h3>회차별 관찰</h3>{edgeTimeline.map(item=><div key={`${item.document_id}-${item.relation_type}`}><span>{item.chapter_index+1}화</span><strong>{item.relation_type}</strong>{item.status==='changed'&&<em>변화</em>}{item.status==='gap'&&<em>중간 공백</em>}{item.status==='explicit_break'&&<em className="danger-text">명시적 단절</em>}</div>)}{timelineHasGap&&<p className="muted timeline-note">중간 회차에 관계가 언급되지 않은 후보입니다. 단절 확정이 아니라 원문 확인 대상으로 표시합니다.</p>}</div>}<RelationStory edge={edge} graph={graph} documents={documents} onOpenDocument={onOpenDocument}/><h3><FileText size={18}/> 전체 근거 구간</h3><RelationEvidence key={edge.id} relationId={edge.id} expanded onOpenDocument={onOpenDocument} documents={documents}/><p className="muted">시점이 다른 관계도 함께 표시됩니다. 원문을 확인해 판단해 주세요.</p><button className="primary" onClick={onReview}>검토 결과로 이동 <ArrowRight size={18}/></button></>}
 {!edges.length&&!entity&&<div className="blank-state"><Network size={36}/><p>표시할 관계가 없습니다. 회차·유형 필터와 분석 상태를 확인하세요.</p></div>}</aside>;
}
