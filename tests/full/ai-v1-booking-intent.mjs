import assert from 'node:assert/strict';
import {control,request,ok,wpath,dbSnapshot,countModel,provision,modelContext,transaction,op,plan,commit,snapshot,addDate,test,stop} from './base.mjs';
const generate=(f,text,who=f.studentA,extra={})=>request(who,wpath(f,'plans/generate'),'POST',{text,...extra});
async function label(f){await provision.query('UPDATE app.workspaces SET name=$2 WHERE id=$1',[f.A,'示例 · 甲教练']);}
const allClarification=p=>p.steps.every(s=>s.operation.intent==='clarification');
try{
 await test('BREQ-01','当前教练显示名来自RLS投影，学员仍仅本人资料',async(f,c)=>{
  await label(f);const ctx=await transaction(f.studentA,f.A,(db,m)=>modelContext(db,m,f.studentA,f.A,'明晚有空吗'));
  assert.equal(ctx.input.context.currentCoachName,'示例 · 甲教练');assert.deepEqual(ctx.input.context.students.map(s=>s.id),[f.a]);assert.equal(ctx.input.context.selfStudentId,f.a);assert.ok(!JSON.stringify(ctx.input).includes('TEST_B_PRIVATE_781'));
  c.push({currentCoachName:ctx.input.context.currentCoachName,selfStudentId:ctx.input.context.selfStudentId});
 });
 await test('BREQ-02','真实模型明晚有空吗生成本人待补齐申请，不猜时间或自动发送',async(f,c)=>{
  await label(f);control({live:true});const before=await dbSnapshot(),reply=ok(await generate(f,'明晚有空吗？'));
  assert.equal(reply.plan.steps.length,1);const d=reply.plan.steps[0].operation;assert.equal(d.intent,'booking');assert.equal(d.studentId,f.a);assert.equal(d.date,addDate(1));for(const k of ['start','duration','venueId'])assert.equal(d[k],null,k);assert.deepEqual(await dbSnapshot(),before);
  const rejected=await request(f.studentA,wpath(f,`plans/${reply.id}/commit`),'POST',{});assert.equal(rejected.status,400);assert.deepEqual(await dbSnapshot(),before);c.push({plan:reply.plan,incompleteCommit:rejected.body});
 });
 await test('BREQ-03','真实模型帮我问当前教练转成内部预约草稿',async(f,c)=>{
  await label(f);control({live:true});const before=await dbSnapshot(),reply=ok(await generate(f,'帮我问一下甲教练明晚是否可以约课。'));
  assert.equal(reply.plan.steps.length,1);const d=reply.plan.steps[0].operation;assert.equal(d.intent,'booking');assert.equal(d.studentId,f.a);assert.equal(d.date,addDate(1));for(const k of ['start','duration','venueId'])assert.equal(d[k],null,k);assert.deepEqual(await dbSnapshot(),before);c.push(reply.plan);
 });
 await test('BREQ-04','未知和其他教练不误投当前教练，明确外发不冒充站内申请',async(f,c)=>{
  await label(f);const before=await dbSnapshot();for(const text of ['帮我问乙教练明晚能不能约课','帮我问某某教练明晚是否可以约课','帮我问其他教练明晚有空吗','帮我给甲教练发微信问明晚能不能约课']){
   const n=countModel(),reply=ok(await generate(f,text));assert.ok(allClarification(reply.plan),text);assert.equal(countModel(),n,text);assert.deepEqual(await dbSnapshot(),before);c.push({text,plan:reply.plan});
  }
 });
 await test('BREQ-05','真实模型预约经确认进入正确教练收件箱，接受后学员可见且不扣课时',async(f,c)=>{
  await label(f);control({live:true});const before=await dbSnapshot(),reply=ok(await generate(f,'帮我问甲教练明天晚上七点在甲网球场能不能上一小时私教课。'));
  const d=reply.plan.steps[0].operation;assert.equal(reply.plan.steps.length,1);assert.equal(d.intent,'booking');assert.equal(d.studentId,f.a);assert.equal(d.date,addDate(1));assert.equal(d.start,'19:00');assert.equal(d.duration,60);assert.equal(d.venueId,f.va);assert.deepEqual(await dbSnapshot(),before);
  const applied=ok(await request(f.studentA,wpath(f,`plans/${reply.id}/commit`),'POST',{}));const teacher=await snapshot(f),added=teacher.records.filter(r=>!before.some(x=>x.id===r.id)),lesson=added.find(r=>r.kind==='lesson'),message=added.find(r=>r.kind==='message'&&r.payload.kind==='booking');
  assert.ok(lesson&&message);assert.equal(lesson.studentId,f.a);assert.equal(lesson.payload.state,'pending');assert.equal(message.lessonId,lesson.id);assert.equal(message.payload.state,'pending');assert.equal((await provision.query('SELECT workspace_id FROM app.records WHERE id=$1',[message.id])).rows[0].workspace_id,f.A);
  const other=await snapshot(f,f.coachB,'B');assert.ok(!other.records.some(r=>r.id===message.id||r.id===lesson.id));assert.equal((await request(f.studentB,wpath(f,'records/'+message.id))).status,404);const once=await dbSnapshot();assert.deepEqual(ok(await request(f.studentA,wpath(f,`plans/${reply.id}/commit`),'POST',{})),applied);assert.deepEqual(await dbSnapshot(),once);
  const confirmed=ok(await commit(f,plan(op('message-decision',{messageId:message.id,decision:'accept'}))));const learner=await snapshot(f,f.studentA);assert.equal(learner.records.find(r=>r.id===lesson.id).payload.state,'confirmed');assert.equal(learner.records.find(r=>r.id===message.id).payload.state,'accepted');
  assert.deepEqual((await dbSnapshot()).filter(r=>r.kind==='ledger'),before.filter(r=>r.kind==='ledger'));c.push({plan:reply.plan,applied,confirmed,lessonId:lesson.id,messageId:message.id,recipient:'甲教练'});
 });
 await test('BREQ-06','明确只读或不要申请时不能产生预约',async(f,c)=>{
  await label(f);const before=await dbSnapshot();for(const text of ['查一下明晚有哪些可约时间，先不要发申请','只看看甲教练明晚有没有空，不要预约','查一下明晚有哪些可约时间','先别约，我只是想看看时间','把甲教练明晚的空档列出来']){const n=countModel(),reply=ok(await generate(f,text));assert.ok(allClarification(reply.plan));assert.equal(countModel(),n);assert.deepEqual(await dbSnapshot(),before);assert.match(reply.plan.steps[0].operation.explanation,/只查看空档/);c.push({text,plan:reply.plan});}
 });
 await test('BREQ-07','浏览器不能伪造当前教练，异教练请求仍受成员权限约束',async(f,c)=>{
  await label(f);const before=await dbSnapshot();for(const extra of [{currentCoachName:'乙教练'},{context:{currentCoachName:'乙教练'}}])assert.equal((await generate(f,'明晚有空吗',f.studentA,extra)).status,400);
  assert.equal((await request(f.studentC,wpath(f,'plans/generate'),'POST',{text:'帮我问甲教练明晚有空吗'})).status,404);assert.deepEqual(await dbSnapshot(),before);c.push({forgedLabelRejected:true,unlinkedStudentRejected:true});
 });
 await test('BREQ-08','教练视角的空闲询问不自动替某位学员约课',async(f,c)=>{
  await label(f);const before=await dbSnapshot(),n=countModel(),reply=ok(await generate(f,'明晚有空吗',f.coachA));assert.ok(allClarification(reply.plan));assert.equal(countModel(),n);assert.deepEqual(await dbSnapshot(),before);c.push(reply.plan);
 });
}finally{await stop();}
