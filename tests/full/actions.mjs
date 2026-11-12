import assert from 'node:assert/strict';
import {op,plan,control,date,addDate,request,ok,wpath,snapshot,commit,generate,rec,test,stop,dbSnapshot} from './base.mjs';

const actions=['add-student','edit-student','add-venue','edit-venue','availability','edit-base','booking','credit','balance','summary','record','edit-lesson','message-decision','resolve-message','practice','edit-practice','followup'];
try {
 for(const mode of ['manual','model-stub'])for(let index=0;index<actions.length;index++){
  const kind=actions[index],id='OP-'+String(index+1).padStart(2,'0');
  await test(id+(mode==='manual'?'-M':'-A'),kind+' through '+mode,async(f,checks)=>{
   let who=f.coachA,v={};
   if(kind==='add-student')v={studentName:'接口矩阵学员',goal:'正手'};
   if(kind==='edit-student')v={studentId:f.a,studentName:'小王更新',goal:'切削',next:'发球'};
   if(kind==='add-venue')v={name:'新增场地',address:'测试路9号',court:'9号场',indoor:false};
   if(kind==='edit-venue')v={venueId:f.va,address:'修改后地址',indoor:true};
   if(kind==='availability')v={venueId:f.va,from:date,to:addDate(30),day:'一',start:'09:00',end:'20:00',gap:15};
   if(kind==='edit-base')v={days:['一','三','五'],start:'08:00',end:'22:00',travel:15};
   if(kind==='booking')v={studentId:f.a,venueId:f.va,date:addDate(2),start:'15:00',duration:60,note:'正反手'};
   if(kind==='credit')v={studentId:f.a,amount:2.5,note:'已购买'};
   if(kind==='balance')v={studentId:f.a};
   if(kind==='summary')v={month:date.slice(0,7)};
   if(kind==='record')v={lessonId:f.confirmed,duration:90,observation:'私密教练笔记',feedback:'学员可见反馈',publish:true,next:'练发球'};
   if(kind==='edit-lesson')v={lessonId:f.confirmed,duration:45,note:'调整主题'};
   if(kind==='message-decision')v={messageId:f.bookingMessage,decision:'accept'};
   if(kind==='resolve-message')v={messageId:await rec(f.A,'message',{kind:'status',state:'pending',title:'待处理通知',text:'测试通知'},{student:f.a,visibility:'shared'})};
   if(kind==='practice'){who=f.studentA;v={name:'今日空挥',text:'20分钟',shared:false};}
   if(kind==='edit-practice'){who=f.studentA;v={practiceId:f.practicePrivate,name:'改为挥拍',text:'30分钟',shared:true};}
   if(kind==='followup'){
    const sid=await rec(f.A,'student',{name:'待回访',goal:'',next:''});
    await rec(f.A,'ledger',{delta:5,label:'未用完课时'},{student:sid});
    await rec(f.A,'lesson',{date:addDate(-30),start:600,duration:60,state:'done',topic:''},{student:sid,venue:f.va,visibility:'shared'});
    v={text:'最近有空回来练球吗？'};
   }
   const before=await dbSnapshot(),p=plan(op(kind,v));let response;
   if(mode==='manual')response=await commit(f,p,who);
   else {control({plan:p});const d=ok(await generate(f,'验收'+kind,who));assert.deepEqual(await dbSnapshot(),before,'generation must not write business records');response=await request(who,wpath(f,`plans/${d.id}/commit`),'POST',{});}
   const result=ok(response).results[0];assert.equal(result.intent,kind);
   const snap=await snapshot(f,who),row=snap.records.find(r=>r.id===result.id),rows=snap.records;
   if(kind==='add-student'){assert.equal(row.payload.name,'接口矩阵学员');assert.equal(rows.filter(r=>r.kind==='student'&&r.payload.name==='接口矩阵学员').length,1);assert.ok(!rows.some(r=>r.kind==='ledger'&&r.studentId===row.id));}
   if(kind==='edit-student'){assert.equal(row.id,f.a);assert.deepEqual(row.payload,{name:'小王更新',goal:'切削',next:'发球'});assert.ok(rows.some(r=>r.kind==='ledger'&&r.studentId===f.a));}
   if(kind==='add-venue')assert.deepEqual(row.payload,{name:'新增场地',address:'测试路9号',court:'9号场',indoor:false});
   if(kind==='edit-venue'){assert.equal(row.id,f.va);assert.equal(row.payload.address,'修改后地址');assert.equal(row.payload.indoor,true);assert.equal(rows.find(r=>r.id===f.confirmed).venueId,f.va);}
   if(kind==='availability'){assert.equal(row.venueId,f.va);assert.deepEqual(row.payload,{from:date,to:addDate(30),day:'一',start:'09:00',end:'20:00',gap:15});assert.equal(rows.find(r=>r.id===f.pending).payload.start,600);}
   if(kind==='edit-base'){assert.deepEqual(row.payload,{days:['一','三','五'],start:'08:00',end:'22:00',travel:15});assert.equal(rows.find(r=>r.id===f.pending).payload.start,600);}
   if(kind==='booking'){assert.equal(row.payload.state,'pending_student');assert.equal(row.payload.topic,'正反手');assert.equal(row.studentId,f.a);assert.equal(row.venueId,f.va);assert.equal(rows.filter(r=>r.kind==='ledger').length,before.filter(r=>r.workspace_id===f.A&&r.kind==='ledger').length);const s=await snapshot(f,f.studentA);assert.ok(s.records.some(r=>r.kind==='message'&&r.lessonId===row.id&&r.payload.kind==='proposal'));}
   if(kind==='credit'){assert.equal(row.payload.delta,2.5);assert.equal(row.payload.label,'已购买');assert.equal(result.balance,12.5);assert.match(result.message,/没有发起付款/);}
   if(kind==='balance'){assert.equal(result.balance,10);assert.equal(result.written,false);assert.deepEqual(await dbSnapshot(),before);}
   if(kind==='summary'){const lessons=before.filter(r=>r.workspace_id===f.A&&r.kind==='lesson'&&r.payload.date.startsWith(v.month));assert.equal(result.lessons,lessons.filter(r=>r.payload.state!=='cancelled').length);assert.equal(result.hours,lessons.filter(r=>r.payload.state==='done').reduce((n,r)=>n+r.payload.duration/60,0));assert.deepEqual(await dbSnapshot(),before);}
   if(kind==='record'){assert.equal(row.payload.state,'done');assert.equal(row.payload.duration,90);assert.equal(rows.filter(r=>r.kind==='ledger'&&r.lessonId===f.confirmed).length,1);assert.equal(rows.find(r=>r.kind==='ledger'&&r.lessonId===f.confirmed).payload.delta,-1.5);assert.equal(rows.find(r=>r.id===f.a).payload.next,'练发球');const s=await snapshot(f,f.studentA);assert.ok(JSON.stringify(s).includes('学员可见反馈'));assert.ok(!JSON.stringify(s).includes('私密教练笔记'));assert.ok(s.records.some(r=>r.kind==='message'&&r.payload.kind==='feedback'&&r.payload.text==='学员可见反馈'));}
   if(kind==='edit-lesson'){assert.equal(row.id,f.confirmed);assert.equal(row.payload.duration,45);assert.equal(row.payload.topic,'调整主题');assert.ok(!rows.some(r=>r.kind==='ledger'&&r.lessonId===f.confirmed));}
   if(kind==='message-decision'){assert.equal(row.payload.state,'confirmed');assert.equal(rows.find(r=>r.id===f.bookingMessage).payload.state,'accepted');assert.ok((await snapshot(f,f.studentA)).records.some(r=>r.kind==='message'&&r.lessonId===f.pending&&r.payload.kind==='status'));}
   if(kind==='resolve-message')assert.equal(row.payload.state,'done');
   if(kind==='practice'){assert.equal(row.studentId,f.a);assert.equal(row.visibility,'private');assert.equal(row.payload.topic,'今日空挥');assert.ok(!(await snapshot(f)).records.some(r=>r.id===row.id));assert.ok(!(await snapshot(f,who,'B')).records.some(r=>r.id===row.id));}
   if(kind==='edit-practice'){assert.equal(row.id,f.practicePrivate);assert.equal(row.visibility,'shared');assert.equal(row.payload.topic,'改为挥拍');assert.ok((await snapshot(f)).records.some(r=>r.id===row.id));assert.ok(!(await snapshot(f,who,'B')).records.some(r=>r.id===row.id));}
   if(kind==='followup'){assert.equal(result.ids.length,1);assert.equal(rows.find(r=>r.id===result.ids[0]).payload.text,v.text);assert.ok(!rows.some(r=>r.kind==='message'&&r.payload.text===v.text));assert.match(result.message,/草稿已保存，没有发送外部消息/);}
   checks.push({mode,action:kind,databaseAssertions:true});
  },[id,...(kind==='credit'?['BOUND-02']:[]),...(['practice','edit-practice'].includes(kind)?['FUN-13']:[]),...(kind==='followup'?['BOUND-04']:[])]);
 }
}finally{await stop();}
