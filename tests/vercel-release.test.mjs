import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cp,mkdir,mkdtemp,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {releasePolicy,currentRef,forwardOnly,checkedDeployment,runRelease,realTools} from '../scripts/vercel-release.mjs';
import {checkedCiManifest} from '../scripts/vercel-first-stage.mjs';

const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
// Synthetic values only: no test reads credentials, touches a real deployment,
// or treats simulated responses as evidence that remote services passed.
const base={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'theroybotx/yuelian',GITHUB_EVENT_NAME:'push',GITHUB_RUN_ID:'123',GITHUB_SHA:B,GITHUB_REF:'refs/heads/devops/vercel',GITHUB_REF_PROTECTED:'true',YUELIAN_PREVIEW_BRANCH:'devops/vercel',CHECKS_RESULT:'success',GH_TOKEN:'synthetic-github',VERCEL_TOKEN:'synthetic-vercel',VERCEL_ORG_ID:'team_synthetic',VERCEL_PROJECT_ID:'prj_sClf94SbvxJ4cS3Etv6EnrQ9OrXR',YUELIAN_RELEASE_BRANCH:'release',YUELIAN_PRODUCTION_ORIGIN:'https://yuelian.vercel.app'};
const prod={...base,GITHUB_REF:'refs/heads/release',GITHUB_REF_PROTECTED:'true'};
const deployment=(target='production',sha=B,id='dpl_candidate')=>({id,projectId:base.VERCEL_PROJECT_ID,readyState:'READY',target,meta:{sourceCommit:sha}});
const url='https://yuelian-synthetic.vercel.app';

async function inspectFixture(t,summary={id:'dpl_candidate',url:url.slice('https://'.length),readyState:'READY',target:'production'}){
 const fixture=await mkdtemp(path.join(tmpdir(),'yuelian-inspect-'));
 t.after(()=>rm(fixture,{recursive:true,force:true}));
 const cli=path.join(fixture,'vercel');const argsFile=path.join(fixture,'args.json');
 await writeFile(cli,'#!'+process.execPath+'\n'+
  "import {writeFileSync} from 'node:fs';\n"+
  'writeFileSync('+JSON.stringify(argsFile)+',JSON.stringify(process.argv.slice(2)));\n'+
  'process.stdout.write('+JSON.stringify(JSON.stringify(summary))+');\n',{mode:0o700});
 return {tools:realTools({...prod,VERCEL_CLI:cli}),argsFile};
}

test('real inspect waits with the CLI then resolves its summary ID through the scoped deployment API',async t=>{
 const {tools,argsFile}=await inspectFixture(t);const calls=[];
 const raw={...deployment(),url:url.slice('https://'.length),meta:{sourceCommit:B,firstStageReceipt:'synthetic-receipt'}};
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  calls.push({input:String(input),init});
  assert.deepEqual(JSON.parse(await readFile(argsFile,'utf8')),['inspect',url,'--wait','--timeout','5m','--json','--token='+base.VERCEL_TOKEN]);
  return Response.json(raw);
 });
 const output=await tools.command(['inspect',url,'--wait','--timeout','5m','--json']);
 assert.deepEqual(JSON.parse(output),raw);
 assert.equal(checkedDeployment(JSON.parse(output),prod,'production').meta.firstStageReceipt,'synthetic-receipt');
 assert.equal(calls.length,1);
 assert.equal(calls[0].input,'https://api.vercel.com/v13/deployments/dpl_candidate?teamId='+base.VERCEL_ORG_ID);
 assert.equal(calls[0].init.method,'GET');
 assert.equal(calls[0].init.headers.authorization,'Bearer '+base.VERCEL_TOKEN);
 assert.equal(calls[0].init.redirect,'error');
});

test('real inspect refuses a missing CLI deployment ID before API access',async t=>{
 const {tools}=await inspectFixture(t,{url,readyState:'READY'});let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Unexpected API access');});
 await assert.rejects(tools.command(['inspect',url,'--wait','--timeout','5m','--json']),/deployment ID missing/i);
 assert.equal(calls,0);
});

test('real inspect propagates deployment API failure without accepting CLI READY',async t=>{
 const {tools}=await inspectFixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:403});});
 await assert.rejects(tools.command(['inspect',url,'--wait','--timeout','5m','--json']),/vercel provenance lookup failed: HTTP 403/);
 assert.equal(calls,1);
});

test('real inspect raw deployment still must pass project, state, source and target guards',async t=>{
 const {tools}=await inspectFixture(t);
 for(const data of [{...deployment(),projectId:'other'},{...deployment(),readyState:'ERROR'},{...deployment(),meta:{sourceCommit:C}},{...deployment(),target:'preview'}]){
  const mocked=t.mock.method(globalThis,'fetch',async()=>Response.json(data));
  const output=await tools.command(['inspect',url,'--wait','--timeout','5m','--json']);
  assert.throws(()=>checkedDeployment(JSON.parse(output),prod,'production'),/provenance mismatch|environment mismatch/);
  mocked.mock.restore();
 }
});

