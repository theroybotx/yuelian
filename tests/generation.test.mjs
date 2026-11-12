import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Draft,scopeInput,validatePlan} from '../lib/assistant.ts';
import {checkReviewedShape,clarificationPlan,understandingHint,applyResolution,generationSnapshot,generateResponse,saveGeneration} from '../server/src/generation.mjs';
import {commitPlan,today} from '../server/src/plans.mjs';

const identity={id:'account-owner',name:'测试教练',requestId:'request-test'},workspace='scope-a';
const member={role:'owner',active:true,permissions:[],revision:4};
const row=(id,kind,payload,extra={})=>({id,kind,payload,revision:1,student_id:null,lesson_id:null,venue_id:null,visibility:'shared',...extra});
const records=()=>[
 row('lin','student',{name:'小林',goal:'正手',next:'转肩'}),row('yu','student',{name:'小宇',goal:'发球',next:'抛球'}),
 row('riverside','venue',{name:'滨江',address:'滨江路',court:'1号',indoor:false}),row('hong','venue',{name:'弘金地',address:'金地路',court:'2号',indoor:false}),
 row('lesson','lesson',{date:'2026-10-01',start:900,duration:60,state:'confirmed',topic:'原训练'}, {student_id:'lin',venue_id:'riverside'}),
 row('participant','participant',{}, {student_id:'lin',lesson_id:'lesson'}),
 row('message','message',{kind:'booking',state:'pending',title:'预约',text:'请确认'}, {student_id:'lin',lesson_id:'lesson'}),
 row('settings','settings',{days:['一','二','三','四','五','六','日'],start:'08:00',end:'21:00',travel:0}),
 row('credit','ledger',{delta:9,label:'购课'},{student_id:'lin'}),
];
const operation=(overrides={})=>Draft.parse({...Object.fromEntries(Object.keys(Draft.shape).map(key=>[key,null])),intent:'booking',title:'核对课程',explanation:'请核对',studentId:'lin',venueId:'riverside',date:'2026-12-01',start:'15:00',duration:60,note:'连续正手 30 球\n  保留两个空格',...overrides});
const plan=(ops=[operation()])=>({title:'核对清单',explanation:'确认后执行',steps:ops.map((op,index)=>({id:`s${index+1}`,dependsOn:[],studentRef:null,venueRef:null,operation:op}))});
const task=(overrides={})=>({originalText:'给小林约明天下午三点一小时',selection:{selectedStudent:'lin'},turn:1,expiresAt:new Date(Date.now()+600000).toISOString(),clarification:null,...overrides});
const prior=(overrides={})=>({id:'saved-task',workspace_id:workspace,actor_id:identity.id,status:'pending',submission_open:false,membership_revision:4,expires_at:new Date(Date.now()+600000).toISOString(),plan:{steps:plan(),revisions:Object.fromEntries(records().map(row=>[row.id,row.revision])),understanding:task()},...overrides});
function client({saved=prior(),rows=records()}={}){
 const calls=[];return {calls,async query(sql,params){
  calls.push({sql,params});
  if(sql==='SELECT name FROM app.workspaces WHERE id=$1')return {rows:params[0]===workspace?[{name:'测试教练的网球课'}]:[]};
  if(sql.startsWith('SELECT * FROM app.plans')||sql.startsWith('SELECT status,submission_open,expires_at FROM app.plans'))return {rows:saved&&params[0]===saved.workspace_id&&params[1]===saved.id&&params[2]===saved.actor_id?[saved]:[]};
  if(sql.startsWith('SELECT * FROM app.records WHERE workspace_id=$1 AND id=$2'))return {rows:params[0]===workspace?rows.filter(row=>row.id===params[1]):[]};
  if(sql.startsWith('SELECT * FROM app.records WHERE workspace_id=$1 ORDER BY'))return {rows:params[0]===workspace?rows:[]};
  if(sql.startsWith('SELECT id,revision FROM app.records'))return {rows:rows.filter(row=>row.kind==='settings').map(({id,revision})=>({id,revision}))};
  if(sql.startsWith('INSERT INTO app.plans')||sql.startsWith('INSERT INTO app.audit'))return {rows:[],rowCount:1};
  throw Error(`Unexpected query: ${sql}`);
 }};
}
const snapshot=(options={},request={text:'改成90分钟',selection:{},taskId:'saved-task'},actor=identity,scope=workspace,m=member)=>generationSnapshot(client(options),m,actor,scope,request);

