import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {op,plan,control,date,addDate,request,ok,denied,wpath,snapshot,draft,commit,rec,test,stop,provision,db,ROOT,dbSnapshot,countModel} from './base.mjs';

const all=['booking','record','availability','add-student','edit-student','credit','balance','summary','message-decision','resolve-message','add-venue','edit-venue','edit-base','edit-lesson','followup','practice','edit-practice'];
const staffAllowed=all.filter(x=>!['practice','edit-practice'].includes(x));
const assistantAllowed=['booking','availability','summary','message-decision','resolve-message','edit-base','edit-lesson'];
const studentAllowed=['booking','balance','summary','message-decision','resolve-message','practice','edit-practice'];
async function operations(f,who){
 const m=await rec(f.A,'message',{kind:'status',state:'pending',title:'角色测试',text:'仅当前关系'},{student:f.a,visibility:'shared'});
 const values={booking:{studentId:f.a,venueId:f.va,date:addDate(2),start:'15:00',duration:60},record:{lessonId:f.confirmed,duration:60,observation:'test'},availability:{venueId:f.va,from:date,to:addDate(30),day:'一',start:'09:00',end:'20:00',gap:0},'add-student':{studentName:'新学生'},'edit-student':{studentId:f.a,goal:'变更'},credit:{studentId:f.a,amount:2,note:'已购'},balance:{studentId:f.a},summary:{month:date.slice(0,7)},'message-decision':{messageId:who===f.studentA?f.proposalMessage:f.bookingMessage,decision:'accept'},'resolve-message':{messageId:m},'add-venue':{name:'新场',address:'测试地址',court:'1',indoor:false},'edit-venue':{venueId:f.va,address:'新地址'},'edit-base':{days:['一'],start:'09:00',end:'21:00',travel:0},'edit-lesson':{lessonId:f.confirmed,duration:45,note:'改课'},followup:{text:'回访'},practice:{name:'练习',text:'记录',shared:false},'edit-practice':{practiceId:f.practicePrivate,name:'修改',text:'记录',shared:false}};
 return values;
}
try{
 for(const [role,allowed] of [['coachA',staffAllowed],['adminA',staffAllowed],['assistant',assistantAllowed],['studentA',studentAllowed]])await test('permissions-'+role,'All 17 actions match the '+role+' permission contract',async(f,checks)=>{
  const who=f[role],values=await operations(f,who),s=await snapshot(f,who),revisions=Object.fromEntries(s.records.map(r=>[r.id,r.revision]));const before=await dbSnapshot();
  for(const intent of all){const r=await request(who,wpath(f,'plans'),'POST',{plan:plan(op(intent,values[intent])),revisions});
   if(allowed.includes(intent))assert.equal(r.status,200,intent+' '+JSON.stringify(r.body));else assert.ok([400,403].includes(r.status),intent+' '+JSON.stringify(r.body));checks.push({intent,allowed:allowed.includes(intent),status:r.status});
  }
  assert.deepEqual(await dbSnapshot(),before);
 },['SEC-06','REL-12']);
 await test('permissions-readonly','Read-only assistant cannot mutate through any action',async(f,checks)=>{
  await provision.query('UPDATE app.memberships SET permissions=$2,revision=revision+1 WHERE user_id=$1',[f.assistant.id,['schedule.read','venues.read']]);
  const values=await operations(f,f.assistant),s=await snapshot(f,f.assistant),revisions=Object.fromEntries(s.records.map(r=>[r.id,r.revision]));
  for(const intent of all){const r=await request(f.assistant,wpath(f,'plans'),'POST',{plan:plan(op(intent,values[intent])),revisions});assert.equal(r.status,intent==='summary'?200:['practice','edit-practice'].includes(intent)?400:403,intent+' '+JSON.stringify(r.body));checks.push({intent,status:r.status});}
 },['SEC-06','NAV-03']);
 await test('permission-record-combination','Attendance requires every stated capability, even if ledger.write remains',async(f,checks)=>{
  const required=['ledger.read','ledger.write','schedule.read','schedule.write','notes.read','notes.write','feedback.read','feedback.write','students.read','students.write'];
  for(const remove of ['ledger.write','schedule.write','notes.write','feedback.write','students.write']){
   await provision.query('UPDATE app.memberships SET permissions=$2,revision=revision+1 WHERE user_id=$1',[f.assistant.id,required.filter(p=>p!==remove)]);
   const r=await draft(f,plan(op('record',{lessonId:f.confirmed,duration:60,observation:'do not save'})),f.assistant);assert.equal(r.status,403,remove);checks.push(remove);
  }
 },['SEC-06','OP-11']);
 await test('followup-finance-revoked','Removing finance read immediately hides saved followups and balance context',async f=>{
  const permissions=[...f.permissions,'students.write','ledger.read'];await provision.query('UPDATE app.memberships SET permissions=$2 WHERE user_id=$1',[f.assistant.id,permissions]);
  const id=await rec(f.A,'followup',{text:'financial-sensitive followup',date},{student:f.a});assert.ok((await snapshot(f,f.assistant)).records.some(r=>r.id===id));
  ok(await request(f.coachA,wpath(f,'members'),'PATCH',{userId:f.assistant.id,revision:1,active:true,permissions:permissions.filter(p=>p!=='ledger.read')}));
  assert.ok(!(await snapshot(f,f.assistant)).records.some(r=>r.id===id));assert.equal((await draft(f,plan(op('followup',{text:'bypass'})),f.assistant)).status,403);
 },['SEC-06','REL-11','OP-17']);
 await test('data-limit','More than 5000 authorized records fails explicitly rather than truncating',async f=>{
  await provision.query("INSERT INTO app.records(workspace_id,id,kind,owner_user_id,payload) SELECT $1,gen_random_uuid(),'student',$2,jsonb_build_object('name','负载'||i,'goal','','next','') FROM generate_series(1,5001) i",[f.A,f.coachA.id]);
  const a=await request(f.coachA,wpath(f,'snapshot'));assert.equal(a.status,413);assert.equal(a.body.code,'DATA_LIMIT');assert.ok(!a.body.records);
  assert.ok((await snapshot(f,f.coachB,'B')).records.length>0);
 },['SEC-14']);
 await test('context-limit','Model context cap rejects before invoking model',async f=>{
  await provision.query("INSERT INTO app.records(workspace_id,id,kind,owner_user_id,payload) SELECT $1,gen_random_uuid(),'student',$2,jsonb_build_object('name','上下文'||i,'goal','','next','') FROM generate_series(1,301) i",[f.A,f.coachA.id]);
  const n=countModel(),r=await request(f.coachA,wpath(f,'plans/generate'),'POST',{text:'看看本月课时'});assert.equal(r.status,400);assert.equal(r.body.code,'INVALID_INPUT');assert.equal(countModel(),n);
 },['SEC-14']);
 await test('text-limit','Excessive input and client context do not invoke a model',async f=>{
  const n=countModel();for(const body of [{text:'x'.repeat(1601)},{text:'查询',context:{role:'owner'}},{text:'查询',selection:{selectedStudent:f.c}}]){const r=await request(f.coachA,wpath(f,'plans/generate'),'POST',body);assert.ok([400,404].includes(r.status));}assert.equal(countModel(),n);
 },['SEC-10','SEC-14']);
 await test('model-busy','Concurrent model generations have a bounded busy rejection',async f=>{
  control({delay:300,plan:plan(op('summary',{month:date.slice(0,7)}))});const run=()=>request(f.coachA,wpath(f,'plans/generate'),'POST',{text:'查询本月'});const rs=await Promise.all([run(),run()]);assert.equal(rs.filter(r=>r.status===200).length,1);assert.equal(rs.filter(r=>r.status===429&&r.body.code==='MODEL_RATE_LIMIT').length,1);
 },['AI-09','SEC-14']);
 await test('plan-limits','Eight independent operations execute together, zero and nine reject',async f=>{
  const p=plan(...Array.from({length:8},()=>op('credit',{studentId:f.a,amount:0.5,note:'eight'})));const r=ok(await commit(f,p));assert.equal(r.results.length,8);assert.equal(r.results.at(-1).balance,14);
  const before=await dbSnapshot();for(const n of [0,9]){const d=await draft(f,plan(...Array.from({length:n},()=>op('balance',{studentId:f.a}))));assert.equal(d.status,400);}assert.deepEqual(await dbSnapshot(),before);
 },['AI-05','SEC-09','TX-01']);
 await test('clarification-plan','Clarification cannot partially execute other valid steps',async f=>{
  const p=plan(op('add-student',{studentName:'不得留下'}),op('clarification',{explanation:'请选择场地'})),before=await dbSnapshot();const r=await commit(f,p);assert.equal(r.status,400);assert.equal(r.body.code,'MISSING_FIELDS');assert.deepEqual(await dbSnapshot(),before);
 },['AI-06','TX-01']);
 await test('audit-scoped','Audit requires management permission and contains no private payload',async f=>{
  await snapshot(f);const a=ok(await request(f.coachA,wpath(f,'audit')));assert.ok(a.events.length>0);for(const marker of ['TEST_A_COACH_NOTE_652','TEST_A_PEER_PHONE_239','TEST_B_PRIVATE_781','password_hash','token_hash'])assert.ok(!JSON.stringify(a).includes(marker));
  for(const who of [f.studentA,f.assistant])assert.equal((await request(who,wpath(f,'audit'))).status,403);
 },['SEC-17']);
 await test('privileged-start','Backend refuses privileged database credentials',async()=>{
  const child=spawn(process.execPath,['--experimental-transform-types',ROOT+'/server/src/server.mjs'],{env:{...process.env,PGDATABASE:db,PGHOST:'/tmp',PGUSER:process.env.YUELIAN_TEST_ADMIN||process.env.USER,PGPASSWORD:'',PORT:'18902'},stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',d=>text+=d);child.stderr.on('data',d=>text+=d);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('privileged startup failed to exit'));},5000);child.on('exit',c=>{clearTimeout(timer);resolve(c);});});assert.notEqual(code,0);assert.ok(text.includes('non-owner, non-privileged RLS role'));assert.ok(!text.includes('listening'));
 },['SEC-15']);
}finally{await stop();}