test('real artifact builder preserves checked bytes and rejects tampering, build failure and wrong source',async t=>{
 const fixture=await mkdtemp(path.join(tmpdir(),'yuelian-artifact-'));
 t.after(()=>rm(fixture,{recursive:true,force:true}));
 const env={PATH:process.env.PATH,HOME:fixture};
 const root=new URL('../',import.meta.url);
 for(const file of ['scripts/build-vercel.mjs','frontend/index.html','cloudflare/login.html','cloudflare/worker.ts','vercel/handler.mjs','tests/vercel-output.test.mjs','tests/vercel-http-fixture.mjs','server/src/transport-auth.mjs','server/src/policy.mjs','server/src/auth-crypto.mjs']){
  const destination=path.join(fixture,file);await mkdir(path.dirname(destination),{recursive:true});
  await cp(new URL(file,root),destination);
 }
 await cp(new URL('public/',root),path.join(fixture,'public'),{recursive:true});
 await symlink(new URL('node_modules/',root).pathname,path.join(fixture,'node_modules'),'dir');
 const git=args=>execFileSync('git',args,{cwd:fixture,env,encoding:'utf8'}).trim();
 git(['init','--quiet']);
 git(['-c','user.name=Artifact test','-c','user.email=artifact@example.invalid','commit','--quiet','--allow-empty','-m','Synthetic artifact fixture']);
 const sourceCommit=git(['rev-parse','HEAD']);
 const build=(sha=sourceCommit)=>spawnSync(process.execPath,['--input-type=module','--eval',
  `import {realTools} from ${JSON.stringify(new URL('../scripts/vercel-release.mjs',import.meta.url).href)};await realTools({...process.env,GITHUB_SHA:${JSON.stringify(sha)}}).command(['build-artifact']);`
 ],{cwd:fixture,env,encoding:'utf8'});
 const verify=()=>spawnSync(process.execPath,['--test','tests/vercel-output.test.mjs'],{cwd:fixture,env,encoding:'utf8'});
 const manifest=async()=>JSON.parse(await readFile(path.join(fixture,'.vercel/output/build-manifest.json'),'utf8'));
 let result=build();assert.equal(result.status,0,result.stderr);
 const checked=await manifest();
 result=verify();assert.equal(result.status,0,result.stdout+result.stderr);
 await rename(path.join(fixture,'.vercel/output'),path.join(fixture,'checked-output'));
 result=build();assert.equal(result.status,0,result.stderr);
 checkedCiManifest(await manifest(),checked,sourceCommit);
 result=verify();assert.equal(result.status,0,result.stdout+result.stderr);
 await writeFile(path.join(fixture,'.vercel/output/config.json'),'{}');
 result=verify();assert.notEqual(result.status,0);assert.match(result.stdout,/config\.json/);
 result=build();assert.notEqual(result.status,0);assert.match(result.stderr,/Artifact build failed/);
 await rename(path.join(fixture,'.vercel/output'),path.join(fixture,'tampered-output'));
 result=build(sourceCommit===A?B:A);assert.notEqual(result.status,0);assert.match(result.stderr,/does not match checked commit/);
});

test('Preview refuses arbitrary or unprotected branches even in the same repository',()=>{
 for(const change of [{YUELIAN_PREVIEW_BRANCH:''},{YUELIAN_PREVIEW_BRANCH:'trusted-preview'},{GITHUB_REF_PROTECTED:'false'}]){
  assert.throws(()=>releasePolicy({...base,...change},'preview'),/protected configured Preview branch/);
 }
});