test('GEN-01 reviewed form can change values but keeps step identities, action types and graph',()=>{
 const base=plan([operation({intent:'add-venue',name:'新场地',venueId:null}),operation({venueId:null})]);base.steps[1].venueRef='s1';base.steps[1].dependsOn=['s1'];
 const edited=structuredClone(base);edited.steps[0].operation.address='新地址';edited.steps[1].operation.note='用户手工修改  原文';
 assert.equal(checkReviewedShape(base,edited),edited);assert.equal(base.steps[0].operation.address,null);
 for(const mutate of [p=>p.steps[1].id='other',p=>p.steps[1].operation.intent='credit',p=>p.steps[1].dependsOn=[],p=>p.steps[1].venueRef=null,p=>p.steps.reverse(),p=>p.steps.pop(),p=>p.steps.push(structuredClone(p.steps[0]))]){
  const invalid=structuredClone(base);mutate(invalid);assert.throws(()=>checkReviewedShape(base,invalid),{code:'TASK_SHAPE_CHANGED',status:400});
 }
});
test('GEN-02 clarification plan is valid, non-executable and contains only the precise question',()=>{
 const question='有两个小林，指哪一位？',p=clarificationPlan(question);
 assert.equal(p.steps.length,1);assert.equal(p.steps[0].operation.intent,'clarification');assert.equal(p.steps[0].operation.explanation,question);
 for(const [key,value] of Object.entries(p.steps[0].operation))if(!['intent','title','explanation'].includes(key))assert.equal(value,null,key);
 assert.deepEqual(p.steps[0].dependsOn,[]);
});
test('GEN-03 understanding hint is complete bounded JSON even with maximum candidate names',()=>{
 const meta={resolved:{studentId:'lin',studentBasis:'explicit-name',venueId:'hong',venueBasis:'latest-completed-lesson',sourceLessonId:'last'},matches:{students:Array.from({length:300},(_,i)=>({id:`student-${i}`,name:'二十字姓名用于判断上下文最大边界和截断行为'})),venues:[]},tasks:['booking','credit'],private:'never-copy'};
 const value=understandingHint(meta);assert.ok(value.length<=6000);const parsed=JSON.parse(value);assert.deepEqual(parsed.resolved,meta.resolved);assert.deepEqual(parsed.tasks,meta.tasks);assert.equal('private' in parsed,false);
});
test('GEN-04 selected candidate must belong to the exact outstanding field and still be authorized',()=>{
 const context={students:[{id:'lin'},{id:'yu'}],venues:[{id:'hong'}],lessons:[{id:'lesson'}],messages:[{id:'message'}]},saved={selection:{month:'2026-11'},clarification:{field:'selectedStudent',choices:[{id:'lin'}]}};
 assert.deepEqual(applyResolution(saved,{field:'selectedStudent',id:'lin'},context),{month:'2026-11',selectedStudent:'lin'});assert.deepEqual(saved.selection,{month:'2026-11'});
 assert.throws(()=>applyResolution(saved,{field:'selectedStudent',id:'yu'},context),{code:'INVALID_RESOLUTION'});
 assert.throws(()=>applyResolution(saved,{field:'venueId',id:'lin'},context),{code:'INVALID_RESOLUTION'});
 assert.throws(()=>applyResolution(saved,{field:'selectedStudent',id:'lin'},{...context,students:[]}),{code:'STALE_PLAN'});
 assert.throws(()=>applyResolution({selection:{}},{field:'selectedStudent',id:'lin'},context),{code:'INVALID_RESOLUTION'});
});
test('GEN-05 message disagreement candidate can select only an authorized pending question choice',()=>{
 const saved={selection:{selectedStudent:'lin'},clarification:{field:'messageId',choices:[{id:'message'}]}},context={messages:[{id:'message'}]};
 assert.deepEqual(applyResolution(saved,{field:'messageId',id:'message'},context),{selectedStudent:'lin',messageId:'message'});
});
test('GEN-06 no candidate selection preserves a copied prior selection',()=>{
 const saved={selection:{selectedStudent:'lin',month:'2026-11'}},result=applyResolution(saved,null,{});
 assert.deepEqual(result,saved.selection);assert.notEqual(result,saved.selection);
});
test('GEN-07 task lookup is parameterized by scope and authenticated actor',async()=>{
 const c=client();await generationSnapshot(c,member,identity,workspace,{text:'改90分钟',taskId:'saved-task'});
 const first=c.calls[0];assert.match(first.sql,/workspace_id=\$1 AND id=\$2 AND actor_id=\$3/);assert.deepEqual(first.params,[workspace,'saved-task',identity.id]);
 for(const [actor,scope] of [[{...identity,id:'other-user'},workspace],[identity,'other-scope']])await assert.rejects(()=>snapshot({},undefined,actor,scope),{code:'TASK_NOT_FOUND',status:404});
});
test('GEN-08 missing tasks and old tasks without understanding state cannot be continued',async()=>{
 for(const saved of [null,prior({plan:{steps:plan(),revisions:{}}})])await assert.rejects(()=>snapshot({saved}),{code:'TASK_NOT_FOUND'});
});
test('GEN-09 committed, cancelled, undone and submission-in-flight plans cannot be revised',async()=>{
 for(const status of ['committed','cancelled','undone'])await assert.rejects(()=>snapshot({saved:prior({status})}),{code:'STALE_PLAN'});
 await assert.rejects(()=>snapshot({saved:prior({submission_open:true})}),{code:'STALE_PLAN'});
});
test('GEN-10 both database and task expiry, including malformed timestamps, fail closed',async()=>{
 const old=new Date(Date.now()-1000).toISOString();
 for(const expires_at of [old,'invalid-timestamp'])await assert.rejects(()=>snapshot({saved:prior({expires_at})}),{code:'STALE_PLAN'});
 for(const expiresAt of [old,'invalid-timestamp']){const saved=prior();saved.plan.understanding.expiresAt=expiresAt;await assert.rejects(()=>snapshot({saved}),{code:'STALE_PLAN'});}
});
test('GEN-11 membership revision changes and the bounded turn limit reject before inference',async()=>{
 await assert.rejects(()=>snapshot({saved:prior({membership_revision:3})}),{code:'STALE_PLAN'});
 const saved=prior();saved.plan.understanding.turn=12;await assert.rejects(()=>snapshot({saved}),{code:'TASK_TURN_LIMIT'});
});
test('GEN-12 stale referenced records cannot be used as an amendment base',async()=>{
 const rows=records();rows.find(row=>row.id==='lin').revision=2;
 await assert.rejects(()=>snapshot({rows}),{code:'STALE_PLAN'});
});
test('GEN-13 full authorized base references survive unrelated task context narrowing',async()=>{
 const base=plan([operation(),operation({intent:'credit',studentId:'yu',venueId:null,amount:3,note:'已买课'})]),saved=prior();saved.plan.steps=base;
 const value=await snapshot({saved},{text:'第二项改成4课时',taskId:'saved-task',selection:{}});
 assert.deepEqual(value.base,base);assert.ok(value.input.context.students.some(row=>row.id==='lin'));assert.ok(value.input.context.students.some(row=>row.id==='yu'));assert.ok(value.input.context.venues.some(row=>row.id==='riverside'));
});
test('GEN-14 reviewed form exact free text survives snapshot and does not mutate stored task',async()=>{
 const saved=prior(),reviewed=structuredClone(saved.plan.steps);reviewed.steps[0].operation.note='  已手改备注\n第二行  不改写';
 const value=await snapshot({saved},{text:'改成90分钟',taskId:'saved-task',reviewedPlan:reviewed});
 assert.equal(value.base.steps[0].operation.note,reviewed.steps[0].operation.note);assert.equal(saved.plan.steps.steps[0].operation.note,operation().note);
});
test('GEN-15 forged reviewed graph and foreign entity IDs are rejected',async()=>{
 const reviewed=plan();reviewed.steps[0].operation.studentId='foreign';await assert.rejects(()=>snapshot({}, {text:'90分钟',taskId:'saved-task',reviewedPlan:reviewed}),{code:'INVALID_DRAFT'});
 const changed=plan();changed.steps.push({...structuredClone(changed.steps[0]),id:'s2'});await assert.rejects(()=>snapshot({}, {text:'90分钟',taskId:'saved-task',reviewedPlan:changed}),{code:'TASK_SHAPE_CHANGED'});
});
test('GEN-16 a new request cannot submit a candidate without a saved server question',async()=>{
 await assert.rejects(()=>snapshot({}, {text:'小林',selection:{},resolution:{field:'selectedStudent',id:'lin'}}),{code:'INVALID_RESOLUTION'});
});
test('GEN-17 unresolved task preserves original request when natural-language clarification is added',async()=>{
 const saved=prior();saved.plan.steps=clarificationPlan('几点？');saved.plan.understanding=task({originalText:'给小林约明天一小时'});
 const value=await snapshot({saved},{text:'下午四点',taskId:'saved-task'});
 assert.equal(value.base,null);assert.equal(value.input.text,'给小林约明天一小时\n补充：下午四点');assert.equal(value.task.originalText,'给小林约明天一小时');assert.equal(value.task.turn,2);assert.equal(value.task.expiresAt,saved.plan.understanding.expiresAt);
});
test('GEN-18 unresolved accumulated text limit rejects instead of silently truncating context',async()=>{
 const saved=prior();saved.plan.steps=clarificationPlan('补充一下');saved.plan.understanding=task({originalText:'约课'.repeat(790)});
 await assert.rejects(()=>snapshot({saved},{text:'备注'.repeat(20),taskId:'saved-task'}),{code:'CONTEXT_LIMIT'});
});
test('GEN-19 explicit candidate resolution retains original task and validated selection',async()=>{
 const saved=prior(),rows=records();rows.find(row=>row.id==='yu').payload.name='小林';saved.plan.steps=clarificationPlan('哪位小林？');saved.plan.understanding=task({selection:{},clarification:{field:'selectedStudent',choices:[{id:'lin'},{id:'yu'}]}});
 const value=await snapshot({saved,rows},{text:'第二位小林',taskId:'saved-task',resolution:{field:'selectedStudent',id:'yu'}});
 assert.equal(value.input.text,saved.plan.understanding.originalText);assert.equal(value.input.context.selectedStudent,'yu');assert.equal(value.task.selection.selectedStudent,'yu');assert.equal(value.clarification,null);
});
test('GEN-20 explicitly changed student becomes the next-turn anchor, not the previous selection',async()=>{
 const value=await snapshot({}, {text:'换成小宇，其他不动',taskId:'saved-task'});
 assert.equal(value.meta.resolved.studentId,'yu');assert.equal(value.task.selection.selectedStudent,'yu');
});
test('GEN-21 response saving revalidates membership and every referenced entity revision',async()=>{
 const c=client(),s=await generationSnapshot(c,member,identity,workspace,{text:'改90分钟',taskId:'saved-task'}),response={plan:plan(),meta:{generationAttempts:1}};
 await assert.rejects(()=>saveGeneration(c,{...member,revision:5},identity,workspace,{text:'改90分钟'},s,response),{code:'STALE_PLAN'});
 const rows=records();rows.find(row=>row.id==='riverside').revision=2;await assert.rejects(()=>saveGeneration(client({rows}),member,identity,workspace,{text:'改90分钟'},s,response),{code:'STALE_PLAN'});
 assert.equal(c.calls.filter(call=>call.sql.startsWith('INSERT INTO app.plans')).length,0);
});
test('GEN-22 successful response saves one new owned task with state, revisions and no business mutation',async()=>{
 const c=client(),request={text:'改90分钟',taskId:'saved-task'},s=await generationSnapshot(c,member,identity,workspace,request),p=plan();p.steps[0].operation.duration=90;
 const saved=await saveGeneration(c,member,identity,workspace,request,s,{plan:p,meta:{amendment:{status:'patched'}}});
 const inserts=c.calls.filter(call=>call.sql.startsWith('INSERT INTO app.plans'));assert.equal(inserts.length,1);assert.equal(inserts[0].params[0],workspace);assert.equal(inserts[0].params[2],identity.id);assert.deepEqual(inserts[0].params[3].steps,p);assert.deepEqual(inserts[0].params[3].understanding,s.task);assert.equal(inserts[0].params[5],false);assert.equal(saved.plan.steps[0].operation.duration,90);assert.equal(c.calls.some(call=>/UPDATE app\.records|INSERT INTO app\.records/.test(call.sql)),false);
});
test('GEN-23 no named or selected student keeps the complete candidate set and no identity anchor',async()=>{
 const value=await snapshot({}, {text:'明天下午三点约一小时',selection:{}});
 assert.equal(value.input.context.selectedStudent,null);assert.equal(value.meta.resolved.studentId,null);assert.deepEqual(value.input.context.students.map(row=>row.id).sort(),['lin','yu']);
});
test('GEN-24 singular pronoun without a verified anchor asks instead of shrinking to an arbitrary student',async()=>{
 const value=await snapshot({}, {text:'给他约明天下午三点',selection:{}});
 assert.equal(value.meta.resolved.studentId,null);assert.equal(value.clarification.field,'selectedStudent');assert.deepEqual(value.clarification.choices.map(row=>row.id).sort(),['lin','yu']);assert.equal(value.input.context.students.length,2);
});
test('GEN-25 two explicit student tasks preserve the union rather than treating the first as the only person',async()=>{
 const value=await snapshot({}, {text:'给小林约课，然后给小宇登记2课时',selection:{}});
 assert.equal(value.input.context.selectedStudent,null);assert.deepEqual(value.input.context.students.map(row=>row.id).sort(),['lin','yu']);assert.ok(value.meta.tasks.includes('booking'));assert.ok(value.meta.tasks.includes('credit'));
});
test('GEN-25b an existing booking amendment keeps booking context instead of reclassifying training text as a new practice',async()=>{
 const value=await snapshot({}, {text:'明晚19点开始，练60分钟，场地选弘金地，练习内容改成正手30球，注意早转肩。',taskId:'saved-task'});
 const hint=JSON.parse(value.input.context.understanding);
 assert.deepEqual(hint.tasks,['booking']);assert.deepEqual(value.meta.tasks,['booking']);
 assert.equal(hint.resolved.venueId,'hong');assert.equal(value.base.steps[0].operation.note,operation().note);
});
async function chosenVenueSnapshot(){
 const saved=prior();saved.plan.steps=clarificationPlan('这次选择哪个场地？');saved.plan.understanding=task({originalText:'给小林登记已购买的2课时，另外给小宇明天在老地方约15点到16点',selection:{explicitStudentChoice:'yu'},clarification:{field:'venueId',choices:[{id:'hong',name:'弘金地'}]}});
 return snapshot({saved},{text:'弘金地',taskId:'saved-task',resolution:{field:'venueId',id:'hong'}});
}
async function generatedFixture(t,s,p){
 const previous=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='unit-only-placeholder';
 t.mock.method(globalThis,'fetch',async()=>Response.json({status:'completed',model:'unit-fixture',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(p)}]}]}));
 try{return await generateResponse(s);}finally{t.mock.restoreAll();if(previous===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previous;}
}
test('GEN-25c a verified venue choice binds only the matching students booking and replaces obsolete ambiguity explanations',async t=>{
 const s=await chosenVenueSnapshot(),p=plan([operation({intent:'credit',studentId:'lin',venueId:null,amount:2,note:'已有购买'}),operation({studentId:'yu',venueId:null,explanation:'场地无法核对，请选择场地'})]);p.explanation='老地方无法核对，请选择场地';
 const before=structuredClone(p),result=await generatedFixture(t,s,p);assert.equal(result.plan.steps[1].operation.venueId,'hong');assert.deepEqual(result.plan.steps[0],before.steps[0]);
 assert.match(result.plan.explanation,/弘金地/);assert.match(result.plan.steps[1].operation.explanation,/弘金地/);assert.doesNotMatch(result.plan.explanation,/无法核对|请选择场地/);
 const expected=structuredClone(before);expected.explanation=result.plan.explanation;expected.steps[1].operation.venueId='hong';expected.steps[1].operation.explanation=result.plan.steps[1].operation.explanation;assert.deepEqual(result.plan,expected);assert.deepEqual(p,before);
 const other=plan([operation({studentId:'lin',venueId:'riverside'}),operation({studentId:'yu',venueId:'riverside'})]);const both=await generatedFixture(t,s,other);assert.equal(both.plan.steps[0].operation.venueId,'riverside');assert.equal(both.plan.steps[1].operation.venueId,'hong');
});
test('GEN-25d explicit venue binding rejects ambiguous, foreign and ref-based targets without guessing or overriding history',async t=>{
 const s=await chosenVenueSnapshot();
 for(const p of [plan([operation({studentId:'lin'})]),plan([operation({studentId:'yu'}),operation({studentId:'yu'})])])await assert.rejects(()=>generatedFixture(t,s,p),{code:'INVALID_RESOLUTION'});
 const ref=plan([operation({intent:'add-venue',name:'新场地',venueId:null}),operation({studentId:'yu',venueId:null})]);ref.steps[1].venueRef='s1';ref.steps[1].dependsOn=['s1'];await assert.rejects(()=>generatedFixture(t,s,ref),{code:'INVALID_RESOLUTION'});
 for(const mutate of [x=>x.meta.resolved.venueId='foreign',x=>x.meta.resolved.historyStudentId='foreign',x=>x.task.selection.venueId='riverside']){const invalid=structuredClone(s);mutate(invalid);await assert.rejects(()=>generatedFixture(t,invalid,plan([operation({studentId:'yu',venueId:null})])),{code:'INVALID_RESOLUTION'});}
 const history=structuredClone(s);history.meta.resolved.venueBasis='latest-completed-lesson';const p=plan([operation({studentId:'yu',venueId:null})]);assert.deepEqual((await generatedFixture(t,history,p)).plan,p);
});

