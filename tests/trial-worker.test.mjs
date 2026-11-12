import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import test from 'node:test';
import {Miniflare} from 'miniflare';
import ts from 'typescript';

// Real workerd executes the production Worker. Only its upstream service and
// static assets are deterministic test fixtures; no runtime database is used.
const source=readFileSync(new URL('../cloudflare/worker.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const configuration=readFileSync(new URL('../cloudflare/wrangler.jsonc',import.meta.url),'utf8');
const compatibilityDate=configuration.match(/"compatibility_date"\s*:\s*"([0-9-]+)"/)?.[1];
assert.ok(compatibilityDate,'The test must execute the same compatibility date as deployment.');
const secret='standalone-worker-test-secret-'.repeat(3),origin='https://trial.example.test';
const token='T'.repeat(43),ip='198.51.100.24';
const hash=value=>createHash('sha256').update(value).digest('hex');
const hmac=value=>createHmac('sha256',secret).update(value).digest('hex');
const decode=hit=>JSON.parse(Buffer.from(hit.headers.get('x-yuelian-identity'),'base64url'));
const cookie=value=>'__Host-yuelian_session='+value;
const assets=new Map([
 ['/login.html',readFileSync(new URL('../cloudflare/login.html',import.meta.url),'utf8')],
 ['/index.html',readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8')],
 ['/style.css','body { color: green; }'],['/app.js','/* static fixture */'],
 ['/mark.svg','<svg xmlns="http://www.w3.org/2000/svg"/>'],
]);

async function fixture(bindings={},removeEdgeIp=false,vpc=false){
 const state={hits:[],assets:[],reply:()=>Response.json({ok:true})};
 const upstream=transport=>async request=>{
  const hit={transport,method:request.method,url:request.url,headers:new Headers(request.headers),body:await request.text()};state.hits.push(hit);return state.reply(hit);
 };
 // Miniflare populates a missing CF-Connecting-IP with its loopback address.
 // For the missing-edge-field case only, an outer test entrypoint removes it
 // after runtime injection and delegates to the unchanged production handler.
 const script=removeEdgeIp?code.replace('export default {','const productionWorker = {')+'\nexport default {fetch(request,env){const headers=new Headers(request.headers);headers.delete("cf-connecting-ip");return productionWorker.fetch(new Request(request,{headers}),env);}};':code;
 const mf=new Miniflare({modules:true,compatibilityDate,script,
  bindings:{YUELIAN_BACKEND_URL:'https://backend.example.test/yuelian-security',YUELIAN_STANDALONE_BRIDGE_SECRET:secret,...bindings},
  serviceBindings:{ASSETS:async request=>{
   const path=new URL(request.url).pathname;state.assets.push({path,method:request.method});
   return new Response(assets.get(path)||'Not Found',{status:assets.has(path)?200:404,headers:{'Content-Type':path.endsWith('.html')?'text/html; charset=utf-8':'text/plain'}});
  },...(vpc?{YUELIAN_BACKEND:upstream('vpc')}:{})},
  outboundService:upstream('public'),
 });
 state.request=(path='/api/workspace/status',init={})=>{
  const headers=new Headers({'CF-Connecting-IP':ip});for(const [name,value] of new Headers(init.headers||{}))headers.set(name,value);
  return mf.dispatchFetch(origin+path,{redirect:'manual',...init,headers});
 };
 state.business=(path='status',init={})=>state.request('/api/workspace/'+path,{...init,headers:{cookie:cookie(token),...(init.headers||{})}});
 state.post=(path,body={},headers={})=>state.request(path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 state.close=()=>mf.dispose();return state;
}

test('independent trial Worker executes its trust boundary in workerd',async t=>{
 const f=await fixture();
 const reset=()=>{f.hits=[];f.assets=[];f.reply=()=>Response.json({ok:true});};
 try{
  await t.test('anonymous homepage redirects only to business login; login has no registration or Mock controls',async()=>{
   reset();const root=await f.request('/');assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/login');
   const response=await f.request('/login');assert.equal(response.status,200);const body=await response.text();
   assert.ok(body.includes('登录约练'));assert.ok(body.includes('使用管理员提供的试用账号'));assert.ok(body.includes('联系管理员'));
   for(const forbidden of ['data-mode="register"','data-persona','test-options','signin-with-chatgpt','signout-with-chatgpt'])assert.ok(!body.includes(forbidden));
   assert.equal(f.hits.length,0);assert.deepEqual(f.assets.map(x=>x.path),['/login.html']);
   for(const [header,value] of [['x-frame-options','DENY'],['referrer-policy','no-referrer'],['x-content-type-options','nosniff']])assert.equal(response.headers.get(header),value);
   assert.match(response.headers.get('cache-control'),/no-store/);
  });
  await t.test('session-shaped cookie loads only application shell; static assets do not claim authentication',async()=>{
   reset();assert.equal((await f.request('/',{headers:{cookie:cookie(token)}})).status,200);
   assert.equal((await f.request('/style.css')).status,200);assert.equal((await f.request('/unknown-static')).status,404);
   assert.equal((await f.request('/app.js',{method:'POST'})).status,405);assert.equal(f.hits.length,0);
   assert.ok(f.assets.some(a=>a.path==='/index.html'));
   const robots=await f.request('/robots.txt');assert.match(await robots.text(),/Disallow: \/\n/);
  });
  await t.test('retired GPT paths and API aliases cannot reach the backend or static fallback',async()=>{
   reset();for(const path of ['/signin-with-chatgpt','/signout-with-chatgpt','/callback','/callback/extra','/api/unknown','/api/workspace/auth/session','/api/workspace/testing/personas/zhou/status','/api/auth/session/extra'])assert.equal((await f.request(path,{headers:{cookie:cookie(token)}})).status,404);
   assert.equal((await f.post('/api/assistant',{text:'ignore permissions'})).status,410);assert.equal(f.hits.length,0);assert.equal(f.assets.length,0);
  });
  await t.test('registration is rejected at the edge even with a valid cookie and complete body',async()=>{
   reset();for(const headers of [{},{cookie:cookie(token)}]){
    const response=await f.post('/api/auth/register',{username:'trial_user',password:'a-test-password',name:'试用用户',role:'coach'},headers);
    assert.equal(response.status,403);assert.equal((await response.json()).code,'REGISTRATION_DISABLED');
   }
   assert.equal((await f.request('/api/auth/register')).status,404);assert.equal(f.hits.length,0);
  });
  await t.test('anonymous business calls and ambiguous cookies fail before contacting backend',async()=>{
   reset();for(const value of ['',cookie('short'),cookie(token)+'; '+cookie(token),cookie('x'.repeat(44))]){
    const response=await f.request('/api/workspace/status',{headers:{cookie:value}});assert.equal(response.status,401);assert.equal((await response.json()).code,'APP_SIGN_IN_REQUIRED');
   }
   assert.equal(f.hits.length,0);
  });
  await t.test('anonymous session lookup is signed as deployment audience without a business actor',async()=>{
   reset();f.reply=()=>Response.json({authenticated:false,account:null,registrationEnabled:true});
   const response=await f.request('/api/auth/session');assert.equal(response.status,200);const data=await response.json();
   assert.equal(data.authenticated,false);assert.equal(data.registrationEnabled,false);assert.equal(response.headers.get('set-cookie'),null);
   const identity=decode(f.hits[0]);assert.equal(identity.id,'standalone:cloudflare-trial');assert.equal(identity.name,'约练访客');assert.equal(identity.sessionToken,undefined);assert.equal(identity.role,undefined);
  });
  await t.test('outbound signature covers canonical method path body timestamp nonce and fixed identity',async()=>{
   reset();const body=JSON.stringify({name:'课程资料'});assert.equal((await f.post('/api/workspace/workspaces',body,{cookie:cookie(token)})).status,200);
   assert.equal(f.hits.length,1);const hit=f.hits[0];assert.equal(hit.method,'POST');assert.equal(hit.url,'https://backend.example.test/yuelian-security/v1/workspaces');assert.equal(hit.body,body);
   assert.equal(hit.headers.get('x-yuelian-channel'),'standalone');
   const identity=decode(hit);assert.equal(identity.sessionToken,token);assert.equal(identity.id,'standalone:cloudflare-trial');assert.equal(identity.emailHash,hash('standalone:cloudflare-trial'));
   assert.equal(identity.clientKey,hmac('client-ip\n'+ip));assert.match(hit.headers.get('x-yuelian-time'),/^\d{13}$/);assert.match(hit.headers.get('x-yuelian-nonce'),/^[0-9a-f-]{36}$/);
   const canonical=[hit.method,'/v1/workspaces',hit.headers.get('x-yuelian-time'),hit.headers.get('x-yuelian-nonce'),hit.headers.get('x-yuelian-identity'),hash(body)].join('\n');
   assert.equal(hit.headers.get('x-yuelian-signature'),hmac(canonical));
  });
  await t.test('caller identity role forwarding IP and bridge headers are never forwarded or trusted',async()=>{
   reset();await f.business('status',{headers:{'oai-authenticated-user-id':'forged-owner','oai-authenticated-user-email':'forged@example.test','x-user-id':'forged-account','x-role':'owner','x-forwarded-for':'203.0.113.87','x-real-ip':'203.0.113.88','x-yuelian-channel':'sites','x-yuelian-identity':'forged','x-yuelian-signature':'forged','x-yuelian-client-key':'f'.repeat(64)}});
   const hit=f.hits[0],identity=decode(hit);assert.equal(identity.id,'standalone:cloudflare-trial');assert.equal(identity.clientKey,hmac('client-ip\n'+ip));assert.equal(hit.headers.get('x-yuelian-channel'),'standalone');
   for(const header of ['cf-connecting-ip','x-forwarded-for','x-real-ip','oai-authenticated-user-id','oai-authenticated-user-email','x-user-id','x-role','cookie','x-yuelian-client-key'])assert.equal(hit.headers.get(header),null);
   assert.ok(!JSON.stringify(identity).includes(ip));assert.ok(!JSON.stringify(identity).includes('forged'));
  });
  await t.test('same IP has stable HMAC key and a distinct valid IP has a distinct key',async()=>{
   reset();for(const value of [ip,ip,'203.0.113.18'])await f.request('/api/auth/session',{headers:{'cf-connecting-ip':value}});
   const keys=f.hits.map(h=>decode(h).clientKey);assert.equal(keys[0],keys[1]);assert.notEqual(keys[0],keys[2]);assert.equal(keys[2],hmac('client-ip\n203.0.113.18'));
  });
  await t.test('equivalent IPv6 representations use the same normalized rate key',async()=>{
   reset();for(const value of ['2001:db8::1','2001:0DB8:0000:0000:0000:0000:0000:0001'])assert.equal((await f.request('/api/auth/session',{headers:{'cf-connecting-ip':value}})).status,200);
   assert.equal(decode(f.hits[0]).clientKey,decode(f.hits[1]).clientKey);
  });
  await t.test('missing trusted IP fails closed after the runtime edge header is removed',async()=>{
   const missing=await fixture({},true);try{const response=await missing.request('/api/auth/session');assert.equal(response.status,503);assert.equal((await response.json()).code,'EDGE_IDENTITY_UNAVAILABLE');assert.equal(missing.hits.length,0);}finally{await missing.close();}
  });
  await t.test('malformed trusted IP fails closed without upstream calls',async()=>{
   reset();for(const value of ['abc', '999.999.999.999', '1.2.3', ':::', '2001:db8::1%eth0', '198.51.100.24, 203.0.113.2', 'not-an-ip']){
    const response=await f.request('/api/auth/session',{headers:{'cf-connecting-ip':value}});assert.equal(response.status,503,'invalid IP must fail closed: '+value);assert.equal((await response.json()).code,'EDGE_IDENTITY_UNAVAILABLE');
   }
   assert.equal(f.hits.length,0);
  });
  await t.test('valid network changes keep the same session token while deriving a new preauth key',async()=>{
   reset();await f.business('status');await f.business('status',{headers:{'cf-connecting-ip':'203.0.113.18'}});
   assert.equal(decode(f.hits[0]).sessionToken,decode(f.hits[1]).sessionToken);assert.notEqual(decode(f.hits[0]).clientKey,decode(f.hits[1]).clientKey);
  });
  await t.test('cross-origin and missing-origin mutations are rejected without upstream calls',async()=>{
   reset();for(const originValue of ['','https://evil.example.test','http://trial.example.test'])assert.equal((await f.post('/api/auth/session',{username:'trial_user',password:'example-password'},{origin:originValue})).status,403);
   assert.equal((await f.request('/api/auth/session',{method:'OPTIONS'})).status,404);assert.equal(f.hits.length,0);
  });
  await t.test('wrong content types and oversized declared or streamed bodies are rejected',async()=>{
   reset();for(const type of ['text/plain','not-application/json','application/x-www-form-urlencoded'])assert.equal((await f.post('/api/auth/session','{}',{'content-type':type})).status,415);
   assert.equal((await f.post('/api/auth/session','x'.repeat(65537))).status,413);
   const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32768));controller.enqueue(new Uint8Array(32769));controller.close();}});
   const response=await f.request('/api/auth/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:stream,duplex:'half'});assert.equal(response.status,413);assert.equal(f.hits.length,0);
  });
  await t.test('path depth encoded delimiters and unknown auth routes are refused',async()=>{
   reset();for(const path of ['/api/workspace/','/api/workspace/a/b/c/d/e/f','/api/workspace/workspaces/%2f/secrets','/api/auth/forgot-password','/api/auth/testing'])assert.equal((await f.request(path,{headers:{cookie:cookie(token)}})).status,404);
   for(const path of ['/api/auth/logout','/api/auth/register'])assert.equal((await f.request(path)).status,404);assert.equal(f.hits.length,0);
  });
  await t.test('successful login sets only HttpOnly host session cookie and strips token from JSON',async()=>{
   reset();f.reply=()=>Response.json({authenticated:true,account:{id:'account:test',username:'trial_user'},sessionToken:token});
   const response=await f.post('/api/auth/session',{username:'trial_user',password:'example-password'});assert.equal(response.status,200);
   const value=response.headers.get('set-cookie');for(const flag of [cookie(token),'Path=/','Secure','HttpOnly','SameSite=Lax','Max-Age=604800'])assert.ok(value.includes(flag));assert.ok(!value.includes('Domain='));
   const body=await response.text();assert.ok(!body.includes(token));assert.equal(JSON.parse(body).registrationEnabled,false);assert.match(response.headers.get('cache-control'),/no-store/);
  });
  await t.test('failed login strips any upstream token and never creates a cookie',async()=>{
   reset();f.reply=()=>Response.json({code:'INVALID_CREDENTIALS',sessionToken:token},{status:401});
   const response=await f.post('/api/auth/session',{username:'trial_user',password:'wrong-password'});assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null);assert.ok(!(await response.text()).includes(token));
  });
  await t.test('malformed success token fails closed and does not create a cookie',async()=>{
   reset();for(const value of [undefined,'short','x'.repeat(44)]){
    f.reply=()=>Response.json({authenticated:true,sessionToken:value});const response=await f.post('/api/auth/session',{});assert.equal(response.status,503);assert.equal(response.headers.get('set-cookie'),null);
   }
  });
  await t.test('logout revokes upstream first then expires only the business cookie',async()=>{
   reset();f.reply=()=>Response.json({loggedOut:true});const response=await f.post('/api/auth/logout',{}, {cookie:cookie(token)});
   assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/__Host-yuelian_session=;.*Max-Age=0/);assert.equal(response.headers.get('location'),null);assert.equal(decode(f.hits[0]).sessionToken,token);assert.ok(f.hits[0].url.endsWith('/v1/auth/logout'));
  });
  await t.test('uncertain logout and late unauthenticated reads cannot clear a newer cookie',async()=>{
   reset();f.reply=()=>new Response('gateway failed',{status:503});const failed=await f.post('/api/auth/logout',{});assert.equal(failed.status,503);assert.equal(failed.headers.get('set-cookie'),null);
   f.reply=()=>Response.json({authenticated:false,account:null});const session=await f.request('/api/auth/session');assert.equal(session.headers.get('set-cookie'),null);
   f.reply=()=>Response.json({code:'APP_SIGN_IN_REQUIRED'},{status:401});assert.equal((await f.business('status')).headers.get('set-cookie'),null);
  });
  await t.test('backend redirects never forward secrets to their Location and are not retried',async()=>{
   for(const status of [301,302,303,307,308]){
    reset();f.reply=()=>new Response(null,{status,headers:{location:'https://untrusted.example.test/collect'}});
    const response=await f.business('status');assert.equal(response.status,503);assert.equal(f.hits.length,1);assert.ok(!f.hits.some(h=>h.url.includes('untrusted')));
    const data=await response.text();assert.ok(!data.includes(secret));assert.ok(!data.includes(token));assert.ok(!data.includes(ip));
   }
  });
  await t.test('non-JSON malformed JSON and transport failures are traceable and sanitized',async()=>{
   for(const reply of [()=>new Response('<html>failure</html>',{status:502}),()=>new Response('bad-json',{headers:{'content-type':'application/json'}}),()=>{throw Error('test transport failure');}]){
    reset();f.reply=reply;const response=await f.business('status');assert.equal(response.status,503);const data=await response.json();assert.equal(data.code,'BACKEND_UNAVAILABLE');assert.ok(data.requestId);assert.equal(f.hits.length,1);assert.ok(!data.error.includes('test transport failure'));
   }
  });
  await t.test('upstream authorization conflict rate and outage status remain intact',async()=>{
   for(const status of [400,401,403,404,409,429,503]){
    reset();f.reply=()=>Response.json({code:'TEST_UPSTREAM',error:'测试错误'},{status});const response=await f.business('status');assert.equal(response.status,status);assert.equal((await response.json()).code,'TEST_UPSTREAM');assert.equal(f.hits.length,1);
   }
  });
  await t.test('failed business writes remain uncertain; generation failure states no business execution',async()=>{
   reset();f.reply=()=>new Response('gateway unavailable',{status:503});
   const write=await f.post('/api/workspace/workspaces/11111111-1111-4111-a111-111111111111/plans',{}, {cookie:cookie(token)});assert.equal(write.status,503);assert.match((await write.json()).error,/尚未确认/);assert.equal(f.hits.length,1);
   f.hits=[];const generate=await f.post('/api/workspace/workspaces/11111111-1111-4111-a111-111111111111/plans/generate',{}, {cookie:cookie(token)});assert.equal(generate.status,503);const data=await generate.json();assert.match(data.error,/尚未修改/);assert.ok(!data.error.includes('尚未确认'));assert.equal(f.hits.length,1);
  });
 }finally{await f.close();}
});

