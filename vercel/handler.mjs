import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {isIP} from 'node:net';
import worker from './worker.mjs';

const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',woff2:'font/woff2',txt:'text/plain; charset=utf-8'};
const unavailable=()=>Response.json({code:'BACKEND_NOT_CONFIGURED',error:'试用服务尚未连接。'},{status:503,headers:{'Cache-Control':'private, no-store'}});

// This file is packaged beside assets/ and worker.mjs, never the source tree.
export async function assetFetch(request){
 const path=new URL(request.url).pathname;
 const manifest=JSON.parse(await readFile(new URL('./assets.json',import.meta.url),'utf8'));
 if(!Object.hasOwn(manifest,path))return new Response('Not Found',{status:404});
 const bytes=await readFile(new URL('./assets/'+manifest[path],import.meta.url));
 return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':types[path.split('.').at(-1)]||'application/octet-stream'}});
}

function requestOrigins(env){
 const canonical=new URL(env.YUELIAN_PUBLIC_ORIGIN);
 if(canonical.protocol!=='https:'||canonical.origin!==env.YUELIAN_PUBLIC_ORIGIN||canonical.username||canonical.password)throw Error('Invalid canonical origin');
 // VERCEL_URL is platform runtime configuration, never a client header or a
 // wildcard grant to other deployments. Missing platform metadata fails closed.
 if(env.VERCEL!=='1'||!/^([a-z0-9]+(?:-[a-z0-9]+)*\.)+vercel\.app$/.test(env.VERCEL_URL||''))throw Error('Missing deployment origin');
 return new Set([canonical.origin,'https://'+env.VERCEL_URL]);
}

export async function handleRequest(request,env,{assets=assetFetch}={}){
 let origin,backend,allowed;
 try{
  allowed=requestOrigins(env);
  origin=new URL(env.YUELIAN_PUBLIC_ORIGIN);backend=new URL(env.YUELIAN_BACKEND_URL);
  // Worker signs /v1/...; the backend authenticates the exact incoming req.url.
  // A URL prefix would change that path without changing the signature.
  if(origin.protocol!=='https:'||origin.origin!==env.YUELIAN_PUBLIC_ORIGIN||backend.protocol!=='https:'||backend.pathname!=='/'||backend.username||backend.password||backend.search||backend.hash)throw Error('Invalid configuration');
 }catch{return unavailable();}
 // Only direct Vercel ingress is supported. VERCEL is a platform environment
 // variable, not a request header. Never fall back to caller forwarding fields.
 if(env.VERCEL!=='1')return unavailable();
 const url=new URL(request.url);
 if(!allowed.has(url.origin))return new Response(null,{status:403,headers:{'Cache-Control':'no-store'}});
 const headers=new Headers(request.headers),ip=headers.get('x-vercel-forwarded-for');
 for(const key of [...headers.keys()])if(key==='cf-connecting-ip'||key==='x-real-ip'||key.startsWith('x-forwarded-')||key.startsWith('oai-')||key.startsWith('x-yuelian-')||key==='x-user-id'||key==='x-role')headers.delete(key);
 // The unchanged Worker consumes this internal normalized field. Its audience
 // remains the backend's existing standalone audience, never a business user.
 if(ip&&isIP(ip))headers.set('cf-connecting-ip',ip);
 return worker.fetch(new Request(request,{headers}),{
  ASSETS:{fetch:assets},YUELIAN_BACKEND_URL:backend.href.replace(/\/$/,''),
  YUELIAN_STANDALONE_BRIDGE_SECRET:env.YUELIAN_STANDALONE_BRIDGE_SECRET,
 });
}

export default async function handler(req,res){
 try{
  // Use configured origins, not untrusted Host/X-Forwarded-Host, for CSRF checks.
  if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))throw Error('Invalid target');
  const allowed=requestOrigins(process.env),host=req.headers.host;
  const origin=[...allowed].find(value=>new URL(value).host===host);
  if(!origin){res.statusCode=403;res.setHeader('Cache-Control','no-store');res.end();return;}
  const url=new URL(req.url,origin);
  const init={method:req.method,headers:req.headers};
  if(!['GET','HEAD'].includes(req.method)){init.body=Readable.toWeb(req);init.duplex='half';}
  const response=await handleRequest(new Request(url,init),process.env);
  res.statusCode=response.status;
  for(const [key,value] of response.headers)res.setHeader(key,value);
  if(req.method==='HEAD'||!response.body)res.end();
  else for await(const chunk of response.body){if(res.destroyed)break;res.write(chunk);} 
  res.end();
 }catch{
  if(!res.headersSent){res.statusCode=503;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');}
  res.end(JSON.stringify({code:'BACKEND_UNAVAILABLE',error:'暂时无法连接约练，请稍后核对操作状态。'}));
 }
}