test('Preview works without choosing a production branch',()=>{
 assert.equal(releasePolicy({...base,YUELIAN_RELEASE_BRANCH:''},'preview').target,'preview');
});
test('repository mismatch, PR/fork events and missing credentials fail closed',()=>{
 for(const change of [{GITHUB_REPOSITORY:'attacker/yuelian'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_ACTIONS:'false'},{VERCEL_TOKEN:''},{GH_TOKEN:''},{VERCEL_PROJECT_ID:'another-project'},{GITHUB_SHA:'truncated'}])assert.throws(()=>releasePolicy({...base,...change},'preview'));
});
test('failed, skipped or cancelled checks cannot authorize deployment',()=>{
 for(const result of ['failure','cancelled','skipped','','neutral'])assert.throws(()=>releasePolicy({...prod,CHECKS_RESULT:result},'production'),/checks/);
});
test('only an exact protected release branch or explicit semver release tag can produce production',()=>{
 assert.equal(releasePolicy(prod,'production').target,'production');
 assert.equal(releasePolicy({...prod,GITHUB_REF:'refs/tags/release-v1.2.3',GITHUB_REF_PROTECTED:'true',YUELIAN_RELEASE_BRANCH:''},'production').target,'production');
 for(const change of [{GITHUB_REF_PROTECTED:'false'},{YUELIAN_RELEASE_BRANCH:''},{GITHUB_REF:'refs/heads/main'},{GITHUB_REF:'refs/heads/release-evil'},{GITHUB_REF:'refs/tags/v1.2.3'},{GITHUB_REF:'refs/tags/release-v01.2.3'},{GITHUB_REF:'refs/tags/release-v1.2.3-preview'}])assert.throws(()=>releasePolicy({...prod,...change},'production'));
});
test('production origin must be explicit HTTPS; a release ref cannot be deployed as Preview',()=>{
 for(const origin of ['', 'http://yuelian.vercel.app','https://yuelian.vercel.app/','https://user:password@yuelian.vercel.app'])assert.throws(()=>releasePolicy({...prod,YUELIAN_PRODUCTION_ORIGIN:origin},'production'));
 assert.throws(()=>releasePolicy(prod,'preview'));
 assert.throws(()=>releasePolicy({...base,GITHUB_REF:'refs/tags/release-v1.0.0'},'preview'));
});
test('old A finishing after newer B is rejected by live branch HEAD',async()=>{
 await assert.rejects(currentRef({...prod,GITHUB_SHA:A},async()=>({object:{type:'commit',sha:B}})),/Stale/);
});
test('annotated tags resolve to their actual commit; changed or unresolved tags fail',async()=>{
 const env={...prod,GITHUB_REF:'refs/tags/release-v1.2.3'};
 let calls=0;
 await currentRef(env,async()=>++calls===1?{object:{type:'tag',sha:C}}:{object:{type:'commit',sha:B}});
 assert.equal(calls,2);
 await assert.rejects(currentRef(env,async()=>({object:{type:'tag',sha:C}})),/unresolved/);
});
test('tag reruns and divergent branches cannot roll production backwards',async()=>{
 for(const status of ['behind','diverged','unknown'])await assert.rejects(forwardOnly(prod,async(service)=>service==='vercel'?deployment('production',C,'dpl_newer'):{status}),/roll back|diverge/);
 for(const status of ['ahead','identical'])assert.equal(await forwardOnly(prod,async(service)=>service==='vercel'?deployment('production',A,'dpl_old'):{status}),false);
});
test('unknown live provenance is never silently adopted',async()=>{
 for(const data of [{...deployment(),meta:{}},{...deployment(),readyState:'ERROR'},{...deployment(),projectId:'other'}])await assert.rejects(forwardOnly(prod,async()=>data),/provenance/);
});
test('first production requires proof that no prior production deployment exists',async()=>{
 assert.equal(await forwardOnly(prod,async(_,path)=>path.startsWith('/v13/')?null:{deployments:[]}),true);
 await assert.rejects(forwardOnly(prod,async(_,path)=>path.startsWith('/v13/')?null:{deployments:[deployment()]}),/reconcile/);
});
test('first alias continuation requires reconciled stage and successful same-SHA Preview',async()=>{
 const env={...prod,YUELIAN_INITIAL_STAGE_ID:'dpl_stage'};
 const stage={...deployment('production',A,'dpl_stage'),url:'stage.vercel.app',alias:[],meta:{sourceCommit:A,firstStageReceipt:'41'}};
 const preview={...deployment(null,B,'dpl_preview'),url:'preview.vercel.app',meta:{sourceCommit:B,continuousReceipt:'42'}};
 const api=async(service,path)=>{
  if(path.includes('/git/ref/'))return {object:{type:'commit',sha:B}};
  if(path.includes('/compare/'))return {status:'ahead'};
  if(path.includes('/v9/projects/'))return {id:env.VERCEL_PROJECT_ID,autoAssignCustomDomains:false,targets:{}};
  if(path.includes('/v13/deployments/dpl_stage'))return stage;
  if(path.includes('/v13/deployments/preview.vercel.app'))return preview;
  if(path.includes('/v13/deployments/'))return null;
  if(path.includes('/deployments/41/statuses'))return [{state:'success',environment_url:'https://stage.vercel.app'}];
  if(path.includes('/deployments/41'))return {id:41,sha:A,environment:'yuelian-first-stage',payload:{projectId:env.VERCEL_PROJECT_ID,sourceCommit:A}};
  if(path.includes('/deployments/42/statuses'))return [{state:'success',environment_url:'https://preview.vercel.app'}];
  if(service==='github'&&path.includes('/deployments?'))return [{id:42,sha:B,environment:'yuelian-preview-release',payload:{projectId:env.VERCEL_PROJECT_ID,sourceCommit:B,target:'preview'}}];
  if(path.startsWith('/v6/'))return {deployments:[stage]};
  throw Error('Unexpected continuation lookup '+path);
 };
 assert.equal(await forwardOnly(env,api),false);
 for(const mode of ['missing-preview','wrong-preview','unreconciled-stage','alias-moved','diverged']){
  const broken=async(s,p,o)=>{
   if(mode==='missing-preview'&&p.includes('/deployments?'))return [];
   if(mode==='wrong-preview'&&p.includes('/v13/deployments/preview.vercel.app'))return {...preview,target:'production'};
   if(mode==='unreconciled-stage'&&p.includes('/deployments/41/statuses'))return [{state:'failure'}];
   if(mode==='alias-moved'&&p.includes('/v9/projects/'))return {id:env.VERCEL_PROJECT_ID,autoAssignCustomDomains:false,targets:{production:{id:'other'}}};
   if(mode==='diverged'&&p.includes('/compare/'))return {status:'diverged'};
   return api(s,p,o);
  };
  await assert.rejects(forwardOnly(env,broken));
 }
});
test('first Preview unexpectedly assigned to Production is rejected',()=>{
 assert.throws(()=>checkedDeployment(deployment('production'),base,'preview'),/environment/);
 checkedDeployment(deployment(null),base,'preview');
 assert.throws(()=>checkedDeployment(deployment('staging'),base,'preview'),/environment/);
});

