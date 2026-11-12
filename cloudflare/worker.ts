// Independent trial entrypoint. The Sites deployment retains its own gateway.
// This channel represents a deployment audience, never a business user.
export interface TrialEnvironment {
 ASSETS: {fetch(request:Request):Promise<Response>};
 YUELIAN_BACKEND_URL: string;
 YUELIAN_STANDALONE_BRIDGE_SECRET: string;
 YUELIAN_BACKEND?: {fetch(request:Request):Promise<Response>};
}
const encoder=new TextEncoder();
const cookieName='__Host-yuelian_session',tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const noStore={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','X-Robots-Tag':'noindex, nofollow'};
const hex=(value:ArrayBuffer)=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
const digest=async(value:string)=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:noStore});
function normalizedClientIp(value:string|null){
 if(!value||value.length>64||!(/^[0-9a-fA-F:.]+$/).test(value))return null;
 if(!value.includes(':')){
  const parts=value.split('.');if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))return null;
  return parts.map(Number).join('.');
 }
 try{return new URL('http://['+value+']/').hostname.slice(1,-1).toLowerCase();}catch{return null;}
}
function readSession(request:Request){
 const found=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='));
 if(found.length!==1)return undefined;
 const token=found[0].slice(cookieName.length+1);return tokenPattern.test(token)?token:undefined;
}
async function proxy(request:Request,env:TrialEnvironment,path:string[],auth:boolean){
 if(path.length<1||path.length>5||path.some(p=>!/^[-a-z0-9]+$/.test(p)))return json({error:'无法访问该资料。'},404);
 if(auth){
  if(path.length!==2||!['session','logout','register'].includes(path[1])||!['GET','POST'].includes(request.method)||request.method==='GET'&&path[1]!=='session')return json({error:'无法访问该资料。'},404);
  if(path[1]==='register')return json({code:'REGISTRATION_DISABLED',error:'当前为邀请试用，请联系管理员领取账号。'},403);
 }else if(path[0]==='auth'||path[0]==='testing')return json({error:'无法访问该资料。'},404);
 if(!['GET','POST','PATCH','DELETE'].includes(request.method))return json({error:'不支持此操作。'},405);
 if(request.method!=='GET'&&request.headers.get('origin')!==new URL(request.url).origin)return json({error:'请从约练页面提交。'},403);
 if(request.method!=='GET'&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return json({error:'请提交 JSON。'},415);
 const secret=env.YUELIAN_STANDALONE_BRIDGE_SECRET;
 if(!env.YUELIAN_BACKEND_URL||!secret||secret.length<43)return json({code:'BACKEND_NOT_CONFIGURED',error:'试用服务尚未连接。'},503);
 // Cloudflare supplies CF-Connecting-IP at this public edge. Never use a
 // caller's X-Forwarded-For, Sites identity, role or user-id header.
 const ip=normalizedClientIp(request.headers.get('cf-connecting-ip'));
 if(!ip)return json({code:'EDGE_IDENTITY_UNAVAILABLE',error:'暂时无法验证访问来源，请稍后再试。'},503);
 const sessionToken=readSession(request);
 if(!auth&&!sessionToken)return json({code:'APP_SIGN_IN_REQUIRED',error:'请登录约练账号。'},401);
 if(Number(request.headers.get('content-length')||0)>65536)return json({error:'请求过大。'},413);
 let body='';const reader=request.body?.getReader();
 if(reader){const decoder=new TextDecoder();let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();return json({error:'请求过大。'},413);}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sign=async(value:string)=>hex(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));
 const identity={id:'standalone:cloudflare-trial',name:'约练访客',emailHash:await digest('standalone:cloudflare-trial'),clientKey:await sign('client-ip\n'+ip),...(sessionToken?{sessionToken}:{})};
 let bytes='';for(const b of encoder.encode(JSON.stringify(identity)))bytes+=String.fromCharCode(b);
 const encoded=btoa(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const stamp=String(Date.now()),nonce=crypto.randomUUID(),backendPath='/v1/'+path.join('/');
 const signature=await sign([request.method,backendPath,stamp,nonce,encoded,await digest(body)].join('\n'));
 try{
  const url=new URL(env.YUELIAN_BACKEND_URL.replace(/\/$/,'')+backendPath);
  // HTTP is allowed only inside the configured VPC service. The encrypted
  // tunnel terminates on this Mac; its service fixes the destination port.
  // Never retry a failed private request through the former public gateway:
  // a write may have reached the backend even when its response was lost.
  if(url.protocol!=='https:'&&!(env.YUELIAN_BACKEND&&url.protocol==='http:'))throw Error('HTTPS required');
  const upstreamRequest=new Request(url,{method:request.method,headers:{'Content-Type':'application/json','X-Yuelian-Channel':'standalone','X-Yuelian-Time':stamp,'X-Yuelian-Nonce':nonce,'X-Yuelian-Identity':encoded,'X-Yuelian-Signature':signature},...(body?{body}:{}),redirect:'manual',signal:AbortSignal.timeout(60000)});
  const response=env.YUELIAN_BACKEND?await env.YUELIAN_BACKEND.fetch(upstreamRequest):await fetch(upstreamRequest);
  if(response.status>=300&&response.status<400||!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw Error('Unexpected upstream');}
  const data=await response.json() as Record<string,unknown>,headers=new Headers(noStore);
  if(auth){
   const token=data.sessionToken;delete data.sessionToken;
   data.registrationEnabled=false;
   if(response.ok&&request.method==='POST'&&path[1]==='session'){
    if(typeof token!=='string'||!tokenPattern.test(token))throw Error('Invalid session response');
    headers.set('Set-Cookie',`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`);
   }
   if(response.ok&&path[1]==='logout')headers.set('Set-Cookie',`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  return Response.json(data,{status:response.status,headers});
 }catch{
  console.error(JSON.stringify({event:'trial_bridge_unavailable',requestId:nonce}));
  const message=auth?'暂时无法连接约练账号服务，请重试。':request.method==='GET'?'暂时无法连接业务后台，请稍后重新连接。':path.at(-1)==='generate'?'暂时无法生成操作，请重试。业务资料尚未修改。':'连接暂时中断，提交结果尚未确认。恢复后请核对原操作。';
  return json({code:'BACKEND_UNAVAILABLE',error:message,requestId:nonce},503);
 }
}
export default {
 async fetch(request:Request,env:TrialEnvironment):Promise<Response>{
  const url=new URL(request.url),path=url.pathname;
  if(path.startsWith('/api/auth/'))return proxy(request,env,['auth',...path.slice(10).split('/')],true);
  if(path.startsWith('/api/workspace/'))return proxy(request,env,path.slice(15).split('/'),false);
  if(path==='/api/assistant')return json({code:'WORKSPACE_REQUIRED',error:'请通过约练中的业务入口操作。'},410);
  if(path.startsWith('/api/')||/^\/(?:signin-with-chatgpt|signout-with-chatgpt|callback)(?:\/|$)/.test(path))return json({error:'无法访问该资料。'},404);
  if(!['GET','HEAD'].includes(request.method))return json({error:'不支持此操作。'},405);
  if(path==='/'&&!readSession(request))return new Response(null,{status:302,headers:{...noStore,Location:'/login'}});
  if(path==='/robots.txt')return new Response('User-agent: *\nDisallow: /\n',{headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
  if(path==='/login')url.pathname='/login.html';else if(path==='/')url.pathname='/index.html';
  const response=await env.ASSETS.fetch(new Request(url,request));
  const headers=new Headers(response.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');headers.set('Referrer-Policy','no-referrer');headers.set('X-Robots-Tag','noindex, nofollow');
  headers.set('Cache-Control',path==='/login'||path==='/'?'private, no-store':'public, max-age=0, must-revalidate');
  return new Response(response.body,{status:response.status,headers});
 }
};
