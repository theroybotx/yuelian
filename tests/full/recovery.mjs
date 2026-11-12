import assert from 'node:assert/strict';
import pg from '../../server/node_modules/pg/lib/index.js';
import {writeFileSync} from 'node:fs';
import {OUT,db,pool,provision,transaction,op,plan,request,ok,denied,wpath,snapshot,seed,test,results,child,stop} from './base.mjs';
const credit=f=>plan(op('credit',{studentId:f.a,amount:2,note:'恢复验收购课'}));
const prepare=async(f,p=credit(f),actor=f.coachA)=>{const s=await snapshot(f,actor);return request(actor,wpath(f,'plans'),'POST',{plan:p,revisions:Object.fromEntries(s.records.map(r=>[r.id,r.revision])),submission:true});};
const execute=(f,id,actor=f.coachA)=>request(actor,wpath(f,`plans/${id}/commit`),'POST',{});
const ack=(f,id,actor=f.coachA)=>request(actor,wpath(f,`plans/${id}/acknowledge`),'POST',{});
const count=async f=>Number((await provision.query("SELECT count(*) FROM app.records WHERE workspace_id=$1 AND kind='ledger' AND payload->>'label'='恢复验收购课'",[f.A])).rows[0].count);
try{
 await test('REC-01','Lost draft response recovers its server ID and blocks a new attempt',async f=>{
  const original=ok(await prepare(f)); // Simulate caller losing this response.
  const s=await snapshot(f);assert.equal(s.submission.id,original.id);assert.equal(s.submission.state,'pending');
  assert.equal((await prepare(f)).body.code,'SUBMISSION_PENDING');assert.equal(await count(f),0);
  const result=ok(await execute(f,s.submission.id));assert.equal(result.results[0].balance,12);assert.equal(await count(f),1);
  assert.equal((await snapshot(f)).submission.state,'committed');ok(await ack(f,original.id));assert.equal((await snapshot(f)).submission,null);
 });
 await test('REC-02','Lost commit response and concurrent retries apply once; later intentional purchase remains possible',async f=>{
  const d=ok(await prepare(f));ok(await execute(f,d.id));const receipt=(await snapshot(f)).submission;
  assert.equal(receipt.state,'committed');const retries=await Promise.all([execute(f,receipt.id),execute(f,receipt.id)]);retries.forEach(ok);assert.deepEqual(retries[0].body,retries[1].body);assert.equal(await count(f),1);
  ok(await ack(f,d.id));ok(await ack(f,d.id));const next=ok(await prepare(f));assert.notEqual(next.id,d.id);ok(await execute(f,next.id));assert.equal(await count(f),2);
 });
 await test('REC-03','Submission recovery never crosses actor or workspace boundaries',async f=>{
  const d=ok(await prepare(f));assert.equal((await snapshot(f,f.adminA)).submission,null);assert.equal((await snapshot(f,f.coachB,'B')).submission,null);
  assert.equal((await execute(f,d.id,f.adminA)).status,404);assert.equal((await ack(f,d.id,f.adminA)).status,404);
  assert.equal((await request(f.coachB,wpath(f,`plans/${d.id}/acknowledge`,'B'),'POST',{})).status,404);assert.equal(await count(f),0);
 });
 await test('REC-04','Cancellation permanently prevents a delayed commit',async f=>{
  const d=ok(await prepare(f));assert.equal(ok(await ack(f,d.id)).status,'cancelled');assert.equal((await execute(f,d.id)).body.code,'CANCELLED_PLAN');assert.equal(await count(f),0);assert.equal((await snapshot(f)).submission,null);ok(await prepare(f));
 });
 await test('REC-05','Changed permissions and expired drafts cannot be resumed or reveal saved data',async f=>{
  const d=ok(await prepare(f,plan(op('booking',{studentId:f.a,venueId:f.va,date:'2099-01-01',start:'15:00',duration:60,note:'PRIVATE_RECOVERY_MARKER'})),f.assistant));
  await provision.query('UPDATE app.memberships SET revision=revision+1,permissions=$2 WHERE user_id=$1',[f.assistant.id,['students.read']]);
  const s=await snapshot(f,f.assistant);assert.equal(s.submission.state,'unavailable');assert.deepEqual(s.submission.actions,[]);assert.ok(!JSON.stringify(s.submission).includes('PRIVATE_RECOVERY_MARKER'));denied(await execute(f,d.id,f.assistant));ok(await ack(f,d.id,f.assistant));
  const expired=ok(await prepare(f));await provision.query("UPDATE app.plans SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.id]);assert.equal((await snapshot(f)).submission.state,'expired');assert.equal((await execute(f,expired.id)).body.code,'STALE_PLAN');ok(await ack(f,expired.id));assert.equal(await count(f),0);
 });
 await test('REC-06','A pending receipt is discoverable after reload in a nondefault workspace',async f=>{
  const s=await snapshot(f,f.studentA,'B'),p=plan(op('practice',{name:'恢复练习',text:'一次',shared:false}));
  const d=ok(await request(f.studentA,wpath(f,'plans','B'),'POST',{plan:p,revisions:Object.fromEntries(s.records.map(r=>[r.id,r.revision])),submission:true}));
  const list=ok(await request(f.studentA,'/v1/workspaces'));assert.equal(list.workspaces.find(w=>w.id===f.B).pending_submission,true);assert.equal(list.workspaces.find(w=>w.id===f.A).pending_submission,false);assert.equal((await snapshot(f,f.studentA,'B')).submission.id,d.id);
 });
 await test('REC-07','Commit versus cancellation race has exactly one durable outcome',async f=>{
  const d=ok(await prepare(f));const [commit,cancel]=await Promise.all([execute(f,d.id),ack(f,d.id)]);ok(cancel);
  if(cancel.body.status==='cancelled'){assert.equal(commit.status,409);assert.equal(await count(f),0);}else{ok(commit);assert.equal(cancel.body.status,'committed');assert.equal(await count(f),1);}assert.equal((await snapshot(f)).submission,null);
 });
 await test('REC-08','Database outage fails closed and the same HTTP process recovers',async(f,checks)=>{
  const d=ok(await prepare(f)),pid=child.pid,admin=new pg.Client({host:'/tmp',user:process.env.YUELIAN_TEST_ADMIN||process.env.USER,database:'postgres'});await admin.connect();
  let offline,generation,submission;try{await admin.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS false`);await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename='yuelian_runtime'",[db]);offline=await request(f.coachA,wpath(f,'snapshot'));generation=await request(f.coachA,wpath(f,'plans/generate'),'POST',{text:'查询当前剩余课时'});submission=await execute(f,d.id);}finally{await admin.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true`);await admin.end();}
  for(const response of [offline,generation,submission]){assert.equal(response.status,503);assert.equal(response.body.code,'DATABASE_UNAVAILABLE');assert.ok(!response.body.records);}
  assert.equal(offline.body.error,'数据连接暂时中断，请稍后重新连接。');assert.ok(!offline.body.error.includes('未确认'));assert.equal(generation.body.error,'暂时无法生成操作，请稍后重试。业务资料尚未执行修改。');assert.ok(!generation.body.error.includes('未确认'));assert.equal(submission.body.error,'数据连接暂时中断，提交结果尚未确认。恢复后请核对原操作。');assert.equal(await count(f),0);assert.equal(child.exitCode,null);assert.equal(child.pid,pid);
  const restored=await snapshot(f);assert.equal(restored.submission.id,d.id);ok(await execute(f,d.id));ok(await execute(f,d.id));assert.equal(await count(f),1);checks.push({samePid:pid,offline:503,generation:503,submission:503,readError:offline.body.error,generationError:generation.body.error,writeError:submission.body.error,restored:200,ledgerRows:1});
 });
 await test('REC-09','Broken in-flight transaction rolls back, discards its connection, and preserves isolation',async f=>{
  let ready,release;const connected=new Promise(r=>ready=r),wait=new Promise(r=>release=r);
  const attempted=transaction(f.coachA,f.A,async c=>{await c.query("UPDATE app.records SET payload=jsonb_set(payload,'{goal}','\"must rollback\"') WHERE id=$1",[f.a]);ready(c.processID);await wait;await c.query('SELECT 1');});
  const pid=await connected;const failed=assert.rejects(attempted);await provision.query('SELECT pg_terminate_backend($1)',[pid]);release();await failed;
  assert.equal((await snapshot(f)).records.find(r=>r.id===f.a).payload.goal,'正手');
  await transaction(f.coachB,f.B,async c=>{assert.equal((await c.query('SELECT 1 FROM app.records WHERE id=$1',[f.a])).rowCount,0);});
 });
}finally{writeFileSync(OUT+'/recovery-results.json',JSON.stringify({database:db,productionDataTouched:false,results},null,2));await stop();console.log(JSON.stringify({passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length}));if(results.some(r=>r.status==='failed'))process.exitCode=1;}
