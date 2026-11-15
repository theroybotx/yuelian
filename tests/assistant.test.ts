import {test} from 'node:test';
import assert from 'node:assert/strict';
import {type AssistantError,Draft,scopeInput,interpret,interpretAmendment,validateDraft,validatePlan,outputSchema,matchingVenues,venueNames,type AssistantInput,type OperationDraft,type OperationPlan} from '../lib/assistant.ts';
import {freshData,balanceOf} from '../public/data.js';
import {toOperation} from '../public/ai-client.js';
const data=freshData();
const context={today:'2026-10-31',role:'coach',month:'2026-10',selectedStudent:null,selectedLesson:null,messageId:null,
 students:data.students.map(s=>({...s,balance:balanceOf(data,s.id)})),venues:data.venues,lessons:data.lessons,messages:data.messages,followupIds:['shen']};
const input=()=>scopeInput({text:'帮我添加一个课程吧，明天下午3点到4点，刘德华的。',context});
const draft=(override:Partial<OperationDraft>&Record<string,unknown>={}):OperationDraft=>({...Object.fromEntries(Object.keys(Draft.shape).map(k=>[k,null])) as Record<keyof OperationDraft,null>,intent:'booking',title:'核对课程',explanation:'场地还需补选。',studentName:'刘德华',date:'2026-11-01',start:'15:00',duration:60,...override});
const plan=(operations=[draft()]):OperationPlan=>({title:'核对操作',explanation:'确认后执行。',steps:operations.map((operation,index)=>({id:'s'+(index+1),dependsOn:[],studentRef:null,venueRef:null,operation}))});
type ModelRequest={model:string;reasoning:{effort:string};input:string;text:{format:{strict:boolean;schema:unknown}}};
type BookingOperation={values:{student:string;date:string;start:string;duration:number|'';venue:string;note:string};unknownName:string;missing:string[]};
type BookingEnvironment={data:typeof data;role:'coach'|'student';request:string;selfStudentId?:string};
const reply=(d:unknown,extras={})=>new Response(JSON.stringify({status:'completed',model:'deepseek-flash',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(d)}]}],...extras}));
test('DeepSeek request uses Flash, Medium and strict schema without unsupported Fast tier',async()=>{
 let payload!:ModelRequest;const result=await interpret(input(),'test-only-key',async(url,init)=>{assert.equal(url,'https://api.deepseek.com/responses');payload=JSON.parse(String(init?.body));return reply(plan());});
 assert.equal(payload.model,'deepseek-flash');assert.deepEqual(payload.reasoning,{effort:'medium'});assert.equal('service_tier' in payload,false);assert.equal('store' in payload,false);assert.equal(payload.text.format.strict,true);assert.deepEqual(payload.text.format.schema,outputSchema);assert.equal(result.plan.steps[0].operation.start,'15:00');assert.equal(result.meta.effectiveReasoning,'high');assert.equal(result.meta.fastSupported,false);
});
test('null fields remain empty and unknown names require explicit selection',()=>{
 const before=JSON.stringify(data);const d=validateDraft(draft(),input());const r=toOperation(d,{data,role:'coach',request:input().text}) as BookingOperation;
 assert.equal(r.values.student,'');assert.equal(r.unknownName,'刘德华');assert.equal(r.values.venue,'');assert.equal(r.values.date,'2026-11-01');assert.equal(r.values.duration,60);assert.equal(JSON.stringify(data),before);
});
test('invalid references and malformed output are rejected',()=>{
 for(const d of [draft({studentId:'invented'}),draft({venueId:'invented'}),draft({start:'99:00'}),draft({surprise:'x'})])assert.throws(()=>validateDraft(d,input()));
});
test('student context excludes other students and coach notes',()=>{
 const i=scopeInput({text:'核对课时',context:{...context,role:'student',selfStudentId:'roy'}});
 assert.deepEqual(i.context.students.map(s=>s.id),['roy']);assert.ok(i.context.lessons.every(l=>l.students.every(s=>s==='roy')&&l.note===''));assert.deepEqual(i.context.followupIds,[]);
 assert.throws(()=>validateDraft(draft({intent:'credit',studentId:'roy',amount:10}),i));assert.throws(()=>validateDraft(draft({studentId:'wang'}),i));
});
test('current coach display name is optional bounded data and does not widen student identity',()=>{
 const i=scopeInput({text:'明晚有空吗',context:{...context,role:'student',selfStudentId:'roy',currentCoachName:'  林教练  ',workspaceId:'forged-workspace',selectedStudent:'wang'}});
 assert.equal(i.context.currentCoachName,'林教练');assert.deepEqual(i.context.students.map(s=>s.id),['roy']);assert.equal(i.context.selectedStudent,'roy');assert.equal('workspaceId' in i.context,false);
 assert.equal(input().context.currentCoachName,undefined);
 for(const currentCoachName of ['', '   ', '名'.repeat(81), 123])assert.throws(()=>scopeInput({text:'约课',context:{...context,currentCoachName}}),{code:'INVALID_INPUT'});
 assert.equal(scopeInput({text:'约课',context:{...context,currentCoachName:'名'.repeat(80)}}).context.currentCoachName?.length,80);
});
test('public venue matching recognizes the exact seeded display decoration without changing stored names or choosing among aliases',()=>{
 const rows=[{id:'hong',name:'示例 · 弘金地网球场'}],before=JSON.stringify(rows);
 for(const name of ['示例 · 弘金地网球场','弘金地网球场','弘金地'])assert.deepEqual(matchingVenues('场地选'+name+'，其他不动',rows),rows);
 assert.ok(venueNames(' 示例·弘金地网球场 ').includes('弘金地网球场'));
 assert.equal(JSON.stringify(rows),before);assert.equal(matchingVenues('弘金地网球场',rows)[0],rows[0]);
 for(const name of ['示例弘金地网球场','新示例 · 弘金地网球场','测试 · 弘金地网球场'])assert.deepEqual(matchingVenues('场地选弘金地网球场',[{id:'other',name}]),[]);
 for(const name of ['弘金地北场','弘金地路'])assert.deepEqual(matchingVenues('场地选'+name,rows),[]);
 const duplicate=[...rows,{id:'other',name:'弘金地网球场'}];
 assert.deepEqual(matchingVenues('场地选弘金地网球场',duplicate).map(row=>row.id),['hong','other']);
});
test('the current coach label reaches model context while incomplete student booking remains editable and self-only',async()=>{
 const i=scopeInput({text:'帮我问林教练明晚是否可以约课',context:{...context,role:'student',selfStudentId:'roy',currentCoachName:'林教练'}});
 const expected=plan([draft({studentId:'roy',studentName:null,date:'2026-11-01',start:null,duration:null,venueId:null})]);let body!:ModelRequest,calls=0;
 const generated=await interpret(i,'test-key',async(_url,init)=>{calls++;body=JSON.parse(String(init?.body));return reply(expected);});
 const sent:AssistantInput=JSON.parse(body.input);assert.equal(sent.context.currentCoachName,'林教练');assert.equal(sent.context.selfStudentId,'roy');assert.deepEqual(sent.context.students.map(s=>s.id),['roy']);
 const ui=(toOperation as (draft:OperationDraft,environment:BookingEnvironment)=>BookingOperation)(generated.plan.steps[0].operation,{data,role:'student',selfStudentId:'roy',request:i.text});
 assert.equal(ui.values.student,'roy');assert.equal(ui.values.date,'2026-11-01');for(const field of ['start','duration','venue'] as const)assert.equal(ui.values[field],'');assert.equal(ui.missing.length,3);assert.equal(calls,1);
 assert.throws(()=>validateDraft(draft({studentId:'wang'}),i),{code:'INVALID_DRAFT'});
});
test('record and inbox drafts must reference actionable current records',()=>{
 assert.throws(()=>validateDraft(draft({intent:'record',lessonId:'l1'}),input()));
 assert.throws(()=>validateDraft(draft({intent:'record',lessonId:'l3'}),input()));
 assert.equal(validateDraft(draft({intent:'record',lessonId:'l2'}),input()).lessonId,'l2');
 assert.equal(validateDraft(draft({intent:'message-decision',messageId:'m-book',decision:'accept'}),input()).decision,'accept');
 assert.throws(()=>validateDraft(draft({intent:'message-decision',messageId:'m-balance',decision:'accept'}),input()));
});
test('incomplete, refusal, broken JSON and upstream failure never become drafts',async()=>{
 for(const response of [reply(draft(),{status:'incomplete'}),reply(null,{output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}),reply(null,{output:[{type:'message',content:[{type:'output_text',text:'not-json'}]}]}),new Response('upstream-private-details',{status:401}),new Response('quota',{status:429})])await assert.rejects(()=>interpret(input(),'test-key',async()=>response));
});
test('network failure and cancellation have explicit errors without fallback',async()=>{
 await assert.rejects(()=>interpret(input(),'test-key',async()=>{throw Error('network');}),{code:'MODEL_TIMEOUT'});
 const controller=new AbortController();controller.abort();await assert.rejects(()=>interpret(input(),'test-key',async()=>{throw Error('aborted');},controller.signal),{code:'CANCELLED'});
});
test('response body cancellation is CANCELLED for initial generation and amendment, without retry or mutation',async()=>{
 for(const amendment of [false,true]){
  const controller=new AbortController(),base=plan(),before=JSON.stringify(base);let calls=0;
  const send:typeof fetch=async(_url,init)=>{calls++;assert.equal(init?.signal?.aborted,false);const response=new Response('{}');response.json=async()=>{controller.abort();throw new DOMException('private body details','AbortError');};return response;};
  await assert.rejects(()=>amendment?interpretAmendment(input(),base,'test-key',send,controller.signal):interpret(input(),'test-key',send,controller.signal),(e:AssistantError)=>e.code==='CANCELLED'&&e.status===499&&!e.message.includes('private body details'));
  assert.equal(calls,1);assert.equal(JSON.stringify(base),before);
 }
});
test('the shared 45 second deadline also governs reading response bodies in both model paths',async t=>{
 let timeoutController=new AbortController(),deadlines=0;
 t.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,45000);deadlines++;return timeoutController.signal;});
 for(const amendment of [false,true]){
  timeoutController=new AbortController();const caller=new AbortController(),base=plan(),before=JSON.stringify(base);let calls=0;
  const send:typeof fetch=async(_url,init)=>{calls++;const response=new Response('{}');response.json=async()=>{timeoutController.abort(new DOMException('deadline','TimeoutError'));assert.equal(init?.signal?.aborted,true);assert.equal(caller.signal.aborted,false);throw new DOMException('private timeout body','AbortError');};return response;};
  await assert.rejects(()=>amendment?interpretAmendment(input(),base,'test-key',send,caller.signal):interpret(input(),'test-key',send,caller.signal),(e:AssistantError)=>e.code==='MODEL_TIMEOUT'&&e.status===504&&!e.message.includes('private timeout body'));
  assert.equal(calls,1);assert.equal(JSON.stringify(base),before);
 }
 assert.equal(deadlines,2);
});
test('malformed response bodies remain INVALID_RESPONSE when no signal was cancelled',async()=>{
 for(const amendment of [false,true]){
  let calls=0;const send:typeof fetch=async()=>{calls++;return new Response('private malformed json');};
  await assert.rejects(()=>amendment?interpretAmendment(input(),plan(),'test-key',send):interpret(input(),'test-key',send),(e:AssistantError)=>e.code==='INVALID_RESPONSE'&&e.status===502&&!e.message.includes('private malformed json'));
  assert.equal(calls,1);
 }
});
test('a body reader that completes after caller cancellation cannot return a late draft',async()=>{
 for(const amendment of [false,true]){
  const caller=new AbortController();let calls=0;
  const send:typeof fetch=async()=>{calls++;const response=reply(plan());const read=response.json.bind(response);response.json=async()=>{const body=await read();caller.abort();return body;};return response;};
  await assert.rejects(()=>amendment?interpretAmendment(input(),plan(),'test-key',send,caller.signal):interpret(input(),'test-key',send,caller.signal),{code:'CANCELLED',status:499});assert.equal(calls,1);
 }
});
test('unsupported provider tier is never advertised as Fast',async()=>{
 const r=await interpret(input(),'test-key',async()=>reply(plan(),{service_tier:'fast'}));assert.equal(r.meta.fastSupported,false);assert.equal('actualServiceTier' in r.meta,false);
});
test('DeepSeek insufficient balance differs from rate limiting',async()=>{
 await assert.rejects(()=>interpret(input(),'test-key',async()=>new Response('private details',{status:402})),{code:'MODEL_QUOTA',status:402});
 await assert.rejects(()=>interpret(input(),'test-key',async()=>new Response('private details',{status:429})),{code:'MODEL_BUSY',status:429});
});
test('bounded inputs reject excessive user text and invalid message scope',()=>{
 assert.throws(()=>scopeInput({text:'a'.repeat(1601),context}));assert.throws(()=>scopeInput({text:'确认',context:{...context,role:'student',messageId:'m-book'}}));
});

