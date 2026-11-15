import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../server/src/model.mjs';

async function inProvider(provider,run){
 const before=process.env.YUELIAN_MODEL_PROVIDER;process.env.YUELIAN_MODEL_PROVIDER=provider;
 try{return await run();}finally{if(before===undefined)delete process.env.YUELIAN_MODEL_PROVIDER;else process.env.YUELIAN_MODEL_PROVIDER=before;}
}
test('settings use only the server allowlist, ignore arbitrary URLs, and never retain a cloud key locally',()=>{
 const s=model.modelSettings({YUELIAN_MODEL_PROVIDER:'strata',DEEPSEEK_API_KEY:'cloud-only-sentinel',YUELIAN_MODEL_URL:'https://attacker.invalid',MODEL:'forged'});
 assert.equal(s.key,'');assert.equal(s.configured,true);assert.equal(s.runtime.endpoint,'http://127.0.0.1:8080/v1/responses');assert.equal(s.runtime.temperature,0);assert.equal(s.runtime.config.model,'qwen3.8-flash-next-unsloth-ud-q4_k_xl');assert.equal(s.runtime.config.reasoning,'medium');assert.equal(s.runtime.config.effectiveReasoning,'medium');assert.equal(s.runtime.config.fastSupported,false);
 assert.equal(JSON.stringify(s).includes('cloud-only-sentinel'),false);assert.equal(JSON.stringify(s).includes('attacker'),false);
 for(const provider of ['unknown','Strata','strata ','https://attacker.invalid'])assert.throws(()=>model.modelSettings({YUELIAN_MODEL_PROVIDER:provider}),/Unknown YUELIAN_MODEL_PROVIDER/);
 const cloud=model.modelSettings({DEEPSEEK_API_KEY:'test-cloud'});assert.equal(cloud.key,'test-cloud');assert.equal(cloud.runtime.config.provider,'deepseek');assert.equal(cloud.runtime.endpoint,'https://api.deepseek.com/responses');assert.equal(cloud.runtime.temperature,undefined);assert.equal(model.modelSettings({}).configured,false);
});
test('requireModel rejects missing cloud configuration but local mode needs no cloud credential',async()=>{
 const key=process.env.DEEPSEEK_API_KEY;delete process.env.DEEPSEEK_API_KEY;
 try{
  await inProvider('deepseek',async()=>assert.throws(()=>model.requireModel(),{code:'MODEL_NOT_CONFIGURED',status:503}));
  await inProvider('strata',async()=>assert.equal(model.requireModel().key,''));
 }finally{if(key!==undefined)process.env.DEEPSEEK_API_KEY=key;}
});
test('configuration exceptions release the acquired user busy flag before any generation',async()=>{
 const run=model.createModelRunner(),usage={busy:true};let calls=0;
 await inProvider('unknown',async()=>assert.rejects(()=>run({},usage,async()=>{calls++;}),/Unknown YUELIAN_MODEL_PROVIDER/));
 assert.equal(usage.busy,false);assert.equal(calls,0);
 usage.busy=true;await inProvider('strata',async()=>assert.equal(await run({},usage,async()=> 'recovered'),'recovered'));assert.equal(usage.busy,false);
});
test('throwing or rejecting generation releases both flags and preserves the original error',async()=>inProvider('strata',async()=>{
 for(const fail of [()=>{throw new Error('sync failure');},async()=>{throw Object.assign(new Error('model failure'),{code:'MODEL_TIMEOUT'});}]){
  const run=model.createModelRunner(),usage={busy:true};
  await assert.rejects(()=>run({},usage,fail),/failure/);assert.equal(usage.busy,false);
  usage.busy=true;assert.equal(await run({},usage,async()=> 'next'),'next');assert.equal(usage.busy,false);
 }
}));
test('clarification does not acquire the local model slot or release another requests slot',async()=>inProvider('strata',async()=>{
 const run=model.createModelRunner(),first={busy:true};let finish;
 const active=run({},first,async()=>new Promise(resolve=>{finish=resolve;}));
 const clarify={busy:true};assert.equal(await run({clarification:{question:'哪位？'}},clarify,async()=> 'question'),'question');assert.equal(clarify.busy,false);
 await assert.rejects(()=>run({},{busy:true},async()=> 'must-not-run'),{code:'MODEL_BUSY'});
 finish('done');await active;
}));
test('cloud calls are not serialized by the local slot and two guards are process-local rather than a global quota',async()=>{
 const run=model.createModelRunner();
 await inProvider('deepseek',async()=>{
  let finish;const active=run({},{busy:true},async()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(await run({},{busy:true},async()=> 'second-cloud'),'second-cloud');finish();await active;
 });
 await inProvider('strata',async()=>{
  let finish;const active=run({},{busy:true},async()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(await model.createModelRunner()({},{busy:true},async()=> 'other-process'),'other-process');finish();await active;
 });
});

test('local process guard rejects a second user while the first request is pending',async()=>{
 assert.equal(typeof model.createModelRunner,'function','server must expose its no-listen process guard');
 const run=model.createModelRunner(),first={busy:true},second={busy:true},snapshot={};
 const before=process.env.YUELIAN_MODEL_PROVIDER;process.env.YUELIAN_MODEL_PROVIDER='strata';
 let finish,started=0;
 try{
  const active=run(snapshot,first,async()=>{started++;return new Promise(resolve=>{finish=resolve;});});
  assert.equal(started,1);assert.equal(first.busy,true);
  await assert.rejects(()=>run(snapshot,second,async()=>{started++;}),{code:'MODEL_BUSY',status:429});
  assert.equal(second.busy,false);assert.equal(first.busy,true);assert.equal(started,1);
  finish('first-result');assert.equal(await active,'first-result');assert.equal(first.busy,false);
  second.busy=true;assert.equal(await run(snapshot,second,async()=> 'next-result'),'next-result');assert.equal(second.busy,false);
 }finally{if(before===undefined)delete process.env.YUELIAN_MODEL_PROVIDER;else process.env.YUELIAN_MODEL_PROVIDER=before;}
});
