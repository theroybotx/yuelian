import test from 'node:test';
import assert from 'node:assert/strict';
import {cases,assertDataset,requestOf,operation,step,plan} from './dataset.mjs';
import {evaluate,summarize} from './oracle.mjs';

test('fixed data: 150 original cases, 45 dev/105 holdout, 78 conversational, all 17 actions',()=>{
 assert.deepEqual(assertDataset(),{version:'yuelian-semantic-v1-2026-11-01',total:150,dev:45,holdout:105,colloquial:78,groups:{A:51,R:18,M:12,P:20,S:11,U:8,C:30}});
});
test('request contains input only, no expected value, IDs, split or style; clone cannot mutate oracle',()=>{
 const c=cases[0],input=requestOf(c);assert.deepEqual(Object.keys(input).sort(),['context','text']);assert.ok(!JSON.stringify(input).includes(c.id));input.text='changed';assert.notEqual(c.input.text,'changed');
});
test('oracle catches valid-schema wrong person, date, amount, omitted and extra steps',()=>{
 const c=cases.find(c=>c.id==='SEM-M04');const good=plan(step('credit',{studentId:'st-lin',amount:2}),step('credit',{studentId:'st-yu',amount:3}));assert.ok(evaluate(c,{plan:good}).passed);
 for(const mutate of [p=>p.steps[0].operation.studentId='st-an',p=>p.steps[1].operation.amount=30,p=>p.steps.pop(),p=>p.steps.push(step('balance',{studentId:'st-lin'}))]){const bad=structuredClone(good);mutate(bad);assert.equal(evaluate(c,{plan:bad}).passed,false);}
 const booking=cases[0],bad=plan(step('booking',{studentId:'st-lin',venueId:'v-river',date:'2026-11-03',start:'15:00',duration:60}));assert.equal(evaluate(booking,{plan:bad}).passed,false);
});
test('oracle validates dependency IDs independently of arbitrary model step labels',()=>{
 const c=cases.find(c=>c.id==='SEM-M02');const good=plan(step('add-student',{studentName:'小禾'},{id:'newPerson'}),step('credit',{studentId:null,amount:5},{id:'purchase',dependsOn:['newPerson'],studentRef:'newPerson'}));assert.ok(evaluate(c,{plan:good}).passed);good.steps[1].dependsOn=[];assert.equal(evaluate(c,{plan:good}).passed,false);
});
test('patch oracle rejects unchanged field rewriting, graph changes, silent null/false/zero changes',()=>{
 const c=cases.find(c=>c.id==='SEM-P01'),good=structuredClone(c.expected.exactPlan);assert.ok(evaluate(c,{plan:good}).passed);
 for(const mutate of [p=>p.steps[0].operation.note='正手',p=>p.steps[0].studentRef='wrong',p=>p.steps[0].operation.publish=false,p=>p.steps[0].operation.travel=0]){const bad=structuredClone(good);mutate(bad);assert.equal(evaluate(c,{plan:bad}).passed,false);}
});
test('initial null privacy/default fields use effective backend semantics; strict score remains separate',()=>{
 const record=cases.find(c=>c.id==='SEM-A05');const p=plan(step('record',{lessonId:'l-yesterday',duration:90,publish:null}));const r=evaluate(record,{plan:p});assert.equal(r.passed,true);assert.equal(r.strictPassed,false);
 const student=cases.find(c=>c.id==='SEM-A15');const wrong=plan(step('edit-student',{studentId:'st-an',name:'小安',goal:'上旋',next:'步法'}));assert.equal(evaluate(student,{plan:wrong}).passed,false,'edit-student backend does not use name alias');
});
test('clarification and denial are checked: empty question and arbitrary runtime error fail',()=>{
 const c=cases.find(c=>c.id==='SEM-S01');assert.ok(evaluate(c,{plan:plan(step('clarification'))}).passed);const bad=plan(step('clarification'));bad.steps[0].operation.explanation='';assert.equal(evaluate(c,{plan:bad}).passed,false);assert.ok(evaluate(c,null,{code:'REFUSED'}).passed);assert.equal(evaluate(c,null,{code:'MODEL_TIMEOUT'}).passed,false);assert.equal(evaluate(cases[0],null,{code:'REFUSED'}).passed,false);
});
test('summary counts actual calls, deterministic cases and unavailable usage separately',()=>{
 const rows=[{id:'1',group:'A',split:'holdout',style:'colloquial',status:'passed',durationMs:10,calls:[{usage:{input_tokens:5,output_tokens:3,total_tokens:8}}]},{id:'2',group:'R',split:'dev',style:'colloquial',status:'passed',durationMs:1,calls:[]},{id:'3',group:'S',split:'holdout',style:'colloquial',status:'failed',error:{code:'X'},durationMs:20,calls:[{usage:null}]}];const s=summarize(rows);assert.equal(s.actualModelCalls,2);assert.equal(s.callsWithUsage,1);assert.equal(s.deterministicWithoutModel,1);assert.deepEqual(s.usage,{inputTokens:5,outputTokens:3,totalTokens:8});
});
