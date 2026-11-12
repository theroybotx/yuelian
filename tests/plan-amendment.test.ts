import {test} from 'node:test';
import assert from 'node:assert/strict';
import {type AssistantError,Draft,scopeInput,interpret,interpretAmendment,normalizeGeneratedPlan,matchingVenues,venueNames,type OperationPlan} from '../lib/assistant.ts';
import {Amendment,amendmentOutputSchema,mergeAmendment} from '../lib/plan-amendment.ts';

const context={today:'2026-11-01',role:'coach',month:'2026-11',selectedStudent:null,selectedLesson:null,messageId:null,
 students:[{id:'lin',name:'小林',goal:'反手',next:'步伐',last:'2026-10-30',balance:9},{id:'yu',name:'小宇',goal:'发球',next:'抛球',last:null,balance:4}],
 venues:[{id:'riverside',name:'滨江',address:'滨江路1号',court:'1号'},{id:'hong',name:'弘金地',address:'金地路2号',court:'2号'}],
 lessons:[{id:'lesson',date:'2026-11-01',start:900,duration:60,students:['lin'],venue:'riverside',state:'confirmed',note:'教练备注'}],
 messages:[{id:'message',student:'lin',lesson:'lesson',kind:'booking',state:'pending',title:'预约',text:'请确认'}],followupIds:[],
 practices:[{id:'practice',topic:'反手',date:'2026-11-01',shared:false}],rules:[],followups:[],
};
const input=(text:string,overrides:Record<string,unknown>={})=>scopeInput({text,context:{...context,...overrides}});
const operation=(overrides:Record<string,unknown>={})=>Draft.parse({...Object.fromEntries(Object.keys(Draft.shape).map(key=>[key,null])),intent:'booking',title:'原始标题',explanation:'原始解释',studentId:'lin',venueId:'riverside',date:'2026-11-02',start:'15:00',duration:60,note:'连续正手 30 球（注意早转肩）\n保留  两个空格',...overrides});
const plan=(operations=[operation()]):OperationPlan=>({title:'原清单',explanation:'逐字保留清单解释',steps:operations.map((op,index)=>({id:`s${index+1}`,dependsOn:[],studentRef:null,venueRef:null,operation:op}))});
const patch=(changes:unknown[],stepId='s1')=>({status:'patched',explanation:'核对修改后再确认',question:null,patches:[{stepId,changes}]});
const change=(field:string,value:unknown,evidence:string)=>({field,value,evidence});
const reply=(value:unknown,extra={})=>new Response(JSON.stringify({status:'completed',model:'deepseek-flash',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],...extra}));
const fake=(value:unknown):typeof fetch=>async()=>reply(value);
type ModelRequest={model:string;reasoning:{effort:string};input:string;max_output_tokens:number;text:{format:{strict:boolean;schema:unknown}}};

