import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

const uid=key=>{const h=createHash('sha256').update('yuelian-mock-v2:'+key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export const personas=[
 {key:'lin',id:'mock:yuelian:v1:coach-lin',name:'林教练',email:'lin@mock.yuelian.invalid',role:'coach',description:'滨江训练营，负责小林和小舟'},
 {key:'chen',id:'mock:yuelian:v1:coach-chen',name:'陈教练',email:'chen@mock.yuelian.invalid',role:'coach',description:'周末网球课，负责安安'},
 {key:'xiaolin',id:'mock:yuelian:v1:student-xiaolin',name:'小林（测试学员）',email:'xiaolin@mock.yuelian.invalid',role:'student',description:'同时关联周教练和林教练，可查看两位教练的课程'},
 {key:'xiaoyu',id:'mock:yuelian:v1:student-xiaoyu',name:'小宇（测试学员）',email:'xiaoyu@mock.yuelian.invalid',role:'student',description:'周教练的另一名学员，用于检查资料隔离'},
 {key:'annan',id:'mock:yuelian:v1:student-annan',name:'安安（测试学员）',email:'annan@mock.yuelian.invalid',role:'student',description:'陈教练的学员'},
 {key:'assistant',id:'mock:yuelian:v1:assistant',name:'小周（测试助教）',email:'assistant@mock.yuelian.invalid',role:'assistant',description:'可排课和看名单，不能查看课时账本与私人备注'}
];
const byKey=key=>personas.find(p=>p.key===key);
export async function seedMockAccounts(c,controllerId){
 const accounts=[{key:'zhou',id:controllerId,name:'周教练',role:'coach',description:'弘金地训练示例，负责小林和小宇'},...personas];
 for(const p of accounts){
  await c.query("INSERT INTO private.accounts(id,username,name,registration_role,login_kind) VALUES($1,$2,$3,$4,'test') ON CONFLICT DO NOTHING",[p.id,'demo-'+p.key,p.name,p.role==='coach'?'coach':'student']);
  const existing=(await c.query('SELECT username,login_kind FROM private.accounts WHERE id=$1',[p.id])).rows[0];
  if(existing?.username!=='demo-'+p.key||existing.login_kind!=='test')throw Error('A mock account conflicts with an existing business account.');
 }
 return accounts.map(p=>({...p,username:'demo-'+p.key}));
}
export async function seedMockData(c,{controllerId,workspaceId,studentId}){
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
 const addDate=days=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
 const A=workspaceId,B=uid('workspace-lin'),C=uid('workspace-chen');
 const before=Number((await c.query('SELECT count(*) AS n FROM app.records')).rows[0].n);
 await c.query('BEGIN');
 try{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('mock-seed-v2',0))");
  for(const w of [A,B,C].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[w]);
  if(!(await c.query("SELECT 1 FROM app.workspaces w JOIN app.memberships m ON m.workspace_id=w.id JOIN app.records r ON r.workspace_id=w.id WHERE w.id=$1 AND w.created_by=$2 AND m.user_id=$2 AND m.role='owner' AND m.active AND r.id=$3 AND r.kind='student'",[A,controllerId,studentId])).rowCount)throw Error('The selected workspace/student must belong to the real controller.');
  const accounts=await seedMockAccounts(c,controllerId);
  for(const [w,name,key] of [[B,'示例 · 林教练','lin'],[C,'示例 · 陈教练','chen']]){
   await c.query('INSERT INTO app.workspaces(id,name,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[w,name,byKey(key).id]);
   await c.query("INSERT INTO app.memberships(workspace_id,user_id,display_name,role) VALUES($1,$2,$3,'owner') ON CONFLICT DO NOTHING",[w,byKey(key).id,byKey(key).name]);
  }
  const owners={[A]:controllerId,[B]:byKey('lin').id,[C]:byKey('chen').id};
  async function rec(w,key,kind,payload,{student=null,lesson=null,venue=null,owner=owners[w],visibility='private'}={}){
   const id=uid(w+':'+key);await c.query('INSERT INTO app.records(workspace_id,id,kind,student_id,lesson_id,venue_id,owner_user_id,visibility,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[w,id,kind,student,lesson,venue,owner,visibility,payload]);return id;
  }
  const xiaolinA=studentId,xiaoyu=await rec(A,'xiaoyu','student',{name:'小宇',goal:'建立稳定的双手反拍',next:'转肩与击球点'}),xiaolinB=await rec(B,'xiaolin','student',{name:'小林',goal:'提升发球与网前衔接',next:'二发落点'}),xiaozhou=await rec(B,'xiaozhou','student',{name:'小舟',goal:'体验网球基础',next:'握拍与准备姿势'}),annan=await rec(C,'annan','student',{name:'安安',goal:'保持每周一次网球练习',next:'移动中的正手'});
  for(const [w,key,role,sid,permissions] of [[A,'xiaolin','student',xiaolinA,[]],[A,'xiaoyu','student',xiaoyu,[]],[B,'xiaolin','student',xiaolinB,[]],[C,'annan','student',annan,[]],[A,'assistant','assistant',null,['students.read','schedule.read','schedule.write','venues.read']]]){
   const p=byKey(key);const existing=(await c.query('SELECT user_id FROM app.memberships WHERE workspace_id=$1 AND student_id=$2',[w,sid])).rows[0];if(existing&&existing.user_id!==p.id)throw Error('A selected student is already linked; existing binding will not be overwritten.');
   await c.query('INSERT INTO app.memberships(workspace_id,user_id,display_name,role,student_id,permissions) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[w,p.id,p.name,role,sid,permissions]);
  }
  const venues={};
  for(const [w,name,address] of [[A,'示例 · 弘金地网球场','测试地址 · 体育路 1 号'],[B,'示例 · 滨江网球场','测试地址 · 江畔路 2 号'],[C,'示例 · 城市网球中心','测试地址 · 公园路 3 号']]){
   venues[w]=await rec(w,'venue','venue',{name,address,court:'1 号场',indoor:false},{visibility:'shared'});
   if(!(await c.query("SELECT 1 FROM app.records WHERE workspace_id=$1 AND kind='settings'",[w])).rowCount)await rec(w,'settings','settings',{days:['一','二','三','四','五','六','日'],start:'09:00',end:'21:00',travel:15},{visibility:'shared'});
  }
  for(const [w,s,n] of [[A,xiaolinA,10],[A,xiaoyu,8],[B,xiaolinB,5],[B,xiaozhou,0],[C,annan,6]])if(n)await rec(w,'credit-'+s,'ledger',{delta:n,label:'Mock 课时包（不收费）'},{student:s});
  async function lesson(w,key,s,days,start,duration,state,topic){const id=await rec(w,key,'lesson',{date:addDate(days),start,duration,state,topic},{student:s,venue:venues[w],visibility:'shared'});await rec(w,key+'-participant','participant',{}, {student:s,lesson:id});return id;}
  const done=await lesson(A,'xiaolin-done',xiaolinA,-1,600,60,'done','正手稳定性与移动步法');
  await rec(A,'xiaolin-charge','ledger',{delta:-1,label:'Mock 已完成课程 60 分钟'},{student:xiaolinA,lesson:done});
  await rec(A,'xiaolin-feedback','feedback',{text:'正手连续回合更稳定，下次继续练习向前迎球。'},{student:xiaolinA,lesson:done,visibility:'shared'});
  await rec(A,'xiaolin-private-note','coach-note',{text:'仅教练可见的 Mock 备注：反手准备稍晚，安排分解练习。'},{student:xiaolinA,lesson:done});
  await rec(A,'peer-contact','contact',{phone:'MOCK-NOT-A-PHONE',email:'xiaoyu@mock.yuelian.invalid'},{student:xiaoyu});
  const pending=await lesson(A,'xiaolin-pending',xiaolinA,1,900,60,'pending','正手与反手练习');
  await rec(A,'xiaolin-booking-message','message',{kind:'booking',state:'pending',title:'小林的预约申请',text:'希望明天下午 3 点练正手和反手。'},{student:xiaolinA,lesson:pending,visibility:'shared'});
  const proposed=await lesson(A,'xiaoyu-proposal',xiaoyu,1,1020,60,'pending_student','双手反拍准备');
  await rec(A,'xiaoyu-proposal-message','message',{kind:'proposal',state:'pending',title:'教练发来课程邀请',text:'明天下午 5 点，一小时反手训练。'},{student:xiaoyu,lesson:proposed,visibility:'shared'});
  await lesson(B,'xiaolin-confirmed',xiaolinB,2,1080,60,'confirmed','发球和网前衔接');
  await lesson(C,'annan-confirmed',annan,1,660,60,'confirmed','正手移动击球');
  await rec(A,'xiaolin-practice','practice',{date:addDate(-2),topic:'自主练习',text:'反手挥拍 20 分钟，注意提前转肩。'},{student:xiaolinA,owner:byKey('xiaolin').id});
  await c.query('INSERT INTO app.audit(workspace_id,id,actor_id,action,outcome,targets,request_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[A,uid('seed-audit'),controllerId,'testing.seed','allowed',[A,B,C],randomUUID()]);
  await c.query('COMMIT');
  return {controllerId,workspaces:{zhou:A,lin:B,chen:C},students:{xiaolinA,xiaoyu,xiaolinB,xiaozhou,annan},venues,lessons:{pending,done,proposed},date,recordsAdded:Number((await c.query('SELECT count(*) AS n FROM app.records')).rows[0].n)-before,personas:accounts};
 }catch(e){await c.query('ROLLBACK');throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.env.YUELIAN_ENVIRONMENT!=='test')throw Error('Mock seeding requires YUELIAN_ENVIRONMENT=test.');
 const [controllerId,workspaceId,studentId,configPath,reportPath]=process.argv.slice(2);if(!reportPath||!configPath)throw Error('Expected controller, workspace, student, private config path and report path.');
 const c=new pg.Client({host:'/tmp',database:process.env.YUELIAN_SEED_DATABASE||'yuelian_security',user:process.env.USER});await c.connect();
 try{const result=await seedMockData(c,{controllerId,workspaceId,studentId});writeFileSync(configPath,JSON.stringify({controllerId,personas},null,2)+'\n',{mode:0o600});writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({seeded:true,recordsAdded:result.recordsAdded,workspaceCount:3,personaCount:personas.length,existingRecordsPreserved:true}));}finally{await c.end();}
}
