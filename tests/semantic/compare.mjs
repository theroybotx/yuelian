import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';

const [baselinePath,newPath,outputPath='output/semantic-v1/comparison.json']=process.argv.slice(2);
if(!baselinePath||!newPath)throw Error('Usage: node tests/semantic/compare.mjs baseline/results.json new/results.json [comparison.json]');
const baseline=JSON.parse(readFileSync(baselinePath,'utf8')),current=JSON.parse(readFileSync(newPath,'utf8'));
if(baseline.mode!=='baseline'||current.mode!=='new')throw Error('Input modes do not match');
if(baseline.datasetDigest!==current.datasetDigest||baseline.oracleDigest!==current.oracleDigest)throw Error('Cannot compare different datasets or oracles');
if(baseline.implementationChanged||current.implementationChanged)throw Error('A compared run changed source during execution');
const old=new Map(baseline.results.map(r=>[r.id,r]));
const pairs=current.results.filter(r=>r.split==='holdout'&&old.has(r.id)).map(r=>({id:r.id,group:r.group,style:r.style,text:r.text,baseline:old.get(r.id).status,current:r.status,baselineStrict:old.get(r.id).strictPassed,currentStrict:r.strictPassed,
 baselineErrors:old.get(r.id).checks.filter(c=>!c.passed),currentErrors:r.checks.filter(c=>!c.passed),
 baselineCalls:old.get(r.id).calls.length,currentCalls:r.calls.length,baselineMs:old.get(r.id).durationMs,currentMs:r.durationMs}));
const stats=rows=>({count:rows.length,baselinePassed:rows.filter(r=>r.baseline==='passed').length,currentPassed:rows.filter(r=>r.current==='passed').length,baselineStrictPassed:rows.filter(r=>r.baselineStrict===true).length,currentStrictPassed:rows.filter(r=>r.currentStrict===true).length,improved:rows.filter(r=>r.baseline==='failed'&&r.current==='passed').length,regressed:rows.filter(r=>r.baseline==='passed'&&r.current==='failed').length,bothFailed:rows.filter(r=>r.baseline==='failed'&&r.current==='failed').length});
const report={generatedAt:new Date().toISOString(),datasetDigest:baseline.datasetDigest,oracleDigest:baseline.oracleDigest,baselineRun:baseline.runId,currentRun:current.runId,baselineSource:baseline.baselineSourceDigest,currentSource:current.source,
 notes:['Fixed original synthetic holdout, not a population accuracy estimate.','Only intersecting holdout cases are compared.','A clarification for an unsupported operation means safe handling, not that the business operation is implemented.','Actual model calls and deterministic preprocessing are reported separately in the original results.'],
 summary:stats(pairs),byGroup:Object.fromEntries([...new Set(pairs.map(r=>r.group))].map(g=>[g,stats(pairs.filter(r=>r.group===g))])),pairs};
mkdirSync(dirname(resolve(outputPath)),{recursive:true});writeFileSync(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify({output:resolve(outputPath),...report.summary}));
