import test from 'node:test';
import assert from 'node:assert/strict';
import {releasePolicy,currentRef,forwardOnly,checkedDeployment,runRelease,realTools} from '../scripts/vercel-release.mjs';

const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
// Synthetic values only: no test reads credentials, touches a real deployment,
// or treats simulated responses as evidence that remote services passed.
const base={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'theroybotx/yuelian',GITHUB_EVENT_NAME:'push',GITHUB_SHA:B,GITHUB_REF:'refs/heads/devops/vercel',GITHUB_REF_PROTECTED:'false',CHECKS_RESULT:'success',GH_TOKEN:'synthetic-github',VERCEL_TOKEN:'synthetic-vercel',VERCEL_ORG_ID:'team_synthetic',VERCEL_PROJECT_ID:'prj_sClf94SbvxJ4cS3Etv6EnrQ9OrXR',YUELIAN_RELEASE_BRANCH:'release',YUELIAN_PRODUCTION_ORIGIN:'https://yuelian.vercel.app'};
const prod={...base,GITHUB_REF:'refs/heads/release',GITHUB_REF_PROTECTED:'true'};
const deployment=(target='production',sha=B,id='dpl_candidate')=>({id,projectId:base.VERCEL_PROJECT_ID,readyState:'READY',target,meta:{sourceCommit:sha}});
const url='https://yuelian-synthetic.vercel.app';

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
test('first Preview unexpectedly assigned to Production is rejected',()=>{
 assert.throws(()=>checkedDeployment(deployment('production'),base,'preview'),/environment/);
 checkedDeployment(deployment(null),base,'preview');
 assert.throws(()=>checkedDeployment(deployment('staging'),base,'preview'),/environment/);
});

function harness({env=base,target='preview',failCommand,refChangesAt=Infinity,smokeFails=false,wrongTarget=false,aliasMismatch=false,compare='ahead',initial=false}={}){
 const calls=[];let refs=0,promoted=false;
 const command=async args=>{
  calls.push(args);
  if(args[0]===failCommand)throw Error('synthetic '+failCommand+' failed');
  if(args[0]==='deploy')return url+'\n';
  if(args[0]==='inspect')return JSON.stringify(deployment(wrongTarget?'production':target==='production'?'production':null));
  if(args[0]==='promote')promoted=true;
  return '';
 };
 const api=async(service,path)=>{
  if(service==='github'&&path.includes('/git/ref/'))return {object:{type:'commit',sha:++refs>=refChangesAt?C:env.GITHUB_SHA}};
  if(service==='github'&&path.includes('/compare/'))return {status:compare};
  if(path.startsWith('/v6/'))return {deployments:initial?[]:[deployment('production',A,'dpl_previous')]};
  if(path.startsWith('/v13/'))return initial&&!promoted?null:deployment('production',promoted?B:A,promoted?(aliasMismatch?'dpl_other':'dpl_candidate'):'dpl_previous');
  throw Error('Unexpected synthetic lookup');
 };
 const smoke=async()=>{calls.push(['smoke']);if(smokeFails)throw Error('synthetic smoke failed');};
 return {calls,run:()=>runRelease({env,target,command,api,smoke})};
}
test('target-environment artifact is verified after final build and before upload',async()=>{
 const h=harness();await h.run();
 const build=h.calls.findIndex(x=>x[0]==='build');
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
 for(const stage of ['pull','build']){
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
 assert.equal(h.calls.find(x=>x[0]==='build').includes('--prod'),false);
 assert.equal(h.calls.some(x=>x[0]==='promote'),false);
});
test('Production builds its own artifact, stages without domains, then promotes after smoke',async()=>{
 const h=harness({env:prod,target:'production'});const r=await h.run();assert.equal(r.sourceCommit,B);
 assert.ok(h.calls.find(x=>x[0]==='pull').includes('--environment=production'));
 assert.ok(h.calls.find(x=>x[0]==='build').includes('--prod'));
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
