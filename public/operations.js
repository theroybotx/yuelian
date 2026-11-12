import {TODAY,balanceOf,timeText,dateText,moneyless} from './data.js';
const clone=value=>structuredClone(value);
const minutes=value=>{const [h,m]=String(value).split(':').map(Number);return h*60+m;};
const dayOf=date=>['日','一','二','三','四','五','六'][new Date(date+'T00:00:00Z').getUTCDay()];
export class OperationError extends Error { constructor(message,index=-1){super(message);this.index=index;} }
const fail=message=>{throw new OperationError(message);};
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const validTime=value=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export const requiredFields={
 booking:{student:'学员',date:'日期',start:'开始时间',duration:'时长',venue:'场地'},
 record:{duration:'实际上课时长',observation:'教练记录'},
 availability:{from:'生效日期',to:'结束日期',day:'星期',start:'开放时间',end:'结束时间',gap:'课间间隔',venue:'场地',preserve:'保留既有预约'},
 'add-venue':{name:'场地名称',address:'地址',court:'球场',indoor:'类型'},
 'edit-venue':{name:'场地名称',address:'地址',court:'球场',indoor:'类型'},
 'add-student':{name:'姓名'},'edit-student':{name:'姓名'},credit:{student:'学员',amount:'增加课时',note:'登记备注'},
 practice:{topic:'练习主题',text:'练习记录'},followup:{text:'回访内容'},'message-decision':{decision:'处理意见'},
 'edit-base':{start:'开始时间',end:'结束时间',travel:'转场时间'},'edit-lesson':{duration:'时长',note:'课程记录'}
};
export function missingFields(r){return Object.entries(requiredFields[r.type]||{}).filter(([key])=>{const v=r.values?.[key];return v==null||typeof v==='string'&&!v.trim()||key==='preserve'&&v!==true;}).map(([,label])=>label);}
function checkValues(data,r,role){
 const v=r.values||{},missing=missingFields(r);if(missing.length)fail('请补充：'+missing.join('、')+'。');
 for(const key of ['date','from','to'])if(key in v&&!validDate(v[key]))fail('请填写有效日期。');
 for(const key of ['start','end'])if(key in v&&!validTime(v[key]))fail('请填写有效时间。');
 for(const [key,min,max,step] of [['duration',r.type==='booking'?30:15,r.type==='booking'?180:240,r.type==='booking'?30:15],['amount',.5,500,.5],['gap',0,120,5],['travel',0,180,5]]){
  if(key in v&&(!Number.isFinite(Number(v[key]))||Number(v[key])<min||Number(v[key])>max||Number(v[key])%step!==0))fail('请检查时长、课时或间隔的范围与步长。');
  if(key in v)v[key]=Number(v[key]);
 }
 if('venue' in v&&!data.venues.some(x=>x.id===v.venue))fail('请选择有效场地。');
 if('student' in v&&!data.students.some(x=>x.id===v.student)&&!(r.type==='booking'&&role==='coach'&&v.student==='__new__'&&r.unknownName))fail('请选择有效学员。');
 if(role==='student'&&('student' in v&&v.student!=='roy'||r.student&&r.student!=='roy'))fail('只能操作自己的课程和资料。');
 if('indoor' in v&&![true,false,'true','false'].includes(v.indoor))fail('请选择室内或室外。');
 if(r.type==='availability'&&!['一','二','三','四','五','六','日'].includes(v.day))fail('请选择星期。');
 if(r.type==='message-decision'&&!['accept','reject'].includes(v.decision))fail('请选择确认或拒绝。');
 if(r.type==='edit-base'&&(!Array.isArray(v.days)||v.days.some(d=>!['一','二','三','四','五','六','日'].includes(d))))fail('请选择有效的开放日。');
 const limits={name:['add-venue','edit-venue'].includes(r.type)?60:20,goal:100,next:300,address:200,court:30,topic:60,observation:600,feedback:600,text:600,note:r.type==='edit-lesson'?600:300};
 for(const [key,max] of Object.entries(limits))if(key in v&&(typeof v[key]!=='string'||v[key].length>max))fail('输入内容过长或格式不正确，请检查文字字段。');
}
function activeRule(data,date) {return (data.availabilityRules||[]).slice().reverse().find(r=>date>=r.from&&date<=r.to&&dayOf(date)===r.day);}
export function validateSlot(data,l,exclude=null,checkOpening=true,today=TODAY) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(l.date)||!Number.isFinite(l.start)||!Number.isFinite(l.duration)||l.duration<=0) return '请填写有效的日期、时间和时长。';
 const rule=activeRule(data,l.date), start=rule?minutes(rule.start):minutes(data.settings.start), end=rule?minutes(rule.end):minutes(data.settings.end);
 if(l.start<0||l.start+l.duration>1440) return '课程时间不能跨到第二天。';
 if(checkOpening) {
  if(l.date<today) return '不能为过去的日期发起新预约。';
  if(!rule&&!data.settings.days.includes(dayOf(l.date))) return '当天未开放预约，请换一个日期。';
  if(l.start<start||l.start+l.duration>end) return `可约时段为 ${timeText(start)}–${timeText(end)}，请调整时间。`;
  if(rule&&l.venue!==rule.venue) return `当天的开放场地为${data.venues.find(v=>v.id===rule.venue)?.name||'指定场地'}，请调整场地。`;
 }
 const conflicts=data.lessons.filter(x=>x.id!==exclude&&x.state!=='cancelled'&&x.date===l.date).filter(x=>{
  const gap=x.venue!==l.venue?Math.max(Number(data.settings.travel),Number(rule?.gap||0)):Number(rule?.gap||0);
  return l.start<x.start+x.duration+gap&&l.start+l.duration+gap>x.start;
 });
 return conflicts.length?`与 ${conflicts[0].students.map(id=>data.students.find(s=>s.id===id)?.name||'学员').join('、')} 的 ${timeText(conflicts[0].start)} 课程或课间预留冲突，请调整时间。`:'';
}