function harness({env=base,target='preview',failCommand,refChangesAt=Infinity,smokeFails=false,wrongTarget=false,aliasMismatch=false,compare='ahead',initial=false,receiptFault}={}){
 const calls=[];let refs=0,promoted=false;const receipts=[];
 const command=async args=>{
  calls.push(args);
  if(args[0]===failCommand)throw Error('synthetic '+failCommand+' failed');
  if(args[0]==='deploy')return url+'\n';
  if(args[0]==='inspect')return JSON.stringify({...deployment(wrongTarget?'production':target==='production'?'production':null),meta:{sourceCommit:B,continuousReceipt:'1'}});
  if(args[0]==='promote')promoted=true;
  return '';
 };
 const api=async(service,path,options={})=>{
  if(service==='github'&&path.includes('/deployments')){
   if(receiptFault==='gate'&&path.includes('environment=yuelian-preview&'))return [{id:999,sha:env.GITHUB_SHA,environment:'yuelian-preview',payload:{}}];
   if(receiptFault==='create'&&options.method==='POST')throw Error('synthetic receipt create denied');
   if(receiptFault==='readback'&&path.endsWith('/deployments/1'))return {...receipts[0],sha:C};
   if(receiptFault==='status'&&path.endsWith('/statuses/2'))return {state:'failure',environment_url:url};
   if(receiptFault==='unknown'&&options.method===undefined)return {};
   if(path.endsWith('/statuses/2'))return {id:2,state:'success',environment_url:url};
   if(options.method==='POST'&&path.endsWith('/statuses'))return {id:2,state:options.body.state};
   if(options.method==='POST'){const record={id:1,sha:env.GITHUB_SHA,...options.body};receipts.push(record);return record;}
   if(path.endsWith('/deployments/1'))return receipts[0];
   return receipts;
  }
  if(service==='github'&&path.includes('/git/ref/'))return {object:{type:'commit',sha:++refs>=refChangesAt?C:env.GITHUB_SHA}};
  if(service==='github'&&path.includes('/compare/'))return {status:compare};
  if(path.startsWith('/v6/'))return {deployments:initial?[]:[deployment('production',A,'dpl_previous')]};
  if(path.startsWith('/v13/'))return initial&&!promoted?null:deployment('production',promoted?B:A,promoted?(aliasMismatch?'dpl_other':'dpl_candidate'):'dpl_previous');
  throw Error('Unexpected synthetic lookup');
 };
 const smoke=async()=>{calls.push(['smoke']);if(smokeFails)throw Error('synthetic smoke failed');};
 return {calls,run:()=>runRelease({env,target,command,api,smoke})};
}
test('GitHub Environment automatic deployment is distinct from durable upload intent',async()=>{
 const h=harness({receiptFault:'gate'});await h.run();
 assert.equal(h.calls.filter(x=>x[0]==='deploy').length,1);
});
test('receipt outage or wrong readback refuses upload; uncertain success does not allow another upload',async()=>{
 for(const receiptFault of ['create','readback','unknown']){
  const h=harness({receiptFault});await assert.rejects(h.run(),/receipt/i);
  assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
 }
 const h=harness({receiptFault:'status'});await assert.rejects(h.run(),/status readback/);
 await assert.rejects(h.run(),/receipt.*reconcile/i);
 assert.equal(h.calls.filter(x=>x[0]==='deploy').length,1);
});

