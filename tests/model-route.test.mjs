import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {z} from 'zod';
import {HttpError,uuid} from '../server/src/policy.mjs';
import {modelSettings,createModelRunner} from '../server/src/model.mjs';

// Evaluate only the actual route function and selection declaration. Never import
// the server entry (it asserts a DB role and listens at module top level).
const source=readFileSync(new URL('../server/src/server.mjs',import.meta.url),'utf8');
const routeSource=source.slice(source.indexOf('async function route('),source.indexOf('\nawait assertRuntimeRole();'));
assert.ok(routeSource.startsWith('async function route(')&&routeSource.endsWith('\n}'));
const identity={id:'test-account',name:'测试',username:'unit-test',registrationRole:'coach'};
function loadRoute(){
 let dbCalls=0;
 const context={z,uuid,HttpError,modelSettings,runModel:createModelRunner(),enabled:true,today:()=> '2026-11-15',authTestingStatus:()=>null,capabilities:[],transaction:async()=>{dbCalls++;throw Error('unexpected database boundary');},modelRates:new Map()};
 const route=vm.runInNewContext(source.match(/^const selection=.*$/m)[0]+'\n'+routeSource+'\nroute;',context);
 return {route,dbCalls:()=>dbCalls};
}
test('actual status route projects only selected model label and configured metadata',async()=>{
 const provider=process.env.YUELIAN_MODEL_PROVIDER,key=process.env.DEEPSEEK_API_KEY;
 try{
  for(const [value,configured] of [['strata',true],['deepseek',false]]){
   process.env.YUELIAN_MODEL_PROVIDER=value;delete process.env.DEEPSEEK_API_KEY;
   const {route,dbCalls}=loadRoute(),status=await route('GET','/v1/status',{},identity);
   assert.equal(status.model,modelSettings().runtime.config.modelLabel);assert.equal(status.configured,configured);assert.equal(status.backend,'postgresql');assert.equal(status.mode,'trial');assert.equal(dbCalls(),0);
   assert.equal('key' in status,false);assert.equal('runtime' in status,false);assert.equal('endpoint' in status,false);
  }
 }finally{for(const [name,value] of [['YUELIAN_MODEL_PROVIDER',provider],['DEEPSEEK_API_KEY',key]])if(value===undefined)delete process.env[name];else process.env[name]=value;}
});
test('actual generation route rejects browser provider and URL fields before database or inference',async()=>{
 const {route,dbCalls}=loadRoute();
 for(const extra of [{provider:'strata'},{endpoint:'http://attacker.invalid'},{runtime:{endpoint:'http://attacker.invalid'}},{selection:{provider:'strata'}}]){
  await assert.rejects(()=>route('POST','/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/plans/generate',{text:'给小林约课',...extra},identity),error=>error.name==='ZodError');
 }
 assert.equal(dbCalls(),0);
});
test('actual route wires the one process guard and retains the original post-generation transaction',()=>{
 assert.match(source,/const runModel=createModelRunner\(\);/);
 assert.match(routeSource,/const response=await runModel\(snapshot,usage,generateResponse\);\s+return transaction\(identity,w,\(c,member\)=>saveGeneration\(c,member,identity,w,input,snapshot,response\)\);/);
});
