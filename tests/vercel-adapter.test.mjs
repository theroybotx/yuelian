import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,copyFile,writeFile,readFile,cp,rm} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTransportAuthenticator} from '../server/src/transport-auth.mjs';
import {ingressFetch} from './vercel-http-fixture.mjs';

// Stage the current source, not a potentially stale previously built handler.
// Only public assets come from the existing build; no backend, env or data is loaded.
const fixture=await mkdtemp(join(tmpdir(),'yuelian-vercel-source-'));
test.after(()=>rm(fixture,{recursive:true,force:true}));
await copyFile(new URL('../vercel/handler.mjs',import.meta.url),join(fixture,'index.mjs'));
await writeFile(join(fixture,'worker.mjs'),stripTypeScriptTypes(await readFile(new URL('../cloudflare/worker.ts',import.meta.url),'utf8')));
await copyFile(new URL('../.vercel/output/functions/gateway.func/assets.json',import.meta.url),join(fixture,'assets.json'));
await cp(new URL('../.vercel/output/functions/gateway.func/assets/',import.meta.url),join(fixture,'assets'),{recursive:true});
const {default:handler,handleRequest}=await import(pathToFileURL(join(fixture,'index.mjs')).href);

const origin='https://vercel-test.example',secret='synthetic-adapter-test-secret-'.repeat(3),token='T'.repeat(43);
const env={VERCEL:'1',VERCEL_URL:'adapter-exact.vercel.app',YUELIAN_PUBLIC_ORIGIN:origin,YUELIAN_BACKEND_URL:'https://backend.invalid',YUELIAN_STANDALONE_BRIDGE_SECRET:secret};
const cookie='__Host-yuelian_session='+token,sha=s=>createHash('sha256').update(s).digest('hex');
const request=(path,init={})=>new Request(origin+path,{...init,headers:{'x-vercel-forwarded-for':'198.51.100.24',...init.headers}});
const post=(path,body={},headers={})=>request(path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
let hits=[],reply=()=>Response.json({ok:true});
const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=async req=>{hits.push(req);return reply(req);};});
test.after(()=>{globalThis.fetch=originalFetch;});
test.beforeEach(()=>{hits=[];reply=()=>Response.json({ok:true});});