test('compound plan validates new venue and student dependencies without inventing real IDs',()=>{
 const p=plan([draft({intent:'add-venue',name:'弘金地网球场',studentName:null}),draft({studentId:'roy',studentName:null,venueId:null})]);
 p.steps[1].venueRef='s1';p.steps[1].dependsOn=['s1'];
 const validated=validatePlan(p,input());assert.equal(validated.steps.length,2);assert.equal(validated.steps[1].operation.venueId,null);
 for(const mutate of [(p:OperationPlan)=>p.steps[1].dependsOn=[],(p:OperationPlan)=>p.steps[1].venueRef='missing',(p:OperationPlan)=>p.steps[1].studentRef='s1',(p:OperationPlan)=>p.steps[0].dependsOn=['s2'],(p:OperationPlan)=>p.steps[1].id='s1']){
  const bad=structuredClone(p);mutate(bad);assert.throws(()=>validatePlan(bad,input()));
 }
});
test('plans cannot exceed eight steps or evade student role restrictions',()=>{
 assert.throws(()=>validatePlan(plan(Array.from({length:9},()=>draft())),input()));
 const i=scopeInput({text:'添加场地再约课',context:{...context,role:'student',selfStudentId:'roy'}});
 assert.throws(()=>validatePlan(plan([draft({intent:'add-venue',name:'新场地'})]),i));
});

