// The model supplies a draft; the workspace backend owns authorization and writes.
export function toOperation(d,{data,role,request,context=null,followupIds=[],selfStudentId=null}) {
 const base={request,context,manual:false,error:'',title:d.title,explanation:d.explanation};
 const value=x=>x??'';
 const known=(rows,id)=>id==null?null:rows.find(x=>x.id===id);
 const s=known(data.students,d.studentId),l=known(data.lessons,d.lessonId),m=known(data.messages,d.messageId);
 for(const [id,rows] of [[d.studentId,data.students],[d.lessonId,data.lessons],[d.messageId,data.messages],[d.venueId,data.venues]])if(id&&!known(rows,id))throw Error('资料已变化，请重新生成草稿。');
 if(role==='student'&&(!['booking','practice','balance','summary','message-decision','resolve-message','edit-practice','clarification'].includes(d.intent)||d.studentId&&d.studentId!==selfStudentId))throw Error('当前角色不能执行这项操作。');
 switch(d.intent){
 case 'booking': {
  const unknownName=!s&&role==='coach'?value(d.studentName):'';
  const values={student:role==='student'?selfStudentId:s?.id||'',date:value(d.date),start:value(d.start),duration:value(d.duration),venue:value(d.venueId),note:value(d.note)};
  const labels={student:'请选择学员',date:'请选择日期',start:'请补充开始时间',duration:'请补充上课时长',venue:'请选择场地'};
  return {...base,type:'booking',values,unknownName,missing:Object.entries(labels).filter(([key])=>!values[key]).map(([,label])=>label)};
 }
 case 'record':if(!l||l.state!=='confirmed'||l.students.length!==1)throw Error('课程状态已变化，请重新生成。');return {...base,type:'record',lesson:l.id,values:{duration:d.duration??l.duration,observation:value(d.observation),next:value(d.next),feedback:value(d.feedback),publish:d.publish===true}};
 case 'availability':return {...base,type:'availability',rule:d.ruleId,values:{from:value(d.from),to:value(d.to),day:value(d.day),start:value(d.start),end:value(d.end),gap:value(d.gap),venue:value(d.venueId),preserve:false}};
 case 'add-student':return {...base,type:'add-student',values:{name:value(d.studentName||d.name),goal:value(d.goal)}};
 case 'edit-student':if(!s)throw Error('需要先选择学员。');return {...base,type:'edit-student',student:s.id,values:{name:d.studentName??s.name,goal:d.goal??s.goal,next:d.next??s.next}};
 case 'credit':return {...base,type:'credit',values:{student:s?.id||'',amount:value(d.amount),note:d.note??'登记课时购买'}};
 case 'edit-practice':return {...base,type:'edit-practice',practice:d.practiceId,values:{date:d.date??data.studentPractice.find(p=>p.id===d.practiceId)?.date,topic:d.name||data.studentPractice.find(p=>p.id===d.practiceId)?.topic||'',text:d.text??data.studentPractice.find(p=>p.id===d.practiceId)?.text??'',shared:d.shared??data.studentPractice.find(p=>p.id===d.practiceId)?.shared??false}};
 case 'practice':return {...base,type:'practice',values:{date:d.date,topic:d.name||'自主练习',text:value(d.text),shared:d.shared===true}};
 case 'message-decision':if(!m||m.state!=='pending'||m.kind!==(role==='coach'?'booking':'proposal')||role==='student'&&m.student!==selfStudentId)throw Error('这条预约已处理或不属于当前角色。');return {...base,type:'message-decision',message:m.id,values:{decision:d.decision}};
 case 'balance':if(!s)throw Error('需要先选择学员。');return {...base,type:'balance',student:s.id};
 case 'summary':return {...base,type:'summary',month:d.month,student:d.studentId};
 case 'followup':return {...base,type:'followup',followup:d.followupId,eligible:d.followupId?data.followups.find(f=>f.id===d.followupId)?.students||[]:followupIds,values:{text:value(d.text)}};
 case 'resolve-message':return {...base,type:'resolve-message',message:d.messageId};
 case 'edit-venue':{const old=data.venues.find(v=>v.id===d.venueId);return {...base,type:'edit-venue',venue:d.venueId,values:{name:d.name??old.name,address:d.address??old.address,court:d.court??old.court,indoor:d.indoor??old.indoor}};}
 case 'edit-base':return {...base,type:'edit-base',values:{days:d.days??data.settings.days,start:d.start??data.settings.start,end:d.end??data.settings.end,travel:d.travel??data.settings.travel}};
 case 'edit-lesson':return {...base,type:'edit-lesson',lesson:d.lessonId,values:{duration:d.duration??l.duration,note:d.note??data.notes.find(n=>n.lesson===l.id)?.observation??l.note}};
 case 'add-venue':return {...base,type:'add-venue',values:{name:value(d.name),address:value(d.address),court:value(d.court),indoor:d.indoor==null?'':String(d.indoor)}};
 default:return {...base,type:'clarification',message:d.explanation||'请补充你要处理的课程或学员。'};
 }
}

// References are draft-only identifiers. The transaction resolves them to saved IDs.
export function toPlan(plan,env) {
 if(!Array.isArray(plan.steps)||!plan.steps.length||plan.steps.length>8)throw Error('没有收到完整的操作清单。');
 const virtual=structuredClone(env.data),steps=[];
 for(const step of plan.steps){
  const d={...step.operation};
  if(step.studentRef)d.studentId='plan:'+step.studentRef;
  if(step.venueRef)d.venueId='plan:'+step.venueRef;
  const r={...toOperation(d,{...env,data:virtual}),id:step.id,dependsOn:step.dependsOn};
  steps.push(r);
  if(r.type==='add-venue')virtual.venues.push({id:'plan:'+step.id,...r.values});
  if(r.type==='add-student')virtual.students.push({id:'plan:'+step.id,...r.values,next:'',last:null});
 }
 if(steps.length===1)return steps[0];
 return {type:'plan',title:plan.title||`核对 ${steps.length} 项操作`,explanation:plan.explanation,request:env.request,context:env.context,steps,error:''};
}
