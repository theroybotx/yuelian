import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {stripTypeScriptTypes} from 'node:module';
import {createTransportAuthenticator} from '../server/src/transport-auth.mjs';
import handler from '../.vercel/output/functions/gateway.func/index.mjs';
import {ingressFetch} from './vercel-http-fixture.mjs';

const root=new URL('../',import.meta.url),output=new URL('.vercel/output/',root);
const bytes=async file=>readFile(new URL(file,root));
const sha=value=>createHash('sha256').update(value).digest('hex');

test('actual deployment files match current source and recorded artifact hashes',async()=>{
 const manifest=JSON.parse(await readFile(new URL('build-manifest.json',output),'utf8'));
 assert.equal(manifest.sourceCommit,execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim());
 assert.equal(await readFile(new URL('functions/gateway.func/index.mjs',output),'utf8'),await readFile(new URL('vercel/handler.mjs',root),'utf8'));
 assert.equal(await readFile(new URL('functions/gateway.func/worker.mjs',output),'utf8'),stripTypeScriptTypes(await readFile(new URL('cloudflare/worker.ts',root),'utf8')));
 for(const [file,digest] of Object.entries(manifest.files))assert.equal(sha(await readFile(new URL(file,output))),digest,file);
 assert.deepEqual((await readdir(new URL('functions/gateway.func/',output))).sort(),['.vc-config.json','assets','assets.json','index.mjs','worker.mjs']);
 const assets=JSON.parse(await readFile(new URL('functions/gateway.func/assets.json',output),'utf8'));
 for(const [requestPath,file] of Object.entries(assets)){
  assert.equal(requestPath,'/'+file);
  const source=file==='index.html'?'frontend/index.html':file==='login.html'?'cloudflare/login.html':'public/'+file;
  assert.equal(sha(await readFile(new URL('functions/gateway.func/assets/'+file,output))),sha(await bytes(source)),source);
 }
});

test('rebuilt Node deployment serves and restarts with exact HMAC and Cookie boundaries',async()=>{
 const env={VERCEL:'1',VERCEL_URL:'packaged-exact.vercel.app',YUELIAN_PUBLIC_ORIGIN:'https://packaged.example',YUELIAN_BACKEND_URL:'https://backend.invalid/base',YUELIAN_STANDALONE_BRIDGE_SECRET:'synthetic-packaged-secret-'.repeat(3)};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 Object.assign(process.env,env);
 const fetchOriginal=globalThis.fetch;let calls=0,port;
 const localFetch=(url,init={})=>ingressFetch(url,init,env.YUELIAN_PUBLIC_ORIGIN);
 // Intercept only the synthetic backend. Local HTTP still reaches the packaged
 // production entrypoint; no real backend, credentials, DB or model is used.
 globalThis.fetch=async(request,...args)=>{
  if(typeof request==='object'&&new URL(request.url).hostname==='backend.invalid'){
   calls++;
   const raw=await request.text();
   const verify=createTransportAuthenticator({sitesSecret:'different-packaged-sites-secret-'.repeat(3),standaloneSecret:env.YUELIAN_STANDALONE_BRIDGE_SECRET});
   const identity=verify({method:request.method,url:new URL(request.url).pathname,headers:Object.fromEntries(request.headers)},raw);
   assert.equal(new URL(request.url).pathname,'/v1/auth/session');
   assert.equal(identity.id,'standalone:cloudflare-trial');
   assert.equal(identity.sessionToken,undefined);
   return Response.json({authenticated:false},{status:200});
  }
  return fetchOriginal(request,...args);
 };
 try{
  for(let round=0;round<2;round++){
   const server=createServer(handler);
   server.listen(port||0,'127.0.0.1');await once(server,'listening');port=server.address().port;
   const base='http://127.0.0.1:'+port;
   try{
    // Prefix configuration must be rejected by the rebuilt backend repair.
    const invalid=await localFetch(base+'/api/auth/session');assert.equal(invalid.status,503);assert.equal(calls,0);
    process.env.YUELIAN_BACKEND_URL='https://backend.invalid';
    const login=await localFetch(base+'/login');assert.equal(login.status,200);assert.match(await login.text(),/登录约练/);
    const head=await localFetch(base+'/app.js',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    const forbidden=await localFetch(base+'/api/auth/session',{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'});assert.equal(forbidden.status,403);
    const before=calls;
    const session=await localFetch(base+'/api/auth/session',{headers:{'x-vercel-forwarded-for':'198.51.100.8'}});assert.equal(session.status,200);assert.equal((await session.json()).authenticated,false);assert.equal(calls,before+1);
    assert.equal(session.headers.get('set-cookie'),null);
   }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
   // Reuse the exact released socket on the next round, not a different port.
   process.env.YUELIAN_BACKEND_URL=env.YUELIAN_BACKEND_URL;calls=0;
  }
 }finally{
  globalThis.fetch=fetchOriginal;
  for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