// These tests exercise the real commit implementation with explicitly scoped
// rows and an in-memory SQL boundary. PostgreSQL RLS itself is tested separately
// by the integration suite; these assertions do not pretend to reproduce it.
function commitClient(p,source=records()){
 const rows=structuredClone(source),calls=[],saved={...prior(),id:'commit-task',plan:{steps:p,revisions:Object.fromEntries(rows.map(row=>[row.id,row.revision]))}};
 const c={rows,calls,saved,async query(sql,params){
  calls.push({sql,params});
  if(sql.startsWith('SELECT * FROM app.plans'))return {rows:params[0]===workspace&&params[1]===saved.id?[structuredClone(saved)]:[]};
  if(sql.startsWith('SELECT * FROM app.records WHERE workspace_id=$1 AND id=$2'))return {rows:params[0]===workspace?structuredClone(rows.filter(row=>row.id===params[1])):[]};
  if(sql.startsWith('SELECT * FROM app.records WHERE workspace_id=$1 ORDER BY'))return {rows:params[0]===workspace?structuredClone(rows):[]};
  if(sql.startsWith('INSERT INTO app.records')){const r=row(params[1],params[2],params[8],{student_id:params[3],lesson_id:params[4],venue_id:params[5],owner_user_id:params[6],visibility:params[7]});rows.push(r);return {rows:[structuredClone(r)],rowCount:1};}
  if(sql.startsWith('UPDATE app.records SET payload=$3,visibility=$4')){const r=rows.find(row=>row.id===params[1]);if(!r)return {rowCount:0,rows:[]};r.payload=structuredClone(params[2]);r.visibility=params[3];r.revision++;return {rowCount:1,rows:[structuredClone(r)]};}
  if(sql.startsWith("UPDATE app.plans SET status='committed'")){saved.status='committed';saved.result=structuredClone(params[2]);return {rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO app.audit'))return {rows:[],rowCount:1};
  throw Error(`Unexpected commit query: ${sql}`);
 }};return c;
}
const scopedSummaryRows=()=>[...records(),
 row('lin-done','lesson',{date:'2026-10-02',start:900,duration:60,state:'done',topic:''},{student_id:'lin',venue_id:'riverside'}),
 row('group-done','lesson',{date:'2026-10-03',start:900,duration:90,state:'done',topic:''},{student_id:null,venue_id:'riverside'}),
 row('group-lin','participant',{}, {student_id:'lin',lesson_id:'group-done'}),row('group-lin-duplicate','participant',{}, {student_id:'lin',lesson_id:'group-done'}),row('group-yu','participant',{}, {student_id:'yu',lesson_id:'group-done'}),
 row('yu-done','lesson',{date:'2026-10-04',start:900,duration:180,state:'done',topic:''},{student_id:'yu',venue_id:'hong'}),
 row('cancelled','lesson',{date:'2026-10-05',start:900,duration:60,state:'cancelled',topic:''},{student_id:'lin',venue_id:'riverside'}),
 row('other-month','lesson',{date:'2026-09-04',start:900,duration:240,state:'done',topic:''},{student_id:'lin',venue_id:'riverside'}),
];
test('GEN-26 targeted summary counts one-to-one and group participation once and excludes other students/months/cancellations',async()=>{
 const c=commitClient(plan([operation({intent:'summary',studentId:'lin',venueId:null,month:'2026-10'})]),scopedSummaryRows());
 const result=await commitPlan(c,member,identity,workspace,'commit-task');assert.deepEqual({lessons:result.results[0].lessons,completed:result.results[0].completed,hours:result.results[0].hours,studentId:result.results[0].studentId},{lessons:3,completed:2,hours:2.5,studentId:'lin'});
 assert.match(result.results[0].message,/小林/);assert.equal(result.undoable,false);assert.equal(c.calls.some(call=>/^(?:INSERT INTO|UPDATE) app\.records/.test(call.sql)),false);
});
test('GEN-27 unfiltered coach summary includes all authorized students but never duplicate group counts',async()=>{
 const c=commitClient(plan([operation({intent:'summary',studentId:null,venueId:null,month:'2026-10'})]),scopedSummaryRows());
 const result=await commitPlan(c,member,identity,workspace,'commit-task');assert.equal(result.results[0].lessons,4);assert.equal(result.results[0].completed,3);assert.equal(result.results[0].hours,5.5);assert.equal(result.results[0].studentId,null);
});
test('GEN-28 student summary cannot target a different student even when a test double exposes their row',async()=>{
 const c=commitClient(plan([operation({intent:'summary',studentId:'yu',venueId:null,month:'2026-10'})]));
 await assert.rejects(()=>commitPlan(c,{...member,role:'student',student_id:'lin'},identity,workspace,'commit-task'),{status:403});assert.equal(c.saved.status,'pending');
});
test('GEN-29 student unfiltered summary computes only the RLS-provided self rows',async()=>{
 const selfRows=scopedSummaryRows().filter(row=>row.id!=='yu'&&row.student_id!=='yu');
 const c=commitClient(plan([operation({intent:'summary',studentId:null,venueId:null,month:'2026-10'})]),selfRows);
 const result=await commitPlan(c,{...member,role:'student',student_id:'lin'},identity,workspace,'commit-task');assert.equal(result.results[0].lessons,3);assert.equal(result.results[0].hours,2.5);
});
const studentMember={...member,role:'student',student_id:'lin'};
const dayOffset=offset=>new Date(Date.parse(today()+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10);
test('GEN-30 new practice stores an explicit historical date and defaults omitted dates to Shanghai today',async()=>{
 for(const date of [dayOffset(-1),null]){
  const c=commitClient(plan([operation({intent:'practice',studentId:null,venueId:null,date,name:'反手练习',text:'原文  保留\n下一行',shared:false})]));
  await commitPlan(c,studentMember,identity,workspace,'commit-task');const r=c.rows.find(row=>row.kind==='practice');assert.equal(r.payload.date,date??today());assert.equal(r.payload.text,'原文  保留\n下一行');assert.equal(r.student_id,'lin');assert.equal(r.visibility,'private');
 }
});
test('GEN-31 edit practice preserves an omitted date and visibility, and honors an explicit date correction',async()=>{
 const old=row('practice-old','practice',{topic:'原主题',text:'原记录',date:dayOffset(-5)},{student_id:'lin',owner_user_id:identity.id,visibility:'shared'});
 for(const date of [null,dayOffset(-1)]){
  const c=commitClient(plan([operation({intent:'edit-practice',studentId:null,venueId:null,practiceId:old.id,date,name:null,text:'手工纠正  不改写',shared:null})]),[...records(),old]);
  const result=await commitPlan(c,studentMember,identity,workspace,'commit-task'),r=c.rows.find(row=>row.id===old.id);assert.equal(r.payload.date,date??old.payload.date);assert.equal(r.payload.topic,'原主题');assert.equal(r.payload.text,'手工纠正  不改写');assert.equal(r.visibility,'shared');assert.match(result.results[0].message,/共享/);
 }
});
test('GEN-32 future practice dates are rejected before insert or update for both actions',async()=>{
 const old=row('practice-old','practice',{topic:'原主题',text:'原记录',date:dayOffset(-5)},{student_id:'lin',owner_user_id:identity.id,visibility:'private'});
 for(const intent of ['practice','edit-practice']){
  const c=commitClient(plan([operation({intent,studentId:null,venueId:null,practiceId:intent==='edit-practice'?old.id:null,date:dayOffset(1),name:'主题',text:'内容',shared:false})]),[...records(),old]),before=structuredClone(c.rows);
  await assert.rejects(()=>commitPlan(c,studentMember,identity,workspace,'commit-task'),{code:'INVALID_PRACTICE_DATE',status:400});assert.deepEqual(c.rows,before);assert.equal(c.saved.status,'pending');
 }
});
test('GEN-33 coach role cannot create or modify student practice records',async()=>{
 for(const intent of ['practice','edit-practice']){
  const c=commitClient(plan([operation({intent,studentId:null,venueId:null,practiceId:intent==='edit-practice'?'practice-old':null,date:today(),name:'主题',text:'内容'})]));
  await assert.rejects(()=>commitPlan(c,member,identity,workspace,'commit-task'),{code:'UNSUPPORTED_ACTION'});assert.equal(c.calls.some(call=>/^(?:INSERT INTO|UPDATE) app\.records/.test(call.sql)),false);
 }
});
