import test from 'node:test';
import assert from 'node:assert/strict';
import {runFirstStage,checkedCiManifest} from '../scripts/vercel-first-stage.mjs';
import {realTools} from '../scripts/vercel-release.mjs';

const sha='b'.repeat(40);
const url='https://yuelian-stage-synthetic.vercel.app';
const base={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'theroybotx/yuelian',GITHUB_EVENT_NAME:'push',GITHUB_SHA:sha,GITHUB_REF:'refs/heads/release',GITHUB_REF_PROTECTED:'true',GITHUB_RUN_ID:'123',CHECKS_RESULT:'success',GH_TOKEN:'synthetic-github',VERCEL_TOKEN:'synthetic-vercel',VERCEL_ORG_ID:'team_BT8V0sLlNcPwLzQaoxU9B1g8',VERCEL_PROJECT_ID:'prj_sClf94SbvxJ4cS3Etv6EnrQ9OrXR',YUELIAN_RELEASE_BRANCH:'release',YUELIAN_PRODUCTION_ORIGIN:'https://yuelian.vercel.app',YUELIAN_FIRST_STAGE_ENABLED:'true'};

function harness(options={}){
 const env={...base,...options.env};
 const calls=[];const statuses=[];let records=options.records||[],refs=0,reads=0;
 const project={id:base.VERCEL_PROJECT_ID,accountId:base.VERCEL_ORG_ID,nodeVersion:'24.x',autoAssignCustomDomains:false,targets:{},ssoProtection:{deploymentType:'all_except_custom_domains'},...options.project};
 const aliases={aliases:[],pagination:{next:null},...options.aliases};
 const deployments={deployments:[],pagination:{next:null},...options.deployments};
 const data={id:'dpl_synthetic',url:new URL(url).host,projectId:base.VERCEL_PROJECT_ID,readyState:'READY',target:'production',meta:{sourceCommit:sha,githubCommitSha:sha,githubCommitRef:'release',firstStageReceipt:'456'},...options.deployment};
 const command=async args=>{
  calls.push({kind:'command',args});
  if(options.failCommand===args[0])throw Error('synthetic command failure');
  if(args[0]==='deploy')return options.output??url+'\n';
  if(args[0]==='inspect')return JSON.stringify(data);
  return '';
 };
 const api=async(service,path,init={})=>{
  calls.push({kind:'api',service,path,...init});
  if(path.includes('/git/ref/'))return {object:{type:'commit',sha:++refs===options.staleAt?'c'.repeat(40):sha}};
  if(path.startsWith('/v9/projects/'))return ++reads===options.isolationBreakAt?{...project,targets:{production:{id:'dpl_promoted'}}}:project;
  if(path.startsWith('/v4/aliases'))return aliases;
  if(path.startsWith('/v6/deployments'))return deployments;
  if(path.endsWith('/statuses')){
   statuses.push(init.body);
   if(options.failStatus)throw Error('synthetic status failure');
   return {state:init.body.state};
  }
  if(service==='github'&&path.includes('/deployments')){
   if(init.method!=='POST')return records;
   if(options.failIntent)throw Error('synthetic intent failure');
   records=[{id:456}];return {id:options.invalidReceipt??456};
  }
  throw Error('Unexpected synthetic API request');
 };
 const smoke=async value=>{calls.push({kind:'smoke',url:value});if(options.failSmoke)throw Error('synthetic smoke failure');};
 return {calls,statuses,get records(){return records;},run:()=>runFirstStage({env,command,api,smoke})};
}
const commands=(h,name)=>h.calls.filter(c=>c.kind==='command'&&c.args[0]===name);
const intents=h=>h.calls.filter(c=>c.kind==='api'&&c.method==='POST'&&!c.path.endsWith('/statuses'));

test('first stage rejects untrusted CI, checks, branch, scope and missing opt-in before side effects',async()=>{
 for(const env of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REPOSITORY:'fork/yuelian'},{GITHUB_REF_PROTECTED:'false'},{GITHUB_REF:'refs/heads/main'},{GITHUB_REF:'refs/tags/release-v1.2.3'},{YUELIAN_RELEASE_BRANCH:''},{CHECKS_RESULT:'failure'},{CHECKS_RESULT:'skipped'},{YUELIAN_FIRST_STAGE_ENABLED:''},{YUELIAN_FIRST_STAGE_ENABLED:'TRUE'},{VERCEL_ORG_ID:'team_other'},{VERCEL_PROJECT_ID:'prj_other'},{GH_TOKEN:''},{VERCEL_TOKEN:''},{YUELIAN_PRODUCTION_ORIGIN:'http://bad.example'},{GITHUB_RUN_ID:''}]){
  const h=harness({env});await assert.rejects(h.run());assert.equal(h.calls.length,0);
 }
});

