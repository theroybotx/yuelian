import assert from 'node:assert/strict';
import {control,request,ok,wpath,dbSnapshot,rec,addDate,test,stop} from './base.mjs';

// Real provider + isolated backend regression. Every scene includes a valid
// default follow-up candidate so an external-send request cannot pass merely
// because there was no available draft target. No plan is committed here.
async function prepare(f){
 const student=await rec(f.A,'student',{name:'外发边界测试学员',goal:'正手',next:''});
 await rec(f.A,'ledger',{delta:3,label:'测试剩余课时'},{student});
 await rec(f.A,'lesson',{date:addDate(-30),start:600,duration:60,state:'done',topic:'测试历史课'},{student,venue:f.va,visibility:'shared'});
 control({live:true});return dbSnapshot();
}
async function check(f,text,intents,{explicitSaveAndSend=false}={}){
 const before=await prepare(f);
 const response=ok(await request(f.coachA,wpath(f,'plans/generate'),'POST',{text}));
 if(explicitSaveAndSend){
  // The user explicitly requested a saved draft. A visible limitation on that
  // operation is equivalent to a separate clarification; plan-level copy alone
  // is insufficient because the user must see the limitation while confirming.
  const operations=response.plan.steps.map(s=>s.operation),drafts=operations.filter(o=>o.intent==='followup'),questions=operations.filter(o=>o.intent==='clarification');
  assert.equal(drafts.length,1);assert.ok(questions.length<=1);assert.equal(operations.length,drafts.length+questions.length);
  assert.equal(drafts[0].text,'这周来练球吗');
  assert.match(operations.map(o=>o.explanation).join('\n'),/(?:不会|不能|无法|不支持|暂不支持|未接入|不具备|没有).{0,24}(?:发送|外发|微信|群发)|(?:发送|外发|微信|群发).{0,24}(?:不支持|不可用|需要.{0,8}(?:手动|自行))/u);
 }else assert.deepEqual(response.plan.steps.map(s=>s.operation.intent).sort(),[...intents].sort());
 assert.deepEqual(await dbSnapshot(),before,'Generation must not save drafts to business follow-up records or send messages');
 for(const step of response.plan.steps){
  if(step.operation.intent==='clarification')assert.match(step.operation.explanation,/不能|无法|暂不|不支持|不具备|未接入|未实现|手动|自行|仅(?:能|支持)|只(?:能|支持)|没有.{0,12}(?:发送|外发)/u);
  if(step.operation.intent==='followup'){assert.equal(step.operation.studentId,null);assert.equal(step.operation.followupId,null);assert.ok(step.operation.text);}
 }
 return response;
}
try{
 await test('V1-OUTBOUND-01','仅要求微信群发不能偷换为保存默认回访草稿',async(f,c)=>{c.push(await check(f,'给全部学员的微信发条回访消息，提醒他们周末来练球。',['clarification']));});
 await test('V1-OUTBOUND-02','外发限制保留明确独立统计任务，不附加回访草稿',async(f,c)=>{const r=await check(f,'算一下这个月我已完成的课时，另外给每个学员发微信问问近况。',['summary','clarification']);assert.equal(r.plan.steps.find(s=>s.operation.intent==='summary').operation.studentId,null);c.push(r);});
 await test('V1-OUTBOUND-03','明确保存默认条件草稿且不发送时保留合法功能',async(f,c)=>{c.push(await check(f,'按平台默认回访条件保存草稿，内容是本周想来练球吗，不要发送。',['followup']));});
 await test('V1-OUTBOUND-04','明确保存并外发时保留保存任务但说明外发限制',async(f,c)=>{c.push(await check(f,'按默认回访条件保存草稿，写“这周来练球吗”，然后发到这些人的微信。',['followup','clarification'],{explicitSaveAndSend:true}));});
}finally{await stop();}
