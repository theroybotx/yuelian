import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {cases,requestOf,assertDataset,representativeHoldout,BASELINE_COMMIT} from './dataset.mjs';
import {evaluate,summarize} from './oracle.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=Object.fromEntries(process.argv.slice(2).map(s=>{const i=s.indexOf('=');return i<0?[s.replace(/^--/,''),true]:[s.slice(0,i).replace(/^--/,''),s.slice(i+1)];}));
const sha=x=>createHash('sha256').update(x).digest('hex');
const fixedDataset=assertDataset();
if(args.supplemental&&!['rename','intent-v1.1'].includes(args.supplemental))throw Error('Unknown supplemental suite');
const extra=args.supplemental?await import(args.supplemental==='rename'?'./rename-regression.mjs':'./intent-v1.1.mjs'):null;
const available=extra?extra.cases:cases;
const dataset=extra?.assertIntentDataset?extra.assertIntentDataset():extra?{name:'post-failure-rename-regression',total:available.length,notOriginalHoldout:true}:fixedDataset;
const evaluateCase=args.supplemental==='intent-v1.1'?(await import('./intent-v1.1-oracle.mjs')).evaluateIntent:evaluate;
const split=args.split||'all',mode=args.mode||'new';
if(!['all','dev','holdout'].includes(split)||!['new','baseline'].includes(mode))throw Error('Use --mode=new|baseline --split=all|dev|holdout');
const ids=args.representative?representativeHoldout:args.ids?String(args.ids).split(','):null;
const selected=available.filter(c=>(split==='all'||c.split===split)&&(!ids||ids.includes(c.id)));
if(!selected.length||ids&&ids.some(id=>!selected.some(c=>c.id===id)))throw Error('Invalid or excluded case ID');
const runId=new Date().toISOString().replaceAll(':','-');
const OUT=resolve(args.output||`${ROOT}/output/semantic-v1/${mode}-${runId}`);
mkdirSync(OUT,{recursive:true});
if(existsSync(OUT+'/results.json'))throw Error('Refusing to overwrite an existing run; choose a new --output directory');
const extraDataFile=args.supplemental==='rename'?'rename-regression.mjs':'intent-v1.1.mjs';
const datasetDigest=args.supplemental?sha(Buffer.concat(['dataset.mjs',extraDataFile].map(p=>readFileSync(new URL('./'+p,import.meta.url))))):sha(readFileSync(new URL('./dataset.mjs',import.meta.url)));
const oracleDigest=args.supplemental==='intent-v1.1'?sha(Buffer.concat(['oracle.mjs','intent-v1.1-oracle.mjs'].map(p=>readFileSync(new URL('./'+p,import.meta.url))))):sha(readFileSync(new URL('./oracle.mjs',import.meta.url)));
const sourcePaths=mode==='baseline'?[]:['lib/assistant.ts','lib/plan-amendment.ts','server/src/understanding.mjs','server/src/generation.mjs','server/src/plans.mjs','server/shared/assistant.ts','server/src/domain-examples.mjs'];
const source=()=>Object.fromEntries(sourcePaths.filter(p=>existsSync(ROOT+'/'+p)).map(p=>[p,sha(readFileSync(ROOT+'/'+p))]));
const initialSource=source();
const metadata={runId,mode,dataset,datasetDigest,oracleDigest,selectedIds:selected.map(c=>c.id),baselineCommit:BASELINE_COMMIT,
 gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),source:initialSource,model:'deepseek-flash',reasoning:'medium',effectiveReasoning:'high',productionDataTouched:false,modelCallsAuthorized:args.live===true};
