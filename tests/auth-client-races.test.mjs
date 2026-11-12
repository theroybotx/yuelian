import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const clientSource=readFileSync(new URL('../public/workspace-client.js',import.meta.url),'utf8');
const loginSource=readFileSync(new URL('../public/login.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const storage=(initial={})=>{const values=new Map(Object.entries(initial));return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function sharedLocks(){let previous=Promise.resolve();return {request:(_name,fn)=>{const next=previous.catch(()=>{}).then(fn);previous=next;return next;}};}
async function client(fetch,options={}){
 const redirects=[],messages=[];let channel;const store=options.store||storage();
 const context=vm.createContext({console,URL,Intl,Date,Error,Number,String,JSON,Map,Set,Object,Array,Response,AbortSignal,structuredClone,fetch,sessionStorage:store,navigator:{locks:options.locks},location:{replace:url=>redirects.push(url)},BroadcastChannel:class{constructor(){channel=this;}postMessage(message){messages.push(message);}}});
 const module=new vm.SourceTextModule(clientSource,{context});await module.link(()=>{});await module.evaluate();return {c:module.namespace,redirects,messages,store,get channel(){return channel;}};
}
test('AUTH-05 SEC-20 pending logout survives reload and blocks protected requests',async()=>{
 const store=storage(),first=await client(async()=>{throw Error('lost response');},{store});first.c.session.identity={id:'old'};
 await assert.rejects(first.c.logout());assert.equal(store.getItem('yuelian_logout_pending'),'1');let hits=0;
 const next=await client(async()=>{hits++;return Response.json({});},{store});await assert.rejects(next.c.bootstrap(),{code:'LOGOUT_PENDING'});assert.equal(hits,0);assert.equal(next.c.session.identity,null);
});
test('AUTH-04 AUTH-07 retrying uncertain logout clears the marker only after confirmation',async()=>{
 let okay=false;const h=await client(async()=>Response.json(okay?{loggedOut:true}:{error:'offline'},{status:okay?200:503}));
 await assert.rejects(h.c.logout());assert.equal(h.messages.length,0);assert.equal(h.redirects.length,0);okay=true;
 await h.c.logout();assert.equal(h.store.getItem('yuelian_logout_pending'),null);assert.equal(h.c.session.logoutPending,false);assert.deepEqual(h.redirects,['/login']);assert.equal(h.messages.length,1);
});
test('AUTH-21 SEC-20 logout invalidates an already pending business response',async()=>{
 const read=deferred(),revoke=deferred();const h=await client(url=>url==='/api/auth/logout'?revoke.promise:read.promise);h.c.session.identity={id:'old'};
 const pending=h.c.api('status'),exit=h.c.logout();read.resolve(Response.json({identity:{id:'old'},privateText:'old private value'}));
 await assert.rejects(pending,{code:'CONTEXT_CHANGED'});assert.equal(h.c.session.identity,null);assert.equal(h.c.session.logoutPending,true);revoke.resolve(Response.json({loggedOut:true}));await exit;
});
test('AUTH-20 UI-16 shared Web Lock serializes cookie changing requests across tabs',async()=>{
 const locks=sharedLocks(),revoke=deferred(),events=[];
 const a=await client(async()=>{events.push('logout started');await revoke.promise;events.push('logout complete');return Response.json({loggedOut:true});},{locks});
 const b=await client(async()=>{events.push('login started');return Response.json({authenticated:true});},{locks});
 b.c.session.status={testing:{canSwitch:true,personas:[{key:'zhou'}]}};
 const exiting=a.c.logout(),entering=b.c.selectTestPersona('zhou');await turn();assert.deepEqual(events,['logout started']);
 revoke.resolve();await Promise.all([exiting,entering]);assert.deepEqual(events,['logout started','logout complete','login started']);
});

// Minimal DOM test adapter. The script under test is the real login module;
// this adapter supplies event targets, form values and browser side effects.
async function login(fetch,{store=storage(),values={username:'player',password:'correct-password'},locks}={}){
 const redirects=[],messages=[],nodes=new Map();
 const node=(key,registration=false)=>{const n={key,registration,hidden:false,textContent:'',children:[],listeners:{},dataset:{},classList:{toggle(){}},setAttribute(){},focus(){n.focused=true;},closest(selector){return selector==='#registration-fields'&&registration?nodes.get('#registration-fields'):null;},addEventListener(type,fn){n.listeners[type]=fn;},replaceChildren(...children){n.children=children;},append(child){n.children.push(child);}};let disabled=false;Object.defineProperty(n,'disabled',{get:()=>disabled,set:value=>disabled=Boolean(value)});nodes.set(key,n);return n;};
 for(const key of ['#login-form','#login-error','#registration-fields','#name','#password','#account-status','#test-accounts','#test-options','.login-submit'])node(key,['#name'].includes(key));
 const coach=node('role-coach',true),student=node('role-student',true),username=node('#username'),modeLogin=node('mode-login'),modeRegister=node('mode-register');modeLogin.dataset.mode='login';modeRegister.dataset.mode='register';
 const fields=[username,nodes.get('#password'),nodes.get('#name'),coach,student,nodes.get('.login-submit')];
 const form=nodes.get('#login-form');form.querySelectorAll=()=>fields;form.reset=()=>{form.resetCalled=true;};nodes.get('#registration-fields').querySelectorAll=()=>[nodes.get('#name'),coach,student];
 const document={querySelector:key=>nodes.get(key),querySelectorAll:key=>key==='[data-mode]'?[modeLogin,modeRegister]:[modeLogin,modeRegister,...nodes.get('#test-options').children],createElement:tag=>node(tag+'-'+nodes.size)};
 const context=vm.createContext({console,document,fetch,Response,AbortSignal,Error,String,Boolean,navigator:{locks},sessionStorage:store,FormData:class{get(key){return values[key]??null;}},location:{replace:url=>redirects.push(url)},BroadcastChannel:class{postMessage(message){messages.push(message);}}});
 const module=new vm.SourceTextModule(loginSource,{context});await module.link(()=>{});const evaluated=module.evaluate();await turn();
 return {nodes,store,redirects,messages,evaluated,submit:()=>form.listeners.submit({preventDefault(){}}),register:()=>modeRegister.listeners.click(),values};
}
for(const status of [200,503])test(`AUTH-20 UI-10 initial login GET ${status} cannot overwrite a newer login`,async()=>{
 const initial=deferred(),requests=[];const h=await login((path,options)=>{requests.push({path,method:options.method});return options.method==='GET'?initial.promise:Promise.resolve(Response.json({authenticated:true}));});
 await h.submit();assert.deepEqual(h.redirects,['/']);
 initial.resolve(Response.json(status===200?{authenticated:true,account:{name:'旧账号',username:'old'},testing:{canLogin:true,personas:[{key:'zhou',name:'周教练'}]}}:{error:'迟到的错误'},{status}));await h.evaluated;
 assert.equal(h.nodes.get('#account-status').children.length,0);assert.equal(h.nodes.get('#login-error').textContent,'');assert.equal(h.nodes.get('#test-options').children.length,0);assert.equal(requests.length,2);
});
test('AUTH-05 UI-10 login page confirms pending logout before reading account state',async()=>{
 const revoke=deferred(),requests=[],store=storage({yuelian_logout_pending:'1'});const h=await login((path,options)=>{requests.push(path);return path.endsWith('logout')?revoke.promise:Promise.resolve(Response.json({authenticated:false,testing:{canLogin:false}}));},{store});
 assert.deepEqual(requests,['/api/auth/logout']);assert.equal(h.nodes.get('.login-submit').disabled,true);revoke.resolve(Response.json({loggedOut:true}));await h.evaluated;
 assert.deepEqual(requests,['/api/auth/logout','/api/auth/session']);assert.equal(store.getItem('yuelian_logout_pending'),null);assert.equal(h.nodes.get('#account-status').children.length,0);assert.equal(h.nodes.get('.login-submit').disabled,false);
});
test('AUTH-07 UI-10 uncertain logout does not silently reuse old login; credentials can recover',async()=>{
 const requests=[],store=storage({yuelian_logout_pending:'1'});const h=await login((path,options)=>{requests.push({path,method:options.method});return Promise.resolve(Response.json(path.endsWith('logout')?{error:'offline'}:{authenticated:true},{status:path.endsWith('logout')?503:200}));},{store});await h.evaluated;
 assert.equal(requests.length,1);assert.match(h.nodes.get('#login-error').textContent,/尚未确认/);assert.equal(h.nodes.get('#account-status').children.length,0);assert.equal(store.getItem('yuelian_logout_pending'),'1');
 await h.submit();assert.equal(requests[1].method,'POST');assert.equal(requests[1].path,'/api/auth/session');assert.equal(store.getItem('yuelian_logout_pending'),null);assert.deepEqual(h.redirects,['/']);
});