test('a second workflow run cannot repeat either a completed or uncertain upload',async()=>{
 for(const failCommand of [undefined,'deploy']){
  const h=harness({failCommand});
  if(failCommand)await assert.rejects(h.run());else await h.run();
  await assert.rejects(h.run(),/receipt.*reconcile/i);
  assert.equal(h.calls.filter(x=>x[0]==='deploy').length,1);
 }
});

test('target-environment artifact is verified after final build and before upload',async()=>{
 const h=harness();await h.run();
 const build=h.calls.findIndex(x=>x[0]==='build-artifact');
 const verify=h.calls.findIndex(x=>x[0]==='verify-artifact');
 const upload=h.calls.findIndex(x=>x[0]==='deploy');
 assert.ok(verify>build&&verify<upload,'final upload must use tested artifact');
 const failed=harness({failCommand:'verify-artifact'});
 await assert.rejects(failed.run(),/verify-artifact/);
 assert.equal(failed.calls.some(x=>x[0]==='deploy'),false);
});
test('unsuccessful CI produces zero deployment side effects',async()=>{
 const h=harness({env:{...prod,CHECKS_RESULT:'failure'},target:'production'});
 await assert.rejects(h.run(),/checks/);assert.equal(h.calls.length,0);
});
test('install/pull or build failures propagate and never deploy',async()=>{
 for(const stage of ['pull','build-artifact']){
  const h=harness({failCommand:stage});await assert.rejects(h.run());
  assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
 }
});
test('staleness after build is checked before upload',async()=>{
 const h=harness({refChangesAt:2});await assert.rejects(h.run(),/Stale/);
 assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
});
test('uncertain failed uploads are attempted exactly once and never promoted',async()=>{
 const h=harness({env:prod,target:'production',failCommand:'deploy'});await assert.rejects(h.run());
 assert.equal(h.calls.filter(x=>x[0]==='deploy').length,1);assert.equal(h.calls.some(x=>x[0]==='promote'),false);
});
test('Preview build/upload flags remain Preview and never promote',async()=>{
 const h=harness();const r=await h.run();assert.equal(r.target,'preview');
 assert.ok(h.calls.find(x=>x[0]==='pull').includes('--environment=preview'));
 assert.ok(h.calls.find(x=>x[0]==='deploy').includes('--environment=preview'));
 assert.deepEqual(h.calls.find(x=>x[0]==='build-artifact'),['build-artifact']);
 assert.equal(h.calls.some(x=>x[0]==='promote'),false);
});
test('Production builds its own artifact, stages without domains, then promotes after smoke',async()=>{
 const h=harness({env:prod,target:'production'});const r=await h.run();assert.equal(r.sourceCommit,B);
 assert.ok(h.calls.find(x=>x[0]==='pull').includes('--environment=production'));
 assert.deepEqual(h.calls.find(x=>x[0]==='build-artifact'),['build-artifact']);
 assert.ok(h.calls.find(x=>x[0]==='deploy').includes('--skip-domain'));
 assert.ok(h.calls.findIndex(x=>x[0]==='smoke')<h.calls.findIndex(x=>x[0]==='promote'));
});
test('new B arriving while A deploys prevents A promotion',async()=>{
 const h=harness({env:prod,target:'production',refChangesAt:3});await assert.rejects(h.run(),/Stale/);
 assert.equal(h.calls.some(x=>x[0]==='promote'),false);
});
test('live smoke failures and environment mismatches cannot promote',async()=>{
 for(const change of [{smokeFails:true},{failCommand:'inspect'}]){
  const h=harness({env:prod,target:'production',...change});await assert.rejects(h.run());
  assert.equal(h.calls.some(x=>x[0]==='promote'),false);
 }
 const h=harness({wrongTarget:true});await assert.rejects(h.run(),/environment/);
});
test('production cannot complete without exact alias readback',async()=>{
 const h=harness({env:prod,target:'production',aliasMismatch:true});await assert.rejects(h.run(),/alias/);
});
test('initial Production refuses upload until stage-first Preview bootstrap is implemented and verified',async()=>{
 const h=harness({env:prod,target:'production',initial:true});
 await assert.rejects(h.run(),/bootstrap/);
 assert.equal(h.calls.some(call=>['deploy','promote'].includes(call[0])),false);
});

