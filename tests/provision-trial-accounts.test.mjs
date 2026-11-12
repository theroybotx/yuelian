// Real PostgreSQL CLI acceptance. This test creates/drops only a new guarded
// rehearsal database; no connection to yuelian_security and no model/network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,stat,chmod,symlink,rm,readdir,access} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from '../server/node_modules/pg/lib/index.js';
import {DEFAULT_ACCOUNTS,accountId,validateManifest,main} from '../server/scripts/provision-trial-accounts.mjs';
import {hashPassword,verifyPassword} from '../server/src/auth-crypto.mjs';
import {handleAuth} from '../server/src/auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const database='yuelian_trial_rehearsal_'+Date.now()+'_'+process.pid;
assert.match(database,/^yuelian_trial_rehearsal_\d+_\d+$/);assert.notEqual(database,'yuelian_security');
const output=path.join(root,'output/trial-accounts-20261102'),results=[];await mkdir(output,{recursive:true});
const secretDir=await mkdtemp(path.join(tmpdir(),'yuelian-trial-credentials-'));await chmod(secretDir,0o700);
const adminConfig={host:'/tmp',user:process.env.YUELIAN_TEST_ADMIN||userInfo().username,password:undefined};
const admin=new pg.Client({...adminConfig,database:'postgres'});await admin.connect();
await admin.query(`CREATE DATABASE ${database} OWNER yuelian_security_owner`);
const provision=new pg.Client({...adminConfig,database});await provision.connect();await provision.query('SET ROLE yuelian_security_owner');
for(const file of (await readdir(path.join(root,'server/migrations'))).filter(name=>/^\d+.*\.sql$/.test(name)).sort())await provision.query(await readFile(path.join(root,'server/migrations',file),'utf8'));
await provision.query('RESET ROLE');
const runtime=new pg.Pool({host:'/tmp',user:'yuelian_runtime',database,max:2});
const script=path.join(root,'server/scripts/provision-trial-accounts.mjs'),delivery=path.join(secretDir,'batch.json');
let sequence=0;
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
const digest=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const manifest=async accounts=>{const file=path.join(secretDir,'manifest-'+(++sequence)+'.json');await writeFile(file,JSON.stringify({accounts}));return file;};
const count=async table=>Number((await provision.query('SELECT count(*) AS n FROM '+table)).rows[0].n);
async function snapshot(){const rows={};for(const table of ['private.accounts','private.sessions','app.workspaces','app.memberships','app.records','app.invitations','app.plans','app.audit'])rows[table]=(await provision.query('SELECT to_jsonb(t) AS value FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows;return digest(rows);}
const cli=(args=[],input,env={})=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[script,'--database',database,...args],{cwd:root,env:{...process.env,PGHOST:'/tmp',PGDATABASE:database,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>{let report;try{report=JSON.parse((code===0?stdout:stderr).trim());}catch{}resolve({code,stdout,stderr,report});});child.stdin.end(input===undefined?'':typeof input==='string'?input:JSON.stringify(input));
});
const success=r=>{assert.equal(r.code,0,r.report?.code||'CLI failed');assert.equal(r.stderr,'');return r.report;};
const denied=(r,code)=>{assert.equal(r.code,1);assert.equal(r.report.code,code);assert.equal(r.stdout,'');};
async function actor(id,fn,workspace=''){const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('request.actor',$1,true),set_config('request.workspace',$2,true)",[id,workspace]);return await fn(c);}finally{await c.query('ROLLBACK');c.release();}}
async function check(t,name,fn){await t.test(name,async()=>{const start=Date.now();try{await fn();results.push({name,status:'passed',durationMs:Date.now()-start});}catch(error){results.push({name,status:'failed',durationMs:Date.now()-start,error:'Assertion failed; no credential contents copied into this report.'});throw error;}finally{await writeFile(path.join(output,'results.json'),JSON.stringify({at:new Date().toISOString(),database,runtimeRole:'yuelian_runtime',productionConnected:false,results},null,2));}});}

await test('local trial account provisioning — isolated PostgreSQL',async t=>{
 try{
  await check(t,'manifest validates normalized identities without accepting credentials or extra privileges',async()=>{
   assert.equal(validateManifest({accounts:[{username:' FRIEND-01 ',name:' 测试朋友 ',role:'student'}]})[0].username,'friend-01');
   for(const accounts of [[{username:'bad',name:'x',role:'owner'}],[{username:'demo-zhou',name:'x',role:'coach'}],[{username:'friend',name:'x',role:'student',password:'not-allowed'}],[{username:'friend',name:'x',role:'student',permissions:['team.manage']}],[{username:'friend',name:'x',role:'student'},{username:'FRIEND',name:'x',role:'student'}]])assert.throws(()=>validateManifest({accounts}));
  });
  await check(t,'wrong or missing database target fails before any account write',async()=>{
   await assert.rejects(()=>main([]),error=>error.code==='INVALID_DATABASE');for(const name of ['postgres','other_database','yuelian_security_typo'])denied(await cli(['--database',name]),'INVALID_DATABASE');assert.equal(await count('private.accounts'),0);
  });
  await check(t,'default dry-run lists eight accounts without writes or credential file',async()=>{
   const before=await snapshot(),r=success(await cli(['--credential-output',delivery]));assert.equal(r.mode,'dry-run');assert.equal(r.wouldCreate,8);assert.equal(r.created,0);assert.equal(await exists(delivery),false);assert.equal(await snapshot(),before);
  });
  await check(t,'apply generates private credentials, salted hashes and exactly three coach profiles',async()=>{
   const r=success(await cli(['--apply','--credential-output',delivery],undefined,{PGUSER:adminConfig.user}));assert.equal(r.role,'yuelian_runtime');assert.equal(r.created,8);assert.equal(r.credentialsWritten,true);assert.equal((await stat(delivery)).mode&0o777,0o600);assert.equal((await stat(secretDir)).mode&0o777,0o700);
   const entries=JSON.parse(await readFile(delivery,'utf8')).accounts;assert.equal(entries.length,8);assert.equal(new Set(entries.map(row=>row.password)).size,8);
   const rows=(await provision.query('SELECT * FROM private.accounts ORDER BY username')).rows;assert.equal(rows.length,8);
   for(const entry of entries){const row=rows.find(r=>r.username===entry.username);assert.equal(row.id,accountId(entry.username));assert.equal(row.login_kind,'password');assert.equal(row.registration_role,entry.role);assert.equal(row.name,entry.name);assert.equal(entry.password.length,32);assert.equal(await verifyPassword(entry.password,row.password_salt,row.password_hash),true);assert.ok(!JSON.stringify(r).includes(entry.password));}
   assert.equal(new Set(rows.map(row=>row.password_salt)).size,8);assert.equal(await count('app.workspaces'),3);assert.equal(await count('app.memberships'),3);assert.equal(await count('app.records'),0);assert.equal(await count('private.sessions'),0);assert.equal(await count('app.invitations'),0);
  });
  await check(t,'provisioned password authenticates through the unchanged account login service',async()=>{
   const entry=JSON.parse(await readFile(delivery,'utf8')).accounts.find(r=>r.username==='trial-roy');const reply=await handleAuth(runtime,'POST','/v1/auth/session',{username:entry.username,password:entry.password},{id:'trial-test-platform',name:'测试',emailHash:'a'.repeat(64)});assert.equal(reply.authenticated,true);assert.equal(reply.account.id,accountId('trial-roy'));assert.equal(reply.account.registrationRole,'student');
  });
  await check(t,'new coaches see only their own profile and records under the runtime RLS role',async()=>{
   const workspaces=(await provision.query('SELECT id,created_by FROM app.workspaces ORDER BY created_by')).rows;
   for(const w of workspaces)await provision.query("INSERT INTO app.records(workspace_id,id,kind,owner_user_id,payload) VALUES($1,$2,'student',$3,$4)",[w.id,randomUUID(),w.created_by,{name:'私有测试学员'}]);
   for(const w of workspaces){const visible=await actor(w.created_by,c=>c.query('SELECT id FROM app.workspaces'));assert.deepEqual(visible.rows.map(row=>row.id),[w.id]);const own=await actor(w.created_by,c=>c.query('SELECT id FROM app.records'),w.id);assert.equal(own.rowCount,1);const other=workspaces.find(row=>row.id!==w.id);const deniedRows=await actor(w.created_by,c=>c.query('SELECT id FROM app.records'),other.id);assert.equal(deniedRows.rowCount,0);}
  });
  await check(t,'new students have no coach relationship, records or inferred binding',async()=>{
   for(const row of DEFAULT_ACCOUNTS.filter(row=>row.role==='student')){const visible=await actor(accountId(row.username),async c=>({workspaces:(await c.query('SELECT id FROM app.workspaces')).rowCount,memberships:(await c.query('SELECT user_id FROM app.memberships')).rowCount,records:(await c.query('SELECT id FROM app.records')).rowCount}));assert.deepEqual(visible,{workspaces:0,memberships:0,records:0});}
  });
  await check(t,'repeat apply preserves credentials, sessions, existing teaching records and changed profile title',async()=>{
   await provision.query('UPDATE app.workspaces SET name=$1 WHERE created_by=$2',['教练自己改过的课程名称',accountId('trial-coach-01')]);const before=await snapshot(),file=digest(await readFile(delivery,'utf8'));const r=success(await cli(['--apply','--credential-output',delivery]));assert.equal(r.created,0);assert.equal(r.existing,8);assert.equal(r.credentialsWritten,false);assert.equal(await snapshot(),before);assert.equal(digest(await readFile(delivery,'utf8')),file);const dry=success(await cli());assert.equal(dry.wouldCreate,0);assert.equal(dry.existing,8);
  });
  await check(t,'later explicit additions accept arbitrary valid usernames and supplied stdin passwords',async()=>{
   const file=await manifest([...DEFAULT_ACCOUNTS,{username:'friend-later',name:'后续朋友',role:'student'}]),outputFile=path.join(secretDir,'later.json'),value='Trial-input-canary-!0123456789';const old=(await provision.query('SELECT to_jsonb(a) AS value FROM private.accounts a ORDER BY id')).rows;
   const response=await cli(['--file',file,'--apply','--passwords-stdin','--credential-output',outputFile],{passwords:{'friend-later':value}}),r=success(response);assert.equal(r.created,1);assert.equal(r.existing,8);assert.ok(!(response.stdout+response.stderr).includes(value));const credentials=JSON.parse(await readFile(outputFile,'utf8'));assert.equal(credentials.accounts.length,1);assert.equal(credentials.accounts[0].password,value);const row=(await provision.query('SELECT * FROM private.accounts WHERE username=$1',['friend-later'])).rows[0];assert.equal(await verifyPassword(value,row.password_salt,row.password_hash),true);assert.deepEqual((await provision.query('SELECT to_jsonb(a) AS value FROM private.accounts a WHERE username<>$1 ORDER BY id',['friend-later'])).rows,old);
  });
  await check(t,'supplying a password for an existing account is rejected rather than treated as a reset',async()=>{
   const before=await snapshot(),value='Never-reset-existing-canary';const r=await cli(['--apply','--passwords-stdin','--credential-output',path.join(secretDir,'reset.json')],{passwords:{'trial-roy':value}});denied(r,'PASSWORD_RESET_FORBIDDEN');assert.ok(!(r.stdout+r.stderr).includes(value));assert.equal(await snapshot(),before);assert.equal(await exists(path.join(secretDir,'reset.json')),false);
  });
  await check(t,'a normal account with the same username rejects the whole mixed batch',async()=>{
   const secret=await hashPassword('Original-account-canary');await provision.query("INSERT INTO private.accounts(id,username,name,registration_role,login_kind,password_salt,password_hash) VALUES($1,'friend-conflict','原有用户','student','password',$2,$3)",['account:'+randomUUID(),secret.salt,secret.hash]);
   const file=await manifest([{username:'friend-not-added',name:'本轮不能新增',role:'coach'},{username:'friend-conflict',name:'原有用户',role:'student'}]),before=await snapshot();denied(await cli(['--file',file,'--apply','--credential-output',path.join(secretDir,'conflict.json')]),'ACCOUNT_CONFLICT');assert.equal(await snapshot(),before);assert.equal(await exists(path.join(secretDir,'conflict.json')),false);
  });
  await check(t,'existing metadata or inactive-account mismatch is never overwritten or reactivated',async()=>{
   for(const [column,value]of [['name','不同名字'],['registration_role','coach'],['active',false]]){const old=(await provision.query('SELECT * FROM private.accounts WHERE username=$1',['trial-roy'])).rows[0];await provision.query('UPDATE private.accounts SET '+column+'=$1 WHERE username=$2',[value,'trial-roy']);const before=await snapshot();denied(await cli(['--apply','--credential-output',path.join(secretDir,'mismatch.json')]),'ACCOUNT_CONFLICT');assert.equal(await snapshot(),before);await provision.query('UPDATE private.accounts SET '+column+'=$1 WHERE username=$2',[old[column],'trial-roy']);}
  });
  await check(t,'later student association is preserved on rerun rather than cleared',async()=>{
   const w=(await provision.query('SELECT id FROM app.workspaces WHERE created_by=$1',[accountId('trial-coach-01')])).rows[0].id,s=(await provision.query("SELECT id FROM app.records WHERE workspace_id=$1 AND kind='student'",[w])).rows[0].id;await provision.query("INSERT INTO app.memberships(workspace_id,user_id,display_name,role,student_id) VALUES($1,$2,'Roy','student',$3)",[w,accountId('trial-roy'),s]);const before=await snapshot();assert.equal(success(await cli(['--apply'])).created,0);assert.equal(await snapshot(),before);
  });
  await check(t,'a coach with missing active ownership is refused without automatic profile repair',async()=>{
   const id=accountId('trial-coach-01');await provision.query('UPDATE app.memberships SET active=false WHERE user_id=$1',[id]);const before=await snapshot();denied(await cli(['--apply']),'TEACHING_PROFILE_CONFLICT');assert.equal(await snapshot(),before);await provision.query('UPDATE app.memberships SET active=true WHERE user_id=$1',[id]);
  });
  await check(t,'malformed or foreign stdin secrets are not echoed to stdout or stderr',async()=>{
   const canary='Secret-invalid-input-!Canary';for(const input of ['{"passwords":{"trial-roy":"'+canary,JSON.stringify({passwords:{'not-in-manifest':canary}}),JSON.stringify({passwords:{'trial-roy':'short'}})]){const r=await cli(['--passwords-stdin'],input);denied(r,'INVALID_PASSWORD_INPUT');assert.ok(!(r.stdout+r.stderr).includes(canary));}const before=await snapshot();assert.equal((await cli(['--password',canary])).report.code,'INVALID_ARGUMENTS');assert.equal(await snapshot(),before);
  });
  await check(t,'new-account apply requires a private absolute output outside the project',async()=>{
   const file=await manifest([{username:'private-output-test',name:'私有输出',role:'student'}]),before=await snapshot();denied(await cli(['--file',file,'--apply']),'PRIVATE_OUTPUT_REQUIRED');denied(await cli(['--file',file,'--apply','--credential-output','relative.json']),'PRIVATE_OUTPUT_REQUIRED');denied(await cli(['--file',file,'--apply','--credential-output',path.join(root,'output','must-not-create-credentials.json')]),'OUTPUT_IN_PROJECT');
   const publicDir=path.join(secretDir,'public');await mkdir(publicDir);await chmod(publicDir,0o755);denied(await cli(['--file',file,'--apply','--credential-output',path.join(publicDir,'credentials.json')]),'OUTPUT_DIRECTORY_NOT_PRIVATE');const gitDir=path.join(secretDir,'another-repo');await mkdir(path.join(gitDir,'.git'),{recursive:true,mode:0o700});denied(await cli(['--file',file,'--apply','--credential-output',path.join(gitDir,'credentials.json')]),'OUTPUT_IN_GIT');assert.equal(await snapshot(),before);assert.equal(await exists(path.join(root,'output','must-not-create-credentials.json')),false);
  });
  await check(t,'existing and symlink credential files are never overwritten',async()=>{
   const file=await manifest([{username:'exclusive-output',name:'输出互斥',role:'student'}]),before=await snapshot(),link=path.join(secretDir,'delivery-link.json'),original=digest(await readFile(delivery,'utf8'));await symlink(delivery,link);for(const target of [delivery,link])denied(await cli(['--file',file,'--apply','--credential-output',target]),'OUTPUT_EXISTS');assert.equal(await snapshot(),before);assert.equal(digest(await readFile(delivery,'utf8')),original);
  });
  await check(t,'workspace failure rolls back all new rows and removes uncommitted credentials without leaking DB errors',async()=>{
   await provision.query("CREATE FUNCTION app.reject_trial_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='force-workspace-failure' THEN RAISE EXCEPTION 'DoNotLogThisDatabaseCanary'; END IF; RETURN NEW; END $$");await provision.query('CREATE TRIGGER reject_trial_test BEFORE INSERT ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.reject_trial_test()');const file=await manifest([{username:'rollback-student',name:'先新增也回滚',role:'student'},{username:'rollback-coach',name:'force-workspace-failure',role:'coach'}]),target=path.join(secretDir,'rollback.json'),before=await snapshot();const response=await cli(['--file',file,'--apply','--credential-output',target]);denied(response,'PROVISION_FAILED');assert.ok(!(response.stdout+response.stderr).includes('DoNotLogThisDatabaseCanary'));assert.equal(await snapshot(),before);assert.equal(await exists(target),false);await provision.query('DROP TRIGGER reject_trial_test ON app.workspaces');await provision.query('DROP FUNCTION app.reject_trial_test()');
  });
  await check(t,'concurrent provisioning adds an account once and never replaces its generated password',async()=>{
   const file=await manifest([{username:'concurrent-friend',name:'并发朋友',role:'coach'}]),a=path.join(secretDir,'concurrent-a.json'),b=path.join(secretDir,'concurrent-b.json');const replies=await Promise.all([cli(['--file',file,'--apply','--credential-output',a]),cli(['--file',file,'--apply','--credential-output',b])]);assert.deepEqual(replies.map(r=>success(r).created).sort(),[0,1]);assert.equal(Number(await exists(a))+Number(await exists(b)),1);const row=(await provision.query("SELECT * FROM private.accounts WHERE username='concurrent-friend'")).rows[0],entry=JSON.parse(await readFile(await exists(a)?a:b,'utf8')).accounts[0];assert.equal(await verifyPassword(entry.password,row.password_salt,row.password_hash),true);assert.equal(Number((await provision.query('SELECT count(*) n FROM app.workspaces WHERE created_by=$1',[row.id])).rows[0].n),1);
  });
  await check(t,'allowed-shaped database with wrong owner is rejected before any schema or account mutation',async()=>{
   const wrong=database+'_wrong';await admin.query(`CREATE DATABASE ${wrong}`);try{denied(await cli(['--database',wrong]),'WRONG_DATABASE');}finally{await admin.query(`DROP DATABASE ${wrong}`);}
  });
 }finally{
  await runtime.end();await provision.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();await rm(secretDir,{recursive:true,force:true});await writeFile(path.join(output,'cleanup.json'),JSON.stringify({database,dropped:true,privateCredentialDirectoryRemoved:true,productionConnected:false},null,2));
 }
});
