import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';

// A separate, explicit review layer. Never alter the fixed expected answers,
// original response, strict score, or business-default score.
const [baselinePath,currentPath,apiPath,livePath,outputPath]=process.argv.slice(2);
if(!outputPath)throw Error('Usage: node tests/semantic/adjudicate.mjs baseline/business-score.json new/results.json api/results.json live/results.json output.json');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const baseline=read(baselinePath),current=read(currentPath),api=read(apiPath),live=read(livePath);
assert.equal(baseline.mode,'baseline');assert.equal(current.mode,'new');
assert.equal(baseline.datasetDigest,current.datasetDigest);assert.equal(baseline.oracleDigest,current.oracleDigest);
assert.ok(!baseline.implementationChanged&&!current.implementationChanged,'Do not adjudicate a source-changing run as final');
if(existsSync(outputPath))throw Error('Refusing to overwrite previous adjudication');
const row=(report,id)=>{const r=report.results.find(r=>r.id===id);assert.ok(r,`Missing ${id}`);return r;};
const op=(r,index=0)=>r.response.plan.steps[index].operation;
const assertBooking=(r,index,student,venue)=>{const o=op(r,index);assert.equal(o.intent,'booking');assert.equal(o.studentId,student);assert.equal(o.venueId,venue);assert.equal(o.date,'2026-11-02');assert.equal(o.start,'15:00');assert.equal(o.duration,60);assert.ok(!r.response.committed&&!r.response.results);};
const blankVenue=(report,id,index)=>{const r=row(report,id);assertBooking(r,index,'st-an',null);assert.match(JSON.stringify(r.response.plan),/场地.{0,20}(?:补选|选择|核对)|(?:补选|选择).{0,10}场地/);return r;};
blankVenue(baseline,'SEM-R09',0);const oldMulti=blankVenue(baseline,'SEM-M09',1);
assert.equal(oldMulti.response.plan.steps.length,2);assert.equal(op(oldMulti).intent,'credit');assert.equal(op(oldMulti).studentId,'st-yu');assert.equal(op(oldMulti).amount,2);
for(const report of [baseline,current]){const r=row(report,'SEM-R10');assert.equal(r.response.plan.steps.length,1);assertBooking(r,0,'st-lin','v-river');}
const staged=row(current,'SEM-M09');assert.equal(staged.response.plan.steps.length,1);assert.equal(op(staged).intent,'clarification');assert.equal(staged.response.meta.understanding.clarification.field,'selectedStudent');
for(const [report,id] of [[api,'V1-API-19'],[live,'V1-LIVE-06']]){assert.equal(row(report,id).status,'passed');assert.equal(report.productionDataTouched,false);assert.match(report.database,/^yuelian_acceptance_/);}
const chainPath=dirname(livePath)+'/multi-turn-plan.json';
const hasDatedChain=existsSync(chainPath);
if(hasDatedChain){
 const chain=read(chainPath),booking=chain.third?.plan?.steps?.[1]?.operation;
 assert.equal(chain.first?.plan?.steps?.[0]?.operation.intent,'clarification');
 assert.equal(chain.second?.meta?.understanding?.clarification?.field,'venueId');
 assert.equal(chain.third?.plan?.steps?.[0]?.operation.intent,'credit');
 assert.equal(chain.third?.plan?.steps?.[0]?.operation.amount,2);
 assert.equal(booking?.intent,'booking');assert.equal(booking?.date,'2026-11-02');
 assert.equal(booking?.start,'15:00');assert.equal(booking?.duration,60);
}
const snapshots=outputPath.replace(/\.json$/,'')+'-evidence';mkdirSync(snapshots,{recursive:true});
const evidence=[baselinePath,currentPath,apiPath,livePath,'tests/full/ai-v1.mjs','tests/full/ai-v1-live.mjs','tests/understanding-context.test.mjs',...(hasDatedChain?[chainPath]:[])].map((path,index)=>{
 const sha256=sha(path),snapshot=`${snapshots}/${index}-${basename(path)}`;
 if(existsSync(snapshot))throw Error('Refusing to overwrite evidence snapshot');
 writeFileSync(snapshot,readFileSync(path));return {path,sha256,snapshot};
});
const verdicts=[
 {mode:'baseline',id:'SEM-R09',reason:'没有历史依据时保留空场地和明确补选说明，其他预约字段完整；待确认表单补充等价于先追问。',evidence:[baselinePath]},
 {mode:'baseline',id:'SEM-M09',reason:'两项任务和全部已知字段保留；第二项空场地并明确补选，未猜测或宣称执行。',evidence:[baselinePath]},
 ...['baseline','new'].map(mode=>({mode,id:'SEM-R10',reason:'仅删除通用后缀后，“滨江网球场”简称为“滨江”，“滨江东岸网球场”简称仍为“滨江东岸”。“滨江”唯一精确匹配前者；不按任意公共前缀制造歧义。两版采用同一裁定。真实同简称冲突另有单元测试。',evidence:[mode==='baseline'?baselinePath:currentPath,'tests/understanding-context.test.mjs']})),
 {mode:'new',id:'SEM-M09',reason:'产品先暂存整项请求并追问历史对象，无历史再问场地；候选续答后恢复登记课时及预约。独立受控 API 与真实模型持久会话链验证任务、对象、课时数、场地、时间、时长及确认前无业务写入。',evidence:[currentPath,apiPath,livePath,...(hasDatedChain?[chainPath]:[])],dateCheckedFromSavedChain:hasDatedChain,limitation:hasDatedChain?null:'此次 LIVE06 断言尚未单独检查明天的日期；不能把已验证字段描述为无遗漏的所有字段。后续补充验证另附证据。'}
];
const score=(report,mode)=>{
 const accepted=new Set(verdicts.filter(v=>v.mode===mode).map(v=>v.id));
 const counts=rows=>({total:rows.length,strictPassed:rows.filter(r=>r.strictPassed).length,businessPassed:rows.filter(r=>r.status==='passed').length,interactionEquivalentPassed:rows.filter(r=>r.status==='passed'||accepted.has(r.id)).length});
 return {...counts(report.results),holdout:counts(report.results.filter(r=>r.split==='holdout')),remainingFailures:report.results.filter(r=>r.status!=='passed'&&!accepted.has(r.id)).map(r=>({id:r.id,text:r.text,error:r.error||null}))};
};
const report={reviewedAt:new Date().toISOString(),kind:'independent-interaction-adjudication-v2',changedFixedExpected:false,changedOriginalResponses:false,additionalModelCalls:0,datasetDigest:baseline.datasetDigest,oracleDigest:baseline.oracleDigest,evidence,verdicts,baseline:score(baseline,'baseline'),current:score(current,'new'),notes:['Three score levels remain visible; interaction review is not a change to the fixed oracle.','The fixed holdout has now informed bug fixes. Current results are regression evidence, not an untouched accuracy estimate.','Network failures stay failures; unsupported requests safely clarified do not mean those operations are implemented.','A semantic draft test does not prove database execution, delivery to WeChat, payment, or user-visible latency.']};
mkdirSync(dirname(resolve(outputPath)),{recursive:true});writeFileSync(outputPath,JSON.stringify(report,null,2));
console.log(JSON.stringify({output:outputPath,baseline:report.baseline,current:report.current}));
