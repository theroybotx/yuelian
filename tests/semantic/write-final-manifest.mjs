import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

const root='output/semantic-v1';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const output=root+'/FINAL-ACCEPTANCE-MANIFEST.json';
if(existsSync(output))throw Error('Refusing to overwrite the acceptance manifest');
const full=read(root+'/new-full-final2/results.json'),audit=read(root+'/interaction-audit-20261101-v3.json');
assert.equal(full.summary.total,150);assert.equal(full.implementationChanged,false);
assert.equal(audit.current.interactionEquivalentPassed,149);
assert.deepEqual(audit.current.remainingFailures.map(r=>r.id),['SEM-A15']);
assert.equal(full.results.find(r=>r.id==='SEM-A15').split,'holdout');
const successful=(directory,count)=>{
 const path=root+'/'+directory+'/results.json',r=read(path);
 assert.equal(r.results.length,count);assert.equal(r.summary.passed,count);assert.equal(r.implementationChanged,false);
 assert.ok(r.results.every(row=>row.status==='passed'));
 return {path,sha256:sha(path),runId:r.runId,source:r.source,summary:r.summary,selectedIds:r.selectedIds};
};
const intent=successful('intent-v1.1-final2',24);
const stability=[1,2,3].map(i=>successful('rename-stability-'+i,1));
const related=successful('rename-related-nine',9),patch=successful('rename-patch-two',2);
for(const r of [stability[1],stability[2],related,patch])assert.deepEqual(r.source,intent.source,'Final frozen targeted runs must share source');
for(const [path,digest] of Object.entries(intent.source))assert.equal(sha(path),digest,'Runtime changed after final tests');
const replayPath=root+'/rename-response-replay.json',replay=read(replayPath);
assert.equal(replay.modelCalls,0);assert.equal(replay.verdict.passed,true);
const history=readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()&&existsSync(root+'/'+d.name+'/results.json')).map(d=>{
 const path=root+'/'+d.name+'/results.json',r=read(path);
 return {path,sha256:sha(path),runId:r.runId,mode:r.mode,dataset:r.dataset,implementationChanged:r.implementationChanged,summary:r.summary};
}).filter(r=>r.runId&&r.summary).sort((a,b)=>a.runId.localeCompare(b.runId));
const totals=history.reduce((a,r)=>({logicalCases:a.logicalCases+r.summary.total,actualModelCalls:a.actualModelCalls+r.summary.actualModelCalls,callsWithUsage:a.callsWithUsage+r.summary.callsWithUsage,inputTokens:a.inputTokens+r.summary.usage.inputTokens,outputTokens:a.outputTokens+r.summary.usage.outputTokens,totalTokens:a.totalTokens+r.summary.usage.totalTokens}),{logicalCases:0,actualModelCalls:0,callsWithUsage:0,inputTokens:0,outputTokens:0,totalTokens:0});
const manifest={generatedAt:new Date().toISOString(),status:'semantic-cumulative-acceptance-complete',productionDataTouched:false,
 scope:'Original 150 synthetic semantics plus versioned 24-case intent correction and supplemental name regression; backend execution/UI/deployment are separate root evidence.',
 sourceBoundary:{lastCompleteOriginal150:full.source,finalRuntime:intent.source,postFullChanges:['Initial edit-student name alias normalization and prompt clarification','Server-authorized currentCoachName and student inquiry/delegation handling','Coach target, negation and explicit-read-only guards'],notSingleFinal150Run:true},
 original150:{fullRun:root+'/new-full-final2/results.json',fullStrictPassed:146,fullBusinessPassed:147,fullInteractionEquivalentPassed:149,total:150,interactionReview:root+'/interaction-audit-20261101-v3.json',unresolvedAfterFull:['SEM-A15'],closedAfterFix:['SEM-A15'],cumulativeAcceptedCases:150,qualification:'Cumulative evidence: the complete run remains 149/150 after interaction adjudication; one real defect was fixed and retested. This is not a single final-source 150/150 run.'},
 same105Holdout:{baseline:{strictPassed:94,businessPassed:95,interactionEquivalentPassed:98},newFullRun:{strictPassed:101,businessPassed:102,interactionEquivalentPassed:104},total:105,remainingAfterFull:'SEM-A15',closure:stability.map(r=>r.path),qualification:'The holdout informed repairs. Results are regression evidence, not independent generalization accuracy; do not rewrite the original 104/105 as an untouched 105/105.'},
 renameRegression:{originalResponseReplay:{path:replayPath,sha256:sha(replayPath),modelCalls:0,passed:true},stability,related,patch,latestPhaseLogicalCases:13,earlierStabilityLogicalCases:1},
 intentV11:{final:intent,firstRun:root+'/intent-v1.1-final/results.json',firstStrictPassed:22,firstInteractionEquivalentPassed:23,firstInteractionReview:root+'/intent-v1.1-first-interaction-review.json',originalC01Preserved:true,qualification:'New product requirement and currentCoachName context; no retrospective change to the original 150 or its historical scores. Safe handling of read-only requests does not implement an availability-query tool.'},
 research:{sourceDocument:'docs/ai-v1-sources.md',allUtterancesOriginalSynthetic:true,privateCustomerChatCollected:false,productionExampleRetrieval:false},
 runHistory:history,semanticRunnerTotals:totals,tokenQualification:'All semantic runner rounds including exploratory failures and repeated regressions. One earlier response-body timeout has no provider usage. Totals exclude root backend/browser model calls and are not a billing estimate.'};
writeFileSync(output,JSON.stringify(manifest,null,2));
console.log(JSON.stringify({output,originalFull:149,originalTotal:150,cumulativeClosed:150,intentPassed:intent.summary.passed,intentTotal:24,latestRenameCases:13,sourceStable:true}));
