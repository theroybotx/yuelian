const shanghaiDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export const localDate=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':shanghaiDate.format(d);};
export let TODAY=localDate(new Date());
export const refreshToday=()=>TODAY=localDate(new Date());
export const timeText=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export const dateText=s=>s?`${Number(s.slice(5,7))} 月 ${Number(s.slice(8,10))} 日`:'';
export const moneyless=n=>n==null?'无权限':Number(Number(n).toFixed(2)).toString();
export const balanceOf=(data,id)=>data.canReadLedger?data.ledger.filter(e=>e.student===id).reduce((n,e)=>n+e.delta,0):null;
export const emptyData=()=>({students:[],venues:[],lessons:[],ledger:[],notes:[],messages:[],studentPractice:[],followups:[],availabilityRules:[],activity:[],settings:{days:[],start:'09:00',end:'21:00',travel:0},canReadLedger:false});
const exitMarker=value=>{try{if(value===undefined)return globalThis.sessionStorage?.getItem('yuelian_logout_pending')==='1';if(value)globalThis.sessionStorage?.setItem('yuelian_logout_pending','1');else globalThis.sessionStorage?.removeItem('yuelian_logout_pending');}catch{}return false;};
export const session={logoutPending:exitMarker(),identity:null,workspaces:[],workspace:null,status:null,revisions:{},submission:null,members:[],invitations:[],ready:false,error:'',loading:true,authRequired:false};
export let testPersona='';
let invalidated=()=>{},epoch=0;
export const onInvalidated=fn=>{invalidated=fn;};
export function clearSession(reason='',authRequired=false){epoch++;session.generation=epoch;session.error=reason;session.authRequired=authRequired;if(reason)session.loading=false;session.ready=false;session.identity=null;session.workspaces=[];session.status=null;session.workspace=null;session.revisions={};session.submission=null;session.members=[];session.invitations=[];session.settingsId=null;testPersona='';invalidated();}
const authChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('yuelian-auth'):null;
if(authChannel)authChannel.onmessage=()=>{exitMarker(false);session.logoutPending=false;clearSession('账号已在其他页面切换，请重新登录。',true);location.replace('/login');};
async function authAction(endpoint,body){
 const send=async()=>{
  let response;try{response=await fetch('/api/auth/'+endpoint,{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});}catch{throw Error('约练账号服务暂时无法连接，请重试。');}
  let value;try{value=await response.json();}catch{throw Error('账号服务返回不完整，请重试。');}
  if(!response.ok)throw Object.assign(Error(value.error||'账号操作未完成，请重试。'),{code:value.code,status:response.status});return value;
 };
 // Serialize cookie-changing requests across same-origin tabs. A delayed logout
 // response must finish before another tab establishes a new account session.
 return globalThis.navigator?.locks?globalThis.navigator.locks.request('yuelian-account-change',send):send();
}
export async function logout(){
 session.logoutPending=true;exitMarker(true);clearSession('正在退出约练…',true);
 try{await authAction('logout',{});}catch(error){clearSession('退出结果尚未确认，请重新点击退出约练。',true);throw error;}
 exitMarker(false);session.logoutPending=false;authChannel?.postMessage({type:'changed'});location.replace('/login');
}
export async function selectTestPersona(value){
 if(!value||!session.status?.testing?.canSwitch||!session.status.testing.personas?.some(p=>p.key===value))throw Error('无法使用这个测试身份。');
 await authAction('session',{testPersona:value});clearSession();authChannel?.postMessage({type:'changed'});location.replace('/');
}
export async function api(path,method='GET',body,signal){
 if(session.logoutPending)throw Object.assign(Error('退出结果尚未确认，请重试退出约练。'),{code:'LOGOUT_PENDING'});
 const requestEpoch=epoch;
 let response;
 try{response=await fetch('/api/workspace/'+path,{method,cache:'no-store',credentials:'same-origin',headers:method==='GET'?{}:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:signal||AbortSignal.timeout(65000)});}catch{throw Object.assign(new Error('网络暂不可用。若正在提交，请重试原操作以核对结果。'),{code:'NETWORK_ERROR'});}
 let value;try{value=await response.json();}catch{throw Object.assign(new Error('服务返回不完整，请重试原操作核对结果。'),{code:'NETWORK_ERROR'});}
 if(requestEpoch!==epoch)throw Object.assign(new Error('当前账号或教练已切换，请重新打开资料。'),{code:'CONTEXT_CHANGED'});
 if(!response.ok){
  if(response.status===401){clearSession(value.error||'约练登录已失效，请重新登录。',true);location.replace('/login');}
  else if([403,404].includes(response.status)&&/^workspaces\/[-a-z0-9]+\/snapshot$/.test(path))clearSession('当前教练关联已失效，请重新选择。');
  throw Object.assign(new Error(value.error||'无法访问该资料。'),{code:value.code,status:response.status,index:value.step,requestId:value.requestId});
 }return value;
}
export const path=suffix=>{if(!session.workspace)throw Error('请先开始执教，或接受教练的邀请。');return `workspaces/${session.workspace.id}/${suffix}`;};
export const can=permission=>session.workspace&&(['owner','admin'].includes(session.workspace.role)||session.workspace.role==='assistant'&&session.workspace.permissions.includes(permission));
export const canAction=intent=>!!session.workspace?.actions.includes(intent);
export async function bootstrap(workspaceId){
 clearSession();const generation=epoch;session.loading=true;session.error='';
 try{session.status=await api('status');testPersona=session.status.testing?.selected||'';session.identity=session.status.identity;session.workspaces=(await api('workspaces')).workspaces;
  const selected=session.workspaces.find(w=>w.id===workspaceId)||session.workspaces.find(w=>w.pending_submission)||session.workspaces[0];
  if(!selected){session.loading=false;return emptyData();}
  session.workspace={...selected,studentId:selected.student_id,actions:[]};return await refresh();
 }catch(error){if(generation===epoch){session.error=error.message;session.loading=false;}throw error;}
}
export async function refresh(){
 const value=await api(path('snapshot'));
 session.workspace=value.workspace;session.submission=value.submission||null;session.ready=true;session.loading=false;session.error='';session.settingsId=value.records.find(r=>r.kind==='settings')?.id;session.revisions=Object.fromEntries(value.records.map(r=>[r.id,r.revision]));
 return viewData(value);
}
export function viewData({records,activity}){
 const data=emptyData(),kind=k=>records.filter(r=>r.kind===k),date=r=>localDate(r.createdAt),lessonDate=id=>kind('lesson').find(l=>l.id===id)?.payload.date;
 data.canReadLedger=session.workspace.role==='student'||can('ledger.read');
 data.students=kind('student').map(r=>({id:r.id,...r.payload,initial:r.payload.name[0],color:'sage',last:kind('lesson').filter(l=>l.payload.state==='done'&&(l.studentId===r.id||kind('participant').some(p=>p.studentId===r.id&&p.lessonId===l.id))).map(l=>l.payload.date).sort().at(-1)||null}));
 data.venues=kind('venue').map(r=>({id:r.id,...r.payload}));
 data.lessons=kind('lesson').map(r=>({id:r.id,...r.payload,students:kind('participant').filter(p=>p.lessonId===r.id).map(p=>p.studentId),venue:r.venueId,note:r.payload.topic,type:r.studentId?'一对一':'小班',capacity:r.studentId?1:30}));
 data.ledger=kind('ledger').map(r=>({id:r.id,student:r.studentId,lesson:r.lessonId,date:lessonDate(r.lessonId)||date(r),...r.payload,detail:r.payload.label}));
 data.notes=kind('coach-note').map(r=>{const f=kind('feedback').find(f=>f.lessonId===r.lessonId&&f.studentId===r.studentId);return {id:r.id,student:r.studentId,lesson:r.lessonId,date:lessonDate(r.lessonId)||date(r),topic:'课后记录',observation:r.payload.text,next:'',feedback:f?.payload.text||'',published:f?.visibility==='shared'};});
 for(const f of kind('feedback'))if(!data.notes.some(n=>n.lesson===f.lessonId&&n.student===f.studentId))data.notes.push({id:f.id,student:f.studentId,lesson:f.lessonId,date:lessonDate(f.lessonId)||date(f),topic:'课后反馈',observation:'',feedback:f.payload.text,published:f.visibility==='shared'});
 data.messages=kind('message').map(r=>({id:r.id,student:r.studentId,lesson:r.lessonId,...r.payload,date:date(r)}));
 data.studentPractice=kind('practice').map(r=>({id:r.id,student:r.studentId,...r.payload,shared:r.visibility==='shared'}));
 data.followups=kind('followup').map(r=>({id:r.id,students:[r.studentId],...r.payload,state:'draft'}));
 data.availabilityRules=kind('availability').map(r=>({id:r.id,...r.payload,venue:r.venueId,preserve:true}));
 data.settings=kind('settings')[0]?.payload||data.settings;data.activity=activity||[];return data;
}
export async function loadTeam(){if(!can('team.manage'))return;const members=await api(path('members')),invitations=await api(path('invitations'));session.members=members.members;session.invitations=invitations.invitations;}
const nullFields=['studentId','studentName','lessonId','messageId','venueId','ruleId','followupId','practiceId','days','travel','shared','date','start','end','duration','from','to','day','gap','goal','next','observation','feedback','publish','text','amount','note','decision','month','name','address','court','indoor'];
export function serverPlan(result){
 const steps=[],operations=result.type==='plan'?result.steps:[result];
 const usedIds=new Set(operations.map((r,i)=>r.id||`s${i+1}`));
 for(let i=0;i<operations.length;i++){
  const r=operations[i],v=r.values||{},id=r.id||`s${i+1}`,operation={...Object.fromEntries(nullFields.map(k=>[k,null])),intent:r.type,title:r.title||'核对操作',explanation:r.explanation||''};
  const nullable=value=>value===''||value===undefined?null:value;
  for(const key of ['date','start','end','duration','from','to','day','gap','goal','next','observation','feedback','publish','text','amount','note','decision','name','address','court','days','travel'])if(key in v)operation[key]=nullable(v[key]);
  if('indoor' in v)operation.indoor=v.indoor===''?null:v.indoor===true||v.indoor==='true';
  if('shared' in v)operation.shared=v.shared===true;
  operation.studentId=nullable(v.student||r.student);operation.venueId=nullable(v.venue||r.venue);operation.lessonId=r.lesson||null;operation.messageId=r.message||null;operation.ruleId=r.rule||null;operation.followupId=r.followup||null;operation.practiceId=r.practice||null;operation.month=r.month||null;
  if(['add-student','edit-student'].includes(r.type)){operation.studentName=v.name;operation.name=null;}
  if(['practice','edit-practice'].includes(r.type))operation.name=v.topic;
  let studentRef=null,venueRef=null,dependsOn=[...(r.dependsOn||[])];
  if(operation.studentId==='__new__'&&r.unknownName){let ref=`new${i+1}`,suffix=0;while(usedIds.has(ref))ref=`new${i+1}_${++suffix}`;usedIds.add(ref);steps.push({id:ref,dependsOn:[],studentRef:null,venueRef:null,operation:{...Object.fromEntries(nullFields.map(k=>[k,null])),intent:'add-student',title:'建立学员档案',explanation:'',studentName:r.unknownName}});operation.studentId='plan:'+ref;dependsOn.push(ref);}
  for(const key of ['studentId','venueId'])if(operation[key]?.startsWith('plan:')){const ref=operation[key].slice(5);if(key==='studentId')studentRef=ref;else venueRef=ref;operation[key]=null;if(!dependsOn.includes(ref))dependsOn.push(ref);}
  steps.push({id,dependsOn,studentRef,venueRef,operation});
 }
 if(steps.length>8)throw Error('含新建档案在内最多一次处理 8 项，请分批提交。');
 return {title:result.title||'核对操作',explanation:result.explanation||'',steps};
}
export const requiredFields={booking:{student:'学员',date:'日期',start:'开始时间',duration:'时长',venue:'场地'},record:{duration:'实际上课时长',observation:'教练记录'},availability:{from:'生效日期',to:'结束日期',day:'星期',start:'开放时间',end:'结束时间',gap:'课间间隔',venue:'场地',preserve:'保留既有预约'},'add-venue':{name:'场地名称',address:'地址',court:'球场',indoor:'类型'},'edit-venue':{name:'场地名称',address:'地址',court:'球场',indoor:'类型'},'add-student':{name:'姓名'},'edit-student':{name:'姓名'},credit:{student:'学员',amount:'增加课时',note:'登记备注'},practice:{topic:'练习主题',text:'练习记录'},'edit-practice':{topic:'练习主题',text:'练习记录'},followup:{text:'回访内容'},'message-decision':{decision:'处理意见'},'edit-base':{start:'开始时间',end:'结束时间',travel:'转场时间'},'edit-lesson':{duration:'时长',note:'课程记录'}};
export const missingFields=r=>Object.entries(requiredFields[r.type]||{}).filter(([key])=>{const v=r.values?.[key];return v==null||typeof v==='string'&&!v.trim()||key==='preserve'&&v!==true;}).map(([,label])=>label);
