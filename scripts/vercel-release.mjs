import {spawnSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const repository='theroybotx/yuelian';
const shaPattern=/^[a-f0-9]{40}$/;
const releaseTag=/^refs\/tags\/release-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function releasePolicy(env,target){
 if(!['preview','production'].includes(target))throw Error('Unknown deployment target');
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==repository||env.GITHUB_EVENT_NAME!=='push')throw Error('Only this repository push workflow may deploy');
 if(env.CHECKS_RESULT!=='success')throw Error('Required checks did not succeed');
 if(!shaPattern.test(env.GITHUB_SHA||''))throw Error('Invalid source commit');
 const branch=env.YUELIAN_RELEASE_BRANCH;
 const protectedRelease=branch&&env.GITHUB_REF==='refs/heads/'+branch&&env.GITHUB_REF_PROTECTED==='true';
 const protectedTag=env.GITHUB_REF_PROTECTED==='true'&&releaseTag.test(env.GITHUB_REF||'');
 if(target==='production'&&!protectedRelease&&!protectedTag)throw Error('Production requires a protected configured release branch or protected release-vX.Y.Z tag');
 if(target==='preview'&&(!env.GITHUB_REF?.startsWith('refs/heads/')||env.GITHUB_REF==='refs/heads/'+branch))throw Error('Preview requires a non-release branch');
 if(!env.VERCEL_TOKEN||!env.GH_TOKEN||!env.VERCEL_ORG_ID||!env.VERCEL_PROJECT_ID)throw Error('Missing deployment authentication or project scope');
 if(env.VERCEL_PROJECT_ID!=='prj_sClf94SbvxJ4cS3Etv6EnrQ9OrXR')throw Error('Unexpected Vercel project');
 if(target==='production'){
  let origin;try{origin=new URL(env.YUELIAN_PRODUCTION_ORIGIN);}catch{throw Error('Production origin must be configured');}
  if(origin.protocol!=='https:'||origin.origin!==env.YUELIAN_PRODUCTION_ORIGIN||origin.username||origin.password)throw Error('Invalid production origin');
 }
 return {target,sha:env.GITHUB_SHA,ref:env.GITHUB_REF};
}

export async function currentRef(env,api){
 const suffix=env.GITHUB_REF.slice('refs/'.length).split('/').map(encodeURIComponent).join('/');
 let object=(await api('github','/repos/'+repository+'/git/ref/'+suffix)).object;
 for(let depth=0;object?.type==='tag'&&depth<5;depth++)object=(await api('github','/repos/'+repository+'/git/tags/'+object.sha)).object;
 if(object?.type!=='commit'||object.sha!==env.GITHUB_SHA)throw Error('Stale or unresolved source ref; deployment refused');
}

export async function forwardOnly(env,api,{initialProduction=false}={}){
 const scope='?teamId='+encodeURIComponent(env.VERCEL_ORG_ID);
 const host=new URL(env.YUELIAN_PRODUCTION_ORIGIN).hostname;
 const live=await api('vercel','/v13/deployments/'+encodeURIComponent(host)+scope,{allow404:true});
 if(!live){
  if(initialProduction)return true;
  const listed=await api('vercel','/v6/deployments'+scope+'&projectId='+encodeURIComponent(env.VERCEL_PROJECT_ID)+'&target=production&limit=1');
  if(!Array.isArray(listed.deployments)||listed.deployments.length)throw Error('Production alias unresolved; reconcile existing deployments before release');
  return true;
 }
 if(live.projectId!==env.VERCEL_PROJECT_ID||live.readyState!=='READY'||!shaPattern.test(live.meta?.sourceCommit||''))throw Error('Current production provenance is unverified');
 const comparison=await api('github','/repos/'+repository+'/compare/'+live.meta.sourceCommit+'...'+env.GITHUB_SHA);
 if(!['ahead','identical'].includes(comparison.status))throw Error('Candidate would roll back or diverge from current production');
 return false;
}

export function checkedDeployment(data,env,target){
 if(data.projectId!==env.VERCEL_PROJECT_ID||data.readyState!=='READY'||data.meta?.sourceCommit!==env.GITHUB_SHA)throw Error('Deployment state or source provenance mismatch');
 if(target==='production'?data.target!=='production':![null,'preview'].includes(data.target))throw Error('Deployment environment mismatch');
 return data;
}

