import {request} from 'node:http';

// Node fetch normalizes Host. Real HTTP requests are required to model Vercel's
// canonical/unique HTTPS authority while listening only on an ephemeral loopback.
export function ingressFetch(url,init={},origin){
 return new Promise((resolve,reject)=>{
  const req=request(url,{agent:false,method:init.method||'GET',headers:{host:new URL(origin).host,...init.headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));
   res.on('end',()=>resolve(new Response(init.method==='HEAD'?null:Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
  });req.on('error',reject);req.end(init.body);
 });
}
