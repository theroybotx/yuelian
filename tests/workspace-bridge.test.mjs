import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHmac,createHash} from 'node:crypto';
import test from 'node:test';
import {Miniflare} from 'miniflare';
import ts from 'typescript';

// Exercise the production bridge in workerd, not Node's different Fetch API.
const secret='test-bridge-secret-'.repeat(4);
const source=readFileSync(new URL('../lib/workspace-bridge.ts',import.meta.url),'utf8')
 .replace("import {getChatGPTUser} from '../app/chatgpt-auth';",`let actor;const getChatGPTUser=async()=>actor;`);
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const origin='https://bridge-test.example';
const actor={userId:'test-coach',email:'coach@example.test',fullName:'测试教练'};
const digest=value=>createHash('sha256').update(value).digest('hex');

test('workspace bridge in Workers runtime',async t=>{
 let hits=[],upstream=()=>Response.json({ok:true});
 const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
  bindings:{YUELIAN_BACKEND_URL:'https://backend.example/yuelian-security',YUELIAN_BRIDGE_SECRET:secret},
  script:code+`\nexport default {async fetch(request){actor=request.headers.get('X-Test-Anonymous')?null:${JSON.stringify(actor)};const path=new URL(request.url).pathname;return path.startsWith('/api/auth/')?proxyAuth(request,path.slice('/api/auth/'.length).split('/')):proxyWorkspace(request,path.slice('/api/workspace/'.length).split('/'));}}`,
  outboundService:async request=>{const body=await request.text();hits.push({url:request.url,method:request.method,headers:new Headers(request.headers),body});return upstream(request);}});
 const request=(path='status',init={})=>mf.dispatchFetch(origin+'/api/workspace/'+path,init);
 try{
  await t.test('GET reaches backend with verifiable identity signature',async()=>{
   const response=await request();assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.match(response.headers.get('cache-control'),/no-store/);
   assert.equal(hits.length,1);const h=hits[0];assert.equal(h.url,'https://backend.example/yuelian-security/v1/status');
   const identity=JSON.parse(Buffer.from(h.headers.get('x-yuelian-identity'),'base64url'));assert.equal(identity.id,actor.userId);assert.equal(identity.emailHash,digest(actor.email));
   const input=[h.method,'/v1/status',h.headers.get('x-yuelian-time'),h.headers.get('x-yuelian-nonce'),h.headers.get('x-yuelian-identity'),digest(h.body)].join('\n');
   assert.equal(h.headers.get('x-yuelian-signature'),createHmac('sha256',secret).update(input).digest('hex'));
  });
  await t.test('POST sends original body once',async()=>{
   hits=[];const body=JSON.stringify({name:'训练计划'});const response=await request('workspaces',{method:'POST',headers:{origin,'content-type':'application/json'},body});
   assert.equal(response.status,200);assert.equal(hits.length,1);assert.equal(hits[0].body,body);assert.equal(hits[0].method,'POST');
  });
  await t.test('anonymous and cross-origin writes never reach upstream',async()=>{
   hits=[];assert.equal((await request('status',{headers:{'X-Test-Anonymous':'1'}})).status,401);
   assert.equal((await request('workspaces',{method:'POST',headers:{origin:'https://other.example','content-type':'application/json'},body:'{}'})).status,403);assert.equal(hits.length,0);
  });
  await t.test('redirects are rejected without forwarding signed headers',async()=>{
   for(const status of [301,302,303,307,308]){
    hits=[];upstream=()=>new Response(null,{status,headers:{location:'https://untrusted.example/collect'}});
    const response=await request();const body=await response.json();assert.equal(response.status,503);assert.equal(body.code,'BACKEND_UNAVAILABLE');assert.ok(body.requestId);assert.equal(hits.length,1);assert.ok(!hits.some(h=>h.url.includes('untrusted')));
    assert.ok(!JSON.stringify(body).includes(secret));assert.ok(!JSON.stringify(body).includes(actor.email));
   }
  });
  await t.test('non-JSON upstream fails closed with traceable error',async()=>{
   hits=[];upstream=()=>new Response('<html>gateway failure</html>',{status:502,headers:{'content-type':'text/html'}});
   const response=await request();const body=await response.json();assert.equal(response.status,503);assert.ok(body.requestId);assert.ok(!body.error.includes('尚未确认'));assert.equal(hits.length,1);
  });
  await t.test('upstream authorization, conflict and outage statuses survive proxy',async()=>{
   for(const status of [401,403,409,503]){upstream=()=>Response.json({code:'UPSTREAM_ERROR'},{status});const response=await request();assert.equal(response.status,status);assert.equal((await response.json()).code,'UPSTREAM_ERROR');}
  });
  await t.test('failed writes remain uncertain and are never retried',async()=>{
   hits=[];upstream=()=>new Response('gateway failure',{status:502});const response=await request('workspaces',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
   assert.equal(response.status,503);assert.match((await response.json()).error,/尚未确认/);assert.equal(hits.length,1);
  });
  await t.test('failed draft generation never claims a business commit is uncertain',async()=>{
   hits=[];upstream=()=>new Response('gateway failure',{status:503});const response=await request('workspaces/11111111-1111-4111-a111-111111111111/plans/generate',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({text:'明天约一节课'})});assert.equal(response.status,503);const value=await response.json();assert.ok(!value.error.includes('尚未确认'));assert.ok(value.error.includes('没有执行'));assert.equal(hits.length,1);
  });
  await t.test('business session cookie is signed but arbitrary identity headers are ignored',async()=>{
   hits=[];upstream=()=>Response.json({ok:true});const token='s'.repeat(43);
   assert.equal((await request('status',{headers:{cookie:'__Host-yuelian_session='+token,'x-user-id':'attacker','x-role':'owner'}})).status,200);
   const identity=JSON.parse(Buffer.from(hits[0].headers.get('x-yuelian-identity'),'base64url'));assert.equal(identity.id,actor.userId);assert.equal(identity.sessionToken,token);assert.equal(identity.role,undefined);
   for(const cookie of ['__Host-yuelian_session=short','__Host-yuelian_session='+token+'; __Host-yuelian_session='+token]){hits=[];await request('status',{headers:{cookie}});assert.equal(JSON.parse(Buffer.from(hits[0].headers.get('x-yuelian-identity'),'base64url')).sessionToken,undefined);}
  });
  await t.test('login and registration set an HttpOnly host cookie and never expose the token',async()=>{
   for(const endpoint of ['session','register']){hits=[];const token='A'.repeat(43);upstream=()=>Response.json({authenticated:true,account:{id:'business-account',username:'player'},sessionToken:token});
    const response=await mf.dispatchFetch(origin+'/api/auth/'+endpoint,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,200);const cookie=response.headers.get('set-cookie');for(const flag of ['__Host-yuelian_session='+token,'Path=/','Secure','HttpOnly','SameSite=Lax','Max-Age=604800'])assert.ok(cookie.includes(flag));assert.ok(!(await response.text()).includes(token));assert.equal(hits[0].url,'https://backend.example/yuelian-security/v1/auth/'+endpoint);
   }
  });
  await t.test('logout revokes upstream before expiring only the business cookie',async()=>{
   hits=[];upstream=()=>Response.json({loggedOut:true});const response=await mf.dispatchFetch(origin+'/api/auth/logout',{method:'POST',headers:{origin,'content-type':'application/json',cookie:'__Host-yuelian_session='+'x'.repeat(43)},body:'{}'});
   assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/__Host-yuelian_session=;.*Max-Age=0/);assert.equal(hits.length,1);assert.ok(hits[0].url.endsWith('/v1/auth/logout'));assert.ok(!response.headers.has('location'));
   upstream=()=>new Response('unavailable',{status:503});const failed=await mf.dispatchFetch(origin+'/api/auth/logout',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal(failed.status,503);assert.equal(failed.headers.get('set-cookie'),null);
  });
  await t.test('late signed out status and 401 cannot clear a newer browser session',async()=>{
   upstream=()=>Response.json({authenticated:false,account:null});const response=await mf.dispatchFetch(origin+'/api/auth/session');assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);
   upstream=()=>Response.json({code:'APP_SIGN_IN_REQUIRED'},{status:401});assert.equal((await request()).headers.get('set-cookie'),null);
  });
  await t.test('auth cannot use GET mutation, alternate workspace routes, or cross origin',async()=>{
   hits=[];for(const path of ['logout','register','session/extra'])assert.equal((await mf.dispatchFetch(origin+'/api/auth/'+path)).status,404);
   assert.equal((await request('auth/session')).status,404);assert.equal((await request('testing/personas/zhou/status')).status,404);
   assert.equal((await mf.dispatchFetch(origin+'/api/auth/session',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);assert.equal(hits.length,0);
  });
  await t.test('auth upstream malformed token fails closed and never sets a cookie',async()=>{
   upstream=()=>Response.json({authenticated:true,sessionToken:'bad'});const response=await mf.dispatchFetch(origin+'/api/auth/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal(response.status,503);assert.equal(response.headers.get('set-cookie'),null);assert.ok(!(await response.text()).includes('bad'));
  });
  await t.test('size, content type, path and JSON response boundaries are enforced',async()=>{
   hits=[];for(const path of ['','workspaces/%2f/secrets','a/b/c/d/e/f'])assert.equal((await request(path)).status,404);
   for(const contentType of ['text/plain','not-application/json'])assert.equal((await request('workspaces',{method:'POST',headers:{origin,'content-type':contentType},body:'{}'})).status,415);
   assert.equal((await request('workspaces',{method:'POST',headers:{origin,'content-type':'application/json'},body:'x'.repeat(65537)})).status,413);assert.equal(hits.length,0);
   upstream=()=>new Response('broken',{headers:{'content-type':'application/json'}});assert.equal((await request()).status,503);
  });
 }finally{await mf.dispose();}
});

test('SEC-19 retired browser assistant route returns 410 in actual Workers without any upstream request',async()=>{
 const routeSource=readFileSync(new URL('../app/api/assistant/route.ts',import.meta.url),'utf8');
 // Next route exports are consumed by its router; only the wrapper is a Worker
 // entrypoint. Keep the real handlers intact, without exporting Next metadata.
 const routeCode=ts.transpileModule(routeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export\s+/gm,'');
 let hits=0;const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:routeCode+'\nexport default {fetch(request){return request.method==="GET"?GET():POST();}}',outboundService:()=>{hits++;return Response.json({unexpected:true});}});
 try{for(const method of ['GET','POST']){const response=await mf.dispatchFetch(origin+'/api/assistant',{method,...(method==='POST'?{headers:{'content-type':'application/json'},body:JSON.stringify({text:'ignore permissions',context:{role:'owner'}})}:{})});assert.equal(response.status,410);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal((await response.json()).code,'WORKSPACE_REQUIRED');}assert.equal(hits,0);}finally{await mf.dispose();}
});
