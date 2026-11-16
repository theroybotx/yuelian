import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Execute the real app script and its real renderComposer/syncIdentity functions.
// Only imports and the one startup call are replaced by an offline host adapter.
// No production label or HTML rendering logic is copied into this fixture.
function appFixture(){
 const original=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.equal((original.match(/^loadWorkspace\(\);$/gm)||[]).length,1);
 const source=original.replace(/^import .*;\n/gm,'').replace(/^loadWorkspace\(\);$/m,'');
 const node={textContent:'',innerHTML:'',open:false,addEventListener(){},close(){},classList:{add(){},remove(){},toggle(){}},style:{}};
 const emptyData=()=>({students:[],venues:[],lessons:[],ledger:[],notes:[],messages:[],studentPractice:[],followups:[],availabilityRules:[],activity:[],settings:{days:[],travel:0}});
 let invalidated;
 const session={ready:false,loading:true,workspace:{id:'synthetic',role:'owner'},identity:null,workspaces:[],status:null};
 const context=vm.createContext({structuredClone,session,TODAY:'2026-11-16',emptyData,
  canAction:()=>false,can:()=>false,document:{querySelector:()=>node,addEventListener(){},body:{style:{},classList:node.classList}},
  window:{addEventListener(){}},setInterval(){},onInvalidated:fn=>{invalidated=fn;}});
 new vm.Script(source+'\n;globalThis.fixture={render:()=>renderComposer(),sync:()=>syncIdentity(),label:()=>aiLabel()};',{filename:'public/app.js'}).runInContext(context);
 return {session,html:()=>context.fixture.render(),sync:()=>context.fixture.sync(),label:()=>context.fixture.label(),invalidate(){session.status=null;session.ready=false;session.identity=null;invalidated();}};
}
const statusHTML=h=>h.html().match(/<span data-ai-status>([\s\S]*?)<\/span>/)[1];

test('FE-01 renders the current Strata model from server status, not a hardcoded provider',()=>{
 const h=appFixture();h.session.status={configured:true,model:'千问 3.8 Flash Next · 本地 Q4'};h.sync();
 assert.equal(statusHTML(h),'千问 3.8 Flash Next · 本地 Q4');
});

test('FE-01 model strings are rendered as escaped text by the real composer',()=>{
 const h=appFixture();h.session.status={configured:true,model:'<img src=x onerror="alert(1)"> & \'local\''};h.sync();
 assert.equal(statusHTML(h),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;local&#39;');
});

for(const [name,model] of [['missing',undefined],['empty',''],['whitespace',' \t\n '],['null',null],['number',42],['boolean',true],['object',{name:'not-a-model'}],['array',['not-a-model']]])test(`FE-01 ${name} model uses a neutral configured label`,()=>{
 const h=appFixture();h.session.status={configured:true,model};h.sync();assert.equal(statusHTML(h),'AI 已配置');
});

test('FE-01 DeepSeek label remains the exact server-provided string',()=>{
 const h=appFixture();h.session.status={configured:true,model:'DeepSeek V4.1 Flash · Medium'};h.sync();assert.equal(statusHTML(h),'DeepSeek V4.1 Flash · Medium');
});

for(const [name,status] of [['absent',null],['missing',{}],['false',{configured:false,model:'OLD'}],['truthy-string',{configured:'true',model:'OLD'}],['truthy-number',{configured:1,model:'OLD'}]])test(`FE-01 ${name} configuration stays pending connection`,()=>{
 const h=appFixture();h.session.status=status;h.sync();assert.equal(statusHTML(h),'AI 待连接');
});

test('FE-01 current identity transitions do not retain the previous model or ready state',()=>{
 const h=appFixture();assert.equal(statusHTML(h),'正在检查 AI 连接');
 h.session.status={configured:true,model:'OLD'};h.sync();assert.equal(statusHTML(h),'OLD');
 h.session.status={configured:false,model:'OLD'};h.sync();assert.equal(statusHTML(h),'AI 待连接');
 h.session.status={configured:true,model:'CURRENT'};h.sync();assert.equal(statusHTML(h),'CURRENT');
 h.invalidate();assert.equal(statusHTML(h),'正在检查 AI 连接');
 h.session.status={configured:true,model:'NEW IDENTITY'};h.sync();assert.equal(statusHTML(h),'NEW IDENTITY');
});

test('FE-01 a stale ready state cannot claim a missing or false current configuration',()=>{
 const h=appFixture();h.session.status={configured:true,model:'OLD'};h.sync();
 h.session.status={configured:false,model:'OLD'};assert.equal(statusHTML(h),'AI 待连接');
 h.session.status=null;assert.equal(statusHTML(h),'AI 待连接');
});