// Side effects are injectable so the failure paths execute in tests without
// credentials or network access. The CLI entrypoint below supplies real tools.
// Bootstrap is an OFFLINE orchestration contract, not a verified platform
// adapter. realTools never provides it. Before enabling a live implementation,
// verify generated-URL protection, CLI/API fields, alias isolation and durable
// receipts with the actual platform. No environment variable enables this path.
async function runBootstrap({env,command,api,smoke,bootstrap}){
 if(bootstrap?.kind!=='offline-synthetic'||!['load','save','isolation'].every(key=>typeof bootstrap[key]==='function'))throw Error('Initial production bootstrap adapter unverified; upload refused');
 const binding={projectId:env.VERCEL_PROJECT_ID,sourceCommit:env.GITHUB_SHA,ref:env.GITHUB_REF,origin:env.YUELIAN_PRODUCTION_ORIGIN};
 const isolation=async()=>{
  const state=await bootstrap.isolation();
  if(state?.projectId!==binding.projectId||state.productionDeploymentId!==null||!Array.isArray(state.aliases)||state.aliases.length!==0)throw Error('Bootstrap alias isolation changed or unknown');
 };
 let record=await bootstrap.load(binding);
 const persist=async phase=>{record={...record,phase};await bootstrap.save(structuredClone(record));};
 if(record){
  if(record.version!==1||Object.entries(binding).some(([key,value])=>record[key]!==value))throw Error('Bootstrap stage record binding mismatch');
  if(!['staged','preview-ready','promoting','complete'].includes(record.phase))throw Error('Uncertain bootstrap upload; reconcile record before retry');
  if(!record.stage?.id||!record.stage?.url||(record.phase!=='staged'&&(!record.preview?.id||!record.preview?.url)))throw Error('Bootstrap stage record incomplete; reconcile before retry');
 }else{
  await isolation();
  const listed=await api('vercel','/v6/deployments?teamId='+encodeURIComponent(env.VERCEL_ORG_ID)+'&projectId='+encodeURIComponent(env.VERCEL_PROJECT_ID)+'&limit=1');
  if(!Array.isArray(listed.deployments)||listed.deployments.length)throw Error('Bootstrap project not empty; reconcile before upload');
  record={version:1,...binding};
 }
 const inspect=async(entry,target)=>{
  if(!entry||!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(entry.url)||!entry.id)throw Error('Bootstrap stage record missing deployment');
  const data=checkedDeployment(JSON.parse(await command(['inspect',entry.url,'--wait','--timeout','5m','--json'])),env,target);
  if(data.id!==entry.id)throw Error('Bootstrap stage ID mismatch');
  return data;
 };
 const live=()=>api('vercel','/v13/deployments/'+encodeURIComponent(new URL(binding.origin).hostname)+'?teamId='+encodeURIComponent(env.VERCEL_ORG_ID),{allow404:true});
 const result=()=>({sourceCommit:binding.sourceCommit,target:'production',url:record.stage.url,deploymentId:record.stage.id,previewUrl:record.preview.url,previewDeploymentId:record.preview.id,evidenceKind:'offline-synthetic'});
 if(['promoting','complete'].includes(record.phase)){
  await inspect(record.stage,'production');const preview=await inspect(record.preview,'preview');
  if(preview.meta?.bootstrapStageId!==record.stage.id||record.preview.id===record.stage.id)throw Error('Preview bootstrap stage binding mismatch');
  const deployed=checkedDeployment(await live()||{},env,'production');
  if(deployed.id!==record.stage.id)throw Error('Uncertain promotion; reconcile alias before retry');
  await persist('complete');return result();
 }
 const build=async target=>{
  await command(['pull','--yes','--environment='+target,...(target==='preview'?['--git-branch='+binding.ref.replace(/^refs\/(heads|tags)\//,'')]:[])]);
  await command(['build-artifact']);
  await command(['verify-artifact']);
  await currentRef(env,api);await isolation();
 };
 const upload=async(target,stageId)=>{
  // Persist intent BEFORE the irreversible call. An unknown result is never
  // retried automatically, even if no deployment ID was returned.
  await persist(target==='production'?'production-uploading':'preview-uploading');
  const output=await command(['deploy','--yes','--prebuilt','--environment='+target,...(target==='production'?['--prod','--skip-domain']:[]),'--meta','sourceCommit='+binding.sourceCommit,...(stageId?['--meta','bootstrapStageId='+stageId]:[])]);
  const urls=output.trim().split(/\s+/).filter(value=>/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(value));
  if(urls.length!==1)throw Error('Bootstrap upload URL unknown; reconcile before retry');
  const data=checkedDeployment(JSON.parse(await command(['inspect',urls[0],'--wait','--timeout','5m','--json'])),env,target);
  if(typeof data.id!=='string'||!data.id)throw Error('Bootstrap deployment ID missing');
  if(stageId&&data.meta?.bootstrapStageId!==stageId)throw Error('Preview bootstrap stage binding mismatch');
  return {url:urls[0],id:data.id};
 };
 if(!record.stage){
  await build('production');const stage=await upload('production');record.stage=stage;await persist('staged');
 }
 await inspect(record.stage,'production');await isolation();await currentRef(env,api);
 if(!record.preview){
  await build('preview');const preview=await upload('preview',record.stage.id);record.preview=preview;await persist('preview-ready');
 }
 const preview=await inspect(record.preview,'preview');
 if(preview.meta?.bootstrapStageId!==record.stage.id||record.preview.id===record.stage.id)throw Error('Preview bootstrap stage binding mismatch');
 await isolation();
 await smoke(record.preview.url,env);await smoke(record.stage.url,env);
 await currentRef(env,api);await isolation();
 await persist('promoting');
 await command(['promote',record.stage.url,'--yes','--timeout','5m']);
 const deployed=checkedDeployment(await live()||{},env,'production');
 if(deployed.id!==record.stage.id)throw Error('Production alias does not resolve to bootstrap stage');
 await persist('complete');return result();
}

export async function runRelease({env,target,command,api,smoke,bootstrap}){
 const policy=releasePolicy(env,target);
 await currentRef(env,api);
 // Vercel documents that a new project's first deployment becomes Production.
 // Refuse before upload; rejecting its target only after upload is too late.
 if(target==='preview'){
  const existing=await api('vercel','/v6/deployments?teamId='+encodeURIComponent(env.VERCEL_ORG_ID)+'&projectId='+encodeURIComponent(env.VERCEL_PROJECT_ID)+'&limit=1');
  if(!Array.isArray(existing.deployments)||existing.deployments.length===0)throw Error('Preview refused: first deployment may become Production; reconcile project bootstrap before upload');
 }
 if(target==='production'&&bootstrap)return runBootstrap({env,command,api,smoke,bootstrap});
 const initialProduction=target==='production'?await forwardOnly(env,api):false;
 if(initialProduction)throw Error('Initial production bootstrap pending: stage-first same-SHA Preview and alias isolation must be verified before upload');
 await command(['pull','--yes','--environment='+target,...(target==='preview'?['--git-branch='+policy.ref.slice('refs/heads/'.length)]:[])]);
 await command(['build-artifact']);
 await command(['verify-artifact']);
 await currentRef(env,api);
 if(target==='production')await forwardOnly(env,api,{initialProduction});
 const output=await command(['deploy','--yes','--prebuilt','--environment='+target,...(target==='production'?['--skip-domain']:[]),'--meta','sourceCommit='+policy.sha,'--meta','githubCommitSha='+policy.sha,'--meta','githubCommitRef='+policy.ref.replace(/^refs\/(heads|tags)\//,'')]);
 const urls=output.trim().split(/\s+/).filter(value=>/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(value));
 if(urls.length!==1)throw Error('CLI did not return exactly one deployment URL');
 const url=urls[0];
 const staged=checkedDeployment(JSON.parse(await command(['inspect',url,'--wait','--timeout','5m','--json'])),env,target);
 await smoke(url,env);
 await currentRef(env,api);
 if(target==='production'){
  await forwardOnly(env,api,{initialProduction});
  await command(['promote',url,'--yes','--timeout','5m']);
  const live=checkedDeployment(await api('vercel','/v13/deployments/'+encodeURIComponent(new URL(env.YUELIAN_PRODUCTION_ORIGIN).hostname)+'?teamId='+encodeURIComponent(env.VERCEL_ORG_ID)),env,target);
  if(live.id!==staged.id)throw Error('Production alias does not resolve to the inspected deployment');
 }
 return {sourceCommit:policy.sha,target,url,deploymentId:staged.id};
}

export function realTools(env){
 const clean=text=>[env.VERCEL_TOKEN,env.GH_TOKEN,env.VERCEL_AUTOMATION_BYPASS_SECRET].filter(Boolean).reduce((s,value)=>s.replaceAll(value,'[REDACTED]'),text);
 return {
  command:async args=>{
   if(args[0]==='build-artifact'){
    const result=spawnSync(process.execPath,['scripts/build-vercel.mjs'],{encoding:'utf8',env,maxBuffer:8*1024*1024});
    if(result.stdout)process.stdout.write(clean(result.stdout));
    if(result.stderr)process.stderr.write(clean(result.stderr));
    if(result.error||result.status!==0)throw Error('Artifact build failed; upload refused');
    if(JSON.parse(readFileSync('.vercel/output/build-manifest.json','utf8')).sourceCommit!==env.GITHUB_SHA)throw Error('Built artifact does not match checked commit');
    return result.stdout;
   }
   if(args[0]==='verify-artifact'){
    const result=spawnSync(process.execPath,['--test','tests/vercel-adapter.test.mjs','tests/vercel-output.test.mjs','tests/vercel-origin.test.mjs','tests/vercel-release.test.mjs'],{encoding:'utf8',env:{...env,GH_TOKEN:'',VERCEL_TOKEN:'',VERCEL_AUTOMATION_BYPASS_SECRET:''},maxBuffer:8*1024*1024});
    if(result.stdout)process.stdout.write(clean(result.stdout));
    if(result.stderr)process.stderr.write(clean(result.stderr));
    if(result.error||result.status!==0)throw Error('Final target artifact checks failed; upload refused');
    return '';
   }
   if(!['pull','deploy','inspect','promote'].includes(args[0]))throw Error('Unsupported Vercel command');
   if(!env.VERCEL_CLI)throw Error('Pinned Vercel CLI path missing');
   const result=spawnSync(env.VERCEL_CLI,[...args,'--token='+env.VERCEL_TOKEN],{encoding:'utf8',env:{...env,VERCEL_TELEMETRY_DISABLED:'1',NO_COLOR:'1'},maxBuffer:8*1024*1024});
   if(result.error||result.status!==0){
    if(result.stderr)process.stderr.write(clean(result.stderr));
    throw Error('Vercel '+args[0]+' failed; not retrying an uncertain operation');
   }
   return result.stdout;
  },
  api:async(service,path,{allow404=false,method='GET',body}={})=>{
   const base=service==='github'?'https://api.github.com':'https://api.vercel.com';
   const token=service==='github'?env.GH_TOKEN:env.VERCEL_TOKEN;
   const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(service==='github'?{'X-GitHub-Api-Version':'2022-11-28'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(response.status===404&&allow404)return null;
   if(!response.ok)throw Error(service+' provenance lookup failed: HTTP '+response.status);
   return response.json();
  },
  smoke:async(url)=>{
   const headers=env.VERCEL_AUTOMATION_BYPASS_SECRET?{'x-vercel-protection-bypass':env.VERCEL_AUTOMATION_BYPASS_SECRET}:{};
   const login=await fetch(url+'/login',{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
   if(login.status!==200||!(await login.text()).includes('登录约练'))throw Error('Live invitation login smoke check failed');
   const session=await fetch(url+'/api/auth/session',{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
   if(session.status!==200||!(session.headers.get('content-type')||'').includes('application/json')||(await session.json()).authenticated!==false)throw Error('Live unauthenticated backend boundary smoke check failed');
   // A non-JSON login probe checks the browser's real origin, but is rejected
   // by the gateway before credentials, database writes or backend calls.
   const origin=await fetch(url+'/api/auth/session',{method:'POST',headers:{...headers,origin:new URL(url).origin,'content-type':'text/plain'},body:'{}',redirect:'error',signal:AbortSignal.timeout(30000)});
   if(origin.status!==415)throw Error('Live same-origin login boundary smoke check failed');
  },
 };
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const env=process.env;
  const result=await runRelease({env,target:process.argv[2],...realTools(env)});
  console.log(JSON.stringify(result));
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,'\nVercel '+result.target+': '+result.url+'\n\nSource: `'+result.sourceCommit+'`; deployment: `'+result.deploymentId+'`.\n');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