test('amendment request uses one Flash Medium strict-schema call without Fast',async()=>{
 const request=input('第二项改成90分钟，其他不动'),base=plan([operation({intent:'add-venue',studentId:null,venueId:null,name:'新场地'}),operation()]);
 let calls=0,body!:ModelRequest;const result=await interpretAmendment(request,base,'test-only-key',async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/responses');body=JSON.parse(String(init?.body));return reply(patch([change('duration',90,'第二项改成90分钟')],'s2'));});
 assert.equal(calls,1);assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.reasoning,{effort:'medium'});assert.equal(body.text.format.strict,true);assert.deepEqual(body.text.format.schema,amendmentOutputSchema);assert.equal('service_tier' in body,false);assert.equal(body.max_output_tokens,5000);assert.equal(result.meta.generationAttempts,1);assert.equal(result.meta.fastSupported,false);assert.equal(result.meta.amendment.status,'patched');assert.equal(result.plan.steps[1].operation.duration,90);
});
test('second-step duration change preserves all other fields byte for byte and never mutates its input',async()=>{
 const base=plan([operation({intent:'add-student',studentId:null,studentName:'小舟',goal:'  转肩\n保留  格式  '}),operation()]);base.steps[1].dependsOn=['s1'];base.steps[1].studentRef='s1';base.steps[1].operation.studentId=null;
 const original=JSON.stringify(base),expected=structuredClone(base);expected.steps[1].operation.duration=90;
 const result=await interpretAmendment(input('第二项90分钟，其他不动'),base,'test-only-key',fake(patch([change('duration',90,'第二项90分钟')],'s2')));
 assert.equal(JSON.stringify(result.plan),JSON.stringify(expected));assert.equal(JSON.stringify(base),original);assert.deepEqual(result.meta.amendment.changedFields,[{stepId:'s2',fields:['duration']}]);
});
test('null missing fields can be filled while existing text and graph stay exact',async()=>{
 const base=plan([operation({date:null,start:null,venueId:null,duration:90})]);
 const result=await interpretAmendment(input('明天四点，滨江'),base,'test-key',fake(patch([change('date','2026-11-02','明天'),change('start','16:00','四点'),change('venueId','riverside','滨江')])));
 assert.equal(result.plan.steps[0].operation.date,'2026-11-02');assert.equal(result.plan.steps[0].operation.start,'16:00');assert.equal(result.plan.steps[0].operation.venueId,'riverside');assert.equal(result.plan.steps[0].operation.note,base.steps[0].operation.note);assert.equal(result.plan.steps[0].operation.duration,90);
});
test('short colloquial relative shift changes only the anchored start time',async()=>{
 const base=plan(),expected=structuredClone(base);expected.steps[0].operation.start='15:30';
 const result=await interpretAmendment(input('往后挪半小时'),base,'test-key',fake(patch([change('start','15:30','往后挪半小时')])));
 assert.deepEqual(result.plan,expected);
});
test('negative instruction preserves time while updating only the requested literal note',async()=>{
 const base=plan(),request=input('不要改时间，只把备注改成练反手');
 const result=await interpretAmendment(request,base,'test-key',fake(patch([change('note','练反手','备注改成练反手')])));
 assert.equal(result.plan.steps[0].operation.start,'15:00');assert.equal(result.plan.steps[0].operation.duration,60);assert.equal(result.plan.steps[0].operation.note,'练反手');
});
test('explicit false, empty arrays and zero remain distinct from null',async()=>{
 const base=plan([operation({intent:'edit-base',days:['一'],travel:15})]);
 const result=await interpretAmendment(input('开放日全部关闭，转场时间改成0'),base,'test-key',fake(patch([change('days',[],'开放日全部关闭'),change('travel',0,'转场时间改成0')])));
 assert.deepEqual(result.plan.steps[0].operation.days,[]);assert.equal(result.plan.steps[0].operation.travel,0);
 const practice=plan([operation({intent:'practice',studentId:'lin',name:'反手',text:'原文',shared:true})]);
 const student=input('不要共享',{role:'student',selfStudentId:'lin'}),r=await interpretAmendment(student,practice,'test-key',fake(patch([change('shared',false,'不要共享')])));
 assert.equal(r.plan.steps[0].operation.shared,false);assert.equal(r.plan.steps[0].operation.text,'原文');
});
test('explicit no-publish changes only the feedback visibility flag',async()=>{
 const base=plan([operation({intent:'record',lessonId:'lesson',observation:'正手30球',feedback:'早转肩',publish:true})]);
 const r=await interpretAmendment(input('暂时不要发给学员'),base,'test-key',fake(patch([change('publish',false,'暂时不要发给学员')])));
 assert.equal(r.plan.steps[0].operation.publish,false);assert.equal(r.plan.steps[0].operation.feedback,'早转肩');
});
test('practice date correction to yesterday preserves topic, text, visibility and the existing practice target',async()=>{
 for(const intent of ['practice','edit-practice']){
  const base=plan([operation({intent,studentId:'lin',practiceId:intent==='edit-practice'?'practice':null,date:'2026-11-01',name:'反手  练习',text:'  昨天的原始记录\n不改写',shared:false})]);
  const expected=structuredClone(base);expected.steps[0].operation.date='2026-10-31';
  const r=await interpretAmendment(input('日期改成昨天，其余保留',{role:'student',selfStudentId:'lin'}),base,'test-key',fake(patch([change('date','2026-10-31','日期改成昨天')])));
  assert.equal(JSON.stringify(r.plan),JSON.stringify(expected));assert.deepEqual(r.meta.amendment.changedFields,[{stepId:'s1',fields:['date']}]);
 }
});
test('two explicitly addressed steps can be patched without changing the remaining task',async()=>{
 const base=plan([operation(),operation({start:'18:00'}),operation({intent:'credit',amount:2,note:'已有购买'})]);
 const raw={status:'patched',explanation:'核对两项修改',question:null,patches:[{stepId:'s1',changes:[change('start','16:00','第一项改四点')]},{stepId:'s2',changes:[change('duration',90,'第二项90分钟')]}]};
 const r=await interpretAmendment(input('第一项改四点，第二项90分钟，课时登记不动'),base,'test-key',fake(raw));
 assert.equal(r.plan.steps[0].operation.start,'16:00');assert.equal(r.plan.steps[1].operation.duration,90);assert.deepEqual(r.plan.steps[2],base.steps[2]);
});
test('clarification preserves the complete plan for ambiguous targets, no-op and new tasks',async()=>{
 for(const text of ['改成四点','只改场地，其他不动','还是原来那儿','再加一个学员','就这样，别改了']){
  const base=plan([operation(),operation({start:'18:00'})]),question='请说明要修改哪一项，以及新的时间或场地。';
  const r=await interpretAmendment(input(text),base,'test-key',fake({status:'clarification',explanation:'原草稿保留。',question,patches:[]}));
  assert.equal(JSON.stringify(r.plan),JSON.stringify(base));assert.equal(r.meta.amendment.status,'clarification');assert.equal(r.meta.amendment.question,question);assert.deepEqual(r.meta.amendment.changedFields,[]);
 }
});
test('schema cannot add or remove steps, replace action types, change authorization or graph',()=>{
 for(const field of ['intent','id','dependsOn','studentRef','venueRef','lessonId','messageId','practiceId','ruleId','followupId','title','explanation','role','workspaceId']){
  assert.equal(Amendment.safeParse(patch([change(field,'malicious','改一下')])).success,false);
 }
 assert.equal(Amendment.safeParse({...patch([change('duration',90,'90分钟')]),steps:[]}).success,false);
});
test('malformed, repeated and unknown steps or fields fail closed without retries',async()=>{
 const samples=[
  patch([change('duration',90,'90分钟')],'s8'),
  patch([change('duration',90,'90分钟'),change('duration',30,'90分钟')]),
  {...patch([change('duration',90,'90分钟')]),patches:[{stepId:'s1',changes:[change('duration',90,'90分钟')]},{stepId:'s1',changes:[change('start','16:00','90分钟')]}]},
  patch([change('amount',100,'90分钟')]),
  patch([change('duration',90,'用户从未说过')]),
 ];
 for(const raw of samples){let calls=0;await assert.rejects(()=>interpretAmendment(input('90分钟'),plan(),'test-key',async()=>{calls++;return reply(raw);}),{code:'INVALID_AMENDMENT'});assert.equal(calls,1);}
});
test('an explicit ordinal cannot be redirected to a different existing step',async()=>{
 await assert.rejects(()=>interpretAmendment(input('第二项改90分钟'),plan([operation(),operation()]),'test-key',fake(patch([change('duration',90,'第二项改90分钟')],'s1'))),{code:'INVALID_AMENDMENT'});
 await assert.rejects(()=>interpretAmendment(input('第三项改90分钟'),plan(),'test-key',fake(patch([change('duration',90,'第三项改90分钟')]))),{code:'INVALID_AMENDMENT'});
});
test('replacement entities must be uniquely named visible entities, not model invented IDs',async()=>{
 const r=await interpretAmendment(input('场地换到弘金地，其他不动'),plan(),'test-key',fake(patch([change('venueId','hong','换到弘金地')])));
 assert.equal(r.plan.steps[0].operation.venueId,'hong');assert.equal(r.plan.steps[0].operation.note,plan().steps[0].operation.note);
 for(const [id,evidence] of [['foreign','弘金地'],['hong','场地换一下'],['riverside','弘金地']])await assert.rejects(()=>interpretAmendment(input(`场地换一下，弘金地`),plan(),'test-key',fake(patch([change('venueId',id,evidence)]))),{code:'INVALID_AMENDMENT'});
});
test('venue replacement accepts only a unique literal name after removing a generic tennis suffix',async()=>{
 for(const suffix of ['网球场','网球中心','网球训练中心','网球馆','网球俱乐部']){
  const i=input('场地换到青山，其他不动',{venues:[...context.venues,{id:'qingshan',name:'青山'+suffix,address:'青山路',court:'1号'}]});
  const r=await interpretAmendment(i,plan(),'test-key',fake(patch([change('venueId','qingshan','换到青山')])));
  assert.equal(r.plan.steps[0].operation.venueId,'qingshan');assert.equal(r.plan.steps[0].operation.note,plan().steps[0].operation.note);
 }
});
test('student can complete an incomplete booking using the undecorated name of an authorized example venue',async()=>{
 const text='明晚19点开始，练60分钟，场地选弘金地网球场，练习内容改成正手30球，注意早转肩。';
 const base=plan([operation({start:null,duration:null,venueId:null,note:null})]),before=JSON.stringify(base);
 const request=input(text,{role:'student',selfStudentId:'lin',currentCoachName:'示例 · 周教练',venues:[{id:'hong',name:'示例 · 弘金地网球场',address:'金地路2号',court:'2号'}]});
 const changes=[change('start','19:00','明晚19点开始'),change('duration',60,'练60分钟'),change('venueId','hong','场地选弘金地网球场'),change('note','正手30球，注意早转肩','练习内容改成正手30球，注意早转肩')];
 const result=await interpretAmendment(request,base,'test-key',fake(patch(changes))),expected=structuredClone(base);
 Object.assign(expected.steps[0].operation,{start:'19:00',duration:60,venueId:'hong',note:'正手30球，注意早转肩'});
 assert.equal(JSON.stringify(result.plan),JSON.stringify(expected));assert.equal(JSON.stringify(base),before);
 assert.deepEqual(result.meta.amendment.changedFields,[{stepId:'s1',fields:['start','duration','venueId','note']}]);
});
test('a model patch cannot silently omit an explicit booking training-note replacement',async()=>{
 const text='明晚19点开始，练60分钟，练习内容改成正手30球，注意早转肩。';
 const base=plan([operation({start:null,duration:null,note:'询问明晚是否可以约课'})]),before=JSON.stringify(base);
 await assert.rejects(()=>interpretAmendment(input(text),base,'test-key',fake(patch([change('start','19:00','明晚19点开始'),change('duration',60,'练60分钟')]))),{code:'INVALID_AMENDMENT'});
 assert.equal(JSON.stringify(base),before);
 const complete=await interpretAmendment(input(text),base,'test-key',fake(patch([change('start','19:00','明晚19点开始'),change('duration',60,'练60分钟'),change('note','正手30球，注意早转肩','练习内容改成正手30球，注意早转肩')])));
 assert.equal(complete.plan.steps[0].operation.note,'正手30球，注意早转肩');
});
test('booking-note completeness check respects explicit step selection, ambiguity and negative instructions',async()=>{
 const base=plan([operation(),operation({start:'18:00'})]);
 await assert.rejects(()=>interpretAmendment(input('第二项时长改90分钟，备注改成练反手'),base,'test-key',fake(patch([change('duration',90,'第二项时长改90分钟')],'s2'))),{code:'INVALID_AMENDMENT'});
 const complete=await interpretAmendment(input('第二项备注改成练反手'),base,'test-key',fake(patch([change('note','练反手','备注改成练反手')],'s2')));
 assert.deepEqual(complete.plan.steps[0],base.steps[0]);assert.equal(complete.plan.steps[1].operation.note,'练反手');
 const uncertain=await interpretAmendment(input('备注改成练反手'),base,'test-key',fake({status:'clarification',explanation:'原草稿保留',question:'要修改哪一项？',patches:[]}));
 assert.deepEqual(uncertain.plan,base);
 for(const text of ['只改成90分钟，备注不要改成练反手','只改成90分钟，如果有空再把备注改成练反手']){
  const unchanged=await interpretAmendment(input(text),plan(),'test-key',fake(patch([change('duration',90,'改成90分钟')])));
  assert.equal(unchanged.plan.steps[0].operation.note,plan().steps[0].operation.note);
 }
});
test('an explicit booking-note replacement cannot return stale text, but same-value requests and untouched notes remain exact',async()=>{
 const base=plan([operation({note:'询问明晚是否可以约课'})]),before=JSON.stringify(base);
 await assert.rejects(()=>interpretAmendment(input('练习内容改成正手30球，注意早转肩。'),base,'test-key',fake(patch([change('note',base.steps[0].operation.note,'练习内容改成正手30球，注意早转肩。')]))),{code:'INVALID_AMENDMENT'});
 assert.equal(JSON.stringify(base),before);
 const same=await interpretAmendment(input('备注改成询问明晚是否可以约课'),base,'test-key',fake(patch([change('note',base.steps[0].operation.note,'备注改成询问明晚是否可以约课')])));
 assert.deepEqual(same.plan,base);
 const duration=await interpretAmendment(input('只把时长改成90分钟，其他不动'),base,'test-key',fake(patch([change('duration',90,'时长改成90分钟')])));
 assert.equal(duration.plan.steps[0].operation.note,base.steps[0].operation.note);assert.equal(duration.plan.steps[0].operation.duration,90);
});
test('relative booking start shifts use the original draft arithmetic instead of the model result',async()=>{
 for(const [text,expected] of [['开始时间往后挪半小时，其他不变','15:30'],['开始时间提前30分钟，其他不变','14:30'],['往后挪45分钟','15:45']]){
  const base=plan([operation({duration:90})]),result=await interpretAmendment(input(text),base,'test-key',fake(patch([change('start','16:00',text.split('，')[0])])));
  const wanted=structuredClone(base);wanted.steps[0].operation.start=expected;assert.deepEqual(result.plan,wanted);assert.match(result.meta.amendment.explanation,new RegExp(expected));
 }
 const base=plan([operation(),operation({start:'18:00'})]),result=await interpretAmendment(input('第二项开始时间往后挪半小时'),base,'test-key',fake(patch([change('start','19:00','第二项开始时间往后挪半小时')],'s2')));
 assert.deepEqual(result.plan.steps[0],base.steps[0]);assert.equal(result.plan.steps[1].operation.start,'18:30');
});
test('relative start correction rejects missing anchors, midnight rollover and ambiguous targets, and does not parse note text',async()=>{
 for(const base of [plan([operation({start:null})]),plan([operation({start:'23:45'})]),plan([operation(),operation({start:'18:00'})])])
  await assert.rejects(()=>interpretAmendment(input('开始时间往后挪半小时'),base,'test-key',fake(patch([change('start','16:00','开始时间往后挪半小时')]))),{code:'INVALID_AMENDMENT'});
 await assert.rejects(()=>interpretAmendment(input('开始时间提前30分钟'),plan([operation({start:'00:15'})]),'test-key',fake(patch([change('start','23:45','开始时间提前30分钟')]))),{code:'INVALID_AMENDMENT'});
 const result=await interpretAmendment(input('备注改成往后挪半小时'),plan(),'test-key',fake(patch([change('note','往后挪半小时','备注改成往后挪半小时')])));
 assert.equal(result.plan.steps[0].operation.start,'15:00');assert.equal(result.plan.steps[0].operation.note,'往后挪半小时');
 await assert.rejects(()=>interpretAmendment(input('开始时间往后挪半小时，其他不变'),plan(),'test-key',fake(patch([change('start','16:00','其他不变')]))),{code:'INVALID_AMENDMENT'});
 await assert.rejects(()=>interpretAmendment(input('如果有空，开始时间往后挪半小时'),plan(),'test-key',fake(patch([change('start','16:00','开始时间往后挪半小时')]))),{code:'INVALID_AMENDMENT'});
 const negative=await interpretAmendment(input('不要把开始时间往后挪半小时，备注改成练反手'),plan(),'test-key',fake(patch([change('note','练反手','备注改成练反手')])));
 assert.equal(negative.plan.steps[0].operation.start,'15:00');
});
test('provider minute-valued times normalize only when literal clock evidence agrees',async()=>{
 const text='明晚19点开始，练60分钟，练习内容改成正手30球，注意早转肩。',base=plan([operation({start:null,duration:null,note:'询问明晚是否可约课'})]);
 const result=await interpretAmendment(input(text),base,'test-key',fake(patch([change('start',1140,'明晚19点开始'),change('duration',60,'练60分钟'),change('note','正手30球，注意早转肩','练习内容改成正手30球，注意早转肩')])));
 assert.equal(result.plan.steps[0].operation.start,'19:00');assert.equal(result.plan.steps[0].operation.duration,60);assert.equal(result.plan.steps[0].operation.note,'正手30球，注意早转肩');
 for(const value of [19,1440,-1,1140.5])await assert.rejects(()=>interpretAmendment(input('明晚19点开始'),base,'test-key',fake(patch([change('start',value,'明晚19点开始')]))),{code:'INVALID_AMENDMENT'});
 await assert.rejects(()=>interpretAmendment(input('时间改一下'),base,'test-key',fake(patch([change('start',1140,'时间改一下')]))),{code:'INVALID_AMENDMENT'});
 for(const evidence of ['19点半','19点一刻','19点三刻','19点30秒','19:00:30','19点零五分'])await assert.rejects(()=>interpretAmendment(input(evidence),base,'test-key',fake(patch([change('start',1140,evidence)]))),{code:'INVALID_AMENDMENT'});
 await assert.rejects(()=>interpretAmendment(input('19:00:30'),base,'test-key',fake(patch([change('start',30,'19:00:30')]))),{code:'INVALID_AMENDMENT'});
});
test('decorated venue amendment still requires a unique authorized match and literal name evidence in the request',async()=>{
 const venue={id:'hong',name:'示例 · 弘金地网球场',address:'金地路2号',court:'2号'};
 for(const [text,evidence,venues,id] of [
  ['场地选弘金地网球场','弘金地网球场',[venue,{...venue,id:'duplicate',name:'弘金地网球场'}],'hong'],
  ['场地改一下，弘金地网球场','场地改一下',[venue],'hong'],
  ['场地选弘金地北场','弘金地',[venue],'hong'],
  ['场地选弘金地网球场','弘金地网球场',[venue],'foreign'],
 ] as const){
  const base=plan([operation({venueId:null})]),before=JSON.stringify(base);
  await assert.rejects(()=>interpretAmendment(input(text,{role:'student',selfStudentId:'lin',venues:[...venues]}),base,'test-key',fake(patch([change('venueId',id,evidence)]))),{code:'INVALID_AMENDMENT'});
  assert.equal(JSON.stringify(base),before);
 }
});
test('shared venue matcher returns original scoped candidates and exposes reusable normalized aliases',()=>{
 const rows=[{id:'a',name:' 青山网球场 ',address:'甲'},{id:'b',name:'青山网球中心',address:'乙'},{id:'c',name:'青山北场网球场',address:'丙'}];
 assert.deepEqual(venueNames(rows[0].name),['青山网球场','青山']);assert.deepEqual(venueNames('山网球场'),['山网球场']);
 const ambiguous=matchingVenues('明天去青山约课',rows);assert.deepEqual(ambiguous.map(row=>row.id),['a','b']);assert.equal(ambiguous[0],rows[0]);
 for(const connector of ['换','换成','改为','改到','换到']){
  assert.deepEqual(matchingVenues('场地'+connector+'青山，其他保留。',rows).map(row=>row.id),['a','b']);
  assert.deepEqual(matchingVenues('场地'+connector+'青山北场，其他保留。',rows).map(row=>row.id),['c']);
  assert.deepEqual(matchingVenues('场地'+connector+'青山路，其他保留。',rows),[]);
 }
 for(const suffix of ['早上九点','上午十点','下午三点','晚上19点','中午十二点','九点','19:00'])assert.deepEqual(matchingVenues('下周六青山'+suffix,rows).map(row=>row.id),['a','b']);
 for(const suffix of ['北场','里程','路'])assert.ok(!matchingVenues('青山'+suffix,rows).some(row=>row.id==='a'||row.id==='b'));
 for(const suffix of ['了','吧','呢','啊']){assert.deepEqual(matchingVenues('不去青山网球场'+suffix,rows).map(row=>row.id),['a']);assert.deepEqual(matchingVenues('不去青山'+suffix,rows).map(row=>row.id),['a','b']);}
 assert.deepEqual(matchingVenues('去青山北场',rows).map(row=>row.id),['c']);assert.deepEqual(matchingVenues('去青山网球中心',rows).map(row=>row.id),['b']);assert.equal(rows.length,3);
});
test('venue aliases cannot remove directional names, match substrings or select among duplicate short names',async()=>{
 for(const [text,venues,id,evidence] of [
  ['换到青山',[...context.venues,{id:'a',name:'青山网球场'},{id:'b',name:'青山网球中心'}],'a','青山'],
  ['换到青山北场',[...context.venues,{id:'a',name:'青山网球场'}],'a','青山'],
  ['换到青山',[...context.venues,{id:'a',name:'青山北场网球场'}],'a','青山'],
  ['换到山',[...context.venues,{id:'a',name:'山网球场'}],'a','山'],
 ] as const){const i=input(text,{venues:venues.map(v=>({address:'地址',court:'1号',...v}))});await assert.rejects(()=>interpretAmendment(i,plan(),'test-key',fake(patch([change('venueId',id,evidence)]))),{code:'INVALID_AMENDMENT'});}
 const i=input('换到青山网球中心',{venues:[...context.venues,{id:'a',name:'青山网球场',address:'甲',court:'1'},{id:'b',name:'青山网球中心',address:'乙',court:'2'}]});
 assert.equal((await interpretAmendment(i,plan(),'test-key',fake(patch([change('venueId','b','青山网球中心')])))).plan.steps[0].operation.venueId,'b');
});
test('explicit clearing of booking or availability venue retains every other field and never clears the student',async()=>{
 for(const intent of ['booking','availability']){
  const base=plan([operation({intent,day:intent==='availability'?'六':null})]),expected=structuredClone(base);expected.steps[0].operation.venueId=null;
  const r=await interpretAmendment(input('场地还没定，清空场地选择'),base,'test-key',fake(patch([change('venueId',null,'清空场地选择')])));
  assert.equal(JSON.stringify(r.plan),JSON.stringify(expected));assert.deepEqual(r.meta.amendment.changedFields,[{stepId:'s1',fields:['venueId']}]);
 }
 await assert.rejects(()=>interpretAmendment(input('清空学员选择'),plan(),'test-key',fake(patch([change('studentId',null,'清空学员选择')]))),{code:'INVALID_AMENDMENT'});
});
test('uncertain or conditional venue statements and dependent venue references cannot be erased',async()=>{
 for(const text of ['场地还没定','如果下雨就清空场地选择'])await assert.rejects(()=>interpretAmendment(input(text),plan(),'test-key',fake(patch([change('venueId',null,text)]))),{code:'INVALID_AMENDMENT'});
 const base=plan([operation({intent:'add-venue',name:'新场地',venueId:null}),operation({venueId:null})]);base.steps[1].venueRef='s1';base.steps[1].dependsOn=['s1'];
 await assert.rejects(()=>interpretAmendment(input('第二项清空场地选择'),base,'test-key',fake(patch([change('venueId',null,'清空场地选择')],'s2'))),{code:'INVALID_AMENDMENT'});
});
test('repeated names and Latin prefix collisions do not authorize identity replacements',async()=>{
 const duplicate=input('换成小林',{students:[...context.students,{...context.students[0],id:'lin-2'}]});
 await assert.rejects(()=>interpretAmendment(duplicate,plan(),'test-key',fake(patch([change('studentId','lin','小林')]))),{code:'INVALID_AMENDMENT'});
 const english=input('换成Royce',{students:[...context.students,{...context.students[0],id:'roy',name:'Roy'},{...context.students[0],id:'royce',name:'Royce'}]});
 const r=await interpretAmendment(english,plan(),'test-key',fake(patch([change('studentId','royce','Royce')])));assert.equal(r.plan.steps[0].operation.studentId,'royce');
 await assert.rejects(()=>interpretAmendment(english,plan(),'test-key',fake(patch([change('studentId','roy','Royce')]))),{code:'INVALID_AMENDMENT'});
});
test('unknown longer Chinese names cannot be rebound through a substring evidence quote',async()=>{
 for(const [text,evidence] of [['换成小林子','小林'],['改成徐小林','小林'],['学员换成小林子','换成小林子']])await assert.rejects(()=>interpretAmendment(input(text),plan(),'test-key',fake(patch([change('studentId','lin',evidence)]))),{code:'INVALID_AMENDMENT'});
 const r=await interpretAmendment(input('换成小宇，其他不动'),plan(),'test-key',fake(patch([change('studentId','yu','小宇')])));assert.equal(r.plan.steps[0].operation.studentId,'yu');
});
test('old-place shorthand requires a verified latest completed lesson for this exact student',async()=>{
 const lessons=[...context.lessons,{...context.lessons[0],id:'last',date:'2026-10-30',venue:'hong',state:'done'}];
 const understanding=JSON.stringify({resolved:{studentId:'lin',venueId:'hong',venueBasis:'latest-completed-lesson',sourceLessonId:'last'}});
 const base=plan(),r=await interpretAmendment(input('还是原来那儿，其他不动',{lessons,understanding}),base,'test-key',fake(patch([change('venueId','hong','还是原来那儿')])));
 assert.equal(r.plan.steps[0].operation.venueId,'hong');assert.equal(r.plan.steps[0].operation.date,base.steps[0].operation.date);assert.equal(r.plan.steps[0].operation.duration,60);
});
test('old-place shorthand rejects missing, foreign, future, stale and conflicting history anchors',async()=>{
 const valid={...context.lessons[0],id:'last',date:'2026-10-30',venue:'hong',state:'done'},resolved={studentId:'lin',venueId:'hong',venueBasis:'latest-completed-lesson',sourceLessonId:'last'};
 for(const extra of [
  {understanding:undefined,lessons:[valid]},
  {understanding:JSON.stringify({resolved:{...resolved,studentId:'yu'}}),lessons:[valid]},
  {understanding:JSON.stringify({resolved}),lessons:[{...valid,date:'2026-11-02'}]},
  {understanding:JSON.stringify({resolved}),lessons:[{...valid,students:['yu']}]},
  {understanding:JSON.stringify({resolved}),lessons:[valid,{...valid,id:'later',date:'2026-10-31',venue:'riverside'}]},
  {understanding:JSON.stringify({resolved}),lessons:[valid,{...valid,id:'tie',venue:'riverside'}]},
 ])await assert.rejects(()=>interpretAmendment(input('还是原来那儿',extra),plan(),'test-key',fake(patch([change('venueId','hong','还是原来那儿')]))),{code:'INVALID_AMENDMENT'});
});
test('existing draft dependencies cannot be detached through a real entity replacement',async()=>{
 const base=plan([operation({intent:'add-venue',name:'新场地',venueId:null}),operation({venueId:null})]);base.steps[1].venueRef='s1';base.steps[1].dependsOn=['s1'];
 await assert.rejects(()=>interpretAmendment(input('第二项换到滨江'),base,'test-key',fake(patch([change('venueId','riverside','换到滨江')],'s2'))),{code:'INVALID_AMENDMENT'});
 assert.equal(base.steps[1].venueRef,'s1');
});
test('wrong value types and invalid calendar dates are rejected by merged plan validation',async()=>{
 for(const [field,value] of [['duration','90'],['duration',10000],['date','2026-11-31'],['start','25:00'],['note',false]])await assert.rejects(()=>interpretAmendment(input('改一下'),plan(),'test-key',fake(patch([change(String(field),value,'改一下')]))),{code:'INVALID_DRAFT'});
});
test('student scope cannot be widened by a patch or stale base before model call',async()=>{
 const i=input('换成小宇',{role:'student',selfStudentId:'lin'});
 await assert.rejects(()=>interpretAmendment(i,plan(),'test-key',fake(patch([change('studentId','yu','小宇')]))),{code:'INVALID_AMENDMENT'});
 let calls=0;await assert.rejects(()=>interpretAmendment(i,plan([operation({intent:'credit',amount:2})]),'test-key',async()=>{calls++;return reply(patch([change('amount',3,'小宇')]));}),{code:'INVALID_DRAFT'});assert.equal(calls,0);
});
test('student self-reference permits only the authenticated self record',async()=>{
 const i=input('给我自己约',{role:'student',selfStudentId:'lin'});
 const r=await interpretAmendment(i,plan(),'test-key',fake(patch([change('studentId','lin','我自己')])));assert.equal(r.plan.steps[0].operation.studentId,'lin');
});
test('clarification output cannot smuggle changes, lack a question or masquerade as an empty patch',async()=>{
 for(const raw of [{...patch([change('duration',90,'改一下')]),status:'clarification',question:'哪项？'},{status:'clarification',explanation:'问一下',question:null,patches:[]},{status:'patched',explanation:'修改',question:null,patches:[]}])await assert.rejects(()=>interpretAmendment(input('改一下'),plan(),'test-key',fake(raw)),{code:'INVALID_AMENDMENT'});
});
test('provider incomplete, refusal and malformed JSON preserve the base and make one call',async()=>{
 const responses=[reply(null,{status:'incomplete'}),reply(null,{output:[{type:'message',content:[{type:'refusal'}]}]}),new Response('not JSON'),reply(null,{output:[{type:'message',content:[{type:'output_text',text:'invalid JSON'}]}]})];
 const base=plan(),before=JSON.stringify(base);
 for(const response of responses){let calls=0;await assert.rejects(()=>interpretAmendment(input('90分钟'),base,'test-key',async()=>{calls++;return response;}));assert.equal(calls,1);assert.equal(JSON.stringify(base),before);}
});
test('provider errors are bounded and never expose private upstream text',async()=>{
 for(const [status,code] of [[400,'MODEL_CONFIGURATION'],[401,'MODEL_UNAVAILABLE'],[402,'MODEL_QUOTA'],[429,'MODEL_BUSY'],[503,'MODEL_UNAVAILABLE']] as const){let calls=0;await assert.rejects(()=>interpretAmendment(input('90分钟'),plan(),'test-key',async()=>{calls++;return new Response('private-provider-body',{status});}),(error:AssistantError)=>error.code===code&&!error.message.includes('private-provider-body'));assert.equal(calls,1);}
});
test('network failure and cancellation keep their existing explicit error contract',async()=>{
 await assert.rejects(()=>interpretAmendment(input('90分钟'),plan(),'test-key',async()=>{throw Error('network');}),{code:'MODEL_TIMEOUT'});
 const c=new AbortController();c.abort();await assert.rejects(()=>interpretAmendment(input('90分钟'),plan(),'test-key',async()=>{throw Error('cancelled');},c.signal),{code:'CANCELLED'});
});
test('understanding remains optional bounded data and the server base is serialized separately',async()=>{
 const request=input('90分钟',{understanding:JSON.stringify({resolved:{studentId:'lin'},tasks:['booking']})});let body!:ModelRequest;
 await interpretAmendment(request,plan(),'test-key',async(_url,init)=>{body=JSON.parse(String(init?.body));return reply(patch([change('duration',90,'90分钟')]));});
 const sent=JSON.parse(body.input);assert.equal(sent.input.context.understanding,request.context.understanding);assert.deepEqual(sent.basePlan,plan());assert.throws(()=>input('90分钟',{understanding:'x'.repeat(6001)}));
});
test('pure merge does not mutate even when a later patch field fails',()=>{
 const base=plan(),before=JSON.stringify(base);
 assert.throws(()=>mergeAmendment(patch([change('duration',90,'改90分钟'),change('amount',99,'改90分钟')]),base,input('改90分钟')));
 assert.equal(JSON.stringify(base),before);
});
test('new availability output canonicalizes only an unambiguous single weekday without mutating provider data',async()=>{
 for(const day of [null,'六']){
  const raw=plan([operation({intent:'availability',day,days:['六']})]),before=JSON.stringify(raw),expected=structuredClone(raw);expected.steps[0].operation.day='六';expected.steps[0].operation.days=null;
  assert.deepEqual(normalizeGeneratedPlan(raw),expected);assert.equal(JSON.stringify(raw),before);
  const r=await interpret(input('每周六开放'), 'test-key',fake(raw));assert.deepEqual(r.plan,expected);
 }
 const base=plan([operation({intent:'edit-base',days:['一','六']})]);assert.deepEqual(normalizeGeneratedPlan(base),base);
});
test('new student-edit output canonicalizes an unambiguous name alias without touching other fields',async()=>{
 for(const studentName of [null,'小安']){
  const raw=plan([operation({intent:'edit-student',name:'小安',studentName,goal:'上旋',next:'步法'})]),before=JSON.stringify(raw),expected=structuredClone(raw);
  expected.steps[0].operation.studentName='小安';expected.steps[0].operation.name=null;
  assert.deepEqual(normalizeGeneratedPlan(raw),expected);assert.equal(JSON.stringify(raw),before);
  assert.deepEqual((await interpret(input('小林改名小安，其他不动'),'test-key',async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(raw)}]}]})))).plan,expected);
 }
});
test('conflicting or oversized student-edit name aliases reject without retry or truncation',async()=>{
 for(const values of [{name:'小安',studentName:'小青'},{name:'甲'.repeat(21),studentName:null},{name:'乙'.repeat(60),studentName:null},{name:'   ',studentName:null}]){
  const raw=plan([operation({intent:'edit-student',...values})]),before=JSON.stringify(raw);let calls=0;
  assert.throws(()=>normalizeGeneratedPlan(raw),{code:'INVALID_DRAFT'});
  await assert.rejects(()=>interpret(input('修改姓名'),'test-key',async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(raw)}]}]}));}),{code:'INVALID_DRAFT'});
  assert.equal(calls,1);assert.equal(JSON.stringify(raw),before);
 }
});
test('student-edit canonicalization does not reinterpret names belonging to other operation types',()=>{
 for(const intent of ['add-student','add-venue','edit-venue','practice']){
  const raw=plan([operation({intent,name:'原本名称',studentName:null})]);assert.deepEqual(normalizeGeneratedPlan(raw),raw);
 }
});
test('amending a stored student-edit plan preserves legacy name fields instead of normalizing them',async()=>{
 const base=plan([operation({intent:'edit-student',name:'旧草稿别名',studentName:null,goal:'正手'})]),before=JSON.stringify(base),expected=structuredClone(base);
 expected.steps[0].operation.goal='移动步法';
 const r=await interpretAmendment(input('目标改成移动步法，其他不动'),base,'test-key',fake(patch([change('goal','移动步法','目标改成移动步法')])));
 assert.deepEqual(r.plan,expected);assert.equal(JSON.stringify(base),before);
});
test('conflicting or multiple availability weekdays fail instead of dropping a day or adding steps',async()=>{
 for(const override of [{day:'一',days:['六']},{day:null,days:['六','日']},{day:'六',days:['六','六']}]){
  let calls=0;await assert.rejects(()=>interpret(input('每周开放'), 'test-key',async()=>{calls++;return reply(plan([operation({intent:'availability',...override})]));}),{code:'INVALID_DRAFT'});assert.equal(calls,1);
 }
});
test('amending an old availability plan never normalizes untouched legacy day fields',async()=>{
 const base=plan([operation({intent:'availability',days:['六'],day:null,gap:15})]),expected=structuredClone(base);expected.steps[0].operation.gap=30;
 const r=await interpretAmendment(input('间隔改成30分钟'),base,'test-key',fake(patch([change('gap',30,'间隔改成30分钟')])));
 assert.equal(JSON.stringify(r.plan),JSON.stringify(expected));
});