test('student identity must be provided by the authorized backend',()=>{
 assert.throws(()=>scopeInput({text:'我的余额',context:{...context,role:'student'}}),{code:'INVALID_IDENTITY'});
});
test('provider rejects malformed requests distinctly without leaking response text',async()=>{
 await assert.rejects(()=>interpret(input(),'test-key',async()=>new Response('private-provider-details',{status:400})),(e:AssistantError)=>e.code==='MODEL_CONFIGURATION'&&e.status===502&&!e.message.includes('private-provider-details'));
});
test('nullable weekdays and nonempty weekdays both validate; runtime still rejects oversized plans',async()=>{
 for(const days of [null,['一','三','五']] satisfies OperationDraft['days'][]){
  const p=plan([draft({intent:'edit-base',days})]);
  assert.deepEqual((await interpret(input(),'test-key',async()=>reply(p))).plan.steps[0].operation.days,days);
 }
 const schema=outputSchema.properties.steps.items.properties.operation.properties as {days:{anyOf:Array<{type:string}>}};
 assert.deepEqual(schema.days.anyOf.map(s=>s.type),['array','null']);
 await assert.rejects(()=>interpret(input(),'test-key',async()=>reply(plan(Array.from({length:9},()=>draft())))),{code:'INVALID_DRAFT'});
});

