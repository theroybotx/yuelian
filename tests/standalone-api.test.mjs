// Isolated PostgreSQL and loopback backends. No runtime database or live model.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash,createHmac,randomUUID,randomBytes} from 'node:crypto';
import pg from '../server/node_modules/pg/lib/index.js';
import {personas,seedMockAccounts} from '../server/scripts/mock-data.mjs';
import {sourceState} from './full/source-state.mjs';
import {STANDALONE_AUDIENCE} from '../server/src/transport-auth.mjs';

if(!process.env.PGUSER)process.loadEnvFile(process.env.YUELIAN_TEST_ENV||process.env.HOME+'/.local/state/yuelian-security/runtime.env');
const root=new URL('..',import.meta.url).pathname.replace(/\/$/,''),out=process.env.YUELIAN_STANDALONE_OUTPUT||root+'/output/standalone-20261102/backend';mkdirSync(out,{recursive:true});
const database='yuelian_acceptance_standalone_20261102',port=18905;
const options={host:'/tmp',user:process.env.YUELIAN_TEST_ADMIN||process.env.USER,password:undefined};
const admin=new pg.Client({...options,database:'postgres'});await admin.connect();
if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)await admin.query(`CREATE DATABASE ${database} OWNER yuelian_security_owner`);await admin.end();
const db=new pg.Client({...options,database});await db.connect();await db.query('DROP SCHEMA IF EXISTS app,private CASCADE');await db.query('SET ROLE yuelian_security_owner');
for(const file of readdirSync(root+'/server/migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.query(readFileSync(root+'/server/migrations/'+file,'utf8'));
await db.query('RESET ROLE');
const secrets={sites:randomBytes(36).toString('base64url'),standalone:randomBytes(36).toString('base64url')};
const sha=value=>createHash('sha256').update(value).digest('hex');
const sites=()=>({id:'sites:trial-test:'+randomUUID(),name:'独立通道验收',emailHash:sha(randomUUID())});
const standalone=(clientKey=sha(randomUUID()))=>({id:STANDALONE_AUDIENCE,name:'约练访客',emailHash:sha('standalone:neutral'),clientKey});
const controller=sites(),accessFile=out+'/mock-access.json';writeFileSync(accessFile,JSON.stringify({controllerId:controller.id,personas}),{mode:0o600});await seedMockAccounts(db,controller.id);
const children=[],results=[],initialSource=sourceState(),password='Independent-trial-password-123';
const modelControl=out+'/model-control.json',modelLog=out+'/model-inputs.jsonl';writeFileSync(modelControl,JSON.stringify({throw:true}));writeFileSync(modelLog,'');
const stateCounts=async()=>(await db.query('SELECT (SELECT count(*)::int FROM private.accounts) AS accounts,(SELECT count(*)::int FROM private.sessions) AS sessions,(SELECT count(*)::int FROM app.workspaces) AS workspaces,(SELECT count(*)::int FROM app.records) AS records,(SELECT count(*)::int FROM app.plans) AS plans,(SELECT count(*)::int FROM app.audit) AS audit')).rows[0];
async function start(offset,extra={}){
 const logfile=out+'/server-'+offset+'.log';writeFileSync(logfile,'');
 const env={...process.env,PGDATABASE:database,PORT:String(port+offset),BIND_HOST:'127.0.0.1',YUELIAN_BRIDGE_SECRET:secrets.sites,YUELIAN_STANDALONE_BRIDGE_SECRET:secrets.standalone,YUELIAN_ENVIRONMENT:'test',YUELIAN_TEST_ACCESS_FILE:accessFile,YUELIAN_ACCEPT_REAL_DATA:'true',ACCEPTANCE_CONTROL:modelControl,ACCEPTANCE_MODEL_LOG:modelLog,...extra};
 // The unset default is tested rather than inheriting any local operator flag.
 if(!('YUELIAN_REGISTRATION_ENABLED' in extra))delete env.YUELIAN_REGISTRATION_ENABLED;
 if(extra.YUELIAN_STANDALONE_BRIDGE_SECRET===null)delete env.YUELIAN_STANDALONE_BRIDGE_SECRET;
 const child=spawn(process.execPath,['--experimental-transform-types','--import',root+'/server/tests/model-preload.mjs',root+'/server/src/server.mjs'],{env,stdio:['ignore','pipe','pipe']});children.push(child);
 let ready=false;for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{appendFileSync(logfile,data);if(String(data).includes('"event":"listening"'))ready=true;});
 for(let n=0;n<100&&!ready;n++){if(child.exitCode!==null)throw Error('Isolated standalone fixture failed to start');await new Promise(r=>setTimeout(r,50));}assert.ok(ready);return port+offset;
}
function signed(actor,path,method='GET',body,{channel=actor.clientKey?'standalone':undefined,secret=secrets[channel||'sites'],headers={},nonce=randomUUID(),rawBody}={}){
 const raw=rawBody??(body===undefined?'':JSON.stringify(body)),stamp=String(Date.now()),encoded=Buffer.from(JSON.stringify(actor)).toString('base64url');
 return {method,headers:{'Content-Type':'application/json','X-Yuelian-Time':stamp,'X-Yuelian-Nonce':nonce,'X-Yuelian-Identity':encoded,'X-Yuelian-Signature':createHmac('sha256',secret).update([method,path,stamp,nonce,encoded,sha(raw)].join('\n')).digest('hex'),...(channel?{'X-Yuelian-Channel':channel}:{}),...headers},...(raw?{body:raw}:{}),signal:AbortSignal.timeout(10000)};
}
async function request(actor,path,method='GET',body,opts={}){const response=await fetch('http://127.0.0.1:'+(opts.port||port)+path,signed(actor,path,method,body,opts));return {status:response.status,body:await response.json()};}
const expect=(result,status=200)=>{assert.equal(result.status,status,result.body.code||'Unexpected status');return result.body;};
async function register(role='coach'){
 const outer=sites(),input={username:'trial-'+randomUUID().slice(0,12),name:'隔离试用'+role,role,password};
 const account=expect(await request(outer,'/v1/auth/register','POST',input,{port:port+1}));return {...account,input,outer,actor:{...outer,sessionToken:account.sessionToken}};
}
async function login(account,outer=standalone(),opts={}){const result=expect(await request(outer,'/v1/auth/session','POST',{username:account.input.username,password},opts));return {...result,outer,actor:{...outer,sessionToken:result.sessionToken}};}
async function check(name,fn){const startedAt=new Date().toISOString(),started=performance.now();try{const evidence=await fn();results.push({name,status:'passed',startedAt,durationMs:performance.now()-started,...(evidence?{evidence}:{})});}catch(error){results.push({name,status:'failed',startedAt,error:error.message,stack:error.stack});}const current=sourceState();writeFileSync(out+'/results.json',JSON.stringify({source:initialSource,sourceAtReport:current,implementationChanged:initialSource.implementationDigest!==current.implementationDigest,database,productionDataTouched:false,results},null,2));console.log(name+': '+results.at(-1).status);}
try{
 await start(0,{YUELIAN_REGISTRATION_ENABLED:'false'});await start(1);
 const a=await register(),b=await register(),student=await register('student');
 const wa=expect(await request(a.actor,'/v1/workspaces','GET',undefined,{port:port+1})).workspaces[0].id;
 const wb=expect(await request(b.actor,'/v1/workspaces','GET',undefined,{port:port+1})).workspaces[0].id;
 await check('default Sites registration stays compatible; standalone registration always closed',async()=>{
  assert.equal(a.registrationEnabled,true);
  const before=await stateCounts();
  for(const p of [port,port+1]){
   const visitor=standalone(),status=expect(await request(visitor,'/v1/auth/session','GET',undefined,{port:p}));assert.equal(status.registrationEnabled,false);assert.equal(status.authenticated,false);
   assert.equal(expect(await request(visitor,'/v1/auth/register','POST',{}, {port:p}),403).code,'REGISTRATION_DISABLED');
   assert.equal(expect(await request(visitor,'/v1/auth/register','POST',{username:'forbidden-'+randomUUID().slice(0,8),name:'不可注册',role:'coach',password},{port:p}),403).code,'REGISTRATION_DISABLED');
  }
  assert.deepEqual(await stateCounts(),before);
 });
 await check('global closure denies Sites registration before creating accounts or sessions',async()=>{
  const before=(await db.query('SELECT count(*)::int n FROM private.accounts')).rows[0].n;
  const identity=sites(),result=expect(await request(identity,'/v1/auth/session'));assert.equal(result.registrationEnabled,false);
  assert.equal(expect(await request(identity,'/v1/auth/register','POST',{username:'closed-registration',password,name:'不可注册',role:'coach'}),403).code,'REGISTRATION_DISABLED');
  assert.equal((await db.query('SELECT count(*)::int n FROM private.accounts')).rows[0].n,before);assert.equal((await db.query('SELECT count(*)::int n FROM private.sessions WHERE platform_id=$1',[identity.id])).rows[0].n,0);
 });
 await check('signed standalone transport identity alone grants no business access',async()=>{
  const identity=standalone(),before=await stateCounts(),beforeModel=readFileSync(modelLog,'utf8');expect(await request(identity,'/v1/status'),401);expect(await request(identity,'/v1/workspaces'),401);
  for(const tail of ['snapshot','members','records'])expect(await request(identity,`/v1/workspaces/${wa}/${tail}`),401);
  for(const text of ['统计我本月课时','添加学员小周'])expect(await request(identity,`/v1/workspaces/${wa}/plans/generate`,'POST',{text}),401);
  expect(await request(identity,`/v1/workspaces/${wa}/plans`,'POST',{}),401);expect(await request(identity,`/v1/workspaces/${wa}/plans/${randomUUID()}/commit`,'POST',{}),401);
  assert.equal(expect(await request(identity,'/v1/auth/session')).authenticated,false);
  assert.deepEqual(await stateCounts(),before);assert.equal(readFileSync(modelLog,'utf8'),beforeModel);
 });
 await check('standalone signs in as database account, enforces ownership and records actual actor',async()=>{
  const session=await login(a);assert.equal(session.registrationEnabled,false);assert.equal(session.account.id,a.account.id);
  const status=expect(await request(session.actor,'/v1/status'));assert.equal(status.identity.id,a.account.id);assert.deepEqual(status.testing.personas,[]);assert.equal(status.testing.environment,'trial');assert.equal(session.testing.environment,'trial');assert.equal(expect(await request(standalone(),'/v1/auth/session')).testing.environment,'trial');
  assert.deepEqual(expect(await request(session.actor,'/v1/workspaces')).workspaces.map(w=>w.id),[wa]);
  expect(await request(session.actor,`/v1/workspaces/${wb}/snapshot`),404);expect(await request(session.actor,`/v1/workspaces/${wa}/snapshot`));
  const audits=(await db.query("SELECT actor_id FROM app.audit WHERE workspace_id=$1 AND action='snapshot.read'",[wa])).rows;assert.ok(audits.length);assert.ok(audits.every(r=>r.actor_id===a.account.id));
  assert.equal((await db.query('SELECT platform_id FROM private.sessions WHERE token_hash=$1',[sha(session.sessionToken)])).rows[0].platform_id,STANDALONE_AUDIENCE);
 });
 await check('student role remains a real student with no implicit coach profile',async()=>{
  const session=await login(student);assert.equal(expect(await request(session.actor,'/v1/status')).identity.registrationRole,'student');assert.deepEqual(expect(await request(session.actor,'/v1/workspaces')).workspaces,[]);
  expect(await request(session.actor,'/v1/workspaces','POST',{name:'伪造教练'}),403);
 });
 await check('unknown invitation account directs to administrator; closed Sites password login still works',async()=>{
  const session=await login(a),response=expect(await request(session.actor,`/v1/workspaces/${wa}/invitations`,'POST',{username:'unknown-invite-account',role:'assistant'}),404);
  assert.equal(response.code,'ACCOUNT_NOT_FOUND');assert.equal(response.error,'未找到这个约练用户名，请联系管理员确认账号。');
  const oldChannel=await login(a,sites());assert.equal(oldChannel.registrationEnabled,false);assert.equal(expect(await request(oldChannel.actor,'/v1/status')).identity.id,a.account.id);
 });
 await check('sessions are channel-bound, and failed cross-channel logout cannot revoke another audience',async()=>{
  const session=await login(a),fromSites={...session.outer,sessionToken:a.sessionToken};expect(await request(fromSites,'/v1/status'),401);
  const fromStandalone={...a.outer,sessionToken:session.sessionToken};expect(await request(fromStandalone,'/v1/status'),401);
  expect(await request(fromSites,'/v1/auth/logout','POST',{}));assert.equal(expect(await request(a.actor,'/v1/status')).identity.id,a.account.id);
  expect(await request(fromStandalone,'/v1/auth/logout','POST',{}));assert.equal(expect(await request(session.actor,'/v1/status')).identity.id,a.account.id);
 });
 await check('signature roots, reserved identities and spoofed headers cannot cross transport channels',async()=>{
  expect(await request(standalone(),'/v1/auth/session','GET',undefined,{secret:secrets.sites}),401);
  expect(await request(sites(),'/v1/auth/session','GET',undefined,{secret:secrets.standalone}),401);
  expect(await request({...standalone(),id:controller.id},'/v1/auth/session'),401);
  expect(await request({...sites(),id:STANDALONE_AUDIENCE},'/v1/auth/session'),401);
  expect(await request({...sites(),clientKey:sha('fake')},'/v1/auth/session','GET',undefined,{channel:'sites'}),401);
  expect(await request(standalone(),'/v1/auth/session','GET',undefined,{headers:{'X-Yuelian-Channel':'sites'}}),401);
  expect(await request(sites(),'/v1/auth/session','GET',undefined,{headers:{'X-Yuelian-Channel':'standalone'}}),401);
 });
 await check('nonce replay is rejected without creating extra sessions',async()=>{
  const identity=standalone(),init=signed(identity,'/v1/auth/session','POST',{username:b.input.username,password});
  const first=await fetch('http://127.0.0.1:'+port+'/v1/auth/session',init);assert.equal(first.status,200);await first.json();
  const replay=await fetch('http://127.0.0.1:'+port+'/v1/auth/session',init);assert.equal(replay.status,401);await replay.json();
 });
 await check('logout revokes the exact session, stays logged out, and permits explicit account switching',async()=>{
  const session=await login(a);expect(await request(session.actor,'/v1/auth/logout','POST',{}));expect(await request(session.actor,'/v1/status'),401);assert.equal(expect(await request(session.actor,'/v1/auth/session')).authenticated,false);
  assert.ok((await db.query('SELECT revoked_at FROM private.sessions WHERE token_hash=$1',[sha(session.sessionToken)])).rows[0].revoked_at);
  const next=await login(b,session.actor);assert.equal(expect(await request(next.actor,'/v1/status')).identity.id,b.account.id);
 });
 await check('IP changes preserve sessions, and injected forwarding headers are not an identity source',async()=>{
  const session=await login(a),moved={...session.actor,clientKey:sha('new-network')};assert.equal(expect(await request(moved,'/v1/status')).identity.id,a.account.id);
  expect(await request(moved,`/v1/workspaces/${wb}/snapshot`,'GET',undefined,{headers:{'CF-Connecting-IP':'8.8.8.8','X-Forwarded-For':'1.2.3.4','X-Yuelian-User':b.account.id}}),404);
 });
 await check('disabled account and unknown token fail before any business access',async()=>{
  const account=await register(),session=await login(account);await db.query('UPDATE private.accounts SET active=false WHERE id=$1',[account.account.id]);
  expect(await request(session.actor,'/v1/status'),401);assert.equal(expect(await request(session.actor,'/v1/auth/session')).authenticated,false);
  expect(await request({...standalone(),sessionToken:randomBytes(32).toString('base64url')},'/v1/status'),401);
  const failures=[];for(const [username,inputPassword] of [[account.input.username,password],[b.input.username,'incorrect-password'],['unknown-disabled-comparison',password]])failures.push(expect(await request(standalone(),'/v1/auth/session','POST',{username,password:inputPassword}),401));
  assert.equal(new Set(failures.map(value=>value.code+'|'+value.error)).size,1);
 });
 await check('standalone cannot use Mock login, test sessions, or legacy testing URL impersonation',async()=>{
  const catalogue=expect(await request(controller,'/v1/auth/session'));assert.equal(catalogue.testing.personas.length,7);
  const mock=expect(await request(controller,'/v1/auth/session','POST',{testPersona:'zhou'}));
  for(const key of ['zhou','lin'])expect(await request(standalone(),'/v1/auth/session','POST',{testPersona:key}),404);
  const forgedToken=randomBytes(32).toString('base64url');await db.query("INSERT INTO private.sessions(token_hash,account_id,platform_id,test_persona,expires_at) VALUES($1,$2,$3,'zhou',now()+interval '1 hour')",[sha(forgedToken),mock.account.id,STANDALONE_AUDIENCE]);
  const forged={...standalone(),sessionToken:forgedToken};expect(await request(forged,'/v1/status'),401);assert.equal(expect(await request(forged,'/v1/auth/session')).authenticated,false);
  const normal=await login(b);expect(await request(normal.actor,'/v1/testing/personas/zhou/status'),404);
 });
 await check('preauth limits are per signed clientKey, not the shared deployment or unsigned IP',async()=>{
  const key=standalone();for(let i=0;i<40;i++)expect(await request(key,'/v1/auth/session'));
  expect(await request(key,'/v1/auth/session','GET',undefined,{headers:{'CF-Connecting-IP':'different'}}),429);
  expect(await request(standalone(),'/v1/auth/session'));
 });
 await check('malformed JSON still consumes the signed preauth request budget',async()=>{
  const client=standalone(),before=(await db.query('SELECT count(*)::int n FROM private.sessions')).rows[0].n;
  for(let n=0;n<40;n++)assert.equal(expect(await request(client,'/v1/auth/session','POST',undefined,{rawBody:'{'}),400).code,'INVALID_JSON');
  assert.equal(expect(await request(client,'/v1/auth/session','POST',undefined,{rawBody:'{'}),429).code,'RATE_LIMIT');
  assert.equal((await db.query('SELECT count(*)::int n FROM private.sessions')).rows[0].n,before);
  expect(await request(standalone(),'/v1/auth/session'));
 });
 await check('malformed business JSON consumes the real account budget across client changes',async()=>{
  const account=await register(),session=await login(account),before=(await db.query('SELECT count(*)::int n FROM app.workspaces WHERE created_by=$1',[account.account.id])).rows[0].n;
  for(let n=0;n<40;n++)assert.equal(expect(await request({...session.actor,clientKey:sha('bad-json-'+n)},'/v1/workspaces','POST',undefined,{rawBody:'{'}),400).code,'INVALID_JSON');
  assert.equal(expect(await request({...session.actor,clientKey:sha('bad-json-next')},'/v1/workspaces','POST',undefined,{rawBody:'{'}),429).code,'RATE_LIMIT');
  assert.equal((await db.query('SELECT count(*)::int n FROM app.workspaces WHERE created_by=$1',[account.account.id])).rows[0].n,before);
 });
 await check('login client limit cannot be bypassed by changing usernames or spoofing IP',async()=>{
  const client=standalone();for(let n=0;n<12;n++)expect(await request(client,'/v1/auth/session','POST',{username:'missing-'+randomUUID().slice(0,10),password}),401);
  const response=expect(await request(client,'/v1/auth/session','POST',{username:b.input.username,password},{headers:{'CF-Connecting-IP':'1.2.3.4'}}),429);assert.equal(response.code,'AUTH_RATE_LIMIT');
  await login(b);
 });
 await check('normalized username budget prevents distributed guessing across clients and channels',async()=>{
  const username='distributed-'+randomUUID().slice(0,8);
  for(let n=0;n<12;n++)expect(await request(n%2?standalone():sites(),'/v1/auth/session','POST',{username:n%2?' '+username.toUpperCase()+' ':username,password}),401);
  assert.equal(expect(await request(standalone(),'/v1/auth/session','POST',{username,password}),429).code,'AUTH_RATE_LIMIT');
  expect(await request(standalone(),'/v1/auth/session','POST',{username:'independent-unknown',password}),401);
 });
 await check('authenticated users sharing one network have separate budgets; rotating clients cannot reset account quota',async()=>{
  const first=await register(),second=await register(),shared=standalone(),one=await login(first,shared),two=await login(second,shared);
  for(let n=0;n<25;n++){expect(await request(one.actor,'/v1/status'));expect(await request(two.actor,'/v1/auth/session'));}
  for(let n=0;n<15;n++)expect(await request({...one.actor,clientKey:sha('network-'+n)},'/v1/status'));
  assert.equal(expect(await request({...one.actor,clientKey:sha('another-network')},'/v1/status'),429).code,'RATE_LIMIT');
  expect(await request(two.actor,'/v1/status'));
 });
 await check('standalone login resumes only after the real sixty-second window',async()=>{
  const account=await register(),client=standalone();
  for(let n=0;n<12;n++)expect(await request(client,'/v1/auth/session','POST',{username:account.input.username,password:'incorrect-password'}),401);
  expect(await request(client,'/v1/auth/session','POST',{username:account.input.username,password}),429);
  const began=performance.now();await new Promise(resolve=>setTimeout(resolve,61000));const elapsed=performance.now()-began;assert.ok(elapsed>=60000);
  const restored=await login(account,client);assert.equal(expect(await request(restored.actor,'/v1/status')).identity.id,account.account.id);
  return {windowMs:60000,elapsedMonotonicMs:elapsed,sameSignedClientKey:true,statusAfterWindow:200};
 });
 await check('restarting the isolated service resets in-memory limits while database sessions remain bound',async()=>{
  await start(2,{YUELIAN_REGISTRATION_ENABLED:'false'});const server=children.at(-1),p=port+2,client=standalone(),session=await login(b,standalone(),{port:p});
  for(let n=0;n<40;n++)expect(await request(client,'/v1/auth/session','GET',undefined,{port:p}));
  expect(await request(client,'/v1/auth/session','GET',undefined,{port:p}),429);
  server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));
  await start(2,{YUELIAN_REGISTRATION_ENABLED:'false'});
  expect(await request(client,'/v1/auth/session','GET',undefined,{port:p}));assert.equal(expect(await request(session.actor,'/v1/status','GET',undefined,{port:p})).identity.id,b.account.id);
  return {rateStorage:'process-memory',limitResetsAfterRestart:true,persistedDatabaseSessionSurvives:true};
 });
 await check('missing and rotated standalone secret never fall back to Sites trust or disable the Sites channel',async()=>{
  await start(3,{YUELIAN_REGISTRATION_ENABLED:'false',YUELIAN_STANDALONE_BRIDGE_SECRET:null});
  const visitor=standalone();expect(await request(visitor,'/v1/auth/session','GET',undefined,{port:port+3}),401);
  expect(await request(visitor,'/v1/auth/session','GET',undefined,{port:port+3,secret:secrets.sites}),401);
  assert.equal(expect(await request(a.actor,'/v1/status','GET',undefined,{port:port+3})).identity.id,a.account.id);
  const session=await login(b),rotated=randomBytes(36).toString('base64url');await start(4,{YUELIAN_REGISTRATION_ENABLED:'false',YUELIAN_STANDALONE_BRIDGE_SECRET:rotated});
  expect(await request(visitor,'/v1/auth/session','GET',undefined,{port:port+4}),401);
  assert.equal(expect(await request(session.actor,'/v1/status','GET',undefined,{port:port+4,secret:rotated})).identity.id,b.account.id);
  const fresh=await login(b,standalone(),{port:port+4,secret:rotated});assert.equal(fresh.account.id,b.account.id);
  assert.equal(expect(await request(a.actor,'/v1/status','GET',undefined,{port:port+4})).identity.id,a.account.id);
  return {unconfiguredStandaloneStatus:401,oldStandaloneSignatureAfterRotation:401,newSignatureStatus:200,sitesSignatureStatus:200,rotationDoesNotImplicitlyRevokeDatabaseSessions:true};
 });
 await check('audit and logs retain no plaintext passwords, token or signing keys',async()=>{
  const logs=[0,1].map(n=>readFileSync(out+'/server-'+n+'.log','utf8')).join('');for(const value of [password,secrets.sites,secrets.standalone,a.sessionToken])assert.ok(!logs.includes(value));
  assert.equal((await db.query('SELECT count(*)::int n FROM app.audit WHERE actor_id=$1',[STANDALONE_AUDIENCE])).rows[0].n,0);
 });
}finally{
 for(const child of children)if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 await db.end();
}
if(results.some(r=>r.status==='failed'))process.exitCode=1;
