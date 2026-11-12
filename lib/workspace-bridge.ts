import {getChatGPTUser} from '../app/chatgpt-auth';
const encode=new TextEncoder();
const hex=(data:ArrayBuffer)=>Array.from(new Uint8Array(data),n=>n.toString(16).padStart(2,'0')).join('');
const sha=async(s:string)=>hex(await crypto.subtle.digest('SHA-256',encode.encode(s)));
const noStore={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const cookieName='__Host-yuelian_session';
const sessionPattern=/^[A-Za-z0-9_-]{43}$/;
const sessionCookie=(token:string)=>`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${token?604800:0}`;
function readSession(request:Request){
 const values=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));
 // Ambiguous cookie values must never select an attacker-controlled session.
 if(values.length!==1)return undefined;
 const value=values[0].slice(cookieName.length+1);return sessionPattern.test(value)?value:undefined;
}
export async function proxyWorkspace(request:Request,path:string[]){
 if(path[0]==='auth'||path[0]==='testing')return Response.json({error:'无法访问该资料。'},{status:404,headers:noStore});
 return proxy(request,path,false);
}
export async function proxyAuth(request:Request,path:string[]){
 const endpoint=path.join('/');
 if(path.length!==1||!(['session','register','logout'].includes(endpoint))||!(['GET','POST'].includes(request.method))||request.method==='GET'&&endpoint!=='session')return Response.json({error:'无法访问该资料。'},{status:404,headers:noStore});
 return proxy(request,['auth',endpoint],true);
}
async function proxy(request:Request,path:string[],auth:boolean){
 const user=await getChatGPTUser();
 if(!user)return Response.json({code:'SIGN_IN_REQUIRED',error:'请先通过此预览网站的访问验证。'},{status:401,headers:noStore});
 if(path.length<1||path.length>5||path.some(p=>!/^[-a-z0-9]+$/.test(p)))return Response.json({error:'无法访问该资料。'},{status:404,headers:noStore});
 const base=process.env.YUELIAN_BACKEND_URL,secret=process.env.YUELIAN_BRIDGE_SECRET;
 if(!base||!secret)return Response.json({code:'BACKEND_NOT_CONFIGURED',error:'约练后台尚未连接。'},{status:503,headers:noStore});
 if(request.method!=='GET'&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请从约练页面提交。'},{status:403,headers:noStore});
 if(request.method!=='GET'&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return Response.json({error:'请提交 JSON。'},{status:415,headers:noStore});
 if(Number(request.headers.get('content-length')||0)>65536)return Response.json({error:'请求过大。'},{status:413,headers:noStore});
 const reader=request.body?.getReader();let body='';
 if(reader){const decoder=new TextDecoder();let length=0;for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>65536){await reader.cancel();return Response.json({error:'请求过大。'},{status:413,headers:noStore});}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}
 const sessionToken=readSession(request);
 const identity={id:user.userId,name:(user.fullName||user.displayName||'约练用户').slice(0,80),emailHash:await sha(user.email.trim().toLowerCase()),...(sessionToken?{sessionToken}:{})};
 const bytes=encode.encode(JSON.stringify(identity));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
 const encoded=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const stamp=String(Date.now()),nonce=crypto.randomUUID(),backendPath='/v1/'+path.join('/');
 const key=await crypto.subtle.importKey('raw',encode.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=hex(await crypto.subtle.sign('HMAC',key,encode.encode([request.method,backendPath,stamp,nonce,encoded,await sha(body)].join('\n'))));
 let stage='configuration',upstreamStatus:number|undefined;
 try{
  const url=new URL(base.replace(/\/$/,'')+backendPath);if(url.protocol!=='https:')throw new Error('HTTPS required');
  stage='fetch';
  // Workers supports manual/follow only. Never forward signed identity on redirects.
  const response=await fetch(url,{method:request.method,headers:{'Content-Type':'application/json','X-Yuelian-Time':stamp,'X-Yuelian-Nonce':nonce,'X-Yuelian-Identity':encoded,'X-Yuelian-Signature':signature},...(body?{body}:{}),redirect:'manual',signal:AbortSignal.timeout(60000)});
  upstreamStatus=response.status;
  stage='redirect';if(response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('Unexpected redirect');}
  stage='content-type';if(!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw new Error('Unexpected upstream');}
  stage='response-body';const data=await response.json() as Record<string,unknown>;
  const headers=new Headers(noStore);
  if(auth){
   // The bearer token crosses only the trusted server bridge, never browser JSON.
   const token=data.sessionToken;delete data.sessionToken;
   if(response.ok&&request.method==='POST'&&path[1]!=='logout'){
    if(typeof token!=='string'||!sessionPattern.test(token))throw new Error('Invalid session response');
    headers.set('Set-Cookie',sessionCookie(token));
   }
   if(response.ok&&path[1]==='logout')headers.set('Set-Cookie',sessionCookie(''));
  }
  return Response.json(data,{status:response.status,headers});
 }catch(error){
  const errorType=error instanceof Error&&['TypeError','TimeoutError','AbortError','Error'].includes(error.name)?error.name:'Other';
  console.error(JSON.stringify({event:'workspace_bridge_failed',requestId:nonce,stage,upstreamStatus,errorType}));
  return Response.json({code:'BACKEND_UNAVAILABLE',error:auth?'暂时无法连接约练账号服务，请重试。':request.method==='GET'?'暂时无法连接业务后台，请稍后重新连接。':path.at(-1)==='generate'&&path.at(-2)==='plans'?'暂时无法生成操作，请稍后重试。没有执行课程或课时等业务修改。':'权限后台暂时不可达，本次结果尚未确认。恢复连接后请查看结果，或重试原草稿。',requestId:nonce},{status:503,headers:noStore});
 }
}