test('private backend binding preserves authentication and fails without public retries',async t=>{
 const f=await fixture({YUELIAN_BACKEND_URL:'http://127.0.0.1:18797'},false,true);
 const reset=()=>{f.hits=[];f.reply=()=>Response.json({ok:true});};
 try{
  await t.test('signed login uses only the configured private service and sets the protected cookie',async()=>{
   reset();f.reply=()=>Response.json({authenticated:true,sessionToken:token});
   const body=JSON.stringify({username:'trial_user',password:'example-password'}),response=await f.post('/api/auth/session',body);
   assert.equal(response.status,200);assert.equal(f.hits.length,1);const hit=f.hits[0];
   assert.equal(hit.transport,'vpc');assert.equal(hit.url,'http://127.0.0.1:18797/v1/auth/session');assert.equal(hit.body,body);
   const canonical=[hit.method,'/v1/auth/session',hit.headers.get('x-yuelian-time'),hit.headers.get('x-yuelian-nonce'),hit.headers.get('x-yuelian-identity'),hash(body)].join('\n');
   assert.equal(hit.headers.get('x-yuelian-signature'),hmac(canonical));assert.equal(decode(hit).id,'standalone:cloudflare-trial');
   assert.match(response.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Lax/);assert.ok(!(await response.text()).includes(token));
  });
  await t.test('binding does not allow anonymous business access or registration',async()=>{
   reset();assert.equal((await f.request('/api/workspace/workspaces')).status,401);
   assert.equal((await f.post('/api/auth/register',{})).status,403);assert.equal(f.hits.length,0);
  });
  await t.test('private writes retain identity body and method without caller identity headers',async()=>{
   reset();const response=await f.business('workspaces/a/plans/b/commit',{method:'POST',headers:{origin,'content-type':'application/json','x-user-id':'other-user','x-forwarded-for':'198.51.100.99'},body:'{"confirm":true}'});
   assert.equal(response.status,200);assert.equal(f.hits.length,1);const hit=f.hits[0];
   assert.equal(hit.transport,'vpc');assert.equal(hit.method,'POST');assert.equal(hit.body,'{"confirm":true}');assert.equal(decode(hit).sessionToken,token);
   assert.equal(hit.headers.get('x-user-id'),null);assert.equal(hit.headers.get('x-forwarded-for'),null);
  });
  await t.test('private transport failure never retries a possibly accepted write on the public network',async()=>{
   reset();f.reply=()=>{throw Error('private connection lost');};
   const response=await f.post('/api/workspace/workspaces/a/plans',{}, {cookie:cookie(token)});
   assert.equal(response.status,503);assert.match((await response.json()).error,/尚未确认/);
   assert.equal(f.hits.length,1);assert.equal(f.hits[0].transport,'vpc');
  });
  await t.test('redirects never send credentials outside the bound private service',async()=>{
   reset();f.reply=()=>new Response(null,{status:307,headers:{location:'https://untrusted.example.test/collect'}});
   assert.equal((await f.business('status')).status,503);assert.equal(f.hits.length,1);assert.equal(f.hits[0].transport,'vpc');
  });
  await t.test('upstream authorization failures are preserved by the private transport',async()=>{
   for(const status of [401,403,404,409,429]){reset();f.reply=()=>Response.json({code:'AUTHORIZATION_CHECK'},{status});const response=await f.business('status');assert.equal(response.status,status);assert.equal(f.hits.length,1);}
  });
  await t.test('private logout still revokes the server session before expiring the cookie',async()=>{
   reset();f.reply=()=>Response.json({loggedOut:true});const response=await f.post('/api/auth/logout',{}, {cookie:cookie(token)});
   assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);assert.equal(f.hits.length,1);assert.equal(decode(f.hits[0]).sessionToken,token);
  });
 }finally{await f.close();}
});

test('trial Worker missing configuration and insecure backend fail closed',async t=>{
 for(const [label,bindings] of [['missing secret',{YUELIAN_STANDALONE_BRIDGE_SECRET:''}],['short secret',{YUELIAN_STANDALONE_BRIDGE_SECRET:'short'}],['missing URL',{YUELIAN_BACKEND_URL:''}],['insecure URL',{YUELIAN_BACKEND_URL:'http://backend.example.test'}]])await t.test(label,async()=>{
  const f=await fixture(bindings);try{const response=await f.request('/api/auth/session');assert.equal(response.status,503);assert.equal(f.hits.length,0);assert.equal(response.headers.get('set-cookie'),null);}finally{await f.close();}
 });
});