function applyOperation(data,r,{role,uid}){
 const v=r.values||{},student=id=>data.students.find(s=>s.id===id),venue=id=>data.venues.find(v=>v.id===id);
 let label='';
 const mutate=(name,fn)=>{label=name;fn();};
 const success=(title,message,link)=>({title,message,link,label,written:!!label});
 const ruleImpact=v=>data.lessons.filter(l=>l.state!=='cancelled'&&l.date>=v.from&&l.date<=v.to&&dayOf(l.date)===v.day&&(l.venue!==v.venue||l.start<minutes(v.start)||l.start+l.duration>minutes(v.end)));
 if(role!=='coach'&&!['booking','practice','balance','summary','message-decision'].includes(r.type))fail('当前角色不能修改教练资料。');
 if(r.type==='clarification')fail('请先补充这一步的处理意见，再重新整理清单。');
 if(r.type==='followup'&&!r.eligible?.length)return success('没有需要回访的学员','没有创建回访草稿。','students');
 checkValues(data,r,role);
 if(r.type==='record'){
  const l=data.lessons.find(l=>l.id===r.lesson);
  if(!l||l.students.length!==1||l.date>TODAY)fail('只能记录已经上课的一对一课程。');
 }
 if(r.type==='edit-student'&&!student(r.student))fail('学员资料已变化，请重新选择。');
 if(r.type==='edit-venue'&&!venue(r.venue))fail('场地资料已变化，请重新选择。');
 if(r.type==='edit-lesson'&&!data.lessons.some(l=>l.id===r.lesson))fail('课程资料已变化，请重新选择。');
 if(r.type==='practice'&&role!=='student')fail('请在学员视角记录自己的练习。');
 if(r.type==='followup'){
  if(!r.eligible?.length) return success('没有需要回访的学员','没有创建回访草稿。','students');
  if(r.eligible.some(id=>!student(id)))fail('回访名单已变化，请重新生成。');
  if(!r.followup&&r.eligible.some(id=>{const s=student(id);return !s.last||(Date.parse(TODAY)-Date.parse(s.last))/86400000<21||balanceOf(data,id)<=0||data.lessons.some(l=>l.students.includes(id)&&l.date>TODAY&&l.state!=='cancelled');}))fail('回访条件已经变化，请重新生成。');
 }
 if(r.type==='message-decision'){
  const m=data.messages.find(x=>x.id===r.message),l=data.lessons.find(x=>x.id===m?.lesson),accept=v.decision==='accept';
  if(!m||m.state!=='pending'||!l||!['pending','pending_student'].includes(l.state))fail('这条预约已经处理，不能重复执行。');
  if(!(role==='coach'&&m.kind==='booking'||role==='student'&&m.kind==='proposal'&&m.student==='roy'))fail('当前角色不能处理这条预约。');
  if(accept){const error=validateSlot(data,l,l.id,false);if(error)fail(error);}
  mutate(accept?'确认预约':'拒绝预约',()=>{
   m.state=accept?'accepted':'declined';l.state=accept?'confirmed':'cancelled';
   data.messages.push({id:uid('message'),kind:'status',student:l.students[0],lesson:l.id,title:accept?'预约已确认':'预约未通过',text:`${dateText(l.date)} ${timeText(l.start)}，${venue(l.venue).name}。${accept?'已进入正式日程，期待球场见。':'可以重新提出其他时间。'}`,state:'done',date:'今天 · 刚刚'});
  });
  return success(accept?'预约已确认':'预约已拒绝',accept?'双方示例日程已更新，对方收件箱可以查看确认结果。':'日程已移除该预约，对方收件箱可以查看结果。','inbox');
 }
 if(r.type==='balance'){
  const s=student(r.student);if(!s)fail('请选择有效学员。');
  return success('课时核对',`${s.name} 还剩 ${moneyless(balanceOf(data,s.id))} 课时。`,'stats');
 }
 if(r.type==='summary'){
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(r.month))fail('请选择统计月份。');
  const lessons=data.lessons.filter(l=>l.date.slice(0,7)===r.month&&l.state!=='cancelled'&&(role==='coach'||l.students.includes('roy'))),done=lessons.filter(l=>l.state==='done');
  return success(r.month+' 课程统计',`已完成 ${done.length} 节、${moneyless(done.reduce((sum,l)=>sum+l.duration/60,0))} 小时；共安排 ${lessons.length} 节（含待确认）。`,'stats');
 }
 if(r.type==='record') {
  const l=data.lessons.find(l=>l.id===r.lesson),s=student(l.students[0]);
  if(l.state==='done'||data.ledger.some(e=>e.lesson===l.id)) return fail('这节课已记录，没有重复扣减课时。');
  if(!['confirmed'].includes(l.state)) return fail('请先确认预约，再记录到课。');
  if(balanceOf(data,s.id)<v.duration/60) return fail('剩余课时不足，请先核对课时账本。');
  const conflict=validateSlot(data,{...l,duration:v.duration},l.id,false);if(conflict)return fail(conflict);
  if(v.publish&&!v.feedback.trim())return fail('选择向学员发布时，请填写反馈内容。');
  mutate('课后记录',()=>{
   l.duration=v.duration;l.state='done';l.note=v.observation;s.last=l.date;s.note=v.observation;s.next=v.next;
   data.ledger.push({id:uid('ledger'),student:s.id,date:l.date,delta:-v.duration/60,label:`一对一 · ${v.duration} 分钟`,detail:`${venue(l.venue).name} · 已到课`,lesson:l.id});
   const note={id:uid('note'),student:s.id,lesson:l.id,date:l.date,topic:s.goal+' · 课后记录',observation:v.observation,next:v.next,feedback:v.feedback,published:v.publish};data.notes.unshift(note);
   if(v.publish)data.messages.push({id:uid('message'),student:s.id,kind:'feedback',title:dateText(l.date)+' · 课后反馈',text:v.feedback,note:note.id,state:'done',date:'今天 · 刚刚'});
  });
  return success('课程已记录',`扣除 ${moneyless(v.duration/60)} 课时，${s.name} 还剩 ${moneyless(balanceOf(data,s.id))} 课时。${v.publish?'反馈已放入学员示例收件箱。':'记录仅教练可见。'}`,'schedule');
 }
 if(r.type==='booking') {
  const l={id:uid('lesson'),date:v.date,start:minutes(v.start),duration:v.duration,students:[role==='student'?'roy':v.student],venue:v.venue,type:'一对一',capacity:1,state:role==='coach'?'pending_student':'pending',note:v.note};
  const error=validateSlot(data,l);if(error)return fail(error);
  const creating=role==='coach'&&v.student==='__new__'&&r.unknownName;
  if((!creating&&!student(l.students[0]))||!venue(l.venue))return fail('请选择有效的学员和场地。');
  if(creating&&data.students.some(s=>s.name.toLowerCase()===r.unknownName.toLowerCase()))return fail('已有同名学员，请从名单中选择，避免重复建档。');
  mutate(creating?'新增学员与预约提案':'预约提案',()=>{
   if(creating){const s={id:uid('student'),name:r.unknownName,initial:r.unknownName[0],goal:'',last:null,note:'',next:'',color:'sage'};data.students.push(s);l.students=[s.id];}
   data.lessons.push(l);data.messages.push({id:uid('message'),kind:role==='coach'?'proposal':'booking',student:l.students[0],lesson:l.id,title:dateText(l.date)+' · 约课申请',text:`${timeText(l.start)}，${venue(l.venue).name}，${l.duration} 分钟。${l.note}`,state:'pending',date:'今天 · 刚刚'});
  });
  
  return success('预约已提交',`${role==='coach'?'等待学员确认；切换为学员可在收件箱处理。':'等待教练确认；切换为教练可在收件箱处理。'}没有扣减课时。`,'schedule');
 }
 if(r.type==='availability') {
  if(v.from>v.to||v.to<TODAY)return fail('请检查生效日期和结束日期。');
  if(minutes(v.start)>=minutes(v.end))return fail('结束时间必须晚于开始时间。');
  if(!v.preserve)return fail('请确认保留既有预约。');
  const count=ruleImpact(v).length;
  mutate('开放规则',()=>{const newRule={...v,id:r.rule||uid('rule')};if(r.rule)data.availabilityRules=data.availabilityRules.map(x=>x.id===r.rule?newRule:x);else data.availabilityRules.push(newRule);});
  return success('开放时间已更新',`每周${v.day} ${v.start}–${v.end}，${venue(v.venue).name}，间隔 ${v.gap} 分钟。${count?`${count} 节不一致的既有预约已保留。`:'既有预约保持原状。'}`,'availability');
 }
 if(r.type==='followup') {mutate('回访草稿',()=>{if(r.followup){data.followups.find(f=>f.id===r.followup).text=v.text;}else{data.followups.push({id:uid('followup'),students:r.eligible,text:v.text,date:TODAY,state:'draft'});}});return success('回访草稿已保存','草稿保存在本浏览器的学员记录中，没有发送外部消息。','students');}
 if(r.type==='add-student') {
  if(data.students.some(s=>s.name.toLowerCase()===v.name.trim().toLowerCase()))return fail('已有同名学员，请先查看档案，避免重复录入。');
  const s={id:uid('student'),name:v.name.trim(),initial:v.name.trim()[0],goal:v.goal,last:null,note:'',next:'',color:'sage'};
  if(!s.name)return fail('请填写姓名。');
  mutate('新增学员',()=>data.students.push(s));return success('学员档案已建立',`${s.name}，初始余额 0 课时，尚无训练记录。`,'students');
 }
 if(r.type==='edit-student') {
  if(!v.name.trim())return fail('请填写姓名。');
  if(data.students.some(s=>s.id!==r.student&&s.name.toLowerCase()===v.name.trim().toLowerCase()))return fail('已有同名学员，请核对姓名。');
  mutate('学员资料纠错',()=>Object.assign(student(r.student),{name:v.name.trim(),initial:v.name.trim()[0],goal:v.goal,next:v.next}));return success('学员资料已更正','训练记录和课时账本已保留。','students');
 }
 if(r.type==='credit') {
  if(!Number.isFinite(v.amount)||v.amount<=0||v.amount>500)return fail('请填写 0.5 到 500 之间的课时。');
  mutate('登记课时包',()=>data.ledger.push({id:uid('ledger'),student:v.student,date:TODAY,delta:v.amount,label:'购买课时包',detail:v.note}));
  return success('课时已登记',`${student(v.student).name} 增加 ${moneyless(v.amount)} 课时，余额 ${moneyless(balanceOf(data,v.student))}。没有产生真实扣款。`,'stats');
 }
 if(r.type==='practice') {
  mutate('自主练习',()=>{data.studentPractice.unshift({id:uid('practice'),student:'roy',topic:v.topic,text:v.text,date:TODAY});data.messages.push({id:uid('message'),kind:'practice',student:'roy',title:'Roy 的自主练习 · '+v.topic,text:v.text,state:'pending',date:'今天 · 刚刚'});});return success('练习已记下','保存在“我的训练”，也已放入教练的示例收件箱。','progress');
 }
 if(r.type==='add-venue'){
  if(!v.name.trim()||!v.address.trim()||!v.court.trim())return fail('请填写场地名称、地址和球场。');
  if(data.venues.some(x=>x.name===v.name.trim()))return fail('已有同名场地，请先查看或编辑。');
  mutate('添加场地',()=>data.venues.push({id:uid('venue'),name:v.name.trim(),address:v.address.trim(),court:v.court.trim(),indoor:v.indoor===true||v.indoor==='true'}));
  return success('场地已添加','可以在安排课程和开放时段中选择这个场地。','availability');
 }
 if(r.type==='edit-venue') {mutate('场地资料纠错',()=>Object.assign(venue(r.venue),{name:v.name,address:v.address,court:v.court,indoor:v.indoor===true||v.indoor==='true'}));return success('场地资料已更正','课程中的场地名称会同步显示。','availability');}
 if(r.type==='edit-base') {
  if(!v.days.length)return fail('请至少选择一个开放日。');
  if(minutes(v.start)>=minutes(v.end))return fail('结束时间必须晚于开始时间。');
  mutate('常规开放时间纠错',()=>Object.assign(data.settings,{days:[...new Set(v.days)],start:v.start,end:v.end,travel:v.travel}));return success('常规开放时间已更正','新的可约时段只用于新预约；既有预约不变。','availability');
 }
 if(r.type==='edit-lesson') {
  const l=data.lessons.find(l=>l.id===r.lesson),entry=data.ledger.find(e=>e.lesson===l.id);
  const error=validateSlot(data,{...l,duration:v.duration},l.id,false);if(error)return fail(error);
  if(entry&&balanceOf(data,entry.student)-entry.delta-v.duration/60<0)return fail('修正后的课时余额不足，请先核对账本。');
  mutate('课程记录纠错',()=>{
   l.note=v.note;
   if(l.state!=='done'||entry)l.duration=v.duration;
   if(entry){entry.delta=-v.duration/60;entry.label=`一对一 · ${v.duration} 分钟`;}
   const note=data.notes.find(n=>n.lesson===l.id);if(note)note.observation=v.note;
  });return success('原记录已更正',entry?'同一笔消课记录已同步调整，没有重复扣款。':'课程备注与时间已更新。','schedule');
 }

 fail('这项操作暂不支持执行，请使用页面上的直接操作。');
}
// Apply all steps to an isolated copy. Nothing reaches storage until all succeed.
export function executeOperations(original,operations,{role,uid=prefix=>`${prefix}-${crypto.randomUUID()}`}={}){
 if(!operations.length||operations.length>8)throw new OperationError('一份清单支持 1 到 8 项操作。');
 const data=clone(original),created=new Map(),completed=new Set(),outcomes=[];
 for(let index=0;index<operations.length;index++){
  const r=clone(operations[index]);
  try{
   if((r.dependsOn||[]).some(id=>!completed.has(id)))fail('前置步骤缺失，请重新整理清单。');
   for(const [target,key,kind] of [[r.values,'venue','add-venue'],[r.values,'student','add-student'],[r,'student','add-student']]){
    if(typeof target?.[key]==='string'&&target[key].startsWith('plan:')){
     const ref=target[key].slice(5),entry=created.get(ref);
     if(!entry||entry.type!==kind||!r.dependsOn?.includes(ref))fail('前置步骤的资料无法关联，请重新整理。');
     target[key]=entry.id;
    }
   }
   const outcome=applyOperation(data,r,{role,uid});outcomes.push(outcome);
   if(r.type==='add-venue'||r.type==='add-student')created.set(r.id,{type:r.type,id:(r.type==='add-venue'?data.venues:data.students).at(-1).id});
   if(r.id){if(completed.has(r.id))fail('操作清单包含重复步骤。');completed.add(r.id);}
  }catch(error){throw new OperationError(error instanceof OperationError?error.message:'资料已变化，请重新核对这一步。',index);}
 }
 return {data,outcomes};
}
