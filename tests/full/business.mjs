import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {provision,op,plan,control,date,addDate,request,ok,denied,wpath,snapshot,draft,commit,generate,rec,test,stop,dbSnapshot,account} from './base.mjs';
const book=(f,v={})=>op('booking',{studentId:f.a,venueId:f.va,date:addDate(2),start:'15:00',duration:60,...v});
const reject=async promise=>{const r=await promise;assert.ok([400,403,404,409,413,422].includes(r.status),JSON.stringify(r));return r;};
const day=d=>['日','一','二','三','四','五','六'][new Date(d+'T00:00:00Z').getUTCDay()];
const rule=(f,v={})=>op('availability',{venueId:f.va,from:addDate(2),to:addDate(2),day:day(addDate(2)),start:'09:00',end:'21:00',gap:15,...v});
try{
 await test('REL-unlinked','New student is a profile, never an automatic membership',async f=>{
  const r=ok(await commit(f,plan(op('add-student',{studentName:'未关联学员'}))));const sid=r.results[0].id;
  assert.equal((await provision.query('SELECT 1 FROM app.memberships WHERE workspace_id=$1 AND student_id=$2',[f.A,sid])).rowCount,0);
  assert.equal((await provision.query('SELECT 1 FROM app.invitations WHERE student_id=$1',[sid])).rowCount,0);
 },['REL-01','OP-01']);
 await test('REL-targeted','Username invitation binds the exact existing profile and protects old membership',async f=>{
  const sid=await rec(f.A,'student',{name:'受邀学员',goal:'',next:''});await rec(f.A,'ledger',{delta:7,label:'既有余额'},{student:sid});
  const invited=await account('targeted');const a=ok(await request(f.coachA,wpath(f,'invitations'),'POST',{username:invited.username,role:'student',studentId:sid}));
  assert.equal(a.token.length,43);const listed=ok(await request(f.coachA,wpath(f,'invitations')));assert.ok(!JSON.stringify(listed).includes(a.token));assert.ok(!JSON.stringify(listed).includes('token_hash'));
  assert.equal((await request(f.outsider,'/v1/invitations/accept','POST',{token:a.token})).status,403);
  ok(await request(invited,'/v1/invitations/accept','POST',{token:a.token}));const snap=await snapshot(f,invited);assert.equal(snap.workspace.studentId,sid);assert.equal(snap.records.filter(r=>r.kind==='student').length,1);assert.equal(snap.records.filter(r=>r.kind==='ledger').reduce((n,r)=>n+r.payload.delta,0),7);
  assert.equal((await request(f.coachA,wpath(f,'invitations'),'POST',{username:f.outsider.username,role:'student',studentId:sid})).status,409);
 },['REL-02','REL-03','REL-04','REL-07']);
 await test('REL-reinvite','Reinvite revokes only pending old token and resolves registered username',async f=>{
  const sid=await rec(f.A,'student',{name:'重新邀请',goal:'',next:''}),who=await account('reinvited');
  assert.equal((await request(f.coachA,wpath(f,'invitations'),'POST',{username:'missing'+randomUUID().slice(0,8),role:'student',studentId:sid})).status,404);
  const a=ok(await request(f.coachA,wpath(f,'invitations'),'POST',{username:who.username,role:'student',studentId:sid}));
  const b=ok(await request(f.coachA,wpath(f,'invitations'),'POST',{username:who.username,role:'student',studentId:sid}));
  await reject(request(who,'/v1/invitations/accept','POST',{token:a.token}));ok(await request(who,'/v1/invitations/accept','POST',{token:b.token}));
  assert.equal((await provision.query('SELECT 1 FROM app.memberships WHERE student_id=$1',[sid])).rowCount,1);
 },['REL-05','REL-06']);
 await test('REL-revision','Stale membership updates cannot overwrite newer authorization',async f=>{
  ok(await request(f.coachA,wpath(f,'members'),'PATCH',{userId:f.assistant.id,revision:1,active:true,permissions:[...f.permissions,'ledger.read']}));
  assert.equal((await request(f.adminA,wpath(f,'members'),'PATCH',{userId:f.assistant.id,revision:1,active:false})).status,409);
  const m=(await provision.query('SELECT active,permissions FROM app.memberships WHERE user_id=$1',[f.assistant.id])).rows[0];assert.equal(m.active,true);assert.ok(m.permissions.includes('ledger.read'));
 },['REL-11','REL-13']);
 await test('REL-staff-roles','Registered usernames can join as bounded assistant or owner-invited admin',async f=>{
  for(const [role,permissions] of [['assistant',['students.read','schedule.read','schedule.write','venues.read']],['admin',[]]]){
   const who=await account('invite'+role),inv=ok(await request(f.coachA,wpath(f,'invitations'),'POST',{username:who.username,role,permissions}));
   ok(await request(who,'/v1/invitations/accept','POST',{token:inv.token}));const s=await snapshot(f,who);assert.equal(s.workspace.role,role);assert.deepEqual(s.workspace.permissions,permissions);
   assert.equal((await request(who,wpath(f,'members'))).status,role==='admin'?200:403);
  }
  for(const permissions of [['schedule.write'],['unknown.read'],['schedule.read','schedule.read']])assert.equal((await request(f.coachA,wpath(f,'invitations'),'POST',{username:f.outsider.username,role:'assistant',permissions})).status,400);
 },['REL-10','REL-12']);
 await test('dual-role','A learner can be an authorized assistant for another coach without merging records',async f=>{
  const invite=ok(await request(f.coachB,wpath(f,'invitations','B'),'POST',{username:f.studentB.username,role:'assistant',permissions:['students.read','schedule.read','schedule.write','venues.read']}));
  ok(await request(f.studentB,'/v1/invitations/accept','POST',{token:invite.token}));const list=ok(await request(f.studentB,'/v1/workspaces')).workspaces;assert.equal(list.find(w=>w.id===f.A).role,'student');assert.equal(list.find(w=>w.id===f.B).role,'assistant');
  const own=await snapshot(f,f.studentB),staff=await snapshot(f,f.studentB,'B');assert.equal(own.workspace.role,'student');assert.equal(staff.workspace.role,'assistant');assert.ok(!own.workspace.actions.includes('edit-base'));assert.ok(staff.workspace.actions.includes('edit-base'));assert.ok(own.records.filter(r=>r.kind==='student').every(r=>r.id===f.b));assert.ok(!staff.records.some(r=>r.id===f.b||r.kind==='ledger'));
 },['NAV-06','SEC-02','SEC-03']);
 await test('booking-student','Student request and both decisions synchronize without ledger debit',async f=>{
  const a=ok(await commit(f,plan(book(f)),f.studentA));let snap=await snapshot(f);const l=snap.records.find(r=>r.id===a.results[0].id);assert.equal(l.payload.state,'pending');const m=snap.records.find(r=>r.kind==='message'&&r.lessonId===l.id);
  ok(await commit(f,plan(op('message-decision',{messageId:m.id,decision:'reject'}))));snap=await snapshot(f,f.studentA);assert.equal(snap.records.find(r=>r.id===l.id).payload.state,'cancelled');assert.ok(snap.records.some(r=>r.kind==='message'&&r.lessonId===l.id&&r.payload.kind==='status'));
  const before=await dbSnapshot();await reject(commit(f,plan(op('message-decision',{messageId:m.id,decision:'accept'}))));assert.deepEqual(await dbSnapshot(),before);
  ok(await commit(f,plan(op('message-decision',{messageId:f.proposalMessage,decision:'accept'})),f.studentA));assert.equal((await snapshot(f)).records.find(r=>r.id===f.proposal).payload.state,'confirmed');assert.equal((await snapshot(f,f.studentA)).records.filter(r=>r.kind==='ledger').reduce((n,r)=>n+r.payload.delta,0),10);
 },['OP-07','OP-13','FUN-03']);
 await test('message-reject-proposal','Student can reject own proposal but not accept their own request',async f=>{
  ok(await commit(f,plan(op('message-decision',{messageId:f.proposalMessage,decision:'reject'})),f.studentA));assert.equal((await snapshot(f)).records.find(r=>r.id===f.proposal).payload.state,'cancelled');
  await reject(commit(f,plan(op('message-decision',{messageId:f.bookingMessage,decision:'accept'})),f.studentA));await reject(commit(f,plan(op('resolve-message',{messageId:f.bookingMessage}))));
 },['OP-13','OP-14','SEC-03']);
 await test('same-court-gaps','Same-court interval boundary is enforced',async f=>{
  ok(await commit(f,plan(rule(f),book(f,{start:'14:00'}))));
  for(const start of ['14:30','15:00','15:14'])await reject(commit(f,plan(book(f,{start}))));
  ok(await commit(f,plan(book(f,{start:'15:15'}))));
 },['FUN-05','OP-05']);
 await test('cross-court-gaps','Different court cannot overlap and travel boundary is enforced',async f=>{
  ok(await commit(f,plan(book(f,{start:'14:00'}))));
  for(const start of ['14:00','15:00','15:29'])await reject(commit(f,plan(book(f,{venueId:f.va2,start}))));
  ok(await commit(f,plan(book(f,{venueId:f.va2,start:'15:30'}))));
 },['FUN-06']);
 await test('rules-edit','Rule edits apply to new booking and preserve existing lessons',async f=>{
  const initial=ok(await commit(f,plan(rule(f,{start:'13:00',end:'18:00'}))));const rid=initial.results[0].id;
  await reject(commit(f,plan(book(f,{start:'10:00'}))));ok(await commit(f,plan(book(f,{start:'13:00'}))));
  ok(await commit(f,plan(rule(f,{ruleId:rid,start:'16:00',end:'19:00',gap:0}))));
  const s=await snapshot(f);assert.equal(s.records.filter(r=>r.kind==='availability').length,1);assert.ok(s.records.some(r=>r.kind==='lesson'&&r.payload.date===addDate(2)&&r.payload.start===780));
  await reject(commit(f,plan(book(f,{start:'14:00'}))));ok(await commit(f,plan(book(f,{start:'17:00'}))));ok(await commit(f,plan(book(f,{date:addDate(3),start:'10:00'}))));
 },['FUN-07','OP-05']);
 await test('base-closed','No open days blocks new lessons but preserves appointments and explicit date rules',async f=>{
  ok(await commit(f,plan(op('edit-base',{days:[],start:'09:00',end:'21:00',travel:30}))));assert.equal((await snapshot(f)).records.find(r=>r.id===f.pending).payload.state,'pending');
  await reject(commit(f,plan(book(f))));ok(await commit(f,plan(rule(f,{gap:0}),book(f))));
 },['OP-06','FUN-07']);
 await test('rules-latest-edit','Latest edited overlapping rule wins for booking and existing-course correction',async f=>{
  const r1=ok(await commit(f,plan(rule(f,{from:date,to:date,day:day(date),gap:30})))).results[0].id;
  ok(await commit(f,plan(rule(f,{from:date,to:date,day:day(date),gap:0}))));
  ok(await commit(f,plan(rule(f,{ruleId:r1,from:date,to:date,day:day(date),gap:30}))));
  const before=await dbSnapshot();const r=await commit(f,plan(op('edit-lesson',{lessonId:f.confirmed,duration:105,note:'should conflict with buffer'})));assert.equal(r.status,409);assert.equal(r.body.code,'SLOT_UNAVAILABLE');assert.deepEqual(await dbSnapshot(),before);
  const record=await commit(f,plan(op('record',{lessonId:f.confirmed,duration:105,observation:'should conflict with buffer',publish:false})));assert.equal(record.status,409);assert.equal(record.body.code,'SLOT_UNAVAILABLE');assert.deepEqual(await dbSnapshot(),before);
 },['FUN-05','FUN-07','OP-11','OP-12']);
 await test('booking-invalid','Invalid dates, midnight overflow and duration boundaries reject atomically',async f=>{
  for(const values of [{date:addDate(-1)},{date:'2026-11-31'},{start:'24:00'},{start:'23:45',duration:30},{duration:0},{duration:14},{duration:241},{duration:17}]){const before=await dbSnapshot();await reject(commit(f,plan(book(f,values))));assert.deepEqual(await dbSnapshot(),before);}
  ok(await commit(f,plan(book(f,{start:'09:00',duration:15}))));ok(await commit(f,plan(book(f,{start:'17:00',duration:240}))));
 },['FUN-08']);
 await test('invalid-fields','Names, amount and required venue details validate without partial writes',async f=>{
  const variants=[op('add-student',{studentName:'小王'}),op('add-student',{studentName:'a'.repeat(21)}),op('edit-student',{studentId:f.a,studentName:'小李'}),op('add-venue',{name:'甲网球场',address:'a',court:'1',indoor:false}),op('edit-venue',{venueId:f.va2,name:'甲网球场'}),op('add-venue',{name:'不完整',address:'',court:'1',indoor:false})];
  for(const amount of [0,-1,501,0.25])variants.push(op('credit',{studentId:f.a,amount,note:'invalid'}));
  for(const v of variants){const before=await dbSnapshot();await reject(commit(f,plan(v)));assert.deepEqual(await dbSnapshot(),before);}
 },['OP-01','OP-03','OP-08']);
 await test('record-private','Unpublished feedback stays private, completion debits exactly once',async f=>{
  ok(await commit(f,plan(op('record',{lessonId:f.confirmed,duration:60,observation:'NOTE_PRIVATE_NEW',feedback:'FEEDBACK_PRIVATE_NEW',publish:false,next:''}))));
  const s=await snapshot(f,f.studentA);assert.ok(!JSON.stringify(s).includes('NOTE_PRIVATE_NEW'));assert.ok(!JSON.stringify(s).includes('FEEDBACK_PRIVATE_NEW'));assert.equal(s.records.filter(r=>r.kind==='ledger').reduce((n,r)=>n+r.payload.delta,0),9);
  const before=await dbSnapshot();await reject(commit(f,plan(op('record',{lessonId:f.confirmed,duration:60,observation:'duplicate'}))));assert.deepEqual(await dbSnapshot(),before);
 },['OP-11','SEC-04']);
 await test('record-invalid-state','Future, cancelled and group lessons cannot be recorded as individual attendance',async f=>{
  for(const lid of [f.pending,f.proposal,f.group])await reject(commit(f,plan(op('record',{lessonId:lid,duration:60,observation:'invalid'}))));
  const future=await rec(f.A,'lesson',{date:addDate(4),start:600,duration:60,state:'confirmed',topic:''},{student:f.a,venue:f.va,visibility:'shared'});await rec(f.A,'participant',{}, {student:f.a,lesson:future});await reject(commit(f,plan(op('record',{lessonId:future,duration:60,observation:'future'}))));
 },['OP-11','FUN-04','BOUND-07']);
 await test('record-insufficient','Zero balance is allowed, negative completion rolls back every related record',async f=>{
  await provision.query("UPDATE app.records SET payload=jsonb_set(payload,'{delta}','0.5') WHERE kind='ledger' AND workspace_id=$1 AND student_id=$2",[f.A,f.a]);
  const before=await dbSnapshot();await reject(commit(f,plan(op('record',{lessonId:f.confirmed,duration:60,observation:'do not save',feedback:'do not publish',publish:true}))));assert.deepEqual(await dbSnapshot(),before);
  ok(await commit(f,plan(op('record',{lessonId:f.confirmed,duration:30,observation:'zero is valid',publish:false}))));assert.equal((await snapshot(f,f.studentA)).records.filter(r=>r.kind==='ledger').reduce((n,r)=>n+r.payload.delta,0),0);
 },['FUN-10','TX-01']);
 await test('edit-done','Editing completed duration updates original debit instead of adding another',async f=>{
  ok(await commit(f,plan(op('record',{lessonId:f.confirmed,duration:60,observation:'original',publish:false}))));
  ok(await commit(f,plan(op('edit-lesson',{lessonId:f.confirmed,duration:90,note:'corrected'}))));let s=await snapshot(f);const ledger=s.records.filter(r=>r.kind==='ledger'&&r.lessonId===f.confirmed);assert.equal(ledger.length,1);assert.equal(ledger[0].payload.delta,-1.5);assert.equal(s.records.find(r=>r.kind==='coach-note'&&r.lessonId===f.confirmed).payload.text,'corrected');
  const before=await dbSnapshot();await reject(commit(f,plan(op('edit-lesson',{lessonId:f.confirmed,duration:180,note:'conflict'}))));assert.deepEqual(await dbSnapshot(),before);
 },['OP-12','FUN-10']);
 await test('edit-historical','Historical completed lesson without linked ledger supports truthful correction behavior',async f=>{
  const lid=await rec(f.A,'lesson',{date:addDate(-2),start:600,duration:60,state:'done',topic:'old'},{student:f.a,venue:f.va,visibility:'shared'});await rec(f.A,'participant',{}, {student:f.a,lesson:lid});await rec(f.A,'coach-note',{text:'old note'},{student:f.a,lesson:lid});
  ok(await commit(f,plan(op('edit-lesson',{lessonId:lid,duration:60,note:'correct historical note'}))));const s=await snapshot(f);assert.equal(s.records.find(r=>r.kind==='coach-note'&&r.lessonId===lid).payload.text,'correct historical note');assert.ok(!s.records.some(r=>r.kind==='ledger'&&r.lessonId===lid));await reject(commit(f,plan(op('edit-lesson',{lessonId:lid,duration:90,note:'bad duration'}))));
 },['OP-12']);
 await test('summary-independent','Summary excludes cancelled lessons and separates both coaches for one student',async f=>{
  for(const [duration,state] of [[60,'done'],[90,'done'],[120,'cancelled']]){const lid=await rec(f.A,'lesson',{date:addDate(-1),start:duration,duration,state,topic:''},{student:f.a,venue:f.va,visibility:'shared'});await rec(f.A,'participant',{}, {student:f.a,lesson:lid});}
  const before=await dbSnapshot();for(const [who,w] of [[f.coachA,'A'],[f.studentA,'A'],[f.studentA,'B']]){const result=ok(await commit(f,plan(op('summary',{month:addDate(-1).slice(0,7)})),who,w)).results[0];const snap=await snapshot(f,who,w);const lessons=snap.records.filter(r=>r.kind==='lesson'&&r.payload.date.startsWith(addDate(-1).slice(0,7)));assert.equal(result.lessons,lessons.filter(r=>r.payload.state!=='cancelled').length);assert.equal(result.hours,lessons.filter(r=>r.payload.state==='done').reduce((n,r)=>n+r.payload.duration/60,0));}assert.deepEqual(await dbSnapshot(),before);
 },['OP-10','FUN-11','SEC-03']);
 await test('followup-boundaries','Followup uses 21-day balance and future-plan boundaries including today',async f=>{
  const expected=[];for(const [name,days,balance,futureState] of [['yes',21,1,null],['recent',20,1,null],['empty',22,0,null],['future',22,1,'pending'],['today',22,1,'confirmed'],['cancelled',22,1,'cancelled']]){
   const sid=await rec(f.A,'student',{name,goal:'',next:''});if(balance)await rec(f.A,'ledger',{delta:balance,label:'边界余额'},{student:sid});await rec(f.A,'lesson',{date:addDate(-days),start:500,duration:60,state:'done',topic:''},{student:sid,venue:f.va,visibility:'shared'});
   if(futureState)await rec(f.A,'lesson',{date:name==='today'?date:addDate(2),start:500,duration:60,state:futureState,topic:''},{student:sid,venue:f.va,visibility:'shared'});if(name==='yes'||name==='cancelled')expected.push(sid);
  }
  const r=ok(await commit(f,plan(op('followup',{text:'回访草稿'}))));const s=await snapshot(f);assert.deepEqual(s.records.filter(r=>r.kind==='followup').map(r=>r.studentId).sort(),expected.sort());assert.equal(r.results[0].ids.length,2);const fid=r.results[0].ids[0];ok(await commit(f,plan(op('followup',{followupId:fid,text:'改后的回访'}))));assert.equal((await snapshot(f)).records.find(r=>r.id===fid).payload.text,'改后的回访');
 },['OP-17','FUN-14']);
 await test('followup-none','No eligible students means no followup writes',async f=>{
  const before=await dbSnapshot(),r=ok(await commit(f,plan(op('followup',{text:'no one'}))));assert.equal(r.results[0].written,false);assert.deepEqual(await dbSnapshot(),before);
 },['OP-17']);
 await test('undo-associated','Undo refuses to delete a newly created student with later linked lessons',async f=>{
  const r=ok(await commit(f,plan(op('add-student',{studentName:'后续有关联'}))));const sid=r.results[0].id;ok(await commit(f,plan(book(f,{studentId:sid}))));const before=await dbSnapshot();assert.equal((await request(f.coachA,wpath(f,`plans/${r.id}/undo`),'POST',{})).status,409);assert.deepEqual(await dbSnapshot(),before);
 },['TX-06']);
 await test('undo-conflicting-period','Undo refuses to re-extend a lesson into a later adjacent booking',async f=>{
  const r=ok(await commit(f,plan(op('edit-lesson',{lessonId:f.confirmed,duration:30,note:'short'}))));ok(await commit(f,plan(book(f,{date,start:'10:30',duration:30}))));const before=await dbSnapshot();assert.equal((await request(f.coachA,wpath(f,`plans/${r.id}/undo`),'POST',{})).status,409);assert.deepEqual(await dbSnapshot(),before);
 },['TX-06']);
 await test('ai-errors','All provider failures classify without saving or leaking provider details',async f=>{
  for(const [value,status,code] of [[{status:400},502,'MODEL_CONFIGURATION'],[{status:401},502,'MODEL_UNAVAILABLE'],[{status:402},402,'MODEL_QUOTA'],[{status:429},429,'MODEL_BUSY'],[{raw:'bad'},502,'INVALID_RESPONSE'],[{incomplete:true,plan:plan(op('clarification'))},502,'INCOMPLETE'],[{throw:true},504,'MODEL_TIMEOUT'],[{refusal:true},422,'REFUSED']]){
   control(value);const before=await dbSnapshot(),r=await generate(f,'检查错误');assert.equal(r.status,status,JSON.stringify(r));assert.equal(r.body.code,code,JSON.stringify(r));assert.ok(!JSON.stringify(r.body).includes('synthetic upstream private detail'));assert.deepEqual(await dbSnapshot(),before);
  }
 },['AI-10']);
}finally{await stop();}