test('broken dependency graph gets one bounded regeneration, never execution or relaxed validation',async()=>{
 const good=plan([draft({intent:'add-student',studentName:'新学员'}),draft({intent:'credit',studentId:null,amount:2})]);good.steps[1].studentRef='s1';good.steps[1].dependsOn=['s1'];
 const bad=structuredClone(good);bad.steps[1].dependsOn=[];const requests:RequestInit[]=[];
 const result=await interpret(input(),'test-key',async(u,o)=>{requests.push(o!);return reply(requests.length===1?bad:good);});
 assert.equal(requests.length,2);assert.equal(requests[0].signal,requests[1].signal);assert.equal(JSON.parse(requests[0].body as string).input,JSON.parse(requests[1].body as string).input);assert.equal(result.meta.generationAttempts,2);
 let attempts=0;await assert.rejects(()=>interpret(input(),'test-key',async()=>{attempts++;return reply(bad);}),{code:'INVALID_PLAN'});assert.equal(attempts,2);
 attempts=0;await assert.rejects(()=>interpret(input(),'test-key',async()=>{attempts++;return reply(plan([draft({studentId:'foreign-student'})]));}),{code:'INVALID_DRAFT'});assert.equal(attempts,1);
});

test('real calendar dates are required, including leap-day boundaries',()=>{for(const date of ['2026-11-31','2026-02-29','2026-13-01','2026-00-10'])assert.equal(Draft.safeParse(draft({date})).success,false);for(const date of ['2024-02-29','2026-11-30'])assert.equal(Draft.safeParse(draft({date})).success,true);});