// Offline bootstrap protocol only. This adapter is deliberately not implemented
// by realTools; these synthetic receipts are not Vercel platform evidence.
function bootstrapHarness({change={},failCommand,failOccurrence=1,failSmoke,staleAt=Infinity,moveAliasAt=Infinity,record=null,transformDeployment=data=>data,saveFailPhase,alreadyPromoted=false}={}){
 const env={...prod,...change};const calls=[];const counts={};let refs=0,isolationReads=0,promoted=alreadyPromoted,stored=structuredClone(record);
 const isolated={projectId:base.VERCEL_PROJECT_ID,productionDeploymentId:null,aliases:[]};
 const adapter={
  kind:'offline-synthetic',
  load:async()=>stored,
  save:async value=>{calls.push(['save',value.phase]);if(value.phase===saveFailPhase)throw Error('synthetic durable record failure');stored=structuredClone(value);},
  isolation:async()=>{calls.push(['isolation']);return ++isolationReads>=moveAliasAt?{...isolated,aliases:['moved.vercel.app']}:isolated;},
 };
 const command=async args=>{
  calls.push(args);counts[args[0]]=(counts[args[0]]||0)+1;
  if(args[0]===failCommand&&counts[args[0]]===failOccurrence)throw Error('synthetic '+failCommand+' failed');
  if(args[0]==='deploy')return args.includes('--environment=production')?'https://stage-synthetic.vercel.app':'https://preview-synthetic.vercel.app';
  if(args[0]==='inspect')return JSON.stringify(transformDeployment(args[1].includes('stage-')?deployment('production',B,'dpl_stage'):{...deployment(null,B,'dpl_preview'),meta:{sourceCommit:B,bootstrapStageId:'dpl_stage'}}));
  if(args[0]==='promote')promoted=true;
  return '';
 };
 const api=async(service,path)=>{
  calls.push(['api',service,path]);
  if(service==='github'&&path.includes('/git/ref/'))return {object:{type:'commit',sha:++refs>=staleAt?C:env.GITHUB_SHA}};
  if(path.startsWith('/v6/'))return {deployments:[]};
  if(path.startsWith('/v13/'))return promoted?deployment('production',B,'dpl_stage'):null;
  throw Error('Unexpected offline API');
 };
 const smoke=async value=>{calls.push(['smoke',value]);if(value.includes(failSmoke||'never-match'))throw Error('synthetic smoke failed');};
 return {calls,adapter,get record(){return stored;},run:()=>runRelease({env,target:'production',command,api,smoke,bootstrap:adapter})};
}

test('offline bootstrap builds and checks distinct targets, isolates stage, checks Preview then stage before promote',async()=>{
 const h=bootstrapHarness();const result=await h.run();
 assert.equal(result.deploymentId,'dpl_stage');assert.equal(result.previewDeploymentId,'dpl_preview');
 assert.deepEqual(h.calls.filter(x=>x[0]==='pull').map(x=>x[2]),['--environment=production','--environment=preview']);
 assert.equal(h.calls.filter(x=>x[0]==='build-artifact').length,2);
 assert.equal(h.calls.filter(x=>x[0]==='verify-artifact').length,2);
 const uploads=h.calls.filter(x=>x[0]==='deploy');assert.equal(uploads.length,2);
 assert.ok(uploads[0].includes('--skip-domain'));assert.ok(uploads[0].includes('--prod'));
 assert.ok(uploads[1].includes('bootstrapStageId=dpl_stage'));
 assert.deepEqual(h.calls.filter(x=>x[0]==='smoke').map(x=>x[1]),['https://preview-synthetic.vercel.app','https://stage-synthetic.vercel.app']);
 assert.equal(h.record.phase,'complete');
});

const stageRecord=(phase='staged')=>({version:1,projectId:base.VERCEL_PROJECT_ID,sourceCommit:B,ref:prod.GITHUB_REF,origin:prod.YUELIAN_PRODUCTION_ORIGIN,phase,stage:{url:'https://stage-synthetic.vercel.app',id:'dpl_stage'},...(phase==='staged'?{}:{preview:{url:'https://preview-synthetic.vercel.app',id:'dpl_preview'}})});

test('corrupt resumable records cannot silently become fresh uploads',async()=>{
 for(const record of [{...stageRecord(),stage:undefined},{...stageRecord('preview-ready'),preview:undefined}]){
  const h=bootstrapHarness({record});await assert.rejects(h.run(),/record/);
  assert.equal(h.calls.some(call=>call[0]==='deploy'),false);
 }
});

test('bootstrap prerequisites fail closed before any upload: protection, CI, PR, fork and stale SHA',async()=>{
 for(const change of [{GITHUB_REF_PROTECTED:''},{GITHUB_REF_PROTECTED:'unknown'},{CHECKS_RESULT:'failure'},{CHECKS_RESULT:'cancelled'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_REPOSITORY:'fork/yuelian'},{VERCEL_PROJECT_ID:'other'}]){
  const h=bootstrapHarness({change});await assert.rejects(h.run());assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
 }
 for(const staleAt of [1,2]){const h=bootstrapHarness({staleAt});await assert.rejects(h.run(),/Stale/);assert.equal(h.calls.some(x=>x[0]==='deploy'),false);}
});

