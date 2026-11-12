import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshData,balanceOf} from '../public/data.js';
import {executeOperations} from '../public/operations.js';
import {toPlan} from '../public/ai-client.js';
const fresh=()=>({...freshData(),availabilityRules:[],activity:[]});
const venue=()=>({id:'s1',type:'add-venue',dependsOn:[],values:{name:'弘金地网球场',address:'测试地址',court:'1号场',indoor:'false'}});
const booking=(values={})=>({id:'s2',type:'booking',dependsOn:['s1'],values:{student:'roy',date:'2026-11-01',start:'15:00',duration:60,venue:'plan:s1',note:'正手、反手',...values}});
const run=(rows,data=fresh(),role='coach')=>executeOperations(data,rows,{role});
test('new venue is saved once and the subsequent booking uses its actual ID',()=>{
 const original=fresh(),before=JSON.stringify(original);const {data,outcomes}=run([venue(),booking()],original);
 assert.equal(JSON.stringify(original),before);assert.equal(data.venues.length,3);assert.equal(data.lessons.length,6);
 const added=data.venues.at(-1),l=data.lessons.at(-1);assert.equal(l.venue,added.id);assert.equal(l.note,'正手、反手');assert.equal(l.state,'pending_student');assert.equal(balanceOf(data,'roy'),5.5);assert.equal(outcomes.length,2);
});
test('missing first-step details and later conflicts leave original completely untouched',()=>{
 for(const rows of [[{...venue(),values:{...venue().values,address:''}},booking()],[venue(),booking({date:'2026-11-03',start:'19:00'})],[venue(),booking(),{...booking(),id:'s3'}]]){
  const original=fresh(),before=JSON.stringify(original);assert.throws(()=>run(rows,original));assert.equal(JSON.stringify(original),before);
 }
});
test('new student, credit and booking can chain; balance query sees earlier writes',()=>{
 const rows=[{id:'s1',type:'add-student',values:{name:'小宇',goal:'正手'}},{id:'s2',type:'credit',dependsOn:['s1'],values:{student:'plan:s1',amount:10,note:'已购买'}},{...booking({student:'plan:s1',venue:'riverside'}),id:'s3'},{id:'s4',type:'balance',dependsOn:['s1','s2'],student:'plan:s1'}];
 const {data,outcomes}=run(rows);assert.equal(balanceOf(data,data.students.at(-1).id),10);assert.equal(data.lessons.at(-1).students[0],data.students.at(-1).id);assert.match(outcomes.at(-1).message,/10 课时/);
});
test('two independent operations work and duplicate submissions cannot double-book',()=>{
 const rows=[{id:'s1',type:'credit',values:{student:'roy',amount:2,note:'已购'}},{...booking({venue:'riverside'}),dependsOn:[]}];
 const {data}=run(rows);assert.equal(balanceOf(data,'roy'),7.5);assert.throws(()=>run(rows,data));assert.equal(balanceOf(data,'roy'),7.5);
});
test('dependencies must exist, precede consumers and produce the right entity type',()=>{
 for(const rows of [[booking(),venue()],[venue(),{...booking(),dependsOn:[]}],[{...venue(),type:'add-student',values:{name:'小明',goal:''}},booking()]])assert.throws(()=>run(rows));
});
test('sequential availability rules and bookings validate against the proposed state',()=>{
 const rule={id:'s1',type:'availability',values:{from:'2026-11-01',to:'2026-11-30',day:'日',start:'14:00',end:'18:00',gap:15,venue:'riverside',preserve:true}};
 assert.equal(run([rule,{...booking({venue:'riverside'}),dependsOn:['s1']}]).data.availabilityRules.length,1);
 assert.throws(()=>run([rule,{...booking({venue:'riverside',start:'19:00'}),dependsOn:['s1']}]));
});
test('message decisions are role-scoped, state-checked and all-or-nothing',()=>{
 const accept={id:'s1',type:'message-decision',values:{decision:'accept'},message:'m-book'};
 assert.equal(run([accept]).data.messages.find(m=>m.id==='m-book').state,'accepted');
 assert.throws(()=>run([accept,{...accept,id:'s2'}]));assert.throws(()=>run([accept],fresh(),'student'));
});
test('record completion debits once, repeated record rolls back the whole plan',()=>{
 const record={id:'s1',type:'record',lesson:'l2',values:{duration:90,observation:'反手有进步',next:'移动练习',feedback:'',publish:false}};
 const {data}=run([record]);assert.equal(balanceOf(data,'roy'),4);assert.throws(()=>run([record,{...record,id:'s2'}]));assert.throws(()=>run([record],data));
});
test('queries, student practice and traditional edits still work',()=>{
 assert.equal(run([{type:'balance',student:'roy'}]).outcomes[0].written,false);
 const practice={type:'practice',values:{topic:'正手',text:'挥拍20分钟'}};
 assert.equal(run([practice],fresh(),'student').data.studentPractice.length,1);assert.throws(()=>run([practice]));
 assert.equal(run([{type:'edit-student',student:'roy',values:{name:'Roy',goal:'移动',next:''}}]).data.students[0].goal,'移动');
 assert.equal(run([{type:'edit-venue',venue:'park',values:{name:'城市公园',address:'测试地址',court:'2号场',indoor:'true'}}]).data.venues[1].indoor,true);
});
test('validation catches malformed dates, invalid choices and forbidden roles',()=>{
 for(const values of [{date:'2026-11-31'},{start:'25:00'},{duration:0},{venue:'missing'},{student:'missing'}])assert.throws(()=>run([{...booking({...values,venue:values.venue||'riverside'}),dependsOn:[]}]));
 assert.throws(()=>run([venue()],fresh(),'student'));assert.throws(()=>run([{type:'credit',values:{student:'missing',amount:3,note:'已购'}}]));
 assert.throws(()=>run([{type:'clarification',message:'需补充'}]));
});
test('plan adapter preserves draft links without mutating saved data',()=>{
 const data=fresh(),before=JSON.stringify(data);
 const p={title:'添加场地并排课',explanation:'核对后执行',steps:[{id:'s1',dependsOn:[],studentRef:null,venueRef:null,operation:{intent:'add-venue',name:'弘金地网球场',address:null,court:null,indoor:null}},{id:'s2',dependsOn:['s1'],studentRef:null,venueRef:'s1',operation:{intent:'booking',studentId:'roy',date:'2026-11-01',start:'15:00',duration:60,note:'正反手'}}]};
 const r=toPlan(p,{data,role:'coach',request:'测试'});assert.equal(r.steps[1].values.venue,'plan:s1');assert.equal(r.steps[0].values.address,'');assert.equal(JSON.stringify(data),before);
});