metadata.harness=Object.fromEntries(['run.mjs','new-adapter.mjs','oracle.mjs','dataset.mjs'].map(p=>[p,sha(readFileSync(new URL('./'+p,import.meta.url)))]));
if(!args.live){writeFileSync(OUT+'/selection.json',JSON.stringify(metadata,null,2));console.log(JSON.stringify({...dataset,mode,selected:selected.length,output:OUT,modelCalls:0}));process.exit(0);}
if(!process.env.DEEPSEEK_API_KEY)throw Error('DEEPSEEK_API_KEY is required; use the existing private runtime env file, never command-line key text');
let run;
if(mode==='baseline'){
 const baselinePath=OUT+'/baseline-assistant.ts';
 writeFileSync(baselinePath,execFileSync('git',['show',BASELINE_COMMIT+':lib/assistant.ts'],{cwd:ROOT}));
 metadata.baselineSourceDigest=sha(readFileSync(baselinePath));
 const module=await import(pathToFileURL(baselinePath));
 run=input=>module.interpret(module.scopeInput(input),process.env.DEEPSEEK_API_KEY);
}else{({run}=await import('./new-adapter.mjs'));}
const originalFetch=globalThis.fetch,storage=new AsyncLocalStorage();
globalThis.fetch=async(url,options)=>{
 const row=storage.getStore();if(!row)throw Error('Model request outside a case');
 if(new URL(String(url)).origin!=='https://api.deepseek.com')throw Error('Semantic evaluation blocks non-provider outbound fetch');
 const body=JSON.parse(options.body);
 if('expected' in body||'caseId' in body||'oracle' in body)throw Error('Evaluation metadata must never be sent to a model');
 const call={startedAt:new Date().toISOString(),requestBytes:Buffer.byteLength(options.body),requestDigest:sha(options.body),instructionsDigest:sha(body.instructions||''),model:body.model,reasoning:body.reasoning};row.calls.push(call);
 const start=Date.now();
 try{const response=await originalFetch(url,options);call.status=response.status;const payload=await response.clone().json().catch(()=>null);call.durationMs=Date.now()-start;call.actualModel=payload?.model||null;call.usage=payload?.usage||null;
  const output=(payload?.output||[]).flatMap(item=>item.type==='message'?(item.content||[]):[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
  if(output){try{call.providerOutput=JSON.parse(output);}catch{call.providerOutput=output.slice(0,50000);}}
  return response;}
 catch(error){call.durationMs=Date.now()-start;call.error=error.name||'Error';throw error;}
};
const concurrency=Number(args.concurrency||1);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Concurrency must be between 1 and 4');
metadata.concurrency=concurrency;
const results=new Array(selected.length);let cursor=0,reported=0;
const completed=()=>results.filter(Boolean);
const save=()=>{const rows=completed();writeFileSync(OUT+'/results.json',JSON.stringify({...metadata,completedAt:new Date().toISOString(),sourceAfter:source(),implementationChanged:JSON.stringify(source())!==JSON.stringify(initialSource),summary:summarize(rows),results:rows},null,2));};
const report=()=>{while(results[reported]){const row=results[reported++];console.log(JSON.stringify({id:row.id,status:row.status,calls:row.calls.length,ms:row.durationMs,failures:row.checks.filter(c=>!c.passed).map(c=>c.path),error:row.error?.code}));}};
try{
 const worker=async()=>{for(;;){const index=cursor++;if(index>=selected.length)return;const testCase=selected[index];
  const row={id:testCase.id,group:testCase.group,split:testCase.split,style:testCase.style,text:testCase.input.text,calls:[]};const start=Date.now();let response,error;
  try{response=await storage.run(row,()=>run(requestOf(testCase)));}catch(e){error={name:e.name,code:e.code||null,message:e.message};}
  const verdict=evaluateCase(testCase,response,error);Object.assign(row,{status:verdict.passed?'passed':'failed',strictPassed:verdict.strictPassed??verdict.passed,durationMs:Date.now()-start,checks:verdict.checks,strictChecks:verdict.strictChecks||[],...(response?{response}:{}),...(error?{error}:{})});
  results[index]=row;writeFileSync(OUT+'/'+row.id+'.json',JSON.stringify(row,null,2));save();report();
 }};
 await Promise.all(Array.from({length:concurrency},()=>worker()));
}finally{globalThis.fetch=originalFetch;save();}
console.log(JSON.stringify({output:OUT,...summarize(completed())}));
if(completed().length!==selected.length||completed().some(r=>r.status==='failed')||JSON.stringify(source())!==JSON.stringify(initialSource))process.exitCode=1;
