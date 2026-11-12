import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import handler from '../.vercel/output/functions/gateway.func/index.mjs';

// Exercise real packaged HTTP ingress. Upstream must never be needed for these
// non-JSON probes; the Worker must still enforce exact same-origin mutation.
test('packaged ingress accepts exact platform Preview origin, never arbitrary Host', async()=>{
 const env={VERCEL:'1',VERCEL_URL:'preview-exact.vercel.app',YUELIAN_PUBLIC_ORIGIN:'https://canonical.example',YUELIAN_BACKEND_URL:'https://backend.invalid',YUELIAN_STANDALONE_BRIDGE_SECRET:'synthetic-origin-test-secret-'.repeat(3)};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 Object.assign(process.env,env);
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port+'/api/auth/session';
 const probe=(host,origin,extra={})=>new Promise((resolve,reject)=>{
  const req=httpRequest(url,{method:'POST',headers:{host,origin,'content-type':'text/plain',...extra}},res=>{
   res.resume();res.on('end',()=>resolve({status:res.statusCode}));
  });req.on('error',reject);req.end('{}');
 });
 try{
  assert.equal((await probe(env.VERCEL_URL,'https://'+env.VERCEL_URL)).status,415);
  assert.equal((await probe('canonical.example',env.YUELIAN_PUBLIC_ORIGIN)).status,415);
  assert.equal((await probe(env.VERCEL_URL,env.YUELIAN_PUBLIC_ORIGIN)).status,403);
  assert.equal((await probe('attacker.vercel.app','https://attacker.vercel.app')).status,403);
  assert.equal((await probe('attacker.invalid','https://attacker.invalid',{'x-forwarded-host':env.VERCEL_URL})).status,403);
  assert.equal((await probe('canonical.example:444',env.YUELIAN_PUBLIC_ORIGIN)).status,403);
  delete process.env.VERCEL_URL;
  assert.equal((await probe('canonical.example',env.YUELIAN_PUBLIC_ORIGIN)).status,503);
 }finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
