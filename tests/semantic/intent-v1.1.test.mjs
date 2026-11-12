import test from 'node:test';
import assert from 'node:assert/strict';
import {cases,assertIntentDataset} from './intent-v1.1.mjs';
import {cases as original,assertDataset,plan,step,requestOf} from './dataset.mjs';
import {evaluateIntent} from './intent-v1.1-oracle.mjs';
const byId=n=>cases.find(c=>c.id==='INTENT-'+String(n).padStart(2,'0'));
const valid=(c,overrides={})=>({plan:plan(step(c.expected.steps[0].intent,{...c.expected.steps[0],explanation:'请核对当前教练与预约资料后确认。',...overrides}))});
test('v1.1 is a separate 24-case regression; original 150 and C01 are unchanged',()=>{
 assert.equal(assertIntentDataset().total,24);assert.equal(assertDataset().total,150);
 const c=original.find(c=>c.id==='SEM-C01');assert.equal(c.expected.steps[0].intent,'clarification');assert.equal(c.input.context.currentCoachName,undefined);
 assert.equal(byId(1).input.context.currentCoachName,'示例 · 周教练');assert.equal(byId(1).expected.steps[0].intent,'booking');
});
test('supplement model input excludes new oracle and explanatory metadata',()=>{
 const r=requestOf(byId(16));assert.deepEqual(Object.keys(r).sort(),['context','text']);assert.ok(!('expected' in r));assert.ok(!('clarificationTopics' in r));assert.ok(!('meaning' in r));
});
test('short inquiry must create a draft but cannot invent time, duration, venue or end',()=>{
 const c=byId(1);assert.equal(evaluateIntent(c,valid(c)).passed,true);
 for(const fields of [{start:'19:00'},{duration:60},{venueId:'v-river'},{end:'20:00'},{date:'2026-11-03'}])assert.equal(evaluateIntent(c,valid(c,fields)).passed,false);
});
test('correct inquiry with explicit fields preserves all known date/time/entities',()=>{
 const c=byId(4);assert.equal(evaluateIntent(c,valid(c)).passed,true);
 assert.equal(evaluateIntent(c,valid(c,{end:'20:00'})).passed,true);
 assert.equal(evaluateIntent(c,valid(c,{end:'21:00'})).passed,false);
 assert.equal(evaluateIntent(c,valid(c,{studentId:'st-yu'})).passed,false);
 const derived=byId(5);assert.equal(evaluateIntent(derived,valid(derived,{end:'21:00'})).passed,true);
});
test('explicit other coach and unresolved coach context cannot generate current-coach booking',()=>{
 for(const n of [16,17,18,19,20,21]){const c=byId(n);assert.equal(evaluateIntent(c,valid(c,{explanation:'请先选择需要约课的教练或学员。'})).passed,true);assert.equal(evaluateIntent(c,{plan:valid(byId(1)).plan}).passed,false);}
});
test('read-only request cannot become a booking or fabricate an available time',()=>{
 const c=byId(11);assert.equal(evaluateIntent(c,valid(c,{explanation:'目前不能直接查询空闲时段，请在日程中查看。'})).passed,true);
 assert.equal(evaluateIntent(c,{plan:valid(byId(1)).plan}).passed,false);
 assert.equal(evaluateIntent(c,valid(c,{explanation:'查询结果：明晚19:00有空。'})).passed,false);
});
test('generation cannot claim that a booking was already submitted',()=>{
 const c=byId(1);assert.equal(evaluateIntent(c,valid(c,{explanation:'已为你提交预约。'})).passed,false);
});