test('new follow-up uses candidate students without accepting student IDs as existing follow-up records',async()=>{
 const i=input(),candidate=i.context.followupIds[0];
 assert.ok(i.context.students.some(s=>s.id===candidate));
 const fresh=draft({intent:'followup',studentId:null,followupId:null,text:'这周方便继续训练吗？'});
 assert.equal(validateDraft(fresh,i).followupId,null);
 const confused=draft({...fresh,studentId:candidate,followupId:candidate});
 let calls=0;
 await assert.rejects(()=>interpret(i,'test-only-key',async()=>{calls++;return reply(plan([confused]));}),{code:'INVALID_DRAFT'});
 assert.equal(calls,1,'Unknown record IDs must fail closed, never widen scope through regeneration');
 const existing=scopeInput({text:'修改回访草稿',context:{...context,followups:[{id:'existing-followup',student:candidate,text:'原内容'}]}});
 assert.equal(validateDraft({...fresh,followupId:'existing-followup'},existing).followupId,'existing-followup');
});

test('coach overall monthly summary needs no selected student while student context stays self-only',()=>{
 const d=draft({intent:'summary',studentId:null,month:context.month});
 assert.equal(validateDraft(d,input()).studentId,null);
 const i=scopeInput({text:'看看我本月上课情况',context:{...context,role:'student',selfStudentId:'roy'}});
 assert.equal(validateDraft(d,i).studentId,null);
 assert.deepEqual(i.context.students.map(s=>s.id),['roy']);
});

