import {Draft,validatePlan,interpretAmendment,scopeInput} from '../shared/assistant.ts';
import {requireModel} from './model.mjs';
import {HttpError} from './policy.mjs';
import {modelContext,inferPlan,authorizePlan,checkRevisions,savePlan} from './plans.mjs';
import {prepareUnderstanding} from './understanding.mjs';

const immutableShape=p=>p.steps.map(s=>({id:s.id,intent:s.operation.intent,dependsOn:s.dependsOn,studentRef:s.studentRef,venueRef:s.venueRef}));
export function checkReviewedShape(base,reviewed){
 if(JSON.stringify(immutableShape(base))!==JSON.stringify(immutableShape(reviewed)))throw new HttpError(400,'这份草稿的步骤已变化，请关闭后重新生成。','TASK_SHAPE_CHANGED');
 return reviewed;
}
export function clarificationPlan(question){
 const operation=Object.fromEntries(Object.keys(Draft.shape).map(k=>[k,null]));
 Object.assign(operation,{intent:'clarification',title:'先确认一下',explanation:question});
 return {title:'先确认一下',explanation:question,steps:[{id:'s1',dependsOn:[],studentRef:null,venueRef:null,operation}]};
}
export function understandingHint(meta){
 const request=meta.studentBookingRequest,core={resolved:meta.resolved||{},tasks:meta.tasks||[],...(request?{studentBookingRequest:{kind:request.kind,coachName:request.coachName,basis:request.basis,requiresConfirmation:request.requiresConfirmation}}:{})},withMatches={...core,matches:Object.fromEntries(Object.entries(meta.matches||{}).map(([kind,rows])=>[kind,rows.slice(0,12)]))};
 const json=JSON.stringify(withMatches);return json.length<=6000?json:JSON.stringify(core);
}
export function applyResolution(saved,resolution,context){
 const previous={...(saved.selection||{})};
 if(!resolution)return previous;
 const pending=saved.clarification;
 if(!pending||pending.field!==resolution.field||!pending.choices.some(c=>c.id===resolution.id))throw new HttpError(400,'这个选项不属于当前问题，请重新选择。','INVALID_RESOLUTION');
 const [list,key]={selectedStudent:['students','selectedStudent'],selectedLesson:['lessons','selectedLesson'],venueId:['venues','venueId'],messageId:['messages','messageId']}[resolution.field]||[];
 if(!list||!context[list].some(row=>row.id===resolution.id))throw new HttpError(409,'这个选项已不可用，请重新生成。','STALE_PLAN');
 previous[key]=resolution.id;return previous;
}
export async function generationSnapshot(c,member,identity,w,request){
 let prior=null,state=null;
 if(request.taskId){
  prior=(await c.query('SELECT * FROM app.plans WHERE workspace_id=$1 AND id=$2 AND actor_id=$3',[w,request.taskId,identity.id])).rows[0];
  if(!prior||!prior.plan.understanding)throw new HttpError(404,'找不到这份草稿，请重新生成。','TASK_NOT_FOUND');
  state=prior.plan.understanding;
  if(prior.status!=='pending'||prior.submission_open||!Number.isFinite(Date.parse(prior.expires_at))||Date.parse(prior.expires_at)<=Date.now()||!Number.isFinite(Date.parse(state.expiresAt))||Date.parse(state.expiresAt)<=Date.now()||prior.membership_revision!==member.revision)throw new HttpError(409,'草稿或权限已变化，请重新生成。','STALE_PLAN');
  if(state.turn>=12)throw new HttpError(400,'这份草稿已调整多次，请核对表单或重新描述。','TASK_TURN_LIMIT');
  await checkRevisions(c,w,prior.plan.steps,prior.plan.revisions);
 }
 const selected=state?.selection||request.selection||{};
 const context=await modelContext(c,member,identity,w,request.text,selected);
 const previous=applyResolution(state||{selection:selected},request.resolution,context.input.context);
 if(request.resolution&&['selectedStudent','selectedLesson','messageId'].includes(request.resolution.field))context.input.context[request.resolution.field]=request.resolution.id;
 if(request.resolution?.field==='selectedStudent')previous.explicitStudentChoice=request.resolution.id;
 if(request.resolution&&!state)throw new HttpError(400,'请先生成草稿。','INVALID_RESOLUTION');
 const originalText=state?.originalText||request.text;
 let base=prior?.plan.steps||null;
 if(request.reviewedPlan){
  const reviewed=validatePlan(request.reviewedPlan,context.input);authorizePlan(member,reviewed);
  if(base)checkReviewedShape(base,reviewed);
  base=reviewed;
 }
 // An unresolved first turn retains the original request. Once a business draft
 // exists, every following utterance is a sparse amendment, never a new plan.
 const unresolved=base?.steps.every(s=>s.operation.intent==='clarification');
 const text=state&&unresolved&&!request.resolution?`${originalText}\n补充：${request.text}`:state&&unresolved?originalText:request.text;
 if(text.length>1600)throw new HttpError(413,'补充后的描述过长，请缩短后重试。','CONTEXT_LIMIT');
 const prepared=prepareUnderstanding({...context.input,text},{text,previous});
 // An amendment edits the existing business draft. Words such as “练习内容”
 // describe a booking field here, not a new practice/venue task. Keep entity
 // resolution, but anchor task hints to the authoritative unchanged intents.
 if(base&&!unresolved)prepared.meta.tasks=[...new Set(base.steps.map(s=>s.operation.intent))];
 // For amendments retain every authorized record needed by the existing draft.
 // Validation after merge still checks all IDs and permissions independently.
 const input=base&&!unresolved?context.input:prepared.input;
 input.context.understanding=understandingHint(prepared.meta);
 const task={originalText,selection:{...selected,...previous,...(prepared.meta.resolved?.studentId?{selectedStudent:prepared.meta.resolved.studentId}:{selectedStudent:null})},turn:(state?.turn||0)+1,expiresAt:state?.expiresAt||new Date(Date.now()+900000).toISOString(),clarification:prepared.clarification||null};
 return {...context,input:scopeInput(input),base:unresolved?null:base,clarification:base&&!unresolved?null:prepared.clarification,task,meta:prepared.meta,revision:member.revision};
}
function bindExplicitVenue(plan,snapshot){
 const resolved=snapshot.meta?.resolved;
 if(snapshot.base||resolved?.venueBasis!=='explicit-choice'||!resolved.historyStudentId)return plan;
 // This choice has already passed applyResolution and RLS-visible candidate
 // validation. It is user input, not a historical inference a model may veto.
 const {historyStudentId:studentId,venueId}=resolved,c=snapshot.input.context;
 const student=c.students.find(row=>row.id===studentId),venue=c.venues.find(row=>row.id===venueId);
 const targets=plan.steps.filter(step=>step.operation.intent==='booking'&&step.operation.studentId===studentId);
 if(!student||!venue||snapshot.task?.selection?.venueId!==venueId||c.role==='student'&&c.selfStudentId!==studentId||targets.length!==1||targets[0].venueRef||targets[0].studentRef)
  throw new HttpError(422,'你选择的场地尚未对应到唯一课程，原有资料没有修改。请核对预约对象和步骤。','INVALID_RESOLUTION');
 const next=structuredClone(plan),target=next.steps.find(step=>step.id===targets[0].id);
 target.operation.venueId=venueId;
 target.operation.explanation=`场地已按你的选择设为「${venue.name}」。请核对日期、开始时间和时长后确认。`;
 next.explanation=`已按你的选择确定${student.name}这次预约的场地为「${venue.name}」。请一并核对各项操作，确认前不会执行。`;
 return validatePlan(next,snapshot.input);
}
export async function generateResponse(snapshot){
 if(snapshot.clarification)return {plan:clarificationPlan(snapshot.clarification.question),meta:{understanding:{...snapshot.meta,clarification:snapshot.clarification}}};
 let response;
 if(snapshot.base){
  const {key,runtime}=requireModel();
  response=await interpretAmendment(snapshot.input,snapshot.base,key,fetch,undefined,runtime);
 }else response=await inferPlan(snapshot.input);
 return {...response,plan:bindExplicitVenue(response.plan,snapshot),meta:{...response.meta,understanding:{...snapshot.meta,clarification:null}}};
}
export async function saveGeneration(c,member,identity,w,request,snapshot,response){
 if(member.revision!==snapshot.revision)throw new HttpError(409,'权限已变化，请重新生成。','STALE_PLAN');
 if(request.taskId){const prior=(await c.query('SELECT status,submission_open,expires_at FROM app.plans WHERE workspace_id=$1 AND id=$2 AND actor_id=$3',[w,request.taskId,identity.id])).rows[0];if(!prior||prior.status!=='pending'||prior.submission_open||Date.parse(prior.expires_at)<=Date.now()||Date.parse(snapshot.task.expiresAt)<=Date.now())throw new HttpError(409,'原草稿已变化，请重新生成。','STALE_PLAN');}
 const fresh=await modelContext(c,member,identity,w,request.text,snapshot.task.selection);
 validatePlan(response.plan,fresh.input);
 for(const step of response.plan.steps)for(const key of ['studentId','venueId','lessonId','messageId','ruleId','practiceId','followupId']){const id=step.operation[key];if(id&&snapshot.revisions[id]!==fresh.revisions[id])throw new HttpError(409,'资料已变化，请重新生成。','STALE_PLAN');}
 const saved=await savePlan(c,member,identity,w,response.plan,fresh.revisions,false,snapshot.task);
 return {...saved,meta:response.meta};
}