test('existing native receipts block retry regardless of their status',async()=>{
 const h=harness({records:[{id:1,status:'failure'}]});await assert.rejects(h.run(),/receipt/);
 assert.equal(commands(h,'deploy').length,0);assert.equal(intents(h).length,0);
});

test('project must retain exact team, project, domain isolation, Node 24 and URL protection',async()=>{
 for(const project of [{id:'prj_other'},{accountId:'team_other'},{autoAssignCustomDomains:true},{autoAssignCustomDomains:undefined},{targets:{production:{id:'dpl_existing'}}},{targets:undefined},{nodeVersion:'26.x'},{ssoProtection:null},{ssoProtection:{deploymentType:'none'}}]){
  const h=harness({project});await assert.rejects(h.run(),/isolation|protection/);
  assert.equal(commands(h,'deploy').length,0);assert.equal(intents(h).length,0);
 }
});

test('existing aliases, deployments and unknown pagination all refuse first upload',async()=>{
 for(const options of [{aliases:{aliases:[{alias:'existing.vercel.app'}]}},{aliases:{pagination:{next:1}}},{aliases:{pagination:undefined}},{aliases:{aliases:undefined}},{deployments:{deployments:[{uid:'dpl_existing'}]}},{deployments:{pagination:{next:2}}},{deployments:{pagination:undefined}},{deployments:{deployments:undefined}}]){
  const h=harness(options);await assert.rejects(h.run());assert.equal(commands(h,'deploy').length,0);assert.equal(intents(h).length,0);
 }
});

test('build and artifact failures occur before intent creation and upload',async()=>{
 for(const failCommand of ['pull','build','verify-artifact']){
  const h=harness({failCommand});await assert.rejects(h.run());assert.equal(intents(h).length,0);assert.equal(commands(h,'deploy').length,0);
 }
});

test('stale source and changed isolation refuse upload after build',async()=>{
 for(const options of [{staleAt:1},{staleAt:2},{isolationBreakAt:2}]){
  const h=harness(options);await assert.rejects(h.run());assert.equal(intents(h).length,0);assert.equal(commands(h,'deploy').length,0);
 }
});

test('durable intent failure and invalid intent IDs prevent upload',async()=>{
 for(const options of [{failIntent:true},{invalidReceipt:0},{invalidReceipt:'456'},{invalidReceipt:-1},{invalidReceipt:1.5}]){
  const h=harness(options);await assert.rejects(h.run());assert.equal(commands(h,'deploy').length,0);
 }
});

test('unknown upload failure leaves native intent and never retries or promotes',async()=>{
 const first=harness({failCommand:'deploy'});await assert.rejects(first.run());
 assert.equal(commands(first,'deploy').length,1);assert.equal(first.records.length,1);
 assert.deepEqual(first.statuses.map(x=>x.state),['failure']);
 const retry=harness({records:first.records});await assert.rejects(retry.run(),/receipt/);
 assert.equal(commands(retry,'deploy').length,0);
 assert.equal(commands(first,'promote').length,0);
});

test('uncertain CLI URL never receives successful receipt status',async()=>{
 for(const output of ['',url+' https://second.vercel.app','https://attacker.example']){
  const h=harness({output});await assert.rejects(h.run());assert.deepEqual(h.statuses.map(x=>x.state),['failure']);
 }
});

test('READY deployment must bind source, target, project, URL and native receipt',async()=>{
 for(const deployment of [{readyState:'ERROR'},{target:'preview'},{projectId:'prj_other'},{id:''},{url:'different.vercel.app'},{meta:{}},{meta:{sourceCommit:'c'.repeat(40)}},{meta:{sourceCommit:sha,githubCommitSha:sha,githubCommitRef:'release',firstStageReceipt:'other'}}]){
  const h=harness({deployment});await assert.rejects(h.run());assert.equal(h.calls.some(c=>c.kind==='smoke'),false);
  assert.deepEqual(h.statuses.map(x=>x.state),['failure']);assert.equal(commands(h,'promote').length,0);
 }
});