const localRuntime={endpoint:'http://127.0.0.1:8080/v1/responses',temperature:0,config:{provider:'strata',model:'qwen3.8-flash-next-unsloth-ud-q4_k_xl',modelLabel:'千问 3.8 Flash Next · 本地 Q4',reasoning:'medium',effectiveReasoning:'medium',fastSupported:false}};
test('local malformed links get at most one regeneration on the same deadline and never a cloud request',async()=>{
 const good=plan([draft({intent:'add-student',studentName:'新学员'}),draft({intent:'credit',studentId:null,amount:2})]);good.steps[1].studentRef='s1';good.steps[1].dependsOn=['s1'];
 const bad=structuredClone(good);bad.steps[1].dependsOn=[];const requests:Array<{url:unknown,init:RequestInit}>=[];
 const send:typeof fetch=async(url,init)=>{requests.push({url,init:init!});return reply(bad);};
 await assert.rejects(()=>interpret(input(),'',send,undefined,localRuntime),{code:'INVALID_PLAN'});assert.equal(requests.length,2);assert.equal(requests[0].init.signal,requests[1].init.signal);
 for(const r of requests){assert.equal(r.url,localRuntime.endpoint);assert.equal(new Headers(r.init.headers).has('Authorization'),false);assert.equal(JSON.parse(String(r.init.body)).temperature,0);}
});
test('local output cannot widen student authorization or silently return an invalid amendment',async()=>{
 const i=scopeInput({text:'改成90分钟',context:{...context,role:'student',selfStudentId:'roy'}}),base=plan([draft({studentId:'roy',studentName:null})]),before=JSON.stringify(base);let calls=0;
 const send:typeof fetch=async()=>{calls++;return reply(plan([draft({studentId:'wang'})]));};
 await assert.rejects(()=>interpret(i,'',send,undefined,localRuntime),{code:'INVALID_DRAFT'});assert.equal(calls,1);
 await assert.rejects(()=>interpretAmendment(i,base,'',async()=>reply({status:'patched',explanation:'不合法',question:null,patches:[{stepId:'s1',changes:[{field:'studentId',value:'wang',evidence:'改成90分钟'}]}]}),undefined,localRuntime),{code:'INVALID_AMENDMENT'});assert.equal(JSON.stringify(base),before);
});
test('local generation uses the supplied server runtime without cloud authorization',async()=>{
 let request!: {url:unknown,init:RequestInit};
 const result=await interpret(input(),'',async(url,init)=>{request={url,init:init!};return reply(plan(),{model:'local-actual'});},undefined,localRuntime);
 assert.equal(request.url,localRuntime.endpoint);assert.equal(new Headers(request.init.headers).has('Authorization'),false);
 const body=JSON.parse(String(request.init.body));assert.equal(body.model,localRuntime.config.model);assert.deepEqual(body.reasoning,{effort:'medium'});assert.equal(body.temperature,0);assert.equal(body.text.format.strict,true);
 assert.equal(result.meta.provider,'strata');assert.equal(result.meta.actualModel,'local-actual');assert.equal(result.meta.effectiveReasoning,'medium');
});
test('local amendment uses the same runtime and preserves untouched free text',async()=>{
 const base=plan(),before=JSON.stringify(base);let request!: {url:unknown,init:RequestInit};
 const r=await interpretAmendment(scopeInput({text:'改成90分钟',context}),base,'',async(url,init)=>{request={url,init:init!};return reply({status:'patched',explanation:'待核对',question:null,patches:[{stepId:'s1',changes:[{field:'duration',value:90,evidence:'改成90分钟'}]}]},{model:'local-actual'});},undefined,localRuntime);
 assert.equal(request.url,localRuntime.endpoint);assert.equal(new Headers(request.init.headers).has('Authorization'),false);
 const body=JSON.parse(String(request.init.body));assert.equal(body.model,localRuntime.config.model);assert.deepEqual(body.reasoning,{effort:'medium'});assert.equal(body.temperature,0);assert.equal(body.text.format.strict,true);assert.equal(body.max_output_tokens,5000);
 assert.equal(r.meta.provider,'strata');assert.equal(r.meta.actualModel,'local-actual');assert.equal(r.plan.steps[0].operation.duration,90);assert.equal(JSON.stringify(base),before);
});
