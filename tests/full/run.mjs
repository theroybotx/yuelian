import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {sourceState} from './source-state.mjs';

const requested=process.argv.slice(2),suites=requested.length?requested:['api','actions','business','security','recovery','live','ai-v1','ai-v1-live','ai-v1-outbound','ai-v1-booking-intent'];
const allowed=new Set(['api','actions','business','security','recovery','live','ai-v1','ai-v1-live','ai-v1-outbound','ai-v1-booking-intent']);
if(suites.some(s=>!allowed.has(s)))throw Error('Unknown suite; allowed: '+[...allowed].join(', '));
const root=process.cwd(),out=process.env.YUELIAN_FULL_OUTPUT||root+'/output/full-20261101';mkdirSync(out,{recursive:true});
const runId=new Date().toISOString().replaceAll(':','-'),history=out+'/runs/'+runId;mkdirSync(history,{recursive:true});
const initial=sourceState(),reports=[];
for(const suite of suites){
 const suiteOut=out+'/'+suite;
 // Never count a prior result when a new suite fails during startup.
 for(const name of ['results.json','extra-results.json','backend.log','model-inputs.jsonl','model-control.json'])rmSync(suiteOut+'/'+name,{force:true});
 const run=spawnSync(process.execPath,['--use-env-proxy','--experimental-transform-types',root+'/tests/full/'+suite+'.mjs'],{
  cwd:root,env:{...process.env,YUELIAN_TEST_RUN_ID:runId,YUELIAN_TEST_SUITE:suite,YUELIAN_TEST_DATABASE:process.env.YUELIAN_TEST_DATABASE||'yuelian_acceptance_full_20261101',YUELIAN_TEST_PORT:process.env.YUELIAN_TEST_PORT||(suite==='recovery'?'18901':'18897'),YUELIAN_TEST_OUTPUT:suiteOut},stdio:'inherit',timeout:900000
 });
 let evidence;try{evidence=JSON.parse(readFileSync(suiteOut+'/results.json','utf8'));}catch{}
 const archived=history+'/'+suite;mkdirSync(archived,{recursive:true});
 for(const name of ['results.json','backend.log','model-inputs.jsonl'])if(existsSync(suiteOut+'/'+name))copyFileSync(suiteOut+'/'+name,archived+'/'+name);
 const fresh=evidence?.runId===runId&&evidence?.results?.length>0;
 reports.push({suite,exitCode:run.status,error:run.error?.message||(!fresh?'Suite did not produce current-run results':undefined),evidence:archived+'/results.json',fresh,source:evidence?.source,results:fresh?evidence.results:[]});
}
const final=sourceState(),report={at:new Date().toISOString(),runId,scope:'backend-integration',initial,final,implementationChanged:initial.implementationDigest!==final.implementationDigest,backendChanged:initial.backendDigest!==final.backendDigest,database:process.env.YUELIAN_TEST_DATABASE||'yuelian_acceptance_full_20261101',productionDataTouched:false,suites:reports};
report.summary={passed:reports.flatMap(s=>s.results).filter(r=>r.status==='passed').length,failed:reports.flatMap(s=>s.results).filter(r=>r.status==='failed').length,suiteFailures:reports.filter(s=>s.exitCode!==0||!s.fresh).length};
writeFileSync(out+'/summary.json',JSON.stringify(report,null,2));
writeFileSync(history+'/summary.json',JSON.stringify(report,null,2));
const cases=reports.flatMap(s=>s.results.map(r=>({suite:s.suite,id:r.id,planIds:r.planIds,status:r.status,evidence:s.evidence})));
writeFileSync(out+'/coverage.json',JSON.stringify({at:report.at,source:final,cases},null,2));
console.log(JSON.stringify({summary:report.summary,implementationChanged:report.implementationChanged,backendChanged:report.backendChanged,evidence:out+'/summary.json'}));
if(report.summary.failed||report.summary.suiteFailures||report.backendChanged)process.exitCode=1;
