const $=s=>document.querySelector(s),form=$('#login-form');
let mode='login',busy=false,authAttempt=0,registrationAllowed=true;
function notice(message){const el=$('#login-error');el.textContent=message;el.hidden=!message;if(message)el.focus();}
function lock(value){busy=value;form.querySelectorAll('button,input').forEach(el=>{el.disabled=value||el.closest('#registration-fields')&&mode!=='register';});document.querySelectorAll('[data-mode],[data-persona]').forEach(el=>el.disabled=value);}
async function auth(path,method='GET',body){
 const response=await fetch('/api/auth/'+path,{method,cache:'no-store',credentials:'same-origin',headers:method==='GET'?{}:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});
 const value=await response.json();if(!response.ok)throw Error(value.error||'暂时无法登录，请重试。');return value;
}
async function changeAccount(endpoint,body){authAttempt++;const send=()=>auth(endpoint,'POST',body);return navigator.locks?navigator.locks.request('yuelian-account-change',send):send();}
function enter(){try{sessionStorage.removeItem('yuelian_logout_pending');}catch{}try{new BroadcastChannel('yuelian-auth').postMessage({type:'changed'});}catch{}location.replace('/');}
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{
 if(busy||button.dataset.mode==='register'&&!registrationAllowed)return;mode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
 $('#registration-fields').hidden=mode!=='register';$('#registration-fields').querySelectorAll('input').forEach(el=>el.disabled=mode!=='register');$('#name').required=mode==='register';$('#password').autocomplete=mode==='register'?'new-password':'current-password';$('.login-submit').textContent=mode==='register'?'创建约练账号':'登录约练';notice('');
}));
form.addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;const data=new FormData(form),body={username:String(data.get('username')||'').trim(),password:String(data.get('password')||'')};if(mode==='register')Object.assign(body,{name:String(data.get('name')||'').trim(),role:data.get('role')});
 lock(true);notice('');try{await changeAccount(mode==='register'?'register':'session',body);form.reset();enter();}catch(error){notice(error.name==='TimeoutError'?'登录服务响应较慢，请重试。':error.message||'网络暂不可用，请重试。');}finally{lock(false);}
});
async function initialize(){
 let exiting=false;try{exiting=sessionStorage.getItem('yuelian_logout_pending')==='1';}catch{}
 if(exiting){
  lock(true);try{await changeAccount('logout',{});sessionStorage.removeItem('yuelian_logout_pending');}catch(error){notice('上次退出结果尚未确认。请刷新重试，或使用用户名和密码重新登录。');return;}finally{lock(false);}
 }
 const initial=authAttempt;
 try{
  const result=await auth('session');if(initial!==authAttempt)return;
  if(result.registrationEnabled===false){registrationAllowed=false;document.querySelectorAll('[data-mode="register"]').forEach(el=>el.hidden=true);if(mode==='register')document.querySelector('[data-mode="login"]')?.click();}
  if(result.authenticated){const link=document.createElement('a');link.href='/';link.textContent=`继续使用 ${result.account.name}（${result.account.username}）`;$('#account-status').replaceChildren(link);}
  if(result.testing?.canLogin&&$('#test-accounts')){
   $('#test-accounts').hidden=false;
   for(const persona of result.testing.personas){
    const button=document.createElement('button');button.type='button';button.className='btn';button.dataset.persona=persona.key;button.textContent=persona.name;button.title=persona.description||'';
    button.addEventListener('click',async()=>{if(busy)return;lock(true);notice('');try{await changeAccount('session',{testPersona:persona.key});enter();}catch(error){notice(error.message);}finally{lock(false);}});$('#test-options').append(button);
   }
  }
 }catch(error){if(initial===authAttempt)notice(error.message||'暂时无法连接约练，请刷新重试。');}
}
await initialize();
