import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {HttpError} from './policy.mjs';
import {username,password,sessionToken,tokenHash,newSessionToken,hashPassword,verifyPassword,reservedUsername} from './auth-crypto.mjs';
import {mockAccount,testingStatus} from './testing.mjs';
import {isStandalone,preauthKey} from './transport-auth.mjs';

export const SESSION_SECONDS=7*24*60*60;
const login=z.union([z.object({username,password}).strict(),z.object({testPersona:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)}).strict()]);
const registration=z.object({username,password,name:z.string().trim().min(1).max(80),role:z.enum(['coach','student'])}).strict();
const authRates=new Map();
const authRequired=()=>new HttpError(401,'请登录约练账号。','APP_SIGN_IN_REQUIRED');
const badCredentials=()=>new HttpError(401,'用户名或密码不正确。','INVALID_CREDENTIALS');
const accountView=account=>({id:account.id,username:account.username,name:account.name,registrationRole:account.registration_role});
const registrationEnabled=outer=>!isStandalone(outer)&&process.env.YUELIAN_REGISTRATION_ENABLED!=='false';
export function authTestingStatus(identity){
 const status=testingStatus(identity);
 return isStandalone(identity)?{...status,environment:'trial',canSwitch:false,canLogin:false,selected:'',personas:[]}:status;
}
function limit(key){
 const now=Date.now();for(const [key,value] of authRates)if(value.until<=now)authRates.delete(key);
 const rate=authRates.get(key)||{count:0,until:now+60000};rate.count++;authRates.set(key,rate);
 if(rate.count>12)throw new HttpError(429,'登录尝试过于频繁，请稍后再试。','AUTH_RATE_LIMIT');
}
function validMock(row,outer){
 return row.login_kind!=='test'||!isStandalone(outer)&&mockAccount(outer,row.test_persona)?.id===row.id;
}
async function sessionRow(c,hash,platformId,lock=false){
 return (await c.query(`SELECT a.id,a.username,a.name,a.registration_role,a.login_kind,a.active,
 s.token_hash,s.platform_id,s.test_persona,s.expires_at,s.revoked_at
 FROM private.sessions s JOIN private.accounts a ON a.id=s.account_id
 WHERE s.token_hash=$1 AND s.platform_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.active
 ${lock?'FOR SHARE OF s,a':''}`,[hash,platformId])).rows[0];
}
const actorFrom=(row,outer)=>({id:row.id,name:row.name,emailHash:outer.emailHash,username:row.username,registrationRole:row.registration_role,requestId:outer.requestId,sessionHash:row.token_hash,platformId:outer.id,expiresAt:row.expires_at,controller:{id:outer.id,name:outer.name,emailHash:outer.emailHash},testPersona:row.test_persona||''});
export async function authenticateSession(c,outer){
 if(!sessionToken.safeParse(outer.sessionToken).success)throw authRequired();
 const row=await sessionRow(c,tokenHash(outer.sessionToken),outer.id);
 if(!row||!validMock(row,outer))throw authRequired();
 return actorFrom(row,outer);
}
export async function assertBusinessSession(c,identity){
 if(!identity.sessionHash||!identity.platformId)throw authRequired();
 // Hold these locks until the enclosing business transaction finishes.
 // Logout or account suspension waits for already-authorized work; any work
 // begun after revocation, including an AI result arriving later, is rejected.
 const row=await sessionRow(c,identity.sessionHash,identity.platformId,true);
 const outer={id:identity.platformId,name:identity.controller?.name||identity.name};
 if(!row||row.id!==identity.id||!validMock(row,outer))throw authRequired();
 return row;
}
async function authTransaction(pool,fn){
 const c=await pool.connect();let discard=false;
 try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
 catch(error){try{await c.query('ROLLBACK');}catch{discard=true;}throw error;}
 finally{c.release(discard);}
}
async function issueSession(c,account,outer,testPersona=null){
 // Rotation is scoped to this browser's previous session and platform owner.
 // It neither logs out other devices nor accepts a cross-platform token.
 if(sessionToken.safeParse(outer.sessionToken).success)await c.query('UPDATE private.sessions SET revoked_at=now() WHERE token_hash=$1 AND platform_id=$2 AND revoked_at IS NULL',[tokenHash(outer.sessionToken),outer.id]);
 const token=newSessionToken();
 const row=(await c.query("INSERT INTO private.sessions(token_hash,account_id,platform_id,test_persona,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING expires_at",[tokenHash(token),account.id,outer.id,testPersona])).rows[0];
 const identity={...outer,controller:outer,testPersona:testPersona||''};
 return {authenticated:true,account:accountView(account),expiresAt:row.expires_at,sessionToken:token,registrationEnabled:registrationEnabled(outer),testing:authTestingStatus(identity)};
}
export async function handleAuth(pool,method,path,body,outer){
 if(path==='/v1/auth/session'&&method==='GET'){
  try{const actor=await authenticateSession(pool,outer);return {authenticated:true,account:{id:actor.id,username:actor.username,name:actor.name,registrationRole:actor.registrationRole},expiresAt:actor.expiresAt,registrationEnabled:registrationEnabled(outer),testing:authTestingStatus(actor)};}
  catch(error){if(error instanceof HttpError&&error.status===401)return {authenticated:false,account:null,registrationEnabled:registrationEnabled(outer),testing:authTestingStatus(outer)};throw error;}
 }
 if(path==='/v1/auth/logout'&&method==='POST'){
  z.object({}).strict().parse(body);
  if(sessionToken.safeParse(outer.sessionToken).success)await pool.query('UPDATE private.sessions SET revoked_at=now() WHERE token_hash=$1 AND platform_id=$2 AND revoked_at IS NULL',[tokenHash(outer.sessionToken),outer.id]);
  return {loggedOut:true};
 }
 if(path==='/v1/auth/session'&&method==='POST'){
  limit('client:'+preauthKey(outer));const input=login.parse(body);
  if('testPersona' in input){
   if(isStandalone(outer))throw new HttpError(404);
   const mock=mockAccount(outer,input.testPersona);if(!mock)throw new HttpError(404);
   return authTransaction(pool,async c=>{
    await c.query("INSERT INTO private.accounts(id,username,name,registration_role,login_kind) VALUES($1,$2,$3,$4,'test') ON CONFLICT DO NOTHING",[mock.id,mock.username,mock.name,mock.role==='coach'?'coach':'student']);
    const account=(await c.query("SELECT * FROM private.accounts WHERE id=$1 AND username=$2 AND login_kind='test' AND active FOR SHARE",[mock.id,mock.username])).rows[0];
    if(!account)throw badCredentials();return issueSession(c,account,outer,mock.key);
   });
  }
  // A signed client identifier changes across networks. Bound attempts for the
  // normalized account as well, so distributing guesses cannot reset the budget.
  limit('username:'+input.username);
  const account=(await pool.query('SELECT * FROM private.accounts WHERE username=$1',[input.username])).rows[0];
  const verified=await verifyPassword(input.password,account?.password_salt,account?.password_hash);
  if(!verified||!account?.active||account.login_kind!=='password')throw badCredentials();
  return authTransaction(pool,async c=>{
   const current=(await c.query("SELECT * FROM private.accounts WHERE id=$1 AND active AND login_kind='password' FOR SHARE",[account.id])).rows[0];
   if(!current)throw badCredentials();return issueSession(c,current,outer);
  });
 }
 if(path==='/v1/auth/register'&&method==='POST'){
  if(!registrationEnabled(outer))throw new HttpError(403,'暂未开放自行注册，请使用已分配的试用账号。','REGISTRATION_DISABLED');
  limit('client:'+preauthKey(outer));const input=registration.parse(body);
  if(reservedUsername(input.username))throw new HttpError(400,'这个用户名保留给系统，请换一个。','USERNAME_RESERVED');
  const secret=await hashPassword(input.password),id='account:'+randomUUID();
  try{return await authTransaction(pool,async c=>{
   const account=(await c.query("INSERT INTO private.accounts(id,username,name,registration_role,login_kind,password_salt,password_hash) VALUES($1,$2,$3,$4,'password',$5,$6) RETURNING *",[id,input.username,input.name,input.role,secret.salt,secret.hash])).rows[0];
   await c.query("SELECT set_config('request.actor',$1,true),set_config('request.workspace','',true)",[id]);
   if(input.role==='coach')await c.query('SELECT private.create_workspace($1,$2,$3)',[randomUUID(),input.name,input.name]);
   return issueSession(c,account,outer);
  });}catch(error){if(error?.code==='23505')throw new HttpError(409,'这个用户名已被使用，请换一个。','USERNAME_TAKEN');throw error;}
 }
 throw new HttpError(404);
}
