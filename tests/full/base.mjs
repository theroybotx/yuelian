import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import pg from '../../server/node_modules/pg/lib/index.js';
import {Draft} from '../../lib/assistant.ts';
import {coverage} from './coverage.mjs';
import {sourceState} from './source-state.mjs';
const implementation=sourceState();
process.loadEnvFile(process.env.YUELIAN_TEST_ENV||'/Users/jarvisxiao/.local/state/yuelian-security/runtime.env');
const ROOT=process.cwd(),OUT=process.env.YUELIAN_TEST_OUTPUT||ROOT+'/output/full-20261101/'+(process.env.YUELIAN_TEST_SUITE||'api');mkdirSync(OUT,{recursive:true});
const db=process.env.YUELIAN_TEST_DATABASE||'yuelian_acceptance_full_20261101',port=Number(process.env.YUELIAN_TEST_PORT||18897),secret=randomBytes(36).toString('base64url');
assert.match(db,/^yuelian_acceptance_[a-z0-9_]+$/);
assert.notEqual(db,'yuelian_security');
const admin=new pg.Client({host:'/tmp',database:'postgres',user:process.env.YUELIAN_TEST_ADMIN||process.env.USER,password:undefined});await admin.connect();
assert.match(db,/^yuelian_acceptance_/);
if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount){await admin.query(`CREATE DATABASE ${db} OWNER yuelian_security_owner`);}
await admin.end();
const provision=new pg.Client({host:'/tmp',database:db,user:process.env.YUELIAN_TEST_ADMIN||process.env.USER,password:undefined});await provision.connect();
// This suite owns this guarded acceptance database; rebuild migrations for each suite.
await provision.query('DROP SCHEMA IF EXISTS app CASCADE');await provision.query('DROP SCHEMA IF EXISTS private CASCADE');
await provision.query('SET ROLE yuelian_security_owner');
for(const file of readdirSync(ROOT+'/server/migrations').filter(f=>/^\d+.*\.sql$/.test(f)).sort())await provision.query(readFileSync(ROOT+'/server/migrations/'+file,'utf8'));
await provision.query('RESET ROLE');
process.env.PGDATABASE=db;process.env.YUELIAN_BRIDGE_SECRET=secret;process.env.PORT=String(port);process.env.YUELIAN_ACCEPT_REAL_DATA='true';process.env.YUELIAN_ENVIRONMENT='test';delete process.env.YUELIAN_TEST_ACCESS_FILE;
process.env.ACCEPTANCE_CONTROL=OUT+'/model-control.json';process.env.ACCEPTANCE_MODEL_LOG=OUT+'/model-inputs.jsonl';
const {pool,transaction,assertRuntimeRole}=await import('../../server/src/db.mjs');
const {modelContext}=await import('../../server/src/plans.mjs');
const logs=[];let child;
const op=(intent,values={})=>({...Object.fromEntries(Object.keys(Draft.shape).map(k=>[k,null])),intent,title:'验收操作',explanation:'仅隔离验收',...values});
const plan=(...operations)=>({title:'验收计划',explanation:'核对后执行',steps:operations.map((operation,i)=>({id:`s${i+1}`,dependsOn:[],studentRef:null,venueRef:null,operation}))});
const control=value=>writeFileSync(process.env.ACCEPTANCE_CONTROL,JSON.stringify(value));
const sha=s=>createHash('sha256').update(s).digest('hex');
const identity=(id)=>({id,name:id,emailHash:sha(id+'@acceptance.invalid'),requestId:randomUUID()});
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const addDate=(days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
function signed(who,method,path,body,overrides={}){
 const raw=body===undefined?'':typeof body==='string'?body:JSON.stringify(body),stamp=String(Date.now()),nonce=randomUUID(),encoded=Buffer.from(JSON.stringify({id:who.platformId||who.id,name:who.platformName||who.name,emailHash:who.emailHash,...(who.sessionToken?{sessionToken:who.sessionToken}:{})})).toString('base64url');
 return {method,headers:{'content-type':'application/json','x-yuelian-time':stamp,'x-yuelian-nonce':nonce,'x-yuelian-identity':encoded,'x-yuelian-signature':createHmac('sha256',secret).update([method,path,stamp,nonce,encoded,sha(raw)].join('\n')).digest('hex'),...overrides},...(raw?{body:raw}:{})};
}
async function request(who,path,method='GET',body,options={}){const r=await fetch('http://127.0.0.1:'+port+path,options.unsigned?{method,headers:options.headers||{},...(body?{body:JSON.stringify(body)}:{})}:signed(who,method,path,body,options.headers));return {status:r.status,body:await r.json(),headers:Object.fromEntries(r.headers)};}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const denied=r=>{assert.ok([400,401,402,403,404,409,410,413,422,429,502,503,504].includes(r.status),'expected denial, got '+JSON.stringify(r));return r;};
const wpath=(f,tail='',which='A')=>`/v1/workspaces/${f[which]}`+(tail?'/'+tail:'');
async function snapshot(f,who=f.coachA,which='A'){return ok(await request(who,wpath(f,'snapshot',which)));}
async function draft(f,p,who=f.coachA,which='A'){const s=await snapshot(f,who,which);return request(who,wpath(f,'plans',which),'POST',{plan:p,revisions:Object.fromEntries(s.records.map(r=>[r.id,r.revision]))});}
async function commit(f,p,who=f.coachA,which='A'){const d=await draft(f,p,who,which);if(d.status!==200)return d;return request(who,wpath(f,`plans/${d.body.id}/commit`,which),'POST',{});}
async function generate(f,text,who=f.coachA,which='A'){return request(who,wpath(f,'plans/generate',which),'POST',{text});}
async function rec(w,kind,payload,more={}){const id=randomUUID();await provision.query('INSERT INTO app.records(workspace_id,id,kind,student_id,lesson_id,venue_id,owner_user_id,visibility,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[w,id,kind,more.student||null,more.lesson||null,more.venue||null,more.owner||'fixture-coach',more.visibility||'private',payload]);return id;}
async function account(label,role='student'){
 const outer=identity('platform-'+randomUUID()),username=('t'+label.replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+randomUUID().slice(0,6)).slice(0,30);
 const reply=await request(outer,'/v1/auth/register','POST',{username,password:'Acceptance-'+randomBytes(16).toString('hex'),name:label.slice(0,60),role});
 if(reply.status!==200)throw Error('Fixture registration failed: '+reply.status+' '+reply.body.code);
 const {account:a,sessionToken}=reply.body;assert.ok(sessionToken&&a?.id,'Registered account and session required');
 return {...outer,id:a.id,name:a.name,username:a.username,platformId:outer.id,platformName:outer.name,sessionToken,sessionHash:sha(sessionToken)};
}
async function seed(){
 await provision.query('TRUNCATE app.workspaces,app.memberships,app.records,app.invitations,app.plans,app.audit,private.request_nonces,private.sessions,private.accounts CASCADE');
 const tag=randomUUID().slice(0,8),f={};for(const n of ['coachA','coachB','adminA','assistant','studentA','studentB','studentC','outsider'])f[n]=await account(tag+'-'+n,n.startsWith('coach')?'coach':'student');
 for(const [key,who] of [['A',f.coachA],['B',f.coachB]]){const ws=ok(await request(who,'/v1/workspaces')).workspaces;assert.equal(ws.length,1);f[key]=ws[0].id;await provision.query('UPDATE app.workspaces SET name=$2 WHERE id=$1',[f[key],key==='A'?'验收球会甲':'验收球会乙']);}

 f.a=await rec(f.A,'student',{name:'小王',goal:'正手',next:''});f.b=await rec(f.A,'student',{name:'小李',goal:'反手',next:''});f.ab=await rec(f.B,'student',{name:'小王',goal:'发球',next:''});f.c=await rec(f.B,'student',{name:'小赵',goal:'截击',next:''});
 f.permissions=['students.read','schedule.read','schedule.write','venues.read'];
 for(const [w,who,role,sid,permissions] of [[f.A,f.adminA,'admin',null,[]],[f.A,f.assistant,'assistant',null,f.permissions],[f.A,f.studentA,'student',f.a,[]],[f.A,f.studentB,'student',f.b,[]],[f.B,f.studentA,'student',f.ab,[]],[f.B,f.studentC,'student',f.c,[]]])await provision.query('INSERT INTO app.memberships(workspace_id,user_id,display_name,role,student_id,permissions) VALUES($1,$2,$3,$4,$5,$6)',[w,who.id,who.name,role,sid,permissions]);
 f.va=await rec(f.A,'venue',{name:'甲网球场',address:'验收路1号',court:'1号场',indoor:false},{visibility:'shared'});f.va2=await rec(f.A,'venue',{name:'甲第二场',address:'验收路2号',court:'2号场',indoor:true},{visibility:'shared'});f.vb=await rec(f.B,'venue',{name:'乙网球场',address:'验收路3号',court:'3号场',indoor:false},{visibility:'shared'});
 await provision.query("DELETE FROM app.records WHERE kind='settings'");
 for(const w of [f.A,f.B])await rec(w,'settings',{days:['一','二','三','四','五','六','日'],start:'09:00',end:'21:00',travel:30},{visibility:'shared'});
 for(const [w,s,delta] of [[f.A,f.a,10],[f.A,f.b,8],[f.B,f.ab,3],[f.B,f.c,6]])await rec(w,'ledger',{delta,label:'验收购课'},{student:s});
 f.privateB=await rec(f.B,'coach-note',{text:'TEST_B_PRIVATE_781'},{student:f.c});f.contactB=await rec(f.A,'contact',{phone:'TEST_A_PEER_PHONE_239',email:''},{student:f.b});f.noteA=await rec(f.A,'coach-note',{text:'TEST_A_COACH_NOTE_652'},{student:f.a});
 f.confirmed=await rec(f.A,'lesson',{date,start:600,duration:60,state:'confirmed',topic:'正反手'},{student:f.a,venue:f.va,visibility:'shared'});await rec(f.A,'participant',{}, {student:f.a,lesson:f.confirmed});
 f.group=await rec(f.A,'lesson',{date,start:720,duration:60,state:'confirmed',topic:'共同训练'},{venue:f.va,visibility:'shared'});for(const s of [f.a,f.b])await rec(f.A,'participant',{}, {student:s,lesson:f.group});
 f.pending=await rec(f.A,'lesson',{date:addDate(1),start:600,duration:60,state:'pending',topic:'正手'},{student:f.a,venue:f.va,visibility:'shared'});await rec(f.A,'participant',{}, {student:f.a,lesson:f.pending});f.bookingMessage=await rec(f.A,'message',{kind:'booking',state:'pending',title:'预约申请',text:'10点预约'},{student:f.a,lesson:f.pending,visibility:'shared'});
 f.proposal=await rec(f.A,'lesson',{date:addDate(1),start:660,duration:60,state:'pending_student',topic:'反手'},{student:f.a,venue:f.va,visibility:'shared'});await rec(f.A,'participant',{}, {student:f.a,lesson:f.proposal});f.proposalMessage=await rec(f.A,'message',{kind:'proposal',state:'pending',title:'教练邀约',text:'11点预约'},{student:f.a,lesson:f.proposal,visibility:'shared'});
 f.feedbackPrivate=await rec(f.A,'feedback',{text:'TEST_UNPUBLISHED_822'},{student:f.a,lesson:f.confirmed});f.feedbackShared=await rec(f.A,'feedback',{text:'TEST_PUBLISHED_888'},{student:f.a,lesson:f.confirmed,visibility:'shared'});
 f.practicePrivate=await rec(f.A,'practice',{topic:'私人练习',text:'TEST_PRACTICE_PRIVATE_251',date},{student:f.a,owner:f.studentA.id});f.practiceShared=await rec(f.A,'practice',{topic:'共享练习',text:'TEST_PRACTICE_SHARED_252',date},{student:f.a,owner:f.studentA.id,visibility:'shared'});
 control({plan:plan(op('clarification',{explanation:'当前无权处理该请求。'}))});return f;
}
const results=[];
async function test(id,name,fn,planIds=[]){if(process.env.ACCEPTANCE_FILTER&&!process.env.ACCEPTANCE_FILTER.split(',').includes(id))return;planIds=planIds.length?planIds:coverage[process.env.YUELIAN_TEST_SUITE||'api']?.[id]||[];const start=Date.now();let checks=[];try{const f=await seed();await fn(f,checks);results.push({id,planIds,name,status:'passed',checks,durationMs:Date.now()-start});}catch(e){results.push({id,planIds,name,status:'failed',error:e.message,stack:e.stack,checks,durationMs:Date.now()-start});}writeFileSync(OUT+'/results.json',JSON.stringify({runId:process.env.YUELIAN_TEST_RUN_ID||null,source:implementation,workingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()?'modified':'clean',database:db,productionDataTouched:false,results},null,2));console.log(id+' '+results.at(-1).status+(results.at(-1).error?' '+results.at(-1).error.slice(0,260):''));}
async function dbSnapshot(){return (await provision.query('SELECT workspace_id,id,kind,student_id,lesson_id,venue_id,owner_user_id,visibility,payload,revision FROM app.records ORDER BY id')).rows;}
const countModel=()=>existsSync(process.env.ACCEPTANCE_MODEL_LOG)?readFileSync(process.env.ACCEPTANCE_MODEL_LOG,'utf8').trim().split('\n').filter(Boolean).length:0;
async function start(){control({plan:plan(op('clarification'))});child=spawn(process.execPath,['--use-env-proxy','--experimental-transform-types','--import',ROOT+'/server/tests/model-preload.mjs',ROOT+'/server/src/server.mjs'],{env:{...process.env},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{logs.push(String(d));appendFileSync(OUT+'/backend.log',d);});child.stderr.on('data',d=>{logs.push(String(d));appendFileSync(OUT+'/backend.log',d);});for(let i=0;i<100;i++){if(logs.some(x=>x.includes('listening')))return;if(child.exitCode!==null)throw Error('test backend failed: '+logs.join(''));await new Promise(r=>setTimeout(r,100));}throw Error('backend startup timeout');}
await start();
export {ROOT,OUT,db,port,secret,provision,pool,transaction,assertRuntimeRole,modelContext,op,plan,control,sha,identity,account,date,addDate,signed,request,ok,denied,wpath,snapshot,draft,commit,generate,rec,seed,test,results,dbSnapshot,countModel,child,logs};
export async function stop(){if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await pool.end();await provision.end();if(results.some(r=>r.status==='failed'))process.exitCode=1;}