test('bootstrap build, artifact and durable intent failures never upload an unchecked target',async()=>{
 for(const failCommand of ['pull','build-artifact','verify-artifact'])for(const failOccurrence of [1,2]){
  const h=bootstrapHarness({failCommand,failOccurrence});await assert.rejects(h.run());
  assert.equal(h.calls.filter(x=>x[0]==='deploy').length,failOccurrence-1);assert.equal(h.calls.some(x=>x[0]==='promote'),false);
 }
 for(const [phase,count] of [['production-uploading',0],['preview-uploading',1]]){
  const h=bootstrapHarness({saveFailPhase:phase});await assert.rejects(h.run(),/record failure/);assert.equal(h.calls.filter(x=>x[0]==='deploy').length,count);
 }
});

test('bootstrap alias isolation is checked before upload and after stage, Preview and smoke',async()=>{
 for(const moveAliasAt of [1,2,3,4,5,6]){
  const h=bootstrapHarness({moveAliasAt});await assert.rejects(h.run(),/isolation/);assert.equal(h.calls.some(x=>x[0]==='promote'),false);
  if(moveAliasAt<=2)assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
 }
});

test('bootstrap rejects wrong project, target, SHA and Preview stage binding',async()=>{
 for(const transformDeployment of [data=>({...data,projectId:'other'}),data=>({...data,target:'staging'}),data=>({...data,meta:{...data.meta,sourceCommit:C}}),data=>data.target===null?{...data,meta:{...data.meta,bootstrapStageId:'other'}}:data]){
  const h=bootstrapHarness({transformDeployment});await assert.rejects(h.run());assert.equal(h.calls.some(x=>x[0]==='promote'),false);
 }
 const h=bootstrapHarness({record:{...stageRecord(),stage:{url:'https://stage-synthetic.vercel.app',id:'other'}}});
 await assert.rejects(h.run(),/stage ID/);assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
});

test('bootstrap newer ref and either smoke failure prevent promotion',async()=>{
 for(const options of [{staleAt:3},{staleAt:4},{staleAt:5},{failSmoke:'preview-'},{failSmoke:'stage-'}]){
  const h=bootstrapHarness(options);await assert.rejects(h.run());assert.equal(h.calls.some(x=>x[0]==='promote'),false);
 }
});

test('uncertain bootstrap uploads leave intent and never retry on restart',async()=>{
 for(const failOccurrence of [1,2]){
  const first=bootstrapHarness({failCommand:'deploy',failOccurrence});await assert.rejects(first.run());
  assert.equal(first.calls.filter(x=>x[0]==='deploy').length,failOccurrence);
  const restart=bootstrapHarness({record:first.record});await assert.rejects(restart.run(),/Uncertain/);
  assert.equal(restart.calls.some(x=>['deploy','promote'].includes(x[0])),false);
 }
});

test('bootstrap interruption resumes inspected stage and Preview without duplicate uploads',async()=>{
 const staged=bootstrapHarness({record:stageRecord()});await staged.run();
 assert.equal(staged.calls.filter(x=>x[0]==='deploy').length,1);
 assert.ok(staged.calls.find(x=>x[0]==='deploy').includes('--environment=preview'));
 const failed=bootstrapHarness({failSmoke:'stage-'});await assert.rejects(failed.run());
 const restart=bootstrapHarness({record:failed.record});await restart.run();
 assert.equal(restart.calls.some(x=>x[0]==='deploy'),false);
 for(const change of [{projectId:'other'},{sourceCommit:C},{ref:'refs/heads/other'},{origin:'https://other.vercel.app'}]){
  const h=bootstrapHarness({record:{...stageRecord(),...change}});await assert.rejects(h.run(),/binding/);assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
 }
});

test('completed and uncertain promotion reruns reconcile exact alias without re-promote',async()=>{
 for(const phase of ['complete','promoting']){
  const h=bootstrapHarness({record:stageRecord(phase),alreadyPromoted:true});await h.run();
  assert.equal(h.calls.some(x=>['deploy','promote'].includes(x[0])),false);
 }
 const unknown=bootstrapHarness({record:stageRecord('promoting')});await assert.rejects(unknown.run());
 assert.equal(unknown.calls.some(x=>['deploy','promote'].includes(x[0])),false);
});

test('completed bootstrap does not adopt an unrelated same-SHA Preview receipt',async()=>{
 const h=bootstrapHarness({record:stageRecord('complete'),alreadyPromoted:true,transformDeployment:data=>data.target===null?{...data,meta:{...data.meta,bootstrapStageId:'other'}}:data});
 await assert.rejects(h.run(),/binding/);assert.equal(h.calls.some(x=>['deploy','promote'].includes(x[0])),false);
});