test('smoke failures, stale final ref and any production target prevent success and promotion',async()=>{
 for(const options of [{failSmoke:true},{staleAt:3},{isolationBreakAt:3},{isolationBreakAt:4},{failStatus:true}]){
  const h=harness(options);await assert.rejects(h.run());
  if(!options.failStatus)assert.equal(h.statuses.some(x=>x.state==='success'),false);
  assert.equal(h.statuses.at(-1).state,'failure');assert.equal(commands(h,'promote').length,0);
 }
});

test('successful first stage records one isolated Production upload and no automatic domains',async()=>{
 const h=harness();const result=await h.run();
 assert.deepEqual(result,{sourceCommit:sha,url,deploymentId:'dpl_synthetic',receiptId:456,target:'production',promoted:false});
 assert.deepEqual(commands(h,'pull')[0].args,['pull','--yes','--environment=production']);
 assert.deepEqual(commands(h,'build')[0].args,['build','--prod']);
 assert.equal(commands(h,'verify-artifact').length,1);assert.equal(commands(h,'deploy').length,1);
 const upload=commands(h,'deploy')[0];
 for(const arg of ['--prebuilt','--environment=production','--prod','--skip-domain','sourceCommit='+sha,'githubCommitSha='+sha,'githubCommitRef=release','firstStageReceipt=456'])assert.ok(upload.args.includes(arg));
 const intent=intents(h)[0];
 assert.deepEqual(intent.body,{ref:sha,auto_merge:false,required_contexts:[],environment:'yuelian-first-stage',transient_environment:true,production_environment:false,payload:{version:1,projectId:base.VERCEL_PROJECT_ID,sourceCommit:sha,phase:'uploading',ciRunId:'123'}});
 assert.ok(h.calls.indexOf(intent)<h.calls.indexOf(upload));
 assert.ok(h.calls.indexOf(commands(h,'verify-artifact')[0])<h.calls.indexOf(intent));
 assert.deepEqual(h.calls.filter(c=>c.kind==='smoke').map(c=>c.url),[url]);
 assert.deepEqual(h.statuses,[{state:'success',environment_url:url,auto_inactive:false,description:'Isolated stage verified; not promoted'}]);
 assert.equal(h.calls.some(c=>c.kind==='command'&&['promote','alias'].includes(c.args[0])),false);
 for(const call of h.calls.filter(c=>c.service==='vercel')){
  assert.ok(call.path.includes('teamId='+base.VERCEL_ORG_ID));
  if(!call.path.startsWith('/v9/projects/'))assert.ok(call.path.includes('projectId='+base.VERCEL_PROJECT_ID));
  assert.equal(call.method,undefined);
 }
});

test('native status failure does not disclose errors or remove the intent',async()=>{
 const h=harness({failCommand:'deploy',failStatus:true});await assert.rejects(h.run());
 assert.equal(h.records.length,1);assert.equal(commands(h,'deploy').length,1);
 assert.equal(JSON.stringify(h.statuses).includes('synthetic command failure'),false);
 assert.equal(JSON.stringify(h.statuses).includes(base.VERCEL_TOKEN),false);
});

test('real API adapter defaults to GET and supports JSON receipt writes',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url,init});return Response.json({id:456});});
 const {api}=realTools(base);
 await api('github','/synthetic');
 await api('github','/synthetic',{method:'POST',body:{state:'success'}});
 assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);
 assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.headers['content-type'],'application/json');
 assert.deepEqual(JSON.parse(calls[1].init.body),{state:'success'});
});

test('production artifact must exactly match same-run checked source and file hashes',()=>{
 const built={sourceCommit:sha,files:{'config.json':'digest-a','functions/index.js':'digest-b'}};
 checkedCiManifest(built,{...built,files:{'functions/index.js':'digest-b','config.json':'digest-a'}},sha);
 for(const checked of [{...built,sourceCommit:'c'.repeat(40)},{...built,files:{'config.json':'different'}},{...built,files:{...built.files,extra:'digest'}},{...built,files:undefined}])assert.throws(()=>checkedCiManifest(built,checked,sha),/artifact/);
 assert.throws(()=>checkedCiManifest({...built,sourceCommit:'c'.repeat(40)},built,sha),/artifact/);
 assert.throws(()=>checkedCiManifest({sourceCommit:sha,files:{}},{sourceCommit:sha,files:{}},sha),/artifact/);
});
