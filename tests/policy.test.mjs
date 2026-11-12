import {test} from 'node:test';
import assert from 'node:assert/strict';
import {can,requirePermission,requireAction,permissions,capabilities,projection,schemas} from '../server/src/policy.mjs';

const actions=['booking','record','availability','add-student','edit-student','credit','balance','summary','message-decision','resolve-message','add-venue','edit-venue','edit-base','edit-lesson','followup','practice','edit-practice'];
const staffActions=actions.filter(x=>!['practice','edit-practice'].includes(x));
const studentActions=['booking','practice','edit-practice','balance','summary','message-decision','resolve-message'];
const scheduleActions=['booking','availability','summary','message-decision','resolve-message','edit-base','edit-lesson'];
const scenarios=[
 ['owner',{role:'owner',active:true,permissions:[]},staffActions],
 ['admin',{role:'admin',active:true,permissions:[]},staffActions],
 ['student',{role:'student',active:true,permissions:[]},studentActions],
 ['scheduling assistant',{role:'assistant',active:true,permissions:['students.read','schedule.read','schedule.write','venues.read']},scheduleActions],
 ['read-only assistant',{role:'assistant',active:true,permissions:['schedule.read','venues.read']},['summary']],
 ['empty assistant',{role:'assistant',active:true,permissions:[]},[]],
 ['fully authorized assistant',{role:'assistant',active:true,permissions:capabilities},staffActions],
 ['unknown role',{role:'visitor',active:true,permissions:capabilities},[]],
];
for(const [label,member,allowed] of scenarios)test(`UNIT-10 action matrix: ${label} × 17 actions`,()=>{
 for(const action of actions){if(allowed.includes(action))assert.doesNotThrow(()=>requireAction(member,action),action);else assert.throws(()=>requireAction(member,action),e=>[400,403].includes(e.status),action);}
});
for(const role of ['owner','admin','assistant','student'])test(`UNIT-10 inactive ${role} cannot perform any action or capability`,()=>{
 const member={role,active:false,permissions:capabilities};
 for(const action of actions)assert.throws(()=>requireAction(member,action),{status:403});
 for(const capability of [...capabilities,'team.manage','audit.read']){assert.equal(can(member,capability),false);assert.throws(()=>requirePermission(member,capability),{status:403});}
});
test('UNIT-10 null identity fails closed before action dispatch',()=>{
 for(const action of actions)assert.throws(()=>requireAction(null,action),{status:403});assert.equal(can(null,'schedule.read'),false);
});
test('UNIT-10 record requires every independent write permission and follow-up needs ledger and schedule reads',()=>{
 const recording=['ledger.write','schedule.write','notes.write','feedback.write','students.write'];
 const following=['students.write','ledger.read','schedule.read'];
 for(const [action,list] of [['record',recording],['followup',following]]){
  assert.doesNotThrow(()=>requireAction({role:'assistant',active:true,permissions:list},action));
  for(const removed of list)assert.throws(()=>requireAction({role:'assistant',active:true,permissions:list.filter(p=>p!==removed)},action),{status:403},removed);
 }
});
test('UNIT-10 capability matrix keeps team administration out of assistant grants',()=>{
 for(const [,member] of scenarios)for(const permission of [...capabilities,'team.manage','audit.read']){
  const expected=['owner','admin'].includes(member.role)||(member.role==='assistant'&&member.permissions.includes(permission));
  assert.equal(can(member,permission),expected,member.role+' '+permission);
 }
 assert.throws(()=>permissions.parse(['team.manage']));
});
test('UNIT-10 permission input rejects duplicate, unknown, or write without read grants',()=>{
 assert.deepEqual(permissions.parse([]),[]);
 for(const list of [['ledger.read','ledger.read'],['schedule.execute'],['schedule.write'],['ledger.write','schedule.read']])assert.throws(()=>permissions.parse(list));
 assert.deepEqual(permissions.parse(['schedule.read','schedule.write']),['schedule.read','schedule.write']);
});
test('UNIT-09 database record schemas reject invalid dates, fractional ledger amounts and unknown fields',()=>{
 assert.throws(()=>schemas.practice.parse({topic:'练习',text:'',date:'2026-02-29'}));
 assert.throws(()=>schemas.ledger.parse({delta:0,label:'x'}));assert.throws(()=>schemas.ledger.parse({delta:0.3,label:'x'}));
 assert.equal(schemas.ledger.parse({delta:2.5,label:'购课'}).delta,2.5);
 assert.throws(()=>schemas.student.parse({name:'小林',phone:'private'}));
 assert.throws(()=>schemas.settings.parse({days:['八'],start:'09:00',end:'21:00',travel:15}));
});
test('UNIT-07 public projection never returns raw owner, tenant, authentication or extra payload fields',()=>{
 const raw={id:'record',kind:'student',student_id:null,lesson_id:null,venue_id:null,visibility:'private',revision:1,created_at:'now',updated_at:'now',workspace_id:'private-scope',owner_user_id:'private-owner',token_hash:'private-token',password_hash:'private-password',payload:{name:'小林',goal:'正手',next:'移动'}};
 const before=structuredClone(raw),out=projection(raw);assert.deepEqual(raw,before);
 assert.deepEqual(Object.keys(out).sort(),['id','kind','studentId','lessonId','venueId','visibility','revision','createdAt','updatedAt','payload'].sort());
 assert.ok(!JSON.stringify(out).includes('private-'));
 assert.throws(()=>projection({...raw,payload:{...raw.payload,password_hash:'forbidden'}}));
});
