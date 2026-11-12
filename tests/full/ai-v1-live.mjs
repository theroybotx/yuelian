import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {control,request,ok,wpath,dbSnapshot,countModel,rec,date,addDate,test as baseTest,stop,provision} from './base.mjs';
const selectedCases=process.env.YUELIAN_LIVE_CASES?.split(',');
if(selectedCases?.some(id=>!/^V1-LIVE-0[1-8]$/.test(id)))throw Error('Unknown live case');
const test=(id,name,fn)=>!selectedCases||selectedCases.includes(id)?baseTest(id,name,fn):Promise.resolve();
const generate=(f,body,who=f.coachA)=>request(who,wpath(f,'plans/generate'),'POST',body);
try{
 await test('V1-LIVE-01','真实模型连续三轮仅改时长和时间，手工备注完整保留',async f=>{control({live:true});const before=await dbSnapshot(),first=ok(await generate(f,{text:'帮小王后天下午3点在甲网球场约一小时，训练内容正手转肩'}));assert.equal(first.plan.steps[0].operation.intent,'booking');const reviewedPlan=structuredClone(first.plan);reviewedPlan.steps[0].operation.note='手改：正手30球\n  不改写标点 100%';const second=ok(await generate(f,{taskId:first.id,text:'时长改90分钟，其他不动',reviewedPlan}));const expected=structuredClone(reviewedPlan);expected.steps[0].operation.duration=90;assert.deepEqual(second.plan,expected);const third=ok(await generate(f,{taskId:second.id,text:'开始时间往后挪半小时，其他不变'}));expected.steps[0].operation.start='15:30';assert.deepEqual(third.plan,expected);assert.deepEqual(await dbSnapshot(),before);});
 await test('V1-LIVE-02','真实模型历史消歧续答恢复完整两任务',async f=>{control({live:true});const lesson=await rec(f.A,'lesson',{date:addDate(-1),start:900,duration:60,state:'done',topic:'历史课'},{student:f.b,venue:f.va2});await rec(f.A,'participant',{}, {student:f.b,lesson});const before=await dbSnapshot(),n=countModel();const first=ok(await generate(f,{text:'给小王登记已购买的2课时，再给小李明天下午3点在老地方约一小时'}));assert.equal(first.plan.steps[0].operation.intent,'clarification');assert.equal(countModel(),n);const second=ok(await generate(f,{taskId:first.id,text:'小李',resolution:{field:'selectedStudent',id:f.b}}));assert.deepEqual(second.plan.steps.map(s=>s.operation.intent),['credit','booking']);assert.equal(second.plan.steps[0].operation.studentId,f.a);assert.equal(second.plan.steps[0].operation.amount,2);assert.equal(second.plan.steps[1].operation.studentId,f.b);assert.equal(second.plan.steps[1].operation.venueId,f.va2);assert.equal(second.plan.steps[1].operation.date,addDate(1));assert.equal(second.plan.steps[1].operation.start,'15:00');assert.deepEqual(await dbSnapshot(),before);});
 await test('V1-LIVE-03','真实模型日期练习草稿经确认保存昨天',async f=>{control({live:true});const first=ok(await generate(f,{text:'记一下我昨天练了20分钟发球，抛球不稳，不分享'},f.studentA));assert.equal(first.plan.steps[0].operation.intent,'practice');assert.equal(first.plan.steps[0].operation.date,addDate(-1));const applied=ok(await request(f.studentA,wpath(f,`plans/${first.id}/commit`),'POST',{}));const record=(await dbSnapshot()).find(r=>r.id===applied.results[0].id);assert.equal(record.payload.date,addDate(-1));assert.equal(record.visibility,'private');});
 await test('V1-LIVE-04','真实模型查询指定学员统计保留筛选对象',async f=>{control({live:true});const first=ok(await generate(f,{text:'统计小李这个月上了多少课'}));assert.equal(first.plan.steps[0].operation.intent,'summary');assert.equal(first.plan.steps[0].operation.studentId,f.b);assert.equal(first.plan.steps[0].operation.month,date.slice(0,7));const result=ok(await request(f.coachA,wpath(f,`plans/${first.id}/commit`),'POST',{}));assert.equal(result.results[0].studentId,f.b);});
 await test('V1-LIVE-05','金额充值不是课时，未完成和半节不误消课',async f=>{control({live:true});const before=await dbSnapshot();for(const text of ['给小王充值800元','这节先记着，下次补','扣半节就行']){const p=ok(await generate(f,{text,selection:{selectedStudent:f.a,selectedLesson:f.confirmed}}));assert.ok(p.plan.steps.every(s=>s.operation.intent==='clarification'),text);assert.deepEqual(await dbSnapshot(),before);}});
 await test('V1-LIVE-06','真实模型无历史候选续答不丢登记课时和约课',async f=>{control({live:true});const before=await dbSnapshot(),n=countModel();const first=ok(await generate(f,{text:'给小王登记已购买的2课时，另外给小李明天在老地方约15点到16点'}));const second=ok(await generate(f,{taskId:first.id,text:'小李',resolution:{field:'selectedStudent',id:f.b}}));assert.equal(second.meta.understanding.clarification.field,'venueId');assert.equal(countModel(),n);const third=ok(await generate(f,{taskId:second.id,text:'甲第二场',resolution:{field:'venueId',id:f.va2}}));assert.deepEqual(third.plan.steps.map(s=>s.operation.intent),['credit','booking']);assert.equal(third.plan.steps[0].operation.studentId,f.a);assert.equal(third.plan.steps[0].operation.amount,2);assert.equal(third.plan.steps[1].operation.studentId,f.b);assert.equal(third.plan.steps[1].operation.venueId,f.va2);assert.equal(third.plan.steps[1].operation.date,addDate(1));assert.equal(third.plan.steps[1].operation.start,'15:00');assert.equal(third.plan.steps[1].operation.duration,60);writeFileSync(process.env.YUELIAN_TEST_OUTPUT+'/multi-turn-plan.json',JSON.stringify({first,second,third},null,2));assert.deepEqual(await dbSnapshot(),before);});

 await test('V1-LIVE-07','真实模型改名后确认写入，训练目标和下次重点保留',async(f,c)=>{
  control({live:true});const before=await dbSnapshot(),old=before.find(r=>r.id===f.a);
  const generated=ok(await generate(f,{text:'小王的姓名改成小安，目标和下次重点不变。'}));
  assert.equal(generated.plan.steps.length,1);assert.equal(generated.plan.steps[0].operation.intent,'edit-student');assert.equal(generated.plan.steps[0].operation.studentId,f.a);assert.equal(generated.plan.steps[0].operation.studentName,'小安');assert.deepEqual(await dbSnapshot(),before);
  const applied=ok(await request(f.coachA,wpath(f,`plans/${generated.id}/commit`),'POST',{}));
  const stored=(await dbSnapshot()).find(r=>r.id===f.a);
  assert.deepEqual(stored.payload,{...old.payload,name:'小安'});assert.equal(stored.revision,old.revision+1);
  c.push({plan:generated.plan,provider:generated.meta,applied,old:old.payload,stored:stored.payload});
 });
 await test('V1-LIVE-08','真实学生问句补齐带示例前缀场地后，只改时长保留其余草稿',async(f,c)=>{
  await provision.query('UPDATE app.workspaces SET name=$2 WHERE id=$1',[f.A,'示例 · 甲教练']);
  await provision.query("UPDATE app.records SET payload=jsonb_set(payload,'{name}',to_jsonb($2::text)) WHERE id=$1",[f.va,'示例 · 弘金地网球场']);
  control({live:true});const before=await dbSnapshot();
  const first=ok(await generate(f,{text:'帮我问甲教练明晚是否可以约课。'},f.studentA));
  assert.equal(first.plan.steps.length,1);assert.equal(first.plan.steps[0].operation.intent,'booking');assert.equal(first.plan.steps[0].operation.studentId,f.a);assert.equal(first.plan.steps[0].operation.date,addDate(1));
  for(const field of ['start','duration','venueId'])assert.equal(first.plan.steps[0].operation[field],null);
  const second=ok(await generate(f,{taskId:first.id,text:'明晚19点开始，练60分钟，场地选弘金地网球场，练习内容改成正手30球，注意早转肩。'},f.studentA));
  const d=second.plan.steps[0].operation;assert.equal(second.plan.steps.length,1);assert.equal(d.studentId,f.a);assert.equal(d.date,addDate(1));assert.equal(d.start,'19:00');assert.equal(d.duration,60);assert.equal(d.venueId,f.va);assert.match(d.note,/正手30球/);assert.match(d.note,/注意早转肩/);
  const reviewedPlan=structuredClone(second.plan);reviewedPlan.steps[0].operation.note='手工核对：正手30球，注意早转肩。\n其他内容保持原样 100%';
  const third=ok(await generate(f,{taskId:second.id,text:'只把时长改成90分钟，其余不动。',reviewedPlan},f.studentA));
  const expected=structuredClone(reviewedPlan);expected.steps[0].operation.duration=90;assert.deepEqual(third.plan,expected);assert.deepEqual(await dbSnapshot(),before);
  c.push({first:first.plan,second:second.plan,third:third.plan,noBusinessWrites:true});
 });
}finally{await stop();}