test('source-staged gateway serves homepage, invitation login, assets and HEAD',async()=>{
 assert.equal((await handleRequest(request('/'),env)).headers.get('location'),'/login');
 assert.match(await (await handleRequest(request('/login'),env)).text(),/登录约练/);
 assert.equal((await handleRequest(request('/',{headers:{cookie}}),env)).status,200);
 assert.equal((await handleRequest(request('/app.js',{method:'HEAD'}),env)).body,null);
 assert.equal((await handleRequest(request('/server/.env'),env)).status,404);
 assert.equal((await handleRequest(request('/assets.json'),env)).status,404);
 assert.equal(hits.length,0);
});
test('Preview HTML has a visible runtime-only environment banner; Production and JSON do not',async()=>{
 for(const route of ['/login','/']){
  const req=request(route,{headers:{cookie}});
  const preview=await handleRequest(req,{...env,VERCEL_ENV:'preview'});
  assert.match(await preview.text(),/id="yuelian-preview-banner"/);
  const production=await handleRequest(req,{...env,VERCEL_ENV:'production'});
  assert.doesNotMatch(await production.text(),/id="yuelian-preview-banner"/);
 }
 assert.doesNotMatch(await (await handleRequest(request('/api/auth/session'),{...env,VERCEL_ENV:'preview'})).text(),/yuelian-preview-banner/);
});
test('wrong origin and missing origin mutations fail before upstream',async()=>{
 for(const value of ['https://attacker.invalid',''])assert.equal((await handleRequest(post('/api/auth/session',{}, {origin:value}),env)).status,403);
 assert.equal((await handleRequest(new Request('https://attacker.invalid/api/auth/session'),env)).status,403);
 assert.equal(hits.length,0);
});
test('missing runtime marker, invalid origins and non-TLS backends fail closed',async()=>{
 for(const change of [{VERCEL:''},{YUELIAN_PUBLIC_ORIGIN:origin+'/'},{YUELIAN_BACKEND_URL:'http://127.0.0.1:18797'},{YUELIAN_BACKEND_URL:'https://user:password@backend.invalid'},{YUELIAN_BACKEND_URL:'https://backend.invalid?redirect=1'}])assert.equal((await handleRequest(request('/api/auth/session'),{...env,...change})).status,503);
 assert.equal(hits.length,0);
});
test('backend path prefixes fail closed before mismatched HMAC requests are sent',async()=>{
 for(const suffix of ['/base','/base/','/v1','//']){
  const response=await handleRequest(request('/api/auth/session'),{...env,YUELIAN_BACKEND_URL:env.YUELIAN_BACKEND_URL+suffix});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'BACKEND_NOT_CONFIGURED');
 }
 assert.equal(hits.length,0);
});
test('a backend origin with a root slash preserves exact backend request path',async()=>{
 assert.equal((await handleRequest(request('/api/auth/session'),{...env,YUELIAN_BACKEND_URL:env.YUELIAN_BACKEND_URL+'/'})).status,200);
 assert.equal(new URL(hits[0].url).pathname,'/v1/auth/session');
});
test('only Vercel injected single IP is used; no fallback to forged Cloudflare/forwarding header',async()=>{
 for(const value of ['', '198.51.100.2, 1.2.3.4','999.1.1.1','not-an-ip']){
  const response=await handleRequest(request('/api/auth/session',{headers:{'x-vercel-forwarded-for':value,'cf-connecting-ip':'1.2.3.4','x-forwarded-for':'1.2.3.4'}}),env);
  assert.equal(response.status,503);assert.equal((await response.json()).code,'EDGE_IDENTITY_UNAVAILABLE');
 }
 assert.equal(hits.length,0);
});
test('signed request verifies in unchanged backend authenticator; forged identity never reaches it',async()=>{
 const body={label:'hello'};
 const response=await handleRequest(post('/api/workspace/workspaces/a/plans',body,{cookie,'oai-authenticated-user-id':'owner','x-user-id':'owner','x-role':'owner','x-yuelian-channel':'sites','cf-connecting-ip':'1.2.3.4','x-forwarded-for':'1.2.3.4'}),env);
 assert.equal(response.status,200);assert.equal(hits.length,1);
 const req=hits[0],raw=await req.text();assert.equal(raw,JSON.stringify(body));
 const identity=createTransportAuthenticator({sitesSecret:'different-test-sites-secret-'.repeat(3),standaloneSecret:secret})({method:req.method,url:new URL(req.url).pathname,headers:Object.fromEntries(req.headers)},raw);
 assert.equal(identity.id,'standalone:cloudflare-trial');assert.equal(identity.sessionToken,token);
 assert.equal(identity.clientKey,createHmac('sha256',secret).update('client-ip\n198.51.100.24').digest('hex'));
 assert.equal(identity.emailHash,sha(identity.id));assert.equal(identity.role,undefined);
 for(const field of ['cookie','cf-connecting-ip','x-forwarded-for','oai-authenticated-user-id','x-role','x-user-id'])assert.equal(req.headers.get(field),null);
});
test('UTF-8 request bytes verify and method, path, body or timestamp tampering fails',async()=>{
 const raw=JSON.stringify({text:'明天约练 🎾'});
 await handleRequest(post('/api/workspace/workspaces/a/plans',JSON.parse(raw),{cookie}),env);
 const req=hits[0],headers=Object.fromEntries(req.headers),url=new URL(req.url).pathname;
 const verify=createTransportAuthenticator({sitesSecret:'different-test-sites-secret-'.repeat(3),standaloneSecret:secret});
 assert.equal(await req.text(),raw);
 assert.equal(verify({method:'POST',url,headers},raw).sessionToken,token);
 for(const [changed,body] of [
  [{method:'PATCH',url,headers},raw],
  [{method:'POST',url:url+'/commit',headers},raw],
  [{method:'POST',url,headers},raw+' '],
  [{method:'POST',url,headers:{...headers,'x-yuelian-time':String(Date.now()-180000)}},raw],
  [{method:'POST',url,headers:{...headers,'x-yuelian-channel':'sites'}},raw],
 ])assert.throws(()=>verify(changed,body),error=>error.code==='AUTH_REQUIRED');
});
test('anonymous and ambiguous-cookie business access, registration, testing and retired routes are rejected',async()=>{
 for(const value of ['',cookie+'; '+cookie])assert.equal((await handleRequest(request('/api/workspace/workspaces',{headers:{cookie:value}}),env)).status,401);
 assert.equal((await handleRequest(post('/api/auth/register'),env)).status,403);
 for(const path of ['/api/workspace/testing/status','/api/workspace/auth/session','/callback','/api/unknown'])assert.equal((await handleRequest(request(path),env)).status,404);
 assert.equal(hits.length,0);
});
test('login strips token JSON and emits only protected business Cookie; logout revokes upstream',async()=>{
 reply=()=>Response.json({authenticated:true,sessionToken:token});
 const r=await handleRequest(post('/api/auth/session'),env);
 assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Lax/);assert.ok(!r.headers.get('set-cookie').includes('Domain='));assert.ok(!(await r.text()).includes(token));
 reply=()=>Response.json({loggedOut:true});
 const logout=await handleRequest(post('/api/auth/logout',{}, {cookie}),env);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);assert.equal(hits.length,2);
});
test('invalid login token cannot establish a session',async()=>{
 reply=()=>Response.json({authenticated:true,sessionToken:'short'});
 const r=await handleRequest(post('/api/auth/session'),env);assert.equal(r.status,503);assert.equal(r.headers.get('set-cookie'),null);
});
test('oversized bodies are rejected without upstream',async()=>{
 const r=await handleRequest(post('/api/auth/session',{text:'x'.repeat(65537)}),env);assert.equal(r.status,413);assert.equal(hits.length,0);
});
test('unsupported API methods and non-JSON mutations never reach upstream',async()=>{
 assert.equal((await handleRequest(post('/api/auth/session',{}, {'content-type':'text/plain'}),env)).status,415);
 assert.equal((await handleRequest(request('/api/workspace/workspaces',{method:'PUT',headers:{origin,cookie,'content-type':'application/json'},body:'{}'}),env)).status,405);
 assert.equal(hits.length,0);
});
test('redirect, non-JSON and lost write responses never retry or expose secrets',async()=>{
 for(const fail of [()=>new Response(null,{status:307,headers:{location:'https://attacker.invalid'}}),()=>new Response('failure'),()=>{throw Error('lost response');}]){
  hits=[];reply=fail;
  const r=await handleRequest(post('/api/workspace/workspaces/a/plans',{}, {cookie}),env);
  assert.equal(r.status,503);const body=await r.text();assert.match(body,/尚未确认/);assert.ok(!body.includes(secret));assert.equal(hits.length,1);
 }
});
test('late unauthorized lookup does not clear a newer session Cookie',async()=>{
 reply=()=>Response.json({authenticated:false},{status:401});
 const r=await handleRequest(request('/api/auth/session'),env);assert.equal(r.headers.get('set-cookie'),null);
});
test('60-second upstream timeout is armed and an aborted write is not retried',async()=>{
 const originalTimeout=AbortSignal.timeout,controller=new AbortController(),durations=[];
 AbortSignal.timeout=milliseconds=>{durations.push(milliseconds);return controller.signal;};
 reply=req=>new Promise((resolve,reject)=>{
  assert.equal(req.redirect,'manual');
  req.signal.addEventListener('abort',()=>reject(req.signal.reason),{once:true});
  queueMicrotask(()=>controller.abort(new DOMException('Synthetic timeout','TimeoutError')));
 });
 try{
  const response=await handleRequest(post('/api/workspace/workspaces/a/plans',{}, {cookie}),env);
  assert.equal(response.status,503);assert.match((await response.json()).error,/尚未确认/);
  assert.deepEqual(durations,[60000]);assert.equal(hits.length,1);
 }finally{AbortSignal.timeout=originalTimeout;}
});
test('Node HTTP entrypoint preserves signed UTF-8 JSON and login Cookie',async()=>{
 const saved={};for(const [k,v] of Object.entries(env)){saved[k]=process.env[k];process.env[k]=v;}
 const verify=createTransportAuthenticator({sitesSecret:'different-test-sites-secret-'.repeat(3),standaloneSecret:secret});
 const raw=JSON.stringify({username:'synthetic-coach',password:'synthetic-密码-🎾'});
 reply=async req=>{
  const body=await req.text();assert.equal(body,raw);
  const identity=verify({method:req.method,url:new URL(req.url).pathname,headers:Object.fromEntries(req.headers)},body);
  assert.equal(identity.id,'standalone:cloudflare-trial');
  return Response.json({authenticated:true,sessionToken:token});
 };
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const response=await ingressFetch('http://127.0.0.1:'+server.address().port+'/api/auth/session',{
   method:'POST',headers:{origin,'content-type':'application/json','x-vercel-forwarded-for':'198.51.100.24'},body:raw,
  },origin);
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Lax/);
  assert.ok(!(await response.text()).includes(token));assert.equal(hits.length,1);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('source-staged Node HTTP entrypoint serves login and enforces fixed-origin CSRF',async()=>{
 const saved={};for(const [k,v] of Object.entries(env)){saved[k]=process.env[k];process.env[k]=v;}
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const r=await ingressFetch(base+'/login',{},origin);assert.equal(r.status,200);assert.match(await r.text(),/登录约练/);
  const cross=await ingressFetch(base+'/api/auth/session',{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'},origin);assert.equal(cross.status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
