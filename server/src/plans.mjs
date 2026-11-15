import {randomUUID} from 'node:crypto';
import {requireModel} from './model.mjs';
import {interpret,scopeInput,validatePlan} from '../shared/assistant.ts';
import {HttpError,requireAction,requirePermission,schemas,can} from './policy.mjs';
import {getRecord,insertRecord,updateRecord,audit} from './db.mjs';

export const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const mins=t=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(t||''))throw new HttpError(400,'请补充有效时间。','MISSING_FIELDS');const [h,m]=t.split(':').map(Number);return h*60+m;};
const time=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const required=(value,message)=>{if(value==null||value==='')throw new HttpError(400,message,'MISSING_FIELDS');return value;};
const refs=[['studentId','student'],['venueId','venue'],['lessonId','lesson'],['messageId','message'],['ruleId','availability'],['practiceId','practice'],['followupId','followup']];
export const actionNames={booking:'安排课程',record:'记录上课',availability:'开放时间','add-student':'添加学员','edit-student':'修改学员',credit:'登记课时',balance:'查询余额',summary:'课程统计','message-decision':'处理预约','resolve-message':'处理消息','add-venue':'添加场地','edit-venue':'修改场地','edit-base':'常规开放时间','edit-lesson':'纠正课程',followup:'回访草稿',practice:'自主练习','edit-practice':'修改练习'};
export const allowedActions=member=>Object.keys(actionNames).filter(intent=>{try{requireAction(member,intent);return true;}catch{return false;}});
export async function authorizedRecords(c,w){
 const rows=(await c.query('SELECT * FROM app.records WHERE workspace_id=$1 ORDER BY created_at,id LIMIT 5001',[w])).rows;
 if(rows.length>5000)throw new HttpError(413,'当前资料超过单次加载范围，请联系管理员归档历史记录。','DATA_LIMIT');
 return rows;
}
function candidates(rows){
 return rows.filter(r=>r.kind==='student').filter(s=>{
  const lessons=rows.filter(l=>l.kind==='lesson'&&(l.student_id===s.id||rows.some(p=>p.kind==='participant'&&p.student_id===s.id&&p.lesson_id===l.id)));
  const last=lessons.filter(l=>l.payload.state==='done').map(l=>l.payload.date).sort().at(-1);
  return last&&(Date.parse(today())-Date.parse(last))/86400000>=21&&rows.filter(l=>l.kind==='ledger'&&l.student_id===s.id).reduce((n,l)=>n+l.payload.delta,0)>0&&!lessons.some(l=>l.payload.date>=today()&&l.payload.state!=='cancelled'&&l.payload.state!=='done');
 }).map(s=>s.id);
}
export async function modelContext(c,member,identity,w,text,selection={},plan=null){
 // The model only sees an explicitly projected subset of RLS-authorized data.
 // No contacts, private coaching notes, private practice text or browser roles.
 let rows=await authorizedRecords(c,w);const allRows=rows,actions=allowedActions(member);
 if(plan){const ids=new Set(plan.steps.flatMap(s=>refs.map(([key])=>s.operation[key]).filter(Boolean)));for(const r of rows)if(ids.has(r.id)){if(r.student_id)ids.add(r.student_id);if(r.lesson_id)ids.add(r.lesson_id);if(r.venue_id)ids.add(r.venue_id);}rows=rows.filter(r=>ids.has(r.id)||r.kind==='participant'&&ids.has(r.lesson_id)||r.kind==='settings');}
 const byKind=k=>rows.filter(r=>r.kind===k);
 const students=byKind('student').map(s=>({id:s.id,name:s.payload.name,goal:s.payload.goal||'',next:s.payload.next||'',last:byKind('lesson').filter(l=>l.payload.state==='done'&&(l.student_id===s.id||byKind('participant').some(p=>p.student_id===s.id&&p.lesson_id===l.id))).map(l=>l.payload.date).sort().at(-1)||null,balance:member.role==='student'||can(member,'ledger.read')?byKind('ledger').filter(l=>l.student_id===s.id).reduce((a,l)=>a+l.payload.delta,0):null}));
 const lessons=byKind('lesson').filter(l=>l.payload.state!=='cancelled').map(l=>({id:l.id,date:l.payload.date,start:l.payload.start,duration:l.payload.duration,students:byKind('participant').filter(p=>p.lesson_id===l.id).map(p=>p.student_id),venue:l.venue_id,state:l.payload.state,note:l.payload.topic||''}));
 const messages=byKind('message').map(m=>({id:m.id,student:m.student_id,...(m.lesson_id?{lesson:m.lesson_id}:{}),...m.payload}));
 for(const [key,kind] of [['selectedStudent','student'],['selectedLesson','lesson'],['messageId','message']])if(selection[key])await getRecord(c,w,selection[key],kind);
 const followupIds=actions.includes('followup')?candidates(allRows):[];
 const currentCoach=(await c.query('SELECT name FROM app.workspaces WHERE id=$1',[w])).rows[0];
 if(!currentCoach)throw new HttpError(404);
 const input=scopeInput({text,context:{currentCoachName:currentCoach.name,today:today(),role:member.role==='student'?'student':'coach',...(member.student_id?{selfStudentId:member.student_id}:{}),month:selection.month||today().slice(0,7),selectedStudent:selection.selectedStudent||null,selectedLesson:selection.selectedLesson||null,messageId:selection.messageId||null,students,lessons,messages,venues:byKind('venue').map(v=>({id:v.id,...v.payload})),followupIds,allowedActions:actions,rules:byKind('availability').map(r=>({id:r.id,...r.payload,venue:r.venue_id})),practices:member.role==='student'?byKind('practice').map(r=>({id:r.id,topic:r.payload.topic,date:r.payload.date,shared:r.visibility==='shared'})):[],followups:actions.includes('followup')?byKind('followup').map(r=>({id:r.id,student:r.student_id,text:r.payload.text})):[],settings:byKind('settings')[0]?.payload}});
 return {input,revisions:Object.fromEntries(allRows.map(r=>[r.id,r.revision]))};
}
export async function inferPlan(input){const {key,runtime}=requireModel();return interpret(input,key,fetch,undefined,runtime);}
export function authorizePlan(member,plan){for(const step of plan.steps)if(step.operation.intent!=='clarification')requireAction(member,step.operation.intent);}
export async function checkRevisions(c,w,plan,revisions){
 if(plan.steps.some(s=>s.operation.intent==='edit-base')){const r=(await c.query("SELECT id,revision FROM app.records WHERE workspace_id=$1 AND kind='settings'",[w])).rows[0];if(r&&revisions[r.id]!==r.revision)throw new HttpError(409,'开放时间已有更新，请刷新后核对。','STALE_PLAN');}
 for(const step of plan.steps)for(const [key,kind] of refs){const id=step.operation[key];if(!id)continue;const r=await getRecord(c,w,id,kind);if(revisions[id]!==r.revision)throw new HttpError(409,'相关资料已更新，请刷新并重新核对。','STALE_PLAN');}
}
export async function pendingSubmission(c,member,identity,w){
 const saved=(await c.query('SELECT id,status,plan,membership_revision,expires_at FROM app.plans WHERE workspace_id=$1 AND actor_id=$2 AND submission_open',[w,identity.id])).rows[0];
 if(!saved)return null;
 // Receipts contain only fixed action labels, never old student data, model
 // text or balances. Re-check current authorization even for one's own receipt.
 let available=saved.membership_revision===member.revision;
 try{authorizePlan(member,saved.plan.steps);}catch{available=false;}
 const state=!available?'unavailable':saved.status==='pending'&&new Date(saved.expires_at)<=new Date()?'expired':saved.status;
 return {id:saved.id,state,actions:available?saved.plan.steps.steps.map(s=>actionNames[s.operation.intent]||'核对操作'):[]};
}
export async function acknowledgeSubmission(c,member,identity,w,id){
 const saved=(await c.query('SELECT status,submission_open FROM app.plans WHERE workspace_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE',[w,id,identity.id])).rows[0];
 if(!saved)throw new HttpError(404);
 // Serialized with commit by the workspace transaction lock. Dismissal of a
 // pending attempt cancels it permanently; a delayed commit cannot run later.
 const status=saved.submission_open&&saved.status==='pending'?'cancelled':saved.status;
 await c.query('UPDATE app.plans SET submission_open=false,status=$3 WHERE workspace_id=$1 AND id=$2',[w,id,status]);
 if(saved.submission_open)await audit(c,identity,w,'submission.acknowledge','allowed',[id]);
 return {id,status};
}
export async function savePlan(c,member,identity,w,plan,revisions,submission=false,understanding=null){
 if(submission&&(await c.query('SELECT 1 FROM app.plans WHERE workspace_id=$1 AND actor_id=$2 AND submission_open',[w,identity.id])).rowCount)throw new HttpError(409,'请先核对上次提交结果，再发起新操作。','SUBMISSION_PENDING');
 authorizePlan(member,plan);const id=randomUUID(),followupIds=plan.steps.some(s=>s.operation.intent==='followup'&&!s.operation.followupId)?candidates(await authorizedRecords(c,w)):[];
 await c.query('INSERT INTO app.plans(workspace_id,id,actor_id,plan,membership_revision,submission_open,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval \'15 minutes\')',[w,id,identity.id,{steps:plan,revisions,followupIds,...(understanding?{understanding}:{})},member.revision,submission]);
 await audit(c,identity,w,'plan.create','allowed',[id]);return {id,plan,revisions,followupIds,expiresInSeconds:900};
}
async function slot(c,w,d,venueId,exclude=null,checkOpening=true){
 const date=required(d.date,'请补充日期。'),start=mins(d.start),duration=required(d.duration,'请补充时长。');
 if(checkOpening&&date<today()||duration<15||duration>240||duration%15!==0||start+duration>1440)throw new HttpError(400,'请检查日期和时长。','INVALID_SCHEDULE');
 await getRecord(c,w,venueId,'venue');
 if(checkOpening){const r=await c.query('SELECT private.slot_available($1,$2,$3,$4,$5,$6) AS available',[w,date,start,duration,venueId,exclude]);if(!r.rows[0].available)throw new HttpError(409,'这个时段未开放或已有预约，请选择其他时间。','SLOT_UNAVAILABLE');}
 else{
  // Staff editing/recording an existing lesson must not collide with other lessons.
  requirePermission((await c.query('SELECT * FROM app.memberships WHERE workspace_id=$1 AND user_id=private.actor()',[w])).rows[0],'schedule.read');
  const rows=await authorizedRecords(c,w),base=rows.find(r=>r.kind==='settings');
  const rule=rows.filter(r=>r.kind==='availability'&&r.venue_id===venueId&&r.payload.from<=date&&r.payload.to>=date&&r.payload.day===['日','一','二','三','四','五','六'][new Date(date+'T00:00:00Z').getUTCDay()]).sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)||a.id.localeCompare(b.id))[0];
  if(rows.some(r=>{if(r.kind!=='lesson'||r.id===exclude||r.payload.date!==date||r.payload.state==='cancelled')return false;const gap=Math.max(rule?.payload.gap||0,r.venue_id!==venueId?base?.payload.travel||0:0);return start<r.payload.start+r.payload.duration+gap&&r.payload.start<start+duration+gap;}))throw new HttpError(409,'修改后的课程时间与现有安排冲突。','SLOT_UNAVAILABLE');
 }
 return {date,start,duration};
}
async function balance(c,w,student){await getRecord(c,w,student,'student');return (await c.query("SELECT payload FROM app.records WHERE workspace_id=$1 AND student_id=$2 AND kind='ledger'",[w,student])).rows.reduce((sum,r)=>sum+Number(r.payload.delta),0);}
async function uniqueName(c,w,kind,name,except=null){if((await c.query("SELECT id FROM app.records WHERE workspace_id=$1 AND kind=$2 AND lower(payload->>'name')=lower($3) AND ($4::uuid IS NULL OR id<>$4)",[w,kind,name,except])).rowCount)throw new HttpError(409,'已有同名资料，请先选择或修改现有记录。','DUPLICATE_NAME');}
export async function commitPlan(c,member,identity,w,id){
 const saved=(await c.query('SELECT * FROM app.plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id])).rows[0];if(!saved)throw new HttpError(404);
 const plan=saved.plan.steps;authorizePlan(member,plan);
 if(saved.membership_revision!==member.revision)throw new HttpError(409,'权限已变化，请重新生成。','STALE_PLAN');
 if(saved.status==='committed')return saved.result;
 if(saved.status==='cancelled')throw new HttpError(409,'这次提交已取消，不能重新执行。','CANCELLED_PLAN');
 if(saved.status==='undone')throw new HttpError(409,'这组操作已撤销，不能重新执行。','UNDONE_PLAN');
 if(new Date(saved.expires_at)<=new Date())throw new HttpError(409,'草稿已过期，请重新生成。','STALE_PLAN');
 await checkRevisions(c,w,plan,saved.plan.revisions);
 if(plan.steps.some(s=>s.operation.intent==='clarification'))throw new HttpError(400,'请先补充说明并重新生成。','MISSING_FIELDS');
 const before=await authorizedRecords(c,w),created=new Map(),results=[];
 const add=r=>{r.payload=schemas[r.kind].parse(r.payload);return insertRecord(c,identity,w,r);};
 const update=(r,payload)=>updateRecord(c,w,r.id,schemas[r.kind].parse(payload));
 for(let index=0;index<plan.steps.length;index++){
  const step=plan.steps[index],d={...step.operation};
  try{
   if(step.studentRef)d.studentId=created.get(step.studentRef);if(step.venueRef)d.venueId=created.get(step.venueRef);
   if(step.studentRef&&!d.studentId||step.venueRef&&!d.venueId)throw new HttpError(400,'前置操作不完整。','INVALID_PLAN');
   if(member.role==='student'&&d.studentId&&d.studentId!==member.student_id)throw new HttpError(403);
   let result={step:step.id,intent:d.intent,title:actionNames[d.intent],written:!['balance','summary'].includes(d.intent),message:'已保存到当前教练的约练资料。'};
   if(d.intent==='add-student'){
    const payload=schemas.student.parse({name:required(d.studentName||d.name,'请补充姓名。'),goal:d.goal||'',next:''});await uniqueName(c,w,'student',payload.name);
    const r=await add({kind:'student',payload});created.set(step.id,r.id);result.id=r.id;
   }else if(d.intent==='edit-student'){
    const r=await getRecord(c,w,d.studentId,'student'),name=d.studentName||r.payload.name;await uniqueName(c,w,'student',name,r.id);
    await update(r,{...r.payload,name,goal:d.goal??r.payload.goal,next:d.next??r.payload.next});result.id=r.id;
   }else if(['add-venue','edit-venue'].includes(d.intent)){
    const old=d.intent==='edit-venue'?await getRecord(c,w,d.venueId,'venue'):null,payload=schemas.venue.parse({name:required(d.name??old?.payload.name,'请补充场地名称。'),address:required(d.address??old?.payload.address,'请补充地址。'),court:required(d.court??old?.payload.court,'请补充球场。'),indoor:required(d.indoor??old?.payload.indoor,'请选择室内或室外。')});await uniqueName(c,w,'venue',payload.name,old?.id);
    const r=old?await update(old,payload):await add({kind:'venue',visibility:'shared',payload});if(!old)created.set(step.id,r.id);result.id=r.id;
   }else if(d.intent==='booking'){
    const sid=member.role==='student'?member.student_id:required(d.studentId,'请选择学员。');await getRecord(c,w,sid,'student');const vid=required(d.venueId,'请选择场地。'),period=await slot(c,w,d,vid);
    const l=await add({kind:'lesson',studentId:sid,venueId:vid,visibility:'shared',payload:{...period,state:member.role==='student'?'pending':'pending_student',topic:d.note||''}});
    await add({kind:'participant',studentId:sid,lessonId:l.id,payload:{}});
    await add({kind:'message',studentId:sid,lessonId:l.id,visibility:'shared',payload:{kind:member.role==='student'?'booking':'proposal',state:'pending',title:'约课申请',text:`${period.date} ${d.start}，${period.duration} 分钟。${d.note||''}`}});result.id=l.id;result.message='预约已提交，等待对方确认。没有扣减课时。';
   }else if(d.intent==='credit'){
    await getRecord(c,w,required(d.studentId,'请选择学员。'),'student');if(!d.amount||d.amount<=0||d.amount>500||d.amount*2!==Math.trunc(d.amount*2))throw new HttpError(400,'购买课时须为 0.5 的倍数。','INVALID_AMOUNT');
    const r=await add({kind:'ledger',studentId:d.studentId,payload:{delta:d.amount,label:required(d.note,'请填写登记备注。')}});result.id=r.id;result.balance=await balance(c,w,d.studentId);result.message=`课时已登记，余额 ${result.balance} 课时。没有发起付款。`;
   }else if(d.intent==='balance'){
    result.balance=await balance(c,w,member.role==='student'?member.student_id:required(d.studentId,'请选择学员。'));result.message=`当前剩余 ${result.balance} 课时。`;
   }else if(d.intent==='availability'){
    const payload=schemas.availability.parse({from:required(d.from,'请补充生效日期。'),to:required(d.to,'请补充结束日期。'),day:required(d.day,'请选择星期。'),start:required(d.start,'请补充开始时间。'),end:required(d.end,'请补充结束时间。'),gap:required(d.gap,'请补充课间间隔。')});
    if(payload.from>payload.to||payload.to<today()||mins(payload.start)>=mins(payload.end))throw new HttpError(400,'开放日期或时间不正确。','INVALID_SCHEDULE');
    await getRecord(c,w,required(d.venueId,'请选择场地。'),'venue');
    if(d.ruleId){const old=await getRecord(c,w,d.ruleId,'availability');await c.query('UPDATE app.records SET payload=$3,venue_id=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,old.id,payload,d.venueId]);result.id=old.id;}
    else result.id=(await add({kind:'availability',venueId:d.venueId,visibility:'shared',payload})).id;result.message='开放规则已保存；既有预约保留。';
   }else if(d.intent==='edit-base'){
    const old=(await c.query("SELECT * FROM app.records WHERE workspace_id=$1 AND kind='settings'",[w])).rows[0];
    const payload=schemas.settings.parse({days:d.days??old?.payload.days??[],start:d.start??old?.payload.start,end:d.end??old?.payload.end,travel:d.travel??old?.payload.travel??0});
    if(payload.start>=payload.end)throw new HttpError(400,'结束时间必须晚于开始时间。','INVALID_SCHEDULE');
    result.id=(old?await update(old,payload):await add({kind:'settings',visibility:'shared',payload})).id;result.message=payload.days.length?'常规开放时间已更新；既有预约保留。':'常规开放日已关闭；日期规则及既有预约保留。';
   }else if(d.intent==='message-decision'){
    const m=await getRecord(c,w,required(d.messageId,'请选择预约。'),'message'),l=await getRecord(c,w,m.lesson_id,'lesson');
    if(m.payload.state!=='pending'||!['pending','pending_student'].includes(l.payload.state))throw new HttpError(409,'预约已处理。','ALREADY_HANDLED');
    if(member.role==='student'?(m.student_id!==member.student_id||m.payload.kind!=='proposal'):m.payload.kind!=='booking')throw new HttpError(403);
    const accept=required(d.decision,'请选择确认或拒绝。')==='accept';if(accept)await slot(c,w,{date:l.payload.date,start:time(l.payload.start),duration:l.payload.duration},l.venue_id,l.id);
    await update(l,{...l.payload,state:accept?'confirmed':'cancelled'});await update(m,{...m.payload,state:accept?'accepted':'declined'});
    await add({kind:'message',studentId:m.student_id,lessonId:l.id,visibility:'shared',payload:{kind:'status',state:'done',title:accept?'预约已确认':'预约未通过',text:`${l.payload.date} ${time(l.payload.start)} 的预约已${accept?'确认':'拒绝'}。`}});result.id=l.id;result.message='双方日程和收件箱已同步更新。';
   }else if(d.intent==='resolve-message'){
    const m=await getRecord(c,w,required(d.messageId,'请选择消息。'),'message');if(['booking','proposal'].includes(m.payload.kind)||m.payload.state!=='pending')throw new HttpError(409,'预约请使用确认或拒绝，其他已处理消息无需重复处理。','INVALID_MESSAGE');await update(m,{...m.payload,state:'done'});result.id=m.id;
   }else if(d.intent==='record'){
    const l=await getRecord(c,w,required(d.lessonId,'请选择课程。'),'lesson');if(l.payload.state!=='confirmed'||l.payload.date>today())throw new HttpError(409,'只能记录已经上课的已确认课程。','INVALID_LESSON');
    const sid=l.student_id;if(!sid)throw new HttpError(400,'小班消课需逐位核对。','GROUP_RECORD_UNSUPPORTED');const duration=required(d.duration,'请补充实际时长。');await slot(c,w,{date:l.payload.date,start:time(l.payload.start),duration},l.venue_id,l.id,false);
    if(await balance(c,w,sid)<duration/60)throw new HttpError(409,'课时余额不足。','INSUFFICIENT_BALANCE');
    await add({kind:'coach-note',studentId:sid,lessonId:l.id,payload:{text:required(d.observation,'请补充上课记录。')}});
    if(d.feedback||d.publish)await add({kind:'feedback',studentId:sid,lessonId:l.id,visibility:d.publish?'shared':'private',payload:{text:d.publish?required(d.feedback,'请填写要发布的反馈。'):d.feedback}});
    if(d.publish)await add({kind:'message',studentId:sid,lessonId:l.id,visibility:'shared',payload:{kind:'feedback',state:'done',title:'课后反馈',text:d.feedback}});
    await add({kind:'ledger',studentId:sid,lessonId:l.id,payload:{delta:-duration/60,label:'课程消课'}});
    const s=await getRecord(c,w,sid,'student');if(d.next!==null)await update(s,{...s.payload,next:d.next});await update(l,{...l.payload,state:'done',duration});result.id=l.id;result.message=`课程已记录，剩余 ${await balance(c,w,sid)} 课时。`;
   }else if(d.intent==='edit-lesson'){
    const l=await getRecord(c,w,d.lessonId,'lesson');if(l.payload.state==='cancelled')throw new HttpError(409,'已取消课程不能修改。','INVALID_LESSON');const duration=d.duration??l.payload.duration;
    await slot(c,w,{date:l.payload.date,start:time(l.payload.start),duration},l.venue_id,l.id,false);
    if(l.payload.state==='done'){requirePermission(member,'ledger.write');requirePermission(member,'notes.write');const entry=(await c.query("SELECT * FROM app.records WHERE workspace_id=$1 AND kind='ledger' AND lesson_id=$2 AND student_id=$3",[w,l.id,l.student_id])).rows[0];if(!entry&&duration!==l.payload.duration)throw new HttpError(409,'历史课程缺少独立消课条目，只能纠正备注，不能修改时长。','MISSING_LEDGER');if(entry&&duration!==l.payload.duration){if(await balance(c,w,l.student_id)-entry.payload.delta-duration/60<0)throw new HttpError(409,'修正后余额不足。','INSUFFICIENT_BALANCE');await update(entry,{...entry.payload,delta:-duration/60});}if(d.note!==null){const n=(await c.query("SELECT * FROM app.records WHERE workspace_id=$1 AND kind='coach-note' AND lesson_id=$2 ORDER BY created_at DESC LIMIT 1",[w,l.id])).rows[0];if(n)await update(n,{text:d.note});else if(l.student_id)await add({kind:'coach-note',studentId:l.student_id,lessonId:l.id,payload:{text:d.note}});}}
    await update(l,{...l.payload,duration,...(l.payload.state!=='done'&&d.note!==null?{topic:d.note}:{})});result.id=l.id;
   }else if(['practice','edit-practice'].includes(d.intent)){
    const old=d.intent==='edit-practice'?await getRecord(c,w,d.practiceId,'practice'):null;
    const payload=schemas.practice.parse({topic:required(d.name??old?.payload.topic,'请填写练习主题。'),text:required(d.text??old?.payload.text,'请填写练习记录。'),date:d.date??old?.payload.date??today()});
    if(payload.date>today())throw new HttpError(400,'练习日志只能记录今天或之前的练习。','INVALID_PRACTICE_DATE');
    const visibility=d.shared===null?(old?.visibility||'private'):d.shared?'shared':'private';
    if(old){await c.query('UPDATE app.records SET payload=$3,visibility=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,old.id,payload,visibility]);result.id=old.id;}
    else result.id=(await add({kind:'practice',studentId:member.student_id,visibility,payload})).id;result.message=visibility==='shared'?'练习已保存并共享给有权查看的教练。':'练习已保存；可在我的训练中调整共享范围。';
   }else if(d.intent==='followup'){
    const text=required(d.text,'请填写回访内容。');if(d.followupId){const old=await getRecord(c,w,d.followupId,'followup');await update(old,{...old.payload,text});result.id=old.id;}
    else{const ids=candidates(await authorizedRecords(c,w));if(JSON.stringify([...ids].sort())!==JSON.stringify([...(saved.plan.followupIds||[])].sort()))throw new HttpError(409,'回访条件已变化，请重新核对名单。','STALE_PLAN');result.ids=[];for(const sid of ids)result.ids.push((await add({kind:'followup',studentId:sid,payload:{text,date:today()}})).id);result.written=ids.length>0;}result.message=result.written?'回访草稿已保存，没有发送外部消息。':'当前没有符合条件的学员，没有新增草稿。';
   }else if(d.intent==='summary'){
    const month=required(d.month,'请选择月份。'),all=await authorizedRecords(c,w),target=d.studentId?await getRecord(c,w,d.studentId,'student'):null;
    const rows=all.filter(r=>r.kind==='lesson'&&r.payload.date.startsWith(month)&&(!target||r.student_id===target.id||all.some(p=>p.kind==='participant'&&p.lesson_id===r.id&&p.student_id===target.id)));
    result.studentId=target?.id||null;result.lessons=rows.filter(r=>r.payload.state!=='cancelled').length;const done=rows.filter(r=>r.payload.state==='done');result.completed=done.length;result.hours=done.reduce((n,r)=>n+r.payload.duration/60,0);result.message=`${target?target.payload.name+' · ':''}${month} 已完成 ${result.completed} 节、${result.hours} 小时，共安排 ${result.lessons} 节。`;
   }else throw new HttpError(400,'暂不支持这项操作。','UNSUPPORTED_ACTION');
   results.push(result);
  }catch(error){error.step=index;throw error;}
 }
 const after=await authorizedRecords(c,w),beforeById=new Map(before.map(r=>[r.id,r]));
 const changes=after.filter(r=>!beforeById.has(r.id)||beforeById.get(r.id).revision!==r.revision).map(r=>({before:beforeById.get(r.id)||null,after:r}));
 const response={id,results,undoable:changes.length>0};
 await c.query("UPDATE app.plans SET status='committed',committed_at=now(),result=$3,changes=$4 WHERE workspace_id=$1 AND id=$2",[w,id,response,JSON.stringify(changes)]);
 await audit(c,identity,w,'plan.commit','allowed',changes.map(r=>r.after.id));return response;
}
export async function undoPlan(c,member,identity,w,id){
 const p=(await c.query('SELECT * FROM app.plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id])).rows[0];if(!p)throw new HttpError(404);authorizePlan(member,p.plan.steps);
 if(p.membership_revision!==member.revision)throw new HttpError(409,'权限已变化，无法撤销旧操作。','STALE_PLAN');
 if(p.status==='undone')return {undone:true};if(p.status!=='committed'||!p.changes?.length)throw new HttpError(409,'这组操作不能撤销。','NOT_UNDOABLE');
 for(const change of p.changes){const r=await getRecord(c,w,change.after.id);if(r.revision!==change.after.revision)throw new HttpError(409,'相关记录已有后续修改，不能整组撤销。','UNDO_CONFLICT');}
 const priority={message:0,feedback:0,'coach-note':0,ledger:0,practice:0,participant:0,followup:0,availability:1,lesson:1,student:2,venue:2,settings:2};
 for(const change of p.changes.filter(x=>!x.before).sort((a,b)=>priority[a.after.kind]-priority[b.after.kind]))await c.query('DELETE FROM app.records WHERE workspace_id=$1 AND id=$2',[w,change.after.id]);
 for(const {before:r} of p.changes.filter(x=>x.before))await c.query('UPDATE app.records SET payload=$3,visibility=$4,venue_id=$5,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,r.id,r.payload,r.visibility,r.venue_id]);
 for(const change of p.changes.filter(x=>x.before?.kind==='lesson'&&x.before.payload.state!=='cancelled'&&['date','start','duration'].some(k=>x.before.payload[k]!==x.after.payload[k]))){const r=await getRecord(c,w,change.before.id,'lesson');await slot(c,w,{date:r.payload.date,start:time(r.payload.start),duration:r.payload.duration},r.venue_id,r.id,false);}
 const bad=(await c.query("SELECT student_id FROM app.records WHERE workspace_id=$1 AND kind='ledger' GROUP BY student_id HAVING sum((payload->>'delta')::numeric)<0",[w])).rowCount;if(bad)throw new HttpError(409,'已有后续消课，撤销会导致余额不足。','UNDO_CONFLICT');
 await c.query("UPDATE app.plans SET status='undone' WHERE workspace_id=$1 AND id=$2",[w,id]);await audit(c,identity,w,'plan.undo','allowed',p.changes.map(r=>r.after.id));return {undone:true};
}
export {validatePlan};
