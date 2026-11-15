import http from 'node:http';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Plan,AssistantError} from '../shared/assistant.ts';
import {HttpError,uuid,permissions,capabilities,projection,requirePermission} from './policy.mjs';
import {pool,isDatabaseUnavailable,assertRuntimeRole,transaction,audit,rejected,getRecord} from './db.mjs';
import {resolveTestIdentity} from './testing.mjs';
import {handleAuth,authenticateSession,authTestingStatus} from './auth.mjs';
import {username} from './auth-crypto.mjs';
import {createTransportAuthenticator,preauthKey} from './transport-auth.mjs';
import {modelContext,inferPlan,validatePlan,authorizePlan,pendingSubmission,acknowledgeSubmission,savePlan,commitPlan,undoPlan,checkRevisions,authorizedRecords,allowedActions,today} from './plans.mjs';

import {generationSnapshot,generateResponse,saveGeneration} from './generation.mjs';
import {modelSettings,createModelRunner} from './model.mjs';

const verifyTransport=createTransportAuthenticator({sitesSecret:process.env.YUELIAN_BRIDGE_SECRET,standaloneSecret:process.env.YUELIAN_STANDALONE_BRIDGE_SECRET});
const enabled=process.env.YUELIAN_ACCEPT_REAL_DATA==='true';
const hash=s=>createHash('sha256').update(s).digest('hex');
const rates=new Map(),modelRates=new Map();
const runModel=createModelRunner();
const selection=z.object({selectedStudent:uuid.optional(),selectedLesson:uuid.optional(),messageId:uuid.optional(),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();
// Shared schemas and the service use separate installed Zod copies. Both are
// trusted validators; constructor identity alone misses valid input failures.
const validationError=error=>error instanceof z.ZodError||error?.name==='ZodError'&&Array.isArray(error.issues)&&error.issues.every(issue=>Array.isArray(issue.path)&&typeof issue.code==='string');
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(value));}
async function bodyOf(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>65536)throw new HttpError(413,'请求过大。','BODY_LIMIT');parts.push(part);}return Buffer.concat(parts).toString('utf8');}
async function authenticate(req,raw){
 const identity=verifyTransport(req,raw);
 try{await pool.query("INSERT INTO private.request_nonces(nonce,expires_at) VALUES($1,now()+interval '5 minutes')",[identity.requestId]);}catch(e){if(e.code==='23505')throw new HttpError(401);throw e;}
 await pool.query('DELETE FROM private.request_nonces WHERE expires_at<now()');
 return identity;
}
function limitRequests(key){
 const now=Date.now();for(const [id,r] of rates)if(r.until<now)rates.delete(id);
 const rate=rates.get(key)||{count:0,until:now+60000};if(++rate.count>40)throw new HttpError(429,'操作较频繁，请稍后再试。','RATE_LIMIT');rates.set(key,rate);
}
async function route(method,path,body,identity){
 if(method==='GET'&&path==='/v1/status'){const model=modelSettings();return {backend:'postgresql',mode:enabled?'trial':'review',model:model.runtime.config.modelLabel,configured:model.configured,today:today(),identity:{id:identity.id,name:identity.name,username:identity.username,registrationRole:identity.registrationRole},testing:authTestingStatus(identity),capabilities};}
 if(method!=='GET'&&!enabled)throw new HttpError(503,'权限模块已部署为审阅版。测试用例待审阅，业务写入尚未开放。','REVIEW_MODE');
 if(path==='/v1/workspaces'&&method==='GET'){
  const workspaces=await transaction(identity,null,async c=>(await c.query('SELECT w.id,w.name,m.role,m.permissions,m.student_id,m.revision FROM app.workspaces w JOIN app.memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 AND m.active ORDER BY w.created_at',[identity.id])).rows);
  // Plan RLS deliberately needs a workspace context, even when listing one's
  // own receipts. Enter each authorized workspace rather than bypassing RLS.
  for(const workspace of workspaces)workspace.pending_submission=await transaction(identity,workspace.id,async c=>(await c.query('SELECT 1 FROM app.plans WHERE workspace_id=$1 AND actor_id=$2 AND submission_open',[workspace.id,identity.id])).rowCount>0);
  return {workspaces};
 }
 if(path==='/v1/workspaces'&&method==='POST'){
  if(identity.registrationRole!=='coach')throw new HttpError(403,'当前学员账号不能创建教练资料。','COACH_ACCOUNT_REQUIRED');
  const input=z.object({name:z.string().trim().min(1).max(80)}).strict().parse(body),id=randomUUID();
  return transaction(identity,null,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace-owner:'||$1,0))",[identity.id]);
   const existing=await c.query("SELECT w.id,w.name FROM app.workspaces w JOIN app.memberships m ON m.workspace_id=w.id WHERE w.created_by=$1 AND m.user_id=$1 AND m.role='owner' AND m.active ORDER BY w.created_at LIMIT 1",[identity.id]);
   if(existing.rowCount)return existing.rows[0];
   const count=await c.query("SELECT count(*)::integer AS n FROM app.workspaces WHERE created_by=$1",[identity.id]);if(count.rows[0].n>=5)throw new HttpError(429,'教练资料数量已达上限，请联系管理员。','WORKSPACE_LIMIT');
   await c.query('SELECT private.create_workspace($1,$2,$3)',[id,input.name,identity.name]);
   await c.query("SELECT set_config('request.workspace',$1,true)",[id]);await audit(c,identity,id,'workspace.create','allowed',[id]);return {id,name:input.name};
  });
 }
 if(path==='/v1/invitations/accept'&&method==='POST'){
  const input=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(body);
  return transaction(identity,null,async c=>{const id=(await c.query('SELECT private.accept_invite($1,$2) AS id',[hash(input.token),identity.name])).rows[0].id;await c.query("SELECT set_config('request.workspace',$1,true)",[id]);await audit(c,identity,id,'invite.accept','allowed');return {workspaceId:id};});
 }
 const match=path.match(/^\/v1\/workspaces\/([a-f0-9-]{36})(?:\/(.*))?$/);if(!match||!uuid.safeParse(match[1]).success)throw new HttpError(404);
 const w=match[1],tail=match[2]||'';
 try{
  if(tail==='plans/generate'&&method==='POST'){
   const input=z.object({text:z.string().trim().min(1).max(1600),selection:selection.default({}),reviewedPlan:z.unknown().optional(),taskId:uuid.optional(),resolution:z.object({field:z.enum(['selectedStudent','selectedLesson','venueId','messageId']),id:uuid}).strict().optional()}).strict().parse(body);
   const snapshot=await transaction(identity,w,(c,member)=>generationSnapshot(c,member,identity,w,input));
   const now=Date.now();for(const [key,r] of modelRates)if(r.until<now&&!r.busy)modelRates.delete(key);
   const usage=modelRates.get(identity.id)||{count:0,until:now+60000,busy:false};if(usage.busy||usage.count>=8)throw new HttpError(429,'请等待当前整理完成，或稍后重试。','MODEL_RATE_LIMIT');usage.count++;usage.busy=true;modelRates.set(identity.id,usage);
   const response=await runModel(snapshot,usage,generateResponse);
   return transaction(identity,w,(c,member)=>saveGeneration(c,member,identity,w,input,snapshot,response));
  }
  return await transaction(identity,w,async(c,member)=>{
   if(tail==='snapshot'&&method==='GET'){
    const records=await authorizedRecords(c,w),workspace=(await c.query('SELECT name FROM app.workspaces WHERE id=$1',[w])).rows[0];
    const activity=(await c.query("SELECT id,result,plan,committed_at FROM app.plans WHERE workspace_id=$1 AND actor_id=$2 AND status='committed' AND membership_revision=$3 ORDER BY committed_at DESC NULLS LAST LIMIT 30",[w,identity.id,member.revision])).rows.map(p=>({id:p.id,label:p.result.results.map(r=>r.title).join('、'),date:p.committed_at?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(p.committed_at):'',role:member.role==='student'?'student':'coach'}));
    await audit(c,identity,w,'snapshot.read','allowed');
    return {workspace:{id:w,name:workspace.name,role:member.role,permissions:member.permissions,studentId:member.student_id,revision:member.revision,actions:allowedActions(member)},records:records.map(projection),activity,submission:await pendingSubmission(c,member,identity,w)};
   }
   if(tail==='members'&&method==='GET'){requirePermission(member,'team.manage');return {members:(await c.query('SELECT user_id,display_name,role,permissions,student_id,active,revision FROM app.memberships WHERE workspace_id=$1 ORDER BY display_name',[w])).rows};}
   if(tail==='members'&&method==='PATCH'){
    requirePermission(member,'team.manage');const input=z.object({userId:z.string().min(1).max(200),revision:z.number().int().positive(),active:z.boolean(),permissions:permissions.optional()}).strict().parse(body);
    const target=(await c.query('SELECT * FROM app.memberships WHERE workspace_id=$1 AND user_id=$2',[w,input.userId])).rows[0];
    if(!target||target.role==='owner'||target.user_id===identity.id||target.role==='admin'&&member.role!=='owner')throw new HttpError(403);
    if(input.permissions&&target.role!=='assistant')throw new HttpError(400,'只有助教支持单项授权。','INVALID_PERMISSIONS');
    const result=await c.query('UPDATE app.memberships SET active=$3,permissions=$4,revision=revision+1 WHERE workspace_id=$1 AND user_id=$2 AND revision=$5 RETURNING revision',[w,input.userId,input.active,input.permissions||target.permissions,input.revision]);
    if(result.rowCount!==1)throw new HttpError(409,'成员权限已更新，请刷新。','STALE_MEMBERSHIP');await audit(c,identity,w,'member.update','allowed');return {revision:result.rows[0].revision};
   }
   if(tail==='invitations'&&method==='GET'){requirePermission(member,'team.manage');return {invitations:(await c.query('SELECT i.id,i.role,i.permissions,i.student_id,i.expires_at,i.accepted_at,i.revoked_at,a.username AS recipient_username,a.name AS recipient_name FROM app.invitations i LEFT JOIN private.accounts a ON a.id=i.recipient_account_id WHERE i.workspace_id=$1 ORDER BY i.expires_at DESC',[w])).rows};}
   if(tail==='invitations'&&method==='POST'){
    requirePermission(member,'team.manage');const input=z.object({username,role:z.enum(['admin','assistant','student']),permissions:permissions.default([]),studentId:uuid.nullable().default(null)}).strict().parse(body);
    if(input.role==='admin'&&member.role!=='owner')throw new HttpError(403);
    if((input.role==='student')!==!!input.studentId||input.role!=='assistant'&&input.permissions.length)throw new HttpError(400,'请检查邀请身份与权限。','INVALID_INVITE');
    if(input.studentId){
     await getRecord(c,w,input.studentId,'student');
     if((await c.query("SELECT 1 FROM app.memberships WHERE workspace_id=$1 AND student_id=$2",[w,input.studentId])).rowCount)throw new HttpError(409,'这个学员档案已关联账号。请在团队成员中管理访问权限。','STUDENT_LINKED');
     await c.query('UPDATE app.invitations SET revoked_at=now() WHERE workspace_id=$1 AND student_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL',[w,input.studentId]);
    }
    const recipient=(await c.query('SELECT id FROM private.accounts WHERE username=$1 AND active',[input.username])).rows[0];
    if(!recipient)throw new HttpError(404,'未找到这个约练用户名，请联系管理员确认账号。','ACCOUNT_NOT_FOUND');
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    await c.query("INSERT INTO app.invitations(workspace_id,id,token_hash,email_hash,recipient_account_id,role,permissions,student_id,issued_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '24 hours')",[w,id,hash(token),hash('account:'+recipient.id),recipient.id,input.role,input.permissions,input.studentId,identity.id]);
    await audit(c,identity,w,'invite.create','allowed',[id]);return {id,token,expiresInSeconds:86400};
   }
   const revoke=tail.match(/^invitations\/([a-f0-9-]{36})\/revoke$/);
   if(revoke&&method==='POST'){requirePermission(member,'team.manage');uuid.parse(revoke[1]);const r=await c.query('UPDATE app.invitations SET revoked_at=now() WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NULL RETURNING id',[w,revoke[1]]);if(!r.rowCount)throw new HttpError(404);await audit(c,identity,w,'invite.revoke','allowed',[revoke[1]]);return {revoked:true};}
   if(tail==='records'&&method==='GET'){
    const rows=await authorizedRecords(c,w);await audit(c,identity,w,'records.list','allowed');return {records:rows.map(projection)};
   }
   const record=tail.match(/^records\/([a-f0-9-]{36})$/);
   if(record&&method==='GET'){uuid.parse(record[1]);const r=await getRecord(c,w,record[1]);await audit(c,identity,w,'record.read','allowed',[r.id]);return {record:projection(r)};}
   if((tail==='records'&&method==='POST')||(record&&method==='PATCH'))throw new HttpError(410,'请通过统一业务操作接口提交。','USE_PLAN');
   if(tail==='plans'&&method==='POST'){
    const input=z.object({plan:z.unknown(),revisions:z.record(z.number().int().positive()),submission:z.boolean().default(false)}).strict().parse(body);
    const shape=Plan.parse(input.plan);authorizePlan(member,shape);
    try{const context=await modelContext(c,member,identity,w,'通过表单核对操作',{},shape);const plan=validatePlan(input.plan,context.input);await checkRevisions(c,w,plan,input.revisions);return savePlan(c,member,identity,w,plan,context.revisions,input.submission);}
    catch(error){if(error instanceof AssistantError&&['INVALID_DRAFT','INVALID_PLAN'].includes(error.code))throw new HttpError(400,'操作资料不完整或已经变化，请重新核对。','INVALID_OPERATION');throw error;}
   }
   const acknowledge=tail.match(/^plans\/([a-f0-9-]{36})\/acknowledge$/);
   if(acknowledge&&method==='POST'){uuid.parse(acknowledge[1]);z.object({}).strict().parse(body);return acknowledgeSubmission(c,member,identity,w,acknowledge[1]);}
   const commit=tail.match(/^plans\/([a-f0-9-]{36})\/commit$/);
   if(commit&&method==='POST'){uuid.parse(commit[1]);z.object({}).strict().parse(body);return commitPlan(c,member,identity,w,commit[1]);}
   const undo=tail.match(/^plans\/([a-f0-9-]{36})\/undo$/);
   if(undo&&method==='POST'){uuid.parse(undo[1]);z.object({}).strict().parse(body);return undoPlan(c,member,identity,w,undo[1]);}
   if(tail==='audit'&&method==='GET'){requirePermission(member,'audit.read');return {events:(await c.query('SELECT id,actor_id,action,outcome,targets,request_id,at FROM app.audit WHERE workspace_id=$1 ORDER BY at DESC LIMIT 100',[w])).rows};}
   throw new HttpError(404);
  });
 }catch(error){if(error instanceof HttpError&&error.status===403||error?.code==='42501')await rejected(identity,w,tail.split('/')[0]||'workspace');throw error;}
}
await assertRuntimeRole();
const server=http.createServer(async(req,res)=>{
 let identity;
 try{
  if(!['GET','POST','PATCH'].includes(req.method))throw new HttpError(405);
  const raw=await bodyOf(req);identity=await authenticate(req,raw);
  const authPath=req.url.startsWith('/v1/auth/');
  if(authPath){
   let actor;
   if(req.url==='/v1/auth/session'&&req.method==='GET'||req.url==='/v1/auth/logout'){
    try{actor=await authenticateSession(pool,identity);}catch(error){if(!(error instanceof HttpError&&error.status===401))throw error;}
   }
   limitRequests(actor?'account:'+actor.id:'preauth:'+preauthKey(identity));
  }else{
   try{identity=await authenticateSession(pool,identity);}catch(error){if(error instanceof HttpError&&error.status===401)limitRequests('preauth:'+preauthKey(identity));throw error;}
   limitRequests('account:'+identity.id);
  }
  // Budget even malformed JSON and paths after resolving the trustworthy
  // client/account. Parsing first would let invalid payloads bypass the quota.
  if(!/^\/v1\/[a-z0-9/-]+$/.test(req.url))throw new HttpError(404);
  let body={};if(raw){try{body=JSON.parse(raw);}catch{throw new HttpError(400,'请求格式不正确。','INVALID_JSON');}}
  if(authPath){reply(res,200,await handleAuth(pool,req.method,req.url,body,identity));return;}
  const target=resolveTestIdentity(req.url,identity);
  reply(res,200,await route(req.method,target.path,body,target.identity));
 }catch(error){
  const recognized=error instanceof HttpError||error instanceof AssistantError;const status=recognized?error.status:validationError(error)?400:isDatabaseUnavailable(error)?503:error?.code==='42501'?403:['23503','23514','23505','22P02'].includes(error?.code)?409:error?.status>=400&&error?.status<600?error.status:500;
  const unavailable=req.method==='GET'?'数据连接暂时中断，请稍后重新连接。':req.method==='POST'&&/^\/v1\/workspaces\/[a-f0-9-]{36}\/plans\/generate$/.test(req.url)?'暂时无法生成操作，请稍后重试。业务资料尚未执行修改。':'数据连接暂时中断，提交结果尚未确认。恢复后请核对原操作。';
  reply(res,status,{code:recognized?error.code:status===400?'INVALID_INPUT':status===409?'CONFLICT':status===500?'INTERNAL_ERROR':status===503?'DATABASE_UNAVAILABLE':'UNAVAILABLE',error:recognized?error.message:status===400?'请求字段不完整或不被允许。':status===409?'资料已变化或操作存在冲突，请重新核对。':status===503?unavailable:'无法访问或处理该资料。',requestId:identity?.requestId,...(Number.isInteger(error.step)?{step:error.step}:{})});
  if(status>=500)console.error(JSON.stringify({event:'request_failed',requestId:identity?.requestId,code:error?.code||'INTERNAL_ERROR'}));
 }
});
server.requestTimeout=65000;server.headersTimeout=10000;
server.listen(Number(process.env.PORT||18797),process.env.BIND_HOST||'127.0.0.1',()=>console.info(JSON.stringify({event:'listening',port:Number(process.env.PORT||18797),mode:enabled?'trial':'review'})));
process.on('SIGTERM',()=>server.close(()=>pool.end().then(()=>process.exit(0))));
