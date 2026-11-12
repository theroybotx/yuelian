// Loopback-only browser harness. Production bridge and app, real isolated DB;
// only the outer Sites identity and external model/network faults are controlled.
import pg from '../../server/node_modules/pg/lib/index.js';
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import ts from 'typescript';
import {seedMockData,personas} from '../../server/scripts/mock-data.mjs';
process.loadEnvFile(process.env.YUELIAN_TEST_ENV||'/Users/jarvisxiao/.local/state/yuelian-security/runtime.env');
const ROOT=process.cwd(),OUT=process.env.YUELIAN_TEST_OUTPUT||ROOT+'/output/full-20261101/browser',db='yuelian_acceptance_browser_20261101',port=18896,webPort=18898,origin='http://127.0.0.1:'+webPort;
mkdirSync(OUT,{recursive:true});
const controller={id:'browser-acceptance-controller',fullName:'验收控制员',email:'controller@acceptance.invalid'},A='0f335aa9-6fce-45e9-a0de-1427b20e06c1',student='090082f0-6012-49d3-af4e-53c3f5b4b262';
const admin=new pg.Client({host:'/tmp',user:'jarvisxiao',database:'postgres'});await admin.connect();if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount)await admin.query(`CREATE DATABASE ${db} OWNER yuelian_security_owner`);await admin.end();
const c=new pg.Client({host:'/tmp',user:'jarvisxiao',database:db});await c.connect();await c.query('DROP SCHEMA IF EXISTS app CASCADE');await c.query('DROP SCHEMA IF EXISTS private CASCADE');await c.query('SET ROLE yuelian_security_owner');for(const f of readdirSync(ROOT+'/server/migrations').filter(f=>/^\d+.*\.sql$/.test(f)).sort())await c.query(readFileSync(ROOT+'/server/migrations/'+f,'utf8'));await c.query('RESET ROLE');
async function seed(){await c.query('TRUNCATE app.workspaces,app.memberships,app.records,app.invitations,app.plans,app.audit,private.accounts,private.sessions,private.request_nonces CASCADE');await c.query('INSERT INTO app.workspaces(id,name,created_by) VALUES($1,$2,$3)',[A,'示例 · 周教练',controller.id]);await c.query("INSERT INTO app.memberships(workspace_id,user_id,display_name,role) VALUES($1,$2,$3,'owner')",[A,controller.id,'周教练']);await c.query("INSERT INTO app.records(workspace_id,id,kind,owner_user_id,payload) VALUES($1,$2,'student',$3,$4)",[A,student,controller.id,{name:'小林',goal:'正反手',next:''}]);return seedMockData(c,{controllerId:controller.id,workspaceId:A,studentId:student});}
let fixture=await seed();writeFileSync(OUT+'/fixture.json',JSON.stringify(fixture,null,2));
const config=OUT+'/mock-access.json';writeFileSync(config,JSON.stringify({controllerId:controller.id,personas}),{mode:0o600});const secret=randomBytes(36).toString('base64url');
const env={...process.env,PGDATABASE:db,PORT:String(port),YUELIAN_BRIDGE_SECRET:secret,YUELIAN_ENVIRONMENT:'test',YUELIAN_TEST_ACCESS_FILE:config,YUELIAN_ACCEPT_REAL_DATA:'true',ACCEPTANCE_CONTROL:OUT+'/model-control.json',ACCEPTANCE_MODEL_LOG:OUT+'/model-inputs.jsonl'};
writeFileSync(env.ACCEPTANCE_CONTROL,JSON.stringify({status:503}));
const child=spawn(process.execPath,['--use-env-proxy','--experimental-transform-types','--import',ROOT+'/server/tests/model-preload.mjs',ROOT+'/server/src/server.mjs'],{env,stdio:['ignore','pipe','pipe']});let listening=false;
for(const out of [child.stdout,child.stderr])out.on('data',b=>{appendFileSync(OUT+'/backend.log',b);if(String(b).includes('listening'))listening=true;});for(let i=0;i<100&&!listening;i++){if(child.exitCode!==null)throw Error('Backend failed; inspect harness log');await new Promise(r=>setTimeout(r,100));}if(!listening)throw Error('Backend startup timeout');
const nativeFetch=globalThis.fetch;let mode={};
globalThis.__browserUser=async()=>({userId:controller.id,...controller});
globalThis.__browserFetch=async(url,options)=>{if(mode.offline)throw Error('simulated gateway outage');const r=await nativeFetch(String(url).replace('https://browser-backend.invalid','http://127.0.0.1:'+port),options);if(mode.dropDraft&&String(url).endsWith('/plans')){mode.dropDraft=false;throw Error('synthetic lost draft response');}if(mode.dropCommit&&String(url).endsWith('/commit')){mode.dropCommit=false;throw Error('synthetic lost commit response');}if(mode.delay&&String(url).endsWith('/snapshot'))await new Promise(r=>setTimeout(r,mode.delay));return r;};
process.env.YUELIAN_BACKEND_URL='https://browser-backend.invalid';process.env.YUELIAN_BRIDGE_SECRET=secret;
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const load=s=>import('data:text/javascript;base64,'+Buffer.from(compile(s)).toString('base64'));
const {proxyWorkspace,proxyAuth}=await load(readFileSync(ROOT+'/lib/workspace-bridge.ts','utf8').replace("import {getChatGPTUser} from '../app/chatgpt-auth';",'const getChatGPTUser=globalThis.__browserUser;').replace('await fetch(url,','await globalThis.__browserFetch(url,'));
const {GET:loginPage}=await load(readFileSync(ROOT+'/app/login/route.ts','utf8'));
const calls=[];
const web=http.createServer(async(req,res)=>{try{const url=new URL(req.url,origin),chunks=[];for await(const part of req)chunks.push(part);const body=Buffer.concat(chunks);
 if(url.pathname==='/__test/fixture'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(fixture));return;}
 if(url.pathname==='/__test/calls'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(calls));return;}
 if(url.pathname==='/__test/control'&&req.method==='POST'){const v=JSON.parse(body.toString());if(v.model)writeFileSync(env.ACCEPTANCE_CONTROL,JSON.stringify(v.model));if(v.mode)mode=v.mode;if(v.reset){fixture=await seed();}res.end('{}');return;}
 if(url.pathname==='/login'){const response=await loginPage();res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}
 if(url.pathname.startsWith('/api/auth/')||url.pathname.startsWith('/api/workspace/')){const auth=url.pathname.startsWith('/api/auth/'),prefix=auth?'/api/auth/':'/api/workspace/';const response=await (auth?proxyAuth:proxyWorkspace)(new Request(url,{method:req.method,headers:new Headers(req.headers),...(body.length?{body}:{} )}),url.pathname.slice(prefix.length).split('/'));calls.push({method:req.method,path:url.pathname,status:response.status});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}
 if(url.pathname==='/api/assistant'){res.writeHead(410,{'content-type':'application/json'});res.end('{"code":"USE_WORKSPACE"}');return;}
 const relative=decodeURIComponent(url.pathname);if(relative.includes('..')){res.writeHead(404);res.end();return;}const file=url.pathname==='/'?ROOT+'/frontend/index.html':ROOT+'/public/'+relative.replace(/^\//,'');if(!existsSync(file)){res.writeHead(404);res.end();return;}const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream';res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(readFileSync(file));
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
web.listen(webPort,'127.0.0.1',()=>console.log('Browser acceptance ready '+origin+' database='+db));
process.on('SIGTERM',()=>web.close(async()=>{writeFileSync(OUT+'/calls.json',JSON.stringify(calls,null,2));child.kill('SIGTERM');await c.end();process.exit(0);}));