test('no environment switch or mock verification flag enables the real bootstrap adapter',async()=>{
 assert.equal(realTools({...prod,BOOTSTRAP_VERIFIED:'true',VERCEL_BOOTSTRAP_ENABLED:'true'}).bootstrap,undefined);
 const h=bootstrapHarness();h.adapter.kind='platform-verified';await assert.rejects(h.run(),/unverified/);
 assert.equal(h.calls.some(x=>x[0]==='deploy'),false);
});

test('continuous jobs require protected exact Preview, environments, receipts and same-run manifests',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/vercel.yml',import.meta.url),'utf8');
 const preview=workflow.split('  preview:\n')[1].split('  production:\n')[0];
 const production=workflow.split('  production:\n')[1].split('  first_stage:\n')[0];
 assert.match(preview,/github\.ref_protected/);
 assert.match(preview,/github\.ref_name == vars\.YUELIAN_PREVIEW_BRANCH/);
 for(const [job,target] of [[preview,'preview'],[production,'production']]){
  assert.ok(job.includes('environment: yuelian-'+target));
  assert.match(job,/deployments: write/);
  assert.match(job,/actions: read/);
  assert.match(job,/name: vercel-manifest-\$\{\{ github.sha \}\}/);
  assert.match(job,/path: .ci-output-manifest/);
 }
 const source=readFileSync(new URL('../scripts/vercel-release.mjs',import.meta.url),'utf8');
 assert.match(source,/checkedCiManifest\(JSON.parse\(readFileSync\('.vercel\/output\/build-manifest.json'/);
});

test('first stage, Preview and Production share one non-cancelling release lock without another trigger',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/vercel.yml',import.meta.url),'utf8');
 const groups=[...workflow.matchAll(/group: (yuelian-vercel-[^\n]+)/g)].map(match=>match[1]).filter(value=>!value.startsWith('yuelian-vercel-checks'));
 assert.deepEqual(groups,['yuelian-vercel-release','yuelian-vercel-release','yuelian-vercel-release']);
 assert.equal((workflow.match(/cancel-in-progress: false/g)||[]).length,3);
 assert.doesNotMatch(workflow,/pull_request_target:|workflow_dispatch:|workflow_run:/);
});

// Branch-scoped Vercel configuration must match the source ref, not a full
// refs/heads/... string. Synthetic command observations are local-only.
test('Preview pulls the exact branch environment before building',async()=>{
 const h=harness();await h.run();
 assert.ok(h.calls.find(x=>x[0]==='pull').includes('--git-branch=devops/vercel'));
 const metadata=h.calls.find(x=>x[0]==='deploy');
 assert.ok(metadata.includes('githubCommitRef=devops/vercel'));
});

test('Preview refuses a new project before the platform can make its first deployment Production',async()=>{
 const h=harness({initial:true});
 await assert.rejects(h.run(),/first deployment/i);
 assert.equal(h.calls.length,0);
});

test('live smoke uses the unchanged backend anonymous-session 200 contract',async t=>{
 t.mock.method(globalThis,'fetch',async(input,init)=>init?.method==='POST'?Response.json({error:'media'},{status:415}):String(input).endsWith('/login')
  ?new Response('登录约练',{status:200})
  :Response.json({authenticated:false,account:null,registrationEnabled:false},{status:200}));
 await realTools(base).smoke(url);
});

test('an unprotected release tag cannot authorize production',()=>{
 assert.throws(()=>releasePolicy({...prod,GITHUB_REF:'refs/tags/release-v1.2.3',GITHUB_REF_PROTECTED:'false'},'production'),/protected/i);
});

test('live smoke rejects failed transport authentication, outages and authenticated anonymous responses',async t=>{
 for(const [status,body] of [[401,{authenticated:false}],[503,{authenticated:false}],[200,{authenticated:true}]]){
  const mocked=t.mock.method(globalThis,'fetch',async input=>String(input).endsWith('/login')
   ?new Response('登录约练',{status:200}):Response.json(body,{status}));
  await assert.rejects(realTools(base).smoke(url),/backend boundary/);
  mocked.mock.restore();
 }
});

test('live smoke detects a deployed origin mismatch without attempting business writes',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  calls.push({input:String(input),init});
  if(init?.method==='POST')return Response.json({error:'origin mismatch'},{status:403});
  return String(input).endsWith('/login')?new Response('登录约练',{status:200}):Response.json({authenticated:false},{status:200});
 });
 await assert.rejects(realTools(base).smoke(url),/origin/i);
 const probe=calls.find(call=>call.init?.method==='POST');
 assert.equal(probe.input,url+'/api/auth/session');
 assert.equal(probe.init.headers.origin,url);
 assert.equal(probe.init.headers['content-type'],'text/plain');
});
